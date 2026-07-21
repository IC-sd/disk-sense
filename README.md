# Disk Sense

Disk Sense is a Windows space-management product, not only a disk cleaner.

Its job is to explain why storage keeps returning after cleanup:

1. discover space;
2. identify the source and owner;
3. explain whether it is rebuildable, personal, stale, or required;
4. recommend cleanup, move, archive, ignore, or monitor;
5. observe the result over time.

The old Disk Sense project is reference material only. This repository is a clean rewrite.

## Development

```bash
pnpm install
pnpm dev
pnpm dev:desktop
```

Open `http://127.0.0.1:5173/` for the hot-reloading UI. `dev:desktop` starts the Electron shell against the same Vite server.

Production checks:

```bash
pnpm typecheck
pnpm test
pnpm build
```

The desktop process stores local snapshots, changes, memories, and cleanup jobs in Electron's `userData` directory. It never sends file contents to the UI or an agent by default.

## Product thesis

Traditional cleaners optimize a single cleanup session. Disk Sense manages the user's storage lifecycle.

## Initial implementation

The first milestone is a read-only space intelligence core with deterministic results and inspectable evidence. Destructive actions are added only after the result model is stable.

## Current capabilities

- Real Windows metadata scanning for user folders and temporary data.
- Snapshot persistence and change events.
- Live filesystem watching for supported user roots.
- Application attribution for common browser, development, and game paths.
- Personal-space and growth views.
- Conventional cleanup scanning with explicit confirmation and Recycle Bin execution.
- Move/archive API, Markdown memory export, and agent-context permission boundary.
- Duplicate-file candidates based on conservative metadata grouping; content hashing remains intentionally opt-in.
