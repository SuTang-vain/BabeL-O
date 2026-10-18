# Compaction P0–P3: final recommendation (2026-10-17)

Status: complete prototype stack, **no stock default change**.

## Delivered

| Stage | What | Evidence |
|---|---|---|
| P0 | newest window + current-instruction pin, state budget, message-based ledger, summary usage | 3/124 failures fixed; PR #33 |
| P1 | opt-in mode/NOOP/ledger, payback admission, T1 eviction, grounding narrowing, threshold env fix | PR stack; gate v2 below |
| P1.5 | deterministic digest, window-scaled summary budget, cache token mapping, tail boundary | post-wiring digest A/B: summary 8,433→0, quality 62/62; fixed-ratio cache A/B ON 433k vs OFF 509k, 9 vs 15 compactions, quality equal |
| P2 | summary cache, summarizer override, realized-payback feedback, forced-percent knob | post-wiring digest A/B C/B 0.936, quality 62/62; runtime wiring tests |
| P3 | retrieval pointers + contextSearch/contextRecent prototype | post-delivery R median 538k vs prose 446k, paired 0.967, quality equal, 0 contextSearch; not recommended |

## P1 gate (same ceiling; v2 4x6, v3 4x4)

- B STOCK / A NOOP billed median **1.190** (90% CI [1.052, 1.288]); calls 1.0×;
  quality 186/186 both.
- C ADAPTIVE / A **1.000** (CI [0.911, 1.076]); calls 0.933×; quality 186/186.
- C gate **fails** at the 4x4 gate v3: C/A billed 1.068 (CI 0.872–1.160), calls
  +11%, quality equal; adaptive did compact (26 boundaries), but was not cheaper
  than NOOP. H1 is task-dependent (7/16 pairs ≥15%) (12/23 pairs ≥+15%, B-todos is cheaper
  with stock compaction); H2 is mixed (natural 852k is not uniformly cheapest).
- One stock cell hit context blocking at 90k despite compaction; residual risk.

## P2/P3 A/B (pre-wiring 2x3; post-wiring 4x2)

| arm | billed median | summary median | calls | contextSearch | quality |
|---|---:|---:|---:|---:|---|
| prose | 462,790 | 8,524 | 21.0 | 0 | 51/51 |
| digest | 366,045 | 0 | 18.5 | 0 | 51/51 |
| retrieval | 511,552 | 0 | 24.5 | 5 | **50/51** |

Retrieval is the most expensive and lost one CLI-filter contract; pointer-only
context is not a safe replacement for the digest.

## Recommendation

1. **Do not change the stock default.** Keep the 90% threshold, prose summary,
   system-prompt boundary, and no retrieval.
2. Ship P0 bug fixes by default (window, instruction pin, state budget, ledger).
3. Keep the policy behind opt-in flags:
   - `BABEL_O_COMPACT_MODE=adaptive` — payback admission, digest, T1 off.
   - `BABEL_O_COMPACT_T1=1` — reversible eviction (separate opt-in).
   - `BABEL_O_COMPACT_BOUNDARY=tail` — boundary before the current instruction.
   - `BABEL_O_COMPACT_SUMMARY_MODEL=<model>` — cheaper summarizer.
   - `BABEL_O_COMPACT_RETRIEVAL=1` — experimental only; not recommended.
   - `BABEL_O_COMPACT_CACHE_AWARE=1` — opt-in only; **not** a default-switch
     candidate (round-2 reproduction reversed the cost direction; see
     `compaction-next-round-20261018.md`).
   - `BABEL_O_COMPACT_FAITHFUL_DIGEST=1` (with adaptive mode) — extractive
     faithful digest prototype (2026-10-18, `feat/compaction-next`); no LLM
     summary cost, verbatim anchors, no recursive digest compaction; pilot
     evidence only, not a candidate until a same-trigger A/B exists.
4. Default-switch criteria (not met yet): a 4×6 same-ceiling gate at the
   **default** window with C/A ≤1.02, calls ≤1.05, quality non-inferior; a live
   cache-hit A/B; a harder task set; no stale-window/blocking failures; 95% CI.
5. Rollback: set `BABEL_O_COMPACT_MODE=stock`, `BABEL_O_COMPACT_BOUNDARY=system`,
   `BABEL_O_COMPACT_RETRIEVAL=0`; revert the stack if invariant tests fail.

