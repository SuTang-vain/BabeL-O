# Go TUI Ctrl+D Top Card Task Page

> State: Draft
> Track: Go TUI
> Priority: P1
> Source of truth: `clients/go-tui/internal/tui/chrome.go`, `clients/go-tui/internal/tui/tui.go`, `clients/go-tui/internal/tui/overlay_tasks.go`
> Related: `TODO.md`, `active/TODO_tui.md`, `go-tui-task-board-and-ask-user-question-plan.md`

## Purpose

Add a task-detail page to the Ctrl+D top-context card so users can monitor
task creation and status during agent execution — the one interactive
surface that remains accessible while `m.running` is true.

The existing `/tasks` overlay (`modeTaskBoard`) is blocked during agent
execution because `startPrompt` returns `nil` when `m.running` is set
(`tui.go:1842`). `Ctrl+D`, in contrast, is a global key handler
(`tui.go:2293`) that bypasses the running guard entirely. This plan
adds left/right arrow key navigation between two pages within the
open top card:

- **Page 0** — Current columns (MCPs, Skills, Session, Memory)
- **Page 1** — Task list (title + status, sourced from `m.taskBoard`)

## Current State

- `tui.go:1157` `topCardOpen bool` — single boolean, no page state.
- `tui.go:2293-2296` `ctrl+d` toggles `topCardOpen`, works globally
  (not guarded by `!m.running` or `m.inputMode == modeComposing`).
- `chrome.go:103-148` `renderTopCard` renders a fixed 4-column layout
  (MCPs, Skills placeholder, Session-to-session, Memory placeholder).
- `overlay_tasks.go:160` `summarizeTaskBoard` provides per-status counts
  (`in_progress 2 · pending 1 · completed 5`).
- `overlay_tasks.go:106-130` `buildTaskBoardLines` + `formatTaskRow`
  produce the ordered line list with `task_id · status · source · owner · title`.
- `tui.go:4660-4684` `consumeNexusEvent` case `task_created` appends
  to `m.taskBoard` in real time (landed in the ask-user-question plan).
- `/tasks` slash command (`modeTaskBoard`) is unreachable during agent
  execution: `startPrompt` at `tui.go:1842` returns `nil` when `m.running`.
- Left/right arrow keys are completely unhandled anywhere in the Go TUI.

## Problem Statement

1. **Runtime accessibility**: `/tasks` (`modeTaskBoard`) requires typing a
   slash command, which `startPrompt` blocks when `m.running` is true. Users
   cannot inspect task state while the agent is working.

2. **Ctrl+D is the available surface**: The top card toggle is global,
   unguarded by `!m.running`, and already shows live context usage, MCP
   servers, and session metadata. Tasks are the natural next column — but
   a single summary line cannot show which tasks exist.

3. **Real-time data is already flowing**: `task_created` events now
   update `m.taskBoard` mid-turn (landed Phase 2-3 of the ask-user-question
   plan). The data is accurate; the missing piece is a UI surface that
   renders it during execution.

## Goals

- Add a task-detail page (page 1) to the Ctrl+D top card, accessible
  with left/right arrow keys while the card is open.
- Page 1 lists each task's title and status from `m.taskBoard`, using
  the same `formatTaskRow` / `buildTaskBoardLines` data pipeline as the
  `/tasks` overlay, but in a compact inline format.
- Page 0 preserves the existing 4-column layout unchanged.
- Left/right arrow keys switch pages only when `topCardOpen` is true;
  when the card is closed, left/right are forwarded to the text input
  (or remain unhandled, same as today).
- `Ctrl+D` close resets the page index to 0.
- Works during agent execution (no `!m.running` guard).

## Non-goals

- No generic page/tab framework — exactly two pages hardcoded.
- No page indicator state machine abstracted beyond `topCardPage int`.
- The `/tasks` overlay (`modeTaskBoard`) is not modified, removed, or
  linked from the top card.
- The top card does not gain scrollable viewports, interactive task
  selection, or per-task actions.
- No changes to `renderTopCard`'s existing column layout on page 0.
- No new keybindings beyond left/right arrow while the card is open.

## Design

### Data flow

```
m.taskBoard ([]nexusTask)
  ├── populated by fetchSessionTasks (api.go:276, on result/error)
  ├── populated by consumeNexusEvent case task_created (tui.go:4660-4684)
  └── read by renderTopCardTaskPage(chrome.go) when topCardPage == 1
```

### State changes

