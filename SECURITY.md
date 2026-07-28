# Security policy

## Reporting a vulnerability

Please do not publish a destructive-cleanup or path-validation vulnerability before a fix is available. Open a private GitHub security advisory for `IC-sd/disk-sense` and include:

- affected version;
- Windows version;
- the cleanup rule or IPC action involved;
- a minimal reproduction;
- whether any file was moved, deleted or exposed.

## Supported versions

Security fixes are provided for the latest 1.x release. Older pre-release builds are not supported.

## Cleanup guarantees

Disk Sense exposes no arbitrary-path or permanent-delete API. Selectable cleanup rules can only move revalidated, short-lived candidates to the Windows Recycle Bin.

System maintenance is a separate allowlisted path:

- the renderer submits only a predefined action id and exact confirmation phrase;
- executable paths and arguments are fixed in the main process and run with `shell: false`;
- administrator privileges are checked immediately before protected actions;
- WinSxS, pagefile and Windows.old files are never deleted directly by Disk Sense;
- DISM and power configuration actions use Windows-owned executables;
- irreversible `ResetBase` is danger-level, isolated from ordinary cleanup and requires the dedicated `RESETBASE` phrase.
