import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  deriveResumableState,
  type ResumableRunState,
  type RunCheckpointBoundary,
} from '../src/runtime/runCheckpoint.js'
import { NEXUS_EVENT_SCHEMA_VERSION, type NexusEvent } from '../src/shared/events.js'
import type { SessionSnapshot } from '../src/shared/session.js'

/**
 * §3.3 of `docs/nexus/reference/agent-runtime-architecture-maturity-plan.md`:
 * Durable Run Checkpoint / Resume — v1 only defines checkpoint
 * boundaries and resumable execution states (no mid-token-stream
 * resume). These tests cover the five states + the three regression
 * scenarios from the acceptance criteria:
 *   - permission wait (waiting_permission),
 *   - tool result persisted but provider continuation incomplete
 *     (retry_from_provider_turn),
 *   - provider context recovery interrupted (cannot_resume without a
 *     continuation snapshot).
 *
 * The projector is pure: it derives state from session phase + an
 * ordered event stream + an optional pending-permission id, with no
 * storage / clock / side effects. This mirrors `projectAgentTrace`.
 */

const SID = 'session-resume-test'
const V = NEXUS_EVENT_SCHEMA_VERSION
const BASE = Date.parse('2026-06-17T10:00:00.000Z')

function ts(baseMs: number, offsetMs: number): string {
  return new Date(baseMs + offsetMs).toISOString()
}

function ev(partial: { type: string; timestamp: string } & Record<string, unknown>): NexusEvent {
  return { schemaVersion: V, sessionId: SID, ...partial } as unknown as NexusEvent
}

function session(phase: SessionSnapshot['phase']): Pick<SessionSnapshot, 'phase' | 'terminalReason' | 'error'> {
  return { phase, terminalReason: undefined, error: undefined }
}

function stateOf(s: { state: ResumableRunState }): ResumableRunState['state'] {
  return s.state.state
}

// --- terminal runs -----------------------------------------------------

describe('deriveResumableState: terminal runs', () => {
  test('successful result event → cannot_resume (nothing to resume)', () => {
    const events = [
      ev({ type: 'session_started', timestamp: ts(BASE, 0), cwd: '/repo' }),
      ev({ type: 'result', timestamp: ts(BASE, 40), success: true, message: 'done' }),
    ]
    const out = deriveResumableState({ session: session('completed'), events })
    assert.equal(stateOf(out), 'cannot_resume')
    assert.equal(out.state.state === 'cannot_resume' ? out.state.boundary : null, null)
    assert.match(out.state.state === 'cannot_resume' ? out.state.reason : '', /completed successfully/)
  })

  test('failed result event (success=false) → terminal_failed_recoverable at before_final_result', () => {
    const events = [
      ev({ type: 'session_started', timestamp: ts(BASE, 0), cwd: '/repo' }),
      ev({ type: 'result', timestamp: ts(BASE, 40), success: false, message: 'tool failed' }),
    ]
    const out = deriveResumableState({ session: session('failed'), events })
    assert.equal(stateOf(out), 'terminal_failed_recoverable')
    if (out.state.state !== 'terminal_failed_recoverable') return
    assert.equal(out.state.boundary, 'before_final_result')
    assert.match(out.state.reason, /failed result event/)
  })

  test('error event → terminal_failed_recoverable, reason carries code + message', () => {
    const events = [
      ev({ type: 'session_started', timestamp: ts(BASE, 0), cwd: '/repo' }),
      ev({ type: 'error', timestamp: ts(BASE, 40), code: 'PROVIDER_ERROR', message: 'upstream 500' }),
    ]
    const out = deriveResumableState({ session: session('failed'), events })
    assert.equal(stateOf(out), 'terminal_failed_recoverable')
    if (out.state.state !== 'terminal_failed_recoverable') return
    assert.match(out.state.reason, /PROVIDER_ERROR/)
    assert.match(out.state.reason, /upstream 500/)
  })

  test('cancelled phase (no terminal event) → cannot_resume', () => {
    const events = [
      ev({ type: 'session_started', timestamp: ts(BASE, 0), cwd: '/repo' }),
      ev({ type: 'assistant_delta', timestamp: ts(BASE, 10), text: 'hi' }),
    ]
    const out = deriveResumableState({ session: session('cancelled'), events })
    assert.equal(stateOf(out), 'cannot_resume')
    assert.match(out.state.state === 'cannot_resume' ? out.state.reason : '', /cancelled/)
  })
})

