import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  assembleContext,
  selectRecentEvents,
  type ContextBudget,
} from '../src/runtime/contextAssembler.js'
import {
  buildSystemPrompt,
  mapEventsToMessages,
} from '../src/runtime/LLMCodingRuntime.js'
import type { NexusEvent } from '../src/shared/events.js'
import { findUngroundedAssistantContextPercentages } from '../src/runtime/contextNarrationDiagnostics.js'

const schemaVersion = '2026-05-21.babel-o.v1' as const

const tinyBudget: ContextBudget = {
  maxTokens: 100,
  maxChars: 400,
  layerBudgets: { system: 10, memory: 10, summary: 10, recent: 70 },
  snipToolOutputChars: 100,
  snipPriorTurnToolOutputChars: 30,
  microcompactToolOutputChars: 500,
  microcompactInternalTextChars: 200,
  recentEventLimit: 20,
  recentTurnLimit: 1,
}

test('context regression: workspace escape followed by continue keeps latest recovery turn', async () => {
  const sessionId = 'context-regression-workspace-escape'
  const cwd = join(tmpdir(), 'BABEL/BabeL-O')
  const wrongPath = '/Users/tangyaoyue/DEV/BabeL/BabeL-O/package.json'
  const latest = '继续，注意正确项目是 /Users/tangyaoyue/DEV/BABEL/BabeL-O'
  const events: NexusEvent[] = [
    user(sessionId, '2026-05-24T00:00:00.000Z', '核对 BabeL-O 上下文能力'),
    assistant(sessionId, '2026-05-24T00:00:01.000Z', '我先读取 package.json。'),
    toolStarted(sessionId, 'call-escape', 'Read', { path: wrongPath }, '2026-05-24T00:00:02.000Z'),
    toolCompleted(sessionId, 'call-escape', 'Read', false, {
      code: 'WORKSPACE_PATH_ESCAPE',
      message: 'Path is outside the current workspace.',
      requestedPath: wrongPath,
      cwd,
    }, '2026-05-24T00:00:03.000Z'),
    user(sessionId, '2026-05-24T00:00:04.000Z', latest),
  ]

  const selected = selectRecentEvents(events, tinyBudget)
  assert.equal(selected[0]?.type, 'user_message')
  assert.match((selected[0] as Extract<NexusEvent, { type: 'user_message' }>).text, /继续/)

  const assembled = await assembleContext({
    runtimeOptions: {
      sessionId,
      prompt: latest,
      cwd,
    },
    events,
    modelId: 'local/coding-runtime',
    buildSystemPrompt,
    mapEventsToMessages,
  })
  assert.match(JSON.stringify(assembled.messages), /正确项目/)
  assert.doesNotMatch(
    JSON.stringify(assembled.messages),
    /Let me first check what's in the third project|BabeL-X横向对比/,
  )
  assert.match(JSON.stringify(assembled.messages), /WORKSPACE_PATH_ESCAPE/)
  assert.equal(assembled.userIntentGuidance.actionHint, 'prioritize_latest')
})

test('context regression: cancel then continue starts from recovery boundary', () => {
  const sessionId = 'context-regression-cancel'
  const events: NexusEvent[] = [
    user(sessionId, '2026-05-24T00:00:00.000Z', '分析一个很长的旧任务'),
    assistant(sessionId, '2026-05-24T00:00:01.000Z', '旧任务输出'.repeat(200)),
    {
      type: 'error',
      schemaVersion,
      sessionId,
      timestamp: '2026-05-24T00:00:02.000Z',
      code: 'REQUEST_CANCELLED',
      message: 'Execution cancelled by user.',
    },
    user(sessionId, '2026-05-24T00:00:03.000Z', '你现在在干什么？'),
  ]

  const selected = selectRecentEvents(events, tinyBudget)
  assert.equal(selected.length, 1)
  assert.equal(selected[0]?.type, 'user_message')
  assert.equal((selected[0] as Extract<NexusEvent, { type: 'user_message' }>).text, '你现在在干什么？')
})

test('context regression: timeout then status follow-up starts from recovery boundary', () => {
  const sessionId = 'context-regression-timeout'
  const recoveryBudget: ContextBudget = {
    ...tinyBudget,
    recentEventLimit: 10,
    recentTurnLimit: 2,
  }
  const events: NexusEvent[] = [
    user(sessionId, '2026-05-24T00:00:00.000Z', '分析一个很长的旧任务'),
    assistant(sessionId, '2026-05-24T00:00:01.000Z', '旧任务输出'.repeat(200)),
    {
      type: 'error',
      schemaVersion,
      sessionId,
      timestamp: '2026-05-24T00:00:02.000Z',
      code: 'REQUEST_TIMEOUT',
      message: 'Execution timed out.',
    },
    user(sessionId, '2026-05-24T00:00:03.000Z', '你现在在干什么？'),
  ]

  const selected = selectRecentEvents(events, recoveryBudget)
  assert.equal(selected.length, 1)
  assert.equal(selected[0]?.type, 'user_message')
  assert.equal((selected[0] as Extract<NexusEvent, { type: 'user_message' }>).text, '你现在在干什么？')
  assert.doesNotMatch(JSON.stringify(selected), /旧任务输出/)
})

