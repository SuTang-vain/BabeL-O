import { test } from 'node:test'
import assert from 'node:assert'
import { formatSessionHistory, renderEvent, renderEventForTest, startSession } from '../src/cli/renderEvents.js'
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
  assert.ok(output.includes('BabeL-O'))
  assert.ok(output.includes('hello world'))
  assert.ok(output.includes('Thinking about listing directory.'))
  // Should render compact bullet point
  assert.ok(output.includes('✓'))
  assert.ok(output.includes('ListDir'))
  assert.ok(output.includes('done'))
  assert.ok(output.includes('ctrl+o to expand tool details'))
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
  assert.ok(output.includes('BabeL-O'))
  assert.ok(output.includes('run command'))
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

test('formatSessionHistory: renders provider fallback policy details', () => {
  const events: NexusEvent[] = [
    {
      type: 'error',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId: 'sess-provider-policy',
      timestamp: new Date().toISOString(),
      code: 'PROVIDER_ERROR',
      message: 'Provider failed.',
      details: {
        kind: 'context_window',
        recoveryReason: 'ESCALATED_CONTEXT_WINDOW',
        retryable: true,
        suggestion: 'Run /compact.',
        fallbackPolicy: {
          mode: 'compact_then_retry',
          reason: 'Context too large.',
          nextAction: 'Run /compact before switching models.',
          allowSilentModelSwitch: false,
        },
      },
    },
  ]

  const output = formatSessionHistory(events, 'compact')
  assert.ok(output.includes('recovery=ESCALATED_CONTEXT_WINDOW'))
  assert.ok(output.includes('fallback=compact_then_retry'))
  assert.ok(output.includes('silentSwitch=false'))
})

