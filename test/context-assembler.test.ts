import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  allocateBudget,
  assembleContext,
  derivePostCompactState,
  eventIdentity,
  microcompactEvents,
  protectToolPairs,
  selectOmittedEvents,
  type ContextBudget,
  selectRecentEvents,
} from '../src/runtime/contextAssembler.js'
import { snipEvent } from '../src/runtime/compactors/snipCompactor.js'
import {
  getAutoCompactDecision,
  countConsecutiveAutoCompactFailures,
  compactSession,
} from '../src/runtime/compact.js'
import { MemoryStorage } from '../src/storage/MemoryStorage.js'
import {
  buildSystemPrompt,
  mapEventsToMessages,
} from '../src/runtime/LLMCodingRuntime.js'
import { extractAbsolutePaths } from '../src/runtime/systemPromptBuilder.js'
import { homedir } from 'node:os'
import type { NexusEvent } from '../src/shared/events.js'
import type { ModelMessage } from '../src/providers/adapters/ModelAdapter.js'
import { analyzeContext } from '../src/runtime/contextAnalysis.js'

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
    snipPriorTurnToolOutputChars: 30,
    microcompactToolOutputChars: 500,
    microcompactInternalTextChars: 200,
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
    snipPriorTurnToolOutputChars: 30,
    microcompactToolOutputChars: 500,
    microcompactInternalTextChars: 200,
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
    snipPriorTurnToolOutputChars: 30,
    microcompactToolOutputChars: 500,
    microcompactInternalTextChars: 200,
    recentEventLimit: 80,
    recentTurnLimit: 4,
  })

  assert.equal(selected.length, 80)
  assert.equal(selected[0].type, 'user_message')
  assert.equal((selected[0] as any).text, '/Users/tangyaoyue/DEV/BABEL/BabeL-X横向对比这个项目')
  assert.doesNotMatch(JSON.stringify(selected), /BabeL-O analysis fragment 0/)
})

test('selectRecentEvents keeps recent turns for explicit path prompts; intent guidance owns focus changes', () => {
  const events: NexusEvent[] = [
    {
      type: 'user_message',
      schemaVersion,
      sessionId: 'session-context',
      timestamp: '2026-05-23T00:00:00.000Z',
      text: 'older project analysis',
    },
    {
      type: 'assistant_delta',
      schemaVersion,
      sessionId: 'session-context',
      timestamp: '2026-05-23T00:00:01.000Z',
      text: 'stale analysis',
    },
    {
      type: 'user_message',
      schemaVersion,
      sessionId: 'session-context',
      timestamp: '2026-05-23T00:00:02.000Z',
      text: '/Users/tangyaoyue/DEV/BABEL/BabeL-O /Users/tangyaoyue/DEV/BABEL/BabeL-X深入分析横向对比这两个项目',
    },
    {
      type: 'assistant_delta',
      schemaVersion,
      sessionId: 'session-context',
      timestamp: '2026-05-23T00:00:03.000Z',
      text: 'older comparison draft',
    },
  ]

  const selected = selectRecentEvents(events, {
    maxTokens: 100,
    maxChars: 400,
    layerBudgets: { system: 10, memory: 10, summary: 10, recent: 70 },
    snipToolOutputChars: 100,
    snipPriorTurnToolOutputChars: 30,
    microcompactToolOutputChars: 500,
    microcompactInternalTextChars: 200,
    recentEventLimit: 20,
    recentTurnLimit: 2,
  })

  assert.equal(selected[0].type, 'user_message')
  assert.equal(
    (selected[0] as Extract<NexusEvent, { type: 'user_message' }>).text,
    'older project analysis',
  )
  assert.match(JSON.stringify(selected), /stale analysis/)
})

test('selectOmittedEvents uses stable event identity after cloning', () => {
  const events: NexusEvent[] = [
    {
      type: 'user_message',
      schemaVersion,
      sessionId: 'session-context',
      timestamp: '2026-05-23T00:00:00.000Z',
      text: 'old',
    },
    {
      type: 'tool_started',
      schemaVersion,
      sessionId: 'session-context',
      timestamp: '2026-05-23T00:00:01.000Z',
      toolUseId: 'tool-stable',
      name: 'Read',
      input: { path: 'a.txt' },
    },
    {
      type: 'tool_completed',
      schemaVersion,
      sessionId: 'session-context',
      timestamp: '2026-05-23T00:00:02.000Z',
      toolUseId: 'tool-stable',
      name: 'Read',
      success: true,
      output: 'ok',
    },
  ]
  const clonedSelected = JSON.parse(JSON.stringify(events.slice(1))) as NexusEvent[]
  const omitted = selectOmittedEvents(events, clonedSelected)

  assert.equal(omitted.length, 1)
  assert.equal(omitted[0]?.type, 'user_message')
  assert.equal(eventIdentity(events[1]!), eventIdentity(clonedSelected[0]!))
})

