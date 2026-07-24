# Local Operations

## Development hot mode

Run Vite and Electron together:

```bash
pnpm dev:desktop
```

The UI uses Vite HMR. The desktop process uses `desktop/preload.cjs` and the isolated `diskSense` bridge.

Vue and CSS changes update in the existing window. Changes to any `.cjs` file under
`desktop/` automatically restart the single Electron window while keeping the Vite
server running. The launcher owns `.dev-desktop.pid.json`, refuses duplicate launchers,
binds Vite to `127.0.0.1:5173`, and cleans up the desktop process when it exits.

## Safety

- The scanner reads metadata and does not read file contents by default.
- Unknown files are not automatically classified as removable.
- Cleaner actions use the Windows Recycle Bin.
- Move/archive is explicit and separate from cleanup.
- Moving to the Recycle Bin does not immediately free disk blocks; the UI reports it as pending reclaimable space.

## Local state

Frequently updated settings and cleanup history live in `disk-sense-state.json`; large
change baselines and the last detailed comparison live in
`disk-sense-state.json.changes.json`. Both use atomic replacement and valid backups.
`disk-sense.log` is a bounded local diagnostic log. All files are local-only. The
in-app “设置与关于” page shows the exact directory and can open it for inspection.

## Release validation

```bash
pnpm validate
pnpm audit --audit-level=moderate
pnpm release:win
```

The release command builds:

- `Disk Sense-Setup-<version>-x64.exe`
- `Disk Sense-Portable-<version>-x64.exe`

The installer is per-user and does not request administrator execution for the app itself. Public downloads should be Authenticode-signed; an unsigned local build is suitable for validation but will not have normal Windows publisher trust.
