import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryStorage } from '../src/storage/MemoryStorage.js'
import { compactSession } from '../src/runtime/compact.js'
import { assembleContext } from '../src/runtime/contextAssembler.js'
import { buildSystemPrompt, mapEventsToMessages } from '../src/runtime/LLMCodingRuntime.js'
import { estimateContextTokens } from '../src/runtime/tokenEstimator.js'
import { queryModelTextWithUsage } from '../src/runtime/compactSummary.js'
import type { NexusEvent } from '../src/shared/events.js'
import type { ModelAdapter } from '../src/providers/adapters/ModelAdapter.js'

const schemaVersion = '2026-05-21.babel-o.v1' as const

function sessionWithManyEvents(sessionId: string, deltaCount: number): NexusEvent[] {
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
      text: 'Step 0 instruction',
    },
  ]
  let second = 2
  const timestamp = () => {
    const value = `2026-05-23T00:${String(Math.floor(second / 60)).padStart(2, '0')}:${String(second % 60).padStart(2, '0')}.000Z`
    second += 1
    return value
  }
  for (let index = 0; index < deltaCount; index += 1) {
    events.push({
      type: 'assistant_delta',
      schemaVersion,
      sessionId,
      timestamp: timestamp(),
      text: `delta-${index}`,
    })
  }
  events.push({
    type: 'user_message',
    schemaVersion,
    sessionId,
    timestamp: timestamp(),
    text: 'Previous instruction',
  })
  events.push({
    type: 'assistant_delta',
    schemaVersion,
    sessionId,
    timestamp: timestamp(),
    text: 'previous answer',
  })
  events.push({
    type: 'user_message',
    schemaVersion,
    sessionId,
    timestamp: timestamp(),
    text: 'CURRENT INSTRUCTION',
  })
  return events
}

async function saveSession(storage: MemoryStorage, sessionId: string, events: NexusEvent[]): Promise<void> {
  await storage.saveSession({
    sessionId,
    cwd: '/tmp',
    prompt: 'benchmark',
    phase: 'executing',
    createdAt: '2026-05-23T00:00:00.000Z',
    updatedAt: '2026-05-23T00:00:00.000Z',
    events,
  })
}

describe('compaction window invariants', () => {
  test('keeps the current user message when the session exceeds 10k events', async () => {
    const sessionId = 'session-compact-window-10k'
    const storage = new MemoryStorage()
    const events = sessionWithManyEvents(sessionId, 10_050)
    await saveSession(storage, sessionId, events)

    const result = await compactSession({
      storage,
      sessionId,
      modelId: 'local/coding-runtime',
      trigger: 'auto',
    })

    const retained = (result.event.retainedEvents ?? []) as NexusEvent[]
    const retainedUserMessages = retained
      .filter(event => event.type === 'user_message')
      .map(event => event.text)

    assert.ok(
      retainedUserMessages.includes('CURRENT INSTRUCTION'),
      'the current user instruction must survive compaction',
    )
    assert.ok(
      !retainedUserMessages.includes('Step 0 instruction'),
      'the window must not be anchored to the oldest loaded events',
    )
    assert.ok(retained.length < 500, `retained window should be bounded, got ${retained.length}`)
  })
})

describe('compaction ledger', () => {
  test('preTokens uses the same message estimate as the trigger', async () => {
    const sessionId = 'session-compact-ledger'
    const storage = new MemoryStorage()
    const events = sessionWithManyEvents(sessionId, 20)
    await saveSession(storage, sessionId, events)

    const expected = estimateContextTokens({
      messages: mapEventsToMessages(events, 'CURRENT INSTRUCTION'),
    }).totalTokens

    const result = await compactSession({
      storage,
      sessionId,
      modelId: 'local/coding-runtime',
      trigger: 'auto',
      initialPrompt: 'CURRENT INSTRUCTION',
      mapEventsToMessages,
    })

    assert.equal(result.event.preTokens, expected)
    assert.ok(
      (result.event.preTokens ?? 0) < 20_000,
      'delta event metadata must not inflate the ledger',
    )
  })
})

describe('summary/state layer budgets', () => {
  test('keeps the post-compact state block when the prose summary exceeds the layer budget', async () => {
    const sessionId = 'session-compact-state-budget'
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
        text: 'Read the file',
      },
      {
        type: 'tool_started',
        schemaVersion,
        sessionId,
        timestamp: '2026-05-23T00:00:02.000Z',
        toolUseId: 'read-1',
        name: 'Read',
        input: { path: 'src/important.ts' },
      },
      {
        type: 'tool_completed',
        schemaVersion,
        sessionId,
        timestamp: '2026-05-23T00:00:03.000Z',
        toolUseId: 'read-1',
        name: 'Read',
        success: true,
        output: `export const important = 1\n${'x'.repeat(20_000)}`,
      },
    ]
    await saveSession(storage, sessionId, events)

    const compacted = await compactSession({
      storage,
      sessionId,
      modelId: 'local/coding-runtime',
      trigger: 'auto',
    })
    const hugeBoundary = {
      ...compacted.event,
      summary: `HEAD_MARKER\n${'s'.repeat(40_000)}`,
      summaryChars: 40_000,
    }

    const assembled = await assembleContext({
      runtimeOptions: {
        sessionId,
        prompt: 'Continue after compact',
        cwd: '/tmp',
      },
      events: [...events, hugeBoundary],
      modelId: 'local/coding-runtime',
      buildSystemPrompt,
      mapEventsToMessages,
    })

    assert.ok(assembled.sessionSummary.includes('HEAD_MARKER'), 'the retained summary prose should be present')
    assert.ok(
      assembled.sessionSummary.includes('Post-Compact State'),
      'the post-compact state block must not be head-truncated',
    )
    assert.ok(
      assembled.sessionSummary.includes('src/important.ts'),
      'the restored file reference should survive the layer budget',
    )
  })
})

describe('summary usage accounting', () => {
  test('queryModelTextWithUsage returns provider-reported usage', async () => {
    const adapter: ModelAdapter = {
      async *queryStream() {
        yield { type: 'text' as const, text: 'summary text' }
        yield { type: 'usage' as const, inputTokens: 17, outputTokens: 5 }
      },
    }
    const result = await queryModelTextWithUsage(adapter, {
      model: 'test-model',
      messages: [{ role: 'user', content: 'summarize' }],
    })
    assert.deepEqual(result, {
      text: 'summary text',
      usage: { inputTokens: 17, outputTokens: 5 },
    })
  })
})
