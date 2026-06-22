# Evidence And Runtime History Ledger

> State: History
> Governance: Indexed by [README.md](./README.md). This ledger consolidates closed reference documents so active architecture references stay small.

This history ledger preserves closed implementation context without keeping every completed plan as a standalone reference document. Current priorities remain in [../TODO.md](../TODO.md) and active implementation detail remains in [../active/](../active/).

## Consolidated Sources

| Closed item | Original file | Closure status |
| --- | --- | --- |
| Session Finalization / Evidence Governance Remediation Plan | `session-finalization-and-evidence-governance-plan.md` | P0 current-turn finalization regression is closed; P2 evidence-scope drift remains a lightweight governance sample. |
| Session Replay and Evidence Governance Plan | `session-replay-and-evidence-governance-plan.md` | Closed reference retained in this history ledger. |
| Task-adaptive Recoverable Timeout 规划 | `task-adaptive-recoverable-timeout-plan.md` | Phase 0 + Phase 1 + Phase 2 + Phase 3 + Phase 4 + Phase 5 + Phase 6 已落地 — 收口（真实样本回归 + 协议拆分 + runtime 可恢复 `timeout_budget_exceeded` 事件 + 自动 extension cycle + Go TUI 软超时状态可见化 / 看门狗友好消息 + hard watchdog `details.kind='watchdog'` 标记与清理回归 + DONE/跨文档同步） |
| Provider Stream Silent-Hang Abort Propagation Plan | `provider-stream-silent-hang-abort-propagation-plan.md` | P0 core closed 2026-06-22: provider reader abort, single-source watchdog, activeAgeMs reset, Nexus iterator abort race, reasoning-only provider settlement, Go TUI backend-loss settlement, and stale `executing` startup recovery all landed. Optional BehaviorMonitor anomaly push remains P2 Watch. |
| Workspace Path Drift / Tool Failure Recovery Governance Plan | `workspace-path-drift-governance-plan.md` | P2 / Watch — minimal diagnostic implemented; repeated-root aggregation / final-answer downgrade remain watch-only |

## Session Finalization / Evidence Governance Remediation Plan

**Original file**: `session-finalization-and-evidence-governance-plan.md`

**Closed status**: P0 current-turn finalization regression is closed; P2 evidence-scope drift remains a lightweight governance sample.

`session_9d985c5c-7c89-41b8-9d5e-cc672e412f00` exposed two issues:
1. **P0 current-turn session finalization regression**: the third user request reached provider invocation prelude, but no terminal `result` / `error` / `execution_metrics` was written for that turn; the session was still marked `completed` and inherited the previous turn result.
2. **P2 evidence-scope drift**: the session produced project-level strong claims, while recorded tool evidence mainly came from `Read` / `ListDir`; no `Grep` / `Glob` / `Bash git status` evidence sufficient for some global claims was observed.

## 中文概述

### 背景

当前轮 finalization 和 evidence scope 漂移会导致模型把未验证或越界证据写成结论。

### 边界

本文只保留 current-turn finalization 与轻量 evidence-scope drift 样本，不替代完整 evidence governance。

### 当前状态

作为 Closed Reference 保留。新的证据范围问题应优先进入 evidence-governance-index 和对应 active TODO。

---

## Session Replay and Evidence Governance Plan

**Original file**: `session-replay-and-evidence-governance-plan.md`

**Closed status**: Closed Reference

