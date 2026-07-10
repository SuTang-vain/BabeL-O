# Error Code: CONTEXT_BLOCKING

## What Happened

The context size exceeded the blocking threshold. The runtime automatically compacts the context before continuing.

## Why It Happened

Common causes:

1. **Large files read** — Many or large files added to context.
2. **Long conversation** — Extended session with many turns.
3. **Verbose output** — Tools producing large amounts of output.
4. **Insufficient compaction** — Auto-compact not keeping up with context growth.

## How to Fix It

### 1. Let Auto-Compact Run

The runtime will automatically compact context when it approaches the limit. Wait for it to complete.

### 2. Run Manual Compact

Trigger immediate context compaction:

```
/compact
```

### 3. Reduce Context Scope

- Use more specific file paths in your requests
- Ask for summaries instead of full file contents
- Focus on specific subdirectories

### 4. Check Context Usage

```
/context
```

This shows:
- Current context size
- Context ceiling
- Top context consumers

### 5. Adjust Context Ceiling (Advanced)

```bash
# Set higher context limit
bbl config set maxContextTokens 200000
```

**Note**: Higher limits may increase costs and latency.

## Context Blocking vs Context Limit

- **CONTEXT_BLOCKING**: Soft limit, runtime auto-compacts and continues.
- **CONTEXT_LIMIT_EXCEEDED**: Hard limit, task fails if compaction doesn't help.

## Related Commands

- `/compact` — Trigger manual compaction
- `/context` — Inspect context usage
- `bbl config get maxContextTokens` — Check context limit

## See Also

- [Context Management Guide](../guides/context-management.md)
- [Context Governance Plan](../nexus/reference/context-governance-index.md)