## Resume/report wording

Do **not** say “compression controls token consumption and attention decay.”
Say: “quantified the peak-context benefit and total-token cost of compaction,
fixed the current-instruction/ledger defects, and shipped an opt-in
digest/admission stack; default remains no proactive compaction on large
windows.”

## Metric definitions

- `billed` = input + output + summaryInput + summaryOutput tokens.
- `calls` = provider calls. Report median per cell and total separately. P1 v3:
  median C 20 vs A 18 (+11%), while total calls C 304 vs A 333 (−8.7%).
- `C/A` = median of paired per-cell billed ratios; the ratio of arm medians is
  a different statistic (P1 v3: 1.0035).
- `cacheReadRatio` = `cacheRead / max(input, cacheRead+cacheCreation)` per
  event; run-cumulative uses sums. State the scope when quoting a range.
- Reproduce the four post-wiring gate tables and paired ratios with
  `node scripts/compaction-metrics.mjs` (`--format json|md|both`); pinned by
  `node --test scripts/compaction-metrics.test.mjs`. CI intervals and the
  pre-wiring/v2 tables are not computed by this script. The tool prints
  exact `.5` medians; docs truncate them to integers.

## Limitations

- Single model, small n (P1 v2 6 reps / v3 4 reps, P2/P3 2–3 reps), 2–4 tasks, saturated quality.
- The ceiling is a deliberate experimental knob; default-window behavior is not
  directly measured.
- The cache policy mock and the live cache-aware A/B are separate: the live run used the fixed ratio and verified 93/80 decisions. P3 is a post-delivery prototype evaluation.
- P1–P3 are delivered as stacked per-stage PRs #35–#38; Phase 0 is #33.

Raw artifacts: `.eval/p1gate/`, `.eval/p1gate2/`, `.eval/p1gate3/`,
`.eval/p2gate/`, `.eval/p2gate2/`, `.eval/p15gate2/`, `.eval/p3gate/`,
`.eval/p3gate2/`; reports under `docs/nexus/reference/compaction-*.md`.

## Audit follow-up (2026-10-17)

- **P2 realized payback is wired**: `recordBoundaryPayback` runs at pre-loop,
  records predicted vs actual prompt reduction, and `applyCompactionMode` feeds
  `getPaybackMultiplier(sessionId)` plus `cacheRatio` into the policy.
- **P2 hierarchical digest is wired**: the boundary persists `digest`; the next
  adaptive compaction uses `normalizeCompactionDigest` + `mergeDigests`, not
  prose concatenation.
- **P2 summary cache is opt-in**: `BABEL_O_COMPACT_SUMMARY_CACHE=1`; stock does
  not use it.
- **Live cache mapping**: per-event `cacheReadRatio =
  cacheRead / max(input, cacheRead+cacheCreation)`; run-cumulative uses the
  sum form. Observed run-cumulative ratios are about **0.68–0.90** across
  P1.5/P3 (per-event roughly 0.06–0.99), not a single 0.70–0.87 band. Live
  cache-aware A/B: ON 433,093 billed vs OFF 508,636, compactions 9 vs 15,
  quality 51/51; ON decisions show 93/80. Cache-aware stays opt-in.
- **Cache-aware cost claim retracted (round 2, 2026-10-18)**: a 4×3×2
  reproduction (`.eval/next-cache/`, 22 cells) reverses the direction —
  paired ON/OFF billed median **1.101** (n=11), compactions 28 vs 21, quality
  equal; pooled with round 1 ≈1.084 (17 pairs). Activation still verified
  (93/80 in ON ledgers only). Round-1's "ON 15% cheaper" is trajectory noise:
  with the threshold env override the trigger is identical across arms.
  **Cache-aware is opt-in only and is no longer a default-switch candidate
  on cost evidence.** Details: `compaction-next-round-20261018.md`.
- **P2/P3 replay**: post-wiring B 15 boundaries D_estimate 37,051; C 17 boundaries
  37,696; post-delivery R 9 boundaries 38,521 (pre-delivery R 10/36,463). P1 v3
  B 27/37,259; C 26/37,181 (D_actual negative due to next-turn growth).
- P1 replay D_estimate corrected to **37,491**.
