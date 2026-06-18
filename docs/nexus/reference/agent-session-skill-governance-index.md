# Agent, Session, And Skill Governance Index

> State: Index
> Track: Agent Runtime / Session Collaboration / Skill Product Loop
> Priority: P1 Watch
> Source of truth: `docs/nexus/TODO.md`, `docs/nexus/active/TODO_agents.md`, `docs/nexus/active/TODO_runtime.md`, `docs/nexus/active/TODO_tui.md`, `docs/nexus/active/TODO_performance.md`, `docs/nexus/DONE.md`, `docs/nexus/WORK_LOG.md`, `src/nexus/`, `src/runtime/`, `src/skills/`, `src/storage/`, `clients/go-tui/`
> Related: [agent-runtime-architecture-maturity-plan.md](./agent-runtime-architecture-maturity-plan.md), [context-and-agent-history.md](../history/context-and-agent-history.md), [session-graph-runtime-map-governance-plan.md](../proposals/session-graph-runtime-map-governance-plan.md), [session-channel-tui-relationship-visibility-plan.md](../proposals/session-channel-tui-relationship-visibility-plan.md), [skill-execution-and-automated-normalized-skill-generation-governance-plan.md](../proposals/skill-execution-and-automated-normalized-skill-generation-governance-plan.md), [memory-governance-plan.md](./memory-governance-plan.md), [tool-governance-plan.md](./tool-governance-plan.md)

## Purpose

This document is the reader entry point for the reference plans that connect agent runtime maturity, typed session collaboration, and governed skill execution. These topics are related because they all affect long-running work quality, but they should not collapse into one implementation surface.

The boundary is:

- Agent runtime maturity owns trace, eval, durable resume, loop taxonomy, and runtime observability gaps.
- Session Graph owns the read-only projected runtime map that connects sessions, events, tool calls, permissions, scope boundaries, child sessions, and channel evidence for users.
- Session collaboration owns typed side-channel messages, inbox, relationship visibility, and parent-child collaboration context.
- Skill governance owns explicit skill listing, validation, invocation, draft generation, and save boundaries.
- Memory governance owns long-term hint authority and EverCore / EverOS lifecycle.
- Tool governance owns tool classes, tool failure semantics, MCP/native tool coexistence, and new-tool admission.

## Ownership Map

| Document | Role | Reading rule |
| --- | --- | --- |
| [agent-runtime-architecture-maturity-plan.md](./agent-runtime-architecture-maturity-plan.md) | Agent runtime maturity roadmap. | Use for trace schema, trajectory eval, durable resume, MCP context primitive, memory quality metrics, and loop taxonomy. |
| [context-and-agent-history.md](../history/context-and-agent-history.md) | Typed SessionChannel and scoped memory architecture. | Use for channel/message/inbox data model, storage/API expectations, and provider-visible inbox boundaries. |
| [session-graph-runtime-map-governance-plan.md](../proposals/session-graph-runtime-map-governance-plan.md) | Session Graph runtime map proposal. | Use for projecting existing session/event/tool/permission/child-session/channel facts into a user-readable graph without creating a second source of truth. |
| [session-channel-tui-relationship-visibility-plan.md](../proposals/session-channel-tui-relationship-visibility-plan.md) | TUI relationship visibility over SessionChannel. | Use for footer indicators, session list badges, tree/activity/graph views, and quote/ack UX boundaries. |
| [skill-execution-and-automated-normalized-skill-generation-governance-plan.md](../proposals/skill-execution-and-automated-normalized-skill-generation-governance-plan.md) | Skill execution and skill generation product loop. | Use for skill schema, registry, validator, explicit skill tools, draft/save confirmation, and diagnostics. |

## Governance Rules

### 1. Agent trace is derived from existing truth

Agent trace should project from Nexus events, execution metrics, tool traces, permissions, task scope, and storage records. It should not become an independent second history that disagrees with session events.

### 1a. Session Graph is a projection, not storage truth

Session Graph may compose agent trace, session assets, SessionChannel records, child sessions, tool traces, permission audits, and scope events into a runtime map. It must remain derived, replayable, and discardable; if the graph disagrees with source events or storage records, the source facts win.

### 2. SessionChannel is collaboration context

Messages from other sessions are not direct user instructions. They can provide findings, review requests, blocked states, or handoff context, but the receiving session must verify claims against current workspace evidence before acting.

