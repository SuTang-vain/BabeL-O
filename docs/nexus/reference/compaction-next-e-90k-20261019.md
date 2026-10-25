# Compaction next round 3 (2026-10-19): E @ 90k three-arm A/B (mechanism confirmed, paired cost = null)

Branch: `stage/p3` (main checkout), local commits only, not pushed.
Model: `deepseek/deepseek-v4-flash` only. Stock defaults unchanged (§5).
Prior rounds: `compaction-next-valid-cache-20261018.md` (50k null — all cells
blocked), `compaction-next-round-20261018.md` (threshold-override null test).

## Budget (hard cap 10 paid units, 120 min)

Consumed: **9/10** (9 cells, all completed; zero casualties, zero re-runs).
Lanes: 3 parallel (one per arm), each cell exactly once; no concurrent writes
to the same cell. Reviewer subagent: free (read-only).

## A. Experiment: E-stateful-migrator @ 90k, 3 arms × 3 reps

Conditions (all arms): `BABEL_O_COMPACT_MODE=stock`,
`BABEL_O_MAX_CONTEXT_TOKENS=90000`, T1 off, retrieval off,
**`BABEL_O_AUTO_COMPACT_THRESHOLD_PERCENT` unset**,
**`BABEL_O_COMPACT_FORCED_PERCENT` unset**. STOCK: no flags. CACHE:
`+BABEL_O_COMPACT_CACHE_AWARE=1`. SFAITH: `+BABEL_O_COMPACT_FAITHFUL_DIGEST=1`
(same-trigger faithful under stock, merged at eb20e8a).
Free preflight replicated the ledger path (90k: OFF 62999/81000 trigger 90;
cache-aware high-cache 72000/83700 trigger 93).

Raw: `.eval/next-e-90k/{results,runs,logs}`; runners `run-{stock,cache,sfaith}.sh`;
drivers `lane-*.sh`; reps `e90-r1..r3`.

### Cells (validity = failedTurns===0)

| arm | rep | billed | calls | compactions | summaryTok | failed | blocked | quality | validity |
|---|---|---:|---:|---:|---:|---:|---:|---|---|
| STOCK | r1 | 2,343,916 | 81 | 5 | 42,320 | 2 | 2 | 9/9 | INVALID |
| STOCK | r2 | 3,121,762 | 112 | 2 | 16,971 | 2 | 1 | 8/9 | INVALID |
| STOCK | r3 | 1,692,362 | 66 | 0 | 0 | 0 | 0 | 9/9 | valid |
| CACHE | r1 | 1,342,320 | 53 | 0 | 0 | 0 | 0 | 9/9 | valid |
| CACHE | r2 | 1,705,520 | 66 | 0 | 0 | 0 | 0 | 9/9 | valid |
| CACHE | r3 | 2,325,493 | 87 | 2 | 0 | 1 | 1 | 9/9 | INVALID |
| SFAITH | r1 | 1,815,502 | 65 | 1 | 0 | 0 | 0 | 9/9 | valid |
| SFAITH | r2 | 2,158,361 | 86 | 0 | 0 | 0 | 0 | 9/9 | valid |
| SFAITH | r3 | 2,117,407 | 77 | 4 | 0 | 4 | 3 | 8/9 | INVALID |

### Ledger (acceptance evidence)

| ledger (warn/compact) | STOCK | CACHE | SFAITH |
|---|---:|---:|---:|
| 62,999/81,000 (70/90) | 33 | 4 | 31 |
| 72,000/83,700 (80/93) | 0 | **26** | 0 |
| 62,999/72,000 (70/80, post-context-error clamp) | 2 | 2 | 2 |

STOCK and SFAITH triggers are identical (90/70) — the same-trigger faithful
arm is confirmed in live data. The 93/80 cache-preservation tier appears only
in CACHE. (62,999 not 63,000 is the code's real rounding, same as all prior
90k rounds.)

### Metrics (`node scripts/compaction-metrics.mjs --pair "CACHE/STOCK" --pair "SFAITH/STOCK" .eval/next-e-90k`)

