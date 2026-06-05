import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { BabelOConfigSchema } from '../src/shared/config.js'
import {
  aggregateHookResults,
  executeRuntimeHooks,
  mergeHookRetryHints,
  type RuntimeHook,
} from '../src/runtime/hooks.js'

describe('runtime hooks', () => {
  test('returns retry hints for invalid tool input failures', async () => {
    const result = await executeRuntimeHooks(
      'PostToolUseFailure',
      {
        toolName: 'Write',
        toolUseId: 'tool-1',
        errorCode: 'INVALID_TOOL_INPUT',
        errorMessage: 'missing path',
        output: {
          code: 'INVALID_TOOL_INPUT',
          message: 'Write requires path',
        },
      },
      {
        sessionId: 'session-1',
        cwd: '/tmp',
      },
    )

    assert.ok(result.events.some(event => event.type === 'hook_started'))
    assert.ok(result.events.some(event => event.type === 'hook_completed'))
    assert.ok(result.results.some(({ result }) => result.retryHint))
    assert.match(
      mergeHookRetryHints('Base message', result),
      /Hook retry hints:/,
    )
    assert.match(
      mergeHookRetryHints('Base message', result),
      /Write input did not match its schema/,
    )
  })

  test('emits permission and session cleanup hook events', async () => {
    const permissionResult = await executeRuntimeHooks(
      'PermissionRequest',
      {
        toolName: 'Bash',
        toolRisk: 'execute',
        toolUseId: 'tool-2',
      },
      {
        sessionId: 'session-2',
        cwd: '/tmp',
      },
    )
    assert.ok(permissionResult.events.some(event => event.type === 'hook_started'))
    assert.ok(permissionResult.events.some(event => event.type === 'hook_completed'))

    const sessionEndResult = await executeRuntimeHooks(
      'SessionEnd',
      {
        cleanup: { reason: 'closed' },
      },
      {
        sessionId: 'session-3',
        cwd: '/tmp',
      },
    )
    assert.ok(sessionEndResult.events.some(event => event.type === 'hook_started'))
    assert.ok(sessionEndResult.events.some(event => event.type === 'hook_completed'))
  })

  test('emits subagent start and stop hook events', async () => {
    const startResult = await executeRuntimeHooks(
      'SubagentStart',
      {
        toolUseId: 'task-1',
        toolName: 'Subagent',
        toolInput: { prompt: 'test', sessionId: 'sub-1' },
      },
      {
        sessionId: 'session-4',
        cwd: '/tmp',
      },
    )
    assert.ok(startResult.events.some(event => event.type === 'hook_started'))
    assert.ok(startResult.events.some(event => event.type === 'hook_completed'))

    const stopResult = await executeRuntimeHooks(
      'SubagentStop',
      {
        toolUseId: 'task-1',
        toolName: 'Subagent',
        toolInput: { prompt: 'test', sessionId: 'sub-1' },
        success: true,
      },
      {
        sessionId: 'session-4',
        cwd: '/tmp',
      },
    )
    assert.ok(stopResult.events.some(event => event.type === 'hook_started'))
    assert.ok(stopResult.events.some(event => event.type === 'hook_completed'))
  })

  test('emits user prompt submit hook events', async () => {
    const result = await executeRuntimeHooks(
      'UserPromptSubmit',
      { prompt: 'Hello world' },
      {
        sessionId: 'session-5',
        cwd: '/tmp',
      },
    )
    assert.ok(result.events.some(event => event.type === 'hook_started'))
    assert.ok(result.events.some(event => event.type === 'hook_completed'))
  })

  test('emits invocation diagnostics hook metadata', async () => {
    const result = await executeRuntimeHooks(
      'PreInvocation',
      {
        invocation: {
          providerId: 'anthropic',
          modelId: 'anthropic/claude-3-5-sonnet',
          loopCount: 1,
          maxLoops: 25,
          role: 'executor',
          contextTokenEstimate: 1200,
          contextMaxTokens: 200000,
          percentUsed: 1,
          toolCount: 3,
          visibleToolCount: 3,
          cachePreservationMode: true,
          finalResponseOnlyMode: false,
        },
      },
      {
        sessionId: 'session-invocation',
        cwd: '/tmp',
        role: 'executor',
      },
    )

    assert.ok(result.events.some(event => event.type === 'hook_started' && event.hookEvent === 'PreInvocation'))
    assert.ok(result.events.some(event => event.type === 'hook_completed' && event.hookEvent === 'PreInvocation'))
    assert.equal(result.results[0]?.hookName, 'InvocationDiagnosticsHook')
    assert.equal(aggregateHookResults(result).metadata[0]?.result.metadata?.modelId, 'anthropic/claude-3-5-sonnet')
  })

  test('validates safe built-in hook configuration schema', () => {
    const parsed = BabelOConfigSchema.parse({
      hooks: {
        enabled: true,
        builtins: {
          RecoverInvalidToolInputHook: {
            enabled: false,
            timeoutMs: 250,
          },
        },
      },
    })

    assert.equal(parsed.hooks?.builtins?.RecoverInvalidToolInputHook.enabled, false)
    assert.equal(parsed.hooks?.builtins?.RecoverInvalidToolInputHook.timeoutMs, 250)
  })

  test('can disable all configured runtime hooks', async () => {
    const result = await executeRuntimeHooks(
      'UserPromptSubmit',
      { prompt: 'Hello world' },
      {
        sessionId: 'session-disabled',
        cwd: '/tmp',
      },
      { config: { enabled: false } },
    )

    assert.deepEqual(result.events, [])
    assert.deepEqual(result.results, [])
  })

  test('can disable one built-in hook while keeping another enabled', async () => {
    const result = await executeRuntimeHooks(
      'PostToolUseFailure',
      {
        toolName: 'Bash',
        toolUseId: 'tool-configured',
        errorCode: 'INVALID_TOOL_INPUT',
        output: {
          exitCode: 2,
          stderr: 'bad flag\nmore detail',
        },
      },
      {
        sessionId: 'session-configured',
        cwd: '/tmp',
      },
      {
        config: {
          builtins: {
            RecoverInvalidToolInputHook: { enabled: false },
          },
        },
      },
    )

    assert.equal(result.results.some(({ hookName }) => hookName === 'RecoverInvalidToolInputHook'), false)
    assert.equal(result.results.some(({ hookName }) => hookName === 'BashFailureSummaryHook'), true)
    assert.match(aggregateHookResults(result).summaries.join('\n'), /Bash failed with exit code 2/)
  })

  test('applies hook timeout override and isolates failed hooks', async () => {
    const hooks: RuntimeHook[] = [
      {
        name: 'SlowHook',
        events: ['UserPromptSubmit'],
        timeoutMs: 1_000,
        async run() {
          await delay(50)
          return { summary: 'too late' }
        },
      },
      {
        name: 'FastHook',
        events: ['UserPromptSubmit'],
        run() {
          return { summary: 'fast hook completed' }
        },
      },
    ]

    const result = await executeRuntimeHooks(
      'UserPromptSubmit',
      { prompt: 'Hello world' },
      {
        sessionId: 'session-timeout',
        cwd: '/tmp',
      },
      {
        hooks,
        config: {
          builtins: {
            SlowHook: { timeoutMs: 1 },
          },
        },
      },
    )

    assert.ok(result.events.some(event => event.type === 'hook_failed' && event.hookName === 'SlowHook'))
    assert.ok(result.events.some(event => event.type === 'hook_completed' && event.hookName === 'FastHook'))
    assert.deepEqual(aggregateHookResults(result).summaries, ['fast hook completed'])
  })

  test('aggregates hook results with first decision and last updated input semantics', async () => {
    const hooks: RuntimeHook[] = [
      {
        name: 'FirstHook',
        events: ['PreToolUse'],
        run() {
          return {
            updatedInput: { value: 1 },
            additionalContext: 'first context',
            denyReason: 'first deny',
            permissionDecision: { approved: false },
            retryHint: 'first hint',
            summary: 'first summary',
            metadata: { order: 1 },
          }
        },
      },
      {
        name: 'SecondHook',
        events: ['PreToolUse'],
        run() {
          return {
            updatedInput: { value: 2 },
            additionalContext: 'second context',
            denyReason: 'second deny',
            permissionDecision: { approved: true, reason: 'second decision' },
            retryHint: 'second hint',
            summary: 'second summary',
            metadata: { order: 2 },
          }
        },
      },
    ]

    const result = await executeRuntimeHooks(
      'PreToolUse',
      { toolName: 'Read', toolUseId: 'tool-aggregate' },
      {
        sessionId: 'session-aggregate',
        cwd: '/tmp',
      },
      { hooks },
    )
    const aggregate = aggregateHookResults(result)

    assert.deepEqual(aggregate.summaries, ['first summary', 'second summary'])
    assert.deepEqual(aggregate.retryHints, ['first hint', 'second hint'])
    assert.deepEqual(aggregate.additionalContext, ['first context', 'second context'])
    assert.equal(aggregate.metadata.length, 2)
    assert.equal(aggregate.denyReason, 'first deny')
    assert.deepEqual(aggregate.permissionDecision, {
      approved: false,
      reason: 'Permission decided by FirstHook',
    })
    assert.deepEqual(aggregate.updatedInput, { value: 2 })
  })
})
