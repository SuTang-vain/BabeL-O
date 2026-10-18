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

- `D_estimate` (trigger estimate − boundary postTokens): median **37,491 tokens**.
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

## Addendum: v2 T1-decoupled rerun (partial, blocked)

After v1, T1 was decoupled behind `BABEL_O_COMPACT_T1` (default off) and A/B/C
were rerun at 90k with T1 off for 6 reps; D was reused from v1 (stock at 852k,
unaffected). During reps r4-r6 the provider returned HTTP **402 Insufficient
Balance**; those cells have 0 provider calls and `failedTurns=5` and are excluded.

Valid cells (r1-r3, `failedTurns=0`): A 12, B 9, C 9, D 12.

| arm | billed median | calls med | compactions | quality |
|---|---:|---:|---:|---|
| A | 353,645 | 18 | 0 | 93/93 |
| B | 435,878 | 19 | 15 | 71/71 |
| C | 392,082 | 20 | 0 | 70/70 |
| D | 372,820 | 16.5 | 0 | 93/93 |

- B/A paired median **1.223** (9 pairs); C/A paired median **0.934** (9 pairs).
- The v1 C regression (+7.1%) did **not** reproduce after T1 was removed; this
  is consistent with the T1/noise explanation rather than admission itself.
- The gate remains **inconclusive**: the pre-registered 6 reps are incomplete
  (B/C missing three reps), and no further provider calls are possible until the
  balance is restored.

Blocker: DeepSeek `402 Insufficient Balance`. Raw invalid cells remain in
`.eval/p1gate2/results/` with `failedTurns=5`; do not aggregate them.

## Addendum 2: v2 final (6 reps, balance restored)

The missing r4-r6 cells and the failed r3 cells were rerun after the provider
balance was restored. One cell per arm still has `failedTurns>0` but a passing
checklist; those cells are excluded from token medians and pair ratios.

| arm | valid/total | billed median | calls med | compactions | quality | wall med | re-ground | peak prompt |
|---|---|---|---:|---:|---|---:|---:|---:|
| A NOOP | 24/24 | 347,543 | 18 | 0 | 186/186 | 77.1 s | 109 | 26,416 |
| B STOCK | 23/24 | 434,447 | 19 | 41 | 186/186 | 92.6 s | 153 | 31,935 |
| C ADAPTIVE | 23/24 | 369,594 | 19 | 0 | 186/186 | 73.3 s | 78 | 26,077 |
| D NATURAL | 23/24 | 357,520 | 17 | 0 | 186/186 | 68.6 s | 33 | 30,033 |

Paired comparisons (valid cells):

- **B/A**: billed median **1.190**, 90% CI **[1.052, 1.288]**; calls median 1.0.
  B is more expensive in A-ledger (+37%), C-logstats (+7%), D-rules (+8%), but
  cheaper in B-todos (−12%). Only 12/23 pairs reach +15%; the effect is
  task-dependent, so H1 is **supported on the median, not uniformly**.
- **C/A**: billed median **1.000**, 90% CI **[0.911, 1.076]**; calls median
  **0.933**; quality equal. The pre-registered C gate (cost ≤1.02, calls ≤1.05,
  quality ≥A) **passes**.
- **H2 (ceiling)**: not confirmed. D is not uniformly cheapest: A is cheaper
  than D on A-ledger (315k vs 352k), D is much cheaper on B-todos (363k vs 573k),
  and the other two tasks are near-tied.

Residual risk: `B-A-ledger p1-r6` hit `CONTEXT_LIMIT_EXCEEDED` on three turns
despite stock compaction (estimate reached 98.8k vs an 89k blocking limit). The
checklist still passed, but the blocking path is a real failure mode at 90k.

Gate verdict: **conditional pass**. Adaptive admission is non-inferior to NOOP
and avoids the stock compaction median (+19%), but H1 is task-dependent and H2
is mixed. Stock default remains unchanged; proceed to P1.5 with these caveats.

## Gate v3: 4 tasks x 4 reps with adaptive forced to compact

The v2 gate's C arm did 0 compactions at 90k. v3 sets
`BABEL_O_COMPACT_FORCED_PERCENT=50` for C so adaptive actually compacts, and
keeps A/B at the same 90k ceiling (D natural). T1 and cache-aware policy off.

| arm | billed median | calls med | compactions | quality | peak prompt |
|---|---:|---:|---:|---|---:|
| A NOOP | 380,983 | 18 | 0 | 124/124 | 26,408 |
| B STOCK (50%) | 437,224 | 20 | 27 | 124/124 | 31,032 |
| C ADAPTIVE (digest, forced 50%) | 382,318 | 20 | **26** | 124/124 | 28,886 |
| D NATURAL 852k | 396,039 | 17 | 0 | 124/124 | 32,460 |

- B/A billed median **1.125**, 90% CI [1.024, 1.419]; 7/16 pairs ≥1.15.
  H1 remains partial: compaction costs on median, not uniformly.
- C/A billed median **1.068**, CI [0.872, 1.160]; calls 20 vs 18 (+11%);
  quality equal. The pre-registered C gate (≤1.02 cost, ≤1.05 calls) **fails**.
- H2 fails: natural D is not the cheapest (A and C are lower).
- Branch replay: B 27 boundaries D_estimate 37,259; C 26 boundaries 37,181;
  D_actual medians −856/−939 (turn-growth caveat).

Verdict: adaptive digest compacts and preserves quality, but at 4x4 it is not
cheaper than NOOP; the C gate fails. Do not default adaptive on this evidence.
Raw: `.eval/p1gate3/results/`, `aggregate.json`, `replay.json`.
