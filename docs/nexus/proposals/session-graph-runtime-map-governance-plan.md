# Session Graph Runtime Map Governance Plan

> State: Draft
> Track: Agent Runtime / Session Collaboration / Evidence / TUI
> Priority: P1 Watch
> Source of truth: [../TODO.md](../TODO.md), [../active/TODO_agents.md](../active/TODO_agents.md), [../active/TODO_runtime.md](../active/TODO_runtime.md), [../active/TODO_tui.md](../active/TODO_tui.md), [../DONE.md](../DONE.md), [../WORK_LOG.md](../WORK_LOG.md), `src/shared/session.ts`, `src/shared/sessionChannel.ts`, `src/runtime/agentTrace.ts`, `src/runtime/runCheckpoint.ts`, `src/nexus/sessionAssets.ts`, `src/storage/`, `clients/go-tui/`
> Governance: Indexed by [agent-session-skill-governance-index.md](../reference/agent-session-skill-governance-index.md). This document owns the projected Session Graph / runtime map UX and data contract; it must not introduce a second source of truth outside Nexus events and storage records.
> Related: [agent-runtime-architecture-maturity-plan.md](../reference/agent-runtime-architecture-maturity-plan.md), [context-and-agent-history.md](../history/context-and-agent-history.md), [session-channel-tui-relationship-visibility-plan.md](./session-channel-tui-relationship-visibility-plan.md), [go-tui-session-observability-governance-plan.md](./go-tui-session-observability-governance-plan.md), [task-scope-and-evidence-scope-governance-plan.md](../reference/task-scope-and-evidence-scope-governance-plan.md), [evidence-governance-index.md](../reference/evidence-governance-index.md)

## Purpose

BabeL-O already stores the raw bones of a session runtime map: session snapshots, ordered Nexus events, tool traces, permission audits, execution metrics, task sessions, parent-child sessions, SessionChannel messages, scope-boundary events, worktree metadata, and derived agent traces.

The missing layer is a user-understandable Session Graph: a projected runtime map that answers, at a glance:

1. What work happened in this session?
2. Which tools, approvals, denials, scope boundaries, and external roots shaped the run?
3. Which child sessions or agent jobs were spawned, blocked, handed off, cancelled, or reviewed?
4. Which SessionChannel messages link this session to other sessions?
5. Where did execution land: cwd, worktree, runner, allowed paths, task scope, and relevant evidence roots?
6. Which claims are backed by current workspace/tool evidence, and which are only collaboration or memory hints?

The design inspiration is the Session-first framing popularized by OpenRath: the unit that should be forked, routed, inspected, and explained is the session dataflow, not an individual agent's private chat log. BabeL-O should absorb the graph and lineage insight, while preserving its Nexus-first product boundary: the graph is a projection from runtime facts, not a new mutable session object.

## Current State

Implemented substrate:

- `SessionSnapshot` already includes `sessionId`, `cwd`, `prompt`, `phase`, ordered `events`, `parentSessionId`, `assignedAgentId`, `currentTaskId`, `allowedPaths`, and metadata.
- `sessionAssets.ts` can build a snapshot containing the session, tasks, child sessions, events, tool traces, permission audits, critic reviews, usage, and execution metrics.
- `agentTrace.ts` projects ordered `NexusEvent[]` into stable spans for run, provider invocation, tool calls, permissions, scope boundaries, compact/recovery, memory updates, sub-agent handoffs, and final results.
- `runCheckpoint.ts` derives resumability from the session phase, event stream, and pending-permission state without claiming durable continuation snapshots that do not exist.
- SessionChannel has typed relationships and evidence references: direct/group/parent_child/workspace_pair/project_bridge channels, messages such as finding/request_review/request_validation/decision/blocked/memory_candidate/handoff, and `session_event` / `tool_trace` / `file` / `url` / `note` evidence refs.
- The Go TUI and `bbl loop` have started rendering inbox and relationship hints, but the user still cannot see a coherent graph-shaped map of a session's runtime trajectory.

Known gap:

- Operators can inspect separate slices (`/context`, `/inbox`, session assets, agent trace, task board, tool panel), but they cannot ask one question -- "show me the runtime map for this work" -- and get a compact, navigable, evidence-aware graph.

## Problem Statement

The current inspection experience is fragmented. A user investigating a long run must mentally join:

- the main session transcript;
- tool start/completion events;
- permission request/response records;
- scope boundary events;
- child session snapshots;
- AgentScheduler job lifecycle;
- SessionChannel inbox messages;
- worktree or cwd placement;
- memory candidate governance;
- final result/error state.

