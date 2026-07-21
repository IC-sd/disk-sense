# Architecture

## Runtime choice

The rewrite starts with a TypeScript domain core and a thin desktop adapter. The domain core must run in tests without Electron or Windows. The desktop adapter is the only layer allowed to access the file system, Windows APIs, dialogs, or the shell.

This keeps the design portable and leaves room for a Rust/Tauri scanner later without rewriting product logic.

## Layers

```text
UI
  ↓ view models / commands
Application
  ↓ use cases and task orchestration
Domain
  ↓ observations, classification, recommendations, decisions
Adapters
  ↓ Windows filesystem, process metadata, recycle bin, persistence
Infrastructure
  ↓ SQLite/event log, diagnostics, telemetry-free local logs
```

## Scanning pipeline

```text
enumerate → normalize → observe → attribute → classify → aggregate → compare → recommend
```

The scanner never decides that a file is safe to delete. It only produces observations. Classification and recommendations consume observations plus evidence.

## Evidence model

Evidence is structured, not only a human-readable explanation:

- normalized path and volume;
- size and file count;
- modified/accessed/created timestamps;
- owning process or application when known;
- parent-directory context;
- known cache or generated-data signature;
- repeated growth across snapshots;
- lock/access errors;
- user decisions.

## Safety model

Actions are capability-based:

- `inspect`
- `open`
- `ignore`
- `monitor`
- `move`
- `archive`
- `trash`
- `permanent-delete`

The first release exposes no permanent-delete capability. Application data and personal data are never handled by the same default rule.

## Observability

Every task has:

- task id;
- phase;
- progress;
- current path/source;
- counters;
- skipped paths with reasons;
- duration;
- cancellation state;
- final summary.

The developer view reads the same task events and persisted job records as the product UI. There is no hidden debugging-only execution path.
