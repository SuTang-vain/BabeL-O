# P3 retrieval prototype: pointers + on-demand tools (2026-10-17)

Status: prototype evaluated; **not recommended as a default**. One branch/PR
contains the P1–P3 stack; the retrieval mode is behind two opt-in flags.

## Prototype

- `BABEL_O_COMPACT_RETRIEVAL=1` + `BABEL_O_COMPACT_MODE=adaptive`: compaction
  writes a **Retrieval Index (pointers only)** instead of a prose summary or a
  structured digest: user turns, file reads/writes, and failures with
  timestamps and `contextSearch` hints.
- The model uses the existing `contextSearch` / `contextRecent` tools to fetch
  exact evidence. Events remain in storage; nothing is deleted.
- Stock default is unchanged (`system` boundary, prose summary, no retrieval).

## Live A/B

2 tasks (A-ledger, B-todos) × 3 reps; ceiling 90k; forced compaction at 50%;
T1 off; same model. B and C results are reused from the P2 digest A/B.

| arm | billed median | summary median | calls med | contextSearch | compactions | quality |
|---|---:|---:|---:|---:|---:|---|
| B prose | 462,790 | 8,524 | 21.0 | 0 | 12 | 51/51 |
| C digest | 366,045 | 0 | 18.5 | 0 | 7 | 51/51 |
| R retrieval | 511,552 | 0 | 24.5 | 5 | 10 | **50/51** |

- R/B billed ratio median **1.238**; R/C **1.195**. R is the most expensive arm.
- R calls 24.5 vs 21 (B) / 18.5 (C); the model made 5 `contextSearch` calls.
- One outlier: `B-todos p2-r3` used **1,981,338** tokens and **83 calls**, and
  failed `cli.list_filters` (returned a done item from `--open`). Pointer-only
  context did not preserve the CLI filter contract; the model re-derived it
  incorrectly. The other five cells passed.

## Interpretation

- Retrieval does **not** reduce total tokens at this scale: it moves cost from
  the summary (8.5k) to repeated tool calls and provider loops, and one cell
  flailed badly.
- Pointer-only compaction loses cross-step contracts (function names, CLI
  behavior); the digest's contract records are doing real work.
- The right architecture is **hybrid**: keep the deterministic digest for
  contracts/open tasks/facts, and use retrieval pointers only for raw evidence
  (tool outputs, logs) with a search budget. Replacing the digest entirely is
  not supported by this data.

## Migration risks

- `contextSearch` loads up to 50k events per call; long sessions can be slow.
- Retrieval miss / wrong query leaves the model without the contract; quality
  risk is asymmetric.
- Storage retention is required; deleting events would break pointers.
- Tool-call latency and loop budget increase; the P1 churn guard does not cover
  retrieval calls.
- Evaluation contamination: both arms share the same tasks; a harder task set
  may change the balance.

## Recommendation

Keep `BABEL_O_COMPACT_RETRIEVAL` as an experimental flag. Do not default it.
The default proposal (P3/docs task) is **no change to stock**; adaptive digest
remains opt-in. A future hybrid (digest + retrieval pointers) needs a 4×6
same-ceiling gate before any default change.

Raw: `.eval/p3gate/results/`, `.eval/p3gate/aggregate.json`; B/C from
`.eval/p2gate/results/`.

## Replay evidence

10 R boundaries: `D_estimate` median **36,463**, `D_actual` median **−864**
(same turn-growth caveat as P1/P2). Raw: `.eval/p3gate/replay.json`.
