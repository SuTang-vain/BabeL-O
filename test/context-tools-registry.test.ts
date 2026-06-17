// test/context-tools-registry.test.ts
//
// PR-8 unit tests: context tool registration in ToolRegistry.
// Covers: 3 tools present in registry, execute returns correct ToolResult,
// 5k cap, isolation.

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

import { createDefaultToolRegistry } from '../src/tools/registry.js'
import { MemoryStorage } from '../src/storage/MemoryStorage.js'
import { NEXUS_EVENT_SCHEMA_VERSION, type NexusEvent } from '../src/shared/events.js'
import { BEHAVIOR_TRACE_RELATIVE_PATH } from '../src/runtime/behaviorTrace.js'

const ORIGINAL_ENV: Record<string, string | undefined> = {}

describe('PR-8 registry registration', () => {
  test('3 context tools are in the default registry', () => {
    const reg = createDefaultToolRegistry()
    assert.ok(reg.has('contextSearch'), 'contextSearch registered')
    assert.ok(reg.has('contextSummarize'), 'contextSummarize registered')
    assert.ok(reg.has('contextRecent'), 'contextRecent registered')
  })

  test('3 context tools have risk=read and source=builtin', () => {
    const reg = createDefaultToolRegistry()
    for (const name of ['contextSearch', 'contextSummarize', 'contextRecent']) {
      const tool = reg.get(name)!
      assert.equal(tool.risk, 'read', `${name} risk=read`)
      assert.deepEqual(tool.source, { type: 'builtin' }, `${name} source=builtin`)
      assert.equal(tool.requiresApproval, false, `${name} requiresApproval=false`)
    }
  })
})

describe('PR-8 contextSearchTool.execute', () => {
  let cwd: string
  let storage: MemoryStorage
  const sessionId = `cs-${randomUUID()}`

  beforeEach(async () => {
    cwd = mkdtempSync(join(tmpdir(), 'babel-o-cs-'))
    storage = new MemoryStorage()
    for (const key of ['HOME', 'BABEL_O_TEST_CONFIG_WRITE_GUARD']) {
      ORIGINAL_ENV[key] = process.env[key]
    }
    process.env.HOME = cwd
    process.env.BABEL_O_TEST_CONFIG_WRITE_GUARD = '1'

    // Seed events
    await storage.saveSession({
      sessionId, cwd, prompt: 'test', phase: 'executing',
      createdAt: '2026-06-16T00:00:00.000Z',
      updatedAt: '2026-06-16T00:00:00.000Z',
      events: [
        { type: 'session_started', schemaVersion: NEXUS_EVENT_SCHEMA_VERSION, sessionId, timestamp: '2026-06-16T10:00:00.000Z', cwd },
        { type: 'user_message', schemaVersion: NEXUS_EVENT_SCHEMA_VERSION, sessionId, timestamp: '2026-06-16T10:00:01.000Z', text: 'check sessionMemoryLite' },
        { type: 'tool_started', schemaVersion: NEXUS_EVENT_SCHEMA_VERSION, sessionId, timestamp: '2026-06-16T10:00:02.000Z', toolUseId: 'tu_1', name: 'Read', input: { path: '/repo/src/runtime/sessionMemoryLite.ts' } },
        { type: 'error', schemaVersion: NEXUS_EVENT_SCHEMA_VERSION, sessionId, timestamp: '2026-06-16T10:00:03.000Z', code: 'TOOL_NOT_FOUND', message: 'file not found' },
      ],
    })
  })

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true })
    for (const [key, val] of Object.entries(ORIGINAL_ENV)) {
      if (val === undefined) delete process.env[key]
      else process.env[key] = val
    }
  })

  test('execute returns hits for matching query', async () => {
    const reg = createDefaultToolRegistry()
    const tool = reg.get('contextSearch')!
    const result = await tool.execute({ query: 'sessionMemoryLite' }, {
      cwd, sessionId, maxOutputBytes: 1_000_000, bashMaxBufferBytes: 1_000_000, storage,
    })
    assert.equal(result.success, true)
    const out = result.output as { hitCount: number; content: string; truncated: boolean; tokenEstimate: number }
    assert.ok(out.hitCount >= 2, `expected ≥2 hits, got ${out.hitCount}`)
    assert.ok(out.content.includes('sessionMemoryLite'))
  })

  test('execute returns 0 hits for no match', async () => {
    const reg = createDefaultToolRegistry()
    const tool = reg.get('contextSearch')!
    const result = await tool.execute({ query: 'nonexistent-xyz' }, {
      cwd, sessionId, maxOutputBytes: 1_000_000, bashMaxBufferBytes: 1_000_000, storage,
    })
    const out = result.output as { hitCount: number }
    assert.equal(out.hitCount, 0)
  })

  test('execute without storage returns success=false', async () => {
    const reg = createDefaultToolRegistry()
    const tool = reg.get('contextSearch')!
    const result = await tool.execute({ query: 'x' }, {
      cwd, sessionId, maxOutputBytes: 1_000_000, bashMaxBufferBytes: 1_000_000, // no storage
    })
    assert.equal(result.success, false)
  })
})

