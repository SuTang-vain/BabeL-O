# Context Search Algorithm And Robustness Plan

> State: Partially Landed
> Track: Tools / Context / Storage
> Priority: P0 — real-session regression: `contextSearch` returns empty across a long session, forcing the model into a multi-retry loop that still misses the newest user messages
> Source of truth: [../TODO.md](../TODO.md), [../active/TODO_runtime.md](../active/TODO_runtime.md), [../WORK_LOG.md](../WORK_LOG.md), `src/tools/builtin/contextSearch.ts`, `src/tools/contextTools.ts`, `src/storage/Storage.ts`, `src/storage/EventRepository.ts`, `src/storage/MemoryStorage.ts`, `test/contextTools.test.ts`
> Governance: Indexed by [README.md](./README.md). Canonical owner of "the `contextSearch` retrieval algorithm and its storage boundary". On-demand tool semantics stay in [../reference/long-running-context-assembly.md](../reference/long-running-context-assembly.md) §7.1; storage interface segregation stays in [../reference/storage-interface-segregation-reference.md](../reference/storage-interface-segregation-reference.md); recoverable-failure tool behavior stays in [../reference/runtime-tool-loop-governance-plan.md](../reference/runtime-tool-loop-governance-plan.md); PR review level for this change is `review-high-risk` per [../reference/development-process-stability-governance-plan.md](../reference/development-process-stability-governance-plan.md) §6.1.
> Related: [../reference/long-running-context-assembly.md](../reference/long-running-context-assembly.md), [../reference/storage-interface-segregation-reference.md](../reference/storage-interface-segregation-reference.md), [../reference/runtime-tool-loop-governance-plan.md](../reference/runtime-tool-loop-governance-plan.md), [../reference/development-process-stability-governance-plan.md](../reference/development-process-stability-governance-plan.md), [../reference/context-cwd-drift-and-recall-governance-plan.md](../reference/context-cwd-drift-and-recall-governance-plan.md)

## Purpose

`contextSearch` is the on-demand history locator the model calls when the user asks about past activity ("what did we do earlier", "回顾一下我们之前的任务"). It is the retrieval entry point for the On-Demand tier of the three-tier context model. This plan governs two defects in that retrieval path — an algorithm defect (whole-string substring matching with no tokenization) and a robustness defect (a 10,000-event hard cap that silently drops the newest events in long sessions) — and the contract misalignment between the tool's prompt and its implementation that turns one failed call into a multi-retry loop.

## Current State

Source-verified facts:

- **The retrieval algorithm is whole-string substring match.** `src/tools/contextTools.ts:206-244` `searchEvents` lowercases the entire `query` into one `needle` and tests `haystack.includes(needle)` per event (`:229`). There is no tokenization, no AND/OR semantics, no fuzzy or semantic match. A query `架构分析 合理性 先进性` becomes a single needle `架构分析 合理性 先进性` that must appear verbatim in some event's extracted text.
- **`extractText` concatenates event fields with spaces.** `src/tools/contextTools.ts:408-425` joins `event.type` plus every string field and shallow-stringified object field with single spaces. So `includes` can only ever match a contiguous run that happens to span the exact field boundaries as serialized.
- **The tool loads events with a 10,000-row hard cap, ascending.** `src/tools/builtin/contextSearch.ts:50-53` calls `context.storage.listEvents(context.sessionId, { order: 'asc', limit: 10_000 })`. `EventRepository.listEvents` (`src/storage/EventRepository.ts:99-139`) paginates by `event_seq` cursor; with `order:'asc'` and no cursor this returns `event_seq` 1..10000. Rows 10001+ are silently dropped. `EventListOptions` (`src/storage/Storage.ts:22-26`) exposes only `limit / cursor / order` — there is no server-side `event_type` filter, so `eventTypeFilter` is applied in memory at `contextTools.ts:227` after the full page is fetched.
- **`truncated` reflects only token capping, not source truncation.** `searchEvents` returns `truncated` from `capByTokens` (`contextTools.ts:236`), which fires when the joined snippet text exceeds `maxTokens`. The 10,000-row source cap produces no signal — the model cannot distinguish "no match" from "the matching events were never loaded".
- **The tool prompt advertises semantic-style lookup.** `contextSearch.ts:33` tells the model to "find the previous decision about X", "what did we do earlier", and to "narrow the query" on `truncated`. The implementation cannot satisfy natural-language queries, so the model re-issues with reworded queries instead of switching strategy.
- **Sibling tools are healthy.** `contextRecent`, `contextSummarize`, and `contextSessions` all returned non-empty results in the same session (verified against `tool_traces`). The regression is isolated to `contextSearch`.

