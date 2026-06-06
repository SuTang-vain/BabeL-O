import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatAgentLoopSmokeResult, parseOptimizeInPlaceOptions, parseOptimizeSubAgentOptions, parseOptimizeProviderSmokeLiveOptions } from '../src/cli/commands/optimize.js'

test('parseOptimizeSubAgentOptions keeps sub-agents disabled by default', () => {
  const parsed = parseOptimizeSubAgentOptions({
    target: 'src',
    focus: 'performance',
    cwd: '/repo',
    maxSubAgentDepth: '1',
    maxSubTasksPerTask: '5',
  })

  assert.deepEqual(parsed, {
    enableSubAgents: false,
    maxSubAgentDepth: 1,
    maxSubTasksPerTask: 5,
  })
})

test('parseOptimizeSubAgentOptions enables sub-agents with explicit limits', () => {
  const parsed = parseOptimizeSubAgentOptions({
    target: 'src',
    focus: 'cleanup',
    cwd: '/repo',
    enableSubAgents: true,
    maxSubAgentDepth: '3',
    maxSubTasksPerTask: 2,
  })

  assert.deepEqual(parsed, {
    enableSubAgents: true,
    maxSubAgentDepth: 3,
    maxSubTasksPerTask: 2,
  })
})

test('parseOptimizeSubAgentOptions accepts commander camelcase for --enable-subagents', () => {
  const parsed = parseOptimizeSubAgentOptions({
    target: 'src',
    focus: 'cleanup',
    cwd: '/repo',
    enableSubagents: true,
    maxSubAgentDepth: '1',
    maxSubTasksPerTask: '2',
  })

  assert.equal(parsed.enableSubAgents, true)
})

test('parseOptimizeProviderSmokeLiveOptions parses explicit timeout and model', () => {
  const parsed = parseOptimizeProviderSmokeLiveOptions({
    focus: 'performance',
    cwd: '/repo',
    timeoutMs: '45000',
    model: 'anthropic/claude-3-5-sonnet',
  })

  assert.deepEqual(parsed, {
    timeoutMs: 45000,
    model: 'anthropic/claude-3-5-sonnet',
  })
})

test('parseOptimizeInPlaceOptions keeps in-place optimizer disabled by default', () => {
  const oldEnv = process.env.BABEL_O_ALLOW_IN_PLACE_OPTIMIZER
  delete process.env.BABEL_O_ALLOW_IN_PLACE_OPTIMIZER

  try {
    const parsed = parseOptimizeInPlaceOptions({
      focus: 'performance',
      cwd: '/repo',
    })

    assert.deepEqual(parsed, { allowInPlaceOptimizer: false })
  } finally {
    if (oldEnv === undefined) delete process.env.BABEL_O_ALLOW_IN_PLACE_OPTIMIZER
    else process.env.BABEL_O_ALLOW_IN_PLACE_OPTIMIZER = oldEnv
  }
})

test('parseOptimizeInPlaceOptions enables in-place optimizer by explicit flag', () => {
  const oldEnv = process.env.BABEL_O_ALLOW_IN_PLACE_OPTIMIZER
  delete process.env.BABEL_O_ALLOW_IN_PLACE_OPTIMIZER

  try {
    assert.deepEqual(parseOptimizeInPlaceOptions({
      focus: 'cleanup',
      cwd: '/repo',
      allowInPlaceOptimizer: true,
    }), { allowInPlaceOptimizer: true })
    assert.deepEqual(parseOptimizeInPlaceOptions({
      focus: 'cleanup',
      cwd: '/repo',
      allowInPlace: true,
    }), { allowInPlaceOptimizer: true })
  } finally {
    if (oldEnv === undefined) delete process.env.BABEL_O_ALLOW_IN_PLACE_OPTIMIZER
    else process.env.BABEL_O_ALLOW_IN_PLACE_OPTIMIZER = oldEnv
  }
})

