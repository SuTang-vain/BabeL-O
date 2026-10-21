# Compaction round: E-stateful-migrator @ 95k, 3 arms × 5 reps (deepseek-v4-flash)

Branch: `stage/p3` (main checkout), local commits only, not pushed.
Model: `deepseek/deepseek-v4-flash` (the kimi-k3 restart is a separate track;
see §6). Prior: `compaction-next-e-100k-20261019.md`.

## Budget

Round cap 15 paid units; consumed **16**: 14 lane cells + 1 killed mid-flight
partial (CACHE e95-r5 first attempt, killed when the deepseek phase was
stopped — disclosed) + 1 protocol re-run of that same cell. The round was
completed to 15/15 with operator approval (+1 unit).

## Conditions (all arms)

`BABEL_O_COMPACT_MODE=stock`, `BABEL_O_MAX_CONTEXT_TOKENS=95000`, T1 off,
retrieval off, **`BABEL_O_AUTO_COMPACT_THRESHOLD_PERCENT` unset**,
**`BABEL_O_COMPACT_FORCED_PERCENT` unset**. STOCK: no flags. CACHE:
`+BABEL_O_COMPACT_CACHE_AWARE=1`. SFAITH: `+BABEL_O_COMPACT_FAITHFUL_DIGEST=1`
(stock same-trigger). 95k chosen as the sensitive band (90%=85,500 vs
93%=88,350 straddling E's peak context); **not a default-window claim**.
Free preflight: OFF ledger 66,500/85,500 trigger 90; cache-aware 76,000/88,350
trigger 93. Raw: `.eval/next-e-95k/{results,runs,logs}`; 3 parallel lanes,
each cell once (plus the disclosed re-run).

## Cells (validity = failedTurns===0) — 8/15 valid

| arm | rep | billed | calls | comp | summaryTok | failed | blocked | quality | validity |
|---|---|---:|---:|---:|---:|---:|---:|---|---|
| CACHE | r1 | 2,299,195 | 80 | 1 | 20,221 | 1 | 0 | 9/9 | INVALID |
| CACHE | r2 | 1,818,868 | 69 | 1 | 0 | 0 | 0 | 9/9 | valid |
| CACHE | r3 | 2,289,208 | 86 | 1 | 0 | 0 | 0 | 9/9 | valid |
| CACHE | r4 | 2,395,522 | 76 | 8 | 79,967 | 4 | 4 | 9/9 | INVALID |
| CACHE | r5 | 2,191,391 | 75 | 4 | 49,978 | 3 | 3 | 9/9 | INVALID |
| SFAITH | r1 | 1,893,032 | 72 | 1 | 0 | 0 | 0 | 9/9 | valid |
| SFAITH | r2 | 1,647,026 | 64 | 0 | 0 | 0 | 0 | 9/9 | valid |
| SFAITH | r3 | 2,199,874 | 83 | 1 | 0 | 1 | 0 | 8/9 | INVALID |
| SFAITH | r4 | 1,614,586 | 60 | 0 | 0 | 0 | 0 | 9/9 | valid |
| SFAITH | r5 | 2,436,263 | 86 | 2 | 0 | 2 | 2 | 8/9 | INVALID |
| STOCK | r1 | 2,675,268 | 89 | 2 | 6,597 | 1 | 1 | 9/9 | INVALID |
| STOCK | r2 | 1,876,462 | 66 | 2 | 42,986 | 1 | 1 | 8/9 | INVALID |
| STOCK | r3 | 1,693,100 | 64 | 0 | 0 | 0 | 0 | 9/9 | valid |
| STOCK | r4 | 2,312,505 | 84 | 1 | 0 | 0 | 0 | 9/9 | valid |
| STOCK | r5 | 1,800,025 | 70 | 1 | 0 | 0 | 0 | 9/9 | valid |

## Ledger (acceptance evidence)

| ledger (warn/compact) | STOCK | CACHE | SFAITH |
|---|---:|---:|---:|
| 66,500/85,500 (70/90) | 51 | 15 | 51 |
| 76,000/88,350 (80/93) | 0 | **46** | 0 |
| 66,500/76,000 (70/80, post-context-error clamp) | 4 | 4 | 3 |

STOCK/SFAITH triggers identical (90/70); the 93/80 tier appears only in CACHE.

## Metrics (`compaction-metrics.mjs --pair "CACHE/STOCK" --pair "SFAITH/STOCK"`)

| arm | valid | billed median | calls median/total | compactions (valid) | summary median | quality (all cells) |
|---|---:|---:|---:|---:|---:|---:|
| CACHE | 2/5 | 2,054,038 | 77.5 / 155 | 2 | 0 | 45/45 |
| SFAITH | 3/5 | 1,647,026 | 64 / 196 | 1 | 0 | 43/45 |
| STOCK | 3/5 | 1,800,025 | 70 / 218 | 2 | 0 | 44/45 |

Compactions over ALL cells: **STOCK 6, CACHE 15, SFAITH 4**. SFAITH
summary-token total = **0 in every cell** (digest is LLM-free; v2 digests on
its boundaries per prior verification pattern). CACHE r4 (8 compactions) and
r5 (4) show that at 95k the 93% trigger no longer reliably prevents
compaction — trajectory variance dominates.

## Paired — n=1 per comparison: null, no directional conclusion

`python3 .eval/paired_bootstrap.py .eval/next-e-95k/results <NUM> STOCK`
(percentile bootstrap, 10k resamples, seed 20261019):

| comparison | double-valid reps | ratio | boot 90% CI |
|---|---:|---:|---|
| CACHE/STOCK | 1 (e95-r3) | **1.3521** | degenerate at n=1 |
| SFAITH/STOCK | 1 (e95-r4) | **0.6982** | degenerate at n=1 |

**Sample insufficient (<3 pairs): no directional conclusion.** The two
single-cell ratios point in opposite directions anyway; at n=1 the CI has no
resampling variability. Reported for completeness only.

## Failure classification (`.eval/classify_failures.py`, sqlite `events` evidence)

| cell | failed/blocked | classes |
|---|---|---|
| CACHE r1 | 1/0 | other ("fetch failed" — transient network) |
| CACHE r4 | 4/4 | context_blocking |
| CACHE r5 | 3/3 | context_blocking + final_check |
| SFAITH r3 | 1/0 | final_check |
| SFAITH r5 | 2/2 | context_blocking |
| STOCK r1 | 1/1 | context_blocking |
| STOCK r2 | 1/1 | context_blocking |

Tally: context_blocking 5 cells, final_check 2 cells, other 1 cell. At 95k,
context blocking is again the dominant invalidity mode (unlike 100k where
final_check dominated); quality stayed ≥8/9 in all cells. Harness validity
semantics unchanged; no rule change made.

## Confirmations & unfinished

- Stock defaults unchanged (STOCK arm all flags unset; no runtime compaction
  code touched for this round — the only runtime edit this phase is the
  eval-only `kimi-coding` provider/model registry entry for the separate
  kimi track, which does not alter any default).
- Nothing pushed.
- Unfinished: (1) paired cost remains undetermined after three windows
  (90k: 0 pairs; 100k: 1+1; 95k: 1+1) — the binding constraint is
  invalidity, not design; a validity rule that distinguishes failure classes
  (procedural final_check vs contextual) is worth a proposal, not landed;
  (2) cache-aware at 95k no longer prevents compaction (15 vs STOCK 6) —
  its protective band looks task-trajectory-dependent, not window-tunable;
  (3) kimi-k3 @ 95k three-arm round is running as a separate track
  (`.eval/kimi-e-95k/`, 15 fresh units approved) — reported separately on
  completion; (4) async prefetch spike remains unmerged (`08e09e2`).
