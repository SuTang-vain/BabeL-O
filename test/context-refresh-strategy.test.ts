import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ContextRefreshStrategy } from '../src/runtime/ContextRefreshStrategy.js'
import { buildSystemPrompt, mapEventsToMessages } from '../src/runtime/LLMCodingRuntime.js'
import type { NexusStorage } from '../src/storage/Storage.js'
import type { SessionMessage } from '../src/shared/sessionChannel.js'

const inboxMessage: SessionMessage = {
  messageId: 'msg-context-refresh-1',
  channelId: 'channel-context-refresh',
  fromSessionId: 'session-a',
  toSessionId: 'session-b',
  broadcast: false,
  type: 'handoff',
  content: 'Context refresh strategy loaded this inbox note.',
  evidence: [{ type: 'file', ref: 'src/runtime/ContextRefreshStrategy.ts' }],
  priority: 'high',
  createdAt: '2026-06-18T00:00:00.000Z',
  deliveredAt: '2026-06-18T00:00:00.000Z',
  status: 'delivered',
}

function baseRefreshOptions() {
  return {
    runtimeOptions: {
      sessionId: 'session-b',
      prompt: 'Continue',
      cwd: tmpdir(),
    },
    events: [],
    modelId: 'local/coding-runtime',
    buildSystemPrompt,
    mapEventsToMessages,
    tools: () => [],
    warningPercent: 70,
    compactPercent: 90,
    suppressToolsForIntent: () => false,
  }
}

test('ContextRefreshStrategy loads session inbox through storage when requested', async () => {
  let requestedSessionId = ''
  const storage = {
    async listSessionInbox(sessionId: string) {
      requestedSessionId = sessionId
      return [inboxMessage]
    },
  } as unknown as NexusStorage
  const strategy = new ContextRefreshStrategy({ storage })

  const state = await strategy.refresh({
    ...baseRefreshOptions(),
    sessionInbox: 'load',
  })

  assert.equal(requestedSessionId, 'session-b')
  assert.match(state.assembledContext.systemPrompt, /Session inbox messages from other sessions/)
  assert.match(state.assembledContext.systemPrompt, /Context refresh strategy loaded this inbox note/)
  assert.equal(state.assembledContext.systemPromptBlocks?.find(block => block.text.includes('Session inbox messages'))?.cacheable, false)
})

test('ContextRefreshStrategy omits session inbox unless requested', async () => {
  const storage = {
    async listSessionInbox() {
      throw new Error('should not load inbox')
    },
  } as unknown as NexusStorage
  const strategy = new ContextRefreshStrategy({ storage })

  const state = await strategy.refresh(baseRefreshOptions())

  assert.doesNotMatch(state.assembledContext.systemPrompt, /Session inbox messages from other sessions/)
  assert.doesNotMatch(state.assembledContext.systemPrompt, /Context refresh strategy loaded this inbox note/)
})
