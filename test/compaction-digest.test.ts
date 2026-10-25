import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryStorage } from '../src/storage/MemoryStorage.js'
import { compactSession } from '../src/runtime/compact.js'
import { allocateBudget } from '../src/runtime/contextAssembler.js'
import {
  buildDeterministicDigest,
  mergeDigests,
  renderDigest,
} from '../src/runtime/compactionDigest.js'
import { mapEventsToMessages } from '../src/runtime/LLMCodingRuntime.js'
import type { NexusEvent } from '../src/shared/events.js'

const schemaVersion = '2026-05-21.babel-o.v1' as const

function fixture(sessionId: string): NexusEvent[] {
  return [
    {
      type: 'session_started',
      schemaVersion,
      sessionId,
      timestamp: '2026-05-23T00:00:00.000Z',
      cwd: '/tmp',
    },
    {
      type: 'user_message',
      schemaVersion,
      sessionId,
      timestamp: '2026-05-23T00:00:01.000Z',
      text: 'Implement the ledger in src/a.ts',
    },
    {
      type: 'tool_started',
      schemaVersion,
      sessionId,
      timestamp: '2026-05-23T00:00:02.000Z',
      toolUseId: 'write-1',
      name: 'Write',
      input: { path: 'src/a.ts' },
    },
    {
      type: 'tool_completed',
      schemaVersion,
      sessionId,
      timestamp: '2026-05-23T00:00:03.000Z',
      toolUseId: 'write-1',
      name: 'Write',
      success: true,
      output: 'written',
    },
    {
      type: 'tool_started',
      schemaVersion,
      sessionId,
      timestamp: '2026-05-23T00:00:04.000Z',
      toolUseId: 'read-1',
      name: 'Read',
      input: { path: 'src/a.ts' },
    },
    {
      type: 'tool_completed',
      schemaVersion,
      sessionId,
      timestamp: '2026-05-23T00:00:05.000Z',
      toolUseId: 'read-1',
      name: 'Read',
      success: true,
      output: 'export const a = 1\n',
    },
    {
      type: 'tool_started',
      schemaVersion,
      sessionId,
      timestamp: '2026-05-23T00:00:06.000Z',
      toolUseId: 'bash-1',
      name: 'Bash',
      input: { command: 'npm test' },
    },
    {
      type: 'tool_completed',
      schemaVersion,
      sessionId,
      timestamp: '2026-05-23T00:00:07.000Z',
      toolUseId: 'bash-1',
      name: 'Bash',
      success: false,
      output: '1 test failed',
    },
    {
      type: 'user_message',
      schemaVersion,
      sessionId,
      timestamp: '2026-05-23T00:00:08.000Z',
      text: 'Now write test.mjs',
    },
  ]
}

describe('buildDeterministicDigest', () => {
  test('extracts contracts, artifacts, facts, and failures without an LLM', () => {
    const digest = buildDeterministicDigest(fixture('session-digest'))
    const kinds = new Set(digest.records.map(record => record.kind))
    assert.ok(kinds.has('contract'))
    assert.ok(kinds.has('artifact'))
    assert.ok(kinds.has('fact'))
    assert.ok(kinds.has('failure'))
    const fact = digest.records.find(record => record.kind === 'fact')
    assert.equal(fact?.subject, 'file:src/a.ts')
    assert.equal(fact?.evidence.sha256?.length, 64)
    assert.equal(fact?.evidence.type, 'tool')
  })

  test('bounds the record count', () => {
    const events: NexusEvent[] = []
    for (let index = 0; index < 20; index += 1) {
      events.push({
        type: 'tool_started',
        schemaVersion,
        sessionId: 'session-bounded',
        timestamp: `2026-05-23T00:00:${String(index * 2).padStart(2, '0')}.000Z`,
        toolUseId: `read-${index}`,
        name: 'Read',
        input: { path: `src/f${index}.ts` },
      })
      events.push({
        type: 'tool_completed',
        schemaVersion,
        sessionId: 'session-bounded',
        timestamp: `2026-05-23T00:00:${String(index * 2 + 1).padStart(2, '0')}.000Z`,
        toolUseId: `read-${index}`,
        name: 'Read',
        success: true,
        output: `content ${index}`,
      })
    }
    const digest = buildDeterministicDigest(events, { maxRecords: 8 })
    assert.equal(digest.records.length, 8)
  })
})

