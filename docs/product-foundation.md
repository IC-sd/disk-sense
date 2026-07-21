# Product Foundation

## Problem

Users clean a disk, regain space, and lose it again within days. The missing capability is not another fixed list of folders. It is the ability to connect storage to applications, workflows, time, and user intent.

## Positioning

Disk Sense is a personal storage observability and decision system with a reliable conventional cleaner inside it.

It has two loops:

### Immediate loop

Discover → explain → preview → act safely.

### Long-term loop

Snapshot → compare → identify recurring growth → recommend a lasting intervention.

Long-term interventions include moving data, changing application locations, reducing retention, excluding known-important paths, and monitoring growth.

## Product principles

- Unknown is a valid result. Never turn uncertainty into a delete recommendation.
- Every recommendation must show evidence.
- Cleanup is one possible action, not the default answer.
- Personal files and application data are different safety domains.
- The product must explain recurring growth, not merely report current size.
- User decisions become durable memory.
- The default interface is calm and understandable; expert evidence is available on demand.

## Primary objects

- `SpaceObservation`: what exists on disk at a point in time.
- `SpaceSource`: the inferred owner/category of an observation.
- `Evidence`: facts supporting the classification.
- `Recommendation`: a proposed action with confidence and impact.
- `StorageSnapshot`: a time-indexed view used for growth analysis.
- `UserDecision`: keep, ignore, monitor, move, archive, or delete.
- `ActionJob`: an auditable execution with per-item results.
- `ChangeEvent`: a normalized observation of something added, removed, modified, moved, or repeatedly growing.
- `UserMemory`: a human-readable, user-editable memory about a path, application, project, or storage habit.
- `AgentContext`: a permission-scoped context package that another local agent can consume without direct filesystem access.

## Success criteria

- The user can see where system-disk space is going without reading raw paths.
- The product identifies large personal content outside conventional cleanup folders.
- It can explain why an application installed on another drive still consumes system-disk space.
- It can distinguish a one-time cleanup opportunity from a recurring growth source.
- Every destructive action is previewed, auditable, and recoverable where Windows permits.

## Self-evolving memory direction

Disk Sense should not silently train itself or mutate rules. Its learning loop is explicit:

1. observe a change;
2. propose a memory or pattern;
3. show the evidence;
4. let the user accept, edit, or reject it;
5. use accepted memories in later classification.

Accepted memories are stored as Markdown so the user can inspect, edit, back up, or provide them to another agent. Machine indexes may accelerate lookup, but Markdown remains the human-readable source of truth.

Examples:

- “This folder is an active project; never recommend deletion.”
- “This application stores its cache on C: even though it is installed on D:.”
- “Archive completed projects after 90 days without access.”
- “The user usually keeps installers for one month, then moves them to D:\\Archive.”
