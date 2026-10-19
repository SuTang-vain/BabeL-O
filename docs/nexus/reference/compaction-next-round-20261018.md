# Compaction next round (2026-10-18): cache reproduction, faithful digest, long-range pilot

Scope: follow-up to `compaction-p0-p3-final-recommendation-20261017.md`.
Branch: `feat/compaction-next` (worktree `../babelo-next`), local commits only, **not pushed**.
Model: `deepseek/deepseek-v4-flash` only. Stock defaults (90/70, prose summary,
system boundary, no retrieval) are **unchanged** — see §5.

## Budget ledger (hard cap 36 paid units: 24 cache + 12 pilot)

| bucket | planned | consumed | note |
|---|---:|---:|---|
| cache reproduction (`.eval/next-cache`) | 24 | **23** | 22 complete cells + 1 killed partial duplicate (11 paid usage events) — launcher error, disclosed; cell (D-rules, nc-r3) dropped from BOTH arms to stay under the sub-cap |
| long-range pilot (`.eval/next-pilot`) | 12 | **3** | 1 complete STOCK cell + 1 interrupted STOCK F partial (29 paid usage events, run aborted by operator interrupt) + 1 complete FAITHFUL cell; pilot deliberately NOT resumed |
| **total** | 36 | **26** | 10 units unused |

## A. Cache-aware reproduction (`.eval/next-cache/`) — **NOT reproduced**

Conditions identical to round 1 (`.eval/p15gate2`): 90k ceiling, `BABEL_O_COMPACT_MODE=stock`,
`BABEL_O_AUTO_COMPACT_THRESHOLD_PERCENT=50`, T1 off; ON adds `BABEL_O_COMPACT_CACHE_AWARE=1`.
4 tasks (A-ledger, B-todos, C-logstats, D-rules) × 3 reps × OFF/ON = 22 cells (11/arm;
D-rules nc-r3 dropped, see budget note). All 22 cells valid (`failedTurns=0`).

Commands: `.eval/next-cache/run.sh <OFF|ON> --task <t> --rep nc-rN --fresh`;
driver `.eval/next-cache/run-remaining.sh`; analysis
`node scripts/compaction-metrics.mjs --pair ON/OFF .eval/next-cache`.

| metric | OFF (11) | ON (11) | round 1 OFF (6) | round 1 ON (6) |
|---|---:|---:|---:|---:|
| billed median | **478,075** | **503,840** | 508,636 | 433,093 |
| calls median / total | 20 / 225 | 21 / 238 | 22 / 132 | 20 / 128 |
| compactions | **21** | **28** | 15 | 9 |
| summary median | 8,033 | 15,478 | — | — |
| quality | 86/86 | 86/86 | 51/51 | 51/51 |

Paired ON/OFF billed ratio (median of per-cell ratios, cells matched on
task+rep): **1.1011** (n=11; range 0.760–1.743; arm-median ratio 1.0539; mean
paired 1.1606). Round 1 was 0.8840 (n=6). Pooled 17 pairs: median ≈ **1.084**.

**Verdict: the round-1 cost claim ("ON ≈15% cheaper, 9 vs 15 compactions")
does not reproduce; round 2's paired median is 1.101 (n=11; bootstrap 90% CI
[0.874, 1.504], which spans 1), so there is no statistically distinguishable
cost difference in this sample.** The activation mechanism DOES reproduce: ON
decision ledgers show `compactThresholdTokens=83,700 /
warningThresholdTokens=72,000` (93/80) in 34/55 entries (never in OFF; OFF
57/57 at 90/70 — command:
`grep compactThresholdTokens .eval/next-cache/runs/*/decisions-*.jsonl`).

Mechanistic note (why this is a **null test**, not evidence against
cache-aware): with `BABEL_O_AUTO_COMPACT_THRESHOLD_PERCENT=50` set,
`getAutoCompactDecision` reads the env override BEFORE the policy value, so
the compaction *trigger* (50%) is identical in both arms;
cache-preservation 93/80 changes only the window-state/blocking limits, not
the trigger. Therefore neither round measured whether the 93/80 trigger
reduces compactions. Do not cite either round's cost delta as evidence for or
against the policy; a valid test must omit the threshold override (or use a
ceiling/task set where 90% and 93% actually differ). Round 1's 15% claim is
withdrawn; round 2's 1.101 is not a reversal claim.

cacheReadRatio (`cacheRead / max(input, cacheRead+creation)`; run-cumulative
Σ/Σ): OFF runs 0.7564–0.8233, ON runs 0.7357–0.8539; gate-wide per-event
n=474, min 0.0608, median 0.9812, max 0.9958. Consistent with the documented
bands (round-1: run-cumulative 0.68–0.85; per-event ~0.06–0.99).

Confidence limits: 22 cells, 4 tasks, single model, saturated quality. The
paired-ratio CI above is a 20k-resample bootstrap of the median (seed 7); no
CI is computed for the other metrics (median spread across pairs is 0.76–1.74).

## B. Faithful digest prototype (`feat/compaction-next`, commit `0887e94`)

