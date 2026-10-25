import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryStorage } from '../src/storage/MemoryStorage.js'
import { compactSession } from '../src/runtime/compact.js'
import { mapEventsToMessages } from '../src/runtime/LLMCodingRuntime.js'
import {
  buildRetrievalIndex,
  isRetrievalCompactionEnabled,
  renderRetrievalPointers,
  searchRetrievalIndex,
} from '../src/runtime/retrievalDigest.js'
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
      toolUseId: 'read-1',
      name: 'Read',
      input: { path: 'src/a.ts' },
    },
    {
      type: 'tool_completed',
      schemaVersion,
      sessionId,
      timestamp: '2026-05-23T00:00:03.000Z',
      toolUseId: 'read-1',
      name: 'Read',
      success: true,
      output: 'export const a = 1\n',
    },
    {
      type: 'tool_started',
      schemaVersion,
      sessionId,
      timestamp: '2026-05-23T00:00:04.000Z',
      toolUseId: 'bash-1',
      name: 'Bash',
      input: { command: 'npm test' },
    },
    {
      type: 'tool_completed',
      schemaVersion,
      sessionId,
      timestamp: '2026-05-23T00:00:05.000Z',
      toolUseId: 'bash-1',
      name: 'Bash',
      success: false,
      output: 'test failed',
    },
  ]
}

describe('retrieval digest', () => {
  test('flag defaults off and opts in explicitly', () => {
    assert.equal(isRetrievalCompactionEnabled({}), false)
    assert.equal(isRetrievalCompactionEnabled({ BABEL_O_COMPACT_RETRIEVAL: 'on' }), true)
    assert.equal(isRetrievalCompactionEnabled({ BABEL_O_COMPACT_RETRIEVAL: '1' }), true)
  })

  test('indexes user turns, file accesses, and failures', () => {
    const index = buildRetrievalIndex(fixture('s'))
    const kinds = new Set(index.entries.map(entry => entry.kind))
    assert.ok(kinds.has('user'))
    assert.ok(kinds.has('file'))
    assert.ok(kinds.has('failure'))
    assert.ok(index.entries.some(entry => entry.subject === 'file:src/a.ts'))
  })

  test('search returns matching pointers and respects the limit', () => {
    const index = buildRetrievalIndex(fixture('s'))
    const byFile = searchRetrievalIndex(index, 'src/a', 2)
    assert.equal(byFile[0]?.subject, 'file:src/a.ts')
    const byUser = searchRetrievalIndex(index, 'ledger', 2)
    assert.equal(byUser[0]?.kind, 'user')
  })

  test('renders a bounded pointer block', () => {
    const index = buildRetrievalIndex(fixture('s'))
    const rendered = renderRetrievalPointers(index, 300)
    assert.ok(rendered.startsWith('## Retrieval Index (pointers only)'))
    assert.ok(rendered.length <= 340)
  })
})

describe('adaptive retrieval compaction', () => {
  test('compactSession uses pointers when BABEL_O_COMPACT_RETRIEVAL=1', async () => {
    const previousMode = process.env.BABEL_O_COMPACT_MODE
    const previousRetrieval = process.env.BABEL_O_COMPACT_RETRIEVAL
    const previousMax = process.env.BABEL_O_MAX_CONTEXT_TOKENS
    process.env.BABEL_O_COMPACT_MODE = 'adaptive'
    process.env.BABEL_O_COMPACT_RETRIEVAL = '1'
    process.env.BABEL_O_MAX_CONTEXT_TOKENS = '90000'
    try {
      const sessionId = 'session-retrieval'
      const storage = new MemoryStorage()
      const base = fixture(sessionId)
      const huge: NexusEvent = {
        type: 'assistant_delta',
        schemaVersion,
        sessionId,
        timestamp: '2026-05-23T00:00:01.500Z',
        text: 'x'.repeat(80_000),
      }
      const tail: NexusEvent[] = Array.from({ length: 4 }, (_, index) => ({
        type: 'user_message' as const,
        schemaVersion,
        sessionId,
        timestamp: `2026-05-23T00:00:${String(20 + index).padStart(2, '0')}.000Z`,
        text: `follow-up ${index}`,
      }))
      await storage.saveSession({
        sessionId,
        cwd: '/tmp',
        prompt: 'retrieval',
        phase: 'executing',
        createdAt: '2026-05-23T00:00:00.000Z',
        updatedAt: '2026-05-23T00:00:00.000Z',
        events: [base[0]!, base[1]!, huge, ...base.slice(2), ...tail],
      })
      const result = await compactSession({
        storage,
        sessionId,
        modelId: 'deepseek/deepseek-v4-flash',
        trigger: 'auto',
        mapEventsToMessages,
      })
      assert.ok(result.event.summary.startsWith('## Retrieval Index (pointers only)'))
      assert.equal(result.event.summaryInputTokens, undefined)
      assert.ok(result.event.summary.includes('[user]'))
    } finally {
      if (previousMode === undefined) delete process.env.BABEL_O_COMPACT_MODE
      else process.env.BABEL_O_COMPACT_MODE = previousMode
      if (previousRetrieval === undefined) delete process.env.BABEL_O_COMPACT_RETRIEVAL
      else process.env.BABEL_O_COMPACT_RETRIEVAL = previousRetrieval
      if (previousMax === undefined) delete process.env.BABEL_O_MAX_CONTEXT_TOKENS
      else process.env.BABEL_O_MAX_CONTEXT_TOKENS = previousMax
    }
  })
})