### 3. TUI visibility does not imply authority

Go TUI and TypeScript TUI can display relationships, badges, inbox overlays, and activity feeds. They must not infer runtime state, auto-acknowledge high-impact messages, auto-submit quoted text, or modify another session's cwd/provider/profile/permission state.

### 4. Skills are explicit capabilities, not hidden policy

Implicit skill matching may provide context, but explicit skill execution, validation, generation, and saving must be observable. Skill metadata cannot bypass tool policy, permission policy, workspace boundaries, or evidence requirements.

### 5. Memory remains non-authoritative

Session channels and skills may reference memory, but long-term memory remains a hint layer. Project facts must still be grounded in workspace files, tool results, or session evidence.

### 6. Do not add broad mega-tools

Prefer narrow skill tools and narrow channel APIs. Avoid a single `Skill` or `Session` mega-tool that combines list/show/invoke/save/send/ack semantics and erases risk boundaries.

## Current State

The current implementation already has meaningful slices:

- Agent orchestration, sub-agent delegation, worktree isolation, and recovery paths are covered in TODO/DONE and runtime code.
- SessionChannel and inbox behavior have landed enough TUI support to make relationships visible in Go TUI and DONE entries.
- The skill loader/matcher/system prompt path exists, including built-in/user/project skill loading and compact retention.
- The full explicit skill product loop is still not complete: list/show/validate/invoke/draft/save should remain governed work, not assumed done.
- Agent trace/eval/durable resume remains a maturity gap rather than a completed production-grade runtime claim.

## Open Watch Items

| Item | Owner document | Status |
| --- | --- | --- |
| Agent trace projection and export | [agent-runtime-architecture-maturity-plan.md](./agent-runtime-architecture-maturity-plan.md) | P1 Watch. |
| Session Graph runtime map | [session-graph-runtime-map-governance-plan.md](../proposals/session-graph-runtime-map-governance-plan.md) | Draft. |
| Trajectory eval harness | [agent-runtime-architecture-maturity-plan.md](./agent-runtime-architecture-maturity-plan.md) | P1 Watch. |
| Durable run checkpoint/resume | [agent-runtime-architecture-maturity-plan.md](./agent-runtime-architecture-maturity-plan.md) | P1 Watch. |
| SessionChannel API/storage/context invariants | [context-and-agent-history.md](../history/context-and-agent-history.md) | Partially landed; keep evidence-first. |
| TUI relationship visibility polish | [session-channel-tui-relationship-visibility-plan.md](../proposals/session-channel-tui-relationship-visibility-plan.md) | Draft / UX follow-up. |
| Explicit skill tools and normalized skill generation | [skill-execution-and-automated-normalized-skill-generation-governance-plan.md](../proposals/skill-execution-and-automated-normalized-skill-generation-governance-plan.md) | Partially landed substrate; product loop open. |

## Verification Expectations

Changes in this group should be verified with the relevant slice from:

- session/event replay tests;
- storage parity tests across MemoryStorage and SQLite;
- runtime context assembly tests for inbox/skill visibility;
- Go TUI PTY smoke for relationship and inbox UX;
- skill loader/registry/validator tests;
- permission and workspace-boundary tests for generated/saved skills;
- docs governance checks to keep reference state and ownership clear.

## 中文概述

### 背景

Agent runtime、SessionChannel、TUI 关系可见化和 Skill 生成都服务于长任务质量，但它们不是同一个模块。过去这些规划平铺在 reference 里，读者很容易把 session 协作、长期记忆、技能执行和 agent runtime 混成一条路线。

### 核心边界

Agent trace 只能从现有事件和存储事实派生；SessionChannel 是协作上下文，不是用户直接指令；TUI 只展示关系和消息，不拥有 runtime truth；Skill 能力必须可见、可验证、可审批，不能绕过工具和权限策略。

### 当前状态

SessionChannel / inbox / Go TUI 可见化已有部分落地；skill loader 与 implicit matching 已存在；但显式 skill product loop、agent trace、trajectory eval、durable resume 仍是打开项。

### 下一步

后续新增或修改相关文档时，先判断它属于 agent runtime、session collaboration、skill product loop、memory 还是 tool governance，再挂到对应入口，避免继续扩散成多个互相覆盖的规划。
