# Go TUI Task Board Real-time Update + AskUserQuestion Dialog

> State: Draft
> Track: Go TUI, Tools
> Priority: P1
> Source of truth: `clients/go-tui/internal/tui/tui.go`, `src/tools/builtin/task.ts`, `src/tools/builtin/askUserQuestion.ts`, `src/shared/events.ts`
> Related: `tool-governance-plan.md`, `TODO.md`, `active/TODO_tui.md`

## Purpose

This plan addresses two concrete Go TUI gaps exposed by the current production interactive flow:

1. **Task board (`/tasks` or `ctrl+t`)** does not show tasks created by the LLM via `TaskCreate` tool during an active turn, because the tool does not emit a `task_created` event to the WebSocket stream.
2. **AskUserQuestion dialog** does not exist at all — the model cannot present a structured multi-choice question to the user via the Go TUI.

## Current State

### Task board (broken)
- `src/tools/builtin/task.ts` `TaskCreate` tool saves to storage but does not emit `task_created` event.
- Go TUI `consumeNexusEvent()` has no `case "task_created"` — the event falls through to the generic `default` branch.
- Go TUI refreshes task board via HTTP `GET /v1/sessions/:sessionId/tasks` only at end-of-turn (on `result`/`error` events), so mid-turn task creation is invisible.
- `src/shared/events.ts` already has `TaskCreatedEventSchema` in the `NexusEventSchema` union, but no code path emits it for the LLM tool path.

### AskUserQuestion (missing)
- `AskUserQuestion` tool is `Plan-only` per `tool-governance-plan.md` — never implemented.
- No `ask_user_question` event schema exists in `src/shared/events.ts`.
- No pending question state, no input mode, no dialog renderer in Go TUI.
- Error codes `ASK_QUESTION_OPTIONS_OUT_OF_RANGE` and `ASK_QUESTION_NOT_ALLOWED_COLD_START` exist in `src/shared/errors.ts` as unused constants.

## Problem Statement

1. When the LLM calls `TaskCreate` during a turn, the task is persisted to SQLite but no real-time event reaches the Go TUI. The `/tasks` overlay only updates after the turn ends, making the board stale during multi-turn task creation workflows.

2. When the model needs to ask the user a structured question (e.g., "Which approach should I take? A, B, or C?"), the only option is to emit unstructured assistant text. The Go TUI has no way to present a selectable choice dialog, and the runtime has no tool to produce one.

## Goals

- Make `TaskCreate` tool emit a `task_created` event so the Go TUI can update the task board in real time.
- Add `task_created` event handling in Go TUI `consumeNexusEvent()` to update `m.taskBoard` and render the transcript entry.
- Define `ask_user_question` event schema and make it part of the `NexusEventSchema` union.
- Implement `AskUserQuestion` tool definition that emits the event and waits for a response.
- Implement Go TUI `modeAskUser` dialog overlay with multi-choice selection, keyboard navigation, and decision sending.
- Deliver both features as a Drop 1 (Phase 2-3 = task board fix) + Drop 2 (Phase 4-6 = AskUserQuestion).

## Non-goals

- Task board per-row actions (claim, complete, fail, cancel, retry) remain CLI-only (`bbl sessions tasks <verb>`).
- AskUserQuestion does not support free-form text input in Phase 0 — only multi-choice selection.
- AskUserQuestion does not support cold-start usage (no session context).
- No changes to the Go TUI loop driver (`internal/loop/loop.go`).
- No changes to the permission flow or scope-boundary governance.
- The task board does not gain additional filters or sorting beyond what already exists.

## Design

### Task board real-time update

**Data flow:**

```
LLM → TaskCreate tool → saveTask() + storage.appendEvent(task_created) → WS stream
  → Go TUI consumeNexusEvent() → append to m.taskBoard → renderTaskBoard() picks it up
```

The `TaskCreate` tool's `execute()` method gains a `storage.appendEvent()` call, mirroring the existing `POST /v1/sessions/:sessionId/tasks` REST API handler. The Go TUI's `consumeNexusEvent()` gets an explicit `case "task_created"` that updates `m.taskBoard` in place.

### AskUserQuestion dialog

**Data flow:**

```
LLM → AskUserQuestion tool → emit ask_user_question event → WS stream
  → Go TUI consumeNexusEvent() → create pendingQuestion → setMode(modeAskUser)
  → renderAskUserDialog() shows options
  → User selects → sendQuestionDecision() → HTTP POST /v1/sessions/:sessionId/questions/:toolUseId/response
  → Nexus handler stores response → runtime injects as tool result
```

