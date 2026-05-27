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
    user(sessionId, '2026-05-24T00:00:04.000Z', '继续，注意正确项目是 /Users/tangyaoyue/DEV/BABEL/BabeL-O'),
  ]

  const selected = selectRecentEvents(events, tinyBudget)
  assert.equal(selected[0]?.type, 'user_message')
  assert.match((selected[0] as Extract<NexusEvent, { type: 'user_message' }>).text, /继续/)

  const assembled = await assembleContext({
    runtimeOptions: {
      sessionId,
      prompt: '继续',
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
  assert.doesNotMatch(JSON.stringify(assembled.messages), /WORKSPACE_PATH_ESCAPE|Read failed/)
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
