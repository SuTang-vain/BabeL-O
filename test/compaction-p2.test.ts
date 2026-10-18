import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildSummaryCacheKey,
  clearSummaryCache,
  getCachedSummary,
  setCachedSummary,
  summaryCacheSize,
} from '../src/runtime/summaryCache.js'
import {
  getPaybackMultiplier,
  recordPayback,
  resetPaybackController,
} from '../src/runtime/paybackController.js'
import { evaluateCompactionPolicy } from '../src/runtime/compactionMode.js'
import { resolveSummaryModelId } from '../src/runtime/compactSummary.js'
import { buildDeterministicDigest, mergeDigests } from '../src/runtime/compactionDigest.js'
import type { NexusEvent } from '../src/shared/events.js'

const schemaVersion = '2026-05-21.babel-o.v1' as const

function userEvent(sessionId: string, text: string, second: number): NexusEvent {
  return {
    type: 'user_message',
    schemaVersion,
    sessionId,
    timestamp: `2026-05-23T00:00:${String(second).padStart(2, '0')}.000Z`,
    text,
  }
}

function readPair(sessionId: string, id: string, path: string, output: string, second: number): NexusEvent[] {
  return [
    {
      type: 'tool_started',
      schemaVersion,
      sessionId,
      timestamp: `2026-05-23T00:00:${String(second).padStart(2, '0')}.000Z`,
      toolUseId: id,
      name: 'Read',
      input: { path },
    },
    {
      type: 'tool_completed',
      schemaVersion,
      sessionId,
      timestamp: `2026-05-23T00:00:${String(second + 1).padStart(2, '0')}.000Z`,
      toolUseId: id,
      name: 'Read',
      success: true,
      output,
    },
  ]
}

describe('summary cache', () => {
  beforeEach(() => clearSummaryCache())

  test('keys are stable per events+model and differ across models', () => {
    const events = [userEvent('s', 'hello', 1)]
    assert.equal(buildSummaryCacheKey(events, 'model-a'), buildSummaryCacheKey(events, 'model-a'))
    assert.notEqual(buildSummaryCacheKey(events, 'model-a'), buildSummaryCacheKey(events, 'model-b'))
  })

  test('stores, retrieves, and evicts the oldest entry', () => {
    for (let index = 0; index < 33; index += 1) {
      setCachedSummary(`k${index}`, {
        text: `summary ${index}`,
        usage: { inputTokens: 1, outputTokens: 1 },
      })
    }
    assert.equal(summaryCacheSize(), 32)
    assert.equal(getCachedSummary('k0'), undefined)
    assert.equal(getCachedSummary('k32')?.text, 'summary 32')
  })
})

describe('payback controller', () => {
  beforeEach(() => resetPaybackController())

  test('raises the multiplier after poor realized payback', () => {
    recordPayback('s1', 100, 30)
    recordPayback('s1', 100, 40)
    assert.equal(getPaybackMultiplier('s1'), 1.5)
  })

  test('stays neutral when realized payback is healthy', () => {
    recordPayback('s2', 100, 90)
    recordPayback('s2', 100, 95)
    assert.equal(getPaybackMultiplier('s2'), 1)
  })
})

describe('admission with realized feedback and forced override', () => {
  test('a higher payback multiplier turns an accepted case into a rejection', () => {
    const base = {
      tokenEstimate: 40_000,
      maxTokens: 100_000,
      nHat: 10,
      dHat: 8_000,
      sHat: 2_000,
      kHat: 0.5,
      cacheRatio: 0,
    }
    assert.equal(evaluateCompactionPolicy(base).shouldCompact, true)
    assert.equal(evaluateCompactionPolicy({ ...base, paybackMultiplier: 1.5 }).shouldCompact, false)
  })

  test('forced percent can be lowered for a forced-digest experiment', () => {
    const previous = process.env.BABEL_O_COMPACT_FORCED_PERCENT
    process.env.BABEL_O_COMPACT_FORCED_PERCENT = '50'
    try {
      const decision = evaluateCompactionPolicy({
        tokenEstimate: 50_000,
        maxTokens: 100_000,
        nHat: 1,
        dHat: 4_000,
        sHat: 12_000,
      })
      assert.equal(decision.shouldCompact, true)
      assert.match(decision.reason, /^forced-/)
    } finally {
      if (previous === undefined) delete process.env.BABEL_O_COMPACT_FORCED_PERCENT
      else process.env.BABEL_O_COMPACT_FORCED_PERCENT = previous
    }
  })
})

describe('hierarchical digest merge', () => {
  test('keeps contracts from both epochs and the latest fact per subject', () => {
    const a = buildDeterministicDigest([
      userEvent('s', 'first instruction', 1),
      ...readPair('s', 'a1', 'src/x.ts', '12345', 2),
    ])
    const b = buildDeterministicDigest([
      userEvent('s', 'first instruction', 1),
      userEvent('s', 'second instruction', 10),
      ...readPair('s', 'b1', 'src/x.ts', '1234567', 11),
    ])
    const merged = mergeDigests(a, b)
    const contracts = merged.records.filter(record => record.kind === 'contract').map(record => record.value)
    assert.ok(contracts.includes('first instruction'))
    assert.ok(contracts.includes('second instruction'))
    const fact = merged.records.find(record => record.subject === 'file:src/x.ts')
    assert.equal(fact?.value, 'read 7 chars')
  })
})

describe('summary model override', () => {
  test('uses BABEL_O_COMPACT_SUMMARY_MODEL when set', () => {
    const previous = process.env.BABEL_O_COMPACT_SUMMARY_MODEL
    process.env.BABEL_O_COMPACT_SUMMARY_MODEL = 'zai/glm-5.3-flash'
    try {
      assert.equal(resolveSummaryModelId('deepseek/deepseek-v4-flash'), 'zai/glm-5.3-flash')
    } finally {
      if (previous === undefined) delete process.env.BABEL_O_COMPACT_SUMMARY_MODEL
      else process.env.BABEL_O_COMPACT_SUMMARY_MODEL = previous
    }
    assert.equal(resolveSummaryModelId('deepseek/deepseek-v4-flash'), 'deepseek/deepseek-v4-flash')
  })
})