test('context regression: terse correction prioritizes latest target without dropping background', async () => {
  const sessionId = 'context-regression-short-correction'
  const cwd = join(tmpdir(), 'BABEL/BabeL-O')
  const latest = '不是这个，是 /Users/tangyaoyue/DEV/BABEL/BabeL-X'
  const events: NexusEvent[] = [
    user(sessionId, '2026-05-24T00:00:00.000Z', '/Users/tangyaoyue/DEV/BABEL/BabeL-O 分析这个项目'),
    assistant(sessionId, '2026-05-24T00:00:01.000Z', 'BabeL-O runtime analysis background.'),
    toolStarted(sessionId, 'call-old-read', 'Read', { path: '/Users/tangyaoyue/DEV/BABEL/BabeL-O/package.json' }, '2026-05-24T00:00:02.000Z'),
    toolCompleted(sessionId, 'call-old-read', 'Read', true, 'BabeL-O package content', '2026-05-24T00:00:03.000Z'),
    user(sessionId, '2026-05-24T00:00:04.000Z', latest),
  ]

  const assembled = await assembleContext({
    runtimeOptions: {
      sessionId,
      prompt: latest,
      cwd,
    },
    events,
    modelId: 'local/coding-runtime',
    buildSystemPrompt,
    mapEventsToMessages,
  })

  assert.equal(assembled.userIntentGuidance.intent, 'correction')
  assert.equal(assembled.userIntentGuidance.actionHint, 'prioritize_latest')
  assert.match(JSON.stringify(assembled.messages), /BabeL-X/)
  assert.match(JSON.stringify(assembled.messages), /BabeL-O runtime analysis background|BabeL-O package content/)
  assert.match(assembled.systemPrompt, /prioritize the latest user message as the active task/i)
})

