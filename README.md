<p align="center">
  <img src="build/icon.png" width="96" height="96" alt="Disk Sense Logo">
</p>

<h1 align="center">Disk Sense</h1>

<p align="center">
  <strong>Understand every directory and file before deciding what to do with your disk space.</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/platform-Windows-blue?style=flat-square" alt="Platform">
  <img src="https://img.shields.io/badge/Electron-43.x-47848F?style=flat-square&logo=electron" alt="Electron">
  <img src="https://img.shields.io/badge/Vue.js-3.x-4FC08D?style=flat-square&logo=vuedotjs" alt="Vue.js">
  <img src="https://img.shields.io/badge/TypeScript-6.x-3178C6?style=flat-square&logo=typescript" alt="TypeScript">
  <img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="License">
</p>

Disk Sense is a Windows desktop utility for **directory and file explanation**, **disk-change analysis**, and **safe space cleanup**. It helps you understand what occupies your storage before you act.

---

## Highlights

- **Directory & file explorer** — Browse from `C:\` with contextual explanations based on path, name, parent, siblings, structure, and content signatures.
- **AI-powered analysis** — Optional OpenAI-compatible review with automatic model discovery, normal/deep analysis modes, and local evidence caching.
- **Disk-change tracking** — Volume-level baselines with honest partial-coverage reporting to show what changed between scans.
- **Safe cleanup** — Fifteen low-risk or detection-only cleanup rules across five risk levels, with process guards, user exclusions, cleanup history, and recycle-bin-only deletion.
- **System slimming detection** — Read-only inspection of hibernation, component store (WinSxS), virtual memory, Windows.old, and ResetBase risk.
- **Application attribution** — Identify data locations of common browsers, communication tools, gaming platforms, and development tools across C/D drives.

## Screenshots

<p align="center">
  <img src="release/smoke-overview.png" alt="Overview" width="600">
  <img src="release/smoke-inspect.png" alt="Directory inspection" width="600">
  <img src="release/smoke-cleaner.png" alt="Cleanup panel" width="600">
  <img src="release/smoke-changes.png" alt="Change tracking" width="600">
</p>

## Requirements

- Windows 10 or later.
- Node.js 18+ and pnpm.

## Development

```bash
pnpm install
pnpm dev              # Vite dev server (frontend only)
pnpm dev:desktop      # Full desktop app with hot reload
pnpm test             # Run tests
pnpm build            # Build for production
```

## Safety

- Cleanup accepts only short-lived opaque candidates from the current scan session.
- Symbolic links and canonical-root escapes are never followed.
- File identity, retention age, process state, and user exclusions are rechecked before execution.
- Selected cleanup moves files to the Windows Recycle Bin only; permanent deletion is not exposed.
- Unknown and personal content is never an automatic cleanup candidate.

## License

[MIT](LICENSE)
