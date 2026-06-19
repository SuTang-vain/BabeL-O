import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ToolDispatchPipeline } from '../src/runtime/ToolDispatchPipeline.js'
import { allowAllTools } from '../src/runtime/LocalCodingRuntime.js'
import { createRuntimeExecutionMetrics } from '../src/runtime/runtimePipeline.js'
import { buildTaskScopeDeclaredEvent } from '../src/runtime/taskScope.js'
import { ProviderSessionRules } from '../src/runtime/providerSessionRules.js'
import { createDefaultToolRegistry } from '../src/tools/registry.js'
import { MemoryStorage } from '../src/storage/MemoryStorage.js'
import type { NexusEvent } from '../src/shared/events.js'

async function collectToolDispatch(stream: ReturnType<ToolDispatchPipeline['run']>) {
  const events: NexusEvent[] = []
  let next = await stream.next()
  while (!next.done) {
    events.push(next.value)
    next = await stream.next()
  }
  return { events, result: next.value }
}

test('ToolDispatchPipeline executes provider tool calls and aggregates tool results', async () => {
  const tools = createDefaultToolRegistry()
  const cwd = join(tmpdir(), `babel-o-tool-dispatch-${Date.now()}`)
  await mkdir(cwd, { recursive: true })
  await writeFile(join(cwd, 'dispatch.txt'), 'dispatch-content', 'utf8')
  const runtimeOptions = {
    sessionId: 'session-tool-dispatch',
    prompt: 'read dispatch.txt',
    cwd,
    skipPermissionCheck: true,
  }
  const taskScopeEvent = buildTaskScopeDeclaredEvent({
    sessionId: runtimeOptions.sessionId,
    cwd,
    prompt: runtimeOptions.prompt,
    events: [],
  })
  let workingSetUpdate: { sessionId: string; cwd: string; events: NexusEvent[] } | undefined
  const pipeline = new ToolDispatchPipeline({
    tools,
    toolPolicy: allowAllTools(),
    storage: new MemoryStorage(),
    metrics: createRuntimeExecutionMetrics(),
    readFileCache: new Map(),
    providerSessionRules: new ProviderSessionRules(),
    applyWorkingSetUpdate: (sessionId, events, updateCwd) => {
      workingSetUpdate = { sessionId, cwd: updateCwd, events }
    },
  })

  const { events, result } = await collectToolDispatch(pipeline.run({
    toolCalls: [{
      id: 'tool-dispatch-read',
      name: 'Read',
      partialInput: '{"path":"dispatch.txt"}',
    }],
    runtimeOptions,
    previousEvents: [taskScopeEvent],
    taskScopeEvent,
  }))

  assert.equal(result.kind, 'continue')
  assert.equal(result.taskScopeEvent, taskScopeEvent)
  assert.equal(result.previousEvents.some(event => event.type === 'tool_completed'), true)
  assert.equal(result.toolResults.length, 1)
  assert.equal(result.toolResults[0]?.toolUseId, 'tool-dispatch-read')
  assert.equal(result.toolResults[0]?.content, 'dispatch-content')
  assert.equal(result.toolResults[0]?.isError, false)
  assert.deepEqual(events.map(event => event.type), ['tool_started', 'tool_completed'])
  assert.equal(workingSetUpdate?.sessionId, runtimeOptions.sessionId)
  assert.equal(workingSetUpdate?.cwd, cwd)
  assert.equal(workingSetUpdate?.events.some(event => event.type === 'tool_started'), true)
  assert.equal(workingSetUpdate?.events.some(event => event.type === 'tool_completed'), true)
})
