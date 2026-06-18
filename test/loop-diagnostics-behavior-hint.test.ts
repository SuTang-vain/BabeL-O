// test/loop-diagnostics-behavior-hint.test.ts
//
// PR-6 unit tests: StatusBehaviorHint PaneStatus extension.
// Covers: 6 existing statuses still resolve (regression), new behaviorHint
// status, applyBehaviorHint pass-through, priority override, integration
// with derivePaneStatus (loop health payload shape).

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  derivePaneStatus,
  applyBehaviorHint,
  PaneStatusSnapshot,
  BehaviorHintProjection,
  STATUS_PRIORITY as _SP,
  BEHAVIOR_HINT_PRIORITY,
} from '../src/runtime/loopDiagnostics.js'
import { NEXUS_EVENT_SCHEMA_VERSION, type NexusEvent } from '../src/shared/events.js'

function mkEvent(type: NexusEvent['type'], overrides: Partial<NexusEvent> = {}): NexusEvent {
  return {
    type,
    schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
    sessionId: 's1',
    timestamp: '2026-06-16T00:00:00.000Z',
    ...overrides,
  } as NexusEvent
}

describe('PR-6 INV-12 regression: 6 existing statuses still resolve', () => {
  test('idle when no events', () => {
    const snap = derivePaneStatus({ events: [] })
    assert.equal(snap.status, 'idle')
  })

  test('working when tool_started', () => {
    const events: NexusEvent[] = [
      mkEvent('tool_started', { toolUseId: 'tu_1' }),
    ]
    const snap = derivePaneStatus({ events })
    assert.equal(snap.status, 'working')
  })

  test('blocked when permission_request', () => {
    const events: NexusEvent[] = [
      mkEvent('permission_request', { toolUseId: 'tu_1' }),
    ]
    const snap = derivePaneStatus({ events })
    assert.equal(snap.status, 'blocked')
  })

  test('drift when scope_boundary_detected', () => {
    const events: NexusEvent[] = [
      mkEvent('scope_boundary_detected', {
        toolUseId: 'tu_1',
        toolName: 'Read',
        targetRoot: '/etc',
        taskPrimaryRoot: '/repo',
        boundaryKind: 'external_absolute_path',
        action: 'warn',
        scopeRisk: 'outside_current_project',
      }),
    ]
    const snap = derivePaneStatus({ events })
    assert.equal(snap.status, 'drift')
  })

  test('waiting when timeout_budget_exceeded', () => {
    const events: NexusEvent[] = [
      mkEvent('timeout_budget_exceeded', { elapsedMs: 100, timeoutMs: 50, policy: 'soft' }),
    ]
    const snap = derivePaneStatus({ events })
    assert.equal(snap.status, 'waiting')
  })

  test('done when result.success=true with no pending', () => {
    const events: NexusEvent[] = [
      mkEvent('result', { success: true, message: 'ok' }),
    ]
    const snap = derivePaneStatus({ events })
    assert.equal(snap.status, 'done')
  })
})

