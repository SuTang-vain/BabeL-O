# Evidence Governance Index

> State: Index
> Track: Evidence / Session / Runtime / Tools
> Priority: P1 Watch
> Source of truth: `docs/nexus/TODO.md`, `docs/nexus/active/`, `docs/nexus/DONE.md`, `docs/nexus/WORK_LOG.md`, `src/runtime/taskScope.ts`, `src/runtime/contextAnalysis.ts`, `src/cli/runSessionFlow.ts`, `src/runtime/readCache.ts`, `src/tools/`, `src/storage/`
> Related: [evidence-and-runtime-history.md](../history/evidence-and-runtime-history.md), [evidence-and-runtime-history.md](../history/evidence-and-runtime-history.md), [task-scope-and-evidence-scope-governance-plan.md](../proposals/task-scope-and-evidence-scope-governance-plan.md), [evidence-and-runtime-history.md](../history/evidence-and-runtime-history.md), [evidence-and-runtime-history.md](../history/evidence-and-runtime-history.md), [tool-governance-plan.md](./tool-governance-plan.md), [context-governance-index.md](./context-governance-index.md)

## Purpose

This document is the reader entry point for BabeL-O evidence governance. It does not replace the detailed regression plans. Its job is to explain which document owns which evidence failure class and to keep one shared rule: final answers must be grounded in current, scoped, replay-safe evidence rather than partial reads, stale terminal events, out-of-scope paths, recoverable tool failures, or memory/context hints.

Current priority still belongs to `docs/nexus/TODO.md` and `docs/nexus/active/`. This index is a navigation and boundary document.

## Ownership Map

| Document | Evidence failure class | Reading rule |
| --- | --- | --- |
| [evidence-and-runtime-history.md](../history/evidence-and-runtime-history.md) | Provider replay safety, event ordering, Read coverage, partial/full evidence semantics, intent-target replay, and provider protocol validity. | Use when a historical session cannot be replayed into a valid provider request or when partial evidence was treated as complete. |
| [evidence-and-runtime-history.md](../history/evidence-and-runtime-history.md) | Current-turn terminal outcome correctness and stale result pollution. | Use when a session appears completed but the latest user turn has no current terminal result/error. |
| [task-scope-and-evidence-scope-governance-plan.md](../proposals/task-scope-and-evidence-scope-governance-plan.md) | Whether real read-only evidence is inside the user's current task scope. | Use when the model reads sibling repos, historical roots, or memory-suggested paths without explicit user authorization. |
| [evidence-and-runtime-history.md](../history/evidence-and-runtime-history.md) | Repeated wrong-root tool failures and evidence degradation after path confusion. | Use when `Read` / `ListDir` / `Glob` / `Bash` failures indicate the model is using a wrong but plausible workspace root. |
| [evidence-and-runtime-history.md](../history/evidence-and-runtime-history.md) | Timeout as recoverable evidence boundary rather than fatal workflow cutoff. | Use when a long task is interrupted by request timeout before the model can summarize partial evidence or ask for continuation. |

## Shared Evidence Model

BabeL-O evidence should be interpreted through five independent dimensions:

| Dimension | Question |
| --- | --- |
| Existence | Did the tool or storage layer actually observe the object/event? |
| Coverage | Was the observation full, partial, ranged, truncated, cached, or summarized? |
| Scope | Was the evidence inside the current user-authorized task boundary? |
| Freshness | Does the evidence belong to the current turn/session/workspace state? |
| Replay validity | Can the event history be reconstructed into a valid provider/tool protocol sequence? |

An answer is well grounded only when the required dimensions are satisfied for the strength of the claim. A weak exploratory answer may cite partial evidence with caveats. A strong implementation/status claim needs current, scoped, sufficiently covered evidence.

## Governance Rules

### 1. Tool evidence beats narrative memory

Workspace files, current tool results, SQLite session events, and structured runtime diagnostics are authoritative for what happened or what exists. Assistant text, compact summaries, memory hits, and historical notes are hints until revalidated.

