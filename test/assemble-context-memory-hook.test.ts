import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { assembleContext } from '../src/runtime/contextAssembler.js'
import { NoopMemoryProvider, type MemoryProvider } from '../src/runtime/memoryProvider.js'
import type { MemoryProviderDiagnostics } from '../src/runtime/memoryProvider.js'
import type { NexusEvent } from '../src/shared/events.js'
import type { RuntimeExecuteOptions } from '../src/runtime/Runtime.js'

/**
 * §3.5 v1.1 follow-up: hot-path `onMemoryRetrieval` hook. The
 * `assembleContext` projector must fire the hook exactly once per
 * `memoryProvider.retrieve()` call so the runtime can persist a
 * `memory_retrieval` NexusEvent for the
 * `/v1/runtime/memory/status` dashboard. The hook is the
 * single source of truth for the dashboard's recent-window
 * quality signal.
 *
 * Backward compatibility: when no hook is provided, the
 * projector still calls `memoryProvider.retrieve()` and uses
 * the result for context assembly — only the side effect is
 * skipped.
 */

const schemaVersion = '2026-05-21.babel-o.v1' as const

function makeSessionEvents(): NexusEvent[] {
  return [
    {
      type: 'session_started',
      schemaVersion,
      sessionId: 'session-hotpath-test',
      timestamp: '2026-06-18T10:00:00.000Z',
      cwd: '/repo',
    },
  ]
}

function runtimeOptions(overrides: Partial<RuntimeExecuteOptions> = {}): RuntimeExecuteOptions {
  return {
    sessionId: 'session-hotpath-test',
    prompt: 'recall what we decided about the API',
    cwd: '/repo',
    ...overrides,
  } as RuntimeExecuteOptions
}

test('onMemoryRetrieval is fired once per memoryProvider.retrieve() with full diagnostics', async () => {
  const cwd = join(tmpdir(), `babel-o-hook-test-${Date.now()}-${Math.random()}`)
  const hookCalls: Array<{ sessionId: string; cwd: string; prompt: string; diagnostics: MemoryProviderDiagnostics }> = []
  await assembleContext({
    runtimeOptions: runtimeOptions({ cwd }),
    events: makeSessionEvents(),
    modelId: 'local/test',
    buildSystemPrompt: () => 'system',
    mapEventsToMessages: () => [],
    memoryProvider: new NoopMemoryProvider(),
    sessionInbox: [],
    onMemoryRetrieval: async input => {
      hookCalls.push(input)
    },
  })
  assert.equal(hookCalls.length, 1, 'expected the hook to fire exactly once per retrieve')
  const call = hookCalls[0]!
  assert.equal(call.sessionId, 'session-hotpath-test')
  assert.equal(call.cwd, cwd)
  assert.equal(call.prompt, 'recall what we decided about the API')
  // NoopMemoryProvider returns enabled: false; the hook must still
  // receive the full diagnostics (the dashboard's auto-search-skip
  // distribution depends on seeing skipped retrievals).
  assert.equal(call.diagnostics.provider, 'noop')
  assert.equal(call.diagnostics.enabled, false)
  assert.equal(call.diagnostics.hitCount, 0)
  // NoopMemoryProvider does not set `autoSearch`; the hook must
  // receive the diagnostics verbatim so the dashboard can tell
  // "noop was used" apart from "no memory cue was found". This
  // is part of the §3.5 dashboard contract.
  assert.equal(call.diagnostics.autoSearch, undefined)
})

test('onMemoryRetrieval is optional — assembly succeeds when no hook is provided', async () => {
  // This is the default for the GET /v1/sessions/:id/context route
  // in production Nexus (only the route-level inspection
  // diagnostics endpoint passes a hook; the hot path inside
  // LLMCodingRuntime wires its own). When no hook is provided
  // assembly must still complete and the memoryProvider must
  // still be consulted.
  let retrieveCalled = false
  const provider: MemoryProvider = {
    name: 'probe',
    async retrieve() {
      retrieveCalled = true
      return {
        content: 'hint',
        diagnostics: {
          provider: 'probe',
          enabled: true,
          hitCount: 1,
          injectedChars: 4,
          budgetChars: 100,
          maxHitChars: 50,
          truncated: false,
          scope: 'project',
        },
      }
    },
  }
  const cwd = join(tmpdir(), `babel-o-no-hook-test-${Date.now()}-${Math.random()}`)
  const ctx = await assembleContext({
    runtimeOptions: runtimeOptions({ cwd }),
    events: makeSessionEvents(),
    modelId: 'local/test',
    buildSystemPrompt: () => 'system',
    mapEventsToMessages: () => [],
    memoryProvider: provider,
    sessionInbox: [],
    // no onMemoryRetrieval — backward compat path
  })
  assert.equal(retrieveCalled, true, 'memoryProvider.retrieve should still be called')
  assert.match(ctx.systemPrompt, /hint/)
})

test('onMemoryRetrieval does not throw into the hot path when it itself throws', async () => {
  // The contract: a failing hook must NOT break the assembly
  // result. The hook fires fire-and-forget from
  // `assembleContext`'s perspective (the implementation awaits
  // the hook with try/catch); a thrown hook error must surface
  // only via process.stderr, not via the assembly return value.
  const cwd = join(tmpdir(), `babel-o-hook-throws-${Date.now()}-${Math.random()}`)
  const ctx = await assembleContext({
    runtimeOptions: runtimeOptions({ cwd }),
    events: makeSessionEvents(),
    modelId: 'local/test',
    buildSystemPrompt: () => 'system',
    mapEventsToMessages: () => [],
    memoryProvider: new NoopMemoryProvider(),
    sessionInbox: [],
    onMemoryRetrieval: async () => {
      throw new Error('synthetic hook failure')
    },
  })
  // The assembly result must still be usable. NoopMemoryProvider
  // returns no content, so the system prompt has no memory hint.
  assert.ok(ctx.systemPrompt.length >= 0, 'assembly must produce a result even when the hook throws')
})