describe('mergeDigests', () => {
  test('is idempotent and deduplicates by subject', () => {
    const a = buildDeterministicDigest(fixture('session-merge-a'))
    const b = buildDeterministicDigest(fixture('session-merge-b'))
    const once = mergeDigests(a, b)
    const twice = mergeDigests(once, b)
    assert.deepEqual(twice, once)
    const subjects = once.records.map(record => record.subject)
    assert.equal(new Set(subjects).size, subjects.length)
  })
})

describe('renderDigest', () => {
  test('renders a bounded deterministic block', () => {
    const digest = buildDeterministicDigest(fixture('session-render'))
    const rendered = renderDigest(digest, 240)
    assert.ok(rendered.startsWith('## Compaction Digest (deterministic)'))
    assert.ok(rendered.length <= 280, `rendered length ${rendered.length}`)
    assert.ok(rendered.includes('[contract]') || rendered.includes('[fact]'))
  })
})

describe('adaptive compaction uses the digest', () => {
  test('compactSession adaptive bypasses the provider and writes a digest summary', async () => {
    const previousMode = process.env.BABEL_O_COMPACT_MODE
    const previousMax = process.env.BABEL_O_MAX_CONTEXT_TOKENS
    process.env.BABEL_O_COMPACT_MODE = 'adaptive'
    process.env.BABEL_O_MAX_CONTEXT_TOKENS = '90000'
    try {
      const sessionId = 'session-adaptive-digest'
      const storage = new MemoryStorage()
      await storage.saveSession({
        sessionId,
        cwd: '/tmp',
        prompt: 'digest',
        phase: 'executing',
        createdAt: '2026-05-23T00:00:00.000Z',
        updatedAt: '2026-05-23T00:00:00.000Z',
        events: fixture(sessionId),
      })
      const tail: NexusEvent[] = Array.from({ length: 4 }, (_, index) => ({
        type: 'user_message' as const,
        schemaVersion,
        sessionId,
        timestamp: `2026-05-23T00:00:${String(20 + index).padStart(2, '0')}.000Z`,
        text: `follow-up ${index}`,
      }))
      const base = fixture(sessionId)
      const hugeDelta: NexusEvent = {
        type: 'assistant_delta',
        schemaVersion,
        sessionId,
        timestamp: '2026-05-23T00:00:01.500Z',
        text: 'x'.repeat(80_000),
      }
      await storage.saveSession({
        sessionId,
        cwd: '/tmp',
        prompt: 'digest',
        phase: 'executing',
        createdAt: '2026-05-23T00:00:00.000Z',
        updatedAt: '2026-05-23T00:00:00.000Z',
        events: [base[0]!, base[1]!, hugeDelta, ...base.slice(2), ...tail],
      })
      const result = await compactSession({
        storage,
        sessionId,
        modelId: 'deepseek/deepseek-v4-flash',
        trigger: 'auto',
        mapEventsToMessages,
      })
      assert.ok(result.event.summary.startsWith('## Compaction Digest (deterministic)'))
      assert.equal(result.event.summaryInputTokens, undefined)
      assert.equal(result.event.summaryOutputTokens, undefined)
      assert.ok(result.event.summary.includes('[contract]'))
    } finally {
      if (previousMode === undefined) delete process.env.BABEL_O_COMPACT_MODE
      else process.env.BABEL_O_COMPACT_MODE = previousMode
      if (previousMax === undefined) delete process.env.BABEL_O_MAX_CONTEXT_TOKENS
      else process.env.BABEL_O_MAX_CONTEXT_TOKENS = previousMax
    }
  })
})

describe('adaptive summary budget', () => {
  test('scales the summary layer with the window and keeps stock at 4k', () => {
    const previousMode = process.env.BABEL_O_COMPACT_MODE
    const previousMax = process.env.BABEL_O_MAX_CONTEXT_TOKENS
    delete process.env.BABEL_O_MAX_CONTEXT_TOKENS
    try {
      delete process.env.BABEL_O_COMPACT_MODE
      assert.equal(allocateBudget('anthropic/claude-3-5-sonnet').layerBudgets.summary, 4_000)
      process.env.BABEL_O_COMPACT_MODE = 'adaptive'
      const adaptive = allocateBudget('anthropic/claude-3-5-sonnet')
      assert.ok(adaptive.layerBudgets.summary > 4_000)
      assert.ok(adaptive.layerBudgets.summary <= 12_000)
    } finally {
      if (previousMode === undefined) delete process.env.BABEL_O_COMPACT_MODE
      else process.env.BABEL_O_COMPACT_MODE = previousMode
      if (previousMax === undefined) delete process.env.BABEL_O_MAX_CONTEXT_TOKENS
      else process.env.BABEL_O_MAX_CONTEXT_TOKENS = previousMax
    }
  })
})
