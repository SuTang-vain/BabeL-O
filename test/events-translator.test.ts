import assert from 'node:assert/strict'
import { test } from 'node:test'
import { eventBase, type NexusEvent } from '../src/shared/events.js'
import { mapEventsToMessages, type MapEventsToMessagesOptions } from '../src/runtime/eventsTranslator.js'

const SESSION = 'test-session-001'

/**
 * Build a `user_message` event with sane defaults.
 */
function userMessage(text: string, sessionId = SESSION): NexusEvent {
  return { type: 'user_message', ...eventBase(sessionId), text }
}

/**
 * Build an `assistant_delta` event.
 */
function assistantDelta(text: string, sessionId = SESSION): NexusEvent {
  return { type: 'assistant_delta', ...eventBase(sessionId), text }
}

/**
 * Build a `thinking_delta` event.
 */
function thinkingDelta(text: string, sessionId = SESSION): NexusEvent {
  return { type: 'thinking_delta', ...eventBase(sessionId), text }
}

function toolStarted(toolUseId: string, name: string, input: unknown, sessionId = SESSION): NexusEvent {
  return { type: 'tool_started', ...eventBase(sessionId), toolUseId, name, input }
}

function toolCompleted(toolUseId: string, name: string, output: string, success = true, sessionId = SESSION): NexusEvent {
  return { type: 'tool_completed', ...eventBase(sessionId), toolUseId, name, output, success }
}

test('mapEventsToMessages emits a user message with initialPrompt when no user_message event is present', () => {
  const messages = mapEventsToMessages([], 'Hello, world')
  assert.equal(messages.length, 1)
  assert.equal(messages[0]?.role, 'user')
  assert.equal(messages[0]?.content, 'Hello, world')
})

test('mapEventsToMessages uses the first user_message event text instead of initialPrompt', () => {
  const events: NexusEvent[] = [
    userMessage('actual prompt text'),
    assistantDelta('hi back'),
  ]
  const messages = mapEventsToMessages(events, 'FALLBACK_PROMPT')
  assert.equal(messages[0]?.role, 'user')
  assert.equal(messages[0]?.content, 'actual prompt text')
})

test('mapEventsToMessages concatenates assistant_delta events into one assistant message', () => {
  const events: NexusEvent[] = [
    userMessage('q'),
    assistantDelta('hello '),
    assistantDelta('world'),
  ]
  const messages = mapEventsToMessages(events, 'q')
  const assistantMsg = messages.find(m => m.role === 'assistant')
  assert.ok(assistantMsg, 'an assistant message must be emitted')
  assert.equal(assistantMsg.content, 'hello world')
})

test('mapEventsToMessages drops thinking_delta when replayReasoningContent is false (default)', () => {
  const events: NexusEvent[] = [
    userMessage('q'),
    thinkingDelta('I should think about this...'),
    assistantDelta('answer'),
  ]
  const messages = mapEventsToMessages(events, 'q')
  const assistantMsg = messages.find(m => m.role === 'assistant')
  assert.ok(assistantMsg, 'an assistant message must be emitted')
  assert.equal(assistantMsg.reasoningContent, undefined)
  assert.equal(assistantMsg.content, 'answer')
})

test('mapEventsToMessages replays thinking_delta into reasoningContent when option is true', () => {
  const events: NexusEvent[] = [
    userMessage('q'),
    thinkingDelta('reasoning step 1 '),
    thinkingDelta('reasoning step 2'),
    assistantDelta('final answer'),
  ]
  const options: MapEventsToMessagesOptions = { replayReasoningContent: true }
  const messages = mapEventsToMessages(events, 'q', options)
  const assistantMsg = messages.find(m => m.role === 'assistant')
  assert.ok(assistantMsg, 'an assistant message must be emitted')
  assert.equal(assistantMsg.content, 'final answer')
  assert.equal(assistantMsg.reasoningContent, 'reasoning step 1 reasoning step 2')
})

