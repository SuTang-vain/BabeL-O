# Compaction Async Summary Prefetch — SPIKE (2026-10-19)

> State: Spike complete — module + tests landed, **not wired into any runtime path**
> Track: Compaction / latency
> Branch: `spike/async-prefetch` (base `8898a34`)
> Source of truth: `src/runtime/compactionPrefetch.ts`, `test/compaction-prefetch.test.ts`;
> wiring target (unchanged by this spike): `src/runtime/compact.ts`

## 1. Hypothesis

In stock mode, `compactSession()` pays the full LLM summary latency
synchronously at trigger time (`llmSummarizeEventsWithUsage`, measured as
`summaryLatencyMs`). If the summary for the *predicted next omission set* is
started early — e.g. right after each turn, while the provider is idle — a
later auto-compaction can await an already-started summary and pay only the
remaining latency instead of the full call.

## 2. What landed

`src/runtime/compactionPrefetch.ts` — pure module, dependencies inverted
(the summarizer is injected; no import of `compact.ts` / `compactSummary.ts`,
no cycle, no runtime wiring, no env flags, no globals):

- `createPrefetchCache({ summarize, maxEntries = 4, now })` →
  `{ prefetch, awaitSummary, size, clear }`.
- `prefetch(events)`: starts `summarize(events)` immediately, stores
  `{ key, promise, startedAt }`; duplicate prefetch for the same content key
  is a no-op; LRU eviction at `maxEntries`; late settlements of evicted
  entries mutate only the orphaned entry and never re-enter the map; a
  settlement observer attached at prefetch time guarantees rejections are
  always handled.
- `buildPrefetchKey(events)`: sha256 over a canonical JSON projection of
  every event field except the constant `schemaVersion` (sorted object keys,
  circular-safe). Stronger than `summaryCache.buildSummaryCacheKey`, which
  hashes only text *lengths* — a same-length edit would collide there and
  cannot here.
- `awaitSummary(events, { deadlineMs })`:
  - key hit → race the stored promise against the **remaining** time
    (`deadlineMs - elapsed since prefetch`); resolved →
    `{ status: 'hit', summary, latencySavedMs }`; timeout →
    `{ status: 'fallback', reason: 'timeout' }` (entry kept under its original
    key — timeout is not eviction; the result is never re-keyed); rejection →
    `{ status: 'fallback', reason: 'error' }` (entry removed). An
    already-resolved entry wins the race even at an exhausted deadline.
  - no entry + empty cache → `{ status: 'miss' }`.
  - no entry + non-empty cache → `{ status: 'stale' }`: the predictions no
    longer match reality; all non-matching entries are invalidated. The stored
    summary is **never** served for different events, even after it resolves.

`test/compaction-prefetch.test.ts` — 8 tests, fully local (summarizer is an
injected deferred; `now` is injectable so `latencySavedMs` is asserted
exactly). All pass; `npx tsc --noEmit` clean. Run:

```
NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/babel-o-prefetch-test.json npx tsx --test test/compaction-prefetch.test.ts
```

## 3. Wiring point (sketch — NOT implemented)

Two insertion points around the existing stock-mode branch in
`compactSession()`:

```ts
// (a) After each turn (e.g. end of LLMCodingRuntime.executeStream or the
//     contextRefresh path): predict the next omission set and kick the summary.
const compactable = /* same derivation as compactSession */
const predicted = selectOmittedEvents(compactable, selectCompactionWindow(compactable, budget, initialPrompt, mapFn))
prefetchCache.prefetch(predicted)
// summarize injected as:
//   evts => llmSummarizeEvents(evts, modelId, { mapEventsToMessages, initialPrompt }).then(...)

// (b) Inside compactSession, stock-mode branch, before llmSummarizeEventsWithUsage:
const outcome = await prefetchCache.awaitSummary(omittedEvents, { deadlineMs: REACTIVE_SUMMARY_BUDGET_MS })
if (outcome.status === 'hit') newSummary = outcome.summary
else /* existing path: summaryCache lookup + llmSummarizeEventsWithUsage */
```

Notes for any future wiring PR:

