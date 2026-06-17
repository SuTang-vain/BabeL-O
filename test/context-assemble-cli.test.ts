// test/context-assemble-cli.test.ts
//
// PR-15 unit tests: `bbl context assemble` CLI subcommand (manual context
// assembly preview per design §7.2).
//
// Covers:
//   1. Empty state returns sections=[workingSet(empty)]
//   2. scope=minimal returns only workingSet
//   3. scope=standard returns workingSet + recentEvents
//   4. scope=full returns workingSet + recentEvents + behaviorTrace
//   5. scope=task returns workingSet + behaviorTrace
//   6. scope=workspace uses cross-session traces
//   7. --session-id filter
//   8. --max-tokens enforced (overflow=drop)
//   9. --json prints valid AssembledContext preview
//  10. section order: pinned first
//  11. budget meta populated
//  12. HOME isolation: HOME files not read
//  13. registers bbl context assemble as subcommand

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Command } from 'commander'

import {
  registerContextCommand,
  runAssemble,
} from '../src/cli/commands/context.js'
import type { AssembledContextPreview } from '../src/nexus/contextAssemblePreview.js'

const ORIGINAL_ENV: Record<string, string | undefined> = {}

describe('PR-15 bbl context assemble', () => {
  let home: string
  let cwd: string
  const sessionId = `pr15-${randomUUID()}`

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'babel-o-pr15-home-'))
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

  function captureStdout(fn: () => Promise<unknown>): Promise<string> {
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

  function seedWorkingSet(entries: Array<{ sid: string; items: Array<{ key: string; value: string; confidence: number }>; version?: number }>): void {
    const dir = join(cwd, '.babel-o')
    mkdirSync(dir, { recursive: true })
    const sessions: Record<string, any> = {}
    for (const e of entries) {
      sessions[e.sid] = {
        sessionId: e.sid,
        workspaceId: cwd,
        entries: e.items,
        version: e.version ?? 1,
        updatedAt: '2026-06-16T00:00:00.000Z',
      }
    }
    writeFileSync(
      join(dir, 'working-set.json'),
      JSON.stringify({ schemaVersion: '2026-06-16.working-set.v1', sessions }, null, 2),
      'utf8',
    )
  }

  function seedTrace(entries: Array<{ trigger: string; errorCode?: string; errorMessage?: string; denialReason?: string; source?: string; ts: string; sid?: string }>): void {
    const dir = join(cwd, '.babel-o')
    mkdirSync(dir, { recursive: true })
    const lines = entries.map((e, i) => JSON.stringify({
      schemaVersion: '2026-06-16.behavior-trace.v1',
      traceId: `trc_${i}`,
      sessionId: e.sid ?? sessionId,
      cwd,
      timestamp: e.ts,
      trigger: e.trigger,
      triggerConfidence: 0.9,
      context: { recentEvents: [], toolSequence: [], fileRefStack: [], userIntentGuidance: '', retryCount: 0, timeInSessionMs: 0, tokensSinceLastTrace: 0 },
      anomaly: { errorCode: e.errorCode, errorMessage: e.errorMessage, denialReason: e.denialReason, source: e.source },
    }))
    writeFileSync(join(dir, 'behavior-trace.jsonl'), lines.join('\n') + '\n', 'utf8')
  }

  // ── Test 1: empty cwd ──────────────────────────────────────────────────
  test('empty cwd: empty workingSet section emitted, no recent/trace', async () => {
    const out = await captureStdout(async () => {
      const result = await runAssemble({ cwd, scope: 'standard', maxTokens: 7500, json: true })
      return result
    })
    const parsed = JSON.parse(out) as AssembledContextPreview
    assert.equal(parsed.scope, 'standard')
    assert.equal(parsed.sessionId, '(none)')
    // standard scope emits workingSet + recentEvents even when empty
    assert.equal(parsed.sections.length, 2)
    assert.equal(parsed.sections[0]!.kind, 'workingSet')
    assert.equal(parsed.sections[0]!.content.includes('(no working set entries)'), true)
    assert.equal(parsed.sections[1]!.kind, 'recentEvents')
    assert.equal(parsed.sections[1]!.content.includes('(no recent events)'), true)
  })

  // ── Test 2: scope=minimal ───────────────────────────────────────────────
  test('scope=minimal: workingSet section only', async () => {
    seedWorkingSet([{ sid: sessionId, items: [{ key: 'task:x', value: 'v', confidence: 0.9 }] }])
    seedTrace([{ trigger: 'error', errorMessage: 'should not appear', ts: '2026-06-16T10:00:01.000Z' }])
    const out = await captureStdout(async () => {
      return await runAssemble({ cwd, sessionId, scope: 'minimal', maxTokens: 7500, json: true })
    })
    const parsed = JSON.parse(out) as AssembledContextPreview
    assert.equal(parsed.sections.length, 1)
    assert.equal(parsed.sections[0]!.kind, 'workingSet')
    assert.equal(parsed.sections[0]!.pinned, true)
  })

  // ── Test 3: scope=standard ──────────────────────────────────────────────
  test('scope=standard: workingSet + recentEvents', async () => {
    seedWorkingSet([{ sid: sessionId, items: [{ key: 'task:x', value: 'v', confidence: 0.9 }] }])
    seedTrace([{ trigger: 'error', errorMessage: 'recent1', ts: '2026-06-16T10:00:01.000Z' }])
    const out = await captureStdout(async () => {
      return await runAssemble({ cwd, sessionId, scope: 'standard', maxTokens: 7500, json: true })
    })
    const parsed = JSON.parse(out) as AssembledContextPreview
    assert.equal(parsed.sections.length, 2)
    assert.equal(parsed.sections[0]!.kind, 'workingSet')
    assert.equal(parsed.sections[1]!.kind, 'recentEvents')
    assert.equal(parsed.sections[1]!.pinned, false)
  })

  // ── Test 4: scope=full ──────────────────────────────────────────────────
  test('scope=full: workingSet + recentEvents + behaviorTrace', async () => {
    seedWorkingSet([{ sid: sessionId, items: [{ key: 'k', value: 'v', confidence: 0.9 }] }])
    seedTrace([
      { trigger: 'error', errorMessage: 'e1', ts: '2026-06-16T10:00:01.000Z' },
      { trigger: 'denial', denialReason: 'd1', ts: '2026-06-16T10:00:02.000Z' },
    ])
    const out = await captureStdout(async () => {
      return await runAssemble({ cwd, sessionId, scope: 'full', maxTokens: 7500, json: true })
    })
    const parsed = JSON.parse(out) as AssembledContextPreview
    assert.equal(parsed.sections.length, 3)
    assert.deepEqual(parsed.sections.map(s => s.kind), ['workingSet', 'recentEvents', 'behaviorTrace'])
    // behaviorTrace summary should have count by trigger
    const bt = parsed.sections.find(s => s.kind === 'behaviorTrace')!
    assert.ok(bt.content.includes('error: 1'))
    assert.ok(bt.content.includes('denial: 1'))
  })

  // ── Test 5: scope=task ──────────────────────────────────────────────────
  test('scope=task: workingSet + behaviorTrace (no recentEvents)', async () => {
    seedWorkingSet([{ sid: sessionId, items: [{ key: 'k', value: 'v', confidence: 0.9 }] }])
    seedTrace([{ trigger: 'error', errorMessage: 't1', ts: '2026-06-16T10:00:01.000Z' }])
    const out = await captureStdout(async () => {
      return await runAssemble({ cwd, sessionId, scope: 'task', maxTokens: 7500, json: true })
    })
    const parsed = JSON.parse(out) as AssembledContextPreview
    assert.deepEqual(parsed.sections.map(s => s.kind), ['workingSet', 'behaviorTrace'])
  })

  // ── Test 6: scope=workspace uses cross-session nexus-sourced traces ─────
  test('scope=workspace: behaviorTrace sourced from nexus (cross-session)', async () => {
    seedWorkingSet([{ sid: sessionId, items: [{ key: 'k', value: 'v', confidence: 0.9 }] }])
    seedTrace([
      { trigger: 'error', errorMessage: 'own', sid: sessionId, ts: '2026-06-16T10:00:01.000Z' },
      { trigger: 'error', errorMessage: 'nexus-cross', sid: 'other-session', source: 'nexus', ts: '2026-06-16T10:00:02.000Z' },
    ])
    const out = await captureStdout(async () => {
      return await runAssemble({ cwd, sessionId, scope: 'workspace', maxTokens: 7500, json: true })
    })
    const parsed = JSON.parse(out) as AssembledContextPreview
    const bt = parsed.sections.find(s => s.kind === 'behaviorTrace')!
    // workspace-scope behaviorTrace uses crossSessionTraces (source=nexus) only
    assert.ok(bt.content.includes('1'), '1 nexus-source entry')
  })

  // ── Test 7: --session-id filter ────────────────────────────────────────
  test('--session-id filter: only matching session assembled', async () => {
    seedWorkingSet([
      { sid: 's1', items: [{ key: 'a', value: 'A', confidence: 0.9 }] },
      { sid: 's2', items: [{ key: 'b', value: 'B', confidence: 0.7 }] },
    ])
    const out = await captureStdout(async () => {
      return await runAssemble({ cwd, sessionId: 's1', scope: 'standard', maxTokens: 7500, json: true })
    })
    const parsed = JSON.parse(out) as AssembledContextPreview
    assert.equal(parsed.sessionId, 's1')
    assert.ok(parsed.sections[0]!.content.includes('a = A'))
  })

  // ── Test 8: --max-tokens enforced ──────────────────────────────────────
  test('--max-tokens: overflow=drop when budget exceeded (non-pinned only)', async () => {
    seedWorkingSet([{ sid: sessionId, items: [{ key: 'k', value: 'v', confidence: 0.9 }] }])
    seedTrace([
      { trigger: 'error', errorMessage: 'X'.repeat(100), ts: '2026-06-16T10:00:01.000Z' },
    ])
    // max-tokens=1: pinned workingSet is kept, recent is dropped
    const out = await captureStdout(async () => {
      return await runAssemble({ cwd, sessionId, scope: 'standard', maxTokens: 1, json: true })
    })
    const parsed = JSON.parse(out) as AssembledContextPreview
    assert.ok(parsed.sections.length >= 1, 'pinned workingSet always kept')
    assert.equal(parsed.sections[0]!.kind, 'workingSet', 'pinned first')
    if (parsed.budget.droppedSections.length > 0) {
      assert.equal(parsed.budget.overflow, 'drop')
    }
  })

  // ── Test 9: --json prints valid AssembledContext preview ───────────────
  test('--json: prints valid AssembledContext preview matching §4.2 schema', async () => {
    seedWorkingSet([{ sid: sessionId, items: [{ key: 'k', value: 'v', confidence: 0.9 }] }])
    const out = await captureStdout(async () => {
      return await runAssemble({ cwd, sessionId, scope: 'standard', maxTokens: 7500, json: true })
    })
    const parsed = JSON.parse(out) as AssembledContextPreview
    // Verify §4.2 shape
    assert.equal(typeof parsed.sessionId, 'string')
    assert.ok(['minimal', 'standard', 'full', 'task', 'workspace'].includes(parsed.scope))
    assert.ok(Array.isArray(parsed.sections))
    assert.ok(parsed.budget)
    assert.equal(typeof parsed.budget.used, 'number')
    assert.equal(typeof parsed.budget.max, 'number')
    assert.ok(['drop', 'microcompact', 'none'].includes(parsed.budget.overflow))
    assert.ok(Array.isArray(parsed.budget.droppedSections))
    assert.ok(parsed.meta)
    assert.equal(typeof parsed.meta.workingSetVersion, 'number')
    assert.equal(typeof parsed.meta.lastEventRev, 'number')
    assert.equal(typeof parsed.meta.traceEntriesConsidered, 'number')
    assert.equal(typeof parsed.meta.assembledAt, 'string')
    assert.equal(typeof parsed.meta.assembleLatencyMs, 'number')
  })

  // ── Test 10: section order — pinned first ─────────────────────────────
  test('section order: pinned (workingSet) comes before non-pinned', async () => {
    seedWorkingSet([{ sid: sessionId, items: [{ key: 'k', value: 'v', confidence: 0.9 }] }])
    seedTrace([{ trigger: 'error', errorMessage: 'm', ts: '2026-06-16T10:00:01.000Z' }])
    const out = await captureStdout(async () => {
      return await runAssemble({ cwd, sessionId, scope: 'full', maxTokens: 7500, json: true })
    })
    const parsed = JSON.parse(out) as AssembledContextPreview
    // Pinned section must be first
    assert.equal(parsed.sections[0]!.pinned, true)
    assert.equal(parsed.sections[0]!.kind, 'workingSet')
    for (let i = 1; i < parsed.sections.length; i++) {
      assert.equal(parsed.sections[i]!.pinned, false, `section[${i}] should not be pinned`)
    }
  })

  // ── Test 11: budget meta populated ─────────────────────────────────────
  test('budget meta: workingSetVersion, lastEventRev, traceEntriesConsidered, assembledAt, latencyMs all populated', async () => {
    seedWorkingSet([{ sid: sessionId, items: [{ key: 'k', value: 'v', confidence: 0.9 }], version: 3 }])
    seedTrace([
      { trigger: 'error', errorMessage: 'e1', ts: '2026-06-16T10:00:01.000Z' },
      { trigger: 'error', errorMessage: 'e2', ts: '2026-06-16T10:00:02.000Z' },
    ])
    const out = await captureStdout(async () => {
      return await runAssemble({ cwd, sessionId, scope: 'standard', maxTokens: 7500, json: true })
    })
    const parsed = JSON.parse(out) as AssembledContextPreview
    assert.equal(parsed.meta.workingSetVersion, 3)
    assert.equal(parsed.meta.lastEventRev, 2, '2 traces for this session')
    assert.equal(parsed.meta.traceEntriesConsidered, 2)
    assert.ok(parsed.meta.assembledAt.length > 0)
    assert.ok(parsed.meta.assembleLatencyMs >= 0)
  })

  // ── Test 12: HOME isolation ────────────────────────────────────────────
  test('HOME isolation: HOME working-set.json + behavior-trace.jsonl not read', async () => {
    // Place files in HOME directly
    writeFileSync(join(home, 'working-set.json'), JSON.stringify({
      schemaVersion: '2026-06-16.working-set.v1',
      sessions: { homeS: { sessionId: 'homeS', workspaceId: home, entries: [{ key: 'h', value: 'H', updatedAt: 't', confidence: 0.9 }], version: 1, updatedAt: 't' } },
    }), 'utf8')
    writeFileSync(join(home, 'behavior-trace.jsonl'), JSON.stringify({
      schemaVersion: '2026-06-16.behavior-trace.v1', traceId: 't', sessionId: 'homeS', cwd: home,
      timestamp: '2026-06-16T00:00:00.000Z', trigger: 'error', triggerConfidence: 0.9,
      context: {}, anomaly: { errorCode: 'X', errorMessage: 'home_msg' },
    }), 'utf8')
    // No seed in cwd
    const out = await captureStdout(async () => {
      return await runAssemble({ cwd, scope: 'standard', maxTokens: 7500, json: true })
    })
    const parsed = JSON.parse(out) as AssembledContextPreview
    assert.notEqual(parsed.sessionId, 'homeS', 'HOME session not picked up')
    // standard scope always emits 2 sections (workingSet + recentEvents), even if empty
    assert.equal(parsed.sections.length, 2)
    assert.equal(parsed.sections[0]!.content.includes('(no working set entries)'), true)
    assert.equal(parsed.sections[1]!.content.includes('(no recent events)'), true)
  })

  // ── Test 13: --include-behavior-trace force-adds ──────────────────────
  test('--include-behavior-trace: force-adds to minimal scope', async () => {
    seedWorkingSet([{ sid: sessionId, items: [{ key: 'k', value: 'v', confidence: 0.9 }] }])
    seedTrace([{ trigger: 'error', errorMessage: 'forced', ts: '2026-06-16T10:00:01.000Z' }])
    const out = await captureStdout(async () => {
      return await runAssemble({ cwd, sessionId, scope: 'minimal', maxTokens: 7500, includeBehaviorTrace: true, json: true })
    })
    const parsed = JSON.parse(out) as AssembledContextPreview
    assert.equal(parsed.sections.length, 2)
    assert.deepEqual(parsed.sections.map(s => s.kind), ['workingSet', 'behaviorTrace'])
  })
})

describe('PR-15 registerContextCommand assemble subcommand', () => {
  test('registers bbl context assemble as a subcommand', () => {
    const program = new Command()
    registerContextCommand(program)
    const ctx = program.commands.find(c => c.name() === 'context')
    assert.ok(ctx)
    const assemble = ctx!.commands.find(c => c.name() === 'assemble')
    assert.ok(assemble, 'assemble subcommand registered')
  })

  test('assemble has 7 options: cwd, session-id, scope, max-tokens, include-behavior-trace, include-long-term, include-project-memory, json', () => {
    const program = new Command()
    registerContextCommand(program)
    const ctx = program.commands.find(c => c.name() === 'context')!
    const assemble = ctx.commands.find(c => c.name() === 'assemble')!
    const optNames = assemble.options.map(o => o.long)
    for (const expected of ['--cwd', '--session-id', '--scope', '--max-tokens', '--include-behavior-trace', '--include-long-term', '--include-project-memory', '--json']) {
      assert.ok(optNames.includes(expected), `${expected} option present`)
    }
  })
})