```go
// tui.go model struct addition
topCardPage int  // 0 = columns, 1 = tasks; reset to 0 on close
```

### Key handling

```go
// tui.go Update, inside the global key section (after ctrl+d handler):
if m.topCardOpen {
    if key == "left" {
        m.topCardPage = 0
        m.resize()
        return m, nil
    }
    if key == "right" {
        m.topCardPage = 1
        m.resize()
        return m, nil
    }
}
```

### Rendering

```go
// chrome.go renderTopCard:
if m.topCardPage == 1 {
    return m.renderTopCardTaskPage(width)
}
// existing 4-column layout (unchanged)
```

```go
func (m model) renderTopCardTaskPage(width int) string {
    innerWidth := max(20, width-4)
    title := focusedLineStyle.Render("Tasks · " + shortID(m.sessionID))
    summary := summarizeTaskBoard(m.taskBoard)
    lines := buildTaskBoardLines(m.taskBoard)
    // Cap visible lines to avoid overshooting card height
    maxVisible := max(1, m.height-8)
    visible := lines
    if len(visible) > maxVisible {
        visible = visible[:maxVisible]
        visible = append(visible, mutedStyle.Render(
            fmt.Sprintf("+%d more · open /tasks for full list", len(lines)-maxVisible),
        ))
    }
    content := strings.Join([]string{
        title,
        mutedStyle.Render(summary),
        "",
        strings.Join(visible, "\n"),
        "",
        mutedStyle.Render("← page 0 · ctrl+d close · /tasks full view"),
    }, "\n")
    return topCardFrameStyle.Width(max(0, width-2)).Render(content)
}
```

### Page indicator

No dedicated page indicator widget — the bottom hint line already
reads `← page 0 · ctrl+d close` on page 1 and `page 1 → · ctrl+d close`
on page 0, which serves as both hint and indicator.

## Phases

| Phase | Status | Scope | Exit criteria |
|-------|--------|-------|---------------|
| Phase 1 | **Draft** | Planning document + index updates | `docs/nexus/proposals/README.md` updated, `TODO.md` updated, `active/TODO_tui.md` updated |
| Phase 2 | **Done** | State + rendering | `topCardPage int` field; `renderTopCardTaskPage` in `chrome.go`; page-1 task list renders from `m.taskBoard` |
| Phase 3 | **Done** | Key handling | Left/right arrow in global key section, gated by `m.topCardOpen`; `topCardPage` resets to 0 on `ctrl+d` close |
| Phase 4 | Draft | Verification | `go build ./...` + `go test ./internal/tui` pass; manual `bbl go` smoke: open card, arrow-right to tasks, arrow-left back, close with ctrl+d |

## Verification

- `cd clients/go-tui && go build ./...` — Go build clean.
- `cd clients/go-tui && go test ./internal/tui` — existing tests pass.
- Manual smoke:
  1. `bbl go`, submit a prompt that triggers task creation.
  2. `Ctrl+D` → see existing columns on page 0.
  3. `→` → see task list on page 1 (titles + status).
  4. `←` → back to page 0.
  5. `Ctrl+D` → card closes, page index resets to 0.
  6. During agent execution, `Ctrl+D` → `→` → tasks visible mid-turn.

## Document Ownership

- Current priority lives in `docs/nexus/TODO.md` and `docs/nexus/active/TODO_tui.md`.
- Completed facts move to `docs/nexus/DONE.md`.
- Detailed factual history goes to `docs/nexus/WORK_LOG.md`.
- This document keeps durable architecture boundaries, phase plans, and regression context.

## 中文概述

### 背景

`Ctrl+D` 顶部卡片是 agent 运行期间唯一可用的交互面板（`/tasks` 斜杠命令被 `m.running` 阻断）。当前卡片展示四列（MCP/Skills/Session/Memory），缺失任务信息。

### 核心做法

- 新增 `topCardPage int` 分页状态，Ctrl+D 关闭时重置为 0
- 左右方向键在 `topCardOpen` 状态下切换 page 0/1，无冲突（Go TUI 当前未处理左右键）
- 页面 0 保留现有四列布局不变
- 页面 1 从 `m.taskBoard` 渲染任务标题+状态列表（复用 `formatTaskRow`/`buildTaskBoardLines`），超过可见行数时提示 `+N more · open /tasks`

### 非目标

- 不做通用翻页框架（仅两页硬编码）
- 不修改 `/tasks` overlay
- 不在卡片内支持滚动/交互/任务操作
