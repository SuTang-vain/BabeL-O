# Compaction round: E-stateful-migrator @ 95k, 3 arms × 5 reps — **kimi-coding/k3**

Branch: `stage/p3` (main checkout), local commits only, not pushed.
Model: **`kimi-coding/k3` only** (kimi-k3; provider `kimi-coding`,
`https://api.kimi.com/coding/v1`; key injected via `BABEL_O_API_KEY`).
Sister round: `compaction-next-e-95k-20261019.md` (same design, deepseek-v4-flash).

## Budget

15/15 Kimi cells consumed (cap 15). Zero casualties, zero re-runs. One
launcher bug (literal `$ARM` quoting) failed all 15 first-pass invocations at
argument parsing **before any API call** — zero paid units wasted, disclosed,
fixed by hardcoding the arm label. No DeepSeek (or other model) runs this
round. No new experiments after this report.

## Conditions (all arms)

Identical to the deepseek 95k round: `BABEL_O_COMPACT_MODE=stock`,
`BABEL_O_MAX_CONTEXT_TOKENS=95000`, T1 off, retrieval off,
**`BABEL_O_AUTO_COMPACT_THRESHOLD_PERCENT` unset** (recorded as `(unset)` in
every result's env), **`BABEL_O_COMPACT_FORCED_PERCENT` unset**. STOCK: no
flags. CACHE: `+BABEL_O_COMPACT_CACHE_AWARE=1`. SFAITH:
`+BABEL_O_COMPACT_FAITHFUL_DIGEST=1`. Free preflight (kimi-coding/k3, 95k):
OFF 66,500/85,500 trigger 90; cache-aware 76,000/88,350 trigger 93.
Model evidence: every decision-ledger entry records `modelId: kimi-coding/k3`,
`mode: stock` (15/15 ledgers).

Raw: `.eval/kimi-e-95k/{results,runs,logs}`; runners `run-{stock,cache,sfaith}.sh`;
3 parallel lanes; reps `k95-r1..r5`; each cell exactly once.

## Cells — 15/15 valid (failedTurns=0, blockedTurns=0 everywhere)

| arm | rep | billed | calls | comp | summaryTok | quality |
|---|---|---:|---:|---:|---:|---|
| CACHE | r1 | 1,069,277 | 38 | 0 | 0 | 3/9 |
| CACHE | r2 | 748,246 | 34 | 0 | 0 | 3/9 |
| CACHE | r3 | 1,066,203 | 41 | 0 | 0 | 6/9 |
| CACHE | r4 | 906,140 | 47 | 0 | 0 | 9/9 |
| CACHE | r5 | 1,916,251 | 66 | 1 | 0 | 3/9 |
| SFAITH | r1 | 1,212,238 | 45 | 0 | 0 | 9/9 |
| SFAITH | r2 | 1,078,130 | 46 | 0 | 0 | 9/9 |
| SFAITH | r3 | 811,021 | 41 | 0 | 0 | 3/9 |
| SFAITH | r4 | 1,055,837 | 59 | 0 | 0 | 9/9 |
| SFAITH | r5 | 1,205,061 | 44 | 0 | 0 | 3/9 |
| STOCK | r1 | 776,904 | 36 | 0 | 0 | 9/9 |
| STOCK | r2 | 804,793 | 37 | 0 | 0 | 9/9 |
| STOCK | r3 | 879,811 | 45 | 0 | 0 | 3/9 |
| STOCK | r4 | 1,182,618 | 49 | 0 | 0 | 9/9 |
| STOCK | r5 | 1,478,581 | 55 | 0 | 0 | 9/9 |

Diagnostics (read-only; harness validity semantics unchanged):
`taskSuccess` (checklist 9/9): STOCK 4/5, CACHE 1/5, SFAITH 3/5.
`proceduralInvalid` (failedTurns>0 without context blocking): 0 cells —
all 15 cells are protocol-valid; the quality shortfall is task-performance,
not failure.

## Ledger (acceptance evidence)

| ledger (warn/compact) | STOCK | CACHE | SFAITH |
|---|---:|---:|---:|
| 66,500/85,500 (70/90) | 50 | 5 | 50 |
| 76,000/88,350 (80/93) | 0 | **45** | 0 |

STOCK/SFAITH triggers identical (90/70); 93/80 only under the CACHE flag.
No post-context-error 80% clamp entries (zero blocking at 95k under k3).

## Metrics (`compaction-metrics.mjs --pair "CACHE/STOCK" --pair "SFAITH/STOCK"`)

| arm | valid | billed median | calls median/total | compactions | summary | quality |
|---|---:|---:|---:|---:|---:|---:|
| STOCK | 5/5 | 879,811 | 45 / 222 | 0 | 0 | 39/45 |
| CACHE | 5/5 | 1,066,203 | 41 / 226 | 1 | 0 | 24/45 |
| SFAITH | 5/5 | 1,078,130 | 45 / 235 | 0 | 0 | 33/45 |

## Paired — CI crosses 1 AND quality non-comparable → **cost conclusion null**

`python3 .eval/paired_bootstrap.py .eval/kimi-e-95k/results <NUM> STOCK`
(percentile bootstrap, **10,000 resamples, seed 20261019**):

| comparison | pairs | ratios (per rep) | median | boot 90% CI | crosses 1? |
|---|---:|---|---:|---|---|
| CACHE/STOCK | 5 | 1.376, 0.930, 1.212, 0.766, 1.296 | **1.2119** | [0.7662, 1.3763] | **yes → null** |
| SFAITH/STOCK | 5 | 1.560, 1.340, 0.922, 0.893, 0.815 | **0.9218** | [0.8150, 1.5603] | **yes → null** |

Two independent reasons forbid any cost/strategy conclusion:
1. Both CIs span 1.0 (pre-registered null condition).
2. **Quality is not comparable across arms** (CACHE 24/45 and SFAITH 33/45
   vs STOCK 39/45): cheaper-or-dearer at different quality is not a cost
   result.

## Cross-model note (qualitative ONLY — no mixed statistics, no model ranking)

Same task/conditions, different model families:
- deepseek-v4-flash @ 95k: quality 43–45/45 per arm; billed medians
  1.65M–2.05M; invalidity dominated by context blocking (5 cells).
- kimi-k3 @ 95k (this round): quality 24–39/45 per arm; billed medians
  0.88M–1.08M; **zero** failed/blocked turns; almost no compaction fired
  (1 across 15 cells) because trajectories stayed short.

**Kimi-k3's task quality on E-stateful-migrator is visibly lower than
deepseek-v4-flash's (e.g. CACHE 24/45 vs 45/45; best arm 39/45 vs 43–45/45).**
It therefore cannot serve as an equivalent-model replication of the
deepseek compaction findings; its shorter trajectories also never exercise
the 90-vs-93 trigger band (compactions ≈ 0), so this round is uninformative
for the cache-aware cost question regardless of the CI. Qualitative
observations only; no pooled stats, no model-superiority claims.

## Confirmations & unfinished

- Stock defaults unchanged (STOCK arm all flags unset; only runtime change
  this track is the approved eval-only `kimi-coding` registry entry, d35e702).
- Nothing pushed. This report is the only commit.
- Unfinished: (1) cache-aware cost remains undetermined — four windows
  (50/90/95/100k × deepseek) + this kimi round all null for different reasons
  (override null test; blocking; too-loose window; paired n=1; CI-crossing +
  quality-incomparable); (2) if kimi-k3 is to be used further, tasks must be
  re-calibrated to its capability/trajectory length so the trigger band is
  actually exercised; (3) async prefetch spike unmerged (`08e09e2`);
  (4) no Kimi 100k or further experiments started per instructions.
