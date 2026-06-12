import { test } from 'node:test'
import assert from 'node:assert'
import { formatMultiAgentStatusView, formatSessionHistory, getSessionEvents, renderEvent, renderEventForTest, startAgentStatus, startSession, stopSpinner } from '../src/cli/renderEvents.js'
import { createMockAgentLoopTuiSmokeEvents } from '../src/cli/commands/chat.js'
import type { NexusEvent } from '../src/shared/events.js'
import type { AgentJob } from '../src/shared/agentJob.js'

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
  assert.ok(output.includes('hello world') || output.includes('run command'))
  assert.ok(output.includes('hello world'))
  assert.ok(output.includes('Thinking about listing directory.'))
  // Should render compact tool call without inline expand noise
  assert.ok(output.includes('●'))
  assert.ok(output.includes('ListDir(/test/path)'))
  assert.ok(!output.includes('(ctrl+o to expand)'))
  assert.ok(!output.includes('ctrl+o to expand tool details'))
  assert.ok(!output.includes('done'))
  // Should NOT render outputs in compact mode
  assert.ok(!output.includes('file.txt'))
  assert.ok(!output.includes('Success: true'))
})

test('formatSessionHistory: compact mode renders structured tool failure summary', () => {
  const events: NexusEvent[] = [
    {
      type: 'tool_started',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId: 'sess-structured-failure',
      timestamp: new Date().toISOString(),
      toolUseId: 'tool-listdir-invalid',
      name: 'ListDir',
      input: { path: '/test/path', maxDepth: 3 },
    },
    {
      type: 'tool_completed',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId: 'sess-structured-failure',
      timestamp: new Date().toISOString(),
      toolUseId: 'tool-listdir-invalid',
      name: 'ListDir',
      success: false,
      output: {
        code: 'INVALID_TOOL_INPUT',
        message: 'Invalid input for tool ListDir.\n✖ Invalid input\n  → at maxDepth\nReturn a corrected ListDir tool call with all required fields.',
      },
    },
  ]

  const output = formatSessionHistory(events, 'compact')

  assert.ok(output.includes('ListDir(/test/path)'))
  assert.ok(output.includes('failed'))
  assert.ok(output.includes('INVALID_TOOL_INPUT'))
  assert.ok(output.includes('maxDepth'))
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
  assert.ok(output.includes('hello world') || output.includes('run command'))
  assert.ok(output.includes('run command'))
  assert.ok(output.includes('✓ Bash(echo hello)'))
  assert.ok(output.includes('Input:'))
  assert.ok(output.includes('CommandLine'))
  assert.ok(output.includes('Status: success'))
  assert.ok(output.includes('Output:'))
  assert.ok(output.includes('hello from bash'))
})

