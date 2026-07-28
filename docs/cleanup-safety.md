# Cleanup safety model

## Non-negotiable rules

1. No permanent-delete capability is exposed.
2. Unknown, personal, application database, login, configuration and system component content never becomes an automatic cleanup candidate.
3. Rules may only target explicit cache or diagnostic roots and file patterns.
4. Symbolic links, directory junctions and paths escaping the canonical rule root are skipped.
5. The renderer receives an opaque candidate id; it cannot ask the main process to trash an arbitrary path.
6. Every candidate expires after 30 minutes and is revalidated immediately before execution.
7. Browser caches are blocked while the corresponding browser process is running.
8. Cancellation stops between files; the current file is allowed to finish its atomic Recycle Bin operation.
9. Every attempted file receives a success or failure result.
10. User exclusions are applied during scanning and checked again immediately before the Recycle Bin operation.
11. Cleanup audit summaries are complete; stored per-file detail is bounded to 1,000 entries per task with failures retained first.

## Retention windows

| Rule | Minimum age | Additional guard |
| --- | ---: | --- |
| User Temp | 7 days | recently modified files omitted |
| Windows Temp | 7 days | no elevation or forced access |
| Crash dumps | 7 days | preserves recent diagnostics |
| Windows Error Reporting | 14 days | preserves recent diagnostics |
| Thumbnail cache | 1 day | exact filename pattern only |
| DirectX shader cache | 3 days | rebuildable data only |
| Chrome/Edge cache | 3 days | browser must be closed |
| Firefox cache | 3 days | browser must be closed |
| VS Code/Discord cache | 7 days | application must be closed |
| npm cache | 14 days | never scans project dependencies |
| pip cache | 14 days | never scans virtual environments |
| NuGet HTTP cache | 14 days | never scans global packages |
| Windows Update cache | 30 days | detection only, not executable |

## System slimming

System slimming is isolated from ordinary file cleanup. It never accepts an executable, argument list or filesystem path from the renderer.

| Capability | Execution boundary |
| --- | --- |
| Hibernation | Calls the fixed `powercfg.exe /hibernate on|off` action after elevation and phrase confirmation |
| Component analysis | Calls DISM `AnalyzeComponentStore`; read-only |
| Component cleanup | Calls DISM `StartComponentCleanup /NoRestart`; never deletes WinSxS files directly |
| ResetBase | Separate danger-level action, marked irreversible and gated by the exact `RESETBASE` phrase |
| Virtual memory | Opens Windows Advanced System Settings; Disk Sense does not edit or delete `pagefile.sys` |
| Windows.old | Opens Windows Storage Settings; Windows remains responsible for removal |

All system actions are selected from a main-process allowlist, use absolute executables under Windows `System32`, run with `shell: false`, recheck administrator privileges, emit progress and retain a bounded local audit result.

## Space reporting

Moving a file to the Recycle Bin preserves the file on the same volume. The job records `movedToTrashBytes` and reports `reclaimedBytes = 0`; actual free space changes only after the user empties the Recycle Bin.