This fragmentation weakens the exact strength BabeL-O is trying to build: durable, auditable coding sessions. The raw facts exist, but the runtime map is not yet visible as a single object.

The risk is not merely UX polish. Without a graph projection, users and maintainers are likely to misdiagnose:

- whether a conclusion came from the parent session or a child session;
- whether a handoff was acknowledged or only queued;
- whether a tool result had permission approval, denial, or recoverable failure;
- whether a path was in task scope or confirmed as an external root;
- whether a failed branch was reviewed and rejected or simply abandoned;
- whether memory/channel content was treated as evidence without workspace revalidation.

## Goals

- Provide a canonical `SessionGraph` projection derived from existing storage facts.
- Keep event stream, session records, tool traces, permission audits, and SessionChannel records as the only facts.
- Make graph nodes and edges stable enough for CLI JSON, TUI rendering, tests, and future exports.
- Represent parent-child session structure, tool/permission/scope relationships, channel messages, evidence references, and execution placement in one bounded data shape.
- Make the graph useful at three zoom levels: summary, focused node detail, and full debug JSON.
- Preserve evidence governance: memory and cross-session messages are hints unless backed by current workspace/tool/session evidence.
- Avoid forcing graph view to become the primary UI; it should support inspection, recovery, and orientation.

## Non-goals

- Do not introduce an OpenRath-style mutable `Session` object as a second runtime state.
- Do not store a separate durable graph table in v1. Recompute from storage unless profiling proves it too slow.
- Do not let the TUI infer missing runtime state. The TUI consumes graph data from Nexus APIs or CLI projections.
- Do not merge transcripts from multiple sessions.
- Do not let graph actions approve permissions, ack messages, quote text, resume runs, or merge worktrees without the existing explicit flows.
- Do not make memory candidates authoritative project facts.
- Do not implement general graph editing, arbitrary agent workflow construction, or a new agent planner DSL.
- Do not change permission policy, task-scope policy, or workspace safety rules.

## Design

### 1. Conceptual Model

The Session Graph is a runtime map, not a data store.

```text
Storage facts
  sessions
  events
  tool_traces
  permission_audits
  execution_metrics
  tasks / task sessions
  session channels / messages
  worktree metadata
        |
        v
Pure projectors
  projectAgentTrace(events)
  deriveResumableState(session, events)
  projectSessionGraph(input)
        |
        v
Consumers
  bbl inspect-session --graph
  Nexus GET /v1/sessions/:id/graph
  Go TUI /sessions graph or details overlay
  tests / export fixtures
```

The graph should reuse `projectAgentTrace()` rather than rebuild tool/permission/span derivation from scratch. The new projector should compose existing projections and side records into a graph-shaped view.

### 2. Data Contract

Initial TypeScript shape:

```ts
export type SessionGraphNodeKind =
  | 'session'
  | 'turn'
  | 'agent_job'
  | 'task'
  | 'tool_call'
  | 'permission'
  | 'scope_boundary'
  | 'channel_message'
  | 'worktree'
  | 'memory_candidate'
  | 'result'

export type SessionGraphEdgeKind =
  | 'parent_child'
  | 'contains'
  | 'spawned'
  | 'requested'
  | 'approved'
  | 'denied'
  | 'confirmed_scope'
  | 'used_evidence'
  | 'handoff'
  | 'blocked'
  | 'reviewed'
  | 'ran_in'
  | 'derived_from'

export type SessionGraphNode = {
  id: string
  kind: SessionGraphNodeKind
  label: string
  status: 'ok' | 'running' | 'waiting' | 'blocked' | 'failed' | 'cancelled' | 'unknown'
  sessionId?: string
  timestamp?: string
  summary?: string
  evidenceRefs?: Array<{ type: string; ref: string; label?: string }>
  attributes?: Record<string, unknown>
}

export type SessionGraphEdge = {
  id: string
  kind: SessionGraphEdgeKind
  from: string
  to: string
  label?: string
  timestamp?: string
  attributes?: Record<string, unknown>
}

export type SessionGraph = {
  type: 'session_graph'
  schemaVersion: '2026-06-18.babel-o.session-graph.v1'
  rootSessionId: string
  generatedFrom: {
    sessions: number
    events: number
    toolTraces: number
    permissionAudits: number
    channelMessages: number
  }
  nodes: SessionGraphNode[]
  edges: SessionGraphEdge[]
  summaries: {
    phases: Record<string, number>
    tools: Record<string, number>
    permissions: { approved: number; denied: number; pending: number }
    scopeBoundaries: { detected: number; confirmed: number; denied: number }
    channels: { unread: number; highPriority: number; handoffs: number; blocked: number }
  }
  warnings: string[]
}
```

