[CmdletBinding()]
param(
  [switch]$Execute,
  [string]$BaselineInstaller,
  [string]$BaselineSha256,
  [string]$CurrentInstaller,
  [string]$EvidenceDirectory = (Join-Path $PSScriptRoot '..\work\windows-acceptance'),
  [switch]$IncludeServiceLifecycle
)

$ErrorActionPreference = 'Stop'
$nodeExecutable = (Get-Command node.exe -ErrorAction Stop).Source
$projectDirectory = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$guardScript = Join-Path $PSScriptRoot 'windows-acceptance-guard.cjs'
$profileScript = Join-Path $PSScriptRoot 'verify-installed-profile.mjs'
$environmentReport = (& $nodeExecutable $guardScript --probe | ConvertFrom-Json)
if ($LASTEXITCODE -ne 0) { throw 'Unable to inspect the acceptance environment' }
$steps = @('install baseline', 'seed isolated-account profile through installed IPC', 'upgrade in place',
  'verify profile and encrypted fixture key', 'uninstall and verify profile hashes',
  'reinstall to a different directory', 'verify retained profile', 'uninstall owned test installation')
if ($IncludeServiceLifecycle) { $steps += 'install, authenticate, restart and uninstall the owned search service' }
if (-not $Execute) {
  [pscustomobject]@{ mode = 'plan'; systemChanges = $false; environment = $environmentReport;
    baselineInstaller = $BaselineInstaller; currentInstaller = $CurrentInstaller; steps = $steps;
    executionRequires = 'An explicitly disposable Windows VM or the dedicated GitHub-hosted job' } | ConvertTo-Json -Depth 5
  exit 0
}

