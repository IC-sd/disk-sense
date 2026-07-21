# Local Operations

## Development hot mode

Run Vite and Electron together:

```bash
pnpm dev:desktop
```

The UI uses Vite HMR. The desktop process uses `desktop/preload.cjs` and the isolated `diskSense` bridge.

## Safety

- The scanner reads metadata and does not read file contents by default.
- Unknown files are not automatically classified as removable.
- Cleaner actions use the Windows Recycle Bin.
- Move/archive is explicit and separate from cleanup.
- Agent context defaults to `mutateFiles: false`.

## Local state

The desktop state file contains snapshots, change events, memories, and cleanup jobs. It is local-only and can be removed by the user after closing the app if a clean development state is needed.
