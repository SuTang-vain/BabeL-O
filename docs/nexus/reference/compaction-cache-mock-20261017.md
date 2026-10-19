# Cache-aware compaction: policy mock report (2026-10-17)

Status: policy-level mock, **not a live provider A/B**. Live cache A/B is
deferred because the DeepSeek balance and gate sample were already stretched;
this report validates the decision math and the mapping contract.

## What changed

- `mapOpenAIUsage` now maps DeepSeek `prompt_cache_hit_tokens` and OpenAI
  `prompt_tokens_details.cached_tokens` to `cacheReadInputTokens` on `usage`
  events. `summarizeCacheAwareUsage` and `buildCacheAwareCompactPolicy` already
  consumed that field; they previously saw zero on every row.
- The adaptive cost model already included the cache term:
  `gain = N·D·[(1−r) + r·p_cache/p_in]`,
  `cost = S + k·P + (1−r)·P`.
- `BABEL_O_COMPACT_BOUNDARY=tail` moves the boundary into a user message before
  the current instruction (default `system`; stock unchanged). Guards covered:
  ordering before the current instruction, duplicate suppression, tool-result
  arrays are never split, and the shared `assembleContext` path used by CLI
  `/compact` (integration test).

## Mock inputs

`P=40,000`, `D=8,000`, `S=2,000`, `k=0.5`, `N=5`, `p_cache/p_in=0.02`.

| cache ratio r | compact threshold | payback (tokens) | cost (tokens) | 1.25×cost | decision |
|---:|---:|---:|---:|---:|---|
| 0.0 | 90% | 40,000 | 62,000 | 77,500 | reject |
| 0.8 | 93% | 8,640 | 30,000 | 37,500 | reject |

- At r=0, the cache-adjusted break-even is `(S+kP+P)/(D) = 62k/8k ≈ 7.8`
  calls; at r=0.8 it is `(S+kP+0.2P)/(D·0.216) ≈ 30k/1.728k ≈ 17.4` calls.
  Cache reuse makes saved prompt tokens worth ~5× less, so the horizon needed
  to amortize a summary grows, not shrinks.
- `buildCacheAwareCompactPolicy` with r=0.8 and a 0.5 cacheable system-prompt
  ratio enters `cachePreservationMode` and raises the compact threshold from
  90% to 93%. Stock uses the same policy; the difference is that it can now see
  the cache signal.

## Verdict

- The mapping is correct and tested (`test/compaction-cache.test.ts`).
- The policy math is conservative: on a cached 1M-window model, proactive
  compaction is even less attractive than before; this supports the `NO_OP`
  default.
- **Policy mock vs live A/B**: the threshold/payback table above is a policy
  mock. A provider-level cache-aware A/B was later run (below); it verifies
  activation but is small (2 tasks × 3 reps).

## Live mapping check (audit follow-up)

After the adapter fix, run-cumulative DeepSeek cache-read ratios
(`Σ cacheRead / Σ max(input, cacheRead+cacheCreation)`) are about **0.68–0.85**
in P1.5 and **0.77–0.90** in P3; per-event ratios span roughly 0.06–0.99.
Examples: ON A-ledger r2 0.7801, ON B-todos r3 0.8515 (run-cumulative). The 0.5
activation threshold is crossed in many runs; the live A/B below verifies the
93/80 branch. The threshold/payback table above remains a policy mock.

## Metric definitions

- `billed` = input + output + summaryInput + summaryOutput tokens.
- `calls` = provider calls. Reports show the median per cell and the total
  separately; the two can move in opposite directions.
- `cacheReadRatio(event)` = `cacheRead / max(input, cacheRead + cacheCreation)`.
  OpenAI/DeepSeek `prompt_tokens` already include cached tokens, while
  Anthropic `input_tokens` excludes cache reads/creation. For a run, use the
  sum form: `Σ cacheRead / Σ max(input, cacheRead + cacheCreation)`.
  State clearly whether a quoted ratio is per-event or run-cumulative.
- Canonical reporter: `node scripts/compaction-metrics.mjs [gateDir ...]` reads
  `results/*.json` + `runs/*/db-*.sqlite` and prints these metrics as Markdown
  or JSON; tests: `node --test scripts/compaction-metrics.test.mjs`.

## Live cache-aware A/B (fixed ratio)

`computeCacheReadRatio` now uses `max(input, cacheRead+cacheCreation)` so
OpenAI/DeepSeek cached prompt tokens are not double-counted. OFF vs ON
(`BABEL_O_COMPACT_CACHE_AWARE=1`), 90k, stock threshold 50, T1 off, 2 tasks x
3 reps:

| arm | billed median | calls med | compactions | quality |
|---|---:|---:|---:|---|
| OFF (90/70) | 508,636 | 22.0 | 15 | 51/51 |
| ON (cache-aware 93/80) | 433,093 | 20.0 | 9 | 51/51 |

The ON decision logs contain `compactThresholdTokens=83,700` /
`warningThresholdTokens=72,000` when the live cache ratio is >=0.5 (some
decisions remain 81,000/62,999 when it is lower), so cache-preservation mode
actually activated. ON was **15% cheaper** with fewer compactions and equal
quality in this n=6 run; this claim is not reproduced by the round-2 null test
below and must not be used as a cost estimate.

> **Round-2 update (2026-10-18, NOT reproduced):** a 4-task × 3-rep × OFF/ON
> rerun under identical conditions (`.eval/next-cache/`, 22 cells) gives OFF
> billed median 478,075 / ON 503,840, compactions 21 vs 28, paired ON/OFF
> median **1.101** (n=11; bootstrap 90% CI 0.874–1.504, spans 1; pooled with
> round 1: ≈1.084, 17 pairs). The 15% cheaper result above does **not**
> reproduce. Activation still reproduces (ON ledgers show 93/80 in 34/55
> decisions; OFF stays 90/70). Critically, both rounds set
> `BABEL_O_AUTO_COMPACT_THRESHOLD_PERCENT=50`, whose env override fixes an
> identical 50% trigger in both arms, so 93/80 cannot reduce the compaction
> count under these conditions. **This is a null test for the cache-aware
> trigger, not evidence that 93/80 is worse.** Do not cite either direction
> as a cost result; a valid A/B must omit the override. Cache-aware remains
> opt-in and untested for default-switch cost. Full details:
> `compaction-next-round-20261018.md`.

Replay: OFF `D_estimate` 41,792 (n=15); ON 37,750 (n=9); `D_actual` negative
(turn-growth caveat). Raw: `.eval/p15gate2/results/`, `replay.json`,
`runs/{OFF,ON}/decisions-*.jsonl`.

The earlier 359k vs 493k run was a **null experiment**: the ratio double-count
kept both arms at 90/70. Do not use those numbers.
