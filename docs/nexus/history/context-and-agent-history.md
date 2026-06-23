# Context And Agent History Ledger

> State: History
> Governance: Indexed by [README.md](./README.md). This ledger consolidates closed reference documents so active architecture references stay small.

This history ledger preserves closed implementation context without keeping every completed plan as a standalone reference document. Current priorities remain in [../TODO.md](../TODO.md) and active implementation detail remains in [../active/](../active/).

## Consolidated Sources

| Closed item | Original file | Closure status |
| --- | --- | --- |
| Adaptive Context Window + History Load Limit (Phase 1-4 + 6) | `adaptive-context-window-selection-plan.md` | Closed 2026-06-22/23. `selectRecentEvents` / `microcompact` / `snip` / recovery-boundary gated on a pre-selection token headroom signal (relax caps below 70% usage); `prepareRuntimeStart` + resume paths replaced hard-coded `listEvents(limit:1000)` with `getHistoryEventLoadLimit(maxTokens)` scaled to budget (852k→42600, cap 50000) so headroom sees real history in fat-turn sessions. Closes the `session_cd42cb65` / `session_75d74b74` / `session_099b26bb` / `session_cf703023` / `session_1891b642` per-turn compression regressions. |
| Tool-Pair Message Ordering Plan (Phase 5) | `tool-pair-message-ordering-plan.md` | Closed 2026-06-22. `mapEventsToMessages` defers runtime-injected user messages that arrive mid tool round; `validateAnthropicToolMessageSequence` and `validateOpenAIToolMessageSequence` tightened to require strict `tool_use ↔ tool_result` contiguity. Closes the `session_6ce63133` 4× PROVIDER_ERROR 400 regression. |
| BabeL-O Context and Sub-agent Upgrade Plan | `context-and-subagent-upgrade-plan.md` | Context Manager / ContextForker / read-only Explore-Review-Test AgentScheduler phases implemented; write-capable implement agents remain disabled. |
| BabeL-O 上下文管理优化规划 | `context-management-optimization-plan.md` | Phase 0 + Phase 1 + Phase 2 + Phase 3 + Phase 4 + Phase 5 + Phase 6A + Phase 6B + Phase 7 已落地 — 基于 BabeL-2 上下文管理机制复盘与 BabeL-O 真实 session `session_661479db-6327-46f2-a793-7b88e0431174` 的“模型自报上下文 91%”样本，推进 runtime-owned context facts、Go TUI footer 可见性、模型不得自估 context 百分比约束、microcompact 事实事件、compact boundary 协议化、provider context-limit recoverable retry、post-compact grounding guard、dirty workspace guard、context bucket/top-items/grounding suggestions 可视化、sub-agent context fork provenance 与后续 context foundation 提升。 |
| Session-to-Session Memory Channel Plan | `session-to-session-memory-channel-plan.md` | Closed reference retained in this history ledger. |

## Adaptive Context Window + History Load Limit (Phase 1-4 + 6)

**Original file**: `adaptive-context-window-selection-plan.md` (folded into this ledger 2026-06-23; full per-phase detail in [../WORK_LOG.md](../WORK_LOG.md) 2026-06-22/23 entries)

**Closed status**: Closed 2026-06-22 (Phase 1-4) + 2026-06-23 (Phase 6) on branch `fix/context-regression-integration`. 1234/1234 full test suite pass.

Four independent "compression" paths were dropping context at low usage. Each was gated on a single headroom signal (`preSelectionTokenEstimate < 70% maxTokens`, env-overridable):

- **Phase 1** (`session_cd42cb65`, 11 turns): `selectRecentEvents` used fixed `recentTurnLimit=4` + `recentEventLimit=300`; the 300-event cap collapsed the window to 1/11 turns. Fix: relax both to Infinity under headroom.
- **Phase 2** (`session_75d74b74`, 5 turns): `microcompact` unconditionally summarized tool_results > 4000 chars, dropping 39866 tokens across 18 large tool_results. Fix: gate `microcompact`/`snip` char thresholds on the same headroom signal (Infinity under headroom; dedup still runs).
- **Phase 4** (`session_8d6fc33d`): recovery-boundary slice dropped all history before a `REQUEST_CANCELLED` even at 2-5% usage. Fix: skip the slice under headroom.
- **Phase 6** (`session_099b26bb` / `session_cf703023` / `session_1891b642`, fat-turn): Phase 1-4 was ineffective because `prepareRuntimeStart` loaded prior events with a hard-coded `listEvents(limit:1000)`. A single deepseek-v4-pro reasoning turn emits 4000+ thinking_delta + 1000+ assistant_delta events, so 1000 events did not cover one turn; prior turns were dropped BEFORE headroom could see them. Diag confirmed `assembleContext` received `inputEvents=1002 preSelEstimate=1025` for a turn whose real history was ~85k tokens. Fix: `getHistoryEventLoadLimit(maxTokens)` scales ~1 event / 20 tokens of budget (852k→42600, cap 50000, env `BABEL_O_HISTORY_EVENT_LOAD_LIMIT`), applied at the per-turn hot path (`prepareRuntimeStart`) and resume paths (`LLMCodingRuntime`, MAX).