`session_315814e7-3b82-4a31-8601-a5b383288e9c` initially looked like a simple hallucination: the model answered the real **G1-G6** structure of `docs/nexus/reference/memory-capability-awareness-and-trigger-plan.md` as **L0-L7**. A full review of the event stream, runtime source, tool contracts, and provider replay showed that it was not an isolated model mistake. Several governance chains failed at the same time:
```text
Evidence chain: Read partial / cache / byte-offset semantics were misused.

## 中文概述

### 背景

真实 session replay 暴露过 provider replay mismatch、Read coverage、intent target 和 event ordering 等证据链问题。

### 边界

Replay 结果必须区分原始事件、重放诊断和推断结论，不能把重新分析当成当时模型真实上下文。

### 当前状态

作为 Closed Reference 保留，用于回归防护和 inspect-session 诊断口径。

---

## Task-adaptive Recoverable Timeout 规划

**Original file**: `task-adaptive-recoverable-timeout-plan.md`

**Closed status**: Phase 0 + Phase 1 + Phase 2 + Phase 3 + Phase 4 + Phase 5 + Phase 6 已落地 — 收口（真实样本回归 + 协议拆分 + runtime 可恢复 `timeout_budget_exceeded` 事件 + 自动 extension cycle + Go TUI 软超时状态可见化 / 看门狗友好消息 + hard watchdog `details.kind='watchdog'` 标记与清理回归 + DONE/跨文档同步）

最新真实 session 复盘结果：
| 指标 | 结果 |
|---|---:|

## 中文概述

### 背景

长任务 timeout 不应只表现为 fatal cutoff；runtime 需要 soft deadline、hard watchdog、extension 和用户可见预算诊断。

### 边界

Timeout recovery 不能让任务无限续命，也不能伪装成成功。所有 extension 都必须受上限和事件记录约束。

### 当前状态

主要阶段已收口，作为 Closed Reference 保留。后续只有真实 fatal-style cutoff drift 再重新开项。

---

## Provider Stream Silent-Hang Abort Propagation Plan

**Original file**: `provider-stream-silent-hang-abort-propagation-plan.md`

**Closed status**: P0 core closed 2026-06-22. Optional BehaviorMonitor `activeAgeMs` anomaly push remains P2 Watch only.

The original regression was `session_3c3ec27c-0cd9-4cf0-a953-86298c002801`: the provider emitted thinking deltas and usage, then no assistant text, no tool call, no terminal event for about eight hours. The hard watchdog existed, but abort did not actively break the silent provider stream reader.

The final closure covered the full abort-to-visible-terminal chain:

- provider SSE readers actively cancel their `ReadableStreamDefaultReader` on abort;
- the hard watchdog is single-source and produces observable watchdog timeout details;
- `/v1/runtime/status` `stream.activeAgeMs` no longer inherits idle gaps between streams;
- `runExecutionStreamLoop()` races each runtime iterator `.next()` against user cancel and timeout abort signals, synthesizing terminal timeout/cancel events when abort wins;
- reasoning-only/no-tool/no-text provider turns terminalize as `EMPTY_PROVIDER_RESPONSE details.kind='reasoning_only'` before `PostInvocation` hooks;
- Go TUI settles local running state on Nexus transport loss without mistaking ordinary HTTP status errors for backend death;
- Nexus startup fails prior-process stale `executing` sessions with `NEXUS_RESTARTED_DURING_EXECUTION` and records `metadata.staleExecutionRecovery`.

Follow-up sessions `session_4872604b`, `session_2f196238`, `session_f4a0a894`, and `session_f300c03c` proved that the visible symptom "drafting response forever" can come from different layers. The governance lesson is to inspect the session event tail before classifying the bug: unresolved `permission_request` means permission UI; `thinking_delta` plus `PostInvocation` means provider/output settlement; hard watchdog log plus active stream means iterator abort race; no backend listener plus a running TUI means transport-loss settlement.

## 中文概述

### 背景

Provider silent stream 和 Go TUI 假 running 会让用户看到 `drafting response` 永久不结束，即使 hard watchdog 已经触发。

### 边界

该线已关闭 P0 核心链路；后续只在新的真实 hang / false-running 样本出现时重开 focused regression。BehaviorMonitor `activeAgeMs` 异常推送仍是可选 Watch，不是当前 blocker。

### 当前状态

作为 runtime 历史账本保留。详细阶段和验证命令见 provider-stream proposal 与 WORK_LOG。

---

## Workspace Path Drift / Tool Failure Recovery Governance Plan

**Original file**: `workspace-path-drift-governance-plan.md`

**Closed status**: P2 / Watch — minimal diagnostic implemented; repeated-root aggregation / final-answer downgrade remain watch-only

`session_1cf5362d-b33f-467f-b07e-f97356652662` exposed a real issue that differs from a single tool failure: during a cross-repository task, the model drifted to the wrong workspace path and repeatedly called `Read` / `ListDir` / `Glob` on nonexistent absolute paths. The tools correctly returned recoverable failures, but the model did not identify the root-path error and continued exploring under the wrong root before producing its analysis.
Key path difference in the sample:
```text

## 中文概述

### 背景

Workspace path drift 会导致模型反复访问错误根目录，随后丢失用户意图或把错误项目当成当前项目。

### 边界

路径失败应保持可恢复和可诊断；重复 wrong-root 不能让模型静默换项目或忘记用户原始目标。

### 当前状态

作为 Closed Reference 保留。后续新样本应进入 evidence/context 回归 corpus，并由 runtime recovery 处理。

## 中文概述

### 背景

本文件把已收口的 reference 长文合并为领域历史账本，减少 reference 目录中的长期噪音。

### 当前状态

原始长文已不再作为独立 reference 维护；后续只在真实回归或新决策出现时更新本 history ledger 或新增 ADR。