test('formatSessionHistory: expanded mode groups permissions and object outputs into tool details', () => {
  const now = new Date().toISOString()
  const events: NexusEvent[] = [
    {
      type: 'tool_started',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId: 'sess-expanded-tool-clean',
      timestamp: now,
      toolUseId: 'tool-bash-expanded',
      name: 'Bash',
      input: { command: 'ls project', timeoutMs: 10000 },
    },
    {
      type: 'permission_request',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId: 'sess-expanded-tool-clean',
      timestamp: now,
      toolUseId: 'tool-bash-expanded',
      name: 'Bash',
      input: { command: 'ls project', timeoutMs: 10000 },
      risk: 'execute',
      message: 'Tool Bash requires user permission to run.',
    },
    {
      type: 'permission_response',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId: 'sess-expanded-tool-clean',
      timestamp: now,
      toolUseId: 'tool-bash-expanded',
      approved: true,
      reason: 'User approved',
    },
    {
      type: 'tool_completed',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId: 'sess-expanded-tool-clean',
      timestamp: now,
      toolUseId: 'tool-bash-expanded',
      name: 'Bash',
      success: true,
      output: { stdout: 'README.md\nsrc\n', stderr: '', exitCode: 0 },
    },
    {
      type: 'usage',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId: 'sess-expanded-tool-clean',
      timestamp: now,
      inputTokens: 0,
      outputTokens: 113,
    },
  ]

  const output = formatSessionHistory(events, 'expanded')
  assert.ok(output.includes('✓ Bash(ls project)'))
  assert.ok(output.includes('Permission: approved (execute risk): User approved'))
  assert.ok(output.includes('"stdout": "README.md\\nsrc\\n"'))
  assert.ok(!output.includes('[object Object]'))
  assert.ok(!output.includes('? Permission requested'))
  assert.ok(!output.includes('Tool Bash requires user permission'))
  assert.ok(!output.includes('usage input='))
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

test('formatSessionHistory: renders recoverable tool denials as blocked', () => {
  const events: NexusEvent[] = [
    {
      type: 'tool_denied',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId: 'sess-recoverable-denial',
      timestamp: new Date().toISOString(),
      name: 'Bash',
      risk: 'execute',
      message: 'Tool denied by Nexus policy: Bash',
      denialKind: 'policy',
      recoverable: true,
    },
  ]

  const outputCompact = formatSessionHistory(events, 'compact')
  assert.ok(outputCompact.includes('blocked recoverable'))
  assert.ok(!outputCompact.includes('✗ failed'))

  const outputExpanded = formatSessionHistory(events, 'expanded')
  assert.ok(outputExpanded.includes('! Bash blocked'))
  assert.ok(outputExpanded.includes('Recoverable: true'))
})

test('formatSessionHistory: renders grounding guard events', () => {
  const now = new Date().toISOString()
  const events: NexusEvent[] = [
    {
      type: 'context_grounding_required',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId: 'sess-grounding-render',
      timestamp: now,
      source: 'post_compact',
      state: 'summary-derived',
      requiredFor: ['file_facts', 'test_results', 'git_status', 'task_completion', 'implementation_status'],
      suggestedActions: ['re_read_referenced_files', 'inspect_changed_files', 'inspect_git_status', 'run_focused_tests', 'inspect_event_log'],
      message: 'Context was compacted; verify current sources before conclusions.',
    },
    {
      type: 'workspace_dirty_detected',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId: 'sess-grounding-render',
      timestamp: now,
      source: 'post_compact',
      changedFileCount: 2,
      changedFiles: ['src/runtime/LLMCodingRuntime.ts', 'test/runtime.test.ts'],
      suggestedActions: ['inspect_changed_files', 'inspect_git_status', 'inspect_diff'],
      message: 'Workspace has 2 changed file(s); inspect git status/diff before relying on compact summaries.',
    },
    {
      type: 'context_grounding_confirmed',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId: 'sess-grounding-render',
      timestamp: now,
      confirmedByToolUseId: 'tool-read-confirm',
      toolName: 'Read',
      confirmationKind: 'file_read',
      confirmedFor: ['file_facts', 'implementation_status'],
      source: 'tool_result',
      message: 'Context grounding confirmed by current file read.',
    },
  ]

  const output = formatSessionHistory(events, 'compact')
  assert.ok(output.includes('context grounding required (post_compact)'))
  assert.ok(output.includes('summary-derived'))
  assert.ok(output.includes('workspace dirty (post_compact): 2 changed file(s)'))
  assert.ok(output.includes('src/runtime/LLMCodingRuntime.ts'))
  assert.ok(output.includes('context grounding confirmed (file_read via Read)'))
  assert.ok(output.includes('file_facts, implementation_status'))
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

test('formatSessionHistory: hides compact boundary details in compact mode', () => {
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
  assert.ok(!output.includes('context compacted: 120 -> 18 events'))
  assert.ok(!output.includes('Old project analysis summarized.'))
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
      output: { stdout: 'ok\n', stderr: '' },
    },
  ]

  const output = formatSessionHistory(events, 'compact')
  assert.ok(output.includes('⏺'))
  assert.ok(output.includes('I will inspect the directory.'))
  assert.ok(output.includes('●'))
  assert.ok(output.includes('Bash'))
  assert.ok(!output.includes('(ctrl+o to expand)'))
  assert.ok(output.includes('⎿  ok'))
  assert.ok(!output.includes('done'))
  assert.ok(!output.includes('running'))
  assert.ok(!output.includes('Running Bash...'))
})

test('formatSessionHistory: compact mode shows folded Bash output preview', () => {
  const events: NexusEvent[] = [
    {
      type: 'tool_started',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId: 'sess-bash-preview',
      timestamp: new Date().toISOString(),
      toolUseId: 'tool-bash-preview',
      name: 'Bash',
      input: { command: 'npm test', timeoutMs: 120000 },
    },
    {
      type: 'tool_completed',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId: 'sess-bash-preview',
      timestamp: new Date().toISOString(),
      toolUseId: 'tool-bash-preview',
      name: 'Bash',
      success: true,
      output: { stdout: 'line 1\nline 2\nline 3\nline 4\nline 5\n', stderr: '', exitCode: 0 },
    },
  ]

  const output = formatSessionHistory(events, 'compact')
  assert.ok(output.includes('Bash(npm test)'))
  assert.ok(output.includes('⎿  line 1'))
  assert.ok(output.includes('⎿  line 2'))
  assert.ok(output.includes('⎿  line 3'))
  assert.ok(!output.includes('line 4'))
  assert.ok(output.includes('… +2 lines (ctrl+o to expand)'))
  assert.ok(output.includes('(timeout 2m)'))
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
  assert.ok(output.includes('Read(/tmp/file.txt)'))
  assert.ok(!output.includes('(ctrl+o to expand)'))
  assert.ok(!output.includes('done'))
  assert.ok(!output.includes('running'))
})

test('formatSessionHistory: compact mode omits inline expand hints', () => {
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
  assert.ok(output.includes('Read(/tmp/a.md)'))
  assert.ok(output.includes('Read(/tmp/b.md)'))
  assert.equal((output.match(/ctrl\+o to expand/g) ?? []).length, 0)
  assert.ok(!output.includes('ctrl+o to expand tool details'))
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
  assert.ok(output.includes('Read(/Users/tangyaoyue/DEV/Baidu/project/README.md)'))
  assert.ok(output.includes('Bash(find /Users/tangyaoyue/DEV/Baidu -name README.md)'))
  assert.ok(!output.includes('path'))
  assert.ok(!output.includes('maxBytes'))
  assert.ok(!output.includes('timeoutMs'))
  assert.ok(!output.includes('running'))
})

test('startAgentStatus renders compacting progress feedback', () => {
  startSession()
  const writes: string[] = []
  const originalWrite = process.stdout.write
  process.stdout.write = ((chunk: any, ...args: any[]) => {
    writes.push(String(chunk))
    return true
  }) as typeof process.stdout.write

  try {
    startAgentStatus('compacting')
  } finally {
    stopSpinner()
    process.stdout.write = originalWrite
  }

  const plainOutput = writes.join('').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
  assert.ok(plainOutput.includes('Compacting conversation...'))
  assert.ok(plainOutput.includes('▰'))
  assert.ok(plainOutput.includes('▱'))
  assert.match(plainOutput, /\d+%/)
})

test('startAgentStatus renders immediate waiting feedback before runtime events', () => {
  startSession()
  const writes: string[] = []
  const originalWrite = process.stdout.write
  process.stdout.write = ((chunk: any, ...args: any[]) => {
    writes.push(String(chunk))
    return true
  }) as typeof process.stdout.write

  try {
    startAgentStatus('working')
  } finally {
    stopSpinner()
    process.stdout.write = originalWrite
  }

  const plainOutput = writes.join('').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
  assert.ok(plainOutput.includes('Working...'))
  assert.ok(plainOutput.includes('[Context: OK]'))
})

test('startAgentStatus renders retrying feedback', () => {
  startSession()
  const writes: string[] = []
  const originalWrite = process.stdout.write
  process.stdout.write = ((chunk: any, ...args: any[]) => {
    writes.push(String(chunk))
    return true
  }) as typeof process.stdout.write

  try {
    startAgentStatus('retrying')
  } finally {
    stopSpinner()
    process.stdout.write = originalWrite
  }

  const plainOutput = writes.join('').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
  assert.ok(plainOutput.includes('Retrying...'))
  assert.ok(plainOutput.includes('[Context: OK]'))
})

test('startAgentStatus renders sub-agent progress with model and context gauge', () => {
  startSession()
  const writes: string[] = []
  const originalWrite = process.stdout.write
  process.stdout.write = ((chunk: any, ...args: any[]) => {
    writes.push(String(chunk))
    return true
  }) as typeof process.stdout.write

  try {
    renderEventForTest({
      type: 'session_started',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId: 'sess-subagent-status',
      timestamp: new Date().toISOString(),
      cwd: '/repo',
      model: 'minimax/MiniMax-M3',
    })
    renderEventForTest({
      type: 'context_warning',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId: 'sess-subagent-status',
      timestamp: new Date().toISOString(),
      modelId: 'minimax/MiniMax-M3',
      tokenEstimate: 161000,
      maxTokens: 200000,
      percentUsed: 81,
      thresholdPercent: 80,
      message: 'Context is approaching the model window.',
    })
    startAgentStatus('running_subagent', 'Deep visual regression child task with long title')
  } finally {
    stopSpinner()
    process.stdout.write = originalWrite
  }

  const plainOutput = writes.join('').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
  assert.ok(plainOutput.includes('context warning: 81%'))
  assert.ok(plainOutput.includes('Running sub-agent Deep visual regression child task with long title...'))
  assert.ok(plainOutput.includes('minimax/MiniMax-M3'))
  assert.ok(plainOutput.includes('81%'))
})

test('startAgentStatus formats elapsed time over one minute as minutes and seconds', () => {
  startSession()
  const writes: string[] = []
  const originalWrite = process.stdout.write
  const originalNow = Date.now
  let now = 1_000_000
  process.stdout.write = ((chunk: any, ...args: any[]) => {
    writes.push(String(chunk))
    return true
  }) as typeof process.stdout.write
  Date.now = () => now

  try {
    startAgentStatus('thinking')
    now += (15 * 60 + 24) * 1000
    startAgentStatus('thinking')
  } finally {
    stopSpinner()
    Date.now = originalNow
    process.stdout.write = originalWrite
  }

  const plainOutput = writes.join('').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
  assert.ok(plainOutput.includes('Thinking... 15m 24s'))
  assert.ok(!plainOutput.includes('Thinking... 924s'))
})

test('renderEvent updates live waiting status across session, permission, and tool phases', () => {
  startSession()
  const writes: string[] = []
  const originalWrite = process.stdout.write
  process.stdout.write = ((chunk: any, ...args: any[]) => {
    writes.push(String(chunk))
    return true
  }) as typeof process.stdout.write

  try {
    startAgentStatus('working')
    renderEventForTest({
      type: 'session_started',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId: 'sess-status-flow',
      timestamp: new Date().toISOString(),
      cwd: '/repo',
      model: 'local/coding-runtime',
    })
    renderEventForTest({
      type: 'tool_started',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId: 'sess-status-flow',
      timestamp: new Date().toISOString(),
      toolUseId: 'tool-status-bash',
      name: 'Bash',
      input: { command: 'node -v' },
    })
    renderEventForTest({
      type: 'permission_request',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId: 'sess-status-flow',
      timestamp: new Date().toISOString(),
      toolUseId: 'tool-status-bash',
      name: 'Bash',
      input: { command: 'node -v' },
      risk: 'execute',
      message: 'Tool Bash requires user permission to run.',
    })
    renderEventForTest({
      type: 'permission_response',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId: 'sess-status-flow',
      timestamp: new Date().toISOString(),
      toolUseId: 'tool-status-bash',
      approved: true,
      reason: 'User approved',
    })
    renderEventForTest({
      type: 'tool_completed',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId: 'sess-status-flow',
      timestamp: new Date().toISOString(),
      toolUseId: 'tool-status-bash',
      name: 'Bash',
      success: true,
      output: { stdout: 'v22.0.0\n', stderr: '', exitCode: 0 },
    })
  } finally {
    stopSpinner()
    process.stdout.write = originalWrite
  }

  const plainOutput = writes.join('').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
  assert.ok(plainOutput.includes('Working...'))
  assert.ok(plainOutput.includes('Generating...'))
  assert.ok(plainOutput.includes('Running Bash...'))
  assert.ok(plainOutput.includes('● Bash(node -v)'))
  assert.ok(plainOutput.includes('⎿  v22.0.0'))
})

test('renderEvent keeps completed tool row before compact thinking spinner', () => {
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
      sessionId: 'sess-thinking-after-tool',
      timestamp: new Date().toISOString(),
      toolUseId: 'tool-bash-thinking',
      name: 'Bash',
      input: { command: 'ls -la /tmp' },
    })
    renderEventForTest({
      type: 'tool_completed',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId: 'sess-thinking-after-tool',
      timestamp: new Date().toISOString(),
      toolUseId: 'tool-bash-thinking',
      name: 'Bash',
      success: true,
      output: { stdout: 'total 248\nfile', stderr: '', exitCode: 0 },
    })
    renderEventForTest({
      type: 'thinking_delta',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId: 'sess-thinking-after-tool',
      timestamp: new Date().toISOString(),
      text: 'Need to summarize.',
    })
  } finally {
    process.stdout.write = originalWrite
  }

  const output = writes.join('')
  const plainOutput = output.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
  assert.ok(plainOutput.includes('● Bash(ls -la /tmp)'))
  assert.ok(plainOutput.includes('⎿  total 248'))
  assert.ok(!plainOutput.includes('(ctrl+o to expand)'))
  assert.ok(!plainOutput.includes('done exitCode=0 total 248\n'))
})