Governance rule: the headroom signal is only as good as the event slice it sees. Any new code that truncates the event stream before `assembleContext` must scale with `budget.maxTokens` via `getHistoryEventLoadLimit`, or it will silently re-defeat headroom on fat-turn sessions.

## 中文概述

### 背景

四条独立的"压缩"路径在低用量时丢上下文。Phase 1-4 修了 selectRecentEvents / microcompact / snip / recovery-boundary,但 fat-turn session 仍每轮压缩 —— 根因是 `listEvents(limit:1000)` 在 headroom 之前截断历史。

### 核心做法

同一个 headroom 信号门控四条路径;Phase 6 把 storage 加载上限从硬编码 1000 改为按 budget 缩放(852k→42600,封顶 50000),让 headroom 看到真实历史。

### 当前状态

Closed Reference。新增截断事件流的代码必须用 `getHistoryEventLoadLimit(maxTokens)`,否则会在 fat-turn session 重新击败 headroom。

---

## Tool-Pair Message Ordering Plan (Phase 5)

**Original file**: `tool-pair-message-ordering-plan.md` (folded into this ledger 2026-06-22; full per-phase detail in [../WORK_LOG.md](../WORK_LOG.md) 2026-06-22 entry)

**Closed status**: Closed 2026-06-22 on branch `fix/tool-pair-message-ordering`. All 4 phases landed; 1222/1222 full test suite pass.

Real session `session_6ce63133-fecb-4c03-adf2-349f38074c98` produced 4 consecutive `PROVIDER_ERROR` 400s in turns 3-6 (seq 192/232 minimax `tool call result does not follow tool call (2013)`, seq 248/264 deepseek `insufficient tool messages following tool_calls message`). Root cause: a single misordered tool pair — Glob `call_019eeec4a8687d83a0f0a18b` on `/Users/tangyaoyue/DEV/Baidu`, suspended by `scope_boundary_detected` / `scope_boundary_confirmed` in turn 2. The runtime injected those two events as standalone `user` messages between `assistant(tool_use=[…])` and the closing `user(tool_result=[…])`, splitting the pair. Anthropic/OpenAI/minimax all reject a split pair at request time; the local validators only checked orphan/duplicate, not contiguity, so the split passed locally and failed on the wire.

Fix (reusable reference for any future runtime-injected event type):

- `src/runtime/eventsTranslator.ts` — `mapEventsToMessages` defers runtime-injected user messages that arrive while a tool round is open (an `assistant` message has a `tool_use` with no matching `tool_result` yet) into a `deferredRuntimeUserMessages` queue, and flushes the queue when the round closes. For streams with no mid-round runtime events the queue is empty and all flushes are no-ops, so existing behavior is unchanged. Zero semantic loss — the deferred messages still reach the model, just after the completed pair.
- `src/providers/adapters/AnthropicAdapter.ts` and `src/providers/adapters/OpenAIAdapter.ts` — both validators tightened to require strict contiguity. New error codes `missing tool_result <id>` and `assistant tool_use not followed by tool_result`; existing orphan/duplicate codes preserved.

Governance rule for future work: any new runtime-injected event type that becomes a `user` message must route through `handleRuntimeUserMessage` to inherit the deferral behavior; otherwise it risks re-splitting tool pairs.

## 中文概述

### 背景

真实 session `session_6ce63133` 连续 4 次 400,根因是 turn 2 一对被 scope_boundary 暂停的 tool_use/tool_result 被 runtime 注入的 user 消息拆开。本地校验只查 orphan/duplicate 不查紧邻,所以拆分在本地通过、在线上被 minimax/deepseek 拒绝。

### 核心做法

`mapEventsToMessages` 在 tool round 打开期间把 runtime 注入的 user 消息推迟到 round 闭合后再追加;两个 adapter 的校验器收紧为要求 `tool_use ↔ tool_result` 严格紧邻。无 runtime 事件的常规流零行为变化。

### 当前状态

