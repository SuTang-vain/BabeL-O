# Task Lifecycle Tool Family Expansion Plan

> State: Draft
> Track: Tools
> Priority: P1
> Source of truth: `src/tools/builtin/task.ts`, `src/nexus/taskQueue.ts`, `src/nexus/routers/sessionTaskMutationRouter.ts`, `src/shared/task.ts`, `clients/go-tui/internal/tui/overlay_tasks.go`, `src/runtime/runtimeToolLoop.ts`
> Related: `tool-governance-plan.md`, `TODO.md`, `active/TODO_runtime.md`, `active/TODO_tui.md`

## Purpose

This plan addresses the incomplete task lifecycle in the LLM-visible tool surface. Currently only `TaskCreate` exists, producing tasks that are permanently stuck in `pending` status. The model cannot list tasks, update their status, or mark them complete. This plan adds `TaskList` and `TaskUpdate` tools to close the lifecycle loop.

## Current State

### What exists

- **`TaskCreate` tool** (`src/tools/builtin/task.ts`): LLM-visible, persists to SQLite via `storage.saveTask()`, emits `task_created` event via `runtimeToolLoop.ts` for real-time Go TUI updates.
- **`TaskQueue`** (`src/nexus/taskQueue.ts`): In-memory `Map<string, NexusTask>` used exclusively by `agentLoop.ts` (Planner-Executor-Critic workflow). Has `createNexusTask`, `claimNexusTask`, `completeNexusTask`, `updateNexusTask` — all in-memory only.
- **REST API** (`src/nexus/routers/sessionTaskMutationRouter.ts`): Full CRUD via HTTP — `POST /tasks, PATCH /tasks/:id, POST .../claim, /complete, /fail, /cancel, /retry, /approve, /reject, /rerun-subagent`.
- **Go TUI task board** (`overlay_tasks.go`): Read-only display of tasks fetched via `GET /v1/sessions/:sessionId/tasks`. Real-time `task_created` event handling in `consumeNexusEvent()`. No per-row actions.

### What's missing

| Tool | Status | Impact |
|------|--------|--------|
| `TaskList` | ❌ Doesn't exist | LLM cannot see what tasks exist |
| `TaskUpdate` | ❌ Doesn't exist | Tasks created by LLM are permanently `pending` |
| `task_updated` event | ❌ Doesn't exist | Go TUI cannot reflect status changes in real-time |

### The gap

Two isolated task systems:

1. **SQLite tasks** (via `TaskCreate` tool): persistent, Go TUI-visible, but LLM cannot update → tasks stay `pending` forever
2. **Memory tasks** (via `TaskQueue`/`agentLoop`): auto-advanced through states, but Go TUI-invisible

## Problem Statement

LLM-created tasks are dead ends: they exist in SQLite, are visible in the Go TUI `/tasks` panel, but the model has no way to advance their lifecycle. There is no `TaskList` tool to enumerate tasks, and no `TaskUpdate` tool to change status, title, description, or result fields.

This is not a regression — it is a known gap from the original tool surface design where `TaskList`/`TaskUpdate`/etc. were listed as "Plan-only" in `tool-governance-plan.md`.

## Goals

- Add `TaskList` tool (read risk) so the LLM can enumerate tasks for the current session, optionally filtered by status.
- Add `TaskUpdate` tool (task risk) so the LLM can change task status (pending → in_progress → completed/failed/cancelled), title, description, and result.
- Emit `task_updated` events from the runtime so the Go TUI receives real-time status updates.
- Handle `task_updated` events in Go TUI `consumeNexusEvent()` to update `m.taskBoard` in place.
- Keep the existing `TaskCreate` tool unchanged.

## Non-goals

- Do not merge SQLite and in-memory task systems. `TaskQueue` remains agentLoop-internal.
- Do not add Go TUI per-row actions. Task board remains read-only; operations go through the LLM or CLI.
- Do not add `TaskClaim`, `TaskComplete`, `TaskFail`, `TaskCancel` as separate tools — `TaskUpdate` with `status` field covers all state transitions.
- Do not add `WebSearch`-style provider abstraction for task backends.
- Do not change the agentLoop task lifecycle or `TaskQueue` implementation.

## Design

### TaskList tool

| Field | Value |
|-------|-------|
| `name` | `TaskList` |
| `risk` | `read` |
| `requiresApproval` | false |
| `inputSchema` | `{ status?: TaskStatus }` |

```typescript
inputSchema: z.object({
  status: z.enum(['pending', 'in_progress', 'blocked', 'completed', 'failed', 'cancelled']).optional(),
})

execute(input, context):
  tasks = await storage.listTasks(context.sessionId)
  if input.status:
    tasks = tasks.filter(t => t.status === input.status)
  return { success: true, output: { tasks: tasks.map(t => ({ taskId, title, status, description? })) } }
```

### TaskUpdate tool

| Field | Value |
|-------|-------|
| `name` | `TaskUpdate` |
| `risk` | `task` |
| `requiresApproval` | true |
| `suggestedAllowRule` | `- tool: TaskUpdate` |
| `inputSchema` | `{ taskId: string, status?: TaskStatus, title?: string, description?: string, result?: string }` |

