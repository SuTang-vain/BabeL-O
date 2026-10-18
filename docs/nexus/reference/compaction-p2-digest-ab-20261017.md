# P2 digest A/B: deterministic digest vs LLM prose (2026-10-17)

Status: directional A/B, not a full gate. 2 tasks × 3 reps, one model.

## Setup

- Model: `deepseek/deepseek-v4-flash`; ceiling 90k; T1 off.
- B STOCK: prose LLM summary, threshold 50%.
- C ADAPTIVE: deterministic structured digest, forced at 50% for this run
  (`BABEL_O_COMPACT_FORCED_PERCENT=50`), so both arms compact at the same pressure.
- Tasks: A-ledger, B-todos; reps p2-r1..r3 (6 cells per arm).

Raw: `.eval/p2gate/results/`, `.eval/p2gate/aggregate.json`.

## Results

| arm | valid | billed median | summary median | calls med | compactions | quality |
|---|---:|---:|---:|---:|---:|---|
| B STOCK (prose) | 6/6 | 462,790 | 8,524 | 21.0 | 12 | 51/51 |
| C ADAPTIVE (digest) | 6/6 | 366,045 | 0 | 18.5 | 7 | 51/51 |

- Summary cost: **8,524 → 0** (digest has no provider call).
- Quality: **51/51 both arms**, no checklist regressions.
- Billed median: C is **21% lower**; paired C/B ratio median **0.915**
  (range 0.683–1.288).
- Compactions: **12 → 7**; the smaller digest post-state does not re-trigger as
  often, which is the main source of the token reduction.

Per task (billed median):

| task | B | C | C/B |
|---|---:|---:|---:|
| A-ledger | 446,998 | 335,417 | 0.75 |
| B-todos | 479,353 | 531,945 | 1.11 |

B-todos is mixed: C wins r2/r3, loses r1. The aggregate direction is driven by
A-ledger and the larger number of B compactions.

## Caveats

- n=3 per cell, 2 tasks; not the 4×6 gate used for P1.
- Some stock cells recorded 0 summary usage despite a compaction (provider usage
  instrumentation gap), so B's summary median is a lower bound.
- C's forced threshold was lowered to 50% only for this experiment; the
  production default is 92%.
- No live retrieval comparison yet; that is P3.

Verdict: P2 **directional pass** for the contract (summary cost down, checklist
non-inferior, regressions green). Do not present the 21% as a general effect.

## Runtime wiring (audit follow-up)

- **Realized payback is wired**: `recordBoundaryPayback` runs at the top of
  `executePreLoopCompactSequence`; it compares the boundary's predicted
  reduction with the actual provider prompt before/after and calls
  `recordPayback`. `applyCompactionMode` now receives `sessionId` and
  `cacheRatio`, and passes `getPaybackMultiplier(sessionId)` into the policy.
- **Hierarchical digest is wired**: adaptive compaction persists
  `compact_boundary.digest`; the next compaction parses it with
  `normalizeCompactionDigest` and merges the delta via `mergeDigests` instead of
  concatenating prose.
- **Summary cache is opt-in**: `BABEL_O_COMPACT_SUMMARY_CACHE=1`; the stock
  prose path no longer touches the cache. `BABEL_O_COMPACT_SUMMARY_MODEL`
  overrides the summarizer in the LLM path.
- Integration tests cover payback recording, previous-digest merge, cache flag,
  and model override.

## Live cache evidence

The cache mapping is live: P2/P3 usage events show DeepSeek cache-read ratios of
**0.70–0.87** (e.g. B A-ledger r2 0.78, C B-todos r2 0.85, R B-todos r3 0.875).
The cache-aware policy therefore sees real hits; this is not the earlier
zero-cache mock. No cache-on/off A/B was run.

## Replay (paired A/B boundaries)

- B prose: 12 boundaries, `D_estimate` median **38,539**, `D_actual` median −690.
- C digest: 7 boundaries, `D_estimate` median **37,561**, `D_actual` median −872.

`D_actual` compares the last call before the boundary to the first after; it is
negative because the next turn's prompt/tool results are included. `D_estimate`
is the system's pre/post estimate, not a causal shrink.

## Gate supplement: adaptive under forced pressure vs NOOP

P1's v2 gate had C at 90k with 0 compactions, so C/A there was effectively a
NOOP comparison. This supplement reuses:
- A: NOOP, 90k, p1gate2, 4 tasks x 3 reps (12 valid cells).
- C: adaptive digest, 90k, forced 50%, p2gate, 2 tasks x 3 reps (6 valid cells).

| arm | billed median | calls med | compactions | quality |
|---|---:|---:|---:|---|
| A NOOP | 353,645 | 18.0 | 0 | 93/93 |
| C adaptive | 366,045 | 18.5 | **7** | 51/51 (paired 51/51) |

Paired C/A billed median **0.950** (range 0.753–1.208). Adaptive actually
compacts under pressure, is 5% cheaper in the paired median, and has no
checklist regression on the shared tasks. This is still a small supplement,
not a 4x6 gate.

## Contract mapping

The P2 task asks for unit coverage of hierarchical merge, summary-cache reuse,
and realized-payback feedback, plus an A/B showing summary cost down with
checklist non-inferior. The digest-vs-prose A/B is that summary-cost A/B;
hierarchical merge and payback are runtime-wired and covered by integration
tests. Cache/override are opt-in flags with unit tests; no separate live A/B
exists for them, and the report does not claim one.

## Post-wiring A/B (4 tasks x 2 reps)

Run after the payback/hierarchical/cache wiring commit (6e17bee), same model,
90k, threshold/forced 50, T1 off, cache-aware off:

| arm | billed median | summary med | calls med | compactions | quality |
|---|---:|---:|---:|---:|---|
| B prose | 446,068 | 8,433 | 21.5 | 15 | 62/62 |
| C digest | 364,095 | 0 | 17.0 | 17 | 62/62 |

C/B billed ratio median **0.936** (range 0.537–1.100); quality equal. Replay:
B D_estimate 37,051, C 37,696. This is post-wiring evidence, not the earlier
pre-wiring p2gate run. Raw: `.eval/p2gate2/results/`, `aggregate.json`, `replay.json`.
