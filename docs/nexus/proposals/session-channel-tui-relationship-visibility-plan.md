# SessionChannel TUI Relationship Visibility Plan

> State: Draft
> Track: TUI / SessionChannel / Relationship Visibility
> Priority: P2 Watch
> Source of truth: [../TODO.md](../TODO.md), [../active/TODO_tui.md](../active/TODO_tui.md), [../DONE.md](../DONE.md), [../WORK_LOG.md](../WORK_LOG.md), `clients/go-tui/`, `src/cli/`, `src/nexus/`
> Governance: Indexed by [agent-session-skill-governance-index.md](../reference/agent-session-skill-governance-index.md). This document owns relationship visibility UX only; it must not make TUI the owner of SessionChannel truth.
> Related: [context-and-agent-history.md](../history/context-and-agent-history.md), [go-client-distribution-governance-index.md](../reference/go-client-distribution-governance-index.md)

## Goal

SessionChannel already allows different sessions to exchange collaboration context through a typed side-channel. The TUI problem is not to merge multiple session transcripts into one chat stream. The problem is to make the following relationships visible in `bbl chat` and session-management surfaces:

1. Which sessions are linked to the current session.
2. What kind of relationship each link represents.
3. Which links have unread or high-priority events.
4. Where the user should open details, acknowledge, quote, or continue collaboration.

The recommended approach is a layered composition rather than one large panel: use the footer for lightweight default visibility, badges for scannability, tree views for structural relationships, activity overlays for event details, and graph views only for debug or overview.

## Current Baseline

Implemented capabilities:

- The `bbl chat` boxed input footer can show SessionChannel linked / unread state.
- `/inbox` and `/inbox all` can open the side-channel overlay.
- The Inbox overlay supports open/read, ack, and quote into the current prompt.
- Quote only pre-fills the current prompt; the user must review and submit manually.
- The main conversation renders compact event cards only for key unread messages.
- Real PTY smoke covers unread footer, Inbox overlay, ack, quote, main-flow event cards, focus ownership, and resize/navigation stability.

Current boundaries:

- TUI remains a consumption-side entrypoint; creating cross-session messages still goes through Nexus API or AgentScheduler parent-child channels.
- Full message handling remains centered on `/inbox`; cross-session messages are not rendered as current user input.
- A SessionChannel message is collaboration context, not a direct user instruction.

## Non-goals

- Do not implement a raw transcript sharing UI.
- Do not permanently insert another session's message body into the main chat stream.
- Do not allow one session to silently change another session's cwd, provider, profile, permission, or execution state.
- Do not turn memory candidates into default auto-save buttons for long-term memory.
- Do not make graph view the default primary navigation; it is only suitable for complex relationship debugging and overview.

## Recommended Composition

### 1. Footer Indicator: Default Persistent Entry

The footer is the best default place for relationship signals because it is visible, low-interruption, does not steal the input area, and does not make cross-session content look like the current conversation.

Example:

```text
? for shortcuts · [3 conns: main, db, ui] · inbox: 1 unread · high: blocked
```

Displayed information:

- linked session count;
- short names for primary linked sessions;
- unread count;
- high-priority message summary;
- highest-priority message type, such as `blocked`, `handoff`, or `request_review`.

Interaction:

- Show summaries by default, not message bodies.
- When unread items exist, hint that the user can open `/inbox`.
- If a shortcut is added later, it may only open the overlay; it must not auto-ack, auto-quote, or auto-send.

### 2. Session List Badge / Marker: Scan All Sessions

The session list needs to expose which sessions are related to the current work. Badges are better than long text at the end of list rows.

Example:

```text
session-main        active     ⇄ backend-api · !2
session-backend     completed  ← main · handoff
session-db          running    → main · blocked
session-ui          idle       ↗ main · finding
```

Suggested symbols:

```text
→ spawned child / current links to child
← parent / source session
⇄ workspace_pair / synced collaboration
↗ referenced evidence or lightweight relation
! unread
!! high-priority unread
```

Rules:

- Show only the one or two most important relationship summaries per row to avoid horizontal overflow.
- Detail entrypoints still route to `/inbox`, `/sessions tree`, or the activity overlay.
- Badges must not replace ack, quote, or send confirmation.

### 3. Parent-child Tree View: Show Spawn Chains And AgentScheduler Structure

Tree views are good for parent-child or spawned-agent structure, but they should not force every channel graph edge into a hierarchy.

Suggested commands:

```text
/sessions tree
/agents tree
```

Example:

```text
● main               !1
  ├─ ● backend-api   blocked
  │    └─ ● db-migration
  └─ ● frontend-ui   handoff
```

Displayed information:

- parent-child hierarchy;
- session phase / agent status for each node;
- unread / high-priority summaries;
- key message types such as `blocked`, `handoff`, and `request_review`.

Constraints:

- Tree only represents structural relationships; non-tree relationships such as workspace_pair, referenced, and broadcast can be shown as badges or attached lines.
- Do not display full message bodies inside tree nodes.
- Opening details from a tree node should open inbox/activity overlay, not inject messages directly into the prompt.

### 4. Activity Feed Overlay: Review Recent Cross-session Events

The activity feed is useful for reviewing recent events, but it should not become a permanent bottom ticker. It should be a bounded overlay.

Suggested commands:

```text
/activity
/sessions activity
```

Example:

```text
Recent SessionChannel activity
[02:14] backend-api  → main      blocked       "Needs validation"
[02:17] db-migration → main      handoff       "Migration ready"
[02:20] frontend-ui  → main      finding high  "UI mismatch"
```