```typescript
inputSchema: z.object({
  taskId: z.string().min(1),
  status: z.enum(['pending', 'in_progress', 'blocked', 'completed', 'failed', 'cancelled']).optional(),
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  result: z.string().optional(),
})

execute(input, context):
  task = await storage.getTask(input.taskId)
  if (!task || task.sessionId !== context.sessionId) → TASK_NOT_FOUND
  if input.status:
    validateTransition(task.status, input.status) → TASK_TERMINAL on illegal back-transition
  updated = { ...task, ...input, updatedAt: now() }
  await storage.saveTask(updated)
  return { success: true, output: { taskId, title, status, updatedAt } }
```

**Valid status transitions:**

```
pending → in_progress ✅
pending → completed ✅
pending → cancelled ✅
in_progress → completed ✅
in_progress → failed ✅
in_progress → cancelled ✅
blocked → cancelled ✅
completed → (any) ❌
failed → (any) ❌
cancelled → (any) ❌
```

### Runtime event emission

In `src/runtime/runtimeToolLoop.ts`, after the `TaskCreate` event emission block (lines 1084-1106), add a parallel block for `TaskUpdate`:

```typescript
if (result.success && tool.name === 'TaskUpdate' && finalOutput && typeof finalOutput === 'object') {
  const taskOutput = finalOutput as Record<string, unknown>
  if (typeof taskOutput.taskId === 'string' && typeof taskOutput.title === 'string') {
    yield {
      type: 'task_updated',
      ...eventBase(runtimeOptions.sessionId),
      taskId: taskOutput.taskId,
      title: taskOutput.title,
      status: taskOutput.status,
    }
  }
}
```

### Go TUI event handling

In `clients/go-tui/internal/tui/tui.go` `consumeNexusEvent()`, add a new case after `task_created`:

```go
case "task_updated":
    taskID := stringField(event, "taskId")
    title := stringField(event, "title")
    status := parseTaskStatus(stringField(event, "status"))
    // Update the task in m.taskBoard in place
    for i, t := range m.taskBoard {
        if t.TaskID == taskID {
            m.taskBoard[i].Title = title
            if status != "" {
                m.taskBoard[i].Status = taskStatus(status)
            }
            break
        }
    }
    m.appendLine("task_updated", formatNexusEvent(event))
```

### Event schema

Add to `src/shared/events.ts`:

```typescript
export const TaskUpdatedEventSchema = z.object({
  type: z.literal('task_updated'),
  ...baseEventFields,
  taskId: z.string(),
  title: z.string(),
  status: z.enum(['pending', 'in_progress', 'blocked', 'completed', 'failed', 'cancelled']).optional(),
})
```

Include in `NexusEventSchema` discriminated union.

## Phases

| Phase | Status | Scope | Exit criteria |
|-------|--------|-------|---------------|
| Phase 0 | **Draft** | Create planning document, update index files | `proposals/README.md`, `TODO.md`, `active/TODO_runtime.md`, `active/TODO_tui.md`, `tool-governance-plan.md` updated |
| Phase 1 | Draft | TaskList tool | `task.ts` exports `taskListTool`; `npm run typecheck` passes |
| Phase 2 | Draft | TaskUpdate tool | `task.ts` exports `taskUpdateTool` with valid transition logic; `npm run typecheck` passes |
| Phase 3 | Draft | Runtime event emission | `runtimeToolLoop.ts` yields `task_updated` for `TaskUpdate`; `npm run typecheck` passes |
| Phase 4 | Draft | Go TUI event handling | `consumeNexusEvent()` handles `task_updated`; `go build ./internal/tui` passes |
| Phase 5 | Draft | Verification + doc graduation | `npm run lint` + `npm test` + `go test ./internal/tui` pass; DONE.md + WORK_LOG.md updated |

## Verification

- `npm run typecheck` — TypeScript compilation clean.
- `npm test` — full test suite passes (1314 tests, 17 pre-existing failures unchanged).
- `cd clients/go-tui && go build ./internal/tui` — Go TUI package compiles.
- `go test ./internal/tui` — Go TUI tests pass.
- Manual `bbl go` smoke: create a task via LLM, then use `TaskList` to verify, then `TaskUpdate` to change status, verify `/tasks` panel reflects the change.

## Document Ownership

- Current priority lives in `docs/nexus/TODO.md` and `docs/nexus/active/TODO_runtime.md`.
- Completed facts move to `docs/nexus/DONE.md`.
- Detailed factual history goes to `docs/nexus/WORK_LOG.md`.
- This document keeps only durable architecture boundaries, phase plans, and regression context.

## 中文概述

### 背景

当前 LLM 只能通过 `TaskCreate` 创建任务，但无法查看任务列表（缺少 `TaskList`）也无法推进任务状态（缺少 `TaskUpdate`）。创建的任务永远停留在 `pending` 状态。

### 核心做法

1. **TaskList 工具**：read risk，可选按状态过滤，返回当前 session 的任务列表
2. **TaskUpdate 工具**：task risk，需审批，支持状态转换（pending→in_progress→completed/failed/cancelled）和字段修改
3. **事件发射**：runtime 在 `TaskUpdate` 成功后 yield `task_updated` 事件
4. **Go TUI 实时更新**：`consumeNexusEvent()` 处理 `task_updated` 事件，实时更新 `m.taskBoard`

### 当前状态

Draft。方案设计完成，待按 Phase 0-5 分步实现。

### 下一步

Phase 0：创建规划文档并更新索引文件 → Phase 1：TaskList 工具。