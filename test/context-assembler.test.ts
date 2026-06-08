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
  isRecoveryBoundaryError,
  buildRetainedSegmentMetadata,
  verifyRetainedSegment,
  microcompactEvents,
  protectToolPairs,
  selectOmittedEvents,
  type ContextBudget,
  selectRecentEvents,
} from '../src/runtime/contextAssembler.js'
import { snipEvent } from '../src/runtime/compactors/snipCompactor.js'
import {
  buildCompactCapabilityReminder,
  formatPostCompactState,
} from '../src/runtime/compactPostRestore.js'
import {
  getAutoCompactDecision,
  countConsecutiveAutoCompactFailures,
  compactSession,
} from '../src/runtime/compact.js'
import {
  flushSessionMemoryLiteQueue,
  queueSessionMemoryLiteUpdate,
} from '../src/runtime/sessionMemoryLite.js'
import { MemoryStorage } from '../src/storage/MemoryStorage.js'
import {
  buildSystemPrompt,
  mapEventsToMessages,
} from '../src/runtime/LLMCodingRuntime.js'
import { extractAbsolutePaths } from '../src/runtime/systemPromptBuilder.js'
import { homedir } from 'node:os'
import chalk from 'chalk'
import type { NexusEvent } from '../src/shared/events.js'
import type { ModelMessage } from '../src/providers/adapters/ModelAdapter.js'
import { analyzeContext, type ContextAnalysis } from '../src/runtime/contextAnalysis.js'
import { formatContextAnalysis } from '../src/cli/commands/chat.js'
import { normalizeContextViewKey, renderContextView } from '../src/cli/contextView.js'
import { CONTEXT_MANAGER_PHASES } from '../src/runtime/contextManager.js'
import { stripAnsi, visibleTerminalWidth } from '../src/cli/terminalWidth.js'
import { extractEverCoreMemoryHits } from '../src/runtime/memoryProvider.js'

const schemaVersion = '2026-05-21.babel-o.v1' as const

test('allocateBudget uses adaptive large-context ceiling and honors env cap', async () => {
  const previous = process.env.BABEL_O_MAX_CONTEXT_TOKENS
  try {
    delete process.env.BABEL_O_MAX_CONTEXT_TOKENS
    const budget = allocateBudget('anthropic/claude-3-5-sonnet')
    assert.equal(budget.maxTokens, 179_616)
    assert.ok(budget.maxTokens > 120_000)
    assert.ok(budget.layerBudgets.recent > 0)
    assert.ok(budget.snipToolOutputChars > 0)

    process.env.BABEL_O_MAX_CONTEXT_TOKENS = '120000'
    assert.equal(allocateBudget('anthropic/claude-3-5-sonnet').maxTokens, 120_000)

    process.env.BABEL_O_MAX_CONTEXT_TOKENS = '160000'
    const cappedAnalysis = await analyzeContext({
      runtimeOptions: {
        sessionId: 'session-env-cap',
        prompt: 'check env cap',
        cwd: tmpdir(),
      },
      events: [],
      modelId: 'minimax/MiniMax-M3',
      buildSystemPrompt,
      mapEventsToMessages,
    })
    assert.equal(cappedAnalysis.window.maxTokens, 160_000)
    assert.equal(cappedAnalysis.diagnostics.cacheEconomics.policySource, 'env_cap')
    assert.equal(cappedAnalysis.diagnostics.cacheEconomics.envMaxContextTokens, 160_000)
    assert.equal(cappedAnalysis.diagnostic.details.modelContextWindow, 200_000)
    assert.equal(cappedAnalysis.diagnostic.details.effectiveContextCeiling, 160_000)
    assert.equal(cappedAnalysis.diagnostic.details.policySource, 'env_cap')
    assert.match(cappedAnalysis.diagnostics.cacheEconomics.reason, /BABEL_O_MAX_CONTEXT_TOKENS/)
  } finally {
    if (previous === undefined) delete process.env.BABEL_O_MAX_CONTEXT_TOKENS
    else process.env.BABEL_O_MAX_CONTEXT_TOKENS = previous
  }
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

test('microcompact deduplicates repeated tool outputs while keeping latest result', () => {
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
      type: 'tool_started',
      schemaVersion,
      sessionId: 'session-context',
      timestamp: '2026-05-23T00:00:00.000Z',
      toolUseId: 'read-old',
      name: 'Read',
      input: { path: 'same.txt' },
    },
    {
      type: 'tool_completed',
      schemaVersion,
      sessionId: 'session-context',
      timestamp: '2026-05-23T00:00:01.000Z',
      toolUseId: 'read-old',
      name: 'Read',
      success: true,
      output: 'old-result'.repeat(80),
    },
    {
      type: 'tool_started',
      schemaVersion,
      sessionId: 'session-context',
      timestamp: '2026-05-23T00:00:02.000Z',
      toolUseId: 'read-new',
      name: 'Read',
      input: { path: 'same.txt' },
    },
    {
      type: 'tool_completed',
      schemaVersion,
      sessionId: 'session-context',
      timestamp: '2026-05-23T00:00:03.000Z',
      toolUseId: 'read-new',
      name: 'Read',
      success: true,
      output: 'latest-result',
    },
  ]

  const oldSourceOutput = (events[1] as Extract<NexusEvent, { type: 'tool_completed' }>).output
  const compacted = microcompactEvents(events, budget)
  const oldOutput = String((compacted[1] as Extract<NexusEvent, { type: 'tool_completed' }>).output)
  const latestOutput = String((compacted[3] as Extract<NexusEvent, { type: 'tool_completed' }>).output)

  assert.equal((events[1] as Extract<NexusEvent, { type: 'tool_completed' }>).output, oldSourceOutput)
  assert.equal(eventIdentity(compacted[3]!), eventIdentity(events[3]!))
  assert.match(oldOutput, /microcompacted duplicate Read result/)
  assert.match(oldOutput, /kept latest result later in context/)
  assert.equal(latestOutput, 'latest-result')
  assert.deepEqual(compacted.map(event => event.type), ['tool_started', 'tool_completed', 'tool_started', 'tool_completed'])
  assert.equal((compacted[0] as Extract<NexusEvent, { type: 'tool_started' }>).toolUseId, 'read-old')
  assert.equal((compacted[1] as Extract<NexusEvent, { type: 'tool_completed' }>).toolUseId, 'read-old')
})