// --- waiting_permission (the one durable resume vector in v1) ----------

describe('deriveResumableState: waiting_permission', () => {
  test('unresolved permission_request → waiting_permission, surfaces toolUseId', () => {
    const events = [
      ev({ type: 'session_started', timestamp: ts(BASE, 0), cwd: '/repo' }),
      ev({ type: 'assistant_delta', timestamp: ts(BASE, 10), text: 'editing' }),
      ev({ type: 'permission_request', timestamp: ts(BASE, 20), toolUseId: 'tu-9', name: 'Edit', input: { path: '/repo/a.ts' }, risk: 'write' }),
    ]
    const out = deriveResumableState({
      session: session('waiting_permission'),
      events,
      pendingPermissionToolUseId: 'tu-9',
    })
    assert.equal(stateOf(out), 'waiting_permission')
    if (out.state.state !== 'waiting_permission') return
    assert.equal(out.state.boundary, 'waiting_permission')
    assert.equal(out.state.toolUseId, 'tu-9')
    assert.match(out.state.reason, /parked waiting for permission/)
    assert.equal(out.pendingPermissionToolUseId, 'tu-9')
    assert.equal(out.warnings.length, 0)
  })

  test('permission_request without live registry entry → still waiting_permission but warns', () => {
    // After a restart the PendingPermissionRegistry is empty even
    // though the permission_request event is persisted. v1 is
    // honest: the run WAS waiting, but the live continuation is
    // gone, so the operator must re-issue.
    const events = [
      ev({ type: 'session_started', timestamp: ts(BASE, 0), cwd: '/repo' }),
      ev({ type: 'permission_request', timestamp: ts(BASE, 20), toolUseId: 'tu-9', name: 'Bash', input: { command: 'rm -rf' }, risk: 'execute' }),
    ]
    const out = deriveResumableState({
      session: session('waiting_permission'),
      events,
      pendingPermissionToolUseId: null,
    })
    assert.equal(stateOf(out), 'waiting_permission')
    if (out.state.state !== 'waiting_permission') return
    assert.equal(out.state.toolUseId, 'tu-9')
    assert.match(out.state.reason, /live pending entry is gone/)
    assert.ok(out.warnings.some(w => /not found in the live registry/.test(w)))
  })

  test('resolved permission_request (has permission_response) does NOT count as pending', () => {
    const events = [
      ev({ type: 'session_started', timestamp: ts(BASE, 0), cwd: '/repo' }),
      ev({ type: 'permission_request', timestamp: ts(BASE, 20), toolUseId: 'tu-9', name: 'Edit', input: {}, risk: 'write' }),
      ev({ type: 'permission_response', timestamp: ts(BASE, 22), toolUseId: 'tu-9', approved: true, scope: 'once' }),
      // No tool_completed after — run died after approval, before tool exec.
    ]
    const out = deriveResumableState({ session: session('executing'), events })
    assert.notEqual(stateOf(out), 'waiting_permission')
    assert.equal(out.pendingPermissionToolUseId, null)
  })

  test('most-recent unresolved permission_request wins when multiple exist', () => {
    const events = [
      ev({ type: 'session_started', timestamp: ts(BASE, 0), cwd: '/repo' }),
      ev({ type: 'permission_request', timestamp: ts(BASE, 20), toolUseId: 'tu-1', name: 'Edit', input: {}, risk: 'write' }),
      ev({ type: 'permission_response', timestamp: ts(BASE, 22), toolUseId: 'tu-1', approved: false, scope: 'once' }),
      ev({ type: 'permission_request', timestamp: ts(BASE, 30), toolUseId: 'tu-2', name: 'Bash', input: {}, risk: 'execute' }),
    ]
    const out = deriveResumableState({
      session: session('waiting_permission'),
      events,
      pendingPermissionToolUseId: 'tu-2',
    })
    assert.equal(stateOf(out), 'waiting_permission')
    if (out.state.state !== 'waiting_permission') return
    assert.equal(out.state.toolUseId, 'tu-2')
  })
})