describe('PR-8 contextRecentTool.execute', () => {
  let cwd: string
  let storage: MemoryStorage
  const sessionId = `cr-${randomUUID()}`

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'babel-o-cr-'))
    storage = new MemoryStorage()
  })

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true })
  })

  test('execute returns last N events', async () => {
    await storage.saveSession({
      sessionId, cwd, prompt: 'test', phase: 'executing',
      createdAt: '2026-06-16T00:00:00.000Z', updatedAt: '2026-06-16T00:00:00.000Z',
      events: [
        { type: 'session_started', schemaVersion: NEXUS_EVENT_SCHEMA_VERSION, sessionId, timestamp: '2026-06-16T10:00:00.000Z', cwd },
        { type: 'user_message', schemaVersion: NEXUS_EVENT_SCHEMA_VERSION, sessionId, timestamp: '2026-06-16T10:00:01.000Z', text: 'first' },
        { type: 'user_message', schemaVersion: NEXUS_EVENT_SCHEMA_VERSION, sessionId, timestamp: '2026-06-16T10:00:02.000Z', text: 'second' },
        { type: 'user_message', schemaVersion: NEXUS_EVENT_SCHEMA_VERSION, sessionId, timestamp: '2026-06-16T10:00:03.000Z', text: 'third' },
      ],
    })
    const reg = createDefaultToolRegistry()
    const tool = reg.get('contextRecent')!
    const result = await tool.execute({ n: 2 }, {
      cwd, sessionId, maxOutputBytes: 1_000_000, bashMaxBufferBytes: 1_000_000, storage,
    })
    const out = result.output as { hitCount: number; content: string }
    assert.equal(out.hitCount, 2)
    assert.ok(out.content.includes('third'), 'newest event included')
    assert.ok(out.content.includes('second'))
    assert.ok(!out.content.includes('first'), 'oldest event excluded')
  })
})

describe('PR-8 contextSummarizeTool.execute', () => {
  let cwd: string
  const sessionId = `csm-${randomUUID()}`

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'babel-o-csm-'))
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

  test('execute returns empty result when no trace file', async () => {
    const reg = createDefaultToolRegistry()
    const tool = reg.get('contextSummarize')!
    const result = await tool.execute({}, {
      cwd, sessionId, maxOutputBytes: 1_000_000, bashMaxBufferBytes: 1_000_000,
    })
    assert.equal(result.success, true)
    const out = result.output as { content: string; hitCount: number }
    assert.equal(out.hitCount, 0)
  })

  test('execute reads and summarizes trace entries', async () => {
    // Seed a trace file
    const traceDir = join(cwd, '.babel-o')
    mkdirSync(traceDir, { recursive: true })
    const tracePath = join(traceDir, 'behavior-trace.jsonl')
    const entries = [
      { schemaVersion: '2026-06-16.behavior-trace.v1', traceId: 't1', sessionId, cwd, timestamp: '2026-06-16T10:00:01.000Z', trigger: 'error', triggerConfidence: 0.9, context: { recentEvents: [], toolSequence: [], fileRefStack: [], userIntentGuidance: '', retryCount: 0, timeInSessionMs: 0, tokensSinceLastTrace: 0 }, anomaly: { errorCode: 'TOOL_NOT_FOUND', errorMessage: 'first' } },
      { schemaVersion: '2026-06-16.behavior-trace.v1', traceId: 't2', sessionId, cwd, timestamp: '2026-06-16T10:00:02.000Z', trigger: 'denial', triggerConfidence: 0.95, context: { recentEvents: [], toolSequence: [], fileRefStack: [], userIntentGuidance: '', retryCount: 0, timeInSessionMs: 0, tokensSinceLastTrace: 0 }, anomaly: { denialReason: 'protected_path' } },
    ]
    writeFileSync(tracePath, entries.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8')

    const reg = createDefaultToolRegistry()
    const tool = reg.get('contextSummarize')!
    const result = await tool.execute({}, {
      cwd, sessionId, maxOutputBytes: 1_000_000, bashMaxBufferBytes: 1_000_000,
    })
    assert.equal(result.success, true)
    const out = result.output as { hitCount: number; content: string }
    assert.equal(out.hitCount, 2)
    assert.ok(out.content.includes('error'))
    assert.ok(out.content.includes('denial'))
  })
})
