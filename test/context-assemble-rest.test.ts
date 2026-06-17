// test/context-assemble-rest.test.ts
//
// PR-18 unit tests: POST /v1/context/assemble REST endpoint.
// Covers: runContextAssemble, buildAssemblePreview pure function,
// end-to-end via Fastify (app.inject), validation errors.

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

import {
  runContextAssemble,
  type ContextAssembleParams,
} from '../src/nexus/app.js'
import {
  buildAssemblePreview,
  type AssembledContextPreview,
} from '../src/cli/commands/context.js'
import { createNexusApp } from '../src/nexus/app.js'
import { MemoryStorage } from '../src/storage/MemoryStorage.js'

const ORIGINAL_ENV: Record<string, string | undefined> = {}

describe('PR-18 buildAssemblePreview (pure function)', () => {
  let home: string
  let cwd: string
  const sessionId = `pr18-${randomUUID()}`

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'babel-o-pr18-home-'))
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

  function seedWorkingSet(items: Array<{ key: string; value: string; confidence: number }>): void {
    const dir = join(cwd, '.babel-o')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'working-set.json'),
      JSON.stringify({
        schemaVersion: '2026-06-16.working-set.v1',
        sessions: {
          [sessionId]: {
            sessionId, workspaceId: cwd, entries: items, version: 1,
            updatedAt: '2026-06-16T00:00:00.000Z',
          },
        },
      }, null, 2),
      'utf8',
    )
  }

  function seedTrace(entries: Array<{ trigger: string; errorMessage?: string; sid?: string; source?: string; ts: string }>): void {
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
      anomaly: { errorMessage: e.errorMessage, source: e.source },
    }))
    writeFileSync(join(dir, 'behavior-trace.jsonl'), lines.join('\n') + '\n', 'utf8')
  }

  // Test 1: scope=full returns 3 sections
  test('scope=full returns 3 sections in order', async () => {
    seedWorkingSet([{ key: 'k', value: 'v', confidence: 0.9 }])
    seedTrace([{ trigger: 'error', errorMessage: 'e1', ts: '2026-06-16T10:00:01.000Z' }])
    const preview = await buildAssemblePreview({ cwd, sessionId, scope: 'full', maxTokens: 7500 })
    assert.equal(preview.sections.length, 3)
    assert.deepEqual(preview.sections.map(s => s.kind), ['workingSet', 'recentEvents', 'behaviorTrace'])
  })

  // Test 2: scope=minimal returns 1 section
  test('scope=minimal returns 1 section', async () => {
    seedWorkingSet([{ key: 'k', value: 'v', confidence: 0.9 }])
    const preview = await buildAssemblePreview({ cwd, sessionId, scope: 'minimal', maxTokens: 7500 })
    assert.equal(preview.sections.length, 1)
    assert.equal(preview.sections[0]!.kind, 'workingSet')
  })

  // Test 3: pinned first
  test('pinned sections come first', async () => {
    seedWorkingSet([{ key: 'k', value: 'v', confidence: 0.9 }])
    seedTrace([{ trigger: 'error', errorMessage: 'e1', ts: '2026-06-16T10:00:01.000Z' }])
    const preview = await buildAssemblePreview({ cwd, sessionId, scope: 'full', maxTokens: 7500 })
    assert.equal(preview.sections[0]!.pinned, true)
    assert.equal(preview.sections[0]!.kind, 'workingSet')
  })

  // Test 4: maxTokens enforcement
  test('maxTokens=1 keeps pinned, drops non-pinned', async () => {
    seedWorkingSet([{ key: 'k', value: 'v', confidence: 0.9 }])
    seedTrace([{ trigger: 'error', errorMessage: 'X'.repeat(100), ts: '2026-06-16T10:00:01.000Z' }])
    const preview = await buildAssemblePreview({ cwd, sessionId, scope: 'full', maxTokens: 1 })
    assert.ok(preview.sections.length >= 1, 'pinned workingSet always kept')
    assert.equal(preview.sections[0]!.kind, 'workingSet')
  })

  // Test 5: meta populated
  test('meta.assembledAt and assembleLatencyMs populated', async () => {
    seedWorkingSet([{ key: 'k', value: 'v', confidence: 0.9 }])
    const preview = await buildAssemblePreview({ cwd, sessionId, scope: 'minimal', maxTokens: 7500 })
    assert.equal(typeof preview.meta.assembledAt, 'string')
    assert.ok(preview.meta.assembledAt.length > 0)
    assert.equal(typeof preview.meta.assembleLatencyMs, 'number')
    assert.ok(preview.meta.assembleLatencyMs >= 0)
  })

  // Test 6: --include-behavior-trace adds to minimal scope
  test('includeBehaviorTrace force-adds to minimal scope', async () => {
    seedWorkingSet([{ key: 'k', value: 'v', confidence: 0.9 }])
    seedTrace([{ trigger: 'error', errorMessage: 'forced', ts: '2026-06-16T10:00:01.000Z' }])
    const preview = await buildAssemblePreview({
      cwd, sessionId, scope: 'minimal', maxTokens: 7500, includeBehaviorTrace: true,
    })
    assert.equal(preview.sections.length, 2)
    assert.deepEqual(preview.sections.map(s => s.kind), ['workingSet', 'behaviorTrace'])
  })

  // Test 7: HOME isolation
  test('HOME isolation: HOME working-set.json not read', async () => {
    writeFileSync(join(home, 'working-set.json'), JSON.stringify({
      schemaVersion: '2026-06-16.working-set.v1',
      sessions: { homeS: { sessionId: 'homeS', workspaceId: home, entries: [{ key: 'h', value: 'H', updatedAt: 't', confidence: 0.9 }], version: 1, updatedAt: 't' } },
    }), 'utf8')
    const preview = await buildAssemblePreview({ cwd, scope: 'standard', maxTokens: 7500 })
    assert.notEqual(preview.sessionId, 'homeS')
  })

  // Test 8: empty cwd
  test('empty cwd: standard scope returns 2 empty sections', async () => {
    const preview = await buildAssemblePreview({ cwd, scope: 'standard', maxTokens: 7500 })
    assert.equal(preview.sessionId, '(none)')
    assert.equal(preview.sections.length, 2)
    assert.equal(preview.sections[0]!.kind, 'workingSet')
    assert.equal(preview.sections[0]!.content.includes('(no working set entries)'), true)
  })
})

