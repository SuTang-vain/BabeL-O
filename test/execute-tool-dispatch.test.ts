import assert from 'node:assert/strict'
import { test } from 'node:test'
import { executeToolDispatch, type ExecuteToolDispatchResult } from '../src/runtime/executeToolDispatch.js'
import type { ToolDispatchPipeline } from '../src/runtime/ToolDispatchPipeline.js'
import type { NexusEvent } from '../src/shared/events.js'
import type { TaskScopeDeclaredEvent } from '../src/runtime/taskScope.js'

// ─── fixtures ──────────────────────────────────────────────

function makeStubPipeline(
  events: NexusEvent[],
  finalValue: any,
): ToolDispatchPipeline {
  return {
    run: async function* () {
      for (const e of events) yield e
      return finalValue
    },
  } as unknown as ToolDispatchPipeline
}

function makeTaskScopeEvent(): TaskScopeDeclaredEvent {
  return {
    type: 'task_scope_declared',
    ...({} as any),
    primaryRoot: '/workspace',
    explicitRoots: [],
    confirmedExternalRoots: [],
    inferredCandidateRoots: [],
    mode: 'single_root',
    source: 'cwd',
  } as unknown as TaskScopeDeclaredEvent
}

async function drainToolDispatch(
  pipeline: ToolDispatchPipeline,
  input = stubInput,
): Promise<ExecuteToolDispatchResult & { streamedEvents: NexusEvent[] }> {
  const events: NexusEvent[] = []
  const stream = executeToolDispatch(pipeline, input)
  let next = await stream.next()
  while (!next.done) {
    events.push(next.value)
    next = await stream.next()
  }
  return normalizeDispatchResult(next.value, events)
}

function normalizeDispatchResult(
  result: ExecuteToolDispatchResult,
  streamedEvents: NexusEvent[],
): ExecuteToolDispatchResult & { streamedEvents: NexusEvent[] } {
  return {
    ...result,
    streamedEvents,
  }
}

const stubInput = {
  toolCalls: [{ toolUseId: 't1', name: 'Bash', input: { command: 'pwd' } }] as any,
  runtimeOptions: {} as any,
  previousEvents: [] as NexusEvent[],
  taskScopeEvent: makeTaskScopeEvent(),
}

// ─── tests ──────────────────────────────────────────────────

test('executeToolDispatch returns events + previousEvents + taskScopeEvent + non-terminal result', async () => {
  const events: NexusEvent[] = [
    { type: 'tool_started', ...({} as any) } as unknown as NexusEvent,
    { type: 'tool_completed', ...({} as any) } as unknown as NexusEvent,
  ]
  const finalValue = {
    kind: 'continue' as const,
    previousEvents: [...events, { type: 'result', ...({} as any) } as unknown as NexusEvent],
    taskScopeEvent: makeTaskScopeEvent(),
    toolResults: [{ type: 'tool_result', toolUseId: 't1', content: 'pwd output', isError: false }],
  }
  const pipeline = makeStubPipeline(events, finalValue)
  const result = await drainToolDispatch(pipeline)
  assert.equal(result.events.length, 2)
  assert.deepEqual(result.streamedEvents, events)
  assert.equal(result.terminal, false)
  assert.equal(result.messages.length, 1, 'continue path → 1 messages entry (toolResults)')
  // previousEvents is the dispatch's accumulator, not
  // the input's. The main loop must write it back.
  assert.equal(result.previousEvents.length, 3)
})

test('executeToolDispatch returns terminal=true on terminal outcome', async () => {
  const events: NexusEvent[] = [
    { type: 'tool_started', ...({} as any) } as unknown as NexusEvent,
  ]
  const finalValue = {
    kind: 'terminal' as const,
    previousEvents: events,
    taskScopeEvent: makeTaskScopeEvent(),
  }
  const pipeline = makeStubPipeline(events, finalValue)
  const result = await drainToolDispatch(pipeline)
  assert.equal(result.terminal, true)
  assert.deepEqual(result.streamedEvents, events)
  assert.equal(result.messages.length, 0, 'terminal path → 0 messages')
  assert.equal(result.previousEvents.length, 1)
})

test('executeToolDispatch returns empty events when pipeline yields nothing', async () => {
  const finalValue = {
    kind: 'continue' as const,
    previousEvents: [],
    taskScopeEvent: makeTaskScopeEvent(),
    toolResults: [],
  }
  const pipeline = makeStubPipeline([], finalValue)
  const result = await drainToolDispatch(pipeline)
  assert.equal(result.events.length, 0)
  assert.equal(result.terminal, false)
  assert.equal(result.messages.length, 1)
})

test('executeToolDispatch propagates errors from the pipeline', async () => {
  const errorPipeline: ToolDispatchPipeline = {
    run: () => {
      throw new Error('pipeline failure')
    },
  } as unknown as ToolDispatchPipeline
  await assert.rejects(
    async () => {
      const stream = executeToolDispatch(errorPipeline, stubInput)
      await stream.next()
    },
    /pipeline failure/,
  )
})

test('executeToolDispatch returns the updated taskScopeEvent from the dispatch result', async () => {
  const newTaskScope = makeTaskScopeEvent()
  const finalValue = {
    kind: 'continue' as const,
    previousEvents: [],
    taskScopeEvent: newTaskScope,
    toolResults: [],
  }
  const pipeline = makeStubPipeline([], finalValue)
  const result = await drainToolDispatch(pipeline, {
    ...stubInput,
    taskScopeEvent: makeTaskScopeEvent(),
  })
  // The helper returns whatever the dispatch updated
  // the taskScopeEvent to. If the pipeline updates it
  // (as the real pipeline does), the result reflects
  // the new value.
  assert.equal(result.taskScopeEvent, newTaskScope)
})

test('executeToolDispatch streams permission_request before waiting for final dispatch result', async () => {
  let releaseDispatch!: () => void
  const blocked = new Promise<void>(resolve => {
    releaseDispatch = resolve
  })
  const permissionRequest = {
    type: 'permission_request',
    toolUseId: 'tool-call-1',
    name: 'Bash',
    input: { command: 'pwd' },
    risk: 'execute',
    message: 'Tool Bash requires user permission to run.',
  } as unknown as NexusEvent
  const finalValue = {
    kind: 'continue' as const,
    previousEvents: [permissionRequest],
    taskScopeEvent: makeTaskScopeEvent(),
    toolResults: [{ type: 'tool_result', toolUseId: 'tool-call-1', content: 'denied', isError: true }],
  }
  const pipeline = {
    run: async function* () {
      yield permissionRequest
      await blocked
      return finalValue
    },
  } as unknown as ToolDispatchPipeline

  const stream = executeToolDispatch(pipeline, stubInput)
  const first = await Promise.race([
    stream.next(),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('permission_request was buffered')), 50)),
  ])

  assert.equal(first.done, false)
  assert.equal(first.value, permissionRequest)
  releaseDispatch()

  const done = await stream.next()
  assert.equal(done.done, true)
  assert.equal(done.value.terminal, false)
  assert.deepEqual(done.value.events, [permissionRequest])
})
