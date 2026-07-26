# Release checklist

## Automated gate

- [x] Vue/TypeScript type check
- [x] Unit and safety tests
- [x] Electron main/preload module syntax checks
- [x] Production Vite build
- [x] Dependency vulnerability audit
- [x] Packaged renderer/preload/main smoke test
- [x] Portable executable smoke test
- [x] Silent installer, installed-app smoke test and silent uninstall
- [x] Desktop hot-mode single-window restart probe

## Security gate

- [x] Supported Electron release line
- [x] Sandboxed renderer and allowlisted preload bridge
- [x] Content Security Policy
- [x] Single application instance
- [x] HTTPS required for remote AI endpoints
- [x] API key encrypted with Windows safeStorage
- [x] No direct system-component deletion
- [x] No permanent-delete route
- [x] Cleanup path containment and identity revalidation
- [x] Browser process guard and fail-closed process detection
- [x] Cancellation, per-file failures and bounded job size

## Public distribution gate

- [ ] Sign installer and application executables with a trusted Authenticode certificate.
- [x] Generate SHA-256 hashes beside local release artifacts.
- [ ] Publish the generated SHA-256 hashes beside release downloads.
- [ ] Run a clean Windows VM installation test for every release tag.

Unsigned artifacts are release candidates for local validation. They should not be described as a trusted public Windows release until the signing and clean-VM items are complete.

## Latest local validation

Validated on Windows x64 on 2026-07-26:

- 13 test files and 67 unit, safety, fault-injection, state-recovery, and performance-boundary tests passed.
- 15 Electron desktop modules passed recursive syntax checks.
- The unpacked build, portable executable, and silently installed application all passed the real preload/IPC/Windows smoke suite.
- The isolated installer completed installation and clean uninstallation with exit code 0.
- Desktop hot mode survived two real main-process file changes, restarting one visible and focused Electron window each time without error-log output.
- Full production and development dependency audit reported no known vulnerabilities; the build chain pins `brace-expansion` 5.0.8 for GHSA-mh99-v99m-4gvg.
- Authenticode status is `NotSigned`; this remains the only trust blocker that can be resolved without a separate clean Windows VM.

Artifact checksums:

```text
6d9e644c5df0b73d63048171061dbdab0b8097b7114ac627b9ceed37d7ede967  Disk Sense-Setup-1.0.0-x64.exe
59ac974faf8c75e99d4c0392e713898ebe027c14929e77d425e1b2da30eab03e  Disk Sense-Portable-1.0.0-x64.exe
```