test('formatSessionHistory: skips standalone whitespace assistant deltas before tool rows', () => {
  const events: NexusEvent[] = [
    {
      type: 'session_started',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId: 'sess-whitespace-assistant',
      timestamp: new Date().toISOString(),
      cwd: '/repo',
      model: 'local/coding-runtime',
    },
    {
      type: 'assistant_delta',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId: 'sess-whitespace-assistant',
      timestamp: new Date().toISOString(),
      text: '\n',
    },
    {
      type: 'tool_started',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId: 'sess-whitespace-assistant',
      timestamp: new Date().toISOString(),
      toolUseId: 'tool-read-whitespace',
      name: 'Read',
      input: { path: '/tmp/file.txt' },
    },
    {
      type: 'tool_completed',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId: 'sess-whitespace-assistant',
      timestamp: new Date().toISOString(),
      toolUseId: 'tool-read-whitespace',
      name: 'Read',
      success: false,
      output: 'failed',
    },
  ]

  const output = formatSessionHistory(events, 'compact')
  assert.equal((output.match(/⏺/g) ?? []).length, 0)
  assert.ok(output.includes('Read(/tmp/file.txt) failed'))
})

test('renderEvent skips standalone whitespace assistant deltas before tool rows', () => {
  startSession()
  const writes: string[] = []
  const originalWrite = process.stdout.write
  process.stdout.write = ((chunk: any, ...args: any[]) => {
    writes.push(String(chunk))
    return true
  }) as typeof process.stdout.write

  try {
    renderEventForTest({
      type: 'assistant_delta',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId: 'sess-live-whitespace-assistant',
      timestamp: new Date().toISOString(),
      text: '\n',
    })
    renderEventForTest({
      type: 'tool_started',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId: 'sess-live-whitespace-assistant',
      timestamp: new Date().toISOString(),
      toolUseId: 'tool-live-whitespace-read',
      name: 'Read',
      input: { path: '/tmp/file.txt' },
    })
  } finally {
    process.stdout.write = originalWrite
  }

  const output = writes.join('')
  assert.equal((output.match(/⏺/g) ?? []).length, 0)
  assert.ok(output.includes('● Read(/tmp/file.txt)'))
})

