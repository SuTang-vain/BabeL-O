# Error Code: REQUEST_TIMEOUT

## What Happened

The task execution exceeded the configured timeout limit. The runtime stopped the task to prevent runaway execution.

## Why It Happened

Common causes:

1. **Complex task** — The task requires many tool calls or long processing time.
2. **Large context** — The context window is too large, causing slow LLM responses.
3. **Network latency** — Slow connection between Nexus and the provider.
4. **Soft-timeout watchdog** — The soft-timeout budget was exhausted and the hard watchdog stopped the turn.

## How to Fix It

### 1. Ask the Model to Summarize and Narrow Scope

Instead of one large task, ask the model to:

- Summarize current progress
- Focus on a specific subtask
- Provide incremental results

**Example**:
```
Please summarize what you've done so far and focus only on the most critical remaining issue.
```

### 2. Reduce Context Size

Run `/compact` to trigger manual context compaction:

```
/compact
```

Or inspect current context usage:

```
/context
```

### 3. Split the Task

Break the task into smaller, independent subtasks:

- Use worktrees for parallel execution
- Create separate sessions for different parts
- Use `bbl run` for one-shot tasks

### 4. Adjust Timeout (Advanced)

If the task genuinely needs more time, adjust the timeout:

```bash
# For a single run
bbl run --execute-timeout-ms 300000 "your prompt"

# Or set in config
bbl config set executeTimeoutMs 300000
```

**Note**: Increasing timeout should be a last resort. Prefer other solutions first.

## Related Commands

- `bbl config get executeTimeoutMs` — Check current timeout setting
- `bbl run --execute-timeout-ms 300000` — Run with extended timeout
- `/compact` — Trigger manual context compaction
- `/context` — Inspect context usage

## Soft-Timeout Policy

If you're using the soft-timeout policy (`--execute-timeout-policy soft`):

- The runtime will extend the timeout automatically when the model is making progress.
- The watchdog message will show how many extensions were used.
- The hint will credit the watchdog, not recommend raising `--execute-timeout-ms`.

## See Also

- [Context Management Guide](../guides/context-management.md)
- [Task-adaptive Timeout Plan](../nexus/reference/task-adaptive-recoverable-timeout-plan.md)
