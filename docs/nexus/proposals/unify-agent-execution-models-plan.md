# Unify Agent Execution Models Plan

> State: Draft
> Track: Agent / Nexus / Runtime
> Priority: P1 — three overlapping "agent" subsystems with non-uniform session/task/job vocabulary and no shared state owner undermines "Nexus owns execution, session is a view"
> Source of truth: [../TODO.md](../TODO.md), [../active/TODO_agents.md](../active/TODO_agents.md), [../DONE.md](../DONE.md), [../WORK_LOG.md](../WORK_LOG.md), `src/nexus/agentLoop.ts`, `src/nexus/agents/AgentScheduler.ts`, `src/nexus/agents/AgentJobRegistry.ts`, `src/nexus/taskSession.ts`, `src/nexus/taskQueue.ts`, `src/nexus/executionStreamLoop.ts`
> Governance: Indexed by [README.md](../README.md) and [agent-session-skill-governance-index.md](../reference/agent-session-skill-governance-index.md). Canonical owner of "there is one agent execution model with one state owner." Agent maturity stays in [agent-runtime-architecture-maturity-plan.md](../reference/agent-runtime-architecture-maturity-plan.md); session-channel collaboration stays in [history/context-and-agent-history.md](../history/context-and-agent-history.md).
> Related: [agent-runtime-architecture-maturity-plan.md](../reference/agent-runtime-architecture-maturity-plan.md), [agent-session-skill-governance-index.md](../reference/agent-session-skill-governance-index.md), [daemon-graceful-shutdown-and-orphan-reaper-plan.md](./daemon-graceful-shutdown-and-orphan-reaper-plan.md)

## Purpose

BabeL-O has three "agent" subsystems that overlap in vocabulary but not in code or state ownership. This plan governs the convergence: one vocabulary, one state owner (SQLite), so that "Nexus owns execution, session is a view" holds for the agent path too — not only for `/v1/execute`.

## Current State

Three subsystems:

| Subsystem | Entry | State owner | Daemon-exposed? |
| --- | --- | --- | --- |
| `runAgentLoop` (planner/executor/critic + worktree) | `agentLoop.ts:224` | **In-process Maps** `taskSessions` (`taskSession.ts:21`), `taskQueues` (`taskQueue.ts:15`) + write-behind | ❌ CLI-only (`optimize.ts:182`) |
| `ExploreAgentScheduler` (explore/review/test jobs) | `AgentScheduler.ts` | SQLite + in-memory `AgentJobRegistry.jobs` (`AgentJobRegistry.ts:58`) | ✅ `/v1/agents` |
| `/v1/execute` direct | `executionStreamLoop.ts:39` | SQLite | ✅ |

- `runAgentLoop` is **not exposed by the daemon** — it is called only from `src/cli/commands/optimize.ts:182` (+ smoke/benchmark). Its state lives in-process Maps; SQLite is a write-behind cache. "Session is a view" does **not** hold here.
- `ExploreAgentScheduler` persists jobs + child sessions to SQLite (`AgentScheduler.ts:176-188`) and drives `runtime.executeStream` itself (`:277`). Jobs are the unit, not sessions.
- Concepts diverge: a `task_session` (agentLoop) ≠ an agent `job` (Scheduler) ≠ a Nexus `session` (execute route). All three are called "agent/session/task" in different places.
- `AgentScheduler.runAgentJob` calls `runtime.executeStream` with `skipPermissionCheck: true` (`AgentScheduler.ts:284`) — spawned agents bypass the permission system; the only guard is the profile tool allowlist (`assertProfileAllowedTools`, `:584-596`).
- `AgentScheduler.createExploreRuntime` (`:429-441`) **re-instantiates a separate runtime** (its own `createDefaultToolRegistry` + `LLMCodingRuntime`/`LocalCodingRuntime`) — a second, divergent runtime-construction site that does not share the parent's tool policy, hooks, or behavior monitor.
- The `/v1/agents` spawn schema advertises `implement`/`debug`/`general` profiles (`agentRouter.ts:10`) that `assertSchedulableProfile` (`AgentScheduler.ts:492-499`) rejects at runtime — dead schema surface that 400s.

## Problem Statement

Three models mean: durability is inconsistent (only two survive daemon death — see [daemon-graceful-shutdown-and-orphan-reaper-plan.md](./daemon-graceful-shutdown-and-orphan-reaper-plan.md)), the `/v1/agents` surface and the `bbl optimize` surface cannot share progress/handoff semantics, and a fix to agent lifecycle must be applied per-subsystem. The CLI-only `runAgentLoop` is invisible to the daemon and to remote clients, contradicting the Nexus-first identity.

## Goals

- One agent execution vocabulary: a spawned unit is an **agent job** with a **child session**; `task_session`/`task_queue` terminology is retired or mapped 1:1.
- SQLite is the state owner for all three paths; in-process Maps become views/caches, not sources of truth.
- `runAgentLoop` is exposed and drivable through the daemon (or explicitly retired in favor of `ExploreAgentScheduler` if the planner/executor/critic flow is subsumed).
- Spawned agents do not silently bypass permissions — `skipPermissionCheck` is replaced by a profile-scoped policy that is auditable (ties into [runtime-tool-permission-flow-reference.md](../reference/runtime-tool-permission-flow-reference.md)).
- One runtime-construction site; `createExploreRuntime` reuses the parent runtime's policy/hooks/behavior-monitor (or is explicitly a configured child, not a fresh construction).
- Dead schema (`implement`/`debug`/`general` profiles) removed or implemented.

