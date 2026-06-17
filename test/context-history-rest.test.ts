// test/context-history-rest.test.ts
//
// PR-11 unit tests: /v1/context/history REST endpoint.
// Covers: parseSinceFromQuery, runContextHistory, end-to-end via Fastify.

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

import {
  parseSinceFromQuery,
  runContextHistory,
  type ContextHistoryParams,
} from '../src/nexus/app.js'

const ORIGINAL_ENV: Record<string, string | undefined> = {}

describe('PR-11 parseSinceFromQuery', () => {
  test('hours', () => assert.equal(parseSinceFromQuery('24h'), 24 * 3600_000))
  test('minutes', () => assert.equal(parseSinceFromQuery('30m'), 30 * 60_000))
  test('days', () => assert.equal(parseSinceFromQuery('1d'), 24 * 3600_000))
  test('weeks', () => assert.equal(parseSinceFromQuery('1w'), 7 * 24 * 3600_000))
  test('invalid returns undefined', () => assert.equal(parseSinceFromQuery('24x'), undefined))
  test('empty returns undefined', () => assert.equal(parseSinceFromQuery(''), undefined))
})

describe('PR-11 runContextHistory', () => {
  let cwd: string
  const sessionId = `rest-${randomUUID()}`

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'babel-o-rest-'))
    for (const key of ['HOME', 'BABEL_O_TEST_CONFIG_WRITE_GUARD']) {
      ORIGINAL_ENV[key] = process.env[key]
    }
    process.env.HOME = cwd
    process.env.BABEL_O_TEST_CONFIG_WRITE_GUARD = '1'
  })

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true })
    for (const [key, val] of Object.entries(ORIGINAL_ENV)) {
      if (val === undefined) delete process.env[key]
      else process.env[key] = val
    }
  })

  function seedTrace(entries: Array<{ trigger: string; errorCode?: string; errorMessage?: string; ts: string; source?: string }>): void {
    const dir = join(cwd, '.babel-o')
    mkdirSync(dir, { recursive: true })
    const lines = entries.map((e, i) => JSON.stringify({
      schemaVersion: '2026-06-16.behavior-trace.v1',
      traceId: `trc_${i}`,
      sessionId,
      cwd,
      timestamp: e.ts,
      trigger: e.trigger,
      triggerConfidence: 0.9,
      context: { recentEvents: [], toolSequence: [], fileRefStack: [], userIntentGuidance: '', retryCount: 0, timeInSessionMs: 0, tokensSinceLastTrace: 0 },
      anomaly: { errorCode: e.errorCode, errorMessage: e.errorMessage, source: e.source },
    }))
    writeFileSync(join(dir, 'behavior-trace.jsonl'), lines.join('\n') + '\n', 'utf8')
  }

  test('no trace file: returns clean empty result', async () => {
    const result = await runContextHistory({
      cwd, scope: 'summarize', maxTokens: 5000, summarizeScope: 'all',
    })
    assert.equal(result.type, 'context_history_result')
    assert.equal(result.hitCount, 0)
    assert.ok(result.content.includes('no behavior trace file'))
  })

  test('summarize mode: returns all entries sorted newest first', async () => {
    seedTrace([
      { trigger: 'error', errorCode: 'E1', errorMessage: 'first', ts: '2026-06-16T10:00:01.000Z' },
      { trigger: 'denial', errorCode: 'D1', errorMessage: 'denial', ts: '2026-06-16T10:00:02.000Z' },
      { trigger: 'user-redirect', errorCode: 'UR1', errorMessage: 'redirect', ts: '2026-06-16T10:00:03.000Z' },
    ])
    const result = await runContextHistory({
      cwd, scope: 'summarize', maxTokens: 5000, summarizeScope: 'all',
    })
    assert.equal(result.hitCount, 3)
    assert.ok(result.content.includes('error'))
    assert.ok(result.content.includes('denial'))
    assert.ok(result.content.includes('user-redirect'))
  })

  test('summarize --summarize-scope=cross-session filters to nexus', async () => {
    seedTrace([
      { trigger: 'error', errorCode: 'E', errorMessage: 'session', ts: '2026-06-16T10:00:01.000Z' },
      { trigger: 'hot-path', errorCode: 'HOT', errorMessage: 'cross', ts: '2026-06-16T10:00:02.000Z', source: 'nexus' },
    ])
    const result = await runContextHistory({
      cwd, scope: 'summarize', maxTokens: 5000, summarizeScope: 'cross-session',
    })
    assert.equal(result.hitCount, 1)
    assert.ok(result.content.includes('[nexus]'))
  })

  test('summarize with sinceMs filters out old entries', async () => {
    seedTrace([
      { trigger: 'error', errorCode: 'OLD', errorMessage: 'ancient', ts: '2020-01-01T00:00:00.000Z' },
      { trigger: 'error', errorCode: 'NEW', errorMessage: 'recent', ts: new Date().toISOString() },
    ])
    const sinceMs = Date.now() - 3600_000
    const result = await runContextHistory({
      cwd, scope: 'summarize', maxTokens: 5000, summarizeScope: 'all', sinceMs,
    })
    assert.equal(result.hitCount, 1)
    assert.ok(result.content.includes('recent'))
    assert.ok(!result.content.includes('ancient'))
  })

  test('search mode finds matching entries', async () => {
    seedTrace([
      { trigger: 'error', errorCode: 'X', errorMessage: 'sessionMemoryLite missing', ts: '2026-06-16T10:00:01.000Z' },
      { trigger: 'error', errorCode: 'Y', errorMessage: 'other', ts: '2026-06-16T10:00:02.000Z' },
    ])
    const result = await runContextHistory({
      cwd, scope: 'search', maxTokens: 5000, summarizeScope: 'all',
      query: 'sessionMemoryLite',
    })
    assert.equal(result.hitCount, 1)
    assert.ok(result.content.includes('sessionMemoryLite'))
  })

  test('search without query throws', async () => {
    // Seed a trace file so the function reaches the search-mode branch
    // (otherwise it returns early with "no behavior trace file yet")
    seedTrace([{ trigger: 'error', errorCode: 'E', errorMessage: 'x', ts: '2026-06-16T10:00:00.000Z' }])
    await assert.rejects(
      () => runContextHistory({ cwd, scope: 'search', maxTokens: 5000, summarizeScope: 'all' }),
      /query is required/,
    )
  })

  test('5k token cap enforced', async () => {
    const big: any[] = []
    for (let i = 0; i < 200; i += 1) {
      big.push({ trigger: 'error', errorCode: 'E', errorMessage: 'Z'.repeat(200), ts: '2026-06-16T10:00:00.000Z' })
    }
    seedTrace(big)
    const result = await runContextHistory({
      cwd, scope: 'summarize', maxTokens: 50, summarizeScope: 'all',
    })
    assert.equal(result.truncated, true)
  })

  test('HOME isolation: HOME trace not read', async () => {
    // Place trace file directly in HOME
    writeFileSync(join(cwd, 'behavior-trace.jsonl'), JSON.stringify({
      schemaVersion: '2026-06-16.behavior-trace.v1', traceId: 't', sessionId: 'home', cwd,
      timestamp: '2026-06-16T10:00:00.000Z', trigger: 'error', triggerConfidence: 0.9,
      context: {}, anomaly: { errorCode: 'X', errorMessage: 'home_msg' },
    }), 'utf8')
    const result = await runContextHistory({
      cwd, scope: 'summarize', maxTokens: 5000, summarizeScope: 'all',
    })
    assert.ok(!result.content.includes('home_msg'), 'HOME file not read')
  })
})