This shape intentionally favors simple, stable graph primitives over a rich domain object hierarchy. Consumers can filter by `kind`, `status`, `sessionId`, or edge type.

### 3. Node Rules

Session nodes:

- One node for the root session.
- One node for each child session included in the bounded query.
- Status mirrors `SessionSnapshot.phase`.
- Attributes include cwd, prompt preview, created/updated time, parent session, assigned agent, allowed paths, and metadata keys that are safe to expose.

Tool nodes:

- Derived primarily from `agentTrace` tool spans and tool trace records.
- Include tool name, success/failure, truncation, original bytes, remote runner, known target path, and source event indices.
- Do not include full tool output by default; details view can fetch the underlying trace or event.

Permission nodes:

- Derived from permission request/response events and permission audits.
- Status is approved, denied, pending, or unknown.
- Scope-aware permission metadata should be visible when present: target root, task primary root, scope risk, and scope reason.

Scope boundary nodes:

- Derived from `task_scope_declared`, `scope_boundary_detected`, and `scope_boundary_confirmed`.
- Show primary root, explicit roots, confirmed external roots, target root, boundary kind, and action.
- Link to the relevant tool node when `toolUseId` is available.

Channel message nodes:

- Derived from SessionChannel messages involving the root session or included child sessions.
- Show type, priority, status, source/target session, and evidence refs.
- Message bodies are summarized by default and capped.
- Memory candidate messages become `memory_candidate` nodes when governance metadata is present.

Worktree / placement nodes:

- Derived from session cwd, allowed paths, task/worktree metadata, and tool/runner attributes.
- v1 should not invent a new placement authority. It only renders known fields.
- A later phase may introduce a normalized `executionPlacement` projection if repeated UI logic emerges.

Result nodes:

- Derived from terminal `result` or `error` events.
- Link to the root session and any reviewer/critic task evidence when available.

### 4. Edge Rules

Parent-child:

- `session.parentSessionId -> session.sessionId`.
- AgentScheduler-created `parent_child` SessionChannel can reinforce the same relationship, but must not create duplicate structure edges.

Contains:

- Root session contains events, tool nodes, permissions, scope nodes, channel messages, and result nodes.
- Child sessions contain their own bounded details when included.

Tool / permission / scope:

- Tool node -> permission node with `requested`.
- Permission node -> tool node with `approved` or `denied`.
- Tool node -> scope boundary node with `requested` or `confirmed_scope`.
- Scope boundary node -> external root/worktree/placement node when known.

SessionChannel:

- Message source session -> message node.
- Message node -> target session with `handoff`, `blocked`, `reviewed`, or a generic typed edge.
- Evidence refs from messages produce `used_evidence` edges only when the target object is present in the graph; otherwise keep refs on the node.

Worktree / placement:

- Session or tool node -> worktree/placement node with `ran_in`.
- Do not infer worktree merges. Merge/recovery actions need explicit task or worktree recovery evidence.

### 5. API And CLI Surfaces

Nexus API:

```text
GET /v1/sessions/:sessionId/graph?depth=1&include=events,tools,permissions,channels,children
```

Recommended query fields:

- `depth`: child session depth, default `1`, max `3`.
- `eventLimit`: default `300`, max `2000`.
- `childSessionLimit`: default `50`, max `200`.
- `include`: comma list, default `summary,tools,permissions,scope,channels,children,result`.
- `format`: `graph` default, later `timeline` if needed.

CLI:

```text
bbl inspect-session <sessionId> --graph
bbl inspect-session <sessionId> --graph --json
bbl sessions graph <sessionId>
```

Text output should be layered:

```text
Session Graph: session_...
phase=completed cwd=/repo children=2 tools=7 permissions=3 scope=1 handoffs=1

root
  tool Read src/runtime/agentTrace.ts       ok
  permission Bash                           denied
  scope ! sibling_repo /Users/.../BabeL-X   confirmed
  child session_abc                         completed · handoff
  result                                    ok

Open details:
  bbl inspect-session <id> --trace
  bbl sessions inbox <id>
```

Go TUI:

- Add read-only graph/relationship detail overlay only after the API and CLI shape are stable.
- Default view should be compact tree/timeline, not a dense graph drawing.
- Node actions may open existing detail views (`/inbox`, tool details, trace span, session transcript), but must not directly mutate runtime state.

### 6. Integration With BabeL-O Loop Surfaces

BabeL-O uses "loop" for several layers. Session Graph should integrate with each layer differently:

