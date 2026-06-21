import { tmpdir } from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { refreshRuntimeContextState } from '../src/runtime/runtimePipeline.js'
import type { RuntimeContextEvent } from '../src/runtime/contextBroadcaster.js'

test('refreshRuntimeContextState publishes assembled context only to injected broadcaster', async () => {
  const events: Array<{ cwd: string; event: RuntimeContextEvent }> = []

  const state = await refreshRuntimeContextState({
    runtimeOptions: {
      sessionId: 'session-context-broadcaster-injection',
      cwd: tmpdir(),
      prompt: 'hello',
    },
    events: [],
    modelId: 'minimax/MiniMax-M3',
    buildSystemPrompt: () => 'system',
    mapEventsToMessages: () => [],
    tools: () => [],
    warningPercent: 70,
    compactPercent: 90,
    suppressToolsForIntent: () => false,
    contextBroadcaster: {
      publish(cwd, event) {
        events.push({ cwd, event })
      },
    },
  })

  assert.equal(events.length, 1)
  assert.equal(events[0].cwd, tmpdir())
  assert.equal(events[0].event.type, 'assembled')
  assert.equal(events[0].event.sessionId, 'session-context-broadcaster-injection')
  assert.equal(events[0].event.context, state.assembledContext)
})

test('refreshRuntimeContextState works without a broadcaster', async () => {
  const state = await refreshRuntimeContextState({
    runtimeOptions: {
      sessionId: 'session-context-broadcaster-none',
      cwd: tmpdir(),
      prompt: 'hello',
    },
    events: [],
    modelId: 'minimax/MiniMax-M3',
    buildSystemPrompt: () => 'system',
    mapEventsToMessages: () => [],
    tools: () => [],
    warningPercent: 70,
    compactPercent: 90,
    suppressToolsForIntent: () => false,
  })

  assert.ok(state.assembledContext.systemPrompt.length > 0)
})
