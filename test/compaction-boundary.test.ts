import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryStorage } from '../src/storage/MemoryStorage.js'
import { compactSession } from '../src/runtime/compact.js'
import { assembleContext } from '../src/runtime/contextAssembler.js'
import { buildSystemPrompt, mapEventsToMessages } from '../src/runtime/LLMCodingRuntime.js'
import {
  formatCompactionBoundaryText,
  insertCompactionBoundaryMessage,
  resolveCompactionBoundaryMode,
} from '../src/runtime/compactionBoundaryMessage.js'
import type { ModelMessage } from '../src/providers/adapters/ModelAdapter.js'
import type { NexusEvent } from '../src/shared/events.js'

const schemaVersion = '2026-05-21.babel-o.v1' as const

describe('resolveCompactionBoundaryMode', () => {
  test('defaults to system and opts into tail only explicitly', () => {
    assert.equal(resolveCompactionBoundaryMode({}), 'system')
    assert.equal(resolveCompactionBoundaryMode({ BABEL_O_COMPACT_BOUNDARY: 'system' }), 'system')
    assert.equal(resolveCompactionBoundaryMode({ BABEL_O_COMPACT_BOUNDARY: 'tail' }), 'tail')
    assert.equal(resolveCompactionBoundaryMode({ BABEL_O_COMPACT_BOUNDARY: 'TAIL' }), 'tail')
  })
})

describe('insertCompactionBoundaryMessage guards', () => {
  const boundary = formatCompactionBoundaryText('SUMMARY')

  test('orders the boundary before the current instruction', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'old' },
      { role: 'assistant', content: 'old answer' },
      { role: 'user', content: 'CURRENT INSTRUCTION' },
    ]
    const result = insertCompactionBoundaryMessage(messages, boundary, 'CURRENT INSTRUCTION')
    assert.equal(result.inserted, true)
    assert.equal(result.reason, 'before-current-instruction')
    assert.deepEqual(result.messages.map(message => message.content), [
      'old',
      'old answer',
      boundary,
      'CURRENT INSTRUCTION',
    ])
  })

  test('deduplicates an existing boundary', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: boundary },
      { role: 'user', content: 'CURRENT INSTRUCTION' },
    ]
    const result = insertCompactionBoundaryMessage(messages, boundary, 'CURRENT INSTRUCTION')
    assert.equal(result.inserted, false)
    assert.equal(result.reason, 'duplicate')
    assert.equal(result.messages.length, 2)
  })

  test('does not split tool-result arrays', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 't1', content: 'ok' }] },
      { role: 'user', content: 'CURRENT INSTRUCTION' },
    ]
    const result = insertCompactionBoundaryMessage(messages, boundary, 'CURRENT INSTRUCTION')
    assert.equal(result.reason, 'before-current-instruction')
    assert.equal(result.messages[0]!.content instanceof Array, true)
    assert.equal(result.messages[1]!.content, boundary)
  })
})

describe('tail boundary integration', () => {
  test('moves the boundary out of the system prompt and before the instruction', async () => {
    const previous = process.env.BABEL_O_COMPACT_BOUNDARY
    process.env.BABEL_O_COMPACT_BOUNDARY = 'tail'
    try {
      const sessionId = 'session-tail-boundary'
      const storage = new MemoryStorage()
      const events: NexusEvent[] = [
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
          text: 'Old goal',
        },
        {
          type: 'assistant_delta',
          schemaVersion,
          sessionId,
          timestamp: '2026-05-23T00:00:02.000Z',
          text: 'Old answer',
        },
      ]
      await storage.saveSession({
        sessionId,
        cwd: '/tmp',
        prompt: 'Old goal',
        phase: 'executing',
        createdAt: '2026-05-23T00:00:00.000Z',
        updatedAt: '2026-05-23T00:00:00.000Z',
        events,
      })
      const compacted = await compactSession({
        storage,
        sessionId,
        modelId: 'local/coding-runtime',
        trigger: 'manual',
      })
      const current: NexusEvent = {
        type: 'user_message',
        schemaVersion,
        sessionId,
        timestamp: '2026-05-23T00:00:10.000Z',
        text: 'CURRENT INSTRUCTION',
      }
      const assembled = await assembleContext({
        runtimeOptions: { sessionId, prompt: 'CURRENT INSTRUCTION', cwd: '/tmp' },
        events: [...events, compacted.event, current],
        modelId: 'local/coding-runtime',
        buildSystemPrompt,
        mapEventsToMessages,
      })
      const contents = assembled.messages.map(message => message.content)
      const boundaryIndex = contents.findIndex(content => typeof content === 'string' && content.startsWith('Context Boundary:'))
      const promptIndex = contents.findIndex(content => content === 'CURRENT INSTRUCTION')
      assert.ok(boundaryIndex >= 0, 'tail boundary message must exist')
      assert.ok(promptIndex >= 0, 'current instruction must exist')
      assert.ok(boundaryIndex < promptIndex, 'boundary must precede the current instruction')
      assert.ok(!assembled.systemPrompt.includes(compacted.event.summary.slice(0, 40)), 'summary must not be in the system prompt')
    } finally {
      if (previous === undefined) delete process.env.BABEL_O_COMPACT_BOUNDARY
      else process.env.BABEL_O_COMPACT_BOUNDARY = previous
    }
  })
})
