# Kimi task calibration (2026-10-19): eligible-aware bootstrap + G-bank-ledger design & calibration

Branch: `stage/p3`, local commits only, not pushed. Model: `kimi-coding/k3`
only (zero DeepSeek/other). Paid cells: **4/4** (cap 4). Subagents: none this
round (all work local).

## A. Eligible-aware bootstrap (0 paid) — landed

`compaction-metrics.mjs --bootstrap [--resamples N] [--seed N]` (commit
`72cda2d`): percentile 90% CI over **canonical costEligible** paired ratios
only (mulberry32 seeded, reproducible; default 10,000 resamples,
seed 20261019); <3 eligible pairs → `insufficient` (CI computed but not
citable); legacy counts alongside. Tests 36/36
(`node --test scripts/compaction-metrics.test.mjs`).

Strict CI recompute (full table in
`compaction-evaluation-validity-20261019.md`, updated): P1/P2/P3 points
unchanged byte-identically (CIs now honestly reported: all cross 1 — first
honest CI for those headlines, presented as confidence limits, not
reversals); E rounds insufficient (0–1 pairs); kimi CACHE/STOCK insufficient
(1 pair, 0.7662); kimi SFAITH/STOCK 3 pairs 1.3396, CI [0.8928, 1.5603],
crosses 1 → null.

## B1. Why kimi-e-95k taskSuccess was low — root cause is a task trap, not "model is bad"

Evidence (per-cell sqlite `tool_traces` + workspaces + step logs):

- All 6 examined failing cells show the same pattern: **11–25 `cd /tmp`
  commands AND 3–18 file writes under `/tmp/`**. E3's prompt invites a
  throwaway /tmp copy for the dry-run exercise; the stateful shell keeps the
  agent in /tmp for every later step, so tools/verify.mjs, fixtures, test.mjs
  etc. land in /tmp while the hidden checks grade the workspace (stuck at E2
  state: journal 2 entries, config v3).
- The agent otherwise worked correctly: 10/10 step prompts were delivered and
  answered (step logs), journal invariants intact as far as it went.
- Actionable conclusion: long-horizon tasks for ANY model must not invite
  `cd` out of the workspace; throwaway work belongs in an in-workspace
  `.scratch/` with mandatory cleanup. (DeepSeek survived the same trap —
  a robustness difference, not a task-success metric.)

## B2. Task G-bank-ledger (design + offline validation)

`.eval/tasks/G-bank-ledger/{steps.json,check.mjs}` (10 steps, 10 checks):
bank ledger CLI — deterministic fixture generator (seed 42: 60 accounts,
2,400 transfers, 24 guaranteed 50M overdraws), append-only `journal.jsonl`,
overdraw→`rejected.log`, idempotent apply (journal+rejected id sets),
replay-auditor, reversal, corruption drill confined to in-workspace
`.scratch/` (G1 states the never-`cd`-out rule). Hidden checks recompute
ground truth from fixtures (no hardcoded numbers) and cover: exact balances
(incl. TXN-0001 reversal), journal uniqueness/count, exact rejection set
(24 + TXN-9999 probe), conservation, idempotent re-apply, audit tamper/
truncation detection, reversal exactness, report counts, tests exit 0.

Offline validation (hand-written reference): **10/10 pass**; tampered
workspace fails 7/10 checks. Two contradictions found and fixed during
calibration: (1) G4's probe legitimately adds TXN-9999 to the real
rejected.log (both r1/r2 failed exactly this) — check now expects
24+1; (2) idempotency must track rejected ids too, or re-apply grows
rejected.log — prompt now states journal-OR-rejected skipping.

## B3. Calibration cells (4/4 budget used) — verdict: **NOT ready**

Conditions: kimi-coding/k3, STOCK, 95k, no threshold/forced overrides
(runner: `.eval/kimi-g-cal/run.sh`; raw: `.eval/kimi-g-cal/{results,runs,logs}`).

| cell | billed | calls | comp | fail/blk | quality | peak est |
|---|---:|---:|---:|---:|---|---:|
| gcal-r1 | 502,100 | 28 | 0 | 0/0 | 9/10 | 55,629 (59%) |
| gcal-r2 | 503,915 | 27 | 0 | 0/0 | 9/10 | 54,412 (57%) |
| gcal-r3 | 1,108,020 | 70 | 0 | 0/0 | 9/10 | 72,403 (76%) |
| gcal-r4 | 1,085,410 | 73 | 0 | 0/0 | **10/10** | 38,342 (40%) |

- r1/r2: single failure = the G4 probe/rejected.log contradiction (fixed
  after r2). r3: single failure = `.scratch/` not deleted (cleanup miss).
  r4: full pass. G is **kimi-completable** (10/10 achieved; 19/20 in the
  final pair).
- Trigger band (85,500–93,000 at 95k): **not reached** — peaks 38k–72k,
  zero compactions, all ledgers 66,500/85,500 (90/70, no cache flag, correct
  for STOCK). Structural cause: tool output truncation caps single-read
  context growth (r3 read the 90KB journal — 263k input that step — yet est
  peaked at 72k); kimi's lean trajectories accumulate too little per step.

Per protocol: taskSuccess 2/2 not met (19/20) and band not met → **stop; no
three-arm run; no further cells** (4/4 budget exhausted).

### Adjustment suggestions (for a future round, not executed)

1. Band reach at 95k needs *accumulation*, not bigger single reads: a 15–20
   step task with mandatory full re-reads of the *growing* journal every few
   steps (monotonic growth, no compaction) — est grows ~10–20k per re-read
   even with truncation. Alternatively accept a lower ceiling (e.g. 60k:
   90%=54k) with the explicit "small window" caveat and the blocking risk
   seen at 50k.
2. Move the `.scratch/` cleanup into G10's verification list ("confirm
   .scratch/ is gone") to remove the r3-class miss.
3. Keep the recompute-from-fixtures check style — it caught both
   contradictions without any hardcoded-number fragility.

## C. Confirmations & unfinished

- Stock defaults unchanged (STOCK runners unset all experiment flags; no
  runtime code touched this round beyond the earlier approved registry entry).
- 0 DeepSeek/other-model runs; 4/4 Kimi cells; no three-arm started; no push.
- Commits: `72cda2d` (bootstrap) + this document.
- Unfinished: G ready-checklist for a future round (suggestions above);
  harness validity-rule proposal (procedural vs contextual) still unlanded;
  async prefetch spike unmerged (`08e09e2`).