| Loop layer | Current role | Session Graph relationship |
| --- | --- | --- |
| runtime / tool loop | Provider calls, tool execution, permission flow, scope-boundary events, terminal result. | Primary event source for tool, permission, scope, result, and evidence nodes. |
| AgentLoop | Planner / Executor / Critic / Optimizer, task sessions, sub-agent jobs, worktree review. | Source for child-session, task, review, blocked, handoff, and failed-branch nodes. |
| single-session Go TUI loop | Interactive prompt, permission panel, overlays, stream rendering. | Secondary consumer: can open a read-only graph/trace overlay for the current session. |
| `bbl loop` multi-pane loop | Workspace/tab/pane model, one pane per session, loop_state reconciliation, health polling, per-pane wait stream, inbox badges. | Best consumer surface: focused-pane graph overlay plus sidebar/footer summaries. |

The `bbl loop` fit is strong because it already has the right boundaries:

- `loop_state` maps pane/workspace/tab to `sessionId`, `cwd`, label, and `lastRev`.
- `/v1/runtime/loop/health` is already a server-owned projection for pane status, pending permissions, pending scope boundaries, out-of-scope evidence, task scope, memory candidate counts, and behavior hints.
- `/v1/sessions/:id/wait` already streams bounded event increments into each pane transcript.
- The loop inbox tick already renders SessionChannel unread/high-priority summaries for the focused pane and sidebar badges for related panes.
- Scope review and behavior trace overlays already prove the pattern: fetch focused-pane detail lazily, render read-only, and keep high-frequency status paths light.

Recommended `bbl loop` integration:

1. Keep `/v1/runtime/loop/health` lightweight. It may later expose graph summary counts such as `graphWarnings`, `childSessions`, `handoffs`, or `failedBranches`, but it must not return the full graph.
2. Add a focused-pane lazy endpoint call, for example `GET /v1/sessions/:sessionId/graph`, triggered by an explicit key or command such as `g`.
3. Cache the latest graph response by `(sessionId, lastRev)` in the Go loop model or overlay state. When health/wait advances `LastEventRev`, mark the graph stale instead of refetching immediately.
4. Render the default overlay as a compact tree/timeline:

```text
Session Graph · session_...
phase=executing · pane=pane_... · cwd=/repo

root
  tool Read src/runtime/agentTrace.ts          ok
  permission Bash                              denied
  scope ! sibling_repo /Users/.../BabeL-X      confirmed
  child session_abc                            completed · handoff
  result                                       waiting

Press Enter: details · i: inbox · t: trace · esc: close
```

5. Let graph nodes open existing detail surfaces rather than creating new mutation paths:
   - channel message -> inbox overlay;
   - tool node -> tool trace / session events detail;
   - scope node -> scope review overlay;
   - child session -> child transcript view;
   - result node -> inspect-session trace/result detail.
6. Do not write graph data to `loop_state`. `loop_state` is pane layout and cursor state; graph data remains derived from Nexus session/runtime storage.
7. Do not let Go reconstruct graph semantics from raw events. Go may render and cache the server graph, but Nexus/runtime remains the graph authority.

This makes Session Graph a runtime-map layer over existing loops, not another loop. The graph explains what the runtime/tool loop and AgentLoop produced; `bbl loop` provides the cockpit for viewing it.

### 7. Evidence And Authority Rules

- Every node must record enough source provenance to explain where it came from: event index, event type, storage table, message id, tool use id, or session id.
- Graph warnings should surface degraded projections: missing `session_started`, orphan tool completions, missing child sessions, unresolved permission request, truncated event page, missing channel records, or inconsistent parent ids.
- Memory candidate and SessionChannel nodes must be visibly labelled as collaboration/hint context.
- The graph must never upgrade a memory hit, compact summary, or inbox message into workspace evidence.
- Strong status claims in graph summaries should be backed by terminal events or persisted session phase, not assistant prose.

### 8. OpenRath-Inspired Boundaries

Useful to borrow:

- Make session lineage visible.
- Treat agents as transformations over session state conceptually.
- Show execution placement as part of the runtime map.
- Make fork/child/handoff/review paths inspectable.
- Keep examples focused on evidence dossiers, not screenshots.

Not useful to borrow directly:

- A mutable Python `Session` value as BabeL-O's core runtime API.
- A user-authored workflow DSL that bypasses Nexus permission and task-scope gates.
- Automatic memory commit as a default behavior.
- Client-side graph truth.

## Phases