## Problem Statement

Real-session evidence — `session_06308b17-84b4-402a-909e-b0078f67ca76` (2026-06-21, `deepseek/deepseek-v4-pro`, cwd `/Users/tangyaoyue/DEV/BABEL/BabeL-O`):

The session holds 11,952 events across 7 user messages (event_seq `1, 78, 2948, 3416, 7324, 10548, 11260`). The user prompt "回顾一下我们之前的任务/聊天记录" triggered 5 `contextSearch` calls:

| # | query | eventTypeFilter | result |
| --- | --- | --- | --- |
| 1 | `架构分析 合理性 先进性` | — | `hitCount=0`, empty |
| 2 | `深度分析研究` | — | `hitCount=0`, empty |
| 3 | `BabeL-O 架构 合理性 先进性 CLI Nexus Runtime` | — | `hitCount=0`, empty |
| 4 | `user message request` | — | `hitCount=0`, empty |
| 5 | `user_message` | `["user_message"]` | `hitCount=5`, partial |

Two compounding defects:

1. **Algorithm defect (primary).** The actual user messages read `分析这个项目架构的合理以及先进性` and `深度分析这个项目的架构耦合性…`. Queries 1–3 are reworded keywords (`架构分析` vs `分析…架构`, `合理性` vs `合理以及先进性`). No contiguous substring is shared, so `includes` returns false for all 11,952 events. Query 5 only hit because the needle `user_message` equals the event `type` field literal — a lucky type-name match, not retrieval working.
2. **Robustness defect (secondary).** The 10,000-row ascending cap loaded event_seq 1..10000. The two newest user messages (seq `10548`, `11260`) were never loaded. Query 5 returned 5 of 7 user messages — the missing two are exactly the ones past the cap, including the in-flight turn. Even with the algorithm fixed, the newest history is unreachable.

The model's observed behavior — four reworded retries then a type-filter fallback — is the direct, predicted consequence of the prompt promising semantic lookup while the implementation does verbatim substring match with no feedback that the source was truncated.

## Goals

- `contextSearch` returns non-empty results for the real queries in `session_06308b17` on the first call, without the model rewording.
- The newest events in a long session (>10,000 events) are reachable by `contextSearch`, both with and without `eventTypeFilter`.
- The model can distinguish "no match in the loaded window" from "the loaded window was source-capped", so retry strategy is informed rather than blind.
- The tool prompt describes the actual matching semantics (tokenized substring, not semantic) and gives concrete query examples, so the prompt no longer misleads the model.
- All changes are covered by deterministic unit tests, including the regression session's exact queries.

## Non-goals

- Do not introduce vector retrieval, embeddings, or memoryos semantic search. That is the separate On-Demand-tier plan under [../reference/long-running-context-assembly.md](../reference/long-running-context-assembly.md); this plan stays in the lexical-retrieval lane.
- Do not change `contextRecent`, `contextSummarize`, or `contextSessions`. They are healthy in the regression session and are out of scope (`feedback-babel-o-p0-regression-focus`).
- Do not alter the `NexusEvent` schema, the `events` table DDL, or the append path. The storage change is additive only: an optional `eventTypes` filter on `EventListOptions`, pushed down to SQL `WHERE event_type IN (...)`.
- Do not change tool-result entry into active context (on-demand tools stay out of the working set).
- Do not touch the 6 `refreshRuntimeContextState` hot-path call sites. They do not use `eventTypeFilter` and are unaffected by the additive `EventListOptions` field.

## Design

### Algorithm — tokenized AND match in `searchEvents`

Replace the single-needle `includes` with tokenized matching:

```text
tokens = query.toLowerCase().split(/\s+/).filter(Boolean)
if tokens.length === 0: return empty (unchanged)
hit = tokens.every(token => haystack.includes(token))
```

