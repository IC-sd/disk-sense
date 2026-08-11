# Changelog

## 0.9.0-beta.7 - 2026-08-11

This beta closes several cross-module reliability and desktop-security gaps found during a full release audit.

### Changed

- Added one foreground disk-operation coordinator shared by change scans, cleanup rule scans, cleanup execution, Windows maintenance and data-directory migration. Compatible cleanup rules can still scan together, while conflicting operations now fail early instead of competing for disk I/O or producing misleading snapshots.
- Denied all unneeded Electron renderer permission checks and requests by default, in addition to the existing sandbox, isolated preload and navigation boundaries.
- Made data-directory migration resume automatic file indexing when checkpointed migration preparation fails, while keeping indexing paused after a successful move that requires restart.
- Corrected the published security support statement and release artifact names.

### Development and validation

- Vite can select a free loopback port when 5173 is occupied. Development-only HTML receives an exact CSP WebSocket origin for that selected port; packaged HTML remains network-restricted.
- Added a repeatable real-Electron development smoke test covering the actual Vite HMR WebSocket, light theme, global search, Office shortcut ranking, keyboard selection, explanation rendering and existing desktop security assertions.
- Added coordinator, session-permission, migration-recovery and development-CSP regression tests.

## 0.9.0-beta.6 - 2026-08-10

This beta focuses on desktop responsiveness and development reliability without changing the cleanup boundary.

### Changed

- Paused directory metadata hydration, icon loading, search refreshes and index subscriptions while the cached Directory & Files page is inactive, reducing background work during page switches.
- Made storage usage and device inspection lazy in Settings so opening the page no longer starts both expensive reads immediately.
- Reordered Settings around the common appearance and privacy entry while keeping storage and device details available on demand.
- Made Electron development mode follow the actual loopback URL selected by Vite instead of assuming port 5173.

### Validation

- Added lifecycle regression coverage for cached workspaces and strict tests for the dynamic development-server boundary.
- Extended real Electron smoke coverage for dynamic development ports, global Word search ranking, settings navigation and existing renderer security assertions.

## 0.9.0-beta.5 - 2026-08-09

This beta broadens conventional cleanup coverage without broadening the deletion boundary. Scanning now distinguishes all recognized files from the smaller set that currently satisfies retention, process and rule safety conditions.

### Added

- Expanded conventional cleanup from 22 to 26 rules with Chrome Canary, Brave, Vivaldi, Chromium, Opera, DingTalk, QQ renderer cache, Tencent Meeting, new Teams cache locations, and standard rebuildable caches for several desktop utilities.
- Added explicit observed, retained and actionable counters so recent files can explain occupied space without silently becoming cleanup candidates.
- Added focused safety tests for exact cache-directory discovery and observed-versus-actionable accounting.

### Changed

- Replaced unbounded-style sequential cache-root discovery with bounded per-root cursor queues and periodic event-loop yielding, preventing one application tree from consuming every discovery slot.
- Updated cleanup rows and completion summaries to make the difference between discovered files and safely actionable files visible.
- Removed the duplicate recent-temporary-files observation rule; recent files are now retained and reported by their owning cleanup rule, avoiding double counting.
- Expanded repository ignore rules for local databases, credentials, logs, screenshots, editor state and build artifacts.
- Pinned vulnerable transitive build and download dependencies to patched releases reported by the current package audit.

### Safety

- Generic names containing `cache` are not accepted. Only explicitly allowlisted rebuildable directory names are discovered.
- Chat history, user databases, downloads, login state, configuration and personal files remain outside the new application-cache rules.
- Existing candidate-vault, process, age, exclusion, canonical-path and file-identity checks remain mandatory before a file can be moved to the Recycle Bin.

## 0.9.0-beta.4 - 2026-08-01

Public beta of the expanded Disk Sense desktop experience. The project maturity
has been intentionally re-baselined below 1.0 until real-user feedback and
long-running validation cover a broader range of Windows systems and storage
layouts. The earlier `v1.0.0` tag remains available only as historical context.

