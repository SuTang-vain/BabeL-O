import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseOptimizeSubAgentOptions } from '../src/cli/commands/optimize.js'

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