| Phase | Status | Scope | Exit criteria |
| --- | --- | --- | --- |
| Phase 0 | Draft | Define `SessionGraph` schema, projector inputs, truncation/warning rules, and golden fixtures from existing sessions. | Unit tests cover empty, simple, permission, scope, child-session, and channel-message graphs without touching storage. |
| Phase 1 | Draft | Implement `projectSessionGraph()` as a pure function composing `projectAgentTrace()`, session snapshots, tool traces, permission audits, and SessionChannel records. | Deterministic IDs, no I/O in projector, degraded warnings for missing pieces, storage parity tests can feed the same input shape. |
| Phase 2 | Draft | Add Nexus API and `bbl inspect-session --graph --json` using bounded queries and existing session assets helpers. | CLI JSON stable; text rendering useful; MemoryStorage and SQLite focused tests pass. |
| Phase 3 | Draft | Add Go TUI / `bbl loop` read-only graph/detail overlay after API stability. Full graph fetch is focused-pane lazy, never part of the health hot path. | PTY tests cover open overlay, stale graph indicator after `LastEventRev` advances, navigate nodes, narrow width, no auto-ack/auto-approve/auto-submit. |
| Phase 4 | Draft | Add examples and docs: "session evidence dossier" walkthrough with parent/child/session-channel/tool/permission/scope graph. | README or docs guide shows a real inspect flow; docs check passes. |
| Phase 5 | Draft | Evaluate optional graph export formats and performance caching only if real large sessions prove recomputation too slow. | No cache table unless benchmark or real session trace shows need; any cache remains derived and invalidatable. |

## Verification

Required tests:

- Pure projector unit tests for node/edge derivation.
- Regression fixtures for permission approval, denial, pending permission, scope boundary confirmed, scope denied, child handoff, blocked child, memory candidate, and terminal error.
- Deterministic ID tests: same input yields same graph IDs.
- Truncation tests: graph warnings when events, children, tool traces, or channel messages are page-limited.
- Storage parity tests: MemoryStorage and SQLite produce the same graph for the same scenario.
- CLI tests for `inspect-session --graph` text and JSON output.
- Go TUI / `bbl loop` PTY smoke only after Phase 3, including lazy graph fetch, stale graph marker after new wait events, and no graph fetch during normal health polling.
- `npm run docs:check` after adding or moving docs.

Manual checks:

- Run a small coding session with one permission request and inspect its graph.
- Run a parent session that spawns a child Explore/Review job and inspect the parent graph.
- Send a SessionChannel handoff and confirm it appears as collaboration context, not as current-user instruction.

## Document Ownership

- This proposal owns the graph projection contract and user-facing runtime map.
- `agent-runtime-architecture-maturity-plan.md` continues to own span-level agent trace.
- `session-channel-tui-relationship-visibility-plan.md` continues to own inbox/footer/tree relationship visibility UX.
- `go-tui-session-observability-governance-plan.md` continues to own session persistence and inspectability gaps.
- `task-scope-and-evidence-scope-governance-plan.md` continues to own scope-boundary detection and permission flow.
- `evidence-governance-index.md` continues to own evidence authority rules.

If this proposal lands, implementation facts should move to `DONE.md` / `WORK_LOG.md`; the stable contract can graduate to `reference/` only after the graph schema is used by at least CLI and one TUI surface.

## 中文概述

### 背景

OpenRath 的文章和项目给 BabeL-O 一个很清楚的提醒：多 Agent 系统真正需要用户看懂的不是"又有几个 Agent"，而是 Session 这份工作状态如何流动、分叉、被工具影响、被权限裁决、被子会话接力、最终形成证据链。BabeL-O 已经有 session、event、tool trace、permission audit、child session、SessionChannel、agent trace 等骨架，但目前这些信息分散在不同入口里。

### 核心做法

本草案建议新增一个 `SessionGraph` 投影层，把现有事实源统一投影成用户能看懂的运行时地图。它不是新数据库，也不是新的可变 Session 对象；它只从 Nexus 事件、存储记录、tool trace、permission audit、SessionChannel、child session 和现有 agent trace 中派生。

### 边界

不能照搬 OpenRath 的 Python `session = workflow(session)` 模型，也不能让 TUI 自己推导 runtime truth。BabeL-O 的优势是 Nexus-first、permission-first、evidence-first，所以 Session Graph 必须保持只读、可复盘、可降级、有来源标注，并且不把 memory 或跨 session message 当成事实源。

### 下一步

最小下一步是 Phase 0：定义 `SessionGraph` schema 和纯 projector fixture。先覆盖简单 session、工具调用、权限、scope boundary、child session、SessionChannel handoff 这几类样本，再考虑 CLI/API/TUI 展示。

`bbl loop` 的结合度很高，但应该作为展示驾驶舱而不是事实推导层。完整 graph 需要 focused pane 按需拉取；高频 `/v1/runtime/loop/health` 只保留轻量状态和摘要，避免把运行时地图变成轮询热路径。