The `v0.9.0-beta.1` tag did not publish artifacts because its clean runner
depended on a machine-specific Electron distribution path. Beta.2 removes that
assumption and downloads the official Electron build during packaging.

The `v0.9.0-beta.2` tag completed the main CI workflow but its release workflow
exposed a Windows timestamp-precision edge case in the cleanup safety suite.
Beta.3 skips the minimum-age comparison when a detection-only rule explicitly
uses a zero-day lower bound; the focused safety suite passed 12 consecutive
runs before this release.

The `v0.9.0-beta.3` release built successfully, but GitHub normalized spaces in
uploaded executable names while the checksum manifest retained them. Beta.4
uses stable `Disk-Sense-*` artifact names end to end so downloaded files match
the SHA-256 manifest exactly.

### Added

- Added global file search inside Directory & Files: a persistent SQLite metadata database now starts automatically, watches available drives for create/rename/delete changes, periodically reconciles missed changes, supports type/time filters and multiple sort modes, and hands every result to the same local/AI explanation panel. Manual rebuild is now a maintenance action in Settings instead of a search-page requirement.
- Expanded conventional cleanup to 22 rules across Windows, browsers, application caches, developer tools, diagnostics, graphics caches, and Windows Update detection.
- Added executable Windows maintenance with a fixed action allowlist: hibernation on/off, DISM component-store analysis, `StartComponentCleanup`, and separately gated `ResetBase`.
- Added Windows-owned settings entry points for virtual memory and previous Windows installations.
- Added maintenance progress, administrator detection, actual free-space deltas, bounded local history, and explicit success/failure results.
- Added persistent dark/light themes with full-page desktop visual coverage.
- Added install/data location reporting, bounded usage statistics, and user-selected data migration with free-space checks, SHA-256 verification, first-launch state synchronization, restart handoff, and retained source backup.
- Added a local device-information view for Windows edition/build, CPU, memory, GPU, uptime, application version, and current install/data paths.

### Safety

- File search indexes metadata only, skips filesystem links, excludes its own SQLite files, remains bounded and cancellable, and never turns a search result into a cleanup candidate.
- System maintenance accepts only predefined action ids; executable paths and arguments never come from renderer input.
- Every maintenance action requires an exact confirmation phrase and rechecks elevation immediately before execution.
- `ResetBase` is isolated as an irreversible danger-level action and requires the dedicated `RESETBASE` confirmation phrase.
- Ordinary cleanup remains candidate-vault based and Recycle-Bin-only; unknown and personal content is never selected automatically.
- Data migration rejects drive roots, network paths, nested source/target paths, non-empty destinations, and locations inside the installation directory; the original data is never deleted automatically.

### Changed

