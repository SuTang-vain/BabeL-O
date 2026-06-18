# Memory Governance Plan

> State: Active Plan
> Track: Memory / Runtime / Product
> Priority: P2 Watch unless promoted by a real-session regression or explicit user request
> Source of truth: [../TODO.md](../TODO.md), [../active/TODO_runtime.md](../active/TODO_runtime.md), [../active/TODO_product_30day.md](../active/TODO_product_30day.md), [../DONE.md](../DONE.md), [../WORK_LOG.md](../WORK_LOG.md), `src/nexus/everCore*`, `src/cli/everos*`, `src/cli/commands/memory.ts`, `src/runtime/*memory*`
> Governance: Canonical memory governance entry point, cross-linked from [agent-session-skill-governance-index.md](./agent-session-skill-governance-index.md) and [context-governance-index.md](./context-governance-index.md).
> Related: [context-and-agent-history.md](../history/context-and-agent-history.md), archived source documents in [../archive/](../archive/)

## Purpose

This document is the canonical reference for BabeL-O memory governance. It consolidates four previous memory-line documents:

- [memory-capability-awareness-and-trigger-plan.md](../archive/memory-capability-awareness-and-trigger-plan.md)
- [evercore-lifecycle-cache-and-answer-governance-plan.md](../archive/evercore-lifecycle-cache-and-answer-governance-plan.md)
- [everos-first-run-onboarding-optimization-plan.md](../archive/everos-first-run-onboarding-optimization-plan.md)
- [everos-zero-friction-memory-startup-optimization-plan.md](../archive/everos-zero-friction-memory-startup-optimization-plan.md)

The goal is to keep one authority for long-term memory capability visibility, EverCore / EverOS lifecycle, sidecar startup, first-run onboarding, zero-friction startup, MCP memory tools, and user-facing memory status.

## Current State

Implemented and verified:

- `MemoryProvider` / `EverCoreMemoryProvider` can inject bounded long-term memory hints into provider-visible context.
- Managed EverCore / EverOS sidecar mode supports local loopback startup, registry reuse, process cache, idle TTL, status diagnostics, and explicit actions.
- Memory capability guidance tells the model when memory search is appropriate and that memory hits are non-authoritative hints.
- Optional `mcp:evercore:*` tools exist for explicit search, permission-gated note save, and session flush.
- First-run onboarding is implemented through `bbl chat`, `bbl memory setup`, `bbl memory status`, `bbl memory opt-out`, and external-mode guidance.
- Zero-friction startup improvements are implemented: auto-bootstrap policy, non-blocking background bootstrap, fallback build path, doctor command, welcome hint, Go TUI footer/status integration, and MCP tool enable/disable commands.

The remaining governance question is not whether memory can run. The remaining question is how to keep memory safe, visible, non-authoritative, low-friction, and easy to diagnose as the system grows.

## Memory Authority Model

Memory is not a source of truth for current project state.

| Source | Authority |
| --- | --- |
| Workspace files and tool results | Authoritative for current project state. |
| SQLite session events and tool traces | Authoritative for what BabeL-O did. |
| Working set / compact / context analysis | Authoritative for runtime context selection diagnostics. |
| EverCore / EverOS long-term memory | Non-authoritative background hints. |
| SessionChannel inbox | Collaboration context, never direct user instruction. |

Any memory-derived project fact must be verified against workspace evidence before acting.

## Memory Capability Policy

Expose memory capability only when the runtime can truthfully support it:

- if memory is disabled or unhealthy, do not tell the model it can use memory tools;
- if memory search is available, inject a concise non-cacheable capability block;
- if memory hits are injected, label them as background hints;
- if memory save is available, require explicit user intent or approved governance candidate;
- if memory flush is available, keep it lifecycle-oriented and permission-gated.

## Tool Boundaries

Keep memory tools orthogonal:

