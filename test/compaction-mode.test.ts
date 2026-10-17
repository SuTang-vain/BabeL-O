import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  applyCompactionMode,
  recordCompactionDecision,
  resolveCompactionMode,
} from '../src/runtime/compactionMode.js'
import type { AutoCompactDecision } from '../src/runtime/compact.js'

function stockDecision(overrides: Partial<AutoCompactDecision> = {}): AutoCompactDecision {
  return {
    enabled: true,
    shouldCompact: false,
    thresholdPercent: 90,
    failureCount: 0,
    failureLimit: 2,
    fuseOpen: false,
    ...overrides,
  }
}

describe('resolveCompactionMode', () => {
  test('defaults to stock when unset or invalid', () => {
    assert.equal(resolveCompactionMode({}), 'stock')
    assert.equal(resolveCompactionMode({ BABEL_O_COMPACT_MODE: '' }), 'stock')
    assert.equal(resolveCompactionMode({ BABEL_O_COMPACT_MODE: 'unknown' }), 'stock')
  })

  test('parses noop, off, and adaptive case-insensitively', () => {
    assert.equal(resolveCompactionMode({ BABEL_O_COMPACT_MODE: 'noop' }), 'noop')
    assert.equal(resolveCompactionMode({ BABEL_O_COMPACT_MODE: 'OFF' }), 'noop')
    assert.equal(resolveCompactionMode({ BABEL_O_COMPACT_MODE: ' adaptive ' }), 'adaptive')
    assert.equal(resolveCompactionMode({ BABEL_O_COMPACT_MODE: 'stock' }), 'stock')
  })
})

describe('applyCompactionMode', () => {
  test('stock preserves the existing decision', () => {
    const stock = stockDecision({ shouldCompact: true, thresholdPercent: 90 })
    const decision = applyCompactionMode({
      mode: 'stock',
      tokenEstimate: 95,
      maxTokens: 100,
      stock,
    })
    assert.equal(decision.enabled, true)
    assert.equal(decision.shouldCompact, true)
    assert.equal(decision.thresholdPercent, 90)
    assert.equal(decision.reason, 'stock-threshold')
  })

  test('noop disables auto compaction even when stock would fire', () => {
    const decision = applyCompactionMode({
      mode: 'noop',
      tokenEstimate: 99,
      maxTokens: 100,
      stock: stockDecision({ shouldCompact: true }),
    })
    assert.equal(decision.enabled, false)
    assert.equal(decision.shouldCompact, false)
    assert.equal(decision.reason, 'mode-noop')
  })

  test('adaptive is forced-only at 92% until P1 admission lands', () => {
    const below = applyCompactionMode({
      mode: 'adaptive',
      tokenEstimate: 91.9,
      maxTokens: 100,
      stock: stockDecision({ shouldCompact: true }),
    })
    const at = applyCompactionMode({
      mode: 'adaptive',
      tokenEstimate: 92,
      maxTokens: 100,
      stock: stockDecision(),
    })
    assert.equal(below.shouldCompact, false)
    assert.equal(below.enabled, true)
    assert.equal(below.thresholdPercent, 92)
    assert.equal(below.reason, 'adaptive-headroom')
    assert.equal(at.shouldCompact, true)
    assert.equal(at.reason, 'adaptive-forced')
  })

  test('adaptive still respects the failure fuse', () => {
    const decision = applyCompactionMode({
      mode: 'adaptive',
      tokenEstimate: 99,
      maxTokens: 100,
      stock: stockDecision({ fuseOpen: true }),
    })
    assert.equal(decision.shouldCompact, false)
    assert.equal(decision.fuseOpen, true)
  })
})

