# Compaction experiments index (2026-10-19)

Single ledger for every compaction evaluation round. Status values:
**canonical** (citable under the current metric definitions) · **null**
(valid experiment, no directional result) · **insufficient** (pair count
below the ≥3 bar) · **withdrawn** (number must not be cited) ·
**not-ready** (calibration incomplete) · **mechanism-only** (trigger/ledger
evidence, no cost claim). Metric definitions and validity strata:
`compaction-evaluation-validity-20261019.md` (canonical pairing =
costEligible; legacy alongside). Canonical reporter:
`node scripts/compaction-metrics.mjs [--bootstrap] <gateDir>`; tests 36/36.

## Delivered-phase gates (deepseek-v4-flash, pre-Oct-18)

| gate | cells | key numbers | status |
|---|---|---|---|
| p1gate3 (P1 v3, adaptive C vs stock A) | 64 | C/A paired median **1.0684** (16p; strict==legacy), boot90CI [0.8757, 1.1169] crosses 1; quality 124/124 every arm; calls median C 20/A 18, totals C 304/A 333 | **canonical** (point); CI honestly crosses 1 |
| p2gate2 (P2, adaptive T2 vs B) | 16 | C/B **0.9356** (8p), CI [0.8297, 1.0508] crosses 1; summary median C 0 vs B 8,433; quality 62/62 | **canonical** (point) |
| p3gate2 (P3 post-delivery R vs P2 B) | 4 | R/B **0.9675** (4p), CI [0.7667, 3.2548] crosses 1; quality 34/34 | **canonical** (point) |
| p15gate2 (cache-aware round 1) | 12 | "ON 15% cheaper" (433,093 vs 508,636; 9 vs 15 compactions) | **withdrawn** — threshold override made it a null test AND direction reversed on reproduction |
| p1gate v1/v2 (release-note & first rerun) | — | v1 release numbers (C/A 0.966, 209 compactions) mismatch raw; v2 pair medians 1.25–1.48 used a different pairing method | **withdrawn/superseded** by p1gate3 (see compaction-delivery-audit-20261018.md) |

## Next-round gates (deepseek-v4-flash, Oct 18–19)

| gate | conditions | cells | result | status |
|---|---|---|---|---|
| next-cache | 90k, **threshold=50 override** | 22 | paired ON/OFF 1.101 (11p) | **null test** (override shadowed 93/80 trigger); number not citable as cost |
| next-valid-cache | 50k, no override | 12 | 0/12 protocolValid (all blocked) | **null** (window too small); mechanism confirmed (93/80 only in ON) |
| next-e-90k | E @ 90k, no override, 3 arms | 9 | 5/9 valid; 0 double-valid pairs | **null**; mechanism confirmed (CACHE 93/80 only); CACHE valid cells zero-compaction |
| next-e-100k | E @ 100k | 12 | 8/12 valid; 1+1 pairs (1.0093 / 0.7359) | **insufficient** (n=1); STOCK invalidity = final_check artifacts |
| next-e-95k | E @ 95k | 15 (+1 disclosed rerun) | 8/15 valid; 1+1 pairs (1.3521 / 0.6982) | **insufficient** (n=1); failure mix context_blocking/final_check |
| next-pilot | E/F long-range pilot @ 90k | 3 (2 complete) | both arms 9/9; SFAITH summaryTok 0 | pilot observations only (n=1) |

## Same-trigger faithful arm (SFAITH = stock + BABEL_O_COMPACT_FAITHFUL_DIGEST)

Mechanism evidence across E @ 90/95/100k and kimi-95k: identical 90/70
trigger to STOCK (ledger-verified), summary LLM cost exactly **0** tokens in
every SFAITH cell, quality equal-or-better than STOCK in deepseek rounds.
Cost: **insufficient** everywhere (≤1 pair per gate). Implementation:
`feat(compaction)` commits 0887e94/6658875 (faithful digest; stock-mode
opt-in), tests 22/22, stock+flag-off byte-equivalence pinned by test.

## Kimi track (kimi-coding/k3; eval-only provider entry d35e702)

| gate | cells | result | status |
|---|---|---|---|
| kimi-e-95k | 15/15 valid, 0 blocked | legacy 5p (1.2119 / 0.9218) **withdrawn**; strict 1p CACHE/STOCK 0.7662 insufficient, 3p SFAITH/STOCK 1.3396 CI [0.8928, 1.5603] crosses 1 | **null**; quality non-comparable (CACHE 24/45 vs STOCK 39/45); kimi trajectories never exercise the 85.5–93k band (≈0 compactions) |
| kimi-g-cal (G-bank-ledger) | 4 | 9/10, 9/10, 9/10, **10/10**; peaks 54k–72k at 95k | **not-ready**: taskSuccess ok after fixes, band unreached (tool-result persistence caps read-driven accumulation) |
| kimi-g2-cal (G2-ledger-accumulation) | 2 (+2 allowed) | see `compaction-kimi-g2-calibration-20261019.md` | calibration |

Root-cause note (kimi-e-95k low taskSuccess): E3's `/tmp` copy step +
stateful shell drifted all later work out of the workspace (11–25 `cd /tmp`
and 3–18 `/tmp` writes in every failing cell) — a task trap, fixed in G/G2
designs (in-workspace `.scratch/`, never-cd-out rule).

## Tooling & governance (no paid units)

| item | state |
|---|---|
| `scripts/compaction-metrics.mjs` (+ tests 36/36) | canonical reporter; billed/calls/cacheReadRatio/paired; validity strata (protocolValid/taskSuccess/costEligible); failureClass diagnostics; eligible-aware bootstrap CI |
| async prefetch spike (`spike/async-prefetch` 6139c57 + 08e09e2) | module + 9/9 tests + feasibility doc; P2 identity-delete fixed and independently reviewed; **unmerged, unwired** by design |
| task suite E/F/G/G2 | hidden checks recompute ground truth from fixtures; reference implementations validated offline (10/10) with tamper negative controls |

## Canonical current conclusions

1. **Stock remains the default** (90/70 thresholds, prose summary, system
   boundary, no retrieval); every experiment flag stays opt-in.
2. Adaptive/T2/faithful arms match stock quality at similar-or-lower cost in
   the delivered gates (P2 C/B 0.9356), but all headline CIs cross 1 at these
   sample sizes — treat as "no measured regression", not savings.
3. **Cache-aware cost: undetermined** after five null/insufficient rounds
   (override null test; 50k blocking; 90k 0 pairs; 95k/100k n=1; kimi band
   unreached). Its 93/80 mechanism is confirmed wherever tested.
4. Faithful digest: mechanism solid (same trigger, zero summary tokens,
   quality intact); cost open.
5. Kimi-k3 cannot replicate deepseek compaction conclusions on the current
   task suite (quality + trajectory-length mismatch); G2 calibration is the
   active attempt to fix reachability.

## Explicitly not citable

- cache round-1 "ON 15% cheaper" (433,093 / 508,636; 9 vs 15 compactions)
- next-cache paired 1.101 (null-test conditions)
- kimi-e-95k legacy 5-pair medians (1.2119 / 0.9218)
- p1gate v1 release-note numbers and v2 pair medians (superseded)
- any single-pair ratio from the E rounds (n=1, degenerate CI)