test('context regression: multi-path comparison keeps both explicit paths as latest focus', async () => {
  const sessionId = 'context-regression-multipath'
  const cwd = join(tmpdir(), 'BABEL/BabeL-O')
  const leftPath = '/Users/tangyaoyue/DEV/BABEL/BabeL-O'
  const rightPath = '/Users/tangyaoyue/DEV/BABEL/BabeL-X'
  const latest = `横向比较 ${leftPath} 和 ${rightPath} 的上下文机制差异`
  const events: NexusEvent[] = [
    user(sessionId, '2026-05-24T00:00:00.000Z', '/Users/tangyaoyue/DEV/Baidu 查看这个旧项目'),
    assistant(sessionId, '2026-05-24T00:00:01.000Z', 'Baidu stale analysis background.'),
    user(sessionId, '2026-05-24T00:00:02.000Z', latest),
  ]

  const assembled = await assembleContext({
    runtimeOptions: {
      sessionId,
      prompt: latest,
      cwd,
    },
    events,
    modelId: 'local/coding-runtime',
    buildSystemPrompt,
    mapEventsToMessages,
  })

  assert.equal(assembled.userIntentGuidance.intent, 'new_focus')
  assert.equal(assembled.userIntentGuidance.actionHint, 'prioritize_latest')
  assert.deepEqual(assembled.userIntentGuidance.explicitPaths, [leftPath, rightPath])
  assert.match(JSON.stringify(assembled.messages), /BabeL-O/)
  assert.match(JSON.stringify(assembled.messages), /BabeL-X/)
  assert.match(assembled.systemPrompt, new RegExp(leftPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(assembled.systemPrompt, new RegExp(rightPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})

test('context regression: real session_321c48be replay keeps Baidu context for malformed greeting', async () => {
  const sessionId = 'session_321c48be-0ffd-4ec4-bfc0-9ba7f1896f8f'
  const events = realSession321c48beReplayEvents().slice(0, 11)

  const assembled = await assembleContext({
    runtimeOptions: {
      sessionId,
      prompt: 'hi`',
      cwd: '/Users/tangyaoyue/DEV/Baidu',
    },
    events,
    modelId: 'local/coding-runtime',
    buildSystemPrompt,
    mapEventsToMessages,
  })

  const messages = JSON.stringify(assembled.messages)
  assert.equal(assembled.userIntentGuidance.intent, 'greeting')
  assert.equal(assembled.userIntentGuidance.actionHint, 'respond_only')
  assert.equal(assembled.userIntentGuidance.requiresTools, false)
  assert.match(messages, /hi`/)
  assert.match(messages, /KeDU-动态百科服务平台|app-bvh8xpidhpfl|Baidu workspace connection summary/)
})

test('context regression: real session_3ba2d788 replay binds greeting to latest prompt', async () => {
  const sessionId = 'session_3ba2d788-6f78-468b-b01d-0a6a10ade46f'
  const oldPrompt = '我记得bebal-X也有对应的上下文压缩机制呀，你再仔细看看'
  const latest = '你好？'
  const events: NexusEvent[] = [
    user(sessionId, '2026-05-29T15:19:30.000Z', oldPrompt),
    {
      type: 'user_intake_guidance',
      schemaVersion,
      sessionId,
      timestamp: '2026-05-29T15:19:31.000Z',
      userText: oldPrompt,
      intent: 'continue',
      confidence: 0.9,
      continuity: 0.8,
      contextScope: 'full',
      actionHint: 'normal',
      requiresTools: true,
      reason: 'Old intake from a previous turn.',
      guidance: 'Continue inspecting BabeL-X context compression.',
      explicitPaths: [
        '/Users/tangyaoyou/DEV/gemini-cli',
        '/Users/tangyaoyao/DEV/gemini-cli',
      ],
      source: 'model',
    },
    assistant(sessionId, '2026-05-29T15:19:32.000Z', '旧上下文压缩分析。'),
    toolStarted(sessionId, 'call-stale-grep', 'Grep', { pattern: 'compact', path: '/Users/tangyaoyue/DEV/BABEL/BabeL-X' }, '2026-05-29T15:19:33.000Z'),
    toolCompleted(sessionId, 'call-stale-grep', 'Grep', true, { matches: ['old BabeL-X result'] }, '2026-05-29T15:19:34.000Z'),
    user(sessionId, '2026-05-29T15:22:48.000Z', latest),
  ]

  const assembled = await assembleContext({
    runtimeOptions: {
      sessionId,
      prompt: latest,
      cwd: '/Users/tangyaoyue/DEV/BABEL/BabeL-O',
    },
    events,
    modelId: 'local/coding-runtime',
    buildSystemPrompt,
    mapEventsToMessages,
  })

  assert.equal(assembled.userIntentGuidance.latestUserText, latest)
  assert.equal(assembled.userIntentGuidance.intent, 'greeting')
  assert.equal(assembled.userIntentGuidance.actionHint, 'respond_only')
  assert.equal(assembled.userIntentGuidance.requiresTools, false)
  assert.deepEqual(assembled.userIntentGuidance.explicitPaths, [])
  assert.match(assembled.systemPrompt, /respond directly to the latest user message/i)
  assert.doesNotMatch(assembled.systemPrompt, /tangyaoyou|tangyaoyao/)
})

test('context regression: real session_321c48be replay treats post-cancel stop as recovery boundary', async () => {
  const sessionId = 'session_321c48be-0ffd-4ec4-bfc0-9ba7f1896f8f'
  const events = realSession321c48beReplayEvents().slice(0, 13)

  const selected = selectRecentEvents(events, {
    ...tinyBudget,
    recentTurnLimit: 3,
    recentEventLimit: 30,
  })
  assert.equal(selected.length, 1)
  assert.equal(selected[0]?.type, 'user_message')
  assert.equal((selected[0] as Extract<NexusEvent, { type: 'user_message' }>).text, 'just stop it and waite for me other require')

  const assembled = await assembleContext({
    runtimeOptions: {
      sessionId,
      prompt: 'just stop it and waite for me other require',
      cwd: '/Users/tangyaoyue/DEV/Baidu',
    },
    events,
    modelId: 'local/coding-runtime',
    buildSystemPrompt,
    mapEventsToMessages,
  })

  const messages = JSON.stringify(assembled.messages)
  assert.equal(assembled.userIntentGuidance.intent, 'pause')
  assert.equal(assembled.userIntentGuidance.actionHint, 'respond_only')
  assert.equal(assembled.userIntentGuidance.requiresTools, false)
  assert.match(messages, /just stop it and waite for me other require/)
  assert.doesNotMatch(messages, /README discovery after malformed greeting|call_00_FxDwoeRnGS0L8GjZf6T26228/)
})

test('context regression: terminal runtime errors start the next turn from recovery boundary', () => {
  const recoveryCodes = [
    'PROVIDER_ERROR',
    'EMPTY_PROVIDER_RESPONSE',
    'CONTEXT_LIMIT_EXCEEDED',
    'MAX_LOOPS_EXCEEDED',
    'MAX_OUTPUT_TOKENS_EXCEEDED',
    'TOOL_LOOP_FINAL_RESPONSE_ONLY',
  ]

  for (const code of recoveryCodes) {
    const sessionId = `context-regression-${code.toLowerCase()}`
    const events: NexusEvent[] = [
      user(sessionId, '2026-05-24T00:00:00.000Z', '分析一个旧任务'),
      assistant(sessionId, '2026-05-24T00:00:01.000Z', `旧任务输出 ${code} `.repeat(50)),
      {
        type: 'error',
        schemaVersion,
        sessionId,
        timestamp: '2026-05-24T00:00:02.000Z',
        code,
        message: `${code} happened.`,
      },
      user(sessionId, '2026-05-24T00:00:03.000Z', '你现在在干什么？'),
    ]

    const selected = selectRecentEvents(events, {
      ...tinyBudget,
      recentTurnLimit: 2,
      recentEventLimit: 10,
    })
    assert.equal(selected.length, 1, code)
    assert.equal(selected[0]?.type, 'user_message', code)
    assert.equal((selected[0] as Extract<NexusEvent, { type: 'user_message' }>).text, '你现在在干什么？', code)
    assert.doesNotMatch(JSON.stringify(selected), /旧任务输出/, code)
  }
})

test('context regression: provider empty response and invalid tool input remain recoverable context', () => {
  const sessionId = 'context-regression-provider-tool'
  const messages = mapEventsToMessages([
    user(sessionId, '2026-05-24T00:00:00.000Z', '写入计划文件'),
    {
      type: 'error',
      schemaVersion,
      sessionId,
      timestamp: '2026-05-24T00:00:01.000Z',
      code: 'EMPTY_PROVIDER_RESPONSE',
      message: 'Provider returned an empty assistant response with no tool calls.',
    },
    user(sessionId, '2026-05-24T00:00:02.000Z', '继续，先修复刚才空响应'),
    toolStarted(sessionId, 'call-invalid', 'Write', { content: 'draft' }, '2026-05-24T00:00:03.000Z'),
    toolCompleted(sessionId, 'call-invalid', 'Write', false, {
      code: 'INVALID_TOOL_INPUT',
      message: 'Invalid input for tool Write. path is required.',
    }, '2026-05-24T00:00:04.000Z'),
  ], '写入计划文件')

  const serialized = JSON.stringify(messages)
  assert.match(serialized, /继续，先修复刚才空响应/)
  assert.match(serialized, /INVALID_TOOL_INPUT/)
})

test('context regression: ungrounded assistant context percentage is diagnosed', () => {
  const sessionId = 'session_661479db-6327-46f2-a793-7b88e0431174'
  const events: NexusEvent[] = [
    user(sessionId, '2026-06-12T03:46:04.762Z', 'AgentLoop、Provider Registry、Tool 风险分类需要进行更深入的源码级对比'),
    assistant(sessionId, '2026-06-12T03:46:45.746Z', '已掌握三个核心模块的完整实现细'),
    assistant(sessionId, '2026-06-12T03:46:47.133Z', '节及跨模块的衔接逻辑。上下文已 91%，停止深读并直接产出对比分析。'),
    {
      type: 'usage',
      schemaVersion,
      sessionId,
      timestamp: '2026-06-12T03:46:44.881Z',
      inputTokens: 63721,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 114,
    },
  ]

  const diagnostics = findUngroundedAssistantContextPercentages(events)
  assert.equal(diagnostics.length, 1)
  assert.equal(diagnostics[0]?.code, 'MODEL_CONTEXT_PERCENT_UNGROUNDED')
  assert.equal(diagnostics[0]?.percent, 91)
  assert.match(diagnostics[0]?.textSnippet ?? '', /上下文已 91%/)
  assert.match(diagnostics[0]?.reason ?? '', /without a recent runtime context event/)
})

test('context regression: assistant context percentage grounded by runtime event is not diagnosed', () => {
  const sessionId = 'context-regression-grounded-context-percent'
  const events: NexusEvent[] = [
    user(sessionId, '2026-06-12T03:46:04.762Z', '继续分析'),
    {
      type: 'context_warning',
      schemaVersion,
      sessionId,
      timestamp: '2026-06-12T03:46:44.000Z',
      modelId: 'minimax/MiniMax-M2.7',
      tokenEstimate: 163800,
      maxTokens: 180000,
      percentUsed: 91,
      thresholdPercent: 70,
      message: 'Context is near capacity.',
    },
    assistant(sessionId, '2026-06-12T03:46:47.133Z', 'runtime 已报告上下文 91%，我先收口当前分析。'),
  ]

  const diagnostics = findUngroundedAssistantContextPercentages(events)
  assert.equal(diagnostics.length, 0)
})

function realSession321c48beReplayEvents(): NexusEvent[] {
  const sessionId = 'session_321c48be-0ffd-4ec4-bfc0-9ba7f1896f8f'
  return [
    user(sessionId, '2026-05-29T01:46:27.394Z', '/Users/tangyaoyue/DEV/Baidu check this profile, list what you can see in it'),
    toolStarted(sessionId, 'call_00_H3fTqYK4tAfBm9TlzhTy6407', 'Bash', { command: 'ls -la /Users/tangyaoyue/DEV/Baidu' }, '2026-05-29T01:46:29.865Z'),
    toolCompleted(sessionId, 'call_00_H3fTqYK4tAfBm9TlzhTy6407', 'Bash', true, {
      stdout: 'Baidu workspace listing with app-bvh8xpidhpfl, app-bvh8xpidhpfl-server, dongtai-baike-整理, KeDU-动态百科服务平台.',
    }, '2026-05-29T01:46:29.964Z'),
    toolStarted(sessionId, 'call_00_YuEjpLbu7HgTby4cTIWK3821', 'Bash', { command: 'list Baidu subprojects' }, '2026-05-29T01:46:38.188Z'),
    toolCompleted(sessionId, 'call_00_YuEjpLbu7HgTby4cTIWK3821', 'Bash', true, {
      stdout: 'Subprojects include Baidu/, app-bvh8xpidhpfl/, app-bvh8xpidhpfl-server/, dongtai-baike-整理/, KeDU-动态百科服务平台/.',
    }, '2026-05-29T01:46:40.830Z'),
    {
      type: 'result',
      schemaVersion,
      sessionId,
      timestamp: '2026-05-29T01:47:04.339Z',
      success: true,
      message: 'Baidu workspace summary complete: KeDU-动态百科服务平台, app-bvh8xpidhpfl frontend, app-bvh8xpidhpfl-server backend, and project documentation folders.',
    },
    user(sessionId, '2026-05-29T01:47:58.027Z', 'can you give a connection analysis of these project?'),
    toolStarted(sessionId, 'call_00_pmtR6Q45WtK96UqPikpo2596', 'Bash', { command: 'ls -la /Users/tangyaoyue/DEV/Baidu' }, '2026-05-29T01:48:00.918Z'),
    toolCompleted(sessionId, 'call_00_pmtR6Q45WtK96UqPikpo2596', 'Bash', true, {
      stdout: 'Baidu workspace connection input listing: KeDU-动态百科服务平台, app-bvh8xpidhpfl, app-bvh8xpidhpfl-server, dongtai-baike-整理.',
    }, '2026-05-29T01:48:01.016Z'),
    {
      type: 'result',
      schemaVersion,
      sessionId,
      timestamp: '2026-05-29T01:48:41.754Z',
      success: true,
      message: 'Baidu workspace connection summary: KeDU is the core product, app-bvh8xpidhpfl is the frontend, app-bvh8xpidhpfl-server is the backend, and documentation folders support the dynamic encyclopedia platform.',
    },
    user(sessionId, '2026-05-29T01:48:44.508Z', 'hi`'),
    {
      type: 'error',
      schemaVersion,
      sessionId,
      timestamp: '2026-05-29T01:49:06.296Z',
      code: 'REQUEST_CANCELLED',
      message: 'Execution cancelled by user.',
    },
    user(sessionId, '2026-05-29T01:49:32.088Z', 'just stop it and waite for me other require'),
  ]
}

function user(sessionId: string, timestamp: string, text: string): NexusEvent {
  return { type: 'user_message', schemaVersion, sessionId, timestamp, text }
}

function assistant(sessionId: string, timestamp: string, text: string): NexusEvent {
  return { type: 'assistant_delta', schemaVersion, sessionId, timestamp, text }
}

function toolStarted(
  sessionId: string,
  toolUseId: string,
  name: string,
  input: unknown,
  timestamp: string,
): NexusEvent {
  return { type: 'tool_started', schemaVersion, sessionId, timestamp, toolUseId, name, input }
}

function toolCompleted(
  sessionId: string,
  toolUseId: string,
  name: string,
  success: boolean,
  output: unknown,
  timestamp: string,
): NexusEvent {
  return { type: 'tool_completed', schemaVersion, sessionId, timestamp, toolUseId, name, success, output }
}
