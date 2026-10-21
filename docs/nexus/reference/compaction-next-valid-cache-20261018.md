# Compaction next round 2 (2026-10-19): valid cache A/B (null), same-trigger faithful A/B, async-prefetch spike

Branch: `feat/compaction-next` (worktree `../babelo-next`), local commits only, not pushed.
Model: `deepseek/deepseek-v4-flash` only. Stock defaults unchanged (see §5).
Prior round: `compaction-next-round-20261018.md` (round-2 cache was a null
test because `BABEL_O_AUTO_COMPACT_THRESHOLD_PERCENT=50` shadowed the 93/80
trigger; this round removes the override).

## Budget (hard cap 30 paid units; 120 min)

| bucket | consumed | note |
|---|---:|---|
| A valid cache A/B (`.eval/next-valid-cache`) | **13** | 12 completed cells + 1 infrastructure casualty (OFF B-todos vc-r2 first attempt froze during a machine suspend: 379 min wall, 3 blocked turns; kept as evidence, cell re-run once per protocol) |
| B same-trigger faithful (`.eval/next-faithful-stock`) | **4** | minimal 4 cells (2 tasks × 1 rep × 2 arms) |
| C long-range E reps | 0 | **dropped** (operator: closing only) |
| D async prefetch spike | 0 | subagent + local tests only |
| **total** | **17/30** | closing phase added exactly 6 (2 cache + 4 faithful) |

## A. Valid cache-aware A/B (`.eval/next-valid-cache/`) — cost verdict: **null** (all cells invalid); mechanism verdict: trigger differentiation confirmed

Conditions: `BABEL_O_MAX_CONTEXT_TOKENS=50000` (deliberately small so 90%
(45,000) vs 93% (46,500) triggers differ observably; **not a default-window
claim**), `BABEL_O_AUTO_COMPACT_THRESHOLD_PERCENT` **unset**, `BABEL_O_COMPACT_MODE=stock`,
T1 off. OFF: no flag. ON: `BABEL_O_COMPACT_CACHE_AWARE=1`. 2 tasks × 3 reps ×
OFF/ON = 12 cells, interleaved per cell. Free preflight replicated the ledger
path before any paid run (OFF 35000/45000 trigger 90, ON 40000/46500 trigger 93).

**All 12 cells are invalid** (`failedTurns` 1–5, `blockedTurns` 1–5 per
cell): at a 50k ceiling these tasks hit `CONTEXT_LIMIT_EXCEEDED` repeatedly
(reactive compaction cannot recover fast enough), the harness aborts each
cell early, quality lands at 42/51 per arm (equal). Failed cells are kept as
evidence and were not re-run (protocol; one exception: the suspend-frozen
casualty, re-run once).

Cost comparison: **null by construction** — 0/6 valid cells per arm, so no
billed medians, no paired ratios, no CI (`compaction-metrics.mjs` reports
`0/6 valid`; `paired_bootstrap.py` reports no pairs). We do not compute
"cost over aborted runs" as a substitute.

