import { test } from 'node:test'
import assert from 'node:assert'
import { formatSessionHistory, renderEvent, startSession } from '../src/cli/renderEvents.js'
import type { NexusEvent } from '../src/shared/events.js'

test('formatSessionHistory: compact mode renders correct summaries', () => {
  const events: NexusEvent[] = [
    {
      type: 'user_message',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId: 'sess-1',
      timestamp: new Date().toISOString(),
      text: 'hello world',
    },
    {
      type: 'assistant_delta',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId: 'sess-1',
      timestamp: new Date().toISOString(),
      text: 'Thinking about listing directory.',
    },
    {
      type: 'tool_started',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId: 'sess-1',
      timestamp: new Date().toISOString(),
      toolUseId: 'tool-1',
      name: 'ListDir',
      input: { DirectoryPath: '/test/path' },
    },
    {
      type: 'tool_completed',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId: 'sess-1',
      timestamp: new Date().toISOString(),
      toolUseId: 'tool-1',
      name: 'ListDir',
      success: true,
      output: [{ name: 'file.txt', isDir: false }],
    },
  ]

  const output = formatSessionHistory(events, 'compact')
  assert.ok(output.includes('> hello world'))
  assert.ok(output.includes('Thinking about listing directory.'))
  // Should render compact bullet point
  assert.ok(output.includes('✓'))
  assert.ok(output.includes('ListDir'))
  assert.ok(output.includes('done'))
  assert.ok(output.includes('ctrl+o to expand'))
  // Should NOT render outputs in compact mode
  assert.ok(!output.includes('file.txt'))
  assert.ok(!output.includes('Success: true'))
})

test('formatSessionHistory: expanded mode renders complete details', () => {
  const events: NexusEvent[] = [
    {
      type: 'user_message',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId: 'sess-1',
      timestamp: new Date().toISOString(),
      text: 'run command',
    },
    {
      type: 'tool_started',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId: 'sess-1',
      timestamp: new Date().toISOString(),
      toolUseId: 'tool-2',
      name: 'Bash',
      input: { CommandLine: 'echo hello' },
    },
    {
      type: 'tool_completed',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId: 'sess-1',
      timestamp: new Date().toISOString(),
      toolUseId: 'tool-2',
      name: 'Bash',
      success: true,
      output: 'hello from bash',
    },
  ]

  const output = formatSessionHistory(events, 'expanded')
  assert.ok(output.includes('> run command'))
  assert.ok(output.includes('✓ Bash'))
  assert.ok(output.includes('Input:'))
  assert.ok(output.includes('CommandLine'))
  assert.ok(output.includes('Success: true'))
  assert.ok(output.includes('Output:'))
  assert.ok(output.includes('hello from bash'))
})

test('formatSessionHistory: handles tool denials and errors', () => {
  const events: NexusEvent[] = [
    {
      type: 'tool_denied',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId: 'sess-1',
      timestamp: new Date().toISOString(),
      name: 'Bash',
      risk: 'execute',
      message: 'Blocked by optimizer safety check',
    },
    {
      type: 'error',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId: 'sess-1',
      timestamp: new Date().toISOString(),
      code: 'UNEXPECTED_ERROR',
      message: 'Something went wrong',
    },
  ]

  const outputCompact = formatSessionHistory(events, 'compact')
  assert.ok(outputCompact.includes('denied (execute risk)'))
  assert.ok(outputCompact.includes('UNEXPECTED_ERROR'))

  const outputExpanded = formatSessionHistory(events, 'expanded')
  assert.ok(outputExpanded.includes('! Bash denied'))
  assert.ok(outputExpanded.includes('Risk: execute'))
  assert.ok(outputExpanded.includes('Blocked by optimizer safety check'))
  assert.ok(outputExpanded.includes('UNEXPECTED_ERROR: Something went wrong'))
})

test('startSession can initialize execution state without replaying readline input', () => {
  startSession()
  assert.equal(formatSessionHistory([], 'compact'), '')
})

test('renderEvent ignores live user_message events to avoid duplicating readline echo', () => {
  startSession()
  renderEvent({
    type: 'user_message',
    schemaVersion: '2026-05-21.babel-o.v1',
    sessionId: 'sess-live',
    timestamp: new Date().toISOString(),
    text: '你好',
  })
  assert.equal(formatSessionHistory([], 'compact'), '')
})

test('formatSessionHistory: renders agent status and task session events', () => {
  const events: NexusEvent[] = [
    {
      type: 'session_started',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId: 'sess-agent',
      timestamp: new Date().toISOString(),
      cwd: '/repo',
      model: 'local/coding-runtime',
    },
    {
      type: 'task_session_event',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId: 'sess-agent',
      eventId: 'event-1',
      eventType: 'planner_completed',
      phase: 'planning',
      timestamp: new Date().toISOString(),
      payload: { taskId: 'task-1' },
    },
  ]

  const output = formatSessionHistory(events, 'compact')
  assert.ok(output.includes('agent sess-agent'))
  assert.ok(output.includes('model local/coding-runtime'))
  assert.ok(output.includes('agent planning planner completed'))
  assert.ok(output.includes('task-1'))
})

test('formatSessionHistory: separates assistant text and bash tool layers', () => {
  const events: NexusEvent[] = [
    {
      type: 'assistant_delta',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId: 'sess-layer',
      timestamp: new Date().toISOString(),
      text: 'I will inspect the directory.',
    },
    {
      type: 'tool_started',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId: 'sess-layer',
      timestamp: new Date().toISOString(),
      toolUseId: 'tool-bash',
      name: 'Bash',
      input: { command: 'ls /tmp' },
    },
    {
      type: 'tool_completed',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId: 'sess-layer',
      timestamp: new Date().toISOString(),
      toolUseId: 'tool-bash',
      name: 'Bash',
      success: true,
      output: 'ok',
    },
  ]

  const output = formatSessionHistory(events, 'compact')
  assert.ok(output.includes('⏺'))
  assert.ok(output.includes('I will inspect the directory.'))
  assert.ok(output.includes('●'))
  assert.ok(output.includes('Bash'))
  assert.ok(output.includes('running') || output.includes('done'))
  assert.ok(!output.includes('Running Bash...'))
})

test('formatSessionHistory: renders expanded thinking as a separate thought block', () => {
  const events: NexusEvent[] = [
    {
      type: 'thinking_delta',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId: 'sess-thinking',
      timestamp: new Date().toISOString(),
      text: 'Need to inspect files first.',
    },
  ]

  const output = formatSessionHistory(events, 'expanded')
  assert.ok(output.includes('▸'))
  assert.ok(output.includes('Thought'))
  assert.ok(output.includes('Need to inspect files first.'))
})