test('renderEvent does not insert blank line between newline-terminated assistant text and tool rows', () => {
  startSession()
  const writes: string[] = []
  const originalWrite = process.stdout.write
  process.stdout.write = ((chunk: any, ...args: any[]) => {
    writes.push(String(chunk))
    return true
  }) as typeof process.stdout.write

  try {
    renderEventForTest({
      type: 'assistant_delta',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId: 'sess-live-spacing',
      timestamp: new Date().toISOString(),
      text: '继续读取文件：\n',
    })
    renderEventForTest({
      type: 'tool_started',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId: 'sess-live-spacing',
      timestamp: new Date().toISOString(),
      toolUseId: 'tool-spacing-read',
      name: 'Read',
      input: { path: '/tmp/file.txt' },
    })
  } finally {
    process.stdout.write = originalWrite
  }

  const output = writes.join('')
  assert.ok(output.includes('继续读取文件：\n● Read(/tmp/file.txt)'))
  assert.ok(!output.includes('继续读取文件：\n\n● Read(/tmp/file.txt)'))
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
    stopSpinner()
    process.stdout.write = originalWrite
  }

  const output = writes.join('')
  assert.ok(output.includes('● Read(/tmp/file.txt)'))
  assert.ok(output.includes('\r\x1b[K'))
  assert.ok(!output.includes('(ctrl+o to expand)'))
  assert.ok(output.includes('Running Read...'))
  assert.ok(output.includes('Generating...'))
  const historyOutput = formatSessionHistory(getSessionEvents(), 'compact')
  assert.equal(historyOutput.includes('Running Read...'), false)
  assert.equal(historyOutput.includes('Generating...'), false)
  assert.ok(!output.includes('\x1b[2A\x1b[J'))
  assert.ok(!output.includes('maxBytes'))
  assert.ok(!output.includes('running'))
})