describe('recordCompactionDecision', () => {
  test('appends one JSON line per decision when the ledger is enabled', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'babelo-compact-ledger-')), 'decisions.jsonl')
    const previous = process.env.BABEL_O_COMPACT_DECISION_LOG
    process.env.BABEL_O_COMPACT_DECISION_LOG = path
    try {
      recordCompactionDecision({
        sessionId: 'session-1',
        requestId: 'request-1',
        modelId: 'local/coding-runtime',
        providerId: 'local',
        source: 'pre_loop',
        mode: 'noop',
        tokenEstimate: 42_000,
        maxTokens: 90_000,
        percentUsed: 46.7,
        warningThresholdTokens: 63_000,
        compactThresholdTokens: 81_000,
        blockingLimitTokens: 89_000,
        enabled: false,
        shouldCompact: false,
        thresholdPercent: 90,
        failureCount: 0,
        fuseOpen: false,
        reason: 'mode-noop',
      })
      recordCompactionDecision({
        sessionId: 'session-1',
        requestId: 'request-1',
        modelId: 'local/coding-runtime',
        providerId: 'local',
        source: 'reactive',
        mode: 'noop',
        tokenEstimate: 89_500,
        maxTokens: 90_000,
        percentUsed: 99.4,
        enabled: false,
        shouldCompact: false,
        thresholdPercent: 90,
        failureCount: 0,
        fuseOpen: false,
        reason: 'provider-loop-blocking',
      })
    } finally {
      if (previous === undefined) delete process.env.BABEL_O_COMPACT_DECISION_LOG
      else process.env.BABEL_O_COMPACT_DECISION_LOG = previous
    }

    const lines = readFileSync(path, 'utf8').trim().split('\n')
    assert.equal(lines.length, 2)
    const first = JSON.parse(lines[0]!)
    assert.equal(first.mode, 'noop')
    assert.equal(first.source, 'pre_loop')
    assert.equal(first.shouldCompact, false)
    assert.equal(first.reason, 'mode-noop')
    assert.equal(typeof first.ts, 'string')
    assert.equal(typeof first.tokenEstimate, 'number')
    const second = JSON.parse(lines[1]!)
    assert.equal(second.source, 'reactive')
    assert.equal(second.reason, 'provider-loop-blocking')
  })

  test('is a no-op when the ledger env is unset', () => {
    const dir = mkdtempSync(join(tmpdir(), 'babelo-compact-ledger-off-'))
    const path = join(dir, 'decisions.jsonl')
    const previous = process.env.BABEL_O_COMPACT_DECISION_LOG
    delete process.env.BABEL_O_COMPACT_DECISION_LOG
    try {
      recordCompactionDecision({
        sessionId: 'session-1',
        modelId: 'local/coding-runtime',
        source: 'manual',
        mode: 'stock',
        tokenEstimate: 0,
        maxTokens: 0,
        percentUsed: 0,
        enabled: false,
        shouldCompact: false,
        thresholdPercent: 90,
        failureCount: 0,
        fuseOpen: false,
        reason: 'off',
      })
    } finally {
      if (previous !== undefined) process.env.BABEL_O_COMPACT_DECISION_LOG = previous
    }
    assert.equal(existsSync(path), false)
  })

  test('never throws when the ledger path is unwritable', () => {
    const previous = process.env.BABEL_O_COMPACT_DECISION_LOG
    process.env.BABEL_O_COMPACT_DECISION_LOG = '/nonexistent-dir/babelo/decisions.jsonl'
    try {
      assert.doesNotThrow(() => recordCompactionDecision({
        sessionId: 'session-1',
        modelId: 'local/coding-runtime',
        source: 'manual',
        mode: 'stock',
        tokenEstimate: 0,
        maxTokens: 0,
        percentUsed: 0,
        enabled: false,
        shouldCompact: false,
        thresholdPercent: 90,
        failureCount: 0,
        fuseOpen: false,
        reason: 'off',
      }))
    } finally {
      if (previous === undefined) delete process.env.BABEL_O_COMPACT_DECISION_LOG
      else process.env.BABEL_O_COMPACT_DECISION_LOG = previous
    }
  })
})
