# Error Code: TOOL_RESULT_BUDGET_EXCEEDED

## What Happened

A tool produced output that exceeded the configured budget. The runtime automatically truncates large outputs to prevent context explosion.

## Why It Happened

Common causes:

1. **Large file read** — Reading a very large file in one operation.
2. **Verbose command** — Running a command that produces massive output.
3. **Broad search** — Using patterns that match too many results.
4. **Recursive operations** — Operating on deeply nested directory structures.

## How to Fix It

### 1. Use More Specific Paths

Instead of:
```
Read the entire src/ directory
```

Try:
```
Read src/main.ts and src/config.ts
```

### 2. Use Line Limits

For large files, request specific line ranges:

```
Read lines 1-100 of src/large-file.ts
```

### 3. Use More Specific Patterns

Instead of:
```
Search for "function" in the codebase
```

Try:
```
Search for "function parseConfig" in src/config/
```

### 4. Let Truncation Work

The runtime automatically truncates large outputs. You can ask the model to:

- Summarize the truncated output
- Focus on specific parts
- Use incremental reading

### 5. Adjust Budget (Advanced)

```bash
# Increase tool result budget
bbl config set toolResultBudgetBytes 500000
```

**Warning**: Larger budgets increase context size and costs.

## Tool Output Behavior

| Tool | Truncation Behavior |
|------|---------------------|
| `Read` | Shows first N bytes/lines, mentions truncation |
| `Grep` | Caps at N matches |
| `Glob` | Caps at N files |
| `Bash` | Truncates stdout/stderr separately |

## Related Commands

- `bbl config get toolResultBudgetBytes` — Check current budget
- `/context` — See context usage from tool outputs

## See Also

- [Context Management Guide](../guides/context-management.md)
- [Tool Governance Plan](../nexus/reference/tool-governance-plan.md)
