// Inspect the built executable and archive without enabling Electron's Node mode.
const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')
const assert = require('node:assert/strict')
const builderRequire = createRequire(require.resolve('electron-builder'))
const dependency = createRequire(builderRequire.resolve('app-builder-lib/package.json'))
const { getCurrentFuseWire, FuseV1Options } = dependency('@electron/fuses')
const asar = dependency('@electron/asar')
;(async () => {
  const executable = path.resolve(process.argv[2] || 'release/win-unpacked/Disk Sense.exe')
  assert(fs.statSync(executable).isFile(), 'Built executable required')
  const wire = await getCurrentFuseWire(executable)
  const expected = { RunAsNode: 48, EnableNodeOptionsEnvironmentVariable: 48, EnableNodeCliInspectArguments: 48,
    OnlyLoadAppFromAsar: 49, EnableEmbeddedAsarIntegrityValidation: 49 }
  for (const [name, state] of Object.entries(expected)) assert.equal(wire[FuseV1Options[name]], state, `Unexpected ${name} fuse`)
  const archive = path.join(path.dirname(executable), 'resources', 'app.asar')
  const required = ['desktop/main.cjs', 'desktop/cleanup-rules.json', 'desktop/operation-journal.cjs',
    'desktop/ntfs-indexer.cs', 'desktop/ntfs-service.cs', 'desktop/file-space-metadata.cs',
    'desktop/file-search-reader.cjs', 'desktop/search-disk-session.cjs', 'desktop/search-top-page.cjs', 'desktop/windows-paths.cjs', 'dist/index.html']
  for (const file of required) {
    assert(asar.statFile(archive, file).size > 0, `Missing packaged ${file}`)
    // A successful older package is not evidence for the current worktree.
    // Confirm required source/entry files match the build being inspected.
    assert(asar.extractFile(archive, file).equals(fs.readFileSync(path.resolve(__dirname, '..', file))), `Packaged file differs from current source: ${file}`)
  }
  const manifest = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8'))
  console.log(JSON.stringify({ version: manifest.version, archiveFilesVerified: required.length, fuses: Object.fromEntries(Object.keys(expected).map(name => [name, wire[FuseV1Options[name]] === 49])) }, null, 2))
})().catch(error => { console.error(error.message); process.exitCode = 1 })
