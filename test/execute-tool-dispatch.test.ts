import assert from 'node:assert/strict'
import { test } from 'node:test'
import { executeToolDispatch } from '../src/runtime/executeToolDispatch.js'
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
    toolResults: [{ toolUseId: 't1', content: 'pwd output', is_error: false }],
  }
  const pipeline = makeStubPipeline(events, finalValue)
  const result = await executeToolDispatch(pipeline, stubInput)
  assert.equal(result.events.length, 2)
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
  const result = await executeToolDispatch(pipeline, stubInput)
  assert.equal(result.terminal, true)
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
  const result = await executeToolDispatch(pipeline, stubInput)
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
    () => executeToolDispatch(errorPipeline, stubInput),
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
  const result = await executeToolDispatch(pipeline, {
    ...stubInput,
    taskScopeEvent: makeTaskScopeEvent(),
  })
  // The helper returns whatever the dispatch updated
  // the taskScopeEvent to. If the pipeline updates it
  // (as the real pipeline does), the result reflects
  // the new value.
  assert.equal(result.taskScopeEvent, newTaskScope)
})
