# Kimi G2 calibration (2026-10-19): accumulation task — NOT ready (structural plateau)

Branch: `stage/p3`, local commits only, not pushed. Model: `kimi-coding/k3`
only. Paid cells: **2/4** (calibration cells g2-r1/g2-r2; the allowed
adjustment cycle was declined — decisive raw evidence makes two more cells of
this design family unjustifiable, see §3).

## 1. Task G2-ledger-accumulation

`.eval/tasks/G2-ledger-accumulation/{steps.json,check.mjs}` — 16 steps: six
monthly apply+close cycles with snapshots, each month followed by a mandated
full `journal.jsonl` Read plus a complete per-transfer reconciliation table
printed into the reply (the accumulation levers), reverse/audit/corruption
drill confined to in-workspace `.scratch/`, G1's never-cd-out rule.

Offline validation (hand-written reference): **10/10 pass**; tampered
workspace (balance bump + wrong snapshot content) fails 5/10 checks
(state/snapshots/conservation/idempotent/audit) — reference and negative
control evidence in place. Known task nit found by calibration: S2 does not
pin rejected.log's line format, and the check assumed raw CSV rows while both
agents wrote JSON objects — a future G2 v1.1 should pin "append the raw CSV
row" (or teach the check both formats). Harness semantics untouched; E/F/G
untouched.

## 2. Calibration cells (kimi-k3, STOCK @ 95k, no overrides)

Runner `.eval/kimi-g2-cal/run.sh` (same conditions as prior STOCK arms);
raw `.eval/kimi-g2-cal/{results,runs,logs}`.

| cell | billed | calls | comp | fail/blk | quality | peak est | peak per-call input |
|---|---:|---:|---:|---:|---:|---:|---:|
| g2-r1 | 1,839,692 | 103 | 0 | 0/0 | 7/10 | 44,557 (46.9%) | — |
| g2-r2 | 1,533,111 | 91 | 0 | 0/0 | 9/10 | 48,613 (51.2%) | **29,213** |

Failures: r1 — README.md missing, rejected.exact (JSON-line format), its own
test.mjs's reverse case; r2 — rejected.exact (same format nit). All ledgers
uniformly 66,500/85,500 (90/70), zero `shouldCompact`, zero compactions.

## 3. Why the band is unreachable for kimi here (decisive evidence)

The accumulation design worked as instructed — full journal reads and 400-line
reconciliation prints happened (e.g. r2 S6 out=6,970; per-step billed input up
to 126k) — yet the **estimate plateaued at 44–49k and the largest single
provider call carried just 29,213 tokens** (max over 91 usage events, r2).

Mechanism (read-only code evidence):
1. `toolResultBudget.ts`: tool results > 50,000 chars are persisted to
   `.babel-o/tool-results/` and replaced in context by a ~2,000-char preview;
   the in-context tool-result budget is ~200k chars total. The growing journal
   (88KB by month 6) is preview-replaced — reads cannot accumulate.
2. Old assistant prints also fall out of the assembled context: r2 printed
   ~7k tokens at S6 yet est *decreased* from 56.8k (S6) to 43.6k (S11).
3. kimi-k3's working style — small loops, compact prompts — keeps the
   assembled payload at ~14k median / 29k max per call regardless.

DeepSeek's E cells reached the 81–90k band on the same runtime, so this is a
model-behavior × assembly interaction, not a runtime defect. Conclusion: at
95k with stock assembly budgets, no task-side read/print forcing gets kimi
into the 85.5–93k trigger band. The two remaining allowed cells were not
spent: the binding constraint is structural, and the evidence above is
already decisive.

### Options for a future round (recorded, not executed)

- Accept that kimi's band is unreachable at 95k and evaluate kimi only where
  its natural peak lives (e.g. 40–60k ceilings) — with the explicit
  small-window caveat and 50k-era blocking risk.
- Or study the plateau directly: per-call payload vs assembly budget under
  forced accumulation (a runtime-instrumentation question, not an eval one).

## 4. Confirmations

- Stock defaults unchanged; no CACHE/SFAITH arms started; no other models.
- 2/4 budget used; no push. Ledger/format/tests green where applicable.
- See `compaction-experiments-index-20261019.md` for the cross-round ledger.
