import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mapOpenAIUsage } from '../src/providers/adapters/OpenAIAdapter.js'
import { buildCacheAwareCompactPolicy, summarizeCacheAwareUsage } from '../src/runtime/cacheAwareCompactPolicy.js'
import { evaluateCompactionPolicy } from '../src/runtime/compactionMode.js'
import type { NexusEvent } from '../src/shared/events.js'

describe('mapOpenAIUsage', () => {
  test('maps DeepSeek prompt_cache_hit_tokens', () => {
    const usage = mapOpenAIUsage({
      prompt_tokens: 1_000,
      completion_tokens: 50,
      prompt_cache_hit_tokens: 800,
      prompt_cache_miss_tokens: 200,
    })
    assert.equal(usage?.inputTokens, 1_000)
    assert.equal(usage?.outputTokens, 50)
    assert.equal(usage?.cacheReadInputTokens, 800)
  })

  test('maps OpenAI cached_tokens and omits zero cache fields', () => {
    const usage = mapOpenAIUsage({
      prompt_tokens: 500,
      completion_tokens: 10,
      prompt_tokens_details: { cached_tokens: 300 },
    })
    assert.equal(usage?.cacheReadInputTokens, 300)
    assert.equal('cacheCreationInputTokens' in (usage ?? {}), false)
    assert.equal(mapOpenAIUsage(undefined), undefined)
  })
})

describe('cache-aware compaction policy', () => {
  test('high cache reuse is opt-in and stock stays at 90%', () => {
    const previous = process.env.BABEL_O_COMPACT_CACHE_AWARE
    delete process.env.BABEL_O_COMPACT_CACHE_AWARE
    try {
      const usage = {
        inputTokens: 5_000,
        outputTokens: 50,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 4_000,
      }
      const stock = buildCacheAwareCompactPolicy({
        modelId: 'anthropic/claude-3-5-sonnet',
        tokenEstimate: 1_000,
        usage,
        cacheableSystemPromptRatio: 0.5,
      })
      assert.equal(stock.cachePreservationMode, false)
      assert.equal(stock.compactThresholdPercent, 90)
    } finally {
      if (previous === undefined) delete process.env.BABEL_O_COMPACT_CACHE_AWARE
      else process.env.BABEL_O_COMPACT_CACHE_AWARE = previous
    }
  })

  test('high cache reuse raises the compact threshold to 93% when opted in', () => {
    const previous = process.env.BABEL_O_COMPACT_CACHE_AWARE
    process.env.BABEL_O_COMPACT_CACHE_AWARE = '1'
    try {
      const usage = {
      inputTokens: 5_000,
      outputTokens: 50,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 4_000,
    }
    const policy = buildCacheAwareCompactPolicy({
      modelId: 'anthropic/claude-3-5-sonnet',
      tokenEstimate: 1_000,
      usage,
      cacheableSystemPromptRatio: 0.5,
    })
      assert.equal(policy.cachePreservationMode, true)
      assert.equal(policy.compactThresholdPercent, 93)
    } finally {
      if (previous === undefined) delete process.env.BABEL_O_COMPACT_CACHE_AWARE
      else process.env.BABEL_O_COMPACT_CACHE_AWARE = previous
    }
  })

  test('summarizeCacheAwareUsage sums cache reads', () => {
    const events = [
      { type: 'usage', inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 40 },
      { type: 'usage', inputTokens: 200, outputTokens: 20, cacheReadInputTokens: 60 },
    ] as NexusEvent[]
    const usage = summarizeCacheAwareUsage(events)
    assert.equal(usage.inputTokens, 300)
    assert.equal(usage.cacheReadInputTokens, 100)
  })

  test('cache reuse lowers payback, making compaction less attractive', () => {
    const base = {
      tokenEstimate: 40_000,
      maxTokens: 100_000,
      nHat: 5,
      dHat: 8_000,
      sHat: 2_000,
      kHat: 0.5,
    }
    const noCache = evaluateCompactionPolicy({ ...base, cacheRatio: 0 })
    const cached = evaluateCompactionPolicy({ ...base, cacheRatio: 0.8 })
    assert.ok(cached.payback < noCache.payback)
  })
})