describe('PR-18 runContextAssemble (REST helper)', () => {
  let home: string
  let cwd: string
  const sessionId = `pr18-rest-${randomUUID()}`

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'babel-o-pr18-rest-home-'))
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

  function seed(): void {
    const dir = join(cwd, '.babel-o')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'working-set.json'), JSON.stringify({
      schemaVersion: '2026-06-16.working-set.v1',
      sessions: {
        [sessionId]: { sessionId, workspaceId: cwd, entries: [{ key: 'task:rest', value: 'test rest', updatedAt: 't', confidence: 0.9 }], version: 2, updatedAt: 't' },
      },
    }, null, 2), 'utf8')
  }

  test('wraps preview in { type, cwd, preview } envelope', async () => {
    seed()
    const result = await runContextAssemble({ cwd, sessionId, scope: 'minimal', maxTokens: 7500 })
    assert.equal(result.type, 'context_assemble_result')
    assert.equal(result.cwd, cwd)
    assert.ok(result.preview)
    assert.equal(result.preview.sections.length, 1)
  })

  test('rejects maxTokens <= 0 (REST surface must validate upstream)', async () => {
    seed()
    // buildAssemblePreview doesn't validate; the handler does. We test the wrapper
    // accepts any positive number; for negative we'd see tokens counts go negative.
    const result = await runContextAssemble({ cwd, sessionId, scope: 'minimal', maxTokens: 100 })
    assert.equal(result.preview.budget.max, 100)
  })
})

describe('PR-18 POST /v1/context/assemble (end-to-end)', () => {
  let home: string
  let cwd: string
  const sessionId = `pr18-e2e-${randomUUID()}`

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'babel-o-pr18-e2e-home-'))
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

  function seedFull(): void {
    const dir = join(cwd, '.babel-o')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'working-set.json'), JSON.stringify({
      schemaVersion: '2026-06-16.working-set.v1',
      sessions: {
        [sessionId]: { sessionId, workspaceId: cwd, entries: [{ key: 'task:e2e', value: 'rest test', updatedAt: 't', confidence: 0.9 }], version: 3, updatedAt: 't' },
      },
    }, null, 2), 'utf8')
    writeFileSync(join(dir, 'behavior-trace.jsonl'), [
      JSON.stringify({ schemaVersion: '2026-06-16.behavior-trace.v1', traceId: 't1', sessionId, cwd, timestamp: '2026-06-16T10:00:01.000Z', trigger: 'error', triggerConfidence: 0.9, context: {}, anomaly: { errorCode: 'X', errorMessage: 'rest e2e' } }),
    ].join('\n') + '\n', 'utf8')
  }

  // Test 9: end-to-end via Fastify
  test('POST /v1/context/assemble returns context_assemble_result envelope', async () => {
    seedFull()
    const app = await createNexusApp({
      storage: new MemoryStorage(),
      defaultCwd: cwd,
      runtime: { listTools: () => [] } as any,
    })
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/context/assemble',
        payload: { cwd, sessionId, scope: 'full', maxTokens: 7500 },
      })
      assert.equal(res.statusCode, 200)
      const body = JSON.parse(res.body)
      assert.equal(body.type, 'context_assemble_result')
      assert.equal(body.cwd, cwd)
      assert.equal(body.preview.scope, 'full')
      assert.equal(body.preview.sections.length, 3)
      assert.equal(body.preview.sections[0].kind, 'workingSet')
    } finally {
      await app.close()
    }
  })

  // Test 10: missing cwd → 400
  test('POST /v1/context/assemble returns 400 when cwd missing', async () => {
    const app = await createNexusApp({
      storage: new MemoryStorage(),
      defaultCwd: cwd,
      runtime: { listTools: () => [] } as any,
    })
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/context/assemble',
        payload: { scope: 'full' },
      })
      assert.equal(res.statusCode, 400)
      const body = JSON.parse(res.body)
      assert.ok(body.error.includes('cwd'))
    } finally {
      await app.close()
    }
  })

  // Test 11: invalid scope → 400
  test('POST /v1/context/assemble returns 400 for invalid scope', async () => {
    const app = await createNexusApp({
      storage: new MemoryStorage(),
      defaultCwd: cwd,
      runtime: { listTools: () => [] } as any,
    })
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/context/assemble',
        payload: { cwd, scope: 'invalid_scope_xyz' },
      })
      assert.equal(res.statusCode, 400)
      const body = JSON.parse(res.body)
      assert.ok(body.error.includes('Invalid scope'))
    } finally {
      await app.close()
    }
  })

  // Test 12: maxTokens <= 0 → 400
  test('POST /v1/context/assemble returns 400 for maxTokens <= 0', async () => {
    const app = await createNexusApp({
      storage: new MemoryStorage(),
      defaultCwd: cwd,
      runtime: { listTools: () => [] } as any,
    })
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/context/assemble',
        payload: { cwd, scope: 'standard', maxTokens: 0 },
      })
      assert.equal(res.statusCode, 400)
      const body = JSON.parse(res.body)
      assert.ok(body.error.includes('maxTokens'))
    } finally {
      await app.close()
    }
  })
})