// --- cannot_resume (no continuation snapshot) -------------------------

describe('deriveResumableState: cannot_resume without continuation snapshot', () => {
  test('non-terminal run after a tool result → cannot_resume at after_tool_result (process restart killed the continuation)', () => {
    const events = [
      ev({ type: 'session_started', timestamp: ts(BASE, 0), cwd: '/repo' }),
      ev({ type: 'assistant_delta', timestamp: ts(BASE, 10), text: 'reading' }),
      ev({ type: 'tool_started', timestamp: ts(BASE, 20), toolUseId: 'tu-1', name: 'Read', input: {} }),
      ev({ type: 'tool_completed', timestamp: ts(BASE, 30), toolUseId: 'tu-1', name: 'Read', success: true, output: 'ok' }),
      // No result event — the provider turn that would consume this
      // tool result never happened because the process died.
    ]
    const out = deriveResumableState({ session: session('executing'), events })
    assert.equal(stateOf(out), 'cannot_resume')
    if (out.state.state !== 'cannot_resume') return
    assert.equal(out.state.boundary, 'after_tool_result')
    assert.match(out.state.reason, /process-local and was not persisted/)
    assert.equal(out.hasContinuationSnapshot, false)
  })

  test('orphan tool_started (no completion/denial/permission) → cannot_resume at before_tool_execution + warning', () => {
    const events = [
      ev({ type: 'session_started', timestamp: ts(BASE, 0), cwd: '/repo' }),
      ev({ type: 'assistant_delta', timestamp: ts(BASE, 10), text: 'editing' }),
      ev({ type: 'tool_started', timestamp: ts(BASE, 20), toolUseId: 'tu-7', name: 'Edit', input: {} }),
      // Run died right after tool_started, before permission or execution.
    ]
    const out = deriveResumableState({ session: session('executing'), events })
    assert.equal(stateOf(out), 'cannot_resume')
    if (out.state.state !== 'cannot_resume') return
    assert.equal(out.state.boundary, 'before_tool_execution')
    assert.ok(out.warnings.some(w => /orphan tool_started/.test(w) && /tu-7/.test(w)))
  })

  test('empty event stream → cannot_resume with warning', () => {
    const out = deriveResumableState({ session: session('created'), events: [] })
    assert.equal(stateOf(out), 'cannot_resume')
    if (out.state.state !== 'cannot_resume') return
    assert.equal(out.state.boundary, null)
    assert.ok(out.warnings.some(w => /no events/.test(w)))
  })

  test('only compact/context events after session_started → cannot_resume at before_provider_invocation (session_started is the boundary)', () => {
    // session_started itself counts as a boundary (before_provider_invocation);
    // compact/context events do not advance it. No warning expected because
    // a boundary WAS found.
    const events = [
      ev({ type: 'session_started', timestamp: ts(BASE, 0), cwd: '/repo' }),
      ev({ type: 'context_warning', timestamp: ts(BASE, 10), message: 'big', tokens: 9000 }),
      ev({ type: 'compact_boundary', timestamp: ts(BASE, 20), boundaryId: 'b1', beforeEventCount: 5, afterEventCount: 1, trigger: 'auto', preTokens: 9000, postTokens: 2000 }),
    ]
    const out = deriveResumableState({ session: session('executing'), events })
    assert.equal(stateOf(out), 'cannot_resume')
    if (out.state.state !== 'cannot_resume') return
    assert.equal(out.state.boundary, 'before_provider_invocation')
  })

  test('event stream with NO session_started and only compact events → warning + before_provider_invocation default', () => {
    // No session_started, no provider/tool/permission event — the
    // backward scan falls through to the default warning.
    const events = [
      ev({ type: 'context_warning', timestamp: ts(BASE, 10), message: 'big', tokens: 9000 }),
      ev({ type: 'compact_boundary', timestamp: ts(BASE, 20), boundaryId: 'b1', beforeEventCount: 5, afterEventCount: 1, trigger: 'auto', preTokens: 9000, postTokens: 2000 }),
    ]
    const out = deriveResumableState({ session: session('executing'), events })
    assert.equal(stateOf(out), 'cannot_resume')
    if (out.state.state !== 'cannot_resume') return
    assert.equal(out.state.boundary, 'before_provider_invocation')
    assert.ok(out.warnings.some(w => /no provider\/tool\/permission boundary/.test(w)))
  })
})