New opt-in: `BABEL_O_COMPACT_FAITHFUL_DIGEST=1`, active only together with
`BABEL_O_COMPACT_MODE=adaptive` (stock mode provably inert — regression test
included). Files: `src/runtime/compactionFaithfulDigest.ts` (new),
`src/runtime/compact.ts` (adaptive branch wiring only),
`test/compaction-faithful.test.ts` (19 tests). Also on this branch:
`scripts/compaction-metrics.mjs` `--pair` shorthand fix (`ON/OFF` =
`ON/OFF=ON/OFF`), no behavior change.

Contract (per the original requirement + independent design review):

1. **Extractive only** — every value is a verbatim slice of source events or
   structured fields; byte-faithful truncation (no whitespace folding);
   truncation is explicitly marked (`…[truncated N chars]`).
2. **Immutable anchors** — most recent user instruction verbatim (emitted in
   full even past the render budget); paths, git SHAs (40-hex anywhere; short
   SHAs only from git-command output), test commands with pass/fail outcome,
   scope/permission constraints, failure excerpts. Per-section caps evict
   oldest-first and now record an explicit `overflow` counter (rendered).
3. **No recursive compaction** — a new digest is built only from raw omitted
   events; a previous faithful digest is carried verbatim (`version: 2` in the
   boundary `digest` field; T2's `normalizeCompactionDigest` ignores it and
   vice versa). A pre-faithful prose summary enters the chain exactly once as
   a verbatim `carriedProse` block (fixes a P1 found in review: mixed
   prose→faithful→faithful histories previously dropped the prose-era summary
   at the third boundary; regression test included).
4. **Opt-in, stock unchanged** — flag is never evaluated in stock mode
   (branch sits inside `mode === 'adaptive'`); with the flag off, adaptive
   falls through to the pre-existing retrieval/T2 paths byte-identically.

Tests: `test/compaction-faithful.test.ts` 19/19 pass
(`NODE_ENV=test BABEL_O_CONFIG_FILE=/tmp/... npx tsx --test test/compaction-faithful.test.ts`);
related suites (`compaction-digest`, `compaction-p2`, `compact`,
`compaction-cache`, `compaction-mode`) 38/38 pass; `npx tsc --noEmit` clean.

**Async/parallel compaction: not implemented (deliberately).** The faithful
digest is synchronous and LLM-free, so async matters only for the prose/LLM
summary path. Feasibility sketch (bounded): run `llmSummarizeEvents` for the
*next predicted* compaction as a detached task after each turn, keyed by a
hash of omittedEvents (same keying as `summaryCache.ts`); on trigger, await
the in-flight promise with a deadline = the existing reactive-compact budget,
falling back to synchronous summarization on miss/timeout. Risk to the main
runtime is the abort/ordering surface (a summary computed for a stale event
set must never be installed); with the hash gate the failure mode is
fall-back-only. Not landed to avoid destabilizing the runtime in this round.

Live pilot evidence (§C): 8/8 boundaries carried `version: 2` faithful
digests, carried chains formed on repeat compactions, summarization LLM cost
= **0 tokens** (vs 69,109 summary tokens in the STOCK cell).

## C. Long-range pilot (`.eval/next-pilot/`) — pilot only, no benchmark claims

Two NEW tasks (not the 5-step suite), checklists validated offline against
hand-built reference solutions before any paid run (E 9/9 pass, tampered
workspace correctly fails 2 checks; F 8/8 pass):

- `E-stateful-migrator` (10 steps): versioned config migrations, append-only
  journal with full snapshots, dry-run no-write, corruption refusal,
  rollback→re-forward recovery, idempotent re-run. Hidden checks probe
  cross-step state survival (early keys, renamed values, journal invariants).
- `F-log-pipeline` (9 steps): tolerant log parser (malformed→null, never a
  default level), cumulative path-keyed idempotent stats, independent
  auditor, corrupted fixtures.

Only 2 complete cells were run (operator stopped the 12-cell plan):

| cell | billed | calls | compactions | summaryTok | failedTurns | blockedTurns | quality | wall |
|---|---:|---:|---:|---:|---:|---:|---|---|
| STOCK E np-r1 | 2,538,411 | 92 | 6 | 69,109 | 4 | **3** | 9/9 | 8.3 min |
| FAITHFUL E np-r1 | 2,029,602 | 74 | 8 | **0** | 2 | 0 | 9/9 | 6.7 min |

Observations (n=1 per arm — trajectory noise dominates; NO conclusion):

- Both arms completed the 10-step task at full quality.
- FAITHFUL was ~20% cheaper in billed tokens with zero summarization cost and
  no blocked turns — single-cell observation only.
