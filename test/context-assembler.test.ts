import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  allocateBudget,
  assembleContext,
  selectRecentEvents,
} from '../src/runtime/contextAssembler.js'
import { snipEvent } from '../src/runtime/compactors/snipCompactor.js'
import { buildSystemPrompt, mapEventsToMessages } from '../src/runtime/LLMCodingRuntime.js'
import type { NexusEvent } from '../src/shared/events.js'
import type { ModelMessage } from '../src/providers/adapters/ModelAdapter.js'

const schemaVersion = '2026-05-21.babel-o.v1' as const

test('allocateBudget caps very large context windows and keeps recent budget positive', () => {
  const budget = allocateBudget('anthropic/claude-3-5-sonnet')
  assert.equal(budget.maxTokens, 120_000)
  assert.ok(budget.layerBudgets.recent > 0)
  assert.ok(budget.snipToolOutputChars > 0)
})

test('snipEvent compacts long tool outputs without changing non-tool events', () => {
  const toolEvent: NexusEvent = {
    type: 'tool_completed',
    schemaVersion,
    sessionId: 'session-context',
    timestamp: '2026-05-23T00:00:00.000Z',
    toolUseId: 'tool-1',
    name: 'Read',
    success: true,
    output: 'a'.repeat(100) + 'middle' + 'z'.repeat(100),
  }
  const snipped = snipEvent(toolEvent, 80) as Extract<NexusEvent, { type: 'tool_completed' }>

  assert.equal(snipped.truncated, true)
  assert.equal(snipped.originalBytes, Buffer.byteLength(toolEvent.output as string, 'utf8'))
  assert.match(snipped.output as string, /chars truncated from tool output/)
  assert.ok((snipped.output as string).startsWith('a'))
  assert.ok((snipped.output as string).endsWith('z'.repeat(32)))

  const userEvent: NexusEvent = {
    type: 'user_message',
    schemaVersion,
    sessionId: 'session-context',
    timestamp: '2026-05-23T00:00:00.000Z',
    text: 'hello',
  }
  assert.equal(snipEvent(userEvent, 10), userEvent)
})

test('selectRecentEvents keeps first user message plus recent bounded history', () => {
  const events: NexusEvent[] = [
    {
      type: 'user_message',
      schemaVersion,
      sessionId: 'session-context',
      timestamp: '2026-05-23T00:00:00.000Z',
      text: 'initial goal',
    },
  ]
  for (let i = 0; i < 10; i++) {
    events.push({
      type: 'assistant_delta',
      schemaVersion,
      sessionId: 'session-context',
      timestamp: `2026-05-23T00:00:${String(i).padStart(2, '0')}.000Z`,
      text: `delta-${i}`,
    })
  }

  const selected = selectRecentEvents(events, {
    maxTokens: 100,
    maxChars: 400,
    layerBudgets: { system: 10, memory: 10, summary: 10, recent: 70 },
    snipToolOutputChars: 100,
    recentEventLimit: 3,
  })

  assert.equal(selected[0].type, 'user_message')
  assert.equal((selected[0] as any).text, 'initial goal')
  assert.equal(selected.length, 4)
  assert.equal((selected.at(-1) as any).text, 'delta-9')
})

test('assembleContext injects project memory and snips historical tool output', async () => {
  const cwd = join(tmpdir(), `babel-o-context-${Date.now()}`)
  await mkdir(join(cwd, '.babel-o'), { recursive: true })
  await writeFile(join(cwd, '.babel-o', 'memory.md'), 'Always prefer focused changes.\n', 'utf8')

  const events: NexusEvent[] = [
    {
      type: 'user_message',
      schemaVersion,
      sessionId: 'session-context',
      timestamp: '2026-05-23T00:00:00.000Z',
      text: 'inspect file',
    },
    {
      type: 'tool_started',
      schemaVersion,
      sessionId: 'session-context',
      timestamp: '2026-05-23T00:00:01.000Z',
      toolUseId: 'tool-1',
      name: 'Read',
      input: { path: 'large.txt' },
    },
    {
      type: 'tool_completed',
      schemaVersion,
      sessionId: 'session-context',
      timestamp: '2026-05-23T00:00:02.000Z',
      toolUseId: 'tool-1',
      name: 'Read',
      success: true,
      output: 'x'.repeat(50_000),
    },
  ]

  const context = await assembleContext({
    runtimeOptions: {
      sessionId: 'session-context',
      prompt: 'continue',
      cwd,
    },
    events,
    modelId: 'local/coding-runtime',
    buildSystemPrompt,
    mapEventsToMessages,
  })

  assert.match(context.systemPrompt, /Project Memory/)
  assert.match(context.systemPrompt, /Always prefer focused changes/)
  assert.equal(context.snippedEventCount, 1)
  const toolResultMessage = context.messages.findLast(message => message.role === 'user')
  assert.ok(Array.isArray(toolResultMessage?.content))
  assert.match((toolResultMessage!.content as any[])[0].content, /chars truncated from tool output/)
})