# This check runs before any installation, profile write or service configuration.
& $nodeExecutable $guardScript --require
if ($LASTEXITCODE -ne 0) { throw 'Refusing installation acceptance on this host' }
if (-not $BaselineInstaller -or -not $CurrentInstaller -or $BaselineSha256 -notmatch '^[a-fA-F0-9]{64}$') {
  throw 'BaselineInstaller, its published SHA256, and CurrentInstaller are required'
}
$baselinePath = (Resolve-Path -LiteralPath $BaselineInstaller).Path
$currentPath = (Resolve-Path -LiteralPath $CurrentInstaller).Path
if ((Get-FileHash -LiteralPath $baselinePath -Algorithm SHA256).Hash -ne $BaselineSha256.ToUpperInvariant()) {
  throw 'Baseline installer does not match the published checksum'
}
$baselineVersion = [regex]::Match([IO.Path]::GetFileName($baselinePath), '^Disk-Sense-Setup-(.+)-x64\.exe$').Groups[1].Value
if (-not $baselineVersion) { throw 'Unexpected baseline installer filename' }
$currentVersion = (Get-Content -LiteralPath (Join-Path $projectDirectory 'package.json') -Raw | ConvertFrom-Json).version
$profileDirectory = Join-Path $env:APPDATA 'Disk Sense'
if (Test-Path -LiteralPath $profileDirectory) { throw 'A Disk Sense profile already exists; use a fresh disposable Windows account' }
$evidenceRoot = [IO.Path]::GetFullPath($EvidenceDirectory)
$allowedRoot = [IO.Path]::GetFullPath((Join-Path $projectDirectory 'work'))
$insideWork = $evidenceRoot.StartsWith($allowedRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
$insideRunnerTemp = $env:RUNNER_TEMP -and $evidenceRoot.StartsWith([IO.Path]::GetFullPath($env:RUNNER_TEMP) + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
if (-not ($insideWork -or $insideRunnerTemp)) { throw 'EvidenceDirectory must be within repository work/ or RUNNER_TEMP' }
New-Item -ItemType Directory -Path $evidenceRoot -Force | Out-Null
$runDirectory = Join-Path $evidenceRoot ('run-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $runDirectory | Out-Null
$installDirectory = Join-Path $runDirectory 'first-install'
$reinstallDirectory = Join-Path $runDirectory 'second-install'
$caseResults = [Collections.Generic.List[object]]::new()
$report = [ordered]@{ startedAt = [DateTime]::UtcNow.ToString('o'); mode = 'real-disposable-windows-installation';
  environment = $environmentReport; baselineVersion = $baselineVersion; currentVersion = $currentVersion;
  baselineSha256 = $BaselineSha256.ToLowerInvariant(); currentSha256 = (Get-FileHash -LiteralPath $currentPath -Algorithm SHA256).Hash.ToLowerInvariant();
  administratorToken = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator);
  standardUserAndUacFlowVerified = $false; fullWindowsRebootVerified = $false; cases = $caseResults; passed = $false }

function Invoke-InstallerProcess([string]$File, [string[]]$Arguments) {
  $process = Start-Process -FilePath $File -ArgumentList $Arguments -WindowStyle Hidden -PassThru
  if (-not $process.WaitForExit(120000)) { $process.Kill(); throw 'Owned installer timed out' }
  if ($process.ExitCode -ne 0) { throw "Installer exit code $($process.ExitCode); no reboot is performed by this harness" }
}
function Add-Case([string]$Name, [scriptblock]$Action) {
  $started = [DateTime]::UtcNow
  try {
    & $Action
    $caseResults.Add([pscustomobject]@{ name = $Name; passed = $true; elapsedMs = [int]([DateTime]::UtcNow - $started).TotalMilliseconds })
  } catch {
    $caseResults.Add([pscustomobject]@{ name = $Name; passed = $false; error = $_.Exception.Message })
    throw
  }
}
function Assert-InstalledApp([string]$Directory) {
  $app = Join-Path $Directory 'Disk Sense.exe'
  if (-not (Test-Path -LiteralPath $app -PathType Leaf)) { throw 'Installed executable missing' }
}
function Invoke-ProfileCheck([string]$Directory, [string]$Action, [string]$Version, [string]$Label) {
  $resultFile = Join-Path $runDirectory "$Label.json"
  & $nodeExecutable $profileScript (Join-Path $Directory 'Disk Sense.exe') $profileDirectory $Action $Version $resultFile
  if ($LASTEXITCODE -ne 0) { throw "Installed profile verification failed: $Label" }
}
function Get-ProfileManifest {
  $files = @(Get-ChildItem -LiteralPath $profileDirectory -File | Where-Object { $_.Name -match '^disk-sense-state\.json(?:\..*)?$' -and $_.Extension -ne '.log' })
  if (-not $files.Count) { throw 'No persisted application state found' }
  $manifest = @{}
  foreach ($file in $files) { $manifest[$file.Name] = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash }
  return $manifest
}
function Assert-ProfileManifest([hashtable]$Manifest) {
  foreach ($name in $Manifest.Keys) {
    $file = Join-Path $profileDirectory $name
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Uninstall removed retained state: $name" }
    if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $Manifest[$name]) { throw "Uninstall changed retained state: $name" }
  }
}
function Uninstall-OwnedApp([string]$Directory) {
  $absolute = [IO.Path]::GetFullPath($Directory)
  if (-not $absolute.StartsWith($runDirectory + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe owned installation path' }
  $uninstallers = @(Get-ChildItem -LiteralPath $absolute -Filter 'Uninstall*.exe' -File)
  if ($uninstallers.Count -ne 1) { throw 'Expected one owned NSIS uninstaller' }
  # NSIS requires _?= to be the last argument and its directory to be unquoted.
  Invoke-InstallerProcess $uninstallers[0].FullName @('/S', "_?=$absolute")
  if (Test-Path -LiteralPath (Join-Path $absolute 'Disk Sense.exe')) { throw 'Uninstaller retained the application executable' }
}

try {
  Add-Case 'baseline-install-custom-directory' {
    Invoke-InstallerProcess $baselinePath @('/S', '/currentuser', "/D=$installDirectory")
    Assert-InstalledApp $installDirectory
  }
  Add-Case 'baseline-installed-ipc-seed' { Invoke-ProfileCheck $installDirectory 'seed' $baselineVersion 'baseline-profile' }
  Add-Case 'upgrade-in-place' {
    Invoke-InstallerProcess $currentPath @('/S', '/currentuser', "/D=$installDirectory")
    Assert-InstalledApp $installDirectory
    Invoke-ProfileCheck $installDirectory 'check' $currentVersion 'upgraded-profile'
  }
  $profileManifest = Get-ProfileManifest
  Add-Case 'uninstall-retains-state' { Uninstall-OwnedApp $installDirectory; Assert-ProfileManifest $profileManifest }
  Add-Case 'reinstall-different-directory-retains-profile' {
    Invoke-InstallerProcess $currentPath @('/S', '/currentuser', "/D=$reinstallDirectory")
    Assert-InstalledApp $reinstallDirectory
    Invoke-ProfileCheck $reinstallDirectory 'check' $currentVersion 'reinstalled-profile'
  }
  $profileManifest = Get-ProfileManifest
  Add-Case 'final-uninstall-retains-state' { Uninstall-OwnedApp $reinstallDirectory; Assert-ProfileManifest $profileManifest }
  if ($IncludeServiceLifecycle) {
    Add-Case 'owned-search-service-lifecycle' {
      & $nodeExecutable (Join-Path $PSScriptRoot 'verify-service-lifecycle.cjs') (Join-Path $runDirectory 'service-lifecycle.json')
      if ($LASTEXITCODE -ne 0) { throw 'Search service lifecycle verification failed' }
    }
  }
  $report.passed = $true
} catch {
  $report.error = $_.Exception.Message
  throw
} finally {
  $report.finishedAt = [DateTime]::UtcNow.ToString('o')
  $report | ConvertTo-Json -Depth 7 | Set-Content -LiteralPath (Join-Path $runDirectory 'installation-validation.json') -Encoding utf8
  Write-Host "Acceptance evidence: $runDirectory"
}