- **AND semantics by default.** Every token must appear (as a substring) in the event's extracted text. This makes `架构分析 合理性 先进性` match `分析这个项目架构的合理以及先进性` because each token (`架构分析`, `合理性`, `先进性`) is a substring of the concatenated fields. Wait — `架构分析` is NOT a substring of `分析…架构` (the characters are reordered). So pure AND-substring still misses reordered Chinese.

  Mitigation for CJK reordering: additionally tokenize CJK runs by 2-character bigrams when no whole-token match is found, and score by hit ratio. To keep the first slice minimal and deterministic, Phase 1 ships AND-substring only (covers space-separated keyword queries 2–4 and all English/literal cases); CJK bigram scoring is Phase 2 and is gated on Phase 1 leaving real queries unanswered.

- **No OR mode in Phase 1.** OR (any token matches) over-retrieves in high-volume sessions (7,668 `assistant_delta` events would match any common token). AND is the safe default; OR is deferred until a real query shows AND is too strict.
- **Ranking.** Hits are returned newest-first (descending `event_seq`) to match `contextRecent` ordering and surface the most recent relevant turn. Ties keep storage order.
- **Deduplication.** Consecutive hits of the same `event.type` with identical 200-char snippet text are collapsed to the last occurrence, so a long `assistant_delta` run does not crowd out the result.

### Robustness — push `eventTypeFilter` to SQL and bound the source cap

- **Additive `EventListOptions` field.** `src/storage/Storage.ts:22-26` gains `eventTypes?: string[]`. `EventRepository.listEvents` adds `AND event_type IN (...)` when present (parameterized). `MemoryStorage.listEvents` applies the same filter in memory. This is a non-breaking optional field; existing callers (the 6 hot-path refresh sites, `contextRecent`, `contextSummarize`) are unaffected.
- **`contextSearch` uses the pushdown.** When `input.eventTypeFilter` is set, pass it as `eventTypes` to `listEvents` so the SQL `WHERE` clause filters before the `LIMIT`, bypassing the 10,000-row cap for filtered queries. When no filter is set, raise the in-tool `limit` from 10,000 to 50,000 (single-session event counts are bounded; the real ceiling is the `maxTokens` token cap on the result, not the row count).
- **Honest truncation signal.** `searchEvents` returns a new `eventsScanned: number` and `eventsCapped: boolean` alongside `truncated`. `eventsCapped` is true when the loaded page hit the row limit (the caller passes back whether `listEvents` returned a `nextCursor`). The tool output surface exposes these so the model knows to narrow with `eventTypeFilter` or `sinceMs` rather than reword the query.

### Contract — align the tool prompt with the implementation

Rewrite `contextSearch.ts:27-33` `description` and `prompt` to state the actual semantics:

- "Tokenized substring match: the query is split on whitespace; every token must appear (as a substring) in some event field. Use distinctive keywords, not full sentences."
- Concrete examples: `query="memory leak"` (good) vs `query="find the previous decision about the memory leak"` (bad).
- Document the `eventsCapped` signal: "if `eventsCapped` is true, narrow with `eventTypeFilter` or `sinceMs` — do not reword the query."
- Keep the "result does NOT enter active context" boundary text.

## Phases

| Phase | Status | Scope | Exit criteria |
| --- | --- | --- | --- |
| Phase 0 | Closed 2026-06-21 | This plan, indexed in `proposals/README.md`, with a reproduction script that runs the regression session's 5 queries against the current `searchEvents` and confirms 0 hits for queries 1–4. | Reproduction script committed; `npm run docs:check` passes. |
| Phase 1 | Closed 2026-06-21 | Tokenized AND-substring match in `searchEvents`; newest-first ordering + same-type dedup; `EventListOptions.eventTypes` pushdown in `EventRepository` + `MemoryStorage`; `contextSearch` passes `eventTypes` and raises `limit` to 50,000; add `eventsScanned` / `eventsCapped` to the result and surface in tool output; rewrite tool `prompt`/`description`; unit tests for tokenization, CJK single-token, pushdown, and the 10k-cap bypass. | Reproduction script returns ≥1 hit for queries 1–4 on first call (observed: queries 1–3 hit 3 each via assistant_output reuse of the same keywords; query 4 hits 16); query 5 returns all 8 user_message events (was 5 of 8); `npm test` green; `npm run typecheck` / `deps:audit` green. |
| Phase 2 | Watch | CJK bigram scoring for reordered Chinese queries, gated on a real Phase-1 query that AND-substring cannot satisfy. Phase 1 did NOT trigger this gate — queries 1–3 matched because the model's own prior assistant output reused the same keywords, so reordered user-message text was not the matching path. Gate remains open for a future real query. | A real session query that Phase 1 misses is resolved by bigram scoring without over-retrieving on `assistant_delta`. |
| Phase 3 | Open | Graduate this proposal to `reference/` as `Active Plan` once Phase 1 is closed against the regression session; summarize implementation into `DONE.md` / `WORK_LOG.md`. | Document lifecycle move verified by `npm run docs:check`; `reference/README.md` updated. |