describe('PR-6 new behaviorHint status', () => {
  test('behaviorHint has highest priority (6) per INV-13', () => {
    assert.equal(BEHAVIOR_HINT_PRIORITY, 6)
    const priorities = [
      'idle', 'working', 'blocked', 'waiting', 'drift', 'done', 'behaviorHint',
    ] as const
    const max = Math.max(...priorities.map(p => _SP[p]))
    assert.equal(_SP.behaviorHint, max, 'behaviorHint must have highest priority')
  })

  test('applyBehaviorHint with null behaviorHint passes through unchanged', () => {
    const base: PaneStatusSnapshot = {
      status: 'working',
      pendingPermissions: 0,
      pendingScopeBoundaries: 0,
      outOfScopeEvidence: 0,
    }
    const result = applyBehaviorHint(base, null)
    assert.equal(result.status, 'working')
    assert.equal(result.pendingHints, 0)
  })

  test('applyBehaviorHint with undefined passes through unchanged', () => {
    const base: PaneStatusSnapshot = {
      status: 'idle',
      pendingPermissions: 0,
      pendingScopeBoundaries: 0,
      outOfScopeEvidence: 0,
    }
    const result = applyBehaviorHint(base, undefined)
    assert.equal(result.status, 'idle')
    assert.equal(result.pendingHints, 0)
  })

  test('applyBehaviorHint with pendingHints=0 passes through unchanged', () => {
    const base: PaneStatusSnapshot = {
      status: 'working',
      pendingPermissions: 0,
      pendingScopeBoundaries: 0,
      outOfScopeEvidence: 0,
    }
    const hint: BehaviorHintProjection = { pendingHints: 0 }
    const result = applyBehaviorHint(base, hint)
    assert.equal(result.status, 'working')
  })

  test('applyBehaviorHint with pendingHints>0 overrides to behaviorHint', () => {
    const base: PaneStatusSnapshot = {
      status: 'idle',
      pendingPermissions: 0,
      pendingScopeBoundaries: 0,
      outOfScopeEvidence: 0,
    }
    const hint: BehaviorHintProjection = {
      pendingHints: 1,
      lastHintAt: Date.now() - 1000,
      lastHintPattern: '/repo/src/runtime/sessionMemoryLite.ts',
    }
    const result = applyBehaviorHint(base, hint)
    assert.equal(result.status, 'behaviorHint')
    assert.equal(result.pendingHints, 1)
    assert.equal(result.lastHintAt, hint.lastHintAt)
    assert.equal(result.lastHintPattern, '/repo/src/runtime/sessionMemoryLite.ts')
  })

  test('applyBehaviorHint overrides even when underlying status is "done" (priority 6 > 2)', () => {
    const base: PaneStatusSnapshot = {
      status: 'done',
      pendingPermissions: 0,
      pendingScopeBoundaries: 0,
      outOfScopeEvidence: 0,
    }
    const hint: BehaviorHintProjection = { pendingHints: 1 }
    const result = applyBehaviorHint(base, hint)
    assert.equal(result.status, 'behaviorHint', 'behaviorHint wins over done')
  })

  test('applyBehaviorHint overrides even when underlying status is "blocked" (priority 6 > 5)', () => {
    const base: PaneStatusSnapshot = {
      status: 'blocked',
      pendingPermissions: 1,
      pendingScopeBoundaries: 0,
      outOfScopeEvidence: 0,
    }
    const hint: BehaviorHintProjection = { pendingHints: 1 }
    const result = applyBehaviorHint(base, hint)
    assert.equal(result.status, 'behaviorHint', 'behaviorHint wins over blocked')
  })

  test('applyBehaviorHint preserves existing fields (pendingPermissions etc.)', () => {
    const base: PaneStatusSnapshot = {
      status: 'working',
      pendingPermissions: 2,
      pendingScopeBoundaries: 1,
      outOfScopeEvidence: 0,
      lastEventSeq: 42,
      lastEventAt: '2026-06-16T00:00:00.000Z',
    }
    const hint: BehaviorHintProjection = { pendingHints: 1 }
    const result = applyBehaviorHint(base, hint)
    assert.equal(result.pendingPermissions, 2)
    assert.equal(result.pendingScopeBoundaries, 1)
    assert.equal(result.lastEventSeq, 42)
    assert.equal(result.lastEventAt, '2026-06-16T00:00:00.000Z')
    assert.equal(result.status, 'behaviorHint')
    assert.equal(result.pendingHints, 1)
  })
})

describe('PR-6 end-to-end: derivePaneStatus + applyBehaviorHint', () => {
  test('a session that is otherwise idle gets behaviorHint when hint arrives', () => {
    const events: NexusEvent[] = [] // idle
    const base = derivePaneStatus({ events })
    assert.equal(base.status, 'idle')

    const result = applyBehaviorHint(base, { pendingHints: 1 })
    assert.equal(result.status, 'behaviorHint')
    assert.equal(result.pendingHints, 1)
  })

  test('a session that is otherwise working gets behaviorHint when hint arrives', () => {
    const events: NexusEvent[] = [mkEvent('tool_started', { toolUseId: 'tu_1' })]
    const base = derivePaneStatus({ events })
    assert.equal(base.status, 'working')

    const result = applyBehaviorHint(base, { pendingHints: 2 })
    assert.equal(result.status, 'behaviorHint')
    assert.equal(result.pendingHints, 2)
  })

  test('multi-hint: pendingHints counter accumulates', () => {
    const base: PaneStatusSnapshot = {
      status: 'idle', pendingPermissions: 0, pendingScopeBoundaries: 0, outOfScopeEvidence: 0,
    }
    let result = applyBehaviorHint(base, { pendingHints: 1 })
    assert.equal(result.pendingHints, 1)
    // Caller increments; we don't do it internally (pure function)
    result = applyBehaviorHint(base, { pendingHints: 3 })
    assert.equal(result.pendingHints, 3)
  })
})
