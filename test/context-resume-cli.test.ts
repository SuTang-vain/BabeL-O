// test/context-resume-cli.test.ts
//
// PR-13 unit tests: `bbl context resume` CLI subcommand (dry-run).
// Covers: empty state, with working set, with trace, --session-id, HOME isolation.

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Command } from 'commander'

import { registerContextCommand, runResume } from '../src/cli/commands/context.js'

const ORIGINAL_ENV: Record<string, string | undefined> = {}

describe('PR-13 bbl context resume (dry-run)', () => {
  let home: string
  let cwd: string
  const sessionId = `resume-${randomUUID()}`

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'babel-o-resume-home-'))
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
  })

  function captureStdout(fn: () => void | Promise<void>): Promise<string> {
    const origLog = console.log
    let buf = ''
    console.log = (...args: unknown[]) => {
      buf += args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ') + '\n'
    }
    return Promise.resolve()
      .then(() => fn())
      .finally(() => { console.log = origLog })
      .then(() => buf)
  }

  function seedWorkingSet(entries: Array<{ sid: string; items: any[] }>): void {
    const dir = join(cwd, '.babel-o')
    mkdirSync(dir, { recursive: true })
    const sessions: Record<string, any> = {}
    for (const e of entries) {
      sessions[e.sid] = {
        sessionId: e.sid,
        workspaceId: cwd,
        entries: e.items,
        version: 1,
        updatedAt: '2026-06-16T00:00:00.000Z',
      }
    }
    writeFileSync(
      join(dir, 'working-set.json'),
      JSON.stringify({ schemaVersion: '2026-06-16.working-set.v1', sessions }, null, 2),
      'utf8',
    )
  }

  function seedTrace(entries: Array<{ trigger: string; errorCode?: string; errorMessage?: string; ts: string }>): void {
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
      anomaly: { errorCode: e.errorCode, errorMessage: e.errorMessage },
    }))
    writeFileSync(join(dir, 'behavior-trace.jsonl'), lines.join('\n') + '\n', 'utf8')
  }

  test('empty state: shows (no working set) and (no behavior trace)', async () => {
    const out = await captureStdout(() => runResume({ cwd }))
    assert.ok(out.includes('Session Resume Plan'))
    assert.ok(out.includes('(no working set)'))
    assert.ok(out.includes('(no behavior trace)'))
    assert.ok(out.includes('working set:'))
    assert.ok(out.includes('no'), 'inherits nothing')
  })

  test('with working set only: shows entries', async () => {
    seedWorkingSet([{
      sid: sessionId,
      items: [
        { key: 'task:investigate', value: 'review main.ts', updatedAt: 't', confidence: 0.95 },
        { key: 'file:src/main.ts', value: '/p/main.ts', updatedAt: 't', confidence: 0.8 },
      ],
    }])
    const out = await captureStdout(() => runResume({ cwd }))
    assert.ok(out.includes(sessionId), 'session id printed')
    assert.ok(out.includes('task:investigate'), 'entry key printed')
    assert.ok(out.includes('review main.ts'), 'entry value printed')
    assert.ok(out.includes('would inherit'), 'resume plan section')
  })

  test('with trace only: shows recent traces', async () => {
    seedTrace([
      { trigger: 'error', errorCode: 'X', errorMessage: 'first error', ts: '2026-06-16T10:00:01.000Z' },
      { trigger: 'denial', errorCode: 'Y', errorMessage: 'denial event', ts: '2026-06-16T10:00:02.000Z' },
    ])
    const out = await captureStdout(() => runResume({ cwd }))
    assert.ok(out.includes('Recent Behavior Trace'))
    assert.ok(out.includes('first error'))
    assert.ok(out.includes('denial event'))
  })

  test('--json: prints valid JSON', async () => {
    seedWorkingSet([{ sid: sessionId, items: [{ key: 'k', value: 'v', updatedAt: 't', confidence: 0.5 }] }])
    seedTrace([{ trigger: 'error', errorCode: 'X', errorMessage: 'msg', ts: '2026-06-16T10:00:01.000Z' }])
    const out = await captureStdout(() => runResume({ cwd, json: true }))
    const parsed = JSON.parse(out)
    assert.equal(parsed.cwd, cwd)
    assert.equal(parsed.workingSet.sessionCount, 1)
    assert.equal(parsed.workingSet.totalEntries, 1)
    assert.equal(parsed.recentBehavior.count, 1)
    assert.equal(parsed.resumePlan.wouldInheritWorkingSet, true)
    assert.equal(parsed.resumePlan.wouldInheritBehaviorTrace, true)
  })

  test('--session-id filter: only matching session', async () => {
    seedWorkingSet([
      { sid: 's1', items: [{ key: 'a', value: 'A', updatedAt: 't', confidence: 0.9 }] },
      { sid: 's2', items: [{ key: 'b', value: 'B', updatedAt: 't', confidence: 0.7 }] },
    ])
    const out = await captureStdout(() => runResume({ cwd, sessionId: 's1' }))
    assert.ok(out.includes('s1'))
    assert.ok(!out.includes('"s2"'), 's2 filtered out (note: s2 may appear in key string)')
    assert.ok(!out.includes(' B '), 's2 value "B" filtered out')
  })

  test('HOME isolation: HOME working-set.json not read', async () => {
    writeFileSync(join(home, 'working-set.json'), JSON.stringify({
      schemaVersion: '2026-06-16.working-set.v1',
      sessions: { homeS: { sessionId: 'homeS', workspaceId: home, entries: [], version: 1, updatedAt: 't' } },
    }), 'utf8')
    const out = await captureStdout(() => runResume({ cwd }))
    assert.ok(!out.includes('homeS'), 'HOME file not read')
  })

  test('truncates entries beyond 5 per session', async () => {
    const items: any[] = []
    for (let i = 0; i < 8; i += 1) {
      items.push({ key: `k${i}`, value: `v${i}`, updatedAt: 't', confidence: 0.5 })
    }
    seedWorkingSet([{ sid: sessionId, items }])
    const out = await captureStdout(() => runResume({ cwd }))
    assert.ok(out.includes('k0'), 'first entry shown')
    assert.ok(out.includes('k4'), '5th entry shown')
    assert.ok(out.includes('and 3 more'), 'truncation note')
    assert.ok(!out.includes('k5'), '6th entry not shown')
  })
})

describe('PR-13 registerContextCommand resume subcommand', () => {
  test('registers bbl context resume as a subcommand', () => {
    const program = new Command()
    registerContextCommand(program)
    const ctx = program.commands.find(c => c.name() === 'context')
    assert.ok(ctx)
    const resume = ctx!.commands.find(c => c.name() === 'resume')
    assert.ok(resume, 'resume subcommand registered')
  })
})
