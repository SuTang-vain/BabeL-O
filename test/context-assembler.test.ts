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
import {
  buildSystemPrompt,
  extractAbsolutePaths,
  mapEventsToMessages,
} from '../src/runtime/LLMCodingRuntime.js'
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

test('selectRecentEvents starts at a recent user boundary instead of preserving stale first user', () => {
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
  events.push({
    type: 'user_message',
    schemaVersion,
    sessionId: 'session-context',
    timestamp: '2026-05-23T00:00:10.000Z',
    text: 'latest question',
  })
  events.push({
    type: 'session_started',
    schemaVersion,
    sessionId: 'session-context',
    timestamp: '2026-05-23T00:00:11.000Z',
    cwd: '/repo',
  })

  const selected = selectRecentEvents(events, {
    maxTokens: 100,
    maxChars: 400,
    layerBudgets: { system: 10, memory: 10, summary: 10, recent: 70 },
    snipToolOutputChars: 100,
    recentEventLimit: 3,
    recentTurnLimit: 1,
  })

  assert.equal(selected[0].type, 'user_message')
  assert.equal((selected[0] as any).text, 'latest question')
  assert.equal(selected.length, 2)
  assert.equal(selected.at(-1)?.type, 'session_started')
})

test('selectRecentEvents keeps recent user turns even when assistant deltas dominate the raw event window', () => {
  const events: NexusEvent[] = [
    {
      type: 'user_message',
      schemaVersion,
      sessionId: 'session-context',
      timestamp: '2026-05-23T00:00:00.000Z',
      text: 'analyze project A',
    },
  ]

  for (let index = 0; index < 200; index += 1) {
    events.push({
      type: 'assistant_delta',
      schemaVersion,
      sessionId: 'session-context',
      timestamp: `2026-05-23T00:01:${String(index % 60).padStart(2, '0')}.000Z`,
      text: `long analysis fragment ${index}. `,
    })
  }

  events.push({
    type: 'user_message',
    schemaVersion,
    sessionId: 'session-context',
    timestamp: '2026-05-23T00:02:00.000Z',
    text: 'now compare architecture performance',
  })

  for (let index = 0; index < 400; index += 1) {
    events.push({
      type: 'thinking_delta',
      schemaVersion,
      sessionId: 'session-context',
      timestamp: `2026-05-23T00:03:${String(index % 60).padStart(2, '0')}.000Z`,
      text: `hidden reasoning fragment ${index}. `,
    })
  }

  const selected = selectRecentEvents(events, {
    maxTokens: 100,
    maxChars: 400,
    layerBudgets: { system: 10, memory: 10, summary: 10, recent: 70 },
    snipToolOutputChars: 100,
    recentEventLimit: 50,
    recentTurnLimit: 1,
  })

  assert.equal(selected[0].type, 'user_message')
  assert.equal((selected[0] as any).text, 'now compare architecture performance')
  assert.equal(selected.length, 50)
  assert.doesNotMatch(JSON.stringify(selected), /hidden reasoning fragment 0/)
})

