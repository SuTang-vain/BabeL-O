# Compaction P1 gate: same-ceiling A/B + replay (2026-10-17)

Status: **gate not passed** — H1 partial, H2 partial, C gate failed by the pre-registered thresholds.
This report is the evidence for PR #34; no default behavior was changed.

## Design (pre-registered)

- Model: `deepseek/deepseek-v4-flash`; 5-step tasks (`A-ledger`, `B-todos`, `C-logstats`, `D-rules`); 6 reps.
- A `NOOP`: `BABEL_O_COMPACT_MODE=noop`, ceiling 90k, no auto/reactive compaction.
- B `STOCK`: `stock`, ceiling 90k, `BABEL_O_AUTO_COMPACT_THRESHOLD_PERCENT=50`.
- C `ADAPTIVE`: `adaptive`, ceiling 90k; payback admission, forced at 92%.
- D `NATURAL`: `stock`, ceiling 852k; no compaction expected.

Pre-registration: `.eval/p1gate/preregistration.md`.
Raw results: `.eval/p1gate/results/` (96 JSON cells), `.eval/p1gate/replay.json`,
`.eval/p1gate/aggregate.json`; decision ledgers under `.eval/p1gate/runs/<arm>/decisions-*.jsonl`.

## Results (24 cells per arm)

| arm | billed median | calls med | compactions | summary med | quality | wall med | re-ground | peak prompt |
|---|---:|---:|---:|---:|---|---:|---:|---:|
| A NOOP | 381,641 | 20 | 0 | 0 | 186/186 | 73.2 s | 137 | 25,658 |
| B STOCK | 417,350 | 19 | 45 | 7,343 | 186/186 | 90.7 s | 198 | 32,393 |
| C ADAPTIVE | 414,254 | 21 | 0 | 0 | 186/186 | 78.4 s | 118 | 27,843 |
| D NATURAL | 356,203 | 16 | 0 | 0 | 186/186 | 71.4 s | 33 | 29,918 |

Per task (billed median):

| task | A | B | C | D |
|---|---:|---:|---:|---:|
| A-ledger | 377,238 | 400,352 (+6.1%) | 446,787 (+18.4%) | 352,304 |
| B-todos | 461,121 | 548,320 (+18.9%) | 497,539 (+7.9%) | 363,308 |
| C-logstats | 410,684 | 423,115 (+3.0%) | 405,187 (−1.3%) | 397,341 |
| D-rules | 368,404 | 338,296 (−8.2%) | 297,642 (−19.2%) | 304,071 |

## Hypothesis verdicts

- **H1 (compaction costs): PARTIAL / NOT CONFIRMED.**
  B/A paired median **1.154** with bootstrap 90% CI **[1.054, 1.301]** (excludes 1),
  but only **12/24 pairs** reach ≥1.15 (the pre-registered 75% pair-count rule would
  require 18/24), and two of four task medians are ≤ +6% (D-rules is −8.2%).
  Compaction cost is task-dependent, not a general +20–42% effect.
- **H2 (ceiling costs): PARTIAL.**
  A vs B are within +9.4% (consistent with the ceiling, not compaction), but the
  pre-registered "both ≥1.15× D" fails for A (381,641 / 356,203 = 1.071). B is
  1.172× D. The natural 852k window is the cheapest arm in 3/4 tasks.
- **H3 (noise): triggered.** The 4-rep CI included 1 and task signs flipped, so the
  run was extended to 6 reps. The 6-rep result still has high variance; H1 remains
  partial rather than a clean pass.
- **C gate: FAIL by the pre-registered thresholds.** C/A paired median 1.071 > 1.02;
  calls 21 vs 20 (+5%) > 1.05; checklist equal. The CI includes 1 [0.935, 1.223],
  and C performed **0 compactions** at 90k (payback admission rejects; forced 92%
  is not reached), so C is effectively NOOP + T1 in this configuration. The point
  estimate fails the gate; the effect is not separable from run variance.

## Replay (paired, not a model fork)

45 B boundaries across 24 cells:

- `D_estimate` (trigger estimate − boundary postTokens): median **37,495 tokens**.
- `D_provider` (last provider prompt before − first after): median **−840 tokens**;
  negative because the first call after a boundary includes the next turn's prompt
  and tool results. This is not a causal shrink measurement.
- `k` (B calls − paired A calls, per compaction): median **0.0** (23 pairs).
  Unlike the earlier 90k/50% forced experiment, stock compaction did **not** induce
  extra provider calls here; the earlier +3 calls/compaction was likely the ceiling
  or trajectory variance.

## Interpretation

1. The earlier +20–42% headline was substantially a **ceiling** effect: at the same
   90k ceiling, stock compaction adds a median +15.4% but only in some tasks; the
   no-compaction A arm is already 7.1% above the natural-window D arm.
2. Compaction is not uniformly cost-positive: D-rules is cheaper with stock
   compaction, A-ledger/B-todos are more expensive. Quality is saturated (186/186
   everywhere), so these differences are pure cost/latency, not quality.
3. Adaptive P1 never compacted at 90k because the payback gate rejects (N* > N̂).
   Its C/A delta is therefore T1 + noise; the pre-registered C gate cannot
   distinguish a real T1 regression from variance at n=24.
4. The gate does **not** justify proceeding to P1.5 as if P1 were validated.
   The decision needs an owner call: decouple T1 from adaptive and rerun, relax the
   C gate with a non-inferiority margin, or stop the policy track.

## Follow-ups (not executed)

- Decouple T1 from `adaptive`: run A/B/C with T1 on/off separately.
- Increase reps for the A-ledger/B-todos cells, where the B/A variance is largest.
- If the goal is to minimize tokens on 1M-window models, the evidence favors
  **natural window + no proactive compaction**; the ceiling cap itself costs ~7%.
- Do not change the stock default on this evidence.