test('assembleContext reports microcompact savings metrics', async () => {
  const cwd = join(tmpdir(), `babel-o-microcompact-metrics-${Date.now()}`)
  const events: NexusEvent[] = [
    {
      type: 'user_message',
      schemaVersion,
      sessionId: 'session-context',
      timestamp: '2026-05-23T00:00:00.000Z',
      text: 'inspect repeated file',
    },
    {
      type: 'tool_started',
      schemaVersion,
      sessionId: 'session-context',
      timestamp: '2026-05-23T00:00:01.000Z',
      toolUseId: 'read-old',
      name: 'Read',
      input: { path: 'same.txt' },
    },
    {
      type: 'tool_completed',
      schemaVersion,
      sessionId: 'session-context',
      timestamp: '2026-05-23T00:00:02.000Z',
      toolUseId: 'read-old',
      name: 'Read',
      success: true,
      output: 'old-result'.repeat(100),
    },
    {
      type: 'tool_started',
      schemaVersion,
      sessionId: 'session-context',
      timestamp: '2026-05-23T00:00:03.000Z',
      toolUseId: 'read-new',
      name: 'Read',
      input: { path: 'same.txt' },
    },
    {
      type: 'tool_completed',
      schemaVersion,
      sessionId: 'session-context',
      timestamp: '2026-05-23T00:00:04.000Z',
      toolUseId: 'read-new',
      name: 'Read',
      success: true,
      output: 'latest-result',
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

  assert.equal(context.microcompactMetrics.deduplicatedToolResultCount, 1)
  assert.equal(context.microcompactedEventCount, 1)
  assert.ok(context.microcompactMetrics.bytesSaved > 0)
  assert.ok(context.microcompactMetrics.estimatedTokensSaved > 0)
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

test('assembleContext injects working set from prior user and tool paths', async () => {
  const cwd = join(tmpdir(), `babel-o-working-context-${Date.now()}`)
  await mkdir(join(cwd, 'src'), { recursive: true })
  await writeFile(join(cwd, 'src', 'focus.ts'), 'export {}\n', 'utf8')

  const events: NexusEvent[] = [
    {
      type: 'user_message',
      schemaVersion,
      sessionId: 'session-context',
      timestamp: '2026-05-23T00:00:00.000Z',
      text: 'inspect src/focus.ts',
    },
    {
      type: 'tool_started',
      schemaVersion,
      sessionId: 'session-context',
      timestamp: '2026-05-23T00:00:01.000Z',
      toolUseId: 'tool-working-set',
      name: 'Read',
      input: { path: 'src/focus.ts' },
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

  assert.match(context.systemPrompt, /Working Set:/)
  assert.match(context.systemPrompt, /src\/focus\.ts/)
  assert.match(context.systemPrompt, /touches=2/)
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

test('compact post-restore module formats restored state and reminder', () => {
  const events: NexusEvent[] = [
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
      type: 'tool_started',
      schemaVersion,
      sessionId: 'session-context',
      timestamp: '2026-05-23T00:00:02.100Z',
      toolUseId: 'mcp-1',
      name: 'mcp:mock:echo',
      input: { message: 'hello' },
    },
    {
      type: 'tool_completed',
      schemaVersion,
      sessionId: 'session-context',
      timestamp: '2026-05-23T00:00:02.200Z',
      toolUseId: 'mcp-1',
      name: 'mcp:mock:echo',
      success: true,
      output: 'hello',
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
      type: 'task_session_event',
      schemaVersion,
      sessionId: 'session-context',
      eventId: 'evt-subtasks',
      eventType: 'subtasks_delegated',
      phase: 'executor',
      timestamp: '2026-05-23T00:00:03.100Z',
      payload: {
        accepted: 2,
        subTasks: [
          { taskId: 'task-2', title: 'Implement API' },
          { taskId: 'task-3', title: 'Implement UI' },
        ],
      },
    },
    {
      type: 'task_session_event',
      schemaVersion,
      sessionId: 'session-context',
      eventId: 'evt-subagent',
      eventType: 'subagent_completed',
      phase: 'executor',
      timestamp: '2026-05-23T00:00:03.200Z',
      payload: {
        taskId: 'task-2',
        subSessionId: 'session-child',
        title: 'Implement API',
        status: 'completed',
      },
    },
    {
      type: 'hook_completed',
      schemaVersion,
      sessionId: 'session-context',
      timestamp: '2026-05-23T00:00:04.000Z',
      hookName: 'SessionCleanupAuditHook',
      hookEvent: 'SessionEnd',
    },
  ]

  const state = derivePostCompactState(events, [{
    id: 'runtime-skill',
    name: 'Runtime',
    content: 'Skill content',
    triggers: ['runtime'],
    priority: 1,
  }])
  const block = formatPostCompactState(state)
  const reminder = buildCompactCapabilityReminder(state)

  assert.deepEqual(state.recentReadFiles, ['src/runtime/contextAssembler.ts'])
  assert.deepEqual(state.activeToolNames, ['Read', 'mcp:mock:echo'])
  assert.deepEqual(state.activeSkills, ['runtime-skill'])
  assert.ok(state.skillReminderLines.some(line => line.includes('runtime-skill')))
  assert.ok(state.mcpToolLines.some(line => line.includes('[completed] mcp:mock:echo')))
  assert.ok(state.toolContractLines.some(line => line.includes('tool_use/tool_result')))
  assert.ok(state.agentStatusLines.some(line => line.includes('subagent_completed Implement API')))
  assert.ok(state.subTaskStatusLines.some(line => line.includes('Implement API, Implement UI')))
  assert.match(block, /Post-Compact State/)
  assert.match(block, /Restored File Contents/)
  assert.match(block, /MCP tool audit/)
  assert.match(block, /Skill reminders/)
  assert.match(block, /Agent status/)
  assert.match(block, /Sub-task status/)
  assert.match(block, /SessionCleanupAuditHook/)
  assert.match(reminder, /File contents restored above for 1 file/)
  assert.match(reminder, /Active skill reminders have been re-announced/)
  assert.match(reminder, /MCP tool activity is listed above/)
  assert.match(reminder, /Agent and sub-task summaries above/)
  assert.match(reminder, /tool_use and tool_result pairs must remain matched/)
})

test('compact post-restore caps total restored file contents', () => {
  const events: NexusEvent[] = []
  for (let index = 0; index < 4; index += 1) {
    events.push({
      type: 'tool_started',
      schemaVersion,
      sessionId: 'session-context',
      timestamp: `2026-05-23T00:00:0${index}.000Z`,
      toolUseId: `read-${index}`,
      name: 'Read',
      input: { path: `src/file-${index}.ts` },
    })
    events.push({
      type: 'tool_completed',
      schemaVersion,
      sessionId: 'session-context',
      timestamp: `2026-05-23T00:00:1${index}.000Z`,
      toolUseId: `read-${index}`,
      name: 'Read',
      success: true,
      output: String(index).repeat(5_000),
    })
  }

  const state = derivePostCompactState(events, [])
  const totalChars = state.restoredFileContents.reduce((sum, file) => sum + file.content.length, 0)
  const block = formatPostCompactState(state)

  assert.equal(state.restoredFileContents.length, 3)
  assert.equal(totalChars, 12_000)
  assert.equal(state.restoredFileContents.some(file => file.truncated), true)
  assert.match(block, /restored content truncated at 2000\/5000 chars/)
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
      type: 'tool_started',
      schemaVersion,
      sessionId: 'session-context',
      timestamp: '2026-05-23T00:00:02.100Z',
      toolUseId: 'mcp-1',
      name: 'mcp:mock:echo',
      input: { message: 'hello' },
    },
    {
      type: 'tool_completed',
      schemaVersion,
      sessionId: 'session-context',
      timestamp: '2026-05-23T00:00:02.200Z',
      toolUseId: 'mcp-1',
      name: 'mcp:mock:echo',
      success: true,
      output: 'hello',
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
      type: 'task_session_event',
      schemaVersion,
      sessionId: 'session-context',
      eventId: 'evt-subtasks',
      eventType: 'subtasks_delegated',
      phase: 'executor',
      timestamp: '2026-05-23T00:00:03.100Z',
      payload: {
        accepted: 2,
        subTasks: [
          { taskId: 'task-2', title: 'Implement API' },
          { taskId: 'task-3', title: 'Implement UI' },
        ],
      },
    },
    {
      type: 'task_session_event',
      schemaVersion,
      sessionId: 'session-context',
      eventId: 'evt-subagent',
      eventType: 'subagent_completed',
      phase: 'executor',
      timestamp: '2026-05-23T00:00:03.200Z',
      payload: {
        taskId: 'task-2',
        subSessionId: 'session-child',
        title: 'Implement API',
        status: 'completed',
      },
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
  assert.ok(context.postCompactState.mcpToolLines.some(line => line.includes('mcp:mock:echo')))
  assert.ok(context.postCompactState.agentStatusLines.some(line => line.includes('subagent_completed')))
  assert.ok(context.postCompactState.subTaskStatusLines.some(line => line.includes('delegated')))
  assert.match(context.sessionSummary, /Post-Compact State/)
  assert.match(context.sessionSummary, /MCP tool audit/)
  assert.match(context.sessionSummary, /Agent status/)
  assert.match(context.sessionSummary, /Sub-task status/)
  assert.match(context.sessionSummary, /Compact Capability Reminder/)
  assert.match(context.sessionSummary, /tool_use and tool_result pairs must remain matched/)
  assert.match(context.systemPrompt, /previously read files|file contents restored/i)
  assert.match(context.systemPrompt, /MCP tool activity is listed above/)
})

test('assembleContext restores compact state across latest task and recovery fixtures', async () => {
  const cwd = join(tmpdir(), `babel-o-post-restore-recovery-${Date.now()}`)
  const scenarios: Array<{
    name: string
    latestPrompt: string
    afterCompactEvents: NexusEvent[]
    expectedMessages?: RegExp
    expectedSystemPrompt?: RegExp
  }> = [
    {
      name: 'latest-task',
      latestPrompt: '继续最新任务，先看 task-9 状态',
      afterCompactEvents: [
        {
          type: 'task_created',
          schemaVersion,
          sessionId: 'placeholder',
          timestamp: '2026-05-23T00:00:01.000Z',
          taskId: 'task-9',
          title: 'Review latest task',
        },
        {
          type: 'task_session_event',
          schemaVersion,
          sessionId: 'placeholder',
          eventId: 'evt-latest-task',
          eventType: 'task_blocked',
          phase: 'executor',
          timestamp: '2026-05-23T00:00:02.000Z',
          payload: { task: { taskId: 'task-9', title: 'Review latest task' } },
        },
      ],
      expectedSystemPrompt: /Review latest task/,
    },
    {
      name: 'workspace-escape',
      latestPrompt: '继续，正确路径是 src/runtime/compactPostRestore.ts',
      afterCompactEvents: [
        {
          type: 'tool_started',
          schemaVersion,
          sessionId: 'placeholder',
          timestamp: '2026-05-23T00:00:01.000Z',
          toolUseId: 'escape-1',
          name: 'Read',
          input: { path: '/outside/workspace/package.json' },
        },
        {
          type: 'tool_completed',
          schemaVersion,
          sessionId: 'placeholder',
          timestamp: '2026-05-23T00:00:02.000Z',
          toolUseId: 'escape-1',
          name: 'Read',
          success: false,
          output: {
            code: 'WORKSPACE_PATH_ESCAPE',
            message: 'Path is outside the current workspace.',
          },
        },
      ],
      expectedSystemPrompt: /WORKSPACE_PATH_ESCAPE/,
    },
    {
      name: 'cancel-boundary',
      latestPrompt: '取消后继续当前 compact post-restore 工作',
      afterCompactEvents: [
        {
          type: 'error',
          schemaVersion,
          sessionId: 'placeholder',
          timestamp: '2026-05-23T00:00:01.000Z',
          code: 'REQUEST_CANCELLED',
          message: 'Execution cancelled by user.',
        },
      ],
      expectedSystemPrompt: /REQUEST_CANCELLED|cancelled/i,
    },
    {
      name: 'empty-provider-response',
      latestPrompt: 'provider 空响应后继续 post-restore 验证',
      afterCompactEvents: [
        {
          type: 'error',
          schemaVersion,
          sessionId: 'placeholder',
          timestamp: '2026-05-23T00:00:01.000Z',
          code: 'EMPTY_PROVIDER_RESPONSE',
          message: 'Provider returned an empty response.',
        },
      ],
      expectedSystemPrompt: /EMPTY_PROVIDER_RESPONSE|empty response/i,
    },
  ]

  for (const scenario of scenarios) {
    const sessionId = `session-post-restore-${scenario.name}`
    const compactBoundary: NexusEvent = {
      type: 'compact_boundary',
      schemaVersion,
      sessionId,
      timestamp: '2026-05-23T00:00:00.000Z',
      trigger: 'manual',
      summary: 'Old stale pre-compact details summarized.',
      beforeEventCount: 20,
      afterEventCount: 4,
      summaryChars: 40,
      snippedToolResults: 0,
      modelId: 'local/coding-runtime',
      budget: allocateBudget('local/coding-runtime'),
      retainedEvents: [],
    } as any
    const events: NexusEvent[] = [
      compactBoundary,
      ...scenario.afterCompactEvents.map(event => ({ ...event, sessionId }) as NexusEvent),
      {
        type: 'tool_started',
        schemaVersion,
        sessionId,
        timestamp: '2026-05-23T00:00:03.000Z',
        toolUseId: `${scenario.name}-read`,
        name: 'Read',
        input: { path: 'src/runtime/compactPostRestore.ts' },
      },
      {
        type: 'tool_completed',
        schemaVersion,
        sessionId,
        timestamp: '2026-05-23T00:00:04.000Z',
        toolUseId: `${scenario.name}-read`,
        name: 'Read',
        success: true,
        output: 'restored compact post-restore content',
      },
      {
        type: 'user_message',
        schemaVersion,
        sessionId,
        timestamp: '2026-05-23T00:00:05.000Z',
        text: scenario.latestPrompt,
      },
    ]

    const context = await assembleContext({
      runtimeOptions: {
        sessionId,
        prompt: scenario.latestPrompt,
        cwd,
      },
      events,
      modelId: 'local/coding-runtime',
      buildSystemPrompt,
      mapEventsToMessages,
    })
    const messagesText = JSON.stringify(context.messages)

    assert.match(messagesText, new RegExp(escapeRegExp(scenario.latestPrompt)))
    assert.match(context.sessionSummary, /Post-Compact State/)
    assert.match(context.sessionSummary, /Compact Capability Reminder/)
    assert.match(context.sessionSummary, /src\/runtime\/compactPostRestore\.ts/)
    if (scenario.name === 'workspace-escape') {
      assert.ok(context.postCompactState.toolFailureLines.some(line => line.includes('WORKSPACE_PATH_ESCAPE')))
    }
    if (scenario.expectedMessages) assert.match(messagesText, scenario.expectedMessages)
    if (scenario.expectedSystemPrompt) assert.match(context.systemPrompt, scenario.expectedSystemPrompt)
  }
})

test('analyzeContext returns token and compact diagnostics', async () => {
  const cwd = join(tmpdir(), `babel-o-context-analysis-${Date.now()}`)
  const events: NexusEvent[] = [
    {
      type: 'user_message',
      schemaVersion,
      sessionId: 'session-analysis',
      timestamp: '2026-05-23T00:00:00.000Z',
      text: '你好，分析上下文 src/runtime/contextAnalysis.ts。',
    },
    {
      type: 'assistant_delta',
      schemaVersion,
      sessionId: 'session-analysis',
      timestamp: '2026-05-23T00:00:01.000Z',
      text: '上下文分析中。',
    },
    {
      type: 'thinking_delta',
      schemaVersion,
      sessionId: 'session-analysis',
      timestamp: '2026-05-23T00:00:02.000Z',
      text: 'reasoning text',
    },
    {
      type: 'tool_started',
      schemaVersion,
      sessionId: 'session-analysis',
      timestamp: '2026-05-23T00:00:03.000Z',
      toolUseId: 'read-old',
      name: 'Read',
      input: { path: 'src/runtime/contextAnalysis.ts' },
    },
    {
      type: 'tool_completed',
      schemaVersion,
      sessionId: 'session-analysis',
      timestamp: '2026-05-23T00:00:04.000Z',
      toolUseId: 'read-old',
      name: 'Read',
      success: true,
      output: 'large-result'.repeat(400),
    },
    {
      type: 'tool_started',
      schemaVersion,
      sessionId: 'session-analysis',
      timestamp: '2026-05-23T00:00:05.000Z',
      toolUseId: 'read-new',
      name: 'Read',
      input: { path: 'src/runtime/contextAnalysis.ts' },
    },
    {
      type: 'tool_completed',
      schemaVersion,
      sessionId: 'session-analysis',
      timestamp: '2026-05-23T00:00:06.000Z',
      toolUseId: 'read-new',
      name: 'Read',
      success: true,
      output: 'latest',
    },
    {
      type: 'usage',
      schemaVersion,
      sessionId: 'session-analysis',
      timestamp: '2026-05-23T00:00:07.000Z',
      inputTokens: 100,
      outputTokens: 25,
      cacheCreationInputTokens: 10,
      cacheReadInputTokens: 40,
    },
    {
      type: 'session_memory_updated',
      schemaVersion,
      sessionId: 'session-analysis',
      timestamp: '2026-05-23T00:00:07.500Z',
      path: '.babel-o/session-memory.md',
      trigger: 'reactive',
      summaryChars: 120,
      eventCount: 8,
      reason: 'pause',
      decisionReason: 'natural_pause',
      estimatedTokensSinceLastUpdate: 512,
      toolCallCount: 2,
      summaryMaxChars: 4000,
      summaryMode: 'extractive',
    } as any,
    {
      type: 'error',
      schemaVersion,
      sessionId: 'session-analysis',
      timestamp: '2026-05-23T00:00:08.000Z',
      code: 'REQUEST_CANCELLED',
      message: 'Execution cancelled by user.',
    },
    {
      type: 'user_message',
      schemaVersion,
      sessionId: 'session-analysis',
      timestamp: '2026-05-23T00:00:09.000Z',
      text: '等一下',
    },
  ]

  const analysis = await analyzeContext({
    runtimeOptions: {
      sessionId: 'session-analysis',
      prompt: '等一下',
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
  assert.equal(analysis.diagnostic.domain, 'context')
  assert.equal(analysis.diagnostic.name, 'context_analysis')
  assert.equal(analysis.diagnostic.details.sessionId, 'session-analysis')
  assert.equal(analysis.diagnostic.details.modelId, 'local/coding-runtime')
  assert.equal(typeof analysis.diagnostic.details.remainingTokens, 'number')
  assert.equal(typeof analysis.diagnostic.details.retainedContextItems, 'number')
  assert.equal(typeof analysis.diagnostic.details.droppedContextItems, 'number')
  assert.ok(analysis.diagnostic.signals.some(signal => signal.type === 'resume_recovery_boundary'))
  assert.equal(analysis.sections.toolDefinitionCount, 1)
  assert.ok(analysis.estimate.totalTokens > 0)
  assert.ok(analysis.window.maxTokens > 0)
  assert.equal(typeof analysis.sections.microcompactedEventCount, 'number')
  assert.equal(typeof analysis.sections.microcompactDeduplicatedToolResultCount, 'number')
  assert.equal(typeof analysis.sections.microcompactBytesSaved, 'number')
  assert.equal(typeof analysis.sections.microcompactEstimatedTokensSaved, 'number')
  assert.equal(typeof analysis.sections.memoryTruncated, 'boolean')
  assert.equal(analysis.userIntentGuidance.intent, 'pause')
  assert.equal(analysis.userIntentGuidance.actionHint, 'respond_only')
  assert.equal(analysis.runtimePolicy.toolsVisible, false)
  assert.equal(analysis.runtimePolicy.toolSuppressionReason, 'intent:pause:respond_only')
  assert.equal(analysis.runtimePolicy.recoveryBoundaryActive, true)
  assert.equal(analysis.runtimePolicy.recoveryBoundaryCode, 'REQUEST_CANCELLED')
  assert.equal(analysis.diagnostics.resumeRecovery.active, true)
  assert.equal(analysis.diagnostics.resumeRecovery.code, 'REQUEST_CANCELLED')
  assert.ok(analysis.diagnostics.signals.some(signal => signal.type === 'resume_recovery_boundary'))
  assert.equal(typeof analysis.diagnostics.remainingTokens, 'number')
  assert.equal(typeof analysis.diagnostics.remainingPercent, 'number')
  assert.equal(typeof analysis.diagnostics.compactRemainingTokens, 'number')
  assert.equal(typeof analysis.diagnostics.blockingRemainingTokens, 'number')
  assert.equal(analysis.diagnostics.workingSetPaths[0]?.path, 'src/runtime/contextAnalysis.ts')
  assert.equal(analysis.diagnostics.workingSetPaths[0]?.touches, 3)
  assert.deepEqual(analysis.diagnostics.selection.phases, CONTEXT_MANAGER_PHASES)
  assert.ok(analysis.diagnostics.selection.retained.length > 0)
  assert.ok(analysis.diagnostics.selection.dropped.length > 0)
  assert.ok(analysis.diagnostics.selection.retained.some(item => item.kind === 'event' && item.reason.includes('selected')))
  assert.ok(analysis.diagnostics.selection.dropped.some(item => item.reason.includes('omitted outside recent event budget')))
  assert.ok(analysis.diagnostics.selection.workingSetPaths.some(path => path.endsWith('src/runtime/contextAnalysis.ts')))
  assert.equal(analysis.diagnostic.details.retainedContextItems, analysis.diagnostics.selection.retained.length)
  assert.equal(analysis.diagnostic.details.droppedContextItems, analysis.diagnostics.selection.dropped.length)
  assert.equal(analysis.diagnostics.longTermMemory.provider, 'noop')
  assert.equal(analysis.diagnostics.longTermMemory.enabled, false)
  assert.equal(analysis.diagnostic.details.longTermMemoryEnabled, false)
  assert.equal(analysis.diagnostics.autoCompactFloor.thresholdPercent, analysis.diagnostics.autoCompact.thresholdPercent)
  assert.equal(analysis.diagnostics.autoCompactFloor.thresholdTokens, Math.floor(analysis.window.maxTokens * (analysis.diagnostics.autoCompact.thresholdPercent / 100)))
  assert.equal(analysis.diagnostics.autoCompactFloor.assemblyBudgetTokens, analysis.budget.maxTokens)
  assert.equal(analysis.diagnostics.compactTokenDelta.hasBoundary, false)
  assert.equal(typeof analysis.diagnostics.compactTokenDelta.afterEstimatedTokens, 'number')
  assert.equal(analysis.diagnostics.sessionMemoryLite.path, '.babel-o/session-memory.md')
  assert.equal(analysis.diagnostics.sessionMemoryLite.lastUpdate?.reason, 'pause')
  assert.equal(analysis.diagnostics.sessionMemoryLite.lastUpdate?.decisionReason, 'natural_pause')
  assert.equal(analysis.diagnostics.sessionMemoryLite.lastUpdate?.estimatedTokensSinceLastUpdate, 512)
  assert.equal(analysis.diagnostics.sessionMemoryLite.nextDecision.reason, 'natural_pause')
  assert.equal(analysis.diagnostics.sessionMemoryLite.costPolicy.modelFallback, 'extractive-only')
  assert.equal(analysis.diagnostics.sessionMemoryLite.costPolicy.maxSummaryChars, 4000)
  assert.equal(analysis.diagnostics.usageSummary.inputTokens, 100)
  assert.equal(analysis.diagnostics.usageSummary.outputTokens, 25)
  assert.equal(analysis.diagnostics.usageSummary.cacheReadInputTokens, 40)
  assert.equal(analysis.diagnostics.cacheEconomics.cacheReadRatio, 40 / 150)
  assert.equal(analysis.diagnostics.cacheEconomics.cachePreservationMode, false)
  assert.equal(analysis.diagnostics.cacheEconomics.longContextUtilizationMode, false)
  assert.equal(analysis.diagnostics.cacheEconomics.effectiveContextCeiling, analysis.window.maxTokens)
  assert.ok(analysis.diagnostics.cacheEconomics.cacheableSystemPromptRatio > 0)
  assert.ok(analysis.diagnostics.cacheEconomics.providerSafetyBufferTokens > 0)
  assert.match(analysis.diagnostics.cacheEconomics.reason, /legacy bounded context ceiling|cache preservation/)
  assert.ok(analysis.diagnostics.usageSummary.estimatedReasoningTokens > 0)
  assert.equal(analysis.diagnostics.repeatedToolInputs[0]?.name, 'Read')
  assert.equal(analysis.diagnostics.repeatedToolInputs[0]?.count, 2)
  assert.equal(analysis.diagnostics.largeToolResults[0]?.name, 'Read')
  assert.ok(analysis.diagnostics.largeToolResults[0]?.outputChars > 0)
  assert.ok(analysis.diagnostics.signals.some(signal => signal.type === 'large_tool_result'))
  assert.ok(analysis.diagnostics.signals.some(signal => signal.type === 'repeated_tool_input'))
  assert.ok(analysis.recommendations.some(recommendation => recommendation.includes('Large tool results')))
})

test('analyzeContext exposes long-term memory budget diagnostics', async () => {
  const analysis = await analyzeContext({
    runtimeOptions: {
      sessionId: 'session-long-term-memory-context',
      prompt: 'Use remembered EverCore constraints',
      cwd: tmpdir(),
    },
    events: [],
    modelId: 'local/coding-runtime',
    buildSystemPrompt,
    mapEventsToMessages,
    memoryProvider: {
      name: 'evercore-test',
      async retrieve() {
        return {
          content: '- Remembered constraint: volatile only.',
          diagnostics: {
            provider: 'evercore-test',
            enabled: true,
            hitCount: 2,
            injectedChars: 39,
            budgetChars: 64,
            maxHitChars: 32,
            truncated: true,
            searchLatencyMs: 12.5,
            scope: 'project',
            namespaceId: 'babel-o-dev',
            namespaceSource: 'workspace',
            isolationKey: 'projectId',
          },
        }
      },
    },
  })

  assert.equal(analysis.diagnostics.longTermMemory.provider, 'evercore-test')
  assert.equal(analysis.diagnostics.longTermMemory.enabled, true)
  assert.equal(analysis.diagnostics.longTermMemory.hitCount, 2)
  assert.equal(analysis.diagnostics.longTermMemory.injectedChars, 39)
  assert.equal(analysis.diagnostics.longTermMemory.budgetChars, 64)
  assert.equal(analysis.diagnostics.longTermMemory.maxHitChars, 32)
  assert.equal(analysis.diagnostics.longTermMemory.truncated, true)
  assert.equal(analysis.diagnostics.longTermMemory.scope, 'project')
  assert.equal(analysis.diagnostics.longTermMemory.namespaceId, 'babel-o-dev')
  assert.equal(analysis.diagnostics.longTermMemory.namespaceSource, 'workspace')
  assert.equal(analysis.diagnostics.longTermMemory.isolationKey, 'projectId')
  assert.equal(analysis.diagnostic.details.longTermMemoryProvider, 'evercore-test')
  assert.equal(analysis.diagnostic.details.longTermMemoryHitCount, 2)
  assert.equal(analysis.diagnostic.details.longTermMemoryInjectedChars, 39)
  assert.equal(analysis.diagnostic.details.longTermMemoryBudgetChars, 64)
  assert.equal(analysis.diagnostic.details.longTermMemoryTruncated, true)
  assert.equal(analysis.diagnostic.details.longTermMemoryScope, 'project')
  assert.equal(analysis.diagnostic.details.longTermMemoryNamespaceId, 'babel-o-dev')
  assert.equal(analysis.diagnostic.details.longTermMemoryNamespaceSource, 'workspace')
  assert.equal(analysis.diagnostic.details.longTermMemoryIsolationKey, 'projectId')
  assert.equal(analysis.diagnostic.details.longTermMemorySearchLatencyMs, 12.5)
  assert.equal(analysis.diagnostics.scopedMemory.length, 1)
  assert.equal(analysis.diagnostics.scopedMemory[0]?.scope, 'project')
  assert.equal(analysis.diagnostics.scopedMemory[0]?.namespaceId, 'babel-o-dev')
  assert.equal(analysis.diagnostic.details.scopedMemory.length, 1)
  assert.equal(analysis.diagnostic.details.scopedMemory[0]?.isolationKey, 'projectId')
  assert.ok(analysis.recommendations.some(recommendation => recommendation.includes('Long-term memory hits were truncated')))

  const rendered = formatContextAnalysis(analysis)
  assert.match(stripAnsi(rendered), /long-term memory evercore-test scope=project namespace=babel-o-dev source=workspace isolation=projectId · hits=2 injected=39 chars\/64 chars latency=13ms · truncated/)
  assert.match(stripAnsi(rendered), /scoped memory project evercore-test namespace=babel-o-dev source=workspace isolation=projectId · hits=2 injected=39 chars\/64 chars · truncated/)
})


test('analyzeContext exposes user and channel scoped memory diagnostics', async () => {
  const analysis = await analyzeContext({
    runtimeOptions: {
      sessionId: 'session-scoped-memory-context',
      prompt: 'Use scoped memory if relevant',
      cwd: tmpdir(),
    },
    events: [],
    modelId: 'local/coding-runtime',
    buildSystemPrompt,
    mapEventsToMessages,
    memoryProvider: {
      name: 'user-memory-test',
      async retrieve() {
        return {
          content: '- User prefers concise validation reports.',
          diagnostics: {
            provider: 'user-memory-test',
            enabled: true,
            hitCount: 1,
            injectedChars: 42,
            budgetChars: 96,
            maxHitChars: 96,
            truncated: false,
            scope: 'user',
            namespaceId: 'user-tangyaoyue',
            namespaceSource: 'explicit',
            isolationKey: 'userId',
          },
        }
      },
    },
    sessionInbox: [{
      messageId: 'msg-channel-memory',
      channelId: 'channel-session-pair',
      fromSessionId: 'session-a',
      toSessionId: 'session-scoped-memory-context',
      broadcast: false,
      type: 'finding',
      content: 'Sibling session verified that inbox context is collaboration-only.',
      priority: 'normal',
      createdAt: '2026-06-08T00:00:00.000Z',
      deliveredAt: '2026-06-08T00:00:00.000Z',
      status: 'delivered',
    }],
  })

  assert.equal(analysis.diagnostics.longTermMemory.scope, 'user')
  assert.equal(analysis.diagnostics.longTermMemory.isolationKey, 'userId')
  assert.equal(analysis.diagnostics.scopedMemory.length, 2)
  assert.equal(analysis.diagnostics.scopedMemory[0]?.scope, 'user')
  assert.equal(analysis.diagnostics.scopedMemory[1]?.scope, 'channel')
  assert.equal(analysis.diagnostics.scopedMemory[1]?.provider, 'session-channel')
  assert.equal(analysis.diagnostics.scopedMemory[1]?.namespaceId, 'channel-session-pair')
  assert.equal(analysis.diagnostics.scopedMemory[1]?.isolationKey, 'channelId')
  assert.equal(analysis.diagnostic.details.scopedMemory[1]?.scope, 'channel')
  assert.equal(analysis.diagnostic.details.scopedMemory[1]?.hitCount, 1)

  const rendered = stripAnsi(formatContextAnalysis(analysis))
  assert.match(rendered, /scoped memory user user-memory-test namespace=user-tangyaoyue source=explicit isolation=userId · hits=1 injected=42 chars\/96 chars/)
  assert.match(rendered, /scoped memory channel session-channel namespace=channel-session-pair isolation=channelId · hits=1 injected=/)
})


test('analyzeContext reports compact token delta after a compact boundary', async () => {
  const cwd = join(tmpdir(), `babel-o-context-compact-delta-${Date.now()}`)
  const retainedEvents: NexusEvent[] = [
    {
      type: 'user_message',
      schemaVersion,
      sessionId: 'session-analysis-compact',
      timestamp: '2026-05-23T00:00:04.000Z',
      text: 'continue from retained state',
    },
  ]
  const events: NexusEvent[] = [
    {
      type: 'user_message',
      schemaVersion,
      sessionId: 'session-analysis-compact',
      timestamp: '2026-05-23T00:00:00.000Z',
      text: 'inspect src/old.ts',
    },
    {
      type: 'tool_started',
      schemaVersion,
      sessionId: 'session-analysis-compact',
      timestamp: '2026-05-23T00:00:01.000Z',
      toolUseId: 'read-old',
      name: 'Read',
      input: { path: 'src/old.ts' },
    },
    {
      type: 'tool_completed',
      schemaVersion,
      sessionId: 'session-analysis-compact',
      timestamp: '2026-05-23T00:00:02.000Z',
      toolUseId: 'read-old',
      name: 'Read',
      success: true,
      output: 'old context '.repeat(2_000),
    },
    {
      type: 'assistant_delta',
      schemaVersion,
      sessionId: 'session-analysis-compact',
      timestamp: '2026-05-23T00:00:03.000Z',
      text: 'old context inspected',
    },
    {
      type: 'compact_boundary',
      schemaVersion,
      sessionId: 'session-analysis-compact',
      timestamp: '2026-05-23T00:00:05.000Z',
      trigger: 'manual',
      summary: 'Old context summarized.',
      beforeEventCount: 4,
      afterEventCount: 2,
      summaryChars: 23,
      snippedToolResults: 1,
      retainedEvents,
      modelId: 'local/coding-runtime',
      budget: allocateBudget('local/coding-runtime'),
    } as any,
    {
      type: 'user_message',
      schemaVersion,
      sessionId: 'session-analysis-compact',
      timestamp: '2026-05-23T00:00:06.000Z',
      text: 'continue in src/new.ts',
    },
  ]

  const analysis = await analyzeContext({
    runtimeOptions: {
      sessionId: 'session-analysis-compact',
      prompt: 'continue in src/new.ts',
      cwd,
    },
    events,
    modelId: 'local/coding-runtime',
    buildSystemPrompt,
    mapEventsToMessages,
  })

  assert.equal(analysis.compact.hasBoundary, true)
  assert.equal(analysis.diagnostics.compactTokenDelta.hasBoundary, true)
  assert.equal(analysis.diagnostics.compactTokenDelta.beforeEventCount, 4)
  assert.equal(analysis.diagnostics.compactTokenDelta.afterEventCount, 2)
  assert.equal(analysis.diagnostics.compactTokenDelta.eventCountDelta, 2)
  assert.ok(analysis.diagnostics.compactTokenDelta.beforeEstimatedTokens > analysis.diagnostics.compactTokenDelta.afterEstimatedTokens)
  assert.ok(analysis.diagnostics.compactTokenDelta.estimatedTokensSaved > 0)
  assert.ok(analysis.diagnostics.workingSetPaths.some(entry => entry.path === 'src/new.ts'))
})

test('/context display includes matching boundary diagnostics for CLI and API payloads', async () => {
  const cwd = join(tmpdir(), `babel-o-context-display-${Date.now()}`)
  const retainedEvents: NexusEvent[] = [
    {
      type: 'user_message',
      schemaVersion,
      sessionId: 'session-context-display',
      timestamp: '2026-05-23T00:00:04.000Z',
      text: 'continue after retained state',
    },
  ]
  const compactBoundary: NexusEvent = {
    type: 'compact_boundary',
    schemaVersion,
    sessionId: 'session-context-display',
    timestamp: '2026-05-23T00:00:05.000Z',
    trigger: 'manual',
    summary: 'Old display context summarized.',
    beforeEventCount: 4,
    afterEventCount: 2,
    summaryChars: 31,
    snippedToolResults: 1,
    retainedEvents,
    modelId: 'local/coding-runtime',
    budget: allocateBudget('local/coding-runtime'),
  } as any
  const events: NexusEvent[] = [
    {
      type: 'user_message',
      schemaVersion,
      sessionId: 'session-context-display',
      timestamp: '2026-05-23T00:00:00.000Z',
      text: 'inspect src/display.ts',
    },
    {
      type: 'tool_started',
      schemaVersion,
      sessionId: 'session-context-display',
      timestamp: '2026-05-23T00:00:01.000Z',
      toolUseId: 'display-read-old',
      name: 'Read',
      input: { path: 'src/display.ts' },
    },
    {
      type: 'tool_completed',
      schemaVersion,
      sessionId: 'session-context-display',
      timestamp: '2026-05-23T00:00:02.000Z',
      toolUseId: 'display-read-old',
      name: 'Read',
      success: true,
      output: 'display context '.repeat(2_000),
    },
    {
      type: 'assistant_delta',
      schemaVersion,
      sessionId: 'session-context-display',
      timestamp: '2026-05-23T00:00:03.000Z',
      text: 'display context inspected',
    },
    compactBoundary,
    {
      type: 'session_memory_updated',
      schemaVersion,
      sessionId: 'session-context-display',
      timestamp: '2026-05-23T00:00:05.500Z',
      path: '.babel-o/session-memory.md',
      trigger: 'manual',
      summaryChars: 256,
      eventCount: 4,
      reason: 'compact',
      decisionReason: 'forced',
      estimatedTokensSinceLastUpdate: 1024,
      toolCallCount: 1,
      summaryMaxChars: 4000,
      summaryMode: 'extractive',
    } as any,
    {
      type: 'error',
      schemaVersion,
      sessionId: 'session-context-display',
      timestamp: '2026-05-23T00:00:06.000Z',
      code: 'REQUEST_CANCELLED',
      message: 'Execution cancelled by user.',
    },
    {
      type: 'user_message',
      schemaVersion,
      sessionId: 'session-context-display',
      timestamp: '2026-05-23T00:00:07.000Z',
      text: 'continue in src/display-next.ts',
    },
  ]

  const analysis = await analyzeContext({
    runtimeOptions: {
      sessionId: 'session-context-display',
      prompt: 'continue in src/display-next.ts',
      cwd,
    },
    events,
    modelId: 'local/coding-runtime',
    buildSystemPrompt,
    mapEventsToMessages,
  })
  const colorAnalysis: ContextAnalysis = {
    ...analysis,
    estimate: {
      ...analysis.estimate,
      totalTokens: 41_200,
      systemPromptTokens: 19_000,
      toolDefinitionTokens: 15_200,
      messageTokens: 7_000,
    },
    sections: {
      ...analysis.sections,
      activeSkillsChars: 24_000,
    },
    window: {
      ...analysis.window,
      maxTokens: 200_000,
      compactThresholdTokens: 167_000,
    },
  }
  const originalChalkLevel = chalk.level
  chalk.level = 1
  let rawRendered = ''
  try {
    rawRendered = formatContextAnalysis(colorAnalysis)
  } finally {
    chalk.level = originalChalkLevel
  }
  const rendered = stripAnsi(formatContextAnalysis(analysis))
  const usageBarLine = rawRendered.split('\n').find(line => stripAnsi(line).includes(' used')) ?? ''

  assert.match(usageBarLine, /\x1b\[34m■+\x1b\[39m/)
  assert.match(usageBarLine, /\x1b\[35m■+\x1b\[39m/)
  assert.match(usageBarLine, /\x1b\[36m■+\x1b\[39m/)
  assert.match(usageBarLine, /\x1b\[32m■+\x1b\[39m/)
  assert.match(usageBarLine, /\x1b\[33m■+\x1b\[39m/)
  assert.match(usageBarLine, /\x1b\[2m□+\x1b\[22m/)
  assert.equal(analysis.diagnostics.compactRetention.hasBoundary, true)
  assert.equal(analysis.diagnostics.compactRetention.retainedSegmentValid, true)
  assert.equal(analysis.diagnostics.compactTokenDelta.hasBoundary, true)
  assert.equal(analysis.diagnostics.resumeRecovery.active, true)
  assert.ok(analysis.diagnostics.signals.some(signal => signal.type === 'resume_recovery_boundary'))
  assert.match(rendered, /BABEL Context/)
  assert.match(rendered, /retained segment valid · events=1/)
  assert.match(rendered, /compact delta events 4→2 · saved≈/)
  assert.match(rendered, /resume recovery boundary REQUEST_CANCELLED · Execution cancelled by user\./)
  assert.match(rendered, /working set paths src\/display-next\.ts×2/)
  assert.match(rendered, /cache policy read=/)
  assert.match(rendered, /cache policy reason /)
  assert.match(rendered, /selection items retained=\d+ dropped=\d+ · phases=8/)
  assert.match(rendered, /selection retained /)
  assert.match(rendered, /session memory lite .*last manual\/compact 256 chars events=4 · next=natural_pause update · policy=extractive max=4k chars/)
})

test('/context view defaults to visual summary and expands diagnostics', async () => {
  const cwd = join(tmpdir(), `babel-o-context-view-${Date.now()}`)
  const events: NexusEvent[] = [
    {
      type: 'user_message',
      schemaVersion,
      sessionId: 'session-context-view',
      timestamp: '2026-05-23T00:00:00.000Z',
      text: 'inspect src/view.ts',
    },
    {
      type: 'tool_started',
      schemaVersion,
      sessionId: 'session-context-view',
      timestamp: '2026-05-23T00:00:01.000Z',
      toolUseId: 'view-read',
      name: 'Read',
      input: { path: 'src/view.ts' },
    },
    {
      type: 'tool_completed',
      schemaVersion,
      sessionId: 'session-context-view',
      timestamp: '2026-05-23T00:00:02.000Z',
      toolUseId: 'view-read',
      name: 'Read',
      success: true,
      output: 'context view large result '.repeat(2_500),
    },
    {
      type: 'error',
      schemaVersion,
      sessionId: 'session-context-view',
      timestamp: '2026-05-23T00:00:03.000Z',
      code: 'CONTEXT_LIMIT_EXCEEDED',
      message: 'Context estimate exceeded window.',
    },
  ]

  const analysis = await analyzeContext({
    runtimeOptions: {
      sessionId: 'session-context-view',
      prompt: 'inspect src/view.ts',
      cwd,
    },
    events,
    modelId: 'local/coding-runtime',
    buildSystemPrompt,
    mapEventsToMessages,
  })
  const collapsed = stripAnsi(renderContextView(analysis, { expanded: false, scrollOffset: 0 }, { rows: 28, columns: 72 }))
  const expanded = stripAnsi(renderContextView(analysis, { expanded: true, scrollOffset: 0 }, { rows: 80, columns: 72 }))
  const narrow = stripAnsi(renderContextView(analysis, { expanded: true, scrollOffset: 0 }, { rows: 18, columns: 42 }))

  assert.match(collapsed, /BABEL Context/)
  assert.match(collapsed, /Current context by source/)
  assert.match(collapsed, /Assembled events\s+selected=/)
  assert.match(collapsed, /ctrl\+o show diagnostics · esc exit/)
  assert.doesNotMatch(collapsed, /Diagnostics scan full session history/)
  assert.doesNotMatch(collapsed, /Recommendations/)
  assert.match(expanded, /Diagnostics/)
  assert.match(expanded, /Diagnostics scan full session history/)
  assert.match(expanded, /historical largest tool result Read/)
  assert.match(expanded, /selection items retained=\d+ dropped=\d+ · phases=8/)
  assert.match(expanded, /selection retained /)
  assert.match(expanded, /Recommendations/)
  assert.equal(normalizeContextViewKey('\x0f'), 'toggle')
  assert.equal(normalizeContextViewKey('\x1b'), 'exit')
  assert.equal(normalizeContextViewKey('\x1b[B'), 'down')
  assert.ok(narrow.split('\n').every(line => visibleTerminalWidth(line) < 42), narrow)
})

test('/context display includes cache-aware long-context diagnostics', async () => {
  const cwd = join(tmpdir(), `babel-o-context-cache-display-${Date.now()}`)
  const events: NexusEvent[] = [
    {
      type: 'user_message',
      schemaVersion,
      sessionId: 'session-context-cache-display',
      timestamp: '2026-05-23T00:00:00.000Z',
      text: 'continue with cache-aware context diagnostics',
    },
    {
      type: 'usage',
      schemaVersion,
      sessionId: 'session-context-cache-display',
      timestamp: '2026-05-23T00:00:01.000Z',
      inputTokens: 10_000,
      outputTokens: 250,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 30_000,
    },
  ]

  const previous = process.env.BABEL_O_MAX_CONTEXT_TOKENS
  try {
    delete process.env.BABEL_O_MAX_CONTEXT_TOKENS
    const analysis = await analyzeContext({
      runtimeOptions: {
        sessionId: 'session-context-cache-display',
        prompt: 'continue with cache-aware context diagnostics',
        cwd,
        maxOutputTokens: 16_384,
      },
      events,
      modelId: 'minimax/MiniMax-M3',
      buildSystemPrompt,
      mapEventsToMessages,
    })
    const rendered = stripAnsi(formatContextAnalysis(analysis))

    assert.equal(analysis.window.maxTokens, 179_616)
    assert.equal(analysis.diagnostics.cacheEconomics.modelContextWindow, 200_000)
    assert.equal(analysis.diagnostics.cacheEconomics.legacyContextCeiling, 120_000)
    assert.equal(analysis.diagnostics.cacheEconomics.effectiveContextCeiling, 179_616)
    assert.equal(analysis.diagnostics.cacheEconomics.reservedOutputTokens, 16_384)
    assert.equal(analysis.diagnostics.cacheEconomics.providerSafetyBufferTokens, 4_000)
    assert.equal(analysis.diagnostics.cacheEconomics.policySource, 'large_context')
    assert.equal(analysis.diagnostics.cacheEconomics.longContextUtilizationMode, true)
    assert.equal(analysis.diagnostics.cacheEconomics.cachePreservationMode, true)
    assert.equal(analysis.diagnostics.cacheEconomics.warningThresholdPercent, 80)
    assert.equal(analysis.diagnostics.cacheEconomics.compactThresholdPercent, 93)
    assert.equal(analysis.diagnostics.cacheEconomics.compactThresholdTokens, Math.floor(179_616 * 0.93))
    assert.equal(analysis.diagnostics.cacheEconomics.blockingLimitTokens, Math.max(Math.floor(179_616 * 0.93), 179_616 - 1_000))
    assert.equal(analysis.diagnostics.autoCompact.thresholdPercent, 93)
    assert.equal(analysis.diagnostic.details.modelContextWindow, 200_000)
    assert.equal(analysis.diagnostic.details.policySource, 'large_context')
    assert.match(rendered, /cache policy read=75% cacheable=.*preserving=yes long-context=yes/)
    assert.match(rendered, /ceiling 179\.6k\/120k legacy/)
    assert.match(rendered, /ceiling source=large_context model\.window=200k reserved_output=16\.4k provider_buffer=4k/)
    assert.match(rendered, /thresholds warning=143\.7k \(80%\) compact=167\.0k \(93%\) blocking=178\.6k/)
    assert.match(rendered, /Large-context model and high prompt cache reuse detected/)
  } finally {
    if (previous === undefined) delete process.env.BABEL_O_MAX_CONTEXT_TOKENS
    else process.env.BABEL_O_MAX_CONTEXT_TOKENS = previous
  }
})

test('/context display includes blocking boundary diagnostics for CLI and API payloads', async () => {
  const cwd = join(tmpdir(), `babel-o-context-blocking-display-${Date.now()}`)
  const events: NexusEvent[] = [
    {
      type: 'user_message',
      schemaVersion,
      sessionId: 'session-context-blocking-display',
      timestamp: '2026-05-23T00:00:00.000Z',
      text: 'summarize blocking display state',
    },
  ]

  const analysis = await analyzeContext({
    runtimeOptions: {
      sessionId: 'session-context-blocking-display',
      prompt: 'summarize blocking display state',
      cwd,
    },
    events,
    modelId: 'local/coding-runtime',
    buildSystemPrompt: () => 'x'.repeat(26_000),
    mapEventsToMessages,
    warningPercent: 1,
  })
  const rendered = stripAnsi(formatContextAnalysis(analysis))

  assert.equal(analysis.window.isWarning, true)
  assert.ok(analysis.diagnostics.signals.some(signal => signal.type === 'near_capacity'))
  assert.ok(analysis.recommendations.some(recommendation => recommendation.includes('warning threshold')))
  assert.match(rendered, /warning Context is near capacity;/)
  assert.match(rendered, /Recommendations/)
  assert.match(rendered, /Context is near the warning threshold; consider \/compact soon\./)
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

test('verifyRetainedSegment reports each retained metadata mismatch independently', () => {
  const retainedEvents: NexusEvent[] = [
    {
      type: 'user_message',
      schemaVersion,
      sessionId: 'session-retained-fixture',
      timestamp: '2026-05-23T00:00:00.000Z',
      text: 'first retained turn',
    },
    {
      type: 'assistant_delta',
      schemaVersion,
      sessionId: 'session-retained-fixture',
      timestamp: '2026-05-23T00:00:01.000Z',
      text: 'retained answer',
    },
  ]
  const boundary: NexusEvent = {
    type: 'compact_boundary',
    schemaVersion,
    sessionId: 'session-retained-fixture',
    timestamp: '2026-05-23T00:00:02.000Z',
    trigger: 'manual',
    summary: 'Retained fixture summary.',
    beforeEventCount: 6,
    afterEventCount: 3,
    summaryChars: 25,
    snippedToolResults: 0,
  }
  const metadata = buildRetainedSegmentMetadata(retainedEvents, boundary)

  assert.deepEqual(verifyRetainedSegment(retainedEvents, metadata, boundary), { valid: true, warning: '' })
  assert.match(
    verifyRetainedSegment(retainedEvents, { ...metadata, boundaryId: 'wrong-boundary' }, boundary).warning,
    /retained boundary anchor mismatch/,
  )
  assert.match(
    verifyRetainedSegment(retainedEvents, { ...metadata, firstEventId: 'wrong-first' }, boundary).warning,
    /retained first event mismatch/,
  )
  assert.match(
    verifyRetainedSegment(retainedEvents, { ...metadata, lastEventId: 'wrong-last' }, boundary).warning,
    /retained last event mismatch/,
  )
  assert.match(
    verifyRetainedSegment(retainedEvents, { ...metadata, hash: 'wrong-hash' }, boundary).warning,
    /retained hash mismatch/,
  )
})

test('assembleContext uses retained tail after a valid compact boundary', async () => {
  const sessionId = 'session-retained-tail-test'
  const cwd = join(tmpdir(), `babel-o-retained-tail-${Date.now()}`)
  const retainedEvents: NexusEvent[] = [
    {
      type: 'user_message',
      schemaVersion,
      sessionId,
      timestamp: '2026-05-23T00:00:02.000Z',
      text: 'retained tail question',
    },
    {
      type: 'assistant_delta',
      schemaVersion,
      sessionId,
      timestamp: '2026-05-23T00:00:03.000Z',
      text: 'retained tail answer',
    },
  ]
  const boundaryBase: NexusEvent = {
    type: 'compact_boundary',
    schemaVersion,
    sessionId,
    timestamp: '2026-05-23T00:00:04.000Z',
    trigger: 'manual',
    summary: 'Old stale work summarized.',
    beforeEventCount: 4,
    afterEventCount: 3,
    summaryChars: 27,
    snippedToolResults: 0,
    retainedEvents,
    modelId: 'local/coding-runtime',
    budget: allocateBudget('local/coding-runtime'),
  } as any
  const boundary = {
    ...boundaryBase,
    retainedSegment: buildRetainedSegmentMetadata(retainedEvents, boundaryBase),
  }
  const events: NexusEvent[] = [
    {
      type: 'user_message',
      schemaVersion,
      sessionId,
      timestamp: '2026-05-23T00:00:00.000Z',
      text: 'stale pre-compact question',
    },
    {
      type: 'assistant_delta',
      schemaVersion,
      sessionId,
      timestamp: '2026-05-23T00:00:01.000Z',
      text: 'stale pre-compact answer',
    },
    ...retainedEvents,
    boundary,
    {
      type: 'user_message',
      schemaVersion,
      sessionId,
      timestamp: '2026-05-23T00:00:05.000Z',
      text: 'latest post-compact question',
    },
  ]

  const context = await assembleContext({
    runtimeOptions: {
      sessionId,
      prompt: 'latest post-compact question',
      cwd,
    },
    events,
    modelId: 'local/coding-runtime',
    buildSystemPrompt,
    mapEventsToMessages,
  })
  const messagesText = JSON.stringify(context.messages)

  assert.equal(context.compactRetainedSegmentValid, true)
  assert.equal(context.compactRetainedEventCount, 2)
  assert.match(messagesText, /retained tail question/)
  assert.match(messagesText, /retained tail answer/)
  assert.match(messagesText, /latest post-compact question/)
  assert.doesNotMatch(messagesText, /stale pre-compact question|stale pre-compact answer/)
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

  const analysis = await analyzeContext({
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

  assert.equal(analysis.diagnostics.compactRetention.hasBoundary, true)
  assert.equal(analysis.diagnostics.compactRetention.retainedSegmentValid, false)
  assert.equal(analysis.diagnostics.compactRetention.fallbackToFullHistory, true)
  assert.match(analysis.diagnostics.compactRetention.retainedSegmentWarning, /retained count mismatch/)
  assert.ok(analysis.diagnostics.signals.some(signal => signal.type === 'retained_segment_fallback'))
  assert.ok(analysis.recommendations.some(recommendation => recommendation.includes('retained segment validation failed')))
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

test('Session Memory Lite queues natural pause updates and skips duplicate turns', async () => {
  const previous = process.env.BABEL_O_SESSION_MEMORY_LITE
  process.env.BABEL_O_SESSION_MEMORY_LITE = '1'
  const cwd = join(tmpdir(), `babel-o-session-memory-queue-${Date.now()}`)
  const sessionId = 'session-memory-lite-queue-test'
  const storage = new MemoryStorage()
  const now = '2026-05-23T00:00:00.000Z'
  await mkdir(cwd, { recursive: true })
  await storage.saveSession({
    sessionId,
    cwd,
    prompt: 'Explain current status',
    phase: 'executing',
    createdAt: now,
    updatedAt: now,
    events: [
      {
        type: 'session_started',
        schemaVersion,
        sessionId,
        timestamp: now,
        cwd,
      },
      {
        type: 'user_message',
        schemaVersion,
        sessionId,
        timestamp: '2026-05-23T00:00:01.000Z',
        text: 'Explain current status',
      },
      {
        type: 'assistant_delta',
        schemaVersion,
        sessionId,
        timestamp: '2026-05-23T00:00:02.000Z',
        text: 'Current status is stable.',
      },
      {
        type: 'result',
        schemaVersion,
        sessionId,
        timestamp: '2026-05-23T00:00:03.000Z',
        success: true,
        message: 'Current status is stable.',
      },
    ],
  })

  try {
    queueSessionMemoryLiteUpdate({ storage, sessionId, cwd })
    queueSessionMemoryLiteUpdate({ storage, sessionId, cwd })
    await flushSessionMemoryLiteQueue()

    const memoryPath = join(cwd, '.babel-o/session-memory.md')
    assert.equal(existsSync(memoryPath), true)
    const memoryText = await readFile(memoryPath, 'utf8')
    assert.match(memoryText, /reactive pause/)
    assert.match(memoryText, /Events summarized/)

    const persisted = await storage.listEvents(sessionId, { order: 'asc', limit: 10_000 })
    const memoryEvents = persisted.events.filter(event => event.type === 'session_memory_updated')
    assert.equal(memoryEvents.length, 1)
    const memoryEvent = memoryEvents[0] as any
    assert.equal(memoryEvent.reason, 'pause')
    assert.equal(memoryEvent.decisionReason, 'natural_pause')
    assert.equal(memoryEvent.summaryMode, 'extractive')
    assert.equal(memoryEvent.summaryMaxChars, 4000)
    assert.equal(typeof memoryEvent.estimatedTokensSinceLastUpdate, 'number')
    assert.equal(memoryEvent.toolCallCount, 0)
  } finally {
    if (previous === undefined) delete process.env.BABEL_O_SESSION_MEMORY_LITE
    else process.env.BABEL_O_SESSION_MEMORY_LITE = previous
    await rm(cwd, { recursive: true, force: true })
  }
})

test('recovery boundary code fixture covers all resumable terminal errors', () => {
  const recoveryCodes = [
    'REQUEST_CANCELLED',
    'REQUEST_TIMEOUT',
    'EXECUTION_TIMEOUT',
    'PROVIDER_ERROR',
    'EMPTY_PROVIDER_RESPONSE',
    'CONTEXT_LIMIT_EXCEEDED',
    'MAX_LOOPS_EXCEEDED',
    'MAX_OUTPUT_TOKENS_EXCEEDED',
    'TOOL_LOOP_FINAL_RESPONSE_ONLY',
  ]
  for (const code of recoveryCodes) {
    assert.equal(isRecoveryBoundaryError(code), true, code)
  }
  assert.equal(isRecoveryBoundaryError('SCHEMA_VALIDATION_ERROR'), false)
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

test('assembleContext injects MemoryProvider results as volatile long-term memory', async () => {
  const context = await assembleContext({
    runtimeOptions: {
      sessionId: 'session-memory-provider-context',
      prompt: 'Use prior architecture context',
      cwd: tmpdir(),
    },
    events: [],
    modelId: 'local/coding-runtime',
    buildSystemPrompt,
    mapEventsToMessages,
    memoryProvider: {
      name: 'test-memory',
      async retrieve(input) {
        assert.equal(input.prompt, 'Use prior architecture context')
        return {
          content: '- Prior decision: keep EverCore memory volatile.',
          diagnostics: {
            provider: 'test-memory',
            enabled: true,
            hitCount: 1,
            injectedChars: 48,
            budgetChars: 128,
            maxHitChars: 64,
            truncated: false,
            scope: 'unknown',
          },
        }
      },
    },
  })

  assert.match(context.systemPrompt, /Long-term semantic memory \(volatile, retrieved for the current request\):/)
  assert.match(context.systemPrompt, /Prior decision: keep EverCore memory volatile/)
  assert.match(context.systemPrompt, /not authoritative project state/)
  assert.equal(context.memoryProviderDiagnostics?.provider, 'test-memory')
  assert.equal(context.memoryProviderDiagnostics?.hitCount, 1)
  assert.equal(context.systemPromptBlocks?.at(-1)?.cacheable, false)
  assert.equal(context.systemPromptBlocks?.at(-1)?.text.includes('Long-term semantic memory'), true)
})

test('extractEverCoreMemoryHits reads current EverOS typed search response', () => {
  const hits = extractEverCoreMemoryHits({
    request_id: 'req-1',
    data: {
      episodes: [{
        id: 'episode-1',
        summary: 'Conversation summary about runtime memory.',
        session_id: 'session-1',
        score: 0.91,
      }],
      profiles: [],
      agent_cases: [{
        id: 'case-1',
        approach: 'Use volatile context instead of authoritative storage replacement.',
        session_id: 'session-2',
        score: 0.82,
      }],
      agent_skills: [{
        id: 'skill-1',
        content: 'Keep memory retrieval bounded and non-cacheable.',
        name: 'bounded-memory',
        score: 0.77,
      }],
      unprocessed_messages: [],
    },
  })

  assert.deepEqual(hits.map(hit => hit.content), [
    'Conversation summary about runtime memory.',
    'Use volatile context instead of authoritative storage replacement.',
    'Keep memory retrieval bounded and non-cacheable.',
  ])
  assert.deepEqual(hits.map(hit => hit.source), ['episode-1', 'case-1', 'skill-1'])
  assert.deepEqual(hits.map(hit => hit.score), [0.91, 0.82, 0.77])
})


test('assembleContext keeps MemoryProvider failures out of provider-visible context', async () => {
  const context = await assembleContext({
    runtimeOptions: {
      sessionId: 'session-memory-provider-failure',
      prompt: 'Use prior context if available',
      cwd: tmpdir(),
    },
    events: [],
    modelId: 'local/coding-runtime',
    buildSystemPrompt,
    mapEventsToMessages,
    memoryProvider: {
      name: 'test-memory',
      async retrieve() {
        return {
          content: '',
          diagnostics: {
            provider: 'test-memory',
            enabled: true,
            hitCount: 0,
            injectedChars: 0,
            budgetChars: 128,
            maxHitChars: 64,
            truncated: false,
            scope: 'unknown',
            error: 'EverCore unavailable',
          },
        }
      },
    },
  })

  assert.doesNotMatch(context.systemPrompt, /Long-term semantic memory/)
  assert.doesNotMatch(context.systemPrompt, /EverCore unavailable/)
  assert.equal(context.memoryProviderDiagnostics?.error, 'EverCore unavailable')
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