## Verification

Before closing Phase 1:

- **Reproduction script** (`scripts/repro-context-search-260621.mjs`): loads the real `session_06308b17` events from `~/.babel-o/db.sqlite`, runs the 5 historical queries through the new `searchEvents`, and asserts queries 1–4 are non-empty and query 5 returns 7 user messages. This is the primary regression gate.
- **Unit tests** in `test/contextTools.test.ts` (or a new `test/context-search-algorithm.test.ts`):
  - space-separated multi-token AND match;
  - single CJK token substring match (no regression for Chinese without spaces);
  - `eventTypeFilter` pushdown reduces loaded rows and bypasses the 10k cap (construct a 10,001-event fixture);
  - `eventsCapped` is true when `nextCursor` is present, false otherwise;
  - newest-first ordering and same-type dedup.
- **Storage interface test**: `EventListOptions.eventTypes` is honored by both `SqliteStorage` and `MemoryStorage` (the latter via the existing storage-polymorphism coverage).
- **Full gate**: `npm test`, `npm run typecheck`, `npm run format:check`, `npm run deps:audit`, `npm run docs:check`, `npm run build:smoke`.
- **No regression in sibling tools**: `contextRecent` / `contextSummarize` / `contextSessions` tests remain green unchanged.

## Document Ownership

- Current priority lives in [../TODO.md](../TODO.md) and [../active/TODO_runtime.md](../active/TODO_runtime.md).
- Completed facts move to [../DONE.md](../DONE.md); detailed history to [../WORK_LOG.md](../WORK_LOG.md).
- This document keeps only the durable algorithm/robustness boundaries, the regression context, and the phase plan. It does not override TODO / DONE / WORK_LOG.
- On close, this proposal either graduates to `reference/` (if the boundaries are durable) or is summarized into `history/` (if the fix is self-contained). Per `proposals/README.md` lifecycle, it must not remain here indefinitely.

## 中文概述

### 背景

真实 session `session_06308b17`（11,952 个事件）里，`contextSearch` 连续 5 次调用 4 次空返，模型只能反复换措辞重试，最后靠 `eventTypeFilter` 兜底还丢了最新 2 条用户消息。根因是两个叠加缺陷：算法层把整个 query 当一个字面量子串去 `includes`（无分词、无中文重序容忍），鲁棒性层用 `limit:10_000` 升序加载把长 session 的新事件静默截断，而 `truncated` 只反映 token 截断不反映源截断，工具 prompt 又写成"语义搜索"口吻误导模型。

### 核心做法

算法：query 按空白分词做 AND 子串匹配，命中按时间倒序 + 同类型去重；CJK 重序问题（如 `架构分析` 匹配 `分析…架构`）用 bigram 评分解决，但作为 Phase 2，门控在"Phase 1 仍有真实 query 答不上"时才做。鲁棒性：给 `EventListOptions` 加可选 `eventTypes`，在 SQL 层 `WHERE event_type IN (...)` 下推，带 filter 时绕开 10k 上限，无 filter 时把 limit 抬到 50k；返回新增 `eventsScanned` / `eventsCapped`，让模型区分"没匹配"和"源被截断"。契约：把工具 prompt 从语义搜索口吻改成"分词子串匹配 + 用关键词而非整句"，并给出正反例。

### 当前状态

Draft。尚未动手，先按文档库准入规则落提案、建复现脚本。Phase 1 是最小闭环：分词 AND + 下推 + 诊断字段 + prompt 对齐 + 单测。Phase 2（CJK bigram）和 Phase 3（毕业到 reference）门控在真实需求。

### 下一步

最小可验证的下一步是 Phase 0：写复现脚本，用 `session_06308b17` 的 5 个真实 query 跑当前 `searchEvents`，确认 query 1–4 命中 0，作为回归基线；随后在独立分支 `fix/context-search-algorithm-robustness`（从 `develop` 切出）上推进 Phase 1。