test('formatSessionHistory: renders compact boundaries and context warnings', () => {
  const events: NexusEvent[] = [
    {
      type: 'compact_boundary',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId: 'sess-compact',
      timestamp: new Date().toISOString(),
      trigger: 'manual',
      summary: 'Old project analysis summarized.',
      beforeEventCount: 120,
      afterEventCount: 18,
      summaryChars: 32,
      snippedToolResults: 3,
      modelId: 'local/coding-runtime',
      budget: { maxTokens: 8192 },
    },
    {
      type: 'context_warning',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId: 'sess-compact',
      timestamp: new Date().toISOString(),
      modelId: 'local/coding-runtime',
      tokenEstimate: 7000,
      maxTokens: 8192,
      percentUsed: 85,
      thresholdPercent: 85,
      message: 'Context is approaching the model window.',
    },
  ]

  const output = formatSessionHistory(events, 'compact')
  assert.ok(output.includes('context compacted: 120 -> 18 events'))
  assert.ok(output.includes('Old project analysis summarized.'))
  assert.ok(output.includes('context warning: 85%'))
  assert.ok(output.includes('/compact'))
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

test('formatSessionHistory: renders agent failure diagnostics', () => {
  const events: NexusEvent[] = [
    {
      type: 'task_session_event',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId: 'sess-agent',
      eventId: 'event-diagnostics',
      eventType: 'executor_failed_error',
      phase: 'executing',
      timestamp: new Date().toISOString(),
      payload: {
        taskId: 'task-1',
        error: 'Failed to parse optimizer structured output',
        diagnostics: {
          resultMessage: 'not json',
          lastToolName: 'Bash',
          lastToolOutputPreview: 'stderr: command failed with code 2',
          structuredOutput: {
            failureType: 'schema_mismatch',
            missingRequiredKeys: ['taskId', 'result'],
            candidateSources: ['assistantText'],
          },
        },
      },
    },
  ]

  const output = formatSessionHistory(events, 'compact')
  assert.ok(output.includes('executor failed error'))
  assert.ok(output.includes('Failed to parse optimizer structured output'))
  assert.ok(output.includes('structured=schema_mismatch'))
  assert.ok(output.includes('missing=taskId,result'))
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
  assert.ok(output.includes('done'))
  assert.ok(!output.includes('running'))
  assert.ok(!output.includes('Running Bash...'))
})

test('formatSessionHistory: completed tools replace running state on redraw', () => {
  const events: NexusEvent[] = [
    {
      type: 'tool_started',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId: 'sess-tool-redraw',
      timestamp: new Date().toISOString(),
      toolUseId: 'tool-read',
      name: 'Read',
      input: { file_path: '/tmp/file.txt' },
    },
    {
      type: 'tool_completed',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId: 'sess-tool-redraw',
      timestamp: new Date().toISOString(),
      toolUseId: 'tool-read',
      name: 'Read',
      success: true,
      output: 'content',
    },
  ]

  const output = formatSessionHistory(events, 'compact')
  assert.ok(output.includes('Read /tmp/file.txt'))
  assert.ok(output.includes('done'))
  assert.ok(!output.includes('running'))
})

test('formatSessionHistory: compact mode shows expand hint only once', () => {
  const now = new Date().toISOString()
  const events: NexusEvent[] = [
    {
      type: 'tool_started',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId: 'sess-expand-hint',
      timestamp: now,
      toolUseId: 'tool-read-a',
      name: 'Read',
      input: { path: '/tmp/a.md' },
    },
    {
      type: 'tool_completed',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId: 'sess-expand-hint',
      timestamp: now,
      toolUseId: 'tool-read-a',
      name: 'Read',
      success: true,
      output: 'a',
    },
    {
      type: 'tool_started',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId: 'sess-expand-hint',
      timestamp: now,
      toolUseId: 'tool-read-b',
      name: 'Read',
      input: { path: '/tmp/b.md' },
    },
    {
      type: 'tool_completed',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId: 'sess-expand-hint',
      timestamp: now,
      toolUseId: 'tool-read-b',
      name: 'Read',
      success: true,
      output: 'b',
    },
  ]

  const output = formatSessionHistory(events, 'compact')
  assert.ok(output.includes('Read /tmp/a.md done'))
  assert.ok(output.includes('Read /tmp/b.md done'))
  assert.equal((output.match(/ctrl\+o to expand/g) ?? []).length, 1)
  assert.ok(!output.includes('(ctrl+o to expand)'))
})

test('formatSessionHistory: compact tool rows hide raw tool parameter names', () => {
  const events: NexusEvent[] = [
    {
      type: 'tool_started',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId: 'sess-tool-simple',
      timestamp: new Date().toISOString(),
      toolUseId: 'tool-read-simple',
      name: 'Read',
      input: { path: '/Users/tangyaoyue/DEV/Baidu/project/README.md', maxBytes: 2000 },
    },
    {
      type: 'tool_started',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId: 'sess-tool-simple',
      timestamp: new Date().toISOString(),
      toolUseId: 'tool-bash-simple',
      name: 'Bash',
      input: { command: 'find /Users/tangyaoyue/DEV/Baidu -name README.md', timeoutMs: 10000 },
    },
  ]

  const output = formatSessionHistory(events, 'compact')
  assert.ok(output.includes('Read /Users/tangyaoyue/DEV/Baidu/project/README.md'))
  assert.ok(output.includes('Bash find /Users/tangyaoyue/DEV/Baidu -name README.md'))
  assert.ok(!output.includes('path'))
  assert.ok(!output.includes('maxBytes'))
  assert.ok(!output.includes('timeoutMs'))
  assert.ok(!output.includes('running'))
})

test('renderEvent updates live tool completion on the same terminal row', () => {
  startSession()
  const writes: string[] = []
  const originalWrite = process.stdout.write
  process.stdout.write = ((chunk: any, ...args: any[]) => {
    writes.push(String(chunk))
    return true
  }) as typeof process.stdout.write

  try {
    renderEventForTest({
      type: 'tool_started',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId: 'sess-live-tool-row',
      timestamp: new Date().toISOString(),
      toolUseId: 'tool-read-live',
      name: 'Read',
      input: { path: '/tmp/file.txt', maxBytes: 2000 },
    })
    renderEventForTest({
      type: 'tool_completed',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId: 'sess-live-tool-row',
      timestamp: new Date().toISOString(),
      toolUseId: 'tool-read-live',
      name: 'Read',
      success: true,
      output: 'content',
    })
  } finally {
    process.stdout.write = originalWrite
  }

  const output = writes.join('')
  assert.ok(output.includes('● Read /tmp/file.txt'))
  assert.ok(output.includes('\r\x1b[K'))
  assert.ok(output.includes('● ✓ Read /tmp/file.txt done'))
  assert.equal((output.match(/\n/g) ?? []).length, 0)
  assert.ok(!output.includes('maxBytes'))
  assert.ok(!output.includes('running'))
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

test('formatTaskStatusPanel renders task status board correctly', () => {
  const events: NexusEvent[] = [
    {
      type: 'task_created',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId: 'sess-task-board',
      timestamp: new Date().toISOString(),
      taskId: 'task-1',
      title: 'Setup repository',
    },
    {
      type: 'task_session_event',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId: 'sess-task-board',
      eventId: 'event-1',
      eventType: 'task_claimed',
      phase: 'executing',
      timestamp: new Date().toISOString(),
      payload: { taskId: 'task-1', title: 'Setup repository' },
    },
    {
      type: 'task_created',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId: 'sess-task-board',
      timestamp: new Date().toISOString(),
      taskId: 'task-2',
      title: 'Run migrations',
    },
  ]

  const output = formatSessionHistory(events, 'compact')
  assert.ok(output.includes('Task Status Board'))
  assert.ok(output.includes('▶ 执行中'))
  assert.ok(output.includes('Setup repository'))
  assert.ok(output.includes('⟳ 规划中'))
  assert.ok(output.includes('Run migrations'))
})

test('formatTaskStatusPanel renders delegated subtask hierarchy', () => {
  const now = new Date().toISOString()
  const events: NexusEvent[] = [
    {
      type: 'task_session_event',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId: 'sess-subtasks',
      eventId: 'event-parent-blocked',
      eventType: 'task_blocked',
      phase: 'executing',
      timestamp: now,
      payload: {
        task: {
          taskId: '1',
          sessionId: 'sess-subtasks',
          title: 'Parent feature',
          status: 'blocked',
          dependsOn: ['2'],
          blocks: [],
          retryCount: 0,
          metadata: { delegatedSubTaskIds: ['2'] },
          createdAt: now,
          updatedAt: now,
        },
      },
    },
    {
      type: 'task_session_event',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId: 'sess-subtasks',
      eventId: 'event-delegated',
      eventType: 'subtasks_delegated',
      phase: 'executing',
      timestamp: now,
      payload: {
        parentTask: {
          taskId: '1',
          sessionId: 'sess-subtasks',
          title: 'Parent feature',
          status: 'blocked',
          dependsOn: ['2'],
          blocks: [],
          retryCount: 0,
          metadata: { delegatedSubTaskIds: ['2'] },
          createdAt: now,
          updatedAt: now,
        },
        subTasks: [
          {
            taskId: '2',
            sessionId: 'sess-subtasks',
            title: 'Child implementation',
            status: 'pending',
            dependsOn: [],
            blocks: ['1'],
            retryCount: 0,
            metadata: { parentTaskId: '1', depth: 1 },
            createdAt: now,
            updatedAt: now,
          },
        ],
      },
    },
  ]

  const output = formatSessionHistory(events, 'compact')
  assert.ok(output.includes('Ⅱ 等待子任务'))
  assert.ok(output.includes('Parent feature'))
  assert.ok(output.includes('delegated #2'))
  assert.ok(output.includes('Child implementation'))
  assert.ok(output.includes('parent #1'))
})

test('formatSessionHistory: consecutive assistant_delta events produce exactly one ⏺ prefix', () => {
  // Simulates a streamed response stored as multiple assistant_delta records in the database.
  // On redraw, they must be merged into a single cohesive paragraph with one ⏺ prefix symbol.
  const events: NexusEvent[] = [
    {
      type: 'assistant_delta',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId: 'sess-merge',
      timestamp: new Date().toISOString(),
      text: '你好！我是 BabeL-O，',
    },
    {
      type: 'assistant_delta',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId: 'sess-merge',
      timestamp: new Date().toISOString(),
      text: '一个 AI 编程助手。',
    },
    {
      type: 'assistant_delta',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId: 'sess-merge',
      timestamp: new Date().toISOString(),
      text: '我可以帮你完成各种软件开发任务。',
    },
  ]

  const output = formatSessionHistory(events, 'compact')

  // The full merged text must be present
  assert.ok(output.includes('你好！我是 BabeL-O，'), 'merged text missing')
  assert.ok(output.includes('一个 AI 编程助手。'), 'merged text missing')
  assert.ok(output.includes('我可以帮你完成各种软件开发任务。'), 'merged text missing')

  // Crucially: only ONE ⏺ symbol should appear, not three
  const bulletCount = (output.match(/⏺/g) ?? []).length
  assert.strictEqual(bulletCount, 1, `Expected exactly 1 ⏺, got ${bulletCount}`)
})

test('formatSessionHistory: usage event between assistant_delta events does not break merging', () => {
  // A "usage" metadata event stored between streaming chunks must be ignored (it is in ignorableTypes)
  // and must NOT break the merge of consecutive assistant text.
  const events: NexusEvent[] = [
    {
      type: 'assistant_delta',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId: 'sess-usage-merge',
      timestamp: new Date().toISOString(),
      text: '首先分析代码结构，',
    },
    {
      type: 'usage',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId: 'sess-usage-merge',
      timestamp: new Date().toISOString(),
      inputTokens: 120,
      outputTokens: 15,
    },
    {
      type: 'assistant_delta',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId: 'sess-usage-merge',
      timestamp: new Date().toISOString(),
      text: '然后优化性能瓶颈。',
    },
  ]

  const output = formatSessionHistory(events, 'compact')

  assert.ok(output.includes('首先分析代码结构，'), 'first chunk missing')
  assert.ok(output.includes('然后优化性能瓶颈。'), 'second chunk missing')

  // Still only one ⏺ even though there was a usage event in between
  const bulletCount = (output.match(/⏺/g) ?? []).length
  assert.strictEqual(bulletCount, 1, `Expected exactly 1 ⏺ after usage-event gap, got ${bulletCount}`)
})