**Trigger/ledger verification (the round's actual question) — confirmed:**

| ledger (warn/compact) | OFF (47 entries) | ON (44 entries) |
|---|---:|---:|
| 35,000/45,000 (70/90) | 36 | 15 |
| 40,000/46,500 (80/93) | **0** | **21** |
| 35,000/40,000 (70/80, post-context-error clamp) | 11 | 8 |

- The 93/80 cache-preservation tier appears **only in ON** (21/44 entries) —
  the flag's mechanism activates exactly where expected, and never in OFF.
- The 80% entries are the documented `providerContextError` clamp
  (`min(base, 80)`) after blocking — present in both arms.
- Decision reasons: OFF 12 stock-threshold + 17 provider-loop-blocking; ON
  10 stock-threshold + 14 provider-loop-blocking. Compaction counts per cell:
  OFF 2–9 (total 29), ON 1–5 (total 24) over aborted trajectories — reported
  as raw counts only, not a comparison.
- Conclusion for the feature: cache-aware's threshold mechanism works at the
  trigger level, but 50k is too small a window for these tasks to complete,
  so this round yields **no cost evidence in either direction**. The round-1
  "ON 15% cheaper" remains unreplicated; cache-aware stays opt-in, not a
  default candidate.

Commands: `.eval/next-valid-cache/run.sh <OFF|ON> --task <t> --rep vc-rN --fresh`;
analysis `node scripts/compaction-metrics.mjs --pair "ON/OFF" .eval/next-valid-cache`,
`python3 .eval/paired_bootstrap.py .eval/next-valid-cache ON OFF` (10k-resample
percentile bootstrap, seed fixed). Raw: `.eval/next-valid-cache/{results,runs,logs}`.

## B. Same-trigger faithful A/B (`.eval/next-faithful-stock/`) — pilot, n=1/task/arm

New opt-in (commit `6658875`, this branch): `BABEL_O_COMPACT_FAITHFUL_DIGEST=1`
now replaces the prose summary **in stock mode** (flag alone gates the branch;
boundary keeps `mode: 'stock'` so the trigger policy is identical — this is
the same-trigger comparison the previous round lacked). Stock without the
flag is byte-identical (regression test: `stock + flag OFF` guard in
`test/compaction-faithful.test.ts`, 22/22 pass; related suites 38/38; tsc clean).

Conditions: 50k, no threshold override, stock mode both arms, T1 off; SFAITH
adds the flag. PROSE arm ran from the same worktree with the flag off
(equivalence guarded by the regression test). Minimal 4 cells:

| cell | billed | calls | compactions | summaryTok | failed | blocked | quality |
|---|---:|---:|---:|---:|---:|---:|---|
| PROSE A-ledger sf-r1 | 280,780 | 14 | 5 | 24,784 | 3 | 3 | 8/9 |
| SFAITH A-ledger sf-r1 | 238,622 | 14 | 3 | **0** | 2 | 2 | 9/9 |
| PROSE B-todos sf-r1 | 265,863 | 16 | 4 | 9,888 | 2 | 2 | 6/8 |
| SFAITH B-todos sf-r1 | 568,066 | 31 | 5 | **0** | 3 | 3 | 8/8 |

Live mechanism evidence: all 8 SFAITH boundaries carry `version: 2` faithful
digests with `## Faithful Compaction Digest` renders (sqlite `events`,
`runs/SFAITH/db-*.sqlite`); summarization LLM cost is exactly 0 tokens.

Observations (n=1 per cell — **no directional claims**): A-ledger SFAITH was
cheaper with better quality; B-todos SFAITH was ~2.1× more expensive with
better quality. Quality was equal-or-better under faithful in both tasks.
Blocking occurred in all 4 cells (50k window again too small; see §A).

Raw: `.eval/next-faithful-stock/{results,runs,logs}`; runners
`run-prose.sh` / `run-faith.sh`.

## C. Long-range E reps — not run (operator decision, budget preserved)

Existing evidence remains the 2 completed cells from the previous round
(STOCK/FAITHFUL E np-r1) plus one interrupted partial. n=1/arm; no new claims.

## D. Async summary-prefetch spike — delivered, verified, not wired

Subagent (`worker`) in isolated worktree `../babelo-async-spike`, branch
`spike/async-prefetch`, commit `6139c57` (local, not pushed; **not** merged
into feat/compaction-next and not wired into any runtime path):
`src/runtime/compactionPrefetch.ts` (content-keyed prefetch cache:
sha256 key over canonical event JSON, injectable `summarize`, LRU(4),
deadline-bounded `awaitSummary` with `hit`/`miss`/`stale`/`fallback`
statuses, structural stale-summary guard), `test/compaction-prefetch.test.ts`
(8/8 pass, locally re-verified), `docs/nexus/reference/compaction-async-prefetch-spike-20261019.md`.
Key findings: stale predictions can waste one LLM call but can never corrupt
a compaction (summaries are only served under the awaited events' own key);
wiring blockers are `selectCompactionWindow` being private to `compact.ts`
and the absence of a summary-latency budget. Recommendation (endorsed here):
viable as a future stock-mode latency optimization; low value under faithful
mode (digest is LLM-free). One dispatch mishap recorded: the first attempt
was mistakenly sent to the read-only `verifier` agent, which correctly
declined to write; re-dispatched to `worker`.

## E. Confirmations & unfinished

- Stock defaults unchanged: no edits to `compactionMode.ts` defaults, 90/70
  thresholds, prose summary path, system boundary, retrieval gating; the
  faithful branch is gated on the flag alone and stock+flag-off has a
  dedicated byte-equivalence regression test.
- Nothing pushed. Commits this round on `feat/compaction-next`:
  `6658875` (stock-mode faithful opt-in + tests), this report (docs commit).
  Spike lives separately on `spike/async-prefetch` (`6139c57`).
- Main checkout `babelo-eval`: no modified tracked files; only gitignored
  `.eval/` experiment data.
- Unfinished: (1) cache-aware cost question still open — needs a window where
  tasks complete (e.g. 90k) AND no threshold override (this round shows 50k
  completes nothing; the previous 90k round overrode the trigger); (2) B at
  n=1 — needs ≥3 reps at a workable ceiling; (3) C dropped; (4) spike not
  merged (by design); (5) `selectCompactionWindow` export + summary-latency
  budget are the spike's wiring prerequisites if ever pursued.
