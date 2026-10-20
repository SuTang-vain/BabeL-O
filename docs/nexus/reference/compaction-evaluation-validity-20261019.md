# Compaction evaluation validity strata (2026-10-19): protocolValid ≠ taskSuccess

Branch: `stage/p3`, local commits only, not pushed. Zero paid units (analysis
and tooling only). Motivation: the kimi-e-95k round had arms reported as
"5/5 valid" with quality 24/45 — protocol-valid cells that are NOT usable
cost samples for the task. This document fixes the canonical metric
definitions so that can no longer be read as a valid cost comparison.

## Definitions (canonical, implemented in `scripts/compaction-metrics.mjs`)

| term | definition | role |
|---|---|---|
| `protocolValid` | legacy `valid`: aggregate.json flag when present, else `totals.failedTurns === 0` | protocol ran to completion; **not** task success |
| `taskSuccess` | `checklist.passed === checklist.total` and `total > 0` | the task's hidden checks all passed |
| `costEligible` | `protocolValid && taskSuccess` | **canonical filter for paired cost ratios** |
| `failureClass` | read-only classification from `runs/<arm>/db-*.sqlite` error/turn_failed events: `context_blocking` (CONTEXT_LIMIT_EXCEEDED / blocking-limit) · `final_check` (final-check/finalization guard) · `other` · `none` · `unknown` (no readable DB evidence for a failed cell). Precedence when mixed: context_blocking > final_check > other; full set kept in `failureClasses` | diagnostic only; **never** decides eligibility |
| `blockedTurns` | unchanged | diagnostic only; never decides eligibility |

Paired ratios: **canonical = costEligible pairs** (`pairsEligible`,
`ratioMedianEligible`); the legacy protocolValid-only pairing is always
printed alongside (`pairsProtocolValidLegacy`, `ratioMedianLegacy`) so
historical numbers stay reproducible byte-identically. Arm summaries add
`protocolValidCells` / `taskSuccessCells` / `costEligibleCells` counts and a
`failureClasses` tally; medians/totals remain legacy-valid-only (labeled).
The harness's own validity semantics are unchanged — this is a reporting
stratum, not a product behavior change.

Tests: `node --test scripts/compaction-metrics.test.mjs` (30/30): synthetic
strata cases (the "24/45" case; final_check + full checklist; sqlite
classification incl. precedence), plus integration pins below.

## Recompute under the new strata

| gate | pair | STRICT (costEligible) | legacy (protocolValid) | verdict |
|---|---|---|---|---|
| p1gate3 | C/A | 16p, median 1.0684 | 16p, 1.0684 | **unchanged** (all cells taskSuccess) |
| p2gate2 | C/B | 8p, 0.9356 | 8p, 0.9356 | **unchanged** |
| p3gate2 | R/B | 4p, 0.9675 | 4p, 0.9675 | **unchanged** |
| next-e-90k | CACHE/STOCK, SFAITH/STOCK | 0p / 0p | 0p / 0p | unchanged (null stands) |
| next-e-95k | CACHE/STOCK · SFAITH/STOCK | 1p 1.3521 · 1p 0.6982 | identical | unchanged (n=1, null stands) |
| next-e-100k | CACHE/STOCK · SFAITH/STOCK | 1p 1.0093 · 1p 0.7359 | identical | unchanged (n=1, null stands) |
| kimi-e-95k | CACHE/STOCK | **1p 0.7662** | 5p 1.2119 | **strict drops 5→1** |
| kimi-e-95k | SFAITH/STOCK | **3p 1.3396** | 5p 0.9218 | **strict drops 5→3** |

Per-arm strata (ts/eligible = taskSuccess / costEligible cells):

| gate | STOCK | CACHE | SFAITH |
|---|---|---|---|
| next-e-90k | pv 1, ts 2, elig 1 | pv 2, ts 3, elig 2 | pv 2, ts 2, elig 2 |
| next-e-95k | pv 3, ts 4, elig 3 | pv 2, ts 5, elig 2 | pv 3, ts 3, elig 3 |
| next-e-100k | pv 1, ts 3, elig 1 | pv 3, ts 3, elig 3 | pv 4, ts 4, elig 4 |
| kimi-e-95k | pv 5, ts 4, elig 4 | pv 5, ts 1, elig 1 | pv 5, ts 3, elig 3 |

failureClass tallies (diagnostic): E rounds — context_blocking dominates
90k/95k (STOCK 2+2 cells), final_check dominates 100k STOCK (2 cells);
kimi-e-95k — none (zero failures anywhere; quality shortfall is
task-performance, not protocol failure).

## Impact assessment

- **P1/P2/P3 conclusions: unaffected.** Every cell in those gates is
  taskSuccess (124/124, 62/62, 34/34 quality), so eligible == legacy and the
  pinned medians/pairs reproduce exactly (integration test asserts equality).
- **E rounds (90/95/100k): pair counts unchanged** — all protocolValid cells
  there also passed their full checklists, so strict == legacy; the existing
  "n≤1, no directional conclusion" verdicts stand verbatim.
- **kimi-e-95k: must be restated.** Under the canonical stratum, CACHE/STOCK
  has 1 pair (0.7662, n=1) and SFAITH/STOCK 3 pairs (median 1.3396). Both
  remain below the <3-pairs no-conclusion bar (CACHE) or at it with the
  quality-comparability caveat (SFAITH ts 3/5 vs STOCK ts 4/5). The legacy
  5-pair medians (1.2119 / 0.9218) are retained for continuity but are no
  longer canonical. Note how the stratum flips the SFAITH/STOCK median sign
  (0.9218 → 1.3396): the legacy set included cheap cells that failed the
  task — exactly the bias this change removes.
- **The cache-aware cost question** stays null under every stratum; nothing
  here rescues or condemns it.

## Commands

```
node scripts/compaction-metrics.mjs --pair "CACHE/STOCK" --pair "SFAITH/STOCK" .eval/next-e-95k
node scripts/compaction-metrics.mjs --format json .eval/kimi-e-95k
node --test scripts/compaction-metrics.test.mjs
```

## Unfinished

- Bootstrap CI is still computed by the separate `.eval/paired_bootstrap.py`
  (legacy protocolValid pairing); an eligible-aware variant is a natural
  follow-up (mechanical).
- A validity-rule proposal for the harness itself (distinguish procedural
  final_check failures from contextual ones when marking cells) remains
  unlanded; this stratum covers the reporting side only.
