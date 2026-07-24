# Changelog

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
