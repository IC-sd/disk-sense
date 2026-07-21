# Agent Contract (Draft)

Disk Sense will expose a local, permission-scoped context interface for future agents.

An agent can request:

- current space summary;
- selected observations and evidence;
- snapshot deltas;
- accepted user memories;
- pending recommendations;
- operation history.

An agent cannot directly delete, move, or redirect files. It can propose an action. The Decision Center must validate the proposal and ask the user for confirmation.

## Context package

```json
{
  "schemaVersion": 1,
  "createdAt": "2026-07-20T00:00:00.000Z",
  "scope": ["C:\\Users\\You\\Downloads"],
  "observations": [],
  "memories": [],
  "changes": [],
  "permissions": { "readMetadata": true, "readContent": false, "mutateFiles": false }
}
```

The contract is intentionally local-first. Network or cloud access is opt-in and never required for core classification.