- `selectCompactionWindow` is currently **private** to `compact.ts`; a wiring
  PR must export it (or extract the prediction) so the post-turn prefetch uses
  exactly the same window logic as the trigger-time compaction. Divergent
  prediction logic is the main hit-rate risk — and is safe-by-construction
  here because a wrong prediction only wastes a prefetch, never corrupts the
  summary (§4).
- `deadlineMs` = the reactive budget at trigger: the runtime measures
  `summaryLatencyMs` but has no latency budget today; a fixed budget (order of
  1–2 s) or a percentile of observed `summaryLatencyMs` would do. On
  timeout/fallback the existing synchronous path runs unchanged, so wiring is
  latency-safe by construction.
- Cache lifetime: one instance per session (or per runtime) is enough;
  `maxEntries` 4 comfortably covers turn-after-turn re-predictions.
- Interplay with `summaryCache` (opt-in via `BABEL_O_COMPACT_SUMMARY_CACHE`):
  a prefetch hit subsumes the cache lookup for that compaction; the existing
  cache remains the fallback path and the dedupe for *repeated* compactions.

## 4. Stale / abort risks, and how the key guard addresses them

| Risk | Handling |
| --- | --- |
| **Wrong prediction** (events appended after prefetch; window shifts) | Content key mismatches at trigger → `'stale'`; stored summary never served, entries invalidated. Worst case: one wasted LLM call. |
| **Same-length edit** to an event | Rekeys (full-content hash, not text lengths like `summaryCache`). |
| **Evicted entry resolves late** | Settlement mutates only the orphaned entry object; never re-enters the map (tested). |
| **Timeout then late resolution** | Entry kept under its *original* key only; a later await of the same events may still hit; different events get `'stale'`, never the summary (tested). |
| **Rejected summarize** | Observer attached at prefetch time → no unhandled rejection; await surfaces `'fallback'` and removes the entry (tested). |
| **Abort/cancellation** | Deliberately not owned by the module. `LlmSummarizeOptions` already accepts `signal?: AbortSignal`, so a wiring PR can close over an `AbortController` per prefetch and abort on eviction/stale to reclaim provider quota. Without that, a wrong prediction burns one extra summary call — bounded by `maxEntries`. |
| **Cost blowup** | Prefetch policy (when to predict) is a wiring decision, out of spike scope; the sane policy is "only when auto-compact is approaching its threshold", not after every turn. |

## 5. Why faithful-digest mode lowers the value

The prefetch hides **LLM** latency. Only the stock-mode branch of
`compactSession()` calls the LLM. Every adaptive-mode branch is LLM-free:

- faithful digest (`isFaithfulDigestEnabled()`): `buildFaithfulDigest` +
  `renderFaithfulDigest` are pure extract/render — no summary call to hide;
- retrieval pointers (`isRetrievalCompactionEnabled()`): deterministic index;
- T2 deterministic digest: `buildDeterministicDigest` + `mergeDigests`.

Recent compaction work on this base (`e77a281` faithful-digest prototype,
`8898a34` cache-aware round 2 as a null test) moves the default trajectory
*toward* deterministic digests. If faithful/retrieval becomes the default
mode, there is no LLM summary latency left to prefetch. Prefetch therefore
only has value while stock-mode LLM summarization remains a supported,
commonly-used path — or as the latency story for providers where the summary
call itself is the bottleneck regardless of mode direction.

## 6. Go / no-go

**GO on feasibility**: the mechanism works — content-keyed prefetch +
deadline-bounded await + stale guard, proven by 8 deterministic local tests;
typecheck clean; zero runtime coupling (drop-in, drop-out).

**Conditional NO-GO on wiring for now.** Wire only when all of these hold:

1. Stock-mode LLM summarization is confirmed to remain a supported path worth
   optimizing (not superseded by faithful/retrieval digests);
2. A prefetch trigger policy is chosen (threshold-proximity, not every turn)
   to bound wasted calls;
3. Abort plumbing (`AbortSignal` through the injected summarizer) is wired so
   evicted/stale prefetches are actually cancelled;
4. `selectCompactionWindow` (or equivalent) is shared between prediction and
   trigger so the hit rate is measurable — wiring should log
   hit/miss/stale/fallback rates before any default-on decision.

Until then the module stays an isolated spike: importable, testable, inert.