**Event schema:**

```typescript
export const AskUserQuestionEventSchema = z.object({
  type: z.literal('ask_user_question'),
  ...baseEventFields,
  toolUseId: z.string(),
  question: z.string(),
  header: z.string().optional(),
  options: z.array(z.object({
    label: z.string(),
    description: z.string().optional(),
  })),
  multiSelect: z.boolean().default(false),
})

export const AskUserQuestionResponseEventSchema = z.object({
  type: z.literal('ask_user_question_response'),
  ...baseEventFields,
  toolUseId: z.string(),
  selectedIndices: z.array(z.number().int().min(0)),
  selectedLabels: z.array(z.string()),
})
```

**Tool execution flow:**

1. `AskUserQuestion.execute()` validates input (2-4 options, validates no cold-start).
2. Emits `ask_user_question` event via `storage.appendEvent()`.
3. Returns a `{ status: 'pending_question', toolUseId }` result — the runtime sees this as a non-terminal tool result and pauses the provider loop.
4. The Go TUI receives the event, renders the dialog, and sends the user's choice.
5. The HTTP endpoint accepts the response, emits `ask_user_question_response`, and the runtime resumes the provider loop with the user's choice as the tool result.

## Phases

| Phase | Status | Scope | Exit criteria |
|-------|--------|-------|---------------|
| Phase 1 | **Draft** | Create planning document, update index files | `docs/nexus/proposals/README.md` updated, `TODO.md` updated, `active/TODO_tui.md` updated, `tool-governance-plan.md` updated |
| Phase 2 | Draft | TaskCreate event emission (1A) | `src/tools/builtin/task.ts` emits `task_created` event; `npm run typecheck` passes; test suite passes |
| Phase 3 | Draft | Go TUI task_created handling (1B) | Go TUI `consumeNexusEvent()` handles `task_created`; task board updates in real-time; `go test ./internal/tui` passes |
| Phase 4 | Draft | AskUserQuestion event protocol (2B) | `AskUserQuestionEventSchema` + `AskUserQuestionResponseEventSchema` in `events.ts`; both in `NexusEventSchema` union |
| Phase 5 | Draft | AskUserQuestion tool + route (2A+2D) | `askUserQuestion.ts` tool, `questionRouter.ts` HTTP endpoint, tool registered in registry |
| Phase 6 | Draft | Go TUI question dialog (2C) | `overlay_question.go`, `modeAskUser`, `pendingQuestion`, keyboard handling, decision sending |
| Phase 7 | Draft | Verification + doc graduation | `npm run lint` + `npm test` pass; `go test ./internal/tui` passes; manual `bbl go` verification; DONE.md + WORK_LOG.md updated |

## Verification

- `npm run typecheck` — TypeScript compilation clean.
- `npm test` — full test suite passes (including any new task + question tool tests).
- `cd clients/go-tui && go test ./internal/tui` — Go TUI tests pass.
- Manual `bbl go` smoke: submit prompt that creates a task, verify `/tasks` overlay shows it immediately.
- Manual `bbl go` smoke: verify AskUserQuestion dialog appears when triggered (requires a provider that supports AskUserQuestion calls).

## Document Ownership

- Current priority lives in `docs/nexus/TODO.md` and `docs/nexus/active/TODO_tui.md`.
- Completed facts move to `docs/nexus/DONE.md`.
- Detailed factual history goes to `docs/nexus/WORK_LOG.md`.
- This document keeps only durable architecture boundaries, phase plans, and regression context.

## 中文概述

### 背景

Go TUI 存在两个交互缺陷：LLM 调用 `TaskCreate` 创建任务后，任务面板不实时更新；用户无法通过结构化选择弹窗回应模型提问。

### 核心做法

1. **TaskCreate 事件发射**：在工具执行成功时调用 `storage.appendEvent()` 发出 `task_created` 事件，Go TUI 实时接收并更新 `m.taskBoard`。
2. **AskUserQuestion 弹窗**：新增事件协议 `ask_user_question`，新增工具定义，Go TUI 实现 `modeAskUser` 模式下的选项选择弹窗，通过 HTTP POST 将用户选择返回 runtime。

### 当前状态

Draft。方案设计完成，待按 Phase 1-7 分步实现。

### 下一步

Phase 1：创建规划文档并更新索引文件 → Phase 2：TaskCreate 事件发射。