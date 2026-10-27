# Cleanup safety model

## Non-negotiable rules

1. No permanent-delete capability is exposed.
2. Unknown, personal, application database, login, configuration and system component content never becomes an automatic cleanup candidate.
3. Rules may only target explicit cache or diagnostic roots and file patterns.
4. Symbolic links, directory junctions and paths escaping the canonical rule root are skipped.
5. The renderer receives an opaque candidate id; it cannot ask the main process to trash an arbitrary path.
6. Every candidate expires after 30 minutes and is revalidated immediately before execution.
7. Browser caches are blocked while the corresponding browser process is running.
8. Cancellation stops between files; the current Recycle Bin operation is allowed to finish safely.
9. Every attempted file receives a success or failure result.
10. User exclusions are applied during scanning and checked again immediately before the Recycle Bin operation.
11. Cleanup audit summaries are complete; stored per-file detail is bounded to 1,000 entries per task with failures retained first.
12. Recognized occupancy and executable cleanup candidates are separate values; recent or process-blocked files may be reported but cannot be selected.
13. Application cache discovery accepts exact allowlisted rebuildable directory names, never a fuzzy substring match for `cache`.
14. Overlapping roots within one rule share canonical-directory traversal. Selection and a whole execution plan deduplicate canonical pathnames; distinct hard-link names remain distinct entries.
15. Scan coverage distinguishes missing or excluded locations from unreadable and partial results. Error samples are bounded to 20 per rule; zero observed bytes must not imply a successful scan of an unreadable location.

## Scan coverage and accounting

The scanner returns bounded stage/path/error diagnostics separately from valid file candidates. Browser and desktop cache discovery uses per-scan contexts, reports permission errors and exhausted depth/directory/entry/time budgets, honors exclusions, and skips links. Partial results remain reviewable under the existing execution guards. Coverage describes built-in discovery and resolved rule roots, not every application configuration or portable installation. Package-manager configuration parsing remains separate. Cross-rule observed occupancy may overlap; executable candidate totals and selections are deduplicated by canonical pathname. Logical file sizes are not an estimate of physical disk space reclaimed.

Open-source evidence, implemented changes, reproducible measurements and remaining gaps are recorded in [cleanup architecture research](cleanup-architecture-research.md).

## Retention windows

| Rule | Minimum age | Additional guard |
| --- | ---: | --- |
| User Temp | 7 days | recently modified files omitted; Playwright/Puppeteer temporary profiles excluded |
| Windows Temp | 7 days | no elevation or forced access |
| Crash dumps | 7 days | preserves recent diagnostics |
| Windows Error Reporting | 14 days | preserves recent diagnostics |
| Thumbnail cache | 1 day | exact filename pattern only |
| DirectX shader cache | 3 days | rebuildable data only |
| Chromium-family browser cache | 3 days | browser must be closed; login and site databases excluded |
| Firefox cache | 3 days | browser must be closed |
| Desktop application renderer cache | 7 days | exact cache roots only; application must be closed |
| VS Code/Discord cache | 7 days | application must be closed |
| npm cache | 14 days | observation only; native tool management, never project dependencies |
| pip cache | 14 days | observation only; native tool management, never virtual environments |
| NuGet HTTP cache | 14 days | observation only; native tool management, never global packages |
| uv/pnpm storage | no age filter | observation only; never generic file deletion |
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

## Tool cache locations

Package caches remain observation-only. `tool-cache-locations.cjs` reads bounded, allowlisted cache settings to identify configured and old default locations without exposing credentials or launching package managers. These locations do not grant generic file cleanup permission.

## Historical data

The governance/recovery module and cross-volume isolation are removed. New cleanup tasks use the Recycle Bin; unsupported execution modes are rejected before any file operation. Old isolation audit entries remain readable, and application-data migration continues preserving their existing journals. Removing the module does not delete isolated files or historical records.
