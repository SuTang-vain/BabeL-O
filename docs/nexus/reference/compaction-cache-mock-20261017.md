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
- **Not proven live**: no provider-level cache-hit A/B was run. Do not cite
  the 90→93% threshold or the 17.4-call break-even as measured production
  behavior; they are policy-mock outputs.

## Live mapping check (audit follow-up)

After the adapter fix, P2/P3 runs record DeepSeek cache-read ratios of
**0.70–0.87** in `usage` events (examples: B A-ledger r2 0.78, C B-todos r2
0.85, R B-todos r3 0.875). The cache-aware policy now sees real hits. The
threshold/payback table above remains a policy mock; no cache-on/off A/B was
run.

## Live cache-aware A/B (audit follow-up)

OFF vs ON (`BABEL_O_COMPACT_CACHE_AWARE=1`), 90k, stock threshold 50, T1 off,
2 tasks x 2 reps, same model:

| arm | billed median | calls med | compactions | quality |
|---|---:|---:|---:|---|
| OFF (stock 90/70) | 359,349 | 17.0 | 4 | 34/34 |
| ON (cache-aware 93/80) | 493,523 | 23.5 | 7 | 34/34 |

The cache-aware policy was **worse** in this live run (+37% billed, +38% calls,
more compactions), with equal quality. Cache mapping is live (ratios 0.70–0.87),
but the policy is not beneficial here. Stock remains 90/70; the flag stays
opt-in and is not recommended.

## Replay

OFF: 4 boundaries, `D_estimate` median **35,602**, `D_actual` median −1,267.
ON: 7 boundaries, `D_estimate` median **38,206**, `D_actual` median −224.
`D_actual` is the last-call-before vs first-call-after and is negative because
the next turn's prompt/tool results are included; it is not a causal shrink.
