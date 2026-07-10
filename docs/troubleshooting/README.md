# Troubleshooting Guide

This directory contains troubleshooting guides for common error codes in BabeL-O.

## Error Code Index

| Error Code | Description | Guide |
|------------|-------------|-------|
| `REQUEST_TIMEOUT` | Task execution exceeded timeout limit | [REQUEST_TIMEOUT.md](./REQUEST_TIMEOUT.md) |
| `CONTEXT_BLOCKING` | Context size exceeded blocking threshold | [CONTEXT_BLOCKING.md](./CONTEXT_BLOCKING.md) |
| `PROVIDER_AUTH_FAILED` | Provider authentication failed | [PROVIDER_AUTH_FAILED.md](./PROVIDER_AUTH_FAILED.md) |
| `WORKTREE_CONFLICT` | Worktree merge conflict detected | [WORKTREE_CONFLICT.md](./WORKTREE_CONFLICT.md) |
| `TOOL_RESULT_BUDGET_EXCEEDED` | Tool output exceeded budget | [TOOL_RESULT_BUDGET_EXCEEDED.md](./TOOL_RESULT_BUDGET_EXCEEDED.md) |

## Quick Reference

### Timeout Errors
- **REQUEST_TIMEOUT**: Ask the model to summarize, narrow scope, or split the task.
- **EXECUTION_TIMEOUT**: Try a simpler task or run `/compact` to reduce context.

### Context Errors
- **CONTEXT_BLOCKING**: Run `/compact` manually or let runtime auto-compact.
- **CONTEXT_LIMIT_EXCEEDED**: Reduce task scope or use `/compact`.

### Provider Errors
- **PROVIDER_AUTH_FAILED**: Check API key with `bbl config audit`.
- **PROVIDER_ERROR**: Check network and API quota.

### Tool Errors
- **TOOL_NOT_FOUND**: Run `/tools` to see available tools.
- **INVALID_TOOL_INPUT**: Check tool schema and retry.
- **WORKTREE_CONFLICT**: Use `bbl sessions worktree-recovery` to resolve.
- **TOOL_RESULT_BUDGET_EXCEEDED**: Use more specific paths or patterns.

## Getting Help

If you encounter an error not listed here:

1. Check the error message for hints.
2. Run `bbl doctor` for system diagnostics.
3. Search or ask in [GitHub Discussions](https://github.com/SuTang-vain/BabeL-O/discussions).
4. Open an issue with the error code and session ID.