test('assembleContext summarizes omitted older events without duplicating recent events', async () => {
  const cwd = join(tmpdir(), `babel-o-summary-${Date.now()}`)
  const events: NexusEvent[] = [
    {
      type: 'user_message',
      schemaVersion,
      sessionId: 'session-context',
      timestamp: '2026-05-23T00:00:00.000Z',
      text: 'initial goal',
    },
    {
      type: 'tool_started',
      schemaVersion,
      sessionId: 'session-context',
      timestamp: '2026-05-23T00:00:01.000Z',
      toolUseId: 'tool-old',
      name: 'Read',
      input: { path: 'src/old.ts' },
    },
    {
      type: 'tool_completed',
      schemaVersion,
      sessionId: 'session-context',
      timestamp: '2026-05-23T00:00:02.000Z',
      toolUseId: 'tool-old',
      name: 'Read',
      success: false,
      output: 'missing file',
    },
    {
      type: 'user_message',
      schemaVersion,
      sessionId: 'session-context',
      timestamp: '2026-05-23T00:00:03.000Z',
      text: 'then inspect the failing file',
    },
  ]
  for (let i = 0; i < 30; i++) {
    events.push({
      type: 'assistant_delta',
      schemaVersion,
      sessionId: 'session-context',
      timestamp: `2026-05-23T00:01:${String(i).padStart(2, '0')}.000Z`,
      text: `recent-${i}`,
    })
  }

  const context = await assembleContext({
    runtimeOptions: {
      sessionId: 'session-context',
      prompt: 'continue',
      cwd,
    },
    events,
    modelId: 'local/coding-runtime',
    buildSystemPrompt,
    mapEventsToMessages,
  })

  assert.ok(context.omittedEventCount > 0)
  assert.match(context.systemPrompt, /Session Summary/)
  assert.match(context.systemPrompt, /Read x1/)
  assert.match(context.systemPrompt, /src\/old\.ts/)
  assert.match(context.systemPrompt, /Read failed/)
  assert.match(context.systemPrompt, /then inspect the failing file/)
})

test('assembleContext omits session summary when all events fit recent context', async () => {
  const cwd = join(tmpdir(), `babel-o-no-summary-${Date.now()}`)
  const events: NexusEvent[] = [
    {
      type: 'user_message',
      schemaVersion,
      sessionId: 'session-context',
      timestamp: '2026-05-23T00:00:00.000Z',
      text: 'short session',
    },
    {
      type: 'assistant_delta',
      schemaVersion,
      sessionId: 'session-context',
      timestamp: '2026-05-23T00:00:01.000Z',
      text: 'ok',
    },
  ]

  const context = await assembleContext({
    runtimeOptions: {
      sessionId: 'session-context',
      prompt: 'continue',
      cwd,
    },
    events,
    modelId: 'local/coding-runtime',
    buildSystemPrompt,
    mapEventsToMessages,
  })

  assert.equal(context.omittedEventCount, 0)
  assert.equal(context.sessionSummary, '')
  assert.doesNotMatch(context.systemPrompt, /Session Summary/)
})

test('assembleContext reduces long-session context by more than 50 percent while preserving recent turns', async () => {
  const cwd = join(tmpdir(), `babel-o-context-benchmark-${Date.now()}`)
  const events = createLongSessionEvents()
  const originalSystemPrompt = buildSystemPrompt({
    sessionId: 'session-context',
    prompt: 'continue',
    cwd,
  })
  const originalMessages = mapEventsToMessages(events, 'continue')
  const originalChars = originalSystemPrompt.length + estimateMessagesChars(originalMessages)

  const context = await assembleContext({
    runtimeOptions: {
      sessionId: 'session-context',
      prompt: 'continue',
      cwd,
    },
    events,
    modelId: 'local/coding-runtime',
    buildSystemPrompt,
    mapEventsToMessages,
  })
  const assembledChars = context.systemPrompt.length + estimateMessagesChars(context.messages)
  const reductionPct = ((originalChars - assembledChars) / originalChars) * 100
  const assembledText = JSON.stringify(context.messages)

  assert.ok(reductionPct > 50, `expected >50% reduction, got ${reductionPct.toFixed(2)}%`)
  assert.match(assembledText, /recent-turn-37/)
  assert.match(assembledText, /recent-turn-38/)
  assert.match(assembledText, /recent-turn-39/)
  assert.match(context.systemPrompt, /Session Summary/)
})

function estimateMessagesChars(messages: ModelMessage[]): number {
  return JSON.stringify(messages).length
}

function createLongSessionEvents(): NexusEvent[] {
  const events: NexusEvent[] = [
    {
      type: 'user_message',
      schemaVersion,
      sessionId: 'session-context',
      timestamp: '2026-05-23T00:00:00.000Z',
      text: 'Optimize this project while preserving the recent context.',
    },
  ]

  for (let index = 0; index < 40; index += 1) {
    const minute = String(index).padStart(2, '0')
    events.push(
      {
        type: 'assistant_delta',
        schemaVersion,
        sessionId: 'session-context',
        timestamp: `2026-05-23T00:${minute}:01.000Z`,
        text: `Planning turn ${index}. `,
      },
      {
        type: 'tool_started',
        schemaVersion,
        sessionId: 'session-context',
        timestamp: `2026-05-23T00:${minute}:02.000Z`,
        toolUseId: `tool-${index}`,
        name: 'Read',
        input: { path: `src/feature-${index}.ts` },
      },
      {
        type: 'tool_completed',
        schemaVersion,
        sessionId: 'session-context',
        timestamp: `2026-05-23T00:${minute}:03.000Z`,
        toolUseId: `tool-${index}`,
        name: 'Read',
        success: true,
        output: `${'x'.repeat(8_000)}\nrecent-turn-${index}\n${'y'.repeat(8_000)}`,
      },
      {
        type: 'user_message',
        schemaVersion,
        sessionId: 'session-context',
        timestamp: `2026-05-23T00:${minute}:04.000Z`,
        text: `Continue after recent-turn-${index}.`,
      },
    )
  }

  return events
}