test('renderEvent clears initial waiting overlay before first tool row', () => {
  startSession()
  const writes: string[] = []
  const originalWrite = process.stdout.write
  process.stdout.write = ((chunk: any, ...args: any[]) => {
    writes.push(String(chunk))
    return true
  }) as typeof process.stdout.write

  try {
    startAgentStatus('working')
    renderEventForTest({
      type: 'tool_started',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId: 'sess-live-tool-status',
      timestamp: new Date().toISOString(),
      toolUseId: 'tool-read-status',
      name: 'Read',
      input: { path: '/tmp/file.txt', maxBytes: 2000 },
    })
  } finally {
    stopSpinner()
    process.stdout.write = originalWrite
  }

  const output = writes.join('')
  const plainOutput = output.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
  assert.ok(plainOutput.includes('Working...'))
  assert.ok(plainOutput.includes('● Read(/tmp/file.txt)'))
  assert.ok(output.includes('\r\x1b[K'))
  assert.ok(!plainOutput.includes('done'))
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

test('formatSessionHistory renders worktree flow panel and recovery hints', () => {
  const now = new Date().toISOString()
  const events: NexusEvent[] = [
    {
      type: 'task_session_event',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId: 'sess-worktree-flow',
      eventId: 'event-worktree-created',
      eventType: 'worktree_created',
      phase: 'executing',
      timestamp: now,
      payload: { taskId: 'task-1', worktreePath: '/repo/.babel-o/worktrees/task-1' },
    },
    {
      type: 'task_session_event',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId: 'sess-worktree-flow',
      eventId: 'event-worktree-conflict',
      eventType: 'worktree_merge_conflict',
      phase: 'waiting_user',
      timestamp: now,
      payload: {
        taskId: 'task-1',
        task: {
          taskId: 'task-1',
          sessionId: 'sess-worktree-flow',
          title: 'Implement isolated fix',
          status: 'failed',
          dependsOn: [],
          blocks: [],
          retryCount: 0,
          metadata: {
            worktreeRecovery: {
              type: 'worktree_merge_conflict',
              status: 'awaiting_manual_recovery',
              taskId: 'task-1',
              worktreePath: '/repo/.babel-o/worktrees/task-1',
              preservedWorktreePath: '/repo/.babel-o/worktrees/task-1',
              conflictingFiles: ['src/conflict.ts'],
              recoveryActions: [{ action: 'keep' }, { action: 'continue' }, { action: 'abandon' }],
            },
          },
          review: { status: 'rejected', reason: 'conflict', reviewerAgentId: 'system' },
          createdAt: now,
          updatedAt: now,
        },
        recovery: {
          type: 'worktree_merge_conflict',
          status: 'awaiting_manual_recovery',
          taskId: 'task-1',
          taskTitle: 'Implement isolated fix',
          worktreePath: '/repo/.babel-o/worktrees/task-1',
          preservedWorktreePath: '/repo/.babel-o/worktrees/task-1',
          conflictingFiles: ['src/conflict.ts'],
          recoveryActions: [{ action: 'keep' }, { action: 'continue' }, { action: 'abandon' }],
        },
      },
    },
    {
      type: 'task_session_event',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId: 'sess-worktree-flow',
      eventId: 'event-worktree-recovery',
      eventType: 'worktree_recovery_action',
      phase: 'executing',
      timestamp: now,
      payload: {
        taskId: 'task-1',
        next: {
          taskId: 'task-1',
          title: 'Implement isolated fix',
          status: 'pending',
          metadata: {
            worktreeRecovery: {
              status: 'retry_requested',
              selectedAction: 'continue',
              preservedWorktreePath: '/repo/.babel-o/worktrees/task-1',
              conflictingFiles: ['src/conflict.ts'],
            },
          },
        },
      },
    },
  ]

  const output = formatSessionHistory(events, 'compact')
  assert.ok(output.includes('worktree executing isolated #task-1'))
  assert.ok(output.includes('worktree waiting_user merge conflict #task-1'))
  assert.ok(output.includes('worktree executing recovery continue #task-1'))
  assert.ok(output.includes('Worktree Flow'))
  assert.ok(output.includes('↻ recovery'))
  assert.ok(output.includes('Implement isolated fix'))
  assert.ok(output.includes('recovery=retry_requested'))
  assert.ok(output.includes('selected=continue'))
  assert.ok(output.includes('conflicts=src/conflict.ts'))
  assert.ok(output.includes('bbl sessions worktree-recovery <sessionId> <taskId> continue|abandon|keep'))
  assert.ok(output.includes('Task Status Board'))
  assert.ok(output.includes('worktree'))
})

test('formatSessionHistory renders successful worktree merge flow', () => {
  const now = new Date().toISOString()
  const events: NexusEvent[] = [
    {
      type: 'task_session_event',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId: 'sess-worktree-merged',
      eventId: 'event-worktree-created',
      eventType: 'worktree_created',
      phase: 'executing',
      timestamp: now,
      payload: { taskId: 'task-2', worktreePath: '/repo/.babel-o/worktrees/task-2' },
    },
    {
      type: 'task_session_event',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId: 'sess-worktree-merged',
      eventId: 'event-worktree-merged',
      eventType: 'worktree_merged',
      phase: 'executing',
      timestamp: now,
      payload: { taskId: 'task-2' },
    },
  ]

  const output = formatSessionHistory(events, 'compact')
  assert.ok(output.includes('worktree executing isolated #task-2'))
  assert.ok(output.includes('worktree executing merged #task-2'))
  assert.ok(output.includes('Worktree Flow'))
  assert.ok(output.includes('✓ merged'))
  assert.ok(output.includes('task #task-2'))
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

test('formatSessionHistory renders AgentLoop sub-agent smoke hierarchy and transcript references', () => {
  const events = createMockAgentLoopTuiSmokeEvents('sess-agentloop-smoke', '/repo')
  const output = formatSessionHistory(events, 'compact')

  assert.ok(output.includes('mock/agentloop-tui-smoke'))
  assert.ok(output.includes('task blocked'))
  assert.ok(output.includes('subtasks delegated'))
  assert.ok(output.includes('subagent started'))
  assert.ok(output.includes('subagent completed'))
  assert.ok(output.includes('Ⅱ 等待子任务'))
  assert.ok(output.includes('Parent blocked by delegated sub-agent'))
  assert.ok(output.includes('Child implementation via sub-agent'))
  assert.ok(output.includes('depth=1'))
  assert.ok(output.includes('parentTaskId=1'))
  assert.ok(output.includes('parent #1'))
  assert.ok(output.includes('transcript=nexus://sessions/sess-agentloop-smoke-sub-2/events'))
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

test('formatMultiAgentStatusView renders AgentJob and AgentLoop sub-agent rows', () => {
  const now = new Date().toISOString()
  const jobs: AgentJob[] = [
    {
      jobId: 'job-review-1',
      parentSessionId: 'session_parent_1',
      childSessionId: 'session_child_review_1',
      agentType: 'review',
      status: 'running',
      prompt: 'Review scheduler diagnostics',
      contextForkMode: 'task-focused',
      isolation: 'none',
      createdAt: now,
      updatedAt: now,
      governance: {
        maxConcurrentAgents: 3,
        activeAgents: 1,
        maxDepth: 2,
        depth: 1,
        maxRuntimeMs: 180000,
      },
    },
    {
      jobId: 'job-test-1',
      parentSessionId: 'session_parent_1',
      childSessionId: 'session_child_test_1',
      agentType: 'test',
      status: 'failed',
      prompt: 'Run focused renderer tests',
      contextForkMode: 'task-focused',
      isolation: 'none',
      createdAt: now,
      updatedAt: now,
      error: { code: 'AGENT_JOB_TIMEOUT', message: 'Timed out.' },
    },
  ]
  const events: NexusEvent[] = [
    {
      type: 'task_session_event',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId: 'session_parent_1',
      eventId: 'event-sub-started',
      eventType: 'subagent_started',
      phase: 'executing',
      timestamp: now,
      payload: {
        agentId: 'subagent-1',
        taskId: 'task-2',
        parentTaskId: 'task-1',
        title: 'Child implementation via AgentLoop',
        subSessionId: 'session_subagent_1',
        transcriptPath: 'nexus://sessions/session_subagent_1/events',
        depth: 1,
      },
    },
  ]

  const output = formatMultiAgentStatusView({ sessionId: 'session_parent_1', jobs, events, columns: 120 })

  assert.ok(output.includes('Multi-Agent Status'))
  assert.ok(output.includes('running 2'))
  assert.ok(output.includes('failed 1'))
  assert.ok(output.includes('job review'))
  assert.ok(output.includes('job test'))
  assert.ok(output.includes('loop subagent'))
  assert.ok(output.includes('Review scheduler diagnostics'))
  assert.ok(output.includes('Run focused renderer tests'))
  assert.ok(output.includes('Child implementation via AgentLoop'))
  assert.ok(output.includes('child=session_chil...iew_1'))
  assert.ok(output.includes('active 1/3'))
  assert.ok(output.includes('AGENT_JOB_TIMEOUT'))
  assert.ok(output.includes('transcript=nexus://sessions/session_subagent_1/events'))
})

test('formatMultiAgentStatusView renders empty session state', () => {
  const output = formatMultiAgentStatusView({ sessionId: 'session_empty', jobs: [], events: [], columns: 100 })

  assert.ok(output.includes('Multi-Agent Status'))
  assert.ok(output.includes('No agent jobs or AgentLoop sub-agents found for this session.'))
})