test('protectToolPairs retains matching tool_use and tool_result events', () => {
  const events: NexusEvent[] = [
    {
      type: 'user_message',
      schemaVersion,
      sessionId: 'session-context',
      timestamp: '2026-05-23T00:00:00.000Z',
      text: 'read file',
    },
    {
      type: 'tool_started',
      schemaVersion,
      sessionId: 'session-context',
      timestamp: '2026-05-23T00:00:01.000Z',
      toolUseId: 'tool-pair',
      name: 'Read',
      input: { path: 'large.txt' },
    },
    {
      type: 'tool_completed',
      schemaVersion,
      sessionId: 'session-context',
      timestamp: '2026-05-23T00:00:02.000Z',
      toolUseId: 'tool-pair',
      name: 'Read',
      success: true,
      output: 'content',
    },
  ]
  const selected = protectToolPairs(events, [events[2]!])

  assert.deepEqual(selected.map(event => event.type), ['tool_started', 'tool_completed'])
  assert.equal((selected[0] as any).toolUseId, 'tool-pair')
  assert.equal((selected[1] as any).toolUseId, 'tool-pair')
})

test('microcompact trims old tool output without denied/interrupted wording', () => {
  const budget: ContextBudget = {
    maxTokens: 1000,
    maxChars: 4000,
    layerBudgets: { system: 100, memory: 100, summary: 100, recent: 700 },
    snipToolOutputChars: 100,
    snipPriorTurnToolOutputChars: 80,
    microcompactToolOutputChars: 120,
    microcompactInternalTextChars: 40,
    recentEventLimit: 20,
    recentTurnLimit: 2,
  }
  const events: NexusEvent[] = [
    {
      type: 'user_message',
      schemaVersion,
      sessionId: 'session-context',
      timestamp: '2026-05-23T00:00:00.000Z',
      text: 'old turn',
    },
    {
      type: 'tool_completed',
      schemaVersion,
      sessionId: 'session-context',
      timestamp: '2026-05-23T00:00:01.000Z',
      toolUseId: 'tool-large',
      name: 'Read',
      success: true,
      output: 'a'.repeat(400),
    },
    {
      type: 'user_message',
      schemaVersion,
      sessionId: 'session-context',
      timestamp: '2026-05-23T00:00:02.000Z',
      text: 'latest turn',
    },
  ]

  const compacted = microcompactEvents(events, budget)
  const output = String((compacted[1] as Extract<NexusEvent, { type: 'tool_completed' }>).output)
  assert.match(output, /microcompacted/)
  assert.doesNotMatch(output, /denied or interrupted/)
  assert.equal((compacted[1] as Extract<NexusEvent, { type: 'tool_completed' }>).truncated, true)
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
  assert.ok(context.snippedEventCount + context.microcompactedEventCount >= 1,
    `Expected at least one truncated event (snipped=${context.snippedEventCount}, microcompacted=${context.microcompactedEventCount})`)
  const toolResultMessage = context.messages.findLast(message => message.role === 'user')
  assert.ok(Array.isArray(toolResultMessage?.content))
  assert.match((toolResultMessage!.content as any[])[0].content, /chars truncated|microcompacted/)
})

test('assembleContext applies dynamic system prompt layer budgets', async () => {
  const cwd = join(tmpdir(), `babel-o-layer-budget-${Date.now()}`)
  await mkdir(join(cwd, '.babel-o'), { recursive: true })
  await writeFile(join(cwd, '.babel-o', 'memory.md'), 'memory-line\n'.repeat(4000), 'utf8')

  const context = await assembleContext({
    runtimeOptions: {
      sessionId: 'session-context',
      prompt: 'continue',
      cwd,
    },
    events: [
      {
        type: 'user_message',
        schemaVersion,
        sessionId: 'session-context',
        timestamp: '2026-05-23T00:00:00.000Z',
        text: 'hello',
      },
    ],
    modelId: 'local/coding-runtime',
    buildSystemPrompt,
    mapEventsToMessages,
  })

  assert.ok(context.projectMemory.length <= context.budget.layerBudgets.memory * 4)
  assert.equal(context.memoryTruncated, true)
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
  assert.match(context.systemPrompt, /Context Boundary/)
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
  assert.doesNotMatch(context.systemPrompt, /Context Boundary/)
})