Closed Reference,保留为可复用参考:deferral 模式 + 校验器契约。新增 runtime 注入事件类型必须走 `handleRuntimeUserMessage` 以继承推迟行为。

---

## BabeL-O Context and Sub-agent Upgrade Plan

**Original file**: `context-and-subagent-upgrade-plan.md`

**Closed status**: Context Manager / ContextForker / read-only Explore-Review-Test AgentScheduler phases implemented; write-capable implement agents remain disabled.

BabeL-O already has a strong context system. The current gap is not raw capability, but architecture normalization: the context pipeline needs clearer stages, standard context item abstractions, and first-class fork modes for child agents.
BabeL-O also already has real sub-agent capabilities through `runAgentLoop`, `TaskQueue`, child task sessions, transcript references, rerun support, and worktree isolation. The model-visible AgentScheduler path has now also landed for governed read-only/check-only jobs: `AgentSpawn`, `AgentWait`, `AgentList`, and `AgentCancel` can expose Explore/Review/Test profiles when explicitly enabled.
The recommended path has mostly been implemented:

## 中文概述

### 背景

本文记录 Context Manager、ContextForker 与 AgentScheduler 的升级路径，是早期上下文和子代理架构的重要参考。

### 边界

它不是当前唯一路线图；实际优先级以 TODO、active TODO、DONE 和 WORK_LOG 为准。write-capable child agent 仍应保持禁用或单独治理。

### 当前状态

作为 Closed Reference 保留，用于解释为什么上下文拆分、模型可见 AgentScheduler 和子任务边界不能混同。

---

## BabeL-O 上下文管理优化规划

**Original file**: `context-management-optimization-plan.md`

**Closed status**: Phase 0 + Phase 1 + Phase 2 + Phase 3 + Phase 4 + Phase 5 + Phase 6A + Phase 6B + Phase 7 已落地 — 基于 BabeL-2 上下文管理机制复盘与 BabeL-O 真实 session `session_661479db-6327-46f2-a793-7b88e0431174` 的“模型自报上下文 91%”样本，推进 runtime-owned context facts、Go TUI footer 可见性、模型不得自估 context 百分比约束、microcompact 事实事件、compact boundary 协议化、provider context-limit recoverable retry、post-compact grounding guard、dirty workspace guard、context bucket/top-items/grounding suggestions 可视化、sub-agent context fork provenance 与后续 context foundation 提升。

最近两条真实观察暴露了 BabeL-O 上下文管理的下一层问题：
1. **模型自报 context 百分比不可信**
   - session: `session_661479db-6327-46f2-a793-7b88e0431174`

## 中文概述

### 背景

本文沉淀长上下文、compact、provider context limit、context warning 与用户可见诊断的真实回归经验。

### 边界

compact summary 不能替代源码事实；模型需要事实结论时必须重新读取文件、diff、测试输出或事件日志。

### 当前状态

作为 Closed Reference 保留。新的上下文治理入口是 context-governance-index，具体打开项继续写入 active TODO。

---

## Session-to-Session Memory Channel Plan

**Original file**: `session-to-session-memory-channel-plan.md`

**Closed status**: Closed Reference

Session-to-session conversation is not a simple link between multiple chat windows. It brings multiple independent workspace states into a governable collaboration system. BabeL-O keeps the same core position: Nexus owns execution, SQLite/session/event/tool traces are the source of truth, and EverCore / EverOS are only long-term semantic memory and consolidation layers, not replacements for runtime facts.
This plan treats a session as a workspace runtime state: it has its own cwd, event stream, tool evidence, session memory, context budget, and current task state. Multiple sessions can exchange bounded, traceable, confirmable collaboration messages through typed channels, but each session's project memory remains isolated by default. Message exchange must not merge workspace facts.

## 中文概述

### 背景

Session-to-session channel 的目标不是合并多个聊天窗口，而是在多个独立 session 之间传递有限、可审计、可确认的协作上下文。

### 边界

跨 session message 不是用户直接指令，也不是长期记忆事实源。接收 session 必须把 inbox 内容当作 collaboration context，并在行动前用当前 workspace evidence 验证。

### 当前状态

本文保留 SessionChannel / SessionMessage / Inbox / scoped memory 的架构边界。具体实现进度以 TODO、DONE、WORK_LOG 和源码为准；后续新增能力应继续保持 typed channel 和 storage parity。

## 中文概述

### 背景

本文件把已收口的 reference 长文合并为领域历史账本，减少 reference 目录中的长期噪音。

### 当前状态

原始长文已不再作为独立 reference 维护；后续只在真实回归或新决策出现时更新本 history ledger 或新增 ADR。
