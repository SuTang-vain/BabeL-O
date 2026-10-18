# Compaction P0–P3: final recommendation (2026-10-17)

Status: complete prototype stack, **no stock default change**.

## Delivered

| Stage | What | Evidence |
|---|---|---|
| P0 | newest window + current-instruction pin, state budget, message-based ledger, summary usage | 3/124 failures fixed; PR #33 |
| P1 | opt-in mode/NOOP/ledger, payback admission, T1 eviction, grounding narrowing, threshold env fix | PR stack; gate v2 below |
| P1.5 | deterministic digest, window-scaled summary budget, cache token mapping, tail boundary | digest A/B: summary 8,524→0, quality 51/51 |
| P2 | summary cache, summarizer override, realized-payback feedback, forced-percent knob | 8 unit tests; directional A/B |
| P3 | retrieval pointers + contextSearch/contextRecent prototype | negative A/B: 1.24× prose, 50/51 |

## P1 gate (same ceiling, 4 tasks × 6 reps)

- B STOCK / A NOOP billed median **1.190** (90% CI [1.052, 1.288]); calls 1.0×;
  quality 186/186 both.
- C ADAPTIVE / A **1.000** (CI [0.911, 1.076]); calls 0.933×; quality 186/186.
- C gate passes; H1 is task-dependent (12/23 pairs ≥+15%, B-todos is cheaper
  with stock compaction); H2 is mixed (natural 852k is not uniformly cheapest).
- One stock cell hit context blocking at 90k despite compaction; residual risk.

## P2/P3 A/B (2 tasks × 3 reps, forced 50%, same ceiling)

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

## Limitations

- Single model, small n (P1 6 reps, P2/P3 3 reps), 2–4 tasks, saturated quality.
- The ceiling is a deliberate experimental knob; default-window behavior is not
  directly measured.
- Cache A/B is a policy mock, not live; P3 is a prototype evaluation.
- P1–P3 share a stacked branch/PR; Phase 0 is separate.

Raw artifacts: `.eval/p1gate/`, `.eval/p1gate2/`, `.eval/p2gate/`,
`.eval/p3gate/`; reports under `docs/nexus/reference/compaction-*.md`.