Rules:

- Limit the default item count, for example to the latest 20 events.
- Support filtering by unread, priority, and channel kind.
- Allow open/read, ack, and quote from a single event.
- Quote still only pre-fills the prompt and requires manual submission.
- The overlay must keep a single input owner and must not fight the slash palette, permission panel, or history search for focus.

### 5. Inline Message Preview: Summary Only, Not The Main Path

Do not put full cross-session message bodies above the input area as the main path. That weakens the boundary between current user input and other sessions' collaboration context.

Acceptable lightweight summary:

```text
! backend-api: blocked · open /inbox
```

Unacceptable default behavior:

- Displaying a full body in a way that looks like current chat history.
- Automatically injecting the body into the prompt.
- Automatically triggering tool calls or ack.
- Treating a message as an instruction for the current session before user confirmation.

### 6. Graph View: Debug-only Overview

Graph view is useful for complex multi-session debugging, not as the default UX.

Suggested commands:

```text
/channels graph
/sessions graph
```

Example:

```text
main ⇄ backend-api
 │       └─ db-migration
 └─ frontend-ui ↗ design-review
```

Rules:

- Hide by default and show only when explicitly invoked.
- Keep it as overview/debug, not the primary ack / quote / send flow.
- When the relationship graph is too large, degrade to a list summary to avoid unreadable ASCII diagrams.

## Future Sender-side UX Direction

Relationship visibility should come before a full sending UI. The current TUI does not have a direct command for creating SessionChannel messages. If this is added later, use two steps:

1. Reply inside `/inbox`: start from an existing message/context to minimize target-selection cost.
2. `/channel send <sessionId|channelId>`: actively create or send a typed message.

The send flow must include:

- explicit message type, such as `question`, `finding`, `request_review`, `request_validation`, `blocked`, or `handoff`;
- explicit target session or channel;
- evidence refs, with evidence required for high-impact messages;
- confirmation preview before send;
- no reuse of the main prompt Enter-to-submit semantics;
- no automatic cwd/provider/profile/permission switching.

## Implementation Order

### Phase 1: Footer Enhancement + Session List Badges

This is the highest-priority UX layer because it provides global awareness of linked, unread, and blocked states with the lowest interaction cost.

**Status (2026-06-17)**: ✅ 已在 `bbl loop` multi-pane TUI 落地。`api.SessionInboxResponse` / `FetchSessionInbox` + `inbox_tick.go` (tea.Cmd 驱动的 inbox 轮询，默认 10s 间隔) + `inbox_chrome.go` (`summarizeInbox` / `formatInboxFooterToken` / `inboxBadgeForSession` 纯函数) + chrome 渲染管道 (`renderInboxIndicator` / `renderFooterLineWithInbox` / `renderSidebarRow` 右侧 badge)。footer 长格式 "inbox: N unread · high: X"（仅高优先级 type 才加 high: 前缀，per plan doc），窄宽度降级 "!!" / "!N"；sidebar 每 pane 行右侧显示 "!N" / "!!"（高优先级时升 "!!"）。Narrow 终端 layout 不破坏 — badge 与 status pill 共同占右侧，padOrTruncate 优先裁 label。28 个新测试 + 全套现有测试 (458 passing in loop package) 全绿。

Exit criteria:

- The `bbl chat` footer can reliably show connection summary, unread count, and high-priority summary.
- The session list can show relationship badges / unread markers.
- Long paths, narrow width, CJK, and resize cases do not break layout.
- PTY smoke covers key unread/high-priority badge paths.

### Phase 2: `/sessions tree` / `/agents tree`

Visualize parent-child and AgentScheduler spawn chains.

Exit criteria:

- Render a parent-child session tree.
- Show unread / blocked / handoff summaries on nodes.
- Do not force non-tree relationships into the hierarchy.
- Allow tree nodes to open inbox/activity details.

### Phase 3：Activity Feed Overlay

Review recent cross-session events.

Exit criteria:

- The overlay is bounded, scrollable, and filterable.
- It supports open/read, ack, and quote into prompt.
- It does not fight the slash palette, permission panel, or history search for focus.
- PTY smoke covers overlay focus ownership and quote without auto-submit.

### Phase 4：Graph View Debug

Implement only when complex session topology needs it.

Exit criteria:

- `/channels graph` or `/sessions graph` can render a concise relationship graph.
- When relationships are too many, degrade to a list summary.
- Clearly mark it as debug / overview, not the primary operation entrypoint.

## Semantic Boundaries

Regardless of presentation layer, these boundaries must hold:

- SessionChannel is a side-channel, not the main chat transcript.
- Messages from other sessions can only be shown as collaboration context.
- Quote only pre-fills the prompt; the user must review and submit manually.
- Ack only changes inbox message state.
- Relationship visibility must not silently change any session's cwd, provider, profile, permission, or execution state.
- Memory candidates only show review-only governance metadata; long-term memory writes must go through a separate approval / permission plan.

## 中文概述

### 背景

SessionChannel 已能表达 session 之间的协作关系，但用户需要在 TUI 中轻量看见这些关系，而不是打开数据库或阅读完整 transcript。

### 核心做法

默认用 footer / badge 提供低打扰信号；复杂关系再进入 tree、activity overlay 或 debug graph。所有跨 session 内容都只能作为 context 展示，不能自动提交、自动 ack 或改变其他 session 状态。

### 当前状态

本文仍是 TUI UX 草案和边界参考。Go TUI 已有部分 inbox / footer 能力，后续扩展应先消费 Nexus API/event，而不是在 TUI 里推导 session truth。
