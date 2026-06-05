import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDefaultNexusRuntime } from '../src/nexus/createRuntime.js'
import { InMemoryRemoteToolRunner } from '../src/runtime/remoteRunner.js'

test('default Nexus runtime keeps Agent tools disabled unless explicitly enabled', async () => {
  const { runtime, storage } = await createDefaultNexusRuntime({
    allowedTools: ['AgentSpawn', 'Read'],
  })
  try {
    const tools = runtime.listTools?.() ?? []
    assert.equal(tools.some(tool => tool.name === 'AgentSpawn'), false)
    assert.equal(tools.some(tool => tool.name === 'Read'), true)
  } finally {
    await storage.close?.()
  }
})

test('Nexus runtime can expose model-visible Agent tools with explicit opt-in', async () => {
  const { runtime, storage } = await createDefaultNexusRuntime({
    enableAgentTools: true,
    allowedTools: ['AgentSpawn', 'AgentWait', 'AgentList', 'AgentCancel', 'Read'],
  })
  try {
    const tools = runtime.listTools?.() ?? []
    const byName = new Map(tools.map(tool => [tool.name, tool]))

    assert.equal(byName.get('AgentSpawn')?.allowed, true)
    assert.equal(byName.get('AgentWait')?.allowed, true)
    assert.equal(byName.get('AgentList')?.allowed, true)
    assert.equal(byName.get('AgentCancel')?.allowed, true)
    assert.equal(byName.get('Read')?.allowed, true)
    assert.equal(byName.get('Edit')?.allowed, false)
    assert.equal(byName.get('Bash')?.allowed, false)
  } finally {
    await storage.close?.()
  }
})

test('Nexus runtime keeps remote runner hidden when Agent scheduler opts into remote execution', async () => {
  const remoteRunner = new InMemoryRemoteToolRunner({
    capabilities: { tools: ['Read'] },
    handler: () => ({ kind: 'result', success: true, output: 'remote read' }),
  })
  const { runtime, storage } = await createDefaultNexusRuntime({
    enableAgentTools: true,
    allowedTools: ['AgentSpawn', 'AgentWait', 'Read'],
    remoteRunner,
    agentExecutionEnvironment: 'remote',
  })

  try {
    const tools = runtime.listTools?.() ?? []
    assert.equal(tools.some(tool => tool.name === remoteRunner.id), false)
    assert.equal(tools.some(tool => tool.name === 'GoRunner'), false)
    assert.equal(tools.some(tool => tool.name === 'AgentSpawn'), true)
  } finally {
    await storage.close?.()
  }
})