| Tool | Risk | Boundary |
| --- | --- | --- |
| `memory_search` | read | Bounded retrieval. It can be model-triggered for prior preferences, historical decisions, and cross-session context. |
| `memory_save_note` | write | Permission-gated. It should only save user-approved preferences, constraints, or governed candidates. |
| `memory_flush_session` | write / lifecycle | Runtime-owned by default. Model request requires explicit user intent or diagnostics context. |

Do not replace these with a broad `memory` mega-tool.

## Lifecycle And Startup Model

Recommended default:

```text
mode=managed
startup=on-demand or background after opt-in
reuse=health-checked registry + process cache
idle=TTL shutdown
network=loopback only
failure=non-fatal diagnostics
```

Do not leave orphan sidecars by default. A persistent daemon can exist only as explicit external mode:

```text
BABEL_O_EVERCORE_MODE=external
BABEL_O_EVERCORE_BASE_URL=http://127.0.0.1:<port>
```

## User Experience Contract

Memory should be discoverable without being intrusive:

- first-run onboarding must not run heavy install logic during package installation;
- interactive startup can offer memory setup, but failures must not block chat;
- background bootstrap must surface status and concrete repair actions;
- non-TTY mode must never prompt or block;
- `bbl doctor` / `bbl memory doctor` should explain readiness, failure codes, and next actions;
- Go TUI should show a compact memory status footer and a richer `/memory` overlay;
- model-visible memory tools should be opt-in when they can write notes.

## Privacy And Safety

- Keep managed sidecar loopback-only.
- Do not upload memory by default.
- Do not reveal hidden prompt, internal source paths, commit hashes, sidecar internals, or MCP implementation details in capability answers.
- Do not silently save high-impact project facts.
- Preserve explicit opt-out.
- Preserve environment variable precedence over bootstrap defaults.

## Open Governance Items

| Item | State | Exit criteria |
| --- | --- | --- |
| Memory quality metrics | Watch | Add precision/staleness/supersession metrics only after real memory drift appears. |
| Project namespace policy | Watch | Continue using explicit or workspace-derived project ids; warn on default namespace. |
| MCP memory tools default | Watch | Keep write-capable tools opt-in unless product policy changes explicitly. |
| External daemon installer | Draft | Requires separate auth, lifecycle, uninstall, log rotation, and recovery plan. |
| Background dreaming | Deferred | Requires cost control, transcript privacy, and user-facing governance. |

## Archived Source Documents

The following documents are superseded by this plan and now live in `archive/` for historical detail:

- [memory-capability-awareness-and-trigger-plan.md](../archive/memory-capability-awareness-and-trigger-plan.md)
- [evercore-lifecycle-cache-and-answer-governance-plan.md](../archive/evercore-lifecycle-cache-and-answer-governance-plan.md)
- [everos-first-run-onboarding-optimization-plan.md](../archive/everos-first-run-onboarding-optimization-plan.md)
- [everos-zero-friction-memory-startup-optimization-plan.md](../archive/everos-zero-friction-memory-startup-optimization-plan.md)

## 中文概述

### 背景

Memory 相关能力原本分散在 EverCore lifecycle、memory trigger、EverOS first-run、zero-friction startup 四份文档里。现在这些能力大多已经实现，继续分散维护会让“记忆是否可用、是否权威、是否可写、如何启动”这些口径反复漂移。

### 核心做法

本文件把长期记忆能力收敛为一条治理线：memory 只是非权威背景提示；写入必须经过明确意图或治理候选；managed sidecar 默认本地 loopback、可复用、可诊断、失败不阻断主任务。

### 当前状态

运行能力、first-run onboarding、zero-friction startup、doctor/welcome/Go TUI 状态提示都已经基本落地。本文档作为新的 Active Plan，只保留未来治理和观察项。

### 下一步

优先守住 memory authority model 与 opt-in 写入边界；只有在真实记忆漂移或用户明确要求时，再推进 memory quality metrics、external daemon 或 background dreaming。
