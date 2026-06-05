import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Command } from 'commander'
import { registerAgentsCommand, buildAgentFilter, buildAgentSpawnRequest } from '../src/cli/commands/agents.js'

test('agents command registers management subcommands', () => {
  const program = new Command()
  registerAgentsCommand(program)

  const agents = program.commands.find(command => command.name() === 'agents')
  assert.ok(agents)
  assert.deepEqual(
    agents.commands.map(command => command.name()),
    ['spawn', 'list', 'show', 'wait', 'cancel', 'transcript', 'session'],
  )
})

test('agents command builds spawn request from CLI options', () => {
  const request = buildAgentSpawnRequest(['Find', 'files'], {
    parentSessionId: 'session-parent',
    agentType: 'explore',
    contextForkMode: 'minimal',
    isolation: 'none',
    maxRuntimeMs: '120000',
  })

  assert.deepEqual(request, {
    parentSessionId: 'session-parent',
    prompt: 'Find files',
    agentType: 'explore',
    contextForkMode: 'minimal',
    isolation: 'none',
    maxRuntimeMs: 120000,
  })
})

test('agents command builds list filters and rejects invalid positive integers', () => {
  assert.deepEqual(buildAgentFilter({
    parentSessionId: 'session-parent',
    status: 'completed',
    agentType: 'explore',
  }), {
    parentSessionId: 'session-parent',
    status: 'completed',
    agentType: 'explore',
  })

  assert.throws(
    () => buildAgentSpawnRequest(['Find'], {
      parentSessionId: 'session-parent',
      maxRuntimeMs: 'soon',
    }),
    /--max-runtime-ms must be a positive integer/,
  )
})
