# Compaction next round 4 (2026-10-19): E @ 100k three-arm A/B — validity fixed, n=1 pairs (point ratios only)

Branch: `stage/p3` (main checkout), local commits only, not pushed.
Model: `deepseek/deepseek-v4-flash` only. Stock defaults unchanged (§5).
Prior: `compaction-next-e-90k-20261019.md` (90k: STOCK 1/3 valid → 0 pairs).

## Budget (hard cap 12 paid units, 120 min)

Consumed: **12/12** (12 cells, zero casualties, zero re-runs). Subagents
(P2 review ×1): free. Analysis: free.

## A. Experiment: E-stateful-migrator @ 100k, 3 arms × 4 reps

Conditions (all arms): `BABEL_O_COMPACT_MODE=stock`,
`BABEL_O_MAX_CONTEXT_TOKENS=100000`, T1 off, retrieval off,
**`BABEL_O_AUTO_COMPACT_THRESHOLD_PERCENT` unset**,
**`BABEL_O_COMPACT_FORCED_PERCENT` unset**. STOCK: no flags. CACHE:
`+BABEL_O_COMPACT_CACHE_AWARE=1`. SFAITH: `+BABEL_O_COMPACT_FAITHFUL_DIGEST=1`.
100k chosen so 90% (90,000) vs 93% (93,000) triggers straddle E's peak
context; **not a default-window claim**. Free preflight confirmed the ledger
path (OFF 70,000/90,000 trigger 90; cache-aware 80,000/93,000 trigger 93).

Raw: `.eval/next-e-100k/{results,runs,logs}`; runners `run-{stock,cache,sfaith}.sh`;
3 parallel lanes, each cell exactly once; reps `e100-r1..r4`.

### Cells (validity = failedTurns===0) — 8/12 valid

| arm | rep | billed | calls | comp | summaryTok | failed | blocked | quality | validity |
|---|---|---:|---:|---:|---:|---:|---:|---|---|
| CACHE | r1 | 2,316,799 | 89 | 1 | 0 | 0 | 0 | 9/9 | valid |
| CACHE | r2 | 2,181,086 | 80 | 1 | 0 | 0 | 0 | 9/9 | valid |
| CACHE | r3 | 2,877,151 | 100 | 0 | 0 | 2 | 0 | 8/9 | INVALID |
| CACHE | r4 | 1,812,295 | 67 | 0 | 0 | 0 | 0 | 9/9 | valid |
| SFAITH | r1 | 1,834,384 | 74 | 0 | 0 | 0 | 0 | 9/9 | valid |
| SFAITH | r2 | 1,590,191 | 58 | 1 | 0 | 0 | 0 | 9/9 | valid |
| SFAITH | r3 | 2,564,636 | 91 | 0 | 0 | 0 | 0 | 9/9 | valid |
| SFAITH | r4 | 1,816,803 | 71 | 0 | 0 | 0 | 0 | 9/9 | valid |
| STOCK | r1 | 2,632,757 | 96 | 1 | 0 | 2 | 0 | 9/9 | INVALID |
| STOCK | r2 | 2,160,918 | 83 | 1 | 0 | 0 | 0 | 9/9 | valid |
| STOCK | r3 | 2,509,527 | 96 | 0 | 0 | 1 | 0 | 8/9 | INVALID |
| STOCK | r4 | 2,584,944 | 86 | 3 | 37,446 | 1 | 1 | 9/9 | INVALID |

**Failure-mode note (evidence from sqlite `events`):** STOCK's invalidity at
100k is NOT the 50k/90k context-blocking mode. r1 (2 failed turns) and r3 (1)
are `final_check: write/execute tool calls attempted during finalization
window` — a procedural guardrail firing when the agent keeps editing after
declaring completion; only r4 has a genuine context block
(`Context estimate … exceeds the blocking limit (99,000)`). CACHE r3's 2
failed turns: same final_check class (blocked=0). Cells are invalid by
protocol regardless of cause; quality stayed ≥8/9 everywhere.

### Ledger (acceptance evidence)

| ledger (warn/compact) | STOCK | CACHE | SFAITH |
|---|---:|---:|---:|
| 70,000/90,000 (70/90) | 43 | 6 | 41 |
| 80,000/93,000 (80/93) | 0 | **36** | 0 |