| arm | valid | billed median | calls median/total | compactions (valid cells) | summaryTok median | quality (all cells) |
|---|---:|---:|---:|---:|---:|---:|
| STOCK | 1/3 | 1,692,362 | 66 / 66 | 0 | 0 | 26/27 |
| CACHE | 2/3 | 1,523,920 | 59.5 / 119 | 0 | 0 | **27/27** |
| SFAITH | 2/3 | 1,986,931.5 | 75.5 / 151 | 1 | 0 | 26/27 |

Raw compaction counts over ALL cells (incl. invalid): STOCK 7, CACHE 2,
SFAITH 5. SFAITH summary-token total is exactly 0 in every cell (digest is
LLM-free); all 5 SFAITH boundaries carry `version: 2` faithful digests
(sqlite-verified).

### Paired analysis — **null, with explicit reasons**

`python3 .eval/paired_bootstrap.py .eval/next-e-90k CACHE STOCK` and
`SFAITH STOCK` both return **no pairs**: in every rep, at least one arm's
cell is invalid (r1/r2 STOCK invalid; r3 CACHE and SFAITH invalid). With 0
pairs where both cells are valid, no paired median or bootstrap CI exists —
this is the pre-registered null condition, not a workaround target.

### Observations (n≤3, no conclusions)

- CACHE's valid cells had **zero compactions** — the 93% trigger kept both
  runs below threshold for the entire 10-step task (peak context lands in the
  81k–83.7k band where 90 vs 93 matters). CACHE also had the best validity
  (2/3), the only perfect quality (27/27), and the lowest valid billed
  median. This is consistent with the intended mechanism at this task scale,
  but n=2 valid cells and no valid pairing → **no cost claim**.
- STOCK was the only arm to compact in its invalid cells (5 and 2 times) and
  the only arm paying summary tokens (42,320 + 16,971).
- Failures are the known `CONTEXT_LIMIT_EXCEEDED` blocking mode (blocked
  turns), not silent task failures; quality stayed ≥8/9 everywhere.

## B. Async prefetch spike — read-only review (no paid units)

Reviewer subagent on `spike/async-prefetch` @ `6139c57` (unmerged, unwired):
stale-summary guard structurally sound (summaries served only under the
awaited events' own key; late resolutions cannot leak into mismatched
results); deadline math OK; no unhandled-rejection risk; bounded memory.
Findings: **no core blockers**; one P2 code issue (identity-delete race on
evict→re-prefetch→reject, line ~159); wiring preconditions restated
(deadline semantics choice, abort plumbing, exporting
`selectCompactionWindow`, per-session cache lifetime, 5 test gaps). Verdict:
OK as an unwired spike. The spike remains unmerged by design.

## C. Cache-doc update

Round-3 evidence appended to `compaction-cache-mock-20261017.md` (history
preserved): at 90k with NO threshold override, the 93/80 tier activates only
under the flag (26/32 CACHE decisions) and CACHE's valid cells had zero
compactions — mechanism confirmed; cost still unproven (0 valid pairs).

## D. Confirmations & unfinished

- Stock defaults unchanged: no edits to `compactionMode.ts` defaults, 90/70
  thresholds, prose path, system boundary, retrieval gating; STOCK arm ran
  with all experiment flags unset.
- Nothing pushed; commits on `stage/p3` (this file + the cache-doc note).
- Spike unmerged (`6139c57` on `spike/async-prefetch`).
- Unfinished: (1) paired cost comparison needs >3 reps or less noisy tasks —
  blocking-induced invalidity at 90k is the binding constraint (STOCK lost
  2/3 cells); (2) the post-context-error 80% clamp now appears in every arm's
  ledger — worth its own look if compact-after-block behavior matters;
  (3) cache-aware's zero-compaction effect observed here is exactly the
  behavior the threshold-override rounds could never show — a larger-n
  repeat at 90k (no override) is the natural next gate.
