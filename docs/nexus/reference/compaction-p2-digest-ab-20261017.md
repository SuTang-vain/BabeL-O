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