test('parseOptimizeInPlaceOptions enables in-place optimizer by environment opt-in', () => {
  const oldEnv = process.env.BABEL_O_ALLOW_IN_PLACE_OPTIMIZER
  process.env.BABEL_O_ALLOW_IN_PLACE_OPTIMIZER = '1'

  try {
    const parsed = parseOptimizeInPlaceOptions({
      focus: 'security',
      cwd: '/repo',
    })

    assert.deepEqual(parsed, { allowInPlaceOptimizer: true })
  } finally {
    if (oldEnv === undefined) delete process.env.BABEL_O_ALLOW_IN_PLACE_OPTIMIZER
    else process.env.BABEL_O_ALLOW_IN_PLACE_OPTIMIZER = oldEnv
  }
})

test('formatAgentLoopSmokeResult includes timeout failure diagnostics', () => {
  const output = formatAgentLoopSmokeResult({
    mode: 'live_manual',
    ready: true,
    live: false,
    success: false,
    provider: { providerId: 'minimax', modelId: 'minimax/MiniMax-M3' },
    checks: {
      authConfigured: true,
      modelResolved: true,
      toolsSupported: true,
      streamingSupported: true,
      structuredOutputSupported: true,
    },
    sessionId: 'session_timeout',
    sessionPhase: 'failed',
    taskCompleted: false,
    criticCompleted: false,
    workspaceCreated: true,
    workspaceCleaned: true,
    usage: [{ role: 'optimizer', eventCount: 17, toolCallCount: 1 }],
    roleDiagnostics: [{
      role: 'optimizer',
      model: 'minimax/MiniMax-M3',
      allowedTools: ['Read'],
      repairAttempts: 0,
      errorCode: 'REQUEST_TIMEOUT',
      errorMessagePreview: 'The operation was aborted.',
      lastToolName: 'Read',
      lastToolSuccess: true,
      lastToolOutputPreview: 'BABEL_O_AGENT_LOOP_SMOKE_OK',
    }],
    error: {
      message: 'AgentLoop live smoke timed out after 120000ms',
      category: 'agent_loop_timeout',
    },
    fallbackPolicy: {
      mode: 'fix_configuration',
      allowSilentModelSwitch: false,
      nextAction: 'Fix provider configuration.',
    },
    diagnostic: {
      domain: 'provider',
      name: 'agent_loop_smoke',
      status: 'blocked',
      summary: 'minimax/MiniMax-M3 agent loop live ready=yes live=no',
    },
  })

  assert.match(output, /Failure type:\s+agent_loop_timeout/)
  assert.match(output, /Diagnostic:\s+blocked · minimax\/MiniMax-M3 agent loop live ready=yes live=no/)
  assert.match(output, /optimizer\{.*error=REQUEST_TIMEOUT/)
  assert.match(output, /lastTool=Read:yes/)
  assert.match(output, /toolOut="BABEL_O_AGENT_LOOP_SMOKE_OK"/)
})

test('parseOptimizeProviderSmokeLiveOptions rejects invalid timeout', () => {
  assert.throws(
    () => parseOptimizeProviderSmokeLiveOptions({
      focus: 'performance',
      cwd: '/repo',
      timeoutMs: 'soon',
    }),
    /--timeout-ms must be a positive integer/,
  )
})

test('parseOptimizeSubAgentOptions rejects invalid limits', () => {
  assert.throws(
    () => parseOptimizeSubAgentOptions({
      target: 'src',
      focus: 'security',
      cwd: '/repo',
      enableSubAgents: true,
      maxSubAgentDepth: '0',
      maxSubTasksPerTask: '5',
    }),
    /--max-sub-agent-depth must be a positive integer/,
  )

  assert.throws(
    () => parseOptimizeSubAgentOptions({
      target: 'src',
      focus: 'security',
      cwd: '/repo',
      enableSubAgents: true,
      maxSubAgentDepth: '1',
      maxSubTasksPerTask: 'many',
    }),
    /--max-sub-tasks-per-task must be a positive integer/,
  )
})