test('auto compact decision respects thresholds and fuse state', () => {
  const budget: ContextBudget = {
    maxTokens: 1000,
    maxChars: 4000,
    layerBudgets: { system: 100, memory: 100, summary: 100, recent: 700 },
    snipToolOutputChars: 100,
    snipPriorTurnToolOutputChars: 30,
    microcompactToolOutputChars: 500,
    microcompactInternalTextChars: 200,
    recentEventLimit: 10,
    recentTurnLimit: 2,
  }
  assert.equal(
    getAutoCompactDecision({
      events: [],
      tokenEstimate: 750,
      maxTokens: budget.maxTokens,
      enabled: true,
      thresholdPercent: 80,
      failureLimit: 2,
    }).shouldCompact,
    false,
  )
  assert.equal(
    getAutoCompactDecision({
      events: [],
      tokenEstimate: 850,
      maxTokens: budget.maxTokens,
      enabled: true,
      thresholdPercent: 80,
      failureLimit: 2,
    }).shouldCompact,
    true,
  )
  assert.equal(
    getAutoCompactDecision({
      events: [
        {
          type: 'compact_failure',
          schemaVersion,
          sessionId: 'session-context',
          timestamp: '2026-05-23T00:00:00.000Z',
          trigger: 'auto',
          failureCount: 1,
          maxFailures: 2,
          message: 'first',
        },
        {
          type: 'compact_failure',
          schemaVersion,
          sessionId: 'session-context',
          timestamp: '2026-05-23T00:00:01.000Z',
          trigger: 'auto',
          failureCount: 2,
          maxFailures: 2,
          message: 'second',
        },
      ],
      tokenEstimate: 900,
      maxTokens: budget.maxTokens,
      enabled: true,
      thresholdPercent: 80,
      failureLimit: 2,
    }).fuseOpen,
    true,
  )
  assert.equal(
    countConsecutiveAutoCompactFailures([
      {
        type: 'compact_failure',
        schemaVersion,
        sessionId: 'session-context',
        timestamp: '2026-05-23T00:00:00.000Z',
        trigger: 'auto',
        failureCount: 1,
        maxFailures: 2,
        message: 'first',
      },
      {
        type: 'compact_boundary',
        schemaVersion,
        sessionId: 'session-context',
        timestamp: '2026-05-23T00:00:01.000Z',
        trigger: 'auto',
        summary: 'ok',
        beforeEventCount: 1,
        afterEventCount: 1,
        summaryChars: 2,
        snippedToolResults: 0,
        budget,
      } as any,
    ]),
    0,
  )
  assert.equal(
    countConsecutiveAutoCompactFailures([
      {
        type: 'compact_failure',
        schemaVersion,
        sessionId: 'session-context',
        timestamp: '2026-05-23T00:00:00.000Z',
        trigger: 'auto',
        failureCount: 1,
        maxFailures: 2,
        message: 'first',
      },
      {
        type: 'compact_boundary',
        schemaVersion,
        sessionId: 'session-context',
        timestamp: '2026-05-23T00:00:01.000Z',
        trigger: 'manual',
        summary: 'manual recovery',
        beforeEventCount: 10,
        afterEventCount: 2,
        summaryChars: 15,
        snippedToolResults: 0,
        budget,
      } as any,
      {
        type: 'compact_failure',
        schemaVersion,
        sessionId: 'session-context',
        timestamp: '2026-05-23T00:00:02.000Z',
        trigger: 'auto',
        failureCount: 1,
        maxFailures: 2,
        message: 'after manual',
      },
    ]),
    1,
  )
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

test('assembleContext rebuilds lightweight post-compact state', async () => {
  const cwd = join(tmpdir(), `babel-o-post-compact-${Date.now()}`)
  const events: NexusEvent[] = [
    {
      type: 'compact_boundary',
      schemaVersion,
      sessionId: 'session-context',
      timestamp: '2026-05-23T00:00:00.000Z',
      trigger: 'manual',
      summary: 'Old work summarized.',
      beforeEventCount: 20,
      afterEventCount: 4,
      summaryChars: 20,
      snippedToolResults: 1,
      modelId: 'local/coding-runtime',
      budget: allocateBudget('local/coding-runtime'),
      retainedEvents: [],
    } as any,
    {
      type: 'tool_started',
      schemaVersion,
      sessionId: 'session-context',
      timestamp: '2026-05-23T00:00:01.000Z',
      toolUseId: 'read-1',
      name: 'Read',
      input: { path: 'src/runtime/contextAssembler.ts' },
    },
    {
      type: 'tool_completed',
      schemaVersion,
      sessionId: 'session-context',
      timestamp: '2026-05-23T00:00:02.000Z',
      toolUseId: 'read-1',
      name: 'Read',
      success: true,
      output: 'file content',
    },
    {
      type: 'task_session_event',
      schemaVersion,
      sessionId: 'session-context',
      eventId: 'evt-1',
      eventType: 'completed',
      phase: 'critic',
      timestamp: '2026-05-23T00:00:03.000Z',
      payload: { taskId: 'task-1', role: 'critic' },
    },
    {
      type: 'hook_completed',
      schemaVersion,
      sessionId: 'session-context',
      timestamp: '2026-05-23T00:00:04.000Z',
      hookName: 'SessionCleanupAuditHook',
      hookEvent: 'SessionEnd',
    },
    {
      type: 'user_message',
      schemaVersion,
      sessionId: 'session-context',
      timestamp: '2026-05-23T00:00:05.000Z',
      text: '继续',
    },
  ]

  const context = await assembleContext({
    runtimeOptions: {
      sessionId: 'session-context',
      prompt: '继续',
      cwd,
    },
    events,
    modelId: 'local/coding-runtime',
    buildSystemPrompt,
    mapEventsToMessages,
  })

  assert.deepEqual(context.postCompactState.recentReadFiles, ['src/runtime/contextAssembler.ts'])
  assert.ok(context.postCompactState.taskStatusLines.some(line => line.includes('critic')))
  assert.ok(context.postCompactState.hookLines.some(line => line.includes('SessionCleanupAuditHook')))
  assert.match(context.sessionSummary, /Post-Compact State/)
  assert.match(context.sessionSummary, /Compact Capability Reminder/)
  assert.match(context.sessionSummary, /tool_use and tool_result pairs must remain matched/)
  assert.match(context.systemPrompt, /previously read files|file contents restored/i)
})

test('analyzeContext returns token and compact diagnostics', async () => {
  const cwd = join(tmpdir(), `babel-o-context-analysis-${Date.now()}`)
  const events: NexusEvent[] = [
    {
      type: 'user_message',
      schemaVersion,
      sessionId: 'session-analysis',
      timestamp: '2026-05-23T00:00:00.000Z',
      text: '你好，分析上下文。',
    },
    {
      type: 'assistant_delta',
      schemaVersion,
      sessionId: 'session-analysis',
      timestamp: '2026-05-23T00:00:01.000Z',
      text: '上下文分析中。',
    },
  ]

  const analysis = await analyzeContext({
    runtimeOptions: {
      sessionId: 'session-analysis',
      prompt: '继续',
      cwd,
    },
    events,
    modelId: 'local/coding-runtime',
    buildSystemPrompt,
    mapEventsToMessages,
    tools: [
      {
        name: 'Read',
        description: 'Read files',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
      },
    ],
  })

  assert.equal(analysis.type, 'context_analysis')
  assert.equal(analysis.sections.toolDefinitionCount, 1)
  assert.ok(analysis.estimate.totalTokens > 0)
  assert.ok(analysis.window.maxTokens > 0)
  assert.equal(typeof analysis.sections.microcompactedEventCount, 'number')
  assert.equal(typeof analysis.sections.memoryTruncated, 'boolean')
  assert.ok(analysis.recommendations.length > 0)
})

test('manual compact smoke retains latest answerable context around cancellation and failures', async () => {
  const cwd = join(tmpdir(), `babel-o-compact-smoke-${Date.now()}`)
  const events: NexusEvent[] = [
    {
      type: 'user_message',
      schemaVersion,
      sessionId: 'session-context',
      timestamp: '2026-05-23T00:00:00.000Z',
      text: 'analyze the project',
    },
    {
      type: 'thinking_delta',
      schemaVersion,
      sessionId: 'session-context',
      timestamp: '2026-05-23T00:00:01.000Z',
      text: 'Thinking through a large task.',
    },
    {
      type: 'tool_completed',
      schemaVersion,
      sessionId: 'session-context',
      timestamp: '2026-05-23T00:00:02.000Z',
      toolUseId: 'tool-big',
      name: 'Read',
      success: true,
      output: 'x'.repeat(5000),
    },
    {
      type: 'error',
      schemaVersion,
      sessionId: 'session-context',
      timestamp: '2026-05-23T00:00:03.000Z',
      code: 'PROVIDER_ERROR',
      message: 'provider failed',
    },
    {
      type: 'error',
      schemaVersion,
      sessionId: 'session-context',
      timestamp: '2026-05-23T00:00:04.000Z',
      code: 'REQUEST_CANCELLED',
      message: 'Execution cancelled by user.',
    },
    {
      type: 'compact_boundary',
      schemaVersion,
      sessionId: 'session-context',
      timestamp: '2026-05-23T00:00:05.000Z',
      trigger: 'manual',
      summary: 'Earlier analysis and tool output summarized.',
      beforeEventCount: 5,
      afterEventCount: 1,
      summaryChars: 44,
      snippedToolResults: 1,
      modelId: 'local/coding-runtime',
      budget: allocateBudget('local/coding-runtime'),
    },
    {
      type: 'user_message',
      schemaVersion,
      sessionId: 'session-context',
      timestamp: '2026-05-23T00:00:06.000Z',
      text: 'what should I do next?',
    },
  ]

  const context = await assembleContext({
    runtimeOptions: {
      sessionId: 'session-context',
      prompt: 'what should I do next?',
      cwd,
    },
    events,
    modelId: 'local/coding-runtime',
    buildSystemPrompt,
    mapEventsToMessages,
  })

  assert.match(context.sessionSummary, /Earlier analysis/)
  assert.match(JSON.stringify(context.messages), /what should I do next\?/)
  assert.doesNotMatch(JSON.stringify(context.messages), /provider failed/)
  assert.doesNotMatch(JSON.stringify(context.messages), /Thinking through a large task/)
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
  assert.match(context.systemPrompt, /Context Boundary/)
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
  assert.doesNotMatch(context.systemPrompt, /Current user request:/)
  assert.match(JSON.stringify(context.messages), /你还记得我们之前在讨论什么吗/)
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
  assert.match(context.systemPrompt, /Context Boundary/)
  assert.match(context.systemPrompt, /REQUEST_CANCELLED|cancelled/i)
})

test('assembleContext treats short greetings as intent guidance without dropping prior context', async () => {
  const cwd = join(tmpdir(), `babel-o-short-pivot-${Date.now()}`)
  const events: NexusEvent[] = [
    {
      type: 'user_message',
      schemaVersion,
      sessionId: 'session-context',
      timestamp: '2026-05-23T00:00:00.000Z',
      text: '/Users/tangyaoyue/DEV/Baidu查看这个文件夹中的项目内容',
    },
  ]
  for (let index = 0; index < 30; index += 1) {
    events.push(
      {
        type: 'assistant_delta',
        schemaVersion,
        sessionId: 'session-context',
        timestamp: `2026-05-23T00:01:${String(index).padStart(2, '0')}.000Z`,
        text: `Baidu project summary fragment ${index}. `,
      },
      {
        type: 'tool_started',
        schemaVersion,
        sessionId: 'session-context',
        timestamp: `2026-05-23T00:02:${String(index).padStart(2, '0')}.000Z`,
        toolUseId: `baidu-tool-${index}`,
        name: 'Bash',
        input: { command: 'ls -la /Users/tangyaoyue/DEV/Baidu' },
      },
      {
        type: 'tool_completed',
        schemaVersion,
        sessionId: 'session-context',
        timestamp: `2026-05-23T00:03:${String(index).padStart(2, '0')}.000Z`,
        toolUseId: `baidu-tool-${index}`,
        name: 'Bash',
        success: true,
        output: { stdout: `Baidu old output ${index}` },
      },
    )
  }
  events.push({
    type: 'result',
    schemaVersion,
    sessionId: 'session-context',
    timestamp: '2026-05-23T00:04:00.000Z',
    success: true,
    message: 'Baidu summary done.',
  })
  events.push({
    type: 'user_message',
    schemaVersion,
    sessionId: 'session-context',
    timestamp: '2026-05-23T00:05:00.000Z',
    text: '你好？',
  })

  const context = await assembleContext({
    runtimeOptions: {
      sessionId: 'session-context',
      prompt: '你好？',
      cwd,
    },
    events,
    modelId: 'deepseek/deepseek-v4-pro',
    buildSystemPrompt,
    mapEventsToMessages,
  })

  const messagesText = JSON.stringify(context.messages)
  assert.match(messagesText, /你好？/)
  assert.match(messagesText, /Baidu old output|Baidu project summary/)
  assert.equal(context.userIntentGuidance.intent, 'greeting')
  assert.equal(context.userIntentGuidance.actionHint, 'respond_only')
  assert.match(context.systemPrompt, /User Intake Guidance/)
})

test('assembleContext treats user correction prompts as high-priority intent guidance', async () => {
  const cwd = join(tmpdir(), `babel-o-correction-pivot-${Date.now()}`)
  const events: NexusEvent[] = [
    {
      type: 'user_message',
      schemaVersion,
      sessionId: 'session-context',
      timestamp: '2026-05-23T00:00:00.000Z',
      text: '/Users/tangyaoyue/DEV/BABEL/BabeL-O分析能否作为服务内核',
    },
    {
      type: 'assistant_delta',
      schemaVersion,
      sessionId: 'session-context',
      timestamp: '2026-05-23T00:01:00.000Z',
      text: 'BabeL-O runtime analysis that should not anchor the correction.',
    },
    {
      type: 'result',
      schemaVersion,
      sessionId: 'session-context',
      timestamp: '2026-05-23T00:02:00.000Z',
      success: true,
      message: 'BabeL-O analysis done.',
    },
    {
      type: 'user_message',
      schemaVersion,
      sessionId: 'session-context',
      timestamp: '2026-05-23T00:03:00.000Z',
      text: '呃让你分析的就是babel-X项目',
    },
  ]

  const context = await assembleContext({
    runtimeOptions: {
      sessionId: 'session-context',
      prompt: '呃让你分析的就是babel-X项目',
      cwd,
    },
    events,
    modelId: 'deepseek/deepseek-v4-pro',
    buildSystemPrompt,
    mapEventsToMessages,
  })

  const messagesText = JSON.stringify(context.messages)
  assert.match(messagesText, /呃让你分析的就是babel-X项目/)
  assert.match(messagesText, /BabeL-O runtime analysis|BabeL-O analysis done/)
  assert.equal(context.userIntentGuidance.intent, 'correction')
  assert.equal(context.userIntentGuidance.actionHint, 'prioritize_latest')
  assert.match(context.systemPrompt, /prioritize the latest user message as the active task/i)
})

test('assembleContext keeps prior project context for malformed greeting like session_321c48be', async () => {
  const cwd = join(tmpdir(), `babel-o-session-321c48be-${Date.now()}`)
  const events: NexusEvent[] = [
    {
      type: 'user_message',
      schemaVersion,
      sessionId: 'session-context',
      timestamp: '2026-05-29T01:46:27.394Z',
      text: '/Users/tangyaoyue/DEV/Baidu check this profile, list what you can see in it',
    },
    {
      type: 'tool_started',
      schemaVersion,
      sessionId: 'session-context',
      timestamp: '2026-05-29T01:46:29.865Z',
      toolUseId: 'baidu-ls',
      name: 'Bash',
      input: { command: 'ls -la /Users/tangyaoyue/DEV/Baidu' },
    },
    {
      type: 'tool_completed',
      schemaVersion,
      sessionId: 'session-context',
      timestamp: '2026-05-29T01:46:29.964Z',
      toolUseId: 'baidu-ls',
      name: 'Bash',
      success: true,
      output: { stdout: 'Baidu directory listing with KeDU and app-bvh8xpidhpfl' },
    },
    {
      type: 'result',
      schemaVersion,
      sessionId: 'session-context',
      timestamp: '2026-05-29T01:47:04.339Z',
      success: true,
      message: 'Baidu summary complete.',
    },
    {
      type: 'user_message',
      schemaVersion,
      sessionId: 'session-context',
      timestamp: '2026-05-29T01:48:44.508Z',
      text: 'hi`',
    },
  ]

  const context = await assembleContext({
    runtimeOptions: {
      sessionId: 'session-context',
      prompt: 'hi`',
      cwd,
    },
    events,
    modelId: 'deepseek/deepseek-v4-pro',
    buildSystemPrompt,
    mapEventsToMessages,
  })

  const messagesText = JSON.stringify(context.messages)
  assert.match(messagesText, /Baidu directory listing|Baidu summary complete/)
  assert.equal(context.userIntentGuidance.intent, 'greeting')
  assert.equal(context.userIntentGuidance.actionHint, 'respond_only')
})

test('assembleContext converts pause requests into respond-only intent guidance', async () => {
  const cwd = join(tmpdir(), `babel-o-pause-guidance-${Date.now()}`)
  const events: NexusEvent[] = [
    {
      type: 'user_message',
      schemaVersion,
      sessionId: 'session-context',
      timestamp: '2026-05-29T01:48:44.508Z',
      text: 'can you give a connection analysis of these project?',
    },
    {
      type: 'tool_started',
      schemaVersion,
      sessionId: 'session-context',
      timestamp: '2026-05-29T01:48:47.460Z',
      toolUseId: 'old-ls',
      name: 'Bash',
      input: { command: 'ls -la /Users/tangyaoyue/DEV/Baidu' },
    },
    {
      type: 'tool_completed',
      schemaVersion,
      sessionId: 'session-context',
      timestamp: '2026-05-29T01:48:47.559Z',
      toolUseId: 'old-ls',
      name: 'Bash',
      success: true,
      output: { stdout: 'previous project listing' },
    },
    {
      type: 'user_message',
      schemaVersion,
      sessionId: 'session-context',
      timestamp: '2026-05-29T01:49:32.088Z',
      text: 'just stop it and waite for me other require',
    },
  ]

  const context = await assembleContext({
    runtimeOptions: {
      sessionId: 'session-context',
      prompt: 'just stop it and waite for me other require',
      cwd,
    },
    events,
    modelId: 'deepseek/deepseek-v4-pro',
    buildSystemPrompt,
    mapEventsToMessages,
  })

  assert.equal(context.userIntentGuidance.intent, 'pause')
  assert.equal(context.userIntentGuidance.actionHint, 'respond_only')
  assert.match(context.systemPrompt, /Do not start tool calls/)
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
  assert.match(systemPrompt, /inspect the explicit path\(s\) from the current message first/)
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

test('auto compact reduces session size while preserving recent user turns', async () => {
  const sessionId = 'session-auto-compact-test'
  const storage = new MemoryStorage()
  const events = createLongSessionEventsForAutoCompact(sessionId)
  await storage.saveSession({
    sessionId,
    cwd: '/tmp',
    prompt: 'benchmark',
    phase: 'executing',
    createdAt: '2026-05-23T00:00:00.000Z',
    updatedAt: '2026-05-23T00:00:00.000Z',
    events,
  })

  const result = await compactSession({
    storage,
    sessionId,
    modelId: 'local/coding-runtime',
    trigger: 'auto',
  })

  assert.ok(result.beforeEventCount > result.afterEventCount, 'beforeEventCount should exceed afterEventCount')
  assert.ok(result.beforeEventCount - result.afterEventCount > 50, 'auto-compact should reduce events by more than 50')

  const { events: postCompactEvents } = await storage.listEvents(sessionId, { limit: 10_000, order: 'asc' })
  assert.ok(
    postCompactEvents.some(event => event.type === 'compact_boundary' && event.trigger === 'auto'),
    'auto compact boundary should be persisted',
  )
  const assembled = await assembleContext({
    runtimeOptions: {
      sessionId,
      prompt: 'Continue after compact',
      cwd: '/tmp',
    },
    events: postCompactEvents,
    modelId: 'local/coding-runtime',
    buildSystemPrompt,
    mapEventsToMessages,
  })
  const messagesText = JSON.stringify(assembled.messages)

  assert.ok(messagesText.includes('Continue after auto-compact-turn-38.'), 'recent turn 38 should be preserved')
  assert.ok(messagesText.includes('Continue after auto-compact-turn-39.'), 'recent turn 39 should be preserved')
})

test('assembleContext verifies retained segment metadata and falls back on mismatch', async () => {
  const sessionId = 'session-retained-segment-test'
  const storage = new MemoryStorage()
  const events = createLongSessionEventsForAutoCompact(sessionId)
  await storage.saveSession({
    sessionId,
    cwd: '/tmp',
    prompt: 'benchmark',
    phase: 'executing',
    createdAt: '2026-05-23T00:00:00.000Z',
    updatedAt: '2026-05-23T00:00:00.000Z',
    events,
  })

  const result = await compactSession({
    storage,
    sessionId,
    modelId: 'local/coding-runtime',
    trigger: 'manual',
  })
  const corruptedBoundary = {
    ...result.event,
    retainedEvents: result.event.retainedEvents?.slice(1),
  }
  const assembled = await assembleContext({
    runtimeOptions: {
      sessionId,
      prompt: 'Continue after compact',
      cwd: '/tmp',
    },
    events: [...events, corruptedBoundary],
    modelId: 'local/coding-runtime',
    buildSystemPrompt,
    mapEventsToMessages,
  })

  assert.equal(assembled.compactRetainedSegmentValid, false)
  assert.match(assembled.compactRetainedSegmentWarning, /retained count mismatch/)
  assert.match(assembled.sessionSummary, /Preserved Segment Warning/)
  assert.ok(
    JSON.stringify(assembled.messages).includes('Continue after auto-compact-turn-39.'),
    'fallback should still preserve latest user context',
  )
})

test('compactSession writes opt-in Session Memory Lite without polluting assembled context', async () => {
  const previous = process.env.BABEL_O_SESSION_MEMORY_LITE
  process.env.BABEL_O_SESSION_MEMORY_LITE = '1'
  const cwd = join(tmpdir(), `babel-o-session-memory-${Date.now()}`)
  const sessionId = 'session-memory-lite-test'
  const storage = new MemoryStorage()
  const events = createLongSessionEventsForAutoCompact(sessionId).map(event =>
    event.type === 'session_started' ? { ...event, cwd } : event
  ) satisfies NexusEvent[]
  await mkdir(cwd, { recursive: true })
  await storage.saveSession({
    sessionId,
    cwd,
    prompt: 'benchmark',
    phase: 'executing',
    createdAt: '2026-05-23T00:00:00.000Z',
    updatedAt: '2026-05-23T00:00:00.000Z',
    events,
  })

  try {
    await compactSession({
      storage,
      sessionId,
      modelId: 'local/coding-runtime',
      trigger: 'manual',
    })

    const memoryPath = join(cwd, '.babel-o/session-memory.md')
    assert.equal(existsSync(memoryPath), true)
    const memoryText = await readFile(memoryPath, 'utf8')
    assert.match(memoryText, /manual compact/)
    assert.match(memoryText, /Omitted events summarized/)

    const persisted = await storage.listEvents(sessionId, { order: 'asc', limit: 10_000 })
    assert.ok(persisted.events.some(event => event.type === 'session_memory_updated'))

    const assembled = await assembleContext({
      runtimeOptions: {
        sessionId,
        prompt: 'Continue after compact',
        cwd,
      },
      events: persisted.events,
      modelId: 'local/coding-runtime',
      buildSystemPrompt,
      mapEventsToMessages,
    })
    assert.doesNotMatch(assembled.systemPrompt, /manual compact/)
    assert.doesNotMatch(JSON.stringify(assembled.messages), /session-memory/)
  } finally {
    if (previous === undefined) delete process.env.BABEL_O_SESSION_MEMORY_LITE
    else process.env.BABEL_O_SESSION_MEMORY_LITE = previous
    await rm(cwd, { recursive: true, force: true })
  }
})

test('auto compact preserves recovery boundary after cancellation or failure', async () => {
  const sessionId = 'session-recovery-compact-test'
  const storage = new MemoryStorage()
  const events: NexusEvent[] = [
    {
      type: 'user_message',
      schemaVersion,
      sessionId,
      timestamp: '2026-05-23T00:00:00.000Z',
      text: 'Start the task.',
    },
    {
      type: 'assistant_delta',
      schemaVersion,
      sessionId,
      timestamp: '2026-05-23T00:00:01.000Z',
      text: 'Working on it.',
    },
    {
      type: 'tool_started',
      schemaVersion,
      sessionId,
      timestamp: '2026-05-23T00:00:02.000Z',
      toolUseId: 'tool-1',
      name: 'Bash',
      input: { command: 'sleep 10' },
    },
    {
      type: 'tool_completed',
      schemaVersion,
      sessionId,
      timestamp: '2026-05-23T00:00:03.000Z',
      toolUseId: 'tool-1',
      name: 'Bash',
      success: false,
      output: 'Command was cancelled.',
    },
    {
      type: 'error',
      schemaVersion,
      sessionId,
      timestamp: '2026-05-23T00:00:04.000Z',
      code: 'REQUEST_CANCELLED',
      message: 'Execution cancelled by user.',
    },
    {
      type: 'user_message',
      schemaVersion,
      sessionId,
      timestamp: '2026-05-23T00:00:05.000Z',
      text: 'Follow-up after cancellation',
    },
    {
      type: 'assistant_delta',
      schemaVersion,
      sessionId,
      timestamp: '2026-05-23T00:00:06.000Z',
      text: 'Responding to follow-up.',
    },
    {
      type: 'tool_started',
      schemaVersion,
      sessionId,
      timestamp: '2026-05-23T00:00:07.000Z',
      toolUseId: 'tool-2',
      name: 'Read',
      input: { path: 'README.md' },
    },
    {
      type: 'tool_completed',
      schemaVersion,
      sessionId,
      timestamp: '2026-05-23T00:00:08.000Z',
      toolUseId: 'tool-2',
      name: 'Read',
      success: true,
      output: 'x'.repeat(5_000),
    },
    {
      type: 'user_message',
      schemaVersion,
      sessionId,
      timestamp: '2026-05-23T00:00:09.000Z',
      text: 'Final question after recovery.',
    },
  ]

  await storage.saveSession({
    sessionId,
    cwd: '/tmp',
    prompt: 'recovery test',
    phase: 'executing',
    createdAt: '2026-05-23T00:00:00.000Z',
    updatedAt: '2026-05-23T00:00:00.000Z',
    events,
  })

  await compactSession({
    storage,
    sessionId,
    modelId: 'local/coding-runtime',
    trigger: 'auto',
  })

  const { events: postCompactEvents } = await storage.listEvents(sessionId, { limit: 10_000, order: 'asc' })
  assert.ok(
    postCompactEvents.some(event => event.type === 'compact_boundary' && event.trigger === 'auto'),
    'auto compact boundary should be persisted',
  )
  const assembled = await assembleContext({
    runtimeOptions: {
      sessionId,
      prompt: 'Final question after recovery.',
      cwd: '/tmp',
    },
    events: postCompactEvents,
    modelId: 'local/coding-runtime',
    buildSystemPrompt,
    mapEventsToMessages,
  })
  const messagesText = JSON.stringify(assembled.messages)

  assert.ok(messagesText.includes('Follow-up after cancellation'), 'recovery boundary user message should survive auto-compact')
  assert.ok(messagesText.includes('Final question after recovery.'), 'final user message after recovery should survive auto-compact')
})

test('buildSystemPrompt anchors focus project when prompt lacks explicit path', async () => {
  const home = homedir()
  const projectCwd = join(tmpdir(), `babel-o-focus-test-${Date.now()}`)

  // When cwd is NOT home and prompt has NO explicit path → focus block appears
  const promptWithPath = buildSystemPrompt({
    sessionId: 'test',
    prompt: 'run tests',
    cwd: projectCwd,
  })
  assert.match(promptWithPath, /Current focus project:/)
  assert.match(promptWithPath, new RegExp(projectCwd))

  // When cwd IS home → no focus block
  const promptHome = buildSystemPrompt({
    sessionId: 'test',
    prompt: 'run tests',
    cwd: home,
  })
  assert.doesNotMatch(promptHome, /Current focus project:/)

  // When prompt HAS explicit path → focus block omitted (requestPathBlock handles it)
  const promptExplicit = buildSystemPrompt({
    sessionId: 'test',
    prompt: `check ${projectCwd}/src`,
    cwd: home,
  })
  assert.doesNotMatch(promptExplicit, /Current focus project:/)
  assert.match(promptExplicit, /Explicit paths in current request:/)
})

function createLongSessionEventsForAutoCompact(sessionId: string): NexusEvent[] {
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
      text: 'Start the long task.',
    },
  ]

  for (let index = 0; index < 40; index += 1) {
    const minute = String(index).padStart(2, '0')
    events.push(
      {
        type: 'assistant_delta',
        schemaVersion,
        sessionId,
        timestamp: `2026-05-23T00:${minute}:02.000Z`,
        text: `Assistant turn ${index} with a lengthy explanation that goes on and on to simulate real model output. `.repeat(20),
      },
      {
        type: 'thinking_delta',
        schemaVersion,
        sessionId,
        timestamp: `2026-05-23T00:${minute}:03.000Z`,
        text: `Thinking about turn ${index} and considering various approaches. `.repeat(10),
      },
      {
        type: 'tool_started',
        schemaVersion,
        sessionId,
        timestamp: `2026-05-23T00:${minute}:04.000Z`,
        toolUseId: `tool-${index}`,
        name: 'Read',
        input: { path: `src/feature-${index}.ts` },
      },
      {
        type: 'tool_completed',
        schemaVersion,
        sessionId,
        timestamp: `2026-05-23T00:${minute}:05.000Z`,
        toolUseId: `tool-${index}`,
        name: 'Read',
        success: true,
        output: `${'x'.repeat(10_000)}\nauto-compact-turn-${index}\n${'y'.repeat(10_000)}`,
      },
      {
        type: 'user_message',
        schemaVersion,
        sessionId,
        timestamp: `2026-05-23T00:${minute}:06.000Z`,
        text: `Continue after auto-compact-turn-${index}.`,
      },
    )
  }

  return events
}
