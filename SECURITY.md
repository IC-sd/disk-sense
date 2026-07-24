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

Disk Sense has no permanent-delete API. Selectable cleanup rules move revalidated files to the Windows Recycle Bin. System component maintenance is read-only in the current release.