- STOCK hit `CONTEXT_LIMIT_EXCEEDED` blocking 3 times at the 90k ceiling and
  recovered — a live reproduction of the residual blocking risk noted in the
  final recommendation ("one stock cell hit context blocking at 90k despite
  compaction").
- The interrupted STOCK F np-r1 partial (29 usage events, no result JSON) is
  kept under `.eval/next-pilot/runs/STOCK/` as evidence; not counted in any
  metric.

Failure modes seen: context blocking with recovery (STOCK), turn errors with
recovery (both). No silent task failure.

## D. Subagents used

| subagent | task | outcome | adopted? |
|---|---|---|---|
| reviewer (task design) | audit E/F steps+checklists for completability, hidden-check fairness, determinism | found 1 major (F `eq()` key-order fragility) + minors (F idempotency-keying ambiguity, F7 premise wording, E3 contradictory dry-run sequencing) | **adopted** — all fixed before the pilot; checklists re-validated offline |
| reviewer (digest design) | audit faithful digest vs its 4-point contract | OK on contract 3/4; P1 mixed-history prose loss + P2s (whitespace folding, dead short-SHA pattern, silent cap eviction, unbounded carry render) | **adopted** — all fixed (`carriedProse`, byte-verbatim truncation, git-gated short SHAs, overflow counters, budget-streamed carry render) + 6 new tests |
| verifier (cache recompute) | independent recomputation of `.eval/next-cache` | first run timed out (300s); resumed with a time-box → **PASS**: own-code recompute matches `compaction-metrics.mjs` on 30+ fields (arm metrics, paired 1.101086, all 22 per-run cacheReadRatios, ledger thresholds); sha256 of all 88 data files stable across the session | **adopted** as the independent check; its caveats recorded in §E |

## E. Raw paths & commands

Verifier-noted caveat: `runs/OFF/db-A-ledger-nc-r1.sqlite` holds two sessions
(the complete cell AND the README-disclosed killed partial, 11 usage events),
so that one DB's run-cumulative ratio (0.7662) pools both; per-session split:
complete 0.7273, partial 0.8357. All other DBs hold exactly one session. The
verifier did not cross-check result-JSON totals against sqlite usage sums
(cell↔DB consistency unchecked) — accepted residual risk, totals taken as
recorded.

- Cache reproduction: `.eval/next-cache/{results,runs,logs}` (main checkout);
  driver logs `logs/remaining.log`; conditions `run.sh`; preregistration note
  `README.md` (incl. the dropped-cell budget disclosure).
- Pilot: `.eval/next-pilot/{results,runs,logs}`; task definitions
  `.eval/tasks/{E-stateful-migrator,F-log-pipeline}/`; reference-validation
  transcripts were run under /tmp (ref-e, ref-f) with
  `node .eval/tasks/<task>/check.mjs`.
- Analysis: `node scripts/compaction-metrics.mjs --pair ON/OFF .eval/next-cache`
  (worktree build for the shorthand; committed build accepts
  `--pair "ON/OFF=ON/OFF"`).
- Ledger thresholds: `python3` tally of `runs/*/decisions-*.jsonl`
  (OFF 57× 62999/81000; ON 21× 62999/81000 + 34× 72000/83700).

## F. Mismatches vs existing docs

1. **`compaction-cache-mock-20261017.md` / final-recommendation "live A/B"**:
   round-1 "ON 433,093 vs OFF 508,636; 9 vs 15 compactions; ON 15% cheaper" is
   not reproduced. Round 2 gives paired median 1.101 (CI spans 1) and 28 vs
   21 compactions, but both rounds set the 50% threshold override, so the
   93/80 trigger was shadowed. Docs updated on this branch to call this a
   null test; cache-aware remains opt-in and untested for default-switch cost.
2. **cache-mock doc example labels** ("B A-ledger r2 0.78, C B-todos r2 0.85")
   were corrected to ON/A-ledger-p15-r2 0.7801 and ON/B-todos-p15-r3 0.8515
   in the main docs; the worktree copy may still carry the old line.

## G. Unfinished / next steps

- Long-range pilot aborted at 2 complete cells by operator decision; E/F arms
  STOCK-vs-FAITHFUL need >=3 reps before any directional statement.
- The FAITHFUL arm ran adaptive+forced-50 (trigger parity with stock-50);
  a same-trigger-policy comparison (stock-50 vs stock-50-with-faithful-summary)
  would isolate summary-fidelity effects from trigger-policy effects — needs a
  small wiring change (faithful summary under stock mode) left unimplemented.
- Carry-chain storage growth across very long sessions (one nesting level per
  compaction) is bounded in render but not in storage; cap or checkpoint if
  faithful mode ever leaves prototype.
- CI methodology for paired ratios remains undocumented (pre-existing).

## Confirmations

- Stock defaults unchanged: no edit to `compactionMode.ts` defaults,
  thresholds (90/70), prose summary path, system boundary, or retrieval gating;
  stock-mode inertness covered by a dedicated regression test.
- Nothing pushed; all commits are local to `feat/compaction-next`
  (worktree `../babelo-next`). Main checkout `babelo-eval` has no modified
  tracked files (only untracked `.eval/next-cache/`, `.eval/next-pilot/`,
  `.eval/tasks/{E,F}*/`, which are gitignored).
- Paid units: 26/36 consumed; closing phase added exactly 1 (FAITHFUL E np-r1).