## Non-goals

- Do not collapse the planner/executor/critic orchestration into the explore/review/test scheduler if they are genuinely different flows — convergence is about vocabulary + state ownership + daemon exposure, not forcing one control flow.
- Do not change the worktree isolation (well-engineered; owned by `worktree.ts`).
- Do not change `/v1/execute` direct path semantics.

## Design

### Phase 1 — Vocabulary + state-owner audit

1. Define the canonical model in this doc: `AgentJob { id, parentSessionId, childSessionId, profile, status, ... }` persisted in SQLite; `AgentJobRegistry` is the in-memory view; `task_session`/`task_queue` are retired aliases.
2. Map every current callsite to the canonical model. Produce a table in WORK_LOG.

### Phase 2 — Make `runAgentLoop` SQLite-owned

1. Move `taskSessions`/`taskQueues` from in-process Maps to SQLite-backed reads/writes (the storage already has `saveTask`/`listTasks` via `TaskRepository`). In-process state becomes a cache.
2. This unblocks daemon-death recovery for the agent-loop path (pairs with [daemon-graceful-shutdown-and-orphan-reaper-plan.md](./daemon-graceful-shutdown-and-orphan-reaper-plan.md) Phase 2).

### Phase 3 — Daemon-expose the planner/executor/critic flow

1. Either expose `runAgentLoop` via a new `/v1/agents/optimize` (or similar) route, or fold its planner/executor/critic stages into `ExploreAgentScheduler` as a profile. Decision deferred to Phase 3 design spike; default to a new route to preserve the existing `bbl optimize` UX.
2. `bbl optimize` then calls the daemon route instead of `runAgentLoop` directly (mirrors the embedded-path unification in [unify-embedded-cli-path-plan.md](./unify-embedded-cli-path-plan.md)).

### Phase 4 — Permission + runtime-construction convergence

1. Replace `skipPermissionCheck: true` (`AgentScheduler.ts:284`) with a profile-scoped `ToolPolicy` (allowlist-based) that flows through the shared `requestToolPermission` ([runtime-tool-permission-flow-reference.md](../reference/runtime-tool-permission-flow-reference.md)). Spawned agents still do not prompt interactively, but their tool calls are policy-gated and audited, not unchecked.
2. `createExploreRuntime` reuses the parent runtime (configured child) instead of fresh construction; share tool policy, hooks, behavior monitor.
3. Remove the dead `implement`/`debug`/`general` profile schema entries (`agentRouter.ts:10`) or implement them.

## Phases

| Phase | Status | Scope | Exit criteria |
| --- | --- | --- | --- |
| Phase 1 | Draft | Canonical model + callsite map. | WORK_LOG records the 1:1 mapping; no behavior change. |
| Phase 2 | Draft | `runAgentLoop` state → SQLite-owned. | Agent-loop path survives daemon restart (paired with shutdown proposal); `test/agent-loop.test.ts` green. |
| Phase 3 | Draft | Daemon-expose planner/executor/critic (new route or folded profile). | `bbl optimize` drives the daemon; remote clients can observe agent-loop progress. |
| Phase 4 | Draft | Profile-scoped permission policy + shared runtime construction + dead-schema cleanup. | No `skipPermissionCheck` bypass; `createExploreRuntime` shares parent policy; `agentRouter` schema matches schedulable profiles. |

## Verification

- `npm test` (existing `test/agent-loop*.test.ts`, `test/agent-scheduler.test.ts`, `test/agent-job-registry.test.ts`, `test/agent-tools*.test.ts`, `test/agents-command.test.ts` green).
- New `test/agent-state-durability.test.ts` (kill + restart recovers agent state).
- `npm run coupling:audit`, `npm run build:smoke`.

## Document Ownership

- Current priority lives in [../TODO.md](../TODO.md) and [../active/TODO_agents.md](../active/TODO_agents.md).
- Completed facts move to [../DONE.md](../DONE.md); factual history to [../WORK_LOG.md](../WORK_LOG.md).
- Agent runtime maturity stays in [agent-runtime-architecture-maturity-plan.md](../reference/agent-runtime-architecture-maturity-plan.md).

## 中文概述

### 背景

三个 "agent" 子系统（`runAgentLoop` CLI-only 进程内 Map / `ExploreAgentScheduler` daemon+SQLite / `/v1/execute` 直写）概念重叠、状态所有者不一、词汇不一；`runAgentLoop` 根本不暴露给 daemon，spawn 出来的 agent `skipPermissionCheck:true` 绕过权限，`createExploreRuntime` 另起一套 runtime 不共享父策略，`agentRouter` schema 还 advertise 会被拒的 profile。

### 核心做法

Phase 1 定 canonical 模型 + callsite 映射；Phase 2 让 `runAgentLoop` 状态 SQLite-owned（配合关停恢复）；Phase 3 把 planner/executor/critic 暴露给 daemon（或折叠成 profile）；Phase 4 用 profile-scoped `ToolPolicy` 取代 `skipPermissionCheck`、共享 runtime 构造、清死 schema。

### 当前状态

草案。这是最大的收敛项，建议在 P0（关停恢复 + 嵌入式统一 + 审计闸）落地后再推进，因为它依赖前者的状态所有者与编排统一。

### 下一步

最小切片：Phase 1 纯文档——定 canonical `AgentJob` 模型 + 把现有 callsite 列成 1:1 映射表进 WORK_LOG，零代码变更，先对齐认知。