test('mapEventsToMessages emits tool_use block on assistant message for tool_started events', () => {
  const events: NexusEvent[] = [
    userMessage('q'),
    assistantDelta('I will use a tool'),
    toolStarted('tool-1', 'Read', { path: '/tmp/x' }),
  ]
  const messages = mapEventsToMessages(events, 'q')
  const assistantMsg = messages.find(m => m.role === 'assistant' && Array.isArray(m.content))
  assert.ok(assistantMsg, 'an assistant message with array content must be emitted')
  const blocks = assistantMsg.content as Array<{ type: string; name?: string; input?: unknown }>
  const toolUseBlock = blocks.find(b => b.type === 'tool_use')
  assert.ok(toolUseBlock, 'a tool_use block must be present')
  assert.equal(toolUseBlock.name, 'Read')
  assert.deepEqual(toolUseBlock.input, { path: '/tmp/x' })
})

test('mapEventsToMessages emits tool_result block for tool_completed events', () => {
  const events: NexusEvent[] = [
    userMessage('q'),
    assistantDelta('go'),
    toolStarted('tool-1', 'Bash', { command: 'ls' }),
    toolCompleted('tool-1', 'Bash', 'file1\nfile2', true),
  ]
  const messages = mapEventsToMessages(events, 'q')
  // Find user message that contains the tool_result block
  const userToolMsg = messages.find(m =>
    m.role === 'user' &&
    Array.isArray(m.content) &&
    (m.content as Array<{ type: string }>).some(b => b.type === 'tool_result')
  )
  assert.ok(userToolMsg, 'a user message with tool_result block must be emitted')
  const blocks = userToolMsg.content as Array<{ type: string; toolUseId?: string; isError?: boolean; content?: string }>
  const toolResult = blocks.find(b => b.type === 'tool_result')!
  assert.equal(toolResult.toolUseId, 'tool-1')
  assert.equal(toolResult.content, 'file1\nfile2')
  assert.equal(toolResult.isError, false)
})

test('mapEventsToMessages marks synthetic tool_result with isError when tool was started but never completed', () => {
  const events: NexusEvent[] = [
    userMessage('q'),
    assistantDelta('go'),
    // tool-1 was started but never completed (denied / interrupted)
    toolStarted('tool-1', 'Bash', { command: 'rm -rf /' }),
  ]
  const messages = mapEventsToMessages(events, 'q')
  const userToolMsg = messages.find(m =>
    m.role === 'user' &&
    Array.isArray(m.content) &&
    m.content.some(b => b.type === 'tool_result')
  )
  assert.ok(userToolMsg, 'a synthetic tool_result must be emitted')
  const blocks = userToolMsg.content as Array<{ type: string; isError?: boolean; content?: string }>
  const toolResult = blocks.find(b => b.type === 'tool_result')!
  assert.equal(toolResult.isError, true)
  assert.match(toolResult.content!, /denied|interrupted/)
})

test('mapEventsToMessages converts near_timeout_warning into a runtime user message', () => {
  const events: NexusEvent[] = [
    userMessage('q'),
    assistantDelta('exploring...'),
    {
      type: 'near_timeout_warning',
      ...eventBase(SESSION),
      elapsedMs: 25_000,
      timeoutMs: 30_000,
      thresholdRatio: 0.83,
      message: 'soft warning',
      partialSummary: undefined,
    },
  ]
  const messages = mapEventsToMessages(events, 'q')
  const userMsgs = messages.filter(m => m.role === 'user' && typeof m.content === 'string') as Array<{ role: 'user'; content: string }>
  const timeoutMsg = userMsgs.find(m => m.content.includes('Runtime timeout convergence warning'))
  assert.ok(timeoutMsg, 'a timeout warning user message must be emitted')
  assert.match(timeoutMsg.content, /soft warning/)
  assert.match(timeoutMsg.content, /Do not start new exploratory tool calls/)
})

