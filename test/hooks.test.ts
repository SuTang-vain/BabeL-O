import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { executeRuntimeHooks, mergeHookRetryHints } from '../src/runtime/hooks.js'

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
})