STOCK/SFAITH triggers identical (90/70) — same-trigger faithful arm confirmed
again. 93/80 appears only in CACHE. No post-context-error 80% clamp entries
this round (blocking rare at 100k).

### Metrics (`compaction-metrics.mjs --pair "CACHE/STOCK" --pair "SFAITH/STOCK"`)

| arm | valid | billed median | calls median/total | compactions (valid) | summaryTok | quality (all cells) |
|---|---:|---:|---:|---:|---:|---:|
| CACHE | 3/4 | 2,181,086 | 80 / 236 | 2 | 0 | 35/36 |
| SFAITH | 4/4 | 1,825,593.5 | 72.5 / 294 | 1 | 0 | **36/36** |
| STOCK | 1/4 | 2,160,918 | 83 / 83 | 1 | 0 (37,446 in r4) | 35/36 |

Raw compaction counts over ALL cells: STOCK 5, CACHE 2, SFAITH 1.

### Paired — one double-valid rep per comparison (e100-r2 only)

`python3 .eval/paired_bootstrap.py .eval/next-e-100k/results CACHE STOCK`
(and SFAITH STOCK; percentile bootstrap, 10k resamples, seed 20261019):

| comparison | double-valid reps | ratio | boot 90% CI |
|---|---:|---:|---|
| CACHE/STOCK | 1 (e100-r2) | **1.0093** | degenerate at n=1 |
| SFAITH/STOCK | 1 (e100-r2) | **0.7359** | degenerate at n=1 |

At n=1 the bootstrap CI collapses to the point (no resampling variability) —
**these are single-cell ratios, not estimates; no inference drawn.** The
other reps lack a valid STOCK cell (r1, r3, r4), which is itself the
dominant finding: STOCK's invalidity at 100k is procedural (final_check),
not contextual.

Tooling note: the bootstrap script takes the **results/** dir; earlier
rounds' invocations passed the gate dir and got "no pairs" — the e-90k null
was independently verified by manual enumeration, so that conclusion stands.

### Key questions (task B)

1. **Does CACHE still avoid compaction / improve validity at 100k?**
   Compactions 2 (vs STOCK 5, SFAITH 1) — it no longer achieves zero
   compaction (the task fits 100k better, so even the 90% trigger rarely
   fires), and its 93% trigger is largely moot when nothing triggers.
   Validity 3/4 vs STOCK 1/4 — but STOCK's failures are final_check
   artifacts, so this is not evidence CACHE prevents blocking.
2. **Does SFAITH keep summary=0 and quality?** Yes: 0 summary tokens in all
   4 cells, the only v2-digest boundary (r2) verified in sqlite, **4/4 valid,
   36/36 quality** — best validity and quality this round, with the lowest
   valid billed median (1,825,593.5). n=4; no strong claims.

## B. Async prefetch spike — P2 fixed, reviewed, unmerged

`spike/async-prefetch` @ `08e09e2` (single-writer): the reviewer-flagged P2
identity-delete race (evict → re-prefetch same key → old promise rejects →
new live entry deleted) is fixed by an identity-checked delete
(`entries.get(key) === entry` before delete). Regression test added (9/9
pass, tsc clean, format clean). Independent reviewer subagent verified the
fix for all interleavings and confirmed the test exercises the exact race —
P2 closed. **Not merged to stage/p3, not wired into any runtime path.**

## C. Confirmations & unfinished

- Stock defaults unchanged: STOCK arm ran with all experiment flags unset;
  no runtime code touched on stage/p3 this round (docs only).
- Nothing pushed. Commits: this report + cache-doc note (stage/p3);
  `08e09e2` on `spike/async-prefetch` (unmerged).
- Unfinished: (1) STOCK's final_check-driven invalidity is now the pairing
  bottleneck — either the harness validity rule needs a failure-class
  distinction (procedural vs contextual) or the task needs a cleaner
  completion signal; (2) at 100k the 90-vs-93 trigger difference mostly
  stops mattering because the task fits — the cache-aware question needs a
  longer task at 100k or accepts E@90k as its sensitive band; (3) SFAITH's
  n=1 pair (0.7359) is suggestive but needs ≥3 double-valid reps;
  (4) spike remains unmerged by design.
