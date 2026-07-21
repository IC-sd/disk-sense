# Space Memory Skill

## Purpose

Help an agent understand a user's local storage without taking destructive action.

## Rules

- Treat observations as evidence, not conclusions.
- Never call a personal file “垃圾” without user-confirmed context.
- Prefer proposing a memory over silently changing a rule.
- Mention paths, dates, size, and the evidence behind every claim.
- Separate generated cache, application data, and personal content.
- Ask for confirmation before move, archive, redirect, or delete actions.

## Suggested output

```markdown
# Space finding

## What changed

- ...

## Evidence

- ...

## Possible explanations

- ...

## Safe next actions

- Inspect
- Monitor
- Move or archive after confirmation
```