### 2. Partial evidence must stay partial

Preview reads, truncated outputs, byte/line ranges, microcompacted tool results, and cached "unchanged" messages cannot support full-file or project-wide conclusions unless coverage is explicitly restored.

### 3. Scope is separate from path safety

A path can be safe to read and still be outside the current task. Evidence from sibling repositories, parent directories, old sessions, or memory-suggested paths needs explicit scope confirmation before it can support current-turn conclusions.

### 4. The latest turn owns finalization

Session finalization must use the current execution boundary. A previous turn's result cannot be reused to mark a newer unanswered turn as complete.

### 5. Recoverable failures are evidence too

Missing files, wrong roots, permission denials, invalid input, and timeout-budget events should remain visible as recoverable evidence. They should guide repair or caveated answers instead of disappearing or becoming generic fatal errors.

### 6. Replay safety is non-negotiable

Provider replay must not send orphan tool results, duplicate tool results, or out-of-order tool-result pairs. If replay cannot be normalized safely, the runtime should stop before sending an invalid provider request and produce diagnostics.

## Current State

The underlying evidence work is mostly implemented and regression-backed:

- provider replay ordering and malformed tool-result protection;
- mode-aware Read cache coverage and partial/full evidence semantics;
- current-turn finalization boundary;
- task scope declaration, boundary detection, confirmation, and context diagnostics;
- path drift guidance for missing paths and wrong roots;
- recoverable timeout protocol and Go TUI visibility;
- `/context` and session diagnostics for scope/evidence hints.

The remaining governance issue is consistency: these capabilities must be read as one evidence protocol rather than isolated bug fixes.

## Open Watch Items

| Item | Owner document | Status |
| --- | --- | --- |
| Full final-answer evidence panel | [task-scope-and-evidence-scope-governance-plan.md](../proposals/task-scope-and-evidence-scope-governance-plan.md), [evidence-and-runtime-history.md](../history/evidence-and-runtime-history.md) | Watch; avoid heavy ledger until new regressions prove need. |
| Durable scope/evidence timeline | [task-scope-and-evidence-scope-governance-plan.md](../proposals/task-scope-and-evidence-scope-governance-plan.md) | Watch; current diagnostics are sufficient for the landed slice. |
| Repeated-root path drift aggregation | [evidence-and-runtime-history.md](../history/evidence-and-runtime-history.md) | Watch; strengthen only on repeated real samples. |
| Timeout continuation UX | [evidence-and-runtime-history.md](../history/evidence-and-runtime-history.md) | Watch; maintain soft deadline vs hard watchdog distinction. |
| Evidence regression corpus | [evidence-and-runtime-history.md](../history/evidence-and-runtime-history.md) | Keep adding real samples when user-visible drift appears. |

## Verification Expectations

Evidence governance changes should be validated with the relevant slice from:

- focused provider replay and tool-result pairing tests;
- Read coverage and cache-mode tests;
- current-turn finalization regression tests;
- task scope and scope-boundary tests;
- path drift diagnostics tests;
- timeout soft-deadline and watchdog tests;
- `npm run docs:check` after every documentation move or canonical/reference change.

## 中文概述

### 背景

Evidence / Session 组文档都在解决同一类用户可见问题：模型看起来回答了，但证据可能不完整、不在任务范围内、来自旧轮次、路径根漂移，或 provider replay 已经不合法。

### 核心做法

本文件不合并那些真实回归文档，而是建立统一入口：把证据按存在性、覆盖范围、任务范围、新鲜度和 replay 合法性五个维度判断，并明确各子文档分别负责哪类失败。

### 当前状态

大多数底层能力已经落地，当前重点是避免口径分散：以后遇到证据漂移、最终回答污染、路径漂移或 timeout 恢复问题，应先从本索引进入对应文档。

### 下一步

继续保持 regression-first。只有真实会话再次证明现有 diagnostics 不够时，才推进更重的 final-answer evidence panel、durable scope timeline 或 Source Coverage Ledger。