- Moved the persistent file index and SQLite search/ranking workload into a dedicated worker thread, coalesced stale keystroke searches, and added a reproducible benchmark for indexing throughput, query latency, and renderer-loop responsiveness.
- Changed directory browsing to staged metadata hydration: names and types render first, while only visible rows receive bounded metadata and directory-size estimates.
- Removed selected-file content reads, Office brand-icon discovery, and cross-volume application-location probing from the Electron main thread; these bounded evidence tasks are now asynchronous and concurrency-limited.
- Reduced the shipped UI stylesheet by removing obsolete component rules from replaced explorer, cleanup, and settings views; added a regression check so deleted templates cannot leave dead CSS behind.
- Reused the shared desktop risk normalizer, cached per-result search rankings, bounded renderer-side native file presentation caching, and narrowed CommonJS exports to the APIs actually consumed outside each module.
- Removed tracked development logs and the obsolete credential-reading release helper; releases continue through the validated package and GitHub workflow paths.
- Removed the machine-specific Electron distribution path from packaging so clean Windows release runners resolve the official Electron build reliably.
- Made global search results update smoothly during continuous typing, added Arrow Up/Down selection and Enter-to-explain, improved ranking of Windows application shortcuts, and kept the previous result set stable while a new query is running.
- Reduced background disk pressure by keeping the persisted search index immediately available, relying on live filesystem monitoring for active sessions, and deferring full-drive startup reconciliation until the index is meaningfully stale.
- Replaced full-directory materialization with bounded directory streams in the explorer and cleanup scanners, and added bounded batched cleanup execution for large plans without weakening per-file validation.
- Expanded change tracking to a 500,000-entry/60-second bounded scan with explicit root-change and partial-coverage reasons, and now confirms before replacing an existing baseline.
- Corrected the explanation panel and selected-row colors to use semantic theme tokens so local and AI explanations remain readable in both light and dark themes.
- Added an explicit system-drive warning when the local search index and application data become large enough that moving the data directory is advisable.
- Reworked the cleanup center into garbage cleanup, system slimming, and operation-audit views with a shared five-level risk language.
- Merged disk-change tracking into Space Overview, replacing the redundant navigation cards and separate sidebar entry with one useful storage-status workspace.
- Reordered Settings to About, Storage Location, and General; disk-capacity information now has one canonical home on Space Overview instead of being repeated in About.
- Unified the cleanup and system-maintenance visual design with a restrained dark palette; risk colors are now reserved for labels and necessary warnings.
- Improved category progress, scan cancellation, exclusion management, lock/process reporting, and real desktop smoke coverage.
- Upgraded the local state schema to v6 for persisted appearance settings and expanded packaged smoke coverage to settings, device information, and both themes.

## 1.0.0 - 2026-07-24

First complete desktop release candidate of the clean Disk Sense rewrite.

### Added

- Explorer-style file and directory explanation beginning at `C:\`.
- Local path, name, context, structure, signature, and bounded-content evidence analysis.
- Optional OpenAI-compatible AI review with automatic model discovery and normal/deep modes.
- Multi-volume capacity overview and local activity summary.
- Bounded disk-change baselines with honest partial-coverage reporting.
- Fifteen low-risk or detection-only cleanup rules, five-level risk language, process guards, user exclusions, cleanup history, and per-file results.
- Read-only system slimming detection for hibernation, component storage, virtual memory, Windows.old, and ResetBase risk.
- Settings and privacy page with exact local data location.

### Safety

- Cleanup accepts only short-lived opaque candidates issued by the current scan.
- Symbolic links and canonical-root escapes are skipped.
- File identity, retention age, process state, and user exclusions are checked again before execution.
- Selectable cleanup only moves files to the Windows Recycle Bin; permanent deletion is not exposed.
- Unknown and personal content is never an automatic cleanup candidate.

### Release status

The generated local installer and portable executable are suitable for functional validation. Public distribution still requires trusted Authenticode signing and a clean Windows VM installation pass.

### Reliability polish

- Added fair per-volume change scanning, per-volume coverage reporting, directory-tree byte aggregation, unambiguous file-move inference, and bounded comparison history.
- Split large change snapshots from frequently written settings and protected valid backups from malformed-primary overwrite.
- Added bounded file-prefix reads, expanded application attribution, filesystem-link handling, and in-process AI result LRU storage.
- Redacted common credential formats from remote AI evidence.
- Added cleanup traversal/time limits, guarded-process refresh, fail-closed enumeration errors, and recycle-bin retry coverage.
- Added recursive desktop syntax checks, rotating local diagnostics, and automatic single-window main-process restart in desktop development mode.
- Added three-way cleanup scan limit reporting, credential redaction across all remote evidence text fields, packaged-app smoke screenshots, and installed/portable release verification.
- Pinned all build-chain `brace-expansion` paths to patched version 5.0.8 after GHSA-mh99-v99m-4gvg, including legacy minimatch consumers used by electron-builder.
- Kept the development window visible during Vite dependency optimization and verified single-window Electron restarts with real main-process file changes.