// --- with continuation snapshot (live process or future durable backend) ---

describe('deriveResumableState: with continuation snapshot', () => {
  test('after_tool_result + hasContinuationSnapshot → retry_from_provider_turn', () => {
    const events = [
      ev({ type: 'session_started', timestamp: ts(BASE, 0), cwd: '/repo' }),
      ev({ type: 'tool_started', timestamp: ts(BASE, 20), toolUseId: 'tu-1', name: 'Read', input: {} }),
      ev({ type: 'tool_completed', timestamp: ts(BASE, 30), toolUseId: 'tu-1', name: 'Read', success: true, output: 'ok' }),
    ]
    const out = deriveResumableState({ session: session('executing'), events, hasContinuationSnapshot: true })
    assert.equal(stateOf(out), 'retry_from_provider_turn')
    if (out.state.state !== 'retry_from_provider_turn') return
    assert.equal(out.state.boundary, 'after_tool_result')
    assert.match(out.state.reason, /retry from the provider turn/)
  })

  test('orphan tool_started + hasContinuationSnapshot → retry_from_provider_turn at before_tool_execution', () => {
    const events = [
      ev({ type: 'session_started', timestamp: ts(BASE, 0), cwd: '/repo' }),
      ev({ type: 'tool_started', timestamp: ts(BASE, 20), toolUseId: 'tu-7', name: 'Edit', input: {} }),
    ]
    const out = deriveResumableState({ session: session('executing'), events, hasContinuationSnapshot: true })
    assert.equal(stateOf(out), 'retry_from_provider_turn')
    if (out.state.state !== 'retry_from_provider_turn') return
    assert.equal(out.state.boundary, 'before_tool_execution')
  })

  test('after_provider_invocation (usage/assistant_delta) + hasContinuationSnapshot → resume_possible', () => {
    const events = [
      ev({ type: 'session_started', timestamp: ts(BASE, 0), cwd: '/repo' }),
      ev({ type: 'assistant_delta', timestamp: ts(BASE, 10), text: 'thinking' }),
      ev({ type: 'usage', timestamp: ts(BASE, 12), inputTokens: 10, outputTokens: 5 }),
    ]
    const out = deriveResumableState({ session: session('executing'), events, hasContinuationSnapshot: true })
    assert.equal(stateOf(out), 'resume_possible')
    if (out.state.state !== 'resume_possible') return
    assert.equal(out.state.boundary, 'after_provider_invocation')
  })

  test('before_provider_invocation (only session_started) + hasContinuationSnapshot → resume_possible', () => {
    const events = [ev({ type: 'session_started', timestamp: ts(BASE, 0), cwd: '/repo' })]
    const out = deriveResumableState({ session: session('created'), events, hasContinuationSnapshot: true })
    assert.equal(stateOf(out), 'resume_possible')
    if (out.state.state !== 'resume_possible') return
    assert.equal(out.state.boundary, 'before_provider_invocation')
  })
})

// --- boundary type exhaustiveness --------------------------------------

test('RunCheckpointBoundary covers the six §3.3 boundaries', () => {
  const expected: RunCheckpointBoundary[] = [
    'before_provider_invocation',
    'after_provider_invocation',
    'before_tool_execution',
    'waiting_permission',
    'after_tool_result',
    'before_final_result',
  ]
  // Compile-time check: every expected value is assignable.
  const _typed: RunCheckpointBoundary[] = expected
  assert.equal(_typed.length, 6)
})
