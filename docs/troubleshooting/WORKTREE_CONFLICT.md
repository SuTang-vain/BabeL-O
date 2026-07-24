# Error Code: WORKTREE_CONFLICT

## What Happened

A worktree merge conflict was detected. The agent created a worktree for isolated work, but when merging back, conflicts were found.

## Why It Happened

Common causes:

1. **Concurrent changes** — Same files modified in both worktree and main branch.
2. **Outdated base** — Worktree created from an older commit, now conflicts with new changes.
3. **Large refactor** — Structural changes that affect multiple files.
4. **Incomplete isolation** — Worktree touched files outside its intended scope.

## How to Fix It

### 1. Check Conflict Status

```bash
bbl sessions worktree-recovery <sessionId> <taskId> status
```

This shows:
- Which files have conflicts
- The nature of the conflict
- Available resolution options

### 2. Review Conflicts

Open the conflicting files and review the changes:

```bash
# List conflicting files
git diff --name-only --diff-filter=U

# View specific conflict
git checkout --conflict=merge <file>
```

### 3. Resolve Conflicts

Choose one of these options:

#### Option A: Continue with Resolution

Manually resolve conflicts, then:

```bash
bbl sessions worktree-recovery <sessionId> <taskId> continue
```

#### Option B: Abort Worktree

Discard worktree changes:

```bash
bbl sessions worktree-recovery <sessionId> <taskId> abandon
```

#### Option C: Keep Worktree

Keep the worktree for later resolution:

```bash
bbl sessions worktree-recovery <sessionId> <taskId> keep
```

### 4. Prevent Future Conflicts

- Use smaller, focused tasks
- Pull latest changes before creating worktrees
- Communicate with team about active worktrees
- Use `git pull` in worktrees periodically

## Worktree Best Practices

1. **Keep worktrees short-lived** — Merge quickly to avoid drift.
2. **Use descriptive names** — Help track which worktree is for what task.
3. **Coordinate with team** — Avoid overlapping worktrees on same files.
4. **Review before merge** — Use `git diff main...HEAD` to see changes.

## Related Commands

- `bbl sessions worktree-recovery` — Resolve worktree conflicts
- `bbl sessions list` — List active sessions
- `git worktree list` — List all worktrees
- `git worktree prune` — Clean up stale worktrees

## See Also

- [Worktree Governance Plan](../nexus/reference/worktree-governance-plan.md)
- [Agent Architecture](../guides/agent-architecture.md)