test('mapEventsToMessages dedupes consecutive identical user_message events', () => {
  const events: NexusEvent[] = [
    userMessage('q'),
    userMessage('q'),
    userMessage('q'),
  ]
  const messages = mapEventsToMessages(events, 'q')
  const userMsgs = messages.filter(m => m.role === 'user' && m.content === 'q')
  assert.equal(userMsgs.length, 1, 'duplicate user_message events must collapse to one')
})

test('mapEventsToMessages emits a context grounding user message for context_grounding_required', () => {
  const events: NexusEvent[] = [
    userMessage('q'),
    {
      type: 'context_grounding_required',
      ...eventBase(SESSION),
      source: 'post_compact',
      state: 'summary-derived',
      message: 'cwd has drifted from session root',
      requiredFor: ['file_facts', 'task_completion'],
      suggestedActions: ['inspect_changed_files', 'inspect_git_status'],
    },
  ]
  const messages = mapEventsToMessages(events, 'q')
  const groundingMsg = messages.find(m =>
    m.role === 'user' &&
    typeof m.content === 'string' &&
    (m.content as string).includes('Runtime grounding required')
  ) as { role: 'user'; content: string } | undefined
  assert.ok(groundingMsg, 'a context_grounding_required user message must be emitted')
  assert.match(groundingMsg.content, /cwd has drifted from session root/)
  assert.match(groundingMsg.content, /file_facts, task_completion/)
})

test('mapEventsToMessages preserves the order of tool_started and tool_completed when interleaved', () => {
  const events: NexusEvent[] = [
    userMessage('q'),
    assistantDelta('start'),
    toolStarted('tool-A', 'Read', { path: '/a' }),
    toolCompleted('tool-A', 'Read', 'content-A', true),
    assistantDelta('next'),
    toolStarted('tool-B', 'Read', { path: '/b' }),
    toolCompleted('tool-B', 'Read', 'content-B', true),
  ]
  const messages = mapEventsToMessages(events, 'q')
  // Should contain both tool_use blocks and both tool_result blocks
  const allBlocks = messages.flatMap(m => Array.isArray(m.content) ? m.content : [])
  const toolUses = allBlocks.filter((b: any) => b.type === 'tool_use')
  const toolResults = allBlocks.filter((b: any) => b.type === 'tool_result')
  assert.equal(toolUses.length, 2)
  assert.equal(toolResults.length, 2)
  assert.equal((toolUses[0] as any).id, 'tool-A')
  assert.equal((toolUses[1] as any).id, 'tool-B')
  assert.equal((toolResults[0] as any).toolUseId, 'tool-A')
  assert.equal((toolResults[1] as any).toolUseId, 'tool-B')
})

test('mapEventsToMessages returns empty array of internal events (no events) yields exactly one user message', () => {
  // Edge case: events array is empty (no user_message, no anything).
  const messages = mapEventsToMessages([], 'fallback prompt')
  assert.equal(messages.length, 1)
  assert.equal(messages[0]?.role, 'user')
  assert.equal(messages[0]?.content, 'fallback prompt')
})

test('mapEventsToMessages handles complex object tool output by JSON-stringifying', () => {
  const events: NexusEvent[] = [
    userMessage('q'),
    assistantDelta('go'),
    toolStarted('tool-1', 'Bash', { command: 'json output' }),
    toolCompleted('tool-1', 'Bash', JSON.stringify({ stdout: 'a', stderr: '', code: 0 }), true),
  ]
  const messages = mapEventsToMessages(events, 'q')
  const userToolMsg = messages.find(m =>
    m.role === 'user' &&
    Array.isArray(m.content) &&
    (m.content as Array<{ type: string }>).some(b => b.type === 'tool_result')
  )
  assert.ok(userToolMsg)
  const toolResult = (userToolMsg.content as any[]).find(b => b.type === 'tool_result')!
  assert.match(toolResult.content, /"stdout":"a"/)
  assert.equal(toolResult.isError, false)
})