test('selectRecentEvents caps selected user turns to the event budget', () => {
  const events: NexusEvent[] = [
    {
      type: 'user_message',
      schemaVersion,
      sessionId: 'session-context',
      timestamp: '2026-05-23T00:00:00.000Z',
      text: 'analyze BabeL-O',
    },
  ]

  for (let index = 0; index < 120; index += 1) {
    events.push({
      type: 'assistant_delta',
      schemaVersion,
      sessionId: 'session-context',
      timestamp: `2026-05-23T00:01:${String(index % 60).padStart(2, '0')}.000Z`,
      text: `BabeL-O analysis fragment ${index}. `,
    })
  }

  events.push({
    type: 'user_message',
    schemaVersion,
    sessionId: 'session-context',
    timestamp: '2026-05-23T00:02:00.000Z',
    text: '/Users/tangyaoyue/DEV/BABEL/BabeL-X横向对比这个项目',
  })

  for (let index = 0; index < 300; index += 1) {
    events.push({
      type: 'assistant_delta',
      schemaVersion,
      sessionId: 'session-context',
      timestamp: `2026-05-23T00:03:${String(index % 60).padStart(2, '0')}.000Z`,
      text: `stale BabeL-O follow-up fragment ${index}. `,
    })
  }

  const selected = selectRecentEvents(events, {
    maxTokens: 100,
    maxChars: 400,
    layerBudgets: { system: 10, memory: 10, summary: 10, recent: 70 },
    snipToolOutputChars: 100,
    recentEventLimit: 80,
    recentTurnLimit: 4,
  })

  assert.equal(selected.length, 80)
  assert.equal(selected[0].type, 'user_message')
  assert.equal((selected[0] as any).text, '/Users/tangyaoyue/DEV/BABEL/BabeL-X横向对比这个项目')
  assert.doesNotMatch(JSON.stringify(selected), /BabeL-O analysis fragment 0/)
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
      timestamp: '2026-05-23T00:00:02.500Z',
      text: 'note the old failure',
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
  assert.match(JSON.stringify(context.messages), /then inspect the failing file/)
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

test('assembleContext respects compact boundaries without double counting old history', async () => {
  const cwd = join(tmpdir(), `babel-o-compact-${Date.now()}`)
  const events: NexusEvent[] = [
    {
      type: 'user_message',
      schemaVersion,
      sessionId: 'session-context',
      timestamp: '2026-05-23T00:00:00.000Z',
      text: 'old goal',
    },
    {
      type: 'tool_started',
      schemaVersion,
      sessionId: 'session-context',
      timestamp: '2026-05-23T00:00:01.000Z',
      toolUseId: 'tool-old',
      name: 'Read',
      input: { path: 'legacy.txt' },
    },
    {
      type: 'tool_completed',
      schemaVersion,
      sessionId: 'session-context',
      timestamp: '2026-05-23T00:00:02.000Z',
      toolUseId: 'tool-old',
      name: 'Read',
      success: true,
      output: 'legacy output',
    },
    {
      type: 'compact_boundary',
      schemaVersion,
      sessionId: 'session-context',
      timestamp: '2026-05-23T00:00:03.000Z',
      trigger: 'manual',
      summary: 'Compressed old goal and legacy output.',
      beforeEventCount: 3,
      afterEventCount: 1,
      summaryChars: 38,
      snippedToolResults: 1,
      modelId: 'local/coding-runtime',
      budget: allocateBudget('local/coding-runtime'),
    },
    {
      type: 'user_message',
      schemaVersion,
      sessionId: 'session-context',
      timestamp: '2026-05-23T00:00:04.000Z',
      text: 'latest question',
    },
    {
      type: 'assistant_delta',
      schemaVersion,
      sessionId: 'session-context',
      timestamp: '2026-05-23T00:00:05.000Z',
      text: 'answering latest question',
    },
  ]

  const context = await assembleContext({
    runtimeOptions: {
      sessionId: 'session-context',
      prompt: 'latest question',
      cwd,
    },
    events,
    modelId: 'local/coding-runtime',
    buildSystemPrompt,
    mapEventsToMessages,
  })

  assert.match(context.sessionSummary, /Compressed old goal/)
  assert.doesNotMatch(context.sessionSummary, /legacy output.*legacy output/)
  assert.match(JSON.stringify(context.messages), /latest question/)
  assert.doesNotMatch(JSON.stringify(context.messages), /old goal/)
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
  assert.match(assembledText, /recent-turn-38/)
  assert.match(assembledText, /recent-turn-39/)
  assert.match(context.systemPrompt, /Session Summary/)
  assert.match(context.systemPrompt, /recent-turn-37/)
})

test('assembleContext prioritizes the latest user question in long noisy sessions', async () => {
  const cwd = join(tmpdir(), `babel-o-latest-question-${Date.now()}`)
  const events: NexusEvent[] = [
    {
      type: 'user_message',
      schemaVersion,
      sessionId: 'session-context',
      timestamp: '2026-05-23T00:00:00.000Z',
      text: 'hi',
    },
  ]

  for (let index = 0; index < 180; index += 1) {
    events.push({
      type: 'assistant_delta',
      schemaVersion,
      sessionId: 'session-context',
      timestamp: `2026-05-23T00:01:${String(index % 60).padStart(2, '0')}.000Z`,
      text: `old project analysis fragment ${index}. `,
    })
  }

  events.push(
    {
      type: 'user_message',
      schemaVersion,
      sessionId: 'session-context',
      timestamp: '2026-05-23T00:02:00.000Z',
      text: '你可以感知我具体再问你什么吗',
    },
    {
      type: 'assistant_delta',
      schemaVersion,
      sessionId: 'session-context',
      timestamp: '2026-05-23T00:02:01.000Z',
      text: 'I should answer the latest question.',
    },
    {
      type: 'user_message',
      schemaVersion,
      sessionId: 'session-context',
      timestamp: '2026-05-23T00:03:00.000Z',
      text: '你还记得我们之前在讨论什么吗',
    },
    {
      type: 'session_started',
      schemaVersion,
      sessionId: 'session-context',
      timestamp: '2026-05-23T00:03:01.000Z',
      cwd,
    },
  )

  const context = await assembleContext({
    runtimeOptions: {
      sessionId: 'session-context',
      prompt: '你还记得我们之前在讨论什么吗',
      cwd,
    },
    events,
    modelId: 'local/coding-runtime',
    buildSystemPrompt,
    mapEventsToMessages,
  })

  assert.notEqual(context.messages[0]?.content, 'hi')
  assert.match(JSON.stringify(context.messages), /你还记得我们之前在讨论什么吗/)
  assert.doesNotMatch(String(context.messages[0]?.content), /old project analysis fragment/)
  assert.match(context.systemPrompt, /Context Boundary:/)
  assert.match(context.systemPrompt, /authoritative working history/)
  assert.match(context.systemPrompt, /Current user request:/)
  assert.match(context.systemPrompt, /你还记得我们之前在讨论什么吗/)
})

test('assembleContext starts fresh after a cancelled or timed out long task', async () => {
  const cwd = join(tmpdir(), `babel-o-recovery-boundary-${Date.now()}`)
  const events: NexusEvent[] = [
    {
      type: 'user_message',
      schemaVersion,
      sessionId: 'session-context',
      timestamp: '2026-05-23T00:00:00.000Z',
      text: '/Users/tangyaoyue/DEV/BABEL/BabeL-O深入分析这个项目',
    },
  ]

  for (let index = 0; index < 20; index += 1) {
    events.push(
      {
        type: 'thinking_delta',
        schemaVersion,
        sessionId: 'session-context',
        timestamp: `2026-05-23T00:00:${String(index).padStart(2, '0')}.000Z`,
        text: `Let me continue reading runtimeAgentStep.ts old-task-${index}.`,
      },
      {
        type: 'tool_started',
        schemaVersion,
        sessionId: 'session-context',
        timestamp: `2026-05-23T00:01:${String(index).padStart(2, '0')}.000Z`,
        toolUseId: `old-tool-${index}`,
        name: 'Read',
        input: { path: '/Users/tangyaoyue/DEV/BABEL/BabeL-O/src/nexus/runtimeAgentStep.ts' },
      },
      {
        type: 'tool_completed',
        schemaVersion,
        sessionId: 'session-context',
        timestamp: `2026-05-23T00:02:${String(index).padStart(2, '0')}.000Z`,
        toolUseId: `old-tool-${index}`,
        name: 'Read',
        success: true,
        output: `old runtimeAgentStep content ${index}`,
      },
    )
  }

  events.push(
    {
      type: 'error',
      schemaVersion,
      sessionId: 'session-context',
      timestamp: '2026-05-23T00:03:00.000Z',
      code: 'REQUEST_CANCELLED',
      message: 'Execution cancelled by user.',
    },
    {
      type: 'user_message',
      schemaVersion,
      sessionId: 'session-context',
      timestamp: '2026-05-23T00:04:00.000Z',
      text: '？你回答我你现在在干什么？？？',
    },
  )

  const context = await assembleContext({
    runtimeOptions: {
      sessionId: 'session-context',
      prompt: '？你回答我你现在在干什么？？？',
      cwd,
    },
    events,
    modelId: 'minimax/MiniMax-M2.7',
    buildSystemPrompt,
    mapEventsToMessages,
  })

  const messagesText = JSON.stringify(context.messages)
  assert.equal(context.messages.at(-1)?.role, 'user')
  assert.equal(context.messages.at(-1)?.content, '？你回答我你现在在干什么？？？')
  assert.doesNotMatch(messagesText, /runtimeAgentStep/)
  assert.doesNotMatch(messagesText, /old-task/)
  assert.match(context.systemPrompt, /Session Summary/)
  assert.match(context.systemPrompt, /REQUEST_CANCELLED|cancelled/i)
})

test('buildSystemPrompt anchors explicit absolute paths from the current request', async () => {
  const cwd = join(tmpdir(), `babel-o-path-anchor-${Date.now()}`)
  const explicitTarget = join(cwd, 'BabeL-X')
  await mkdir(explicitTarget, { recursive: true })

  const prompt = `${explicitTarget}横向对比分析这个项目`
  const paths = extractAbsolutePaths(prompt)
  assert.deepEqual(paths, [explicitTarget])

  const systemPrompt = buildSystemPrompt({
    sessionId: 'session-context',
    prompt,
    cwd,
  })

  assert.match(systemPrompt, /Explicit paths in current request:/)
  assert.match(systemPrompt, new RegExp(escapeRegExp(explicitTarget)))
  const explicitPathBlock = systemPrompt.match(/Explicit paths in current request:\n(?<block>(?:- .+\n)+)/)?.groups?.block ?? ''
  assert.doesNotMatch(explicitPathBlock, new RegExp(escapeRegExp(`${explicitTarget}横向`)))
  assert.match(systemPrompt, /authoritative task targets/)
  assert.match(systemPrompt, /inspect that explicit path first/)
})

test('extractAbsolutePaths does not collapse missing file paths to an existing parent directory', async () => {
  const cwd = join(tmpdir(), `babel-o-missing-path-${Date.now()}`)
  await mkdir(cwd, { recursive: true })

  const missingPath = join(cwd, 'missing.txt')
  assert.deepEqual(extractAbsolutePaths(`请读取${missingPath}`), [missingPath])
})

function estimateMessagesChars(messages: ModelMessage[]): number {
  return JSON.stringify(messages).length
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
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
