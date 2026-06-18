// test/context-history-cli.test.ts
//
// PR-10 unit tests: `bbl context history` CLI subcommand.
// Covers: --since parsing, summarize mode, search mode, --json, HOME isolation.

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Command } from 'commander'

import { registerContextCommand, runHistory, parseSince } from '../src/cli/commands/context.js'

const ORIGINAL_ENV: Record<string, string | undefined> = {}

describe('PR-10 parseSince', () => {
  test('hours', () => assert.equal(parseSince('24h'), 24 * 3600_000))
  test('minutes', () => assert.equal(parseSince('30m'), 30 * 60_000))
  test('days', () => assert.equal(parseSince('1d'), 24 * 3600_000))
  test('weeks', () => assert.equal(parseSince('1w'), 7 * 24 * 3600_000))
  test('invalid returns undefined', () => assert.equal(parseSince('24x'), undefined))
  test('empty returns undefined', () => assert.equal(parseSince(''), undefined))
  test('multi-digit', () => assert.equal(parseSince('168h'), 168 * 3600_000))
})

describe('PR-10 bbl context history', () => {
  let home: string
  let cwd: string
  const sessionId = `hist-${randomUUID()}`

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'babel-o-hist-home-'))
    cwd = mkdtempSync(join(home, 'project-'))
    for (const key of ['HOME', 'BABEL_O_TEST_CONFIG_WRITE_GUARD']) {
      ORIGINAL_ENV[key] = process.env[key]
    }
    process.env.HOME = home
    process.env.BABEL_O_TEST_CONFIG_WRITE_GUARD = '1'
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
    for (const [key, val] of Object.entries(ORIGINAL_ENV)) {
      if (val === undefined) delete process.env[key]
      else process.env[key] = val
    }
    // Reset process.exitCode to prevent the test runner from seeing
    // a non-zero exit code (caused by tests that verify exitCode=1).
    process.exitCode = undefined
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

  function captureStdout(fn: () => void | Promise<void>): Promise<string> {
    const origLog = console.log
    const origErr = console.error
    let buf = ''
    console.log = (...args: unknown[]) => {
      buf += args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ') + '\n'
    }
    console.error = (...args: unknown[]) => {
      buf += args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ') + '\n'
    }
    return Promise.resolve()
      .then(() => fn())
      .finally(() => {
        console.log = origLog
        console.error = origErr
      })
      .then(() => buf)
  }

  test('empty: no trace file → clean message', async () => {
    const out = await captureStdout(() => runHistory({ cwd, scope: 'summarize' }))
    assert.ok(out.includes('no behavior trace file yet'))
  })

  test('summarize mode (default): prints all entries newest first', async () => {
    seedTrace([
      { trigger: 'error', errorCode: 'E1', errorMessage: 'first', ts: '2026-06-16T10:00:01.000Z' },
      { trigger: 'denial', errorCode: 'D1', errorMessage: 'denial_msg', ts: '2026-06-16T10:00:02.000Z' },
      { trigger: 'user-redirect', errorCode: 'UR1', errorMessage: 'redirect', ts: '2026-06-16T10:00:03.000Z' },
    ])
    const out = await captureStdout(() => runHistory({ cwd, scope: 'summarize' }))
    assert.ok(out.includes('error'))
    assert.ok(out.includes('denial'))
    assert.ok(out.includes('user-redirect'))
    assert.ok(out.includes('hitCount=3'), 'hit count printed')
  })

  test('summarize --summarize-scope=cross-session filters to nexus', async () => {
    seedTrace([
      { trigger: 'error', errorCode: 'E1', errorMessage: 'first', ts: '2026-06-16T10:00:01.000Z' },
      { trigger: 'hot-path', errorCode: 'HOT_PATH', errorMessage: 'cross', ts: '2026-06-16T10:00:02.000Z', source: 'nexus' },
    ])
    const out = await captureStdout(() => runHistory({ cwd, scope: 'summarize', summarizeScope: 'cross-session' }))
    assert.ok(out.includes('cross'))
    assert.ok(out.includes('[nexus]'))
    assert.ok(out.includes('hitCount=1'))
  })

  test('--since 1h filters out older entries', async () => {
    seedTrace([
      { trigger: 'error', errorCode: 'E_OLD', errorMessage: 'ancient', ts: '2020-01-01T00:00:00.000Z' },
      { trigger: 'error', errorCode: 'E_NEW', errorMessage: 'recent', ts: new Date().toISOString() },
    ])
    const out = await captureStdout(() => runHistory({ cwd, scope: 'summarize', since: '1h' }))
    assert.ok(!out.includes('ancient'), 'old entry excluded')
    assert.ok(out.includes('recent'), 'new entry included')
    assert.ok(out.includes('hitCount=1'))
  })

  test('search mode requires --query', async () => {
    seedTrace([{ trigger: 'error', errorCode: 'E', errorMessage: 'msg', ts: '2026-06-16T10:00:01.000Z' }])
    const out = await captureStdout(() => runHistory({ cwd, scope: 'search' }))
    assert.ok(out.includes('--query is required'))
  })

  test('search mode finds matching entries', async () => {
    seedTrace([
      { trigger: 'error', errorCode: 'NOT_FOUND', errorMessage: 'sessionMemoryLite missing', ts: '2026-06-16T10:00:01.000Z' },
      { trigger: 'error', errorCode: 'OTHER', errorMessage: 'something else', ts: '2026-06-16T10:00:02.000Z' },
    ])
    const out = await captureStdout(() => runHistory({ cwd, scope: 'search', query: 'sessionMemoryLite' }))
    assert.ok(out.includes('sessionMemoryLite'))
    assert.ok(out.includes('hitCount=1'))
  })

  test('--json: prints raw JSON', async () => {
    seedTrace([{ trigger: 'error', errorCode: 'E', errorMessage: 'msg', ts: '2026-06-16T10:00:01.000Z' }])
    const out = await captureStdout(() => runHistory({ cwd, scope: 'summarize', json: true }))
    const parsed = JSON.parse(out)
    assert.equal(parsed.hitCount, 1)
    assert.ok(typeof parsed.content === 'string')
    assert.equal(parsed.truncated, false)
  })

  test('invalid --since prints error and sets exitCode=1', async () => {
    seedTrace([{ trigger: 'error', errorCode: 'E', errorMessage: 'msg', ts: '2026-06-16T10:00:01.000Z' }])
    const out = await captureStdout(() => runHistory({ cwd, scope: 'summarize', since: 'invalid' }))
    assert.ok(out.includes('Invalid --since'), `expected "Invalid --since" in: ${out.slice(0, 200)}`)
    assert.equal(process.exitCode, 1, 'exitCode set to 1')
  })

  test('isolation: HOME trace file not read', async () => {
    // Place trace file directly in HOME
    writeFileSync(join(home, 'behavior-trace.jsonl'), JSON.stringify({
      schemaVersion: '2026-06-16.behavior-trace.v1', traceId: 't', sessionId: 'home', cwd: home,
      timestamp: '2026-06-16T10:00:00.000Z', trigger: 'error', triggerConfidence: 0.9,
      context: {}, anomaly: { errorCode: 'X', errorMessage: 'home_msg' },
    }), 'utf8')
    const out = await captureStdout(() => runHistory({ cwd, scope: 'summarize' }))
    assert.ok(!out.includes('home_msg'), 'HOME file not read')
  })
})

describe('PR-10 registerContextCommand history subcommand', () => {
  test('registers bbl context history as a subcommand', () => {
    const program = new Command()
    registerContextCommand(program)
    const ctx = program.commands.find(c => c.name() === 'context')
    assert.ok(ctx)
    const history = ctx!.commands.find(c => c.name() === 'history')
    assert.ok(history, 'history subcommand registered')
  })
})
