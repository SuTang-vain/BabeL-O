// src/runtime/loopDiagnostics.ts
//
// bbl loop plan Phase 1: derive `PaneStatus` for one session from
// the runtime-owned Nexus event stream. The status is a
// server-owned projection so clients (multi-pane TUI, sidecar
// dashboards) never re-derive truth.
//
// Status precedence (highest priority wins):
//   1. blocked   — last unresolved `permission_request`
//   2. drift     — last unresolved `scope_boundary_detected`
//   3. waiting   — last `timeout_budget_exceeded` /
//                  `near_timeout_warning` / `context_grounding_required`
//   4. done      — terminal `result.success === true` with no
//                  outstanding permission/scope boundary
//   5. working   — last `tool_started` without terminal result
//   6. idle      — otherwise

import type { NexusEvent } from '../shared/events.js'

export type PaneStatus =
  | 'idle'
  | 'working'
  | 'blocked'
  | 'waiting'
  | 'drift'
  | 'done'
  // PR-6: new status for cross-session behavior hints (Track B Phase 2).
  // Per design §6.5.2 + INV-13: highest priority (6).
  | 'behaviorHint'

export interface PaneStatusSnapshot {
  status: PaneStatus
  pendingPermissions: number
  pendingScopeBoundaries: number
  outOfScopeEvidence: number
  lastEventSeq?: number
  lastEventAt?: string
}

const STATUS_PRIORITY: Record<PaneStatus, number> = {
  blocked: 5,
  drift: 4,
  waiting: 3,
  done: 2,
  working: 1,
  idle: 0,
  // PR-6: behaviorHint is highest priority (INV-13). When a session
  // has a pending behavior hint, it overrides all 6 existing statuses.
  behaviorHint: 6,
}

// Re-export for tests + callers that need to inspect priority ordering.
export { STATUS_PRIORITY }

export interface DerivePaneStatusOptions {
  /** Recent event slice from `storage.listEvents`. */
  events: NexusEvent[]
  /**
   * Cursor/page-limit awareness: the route may receive a slice
   * that doesn't include all historical events. When set, the
   * helper treats the input as the working window.
   */
  windowSize?: number
}

/**
 * Derive a snapshot of one session's current pane status from the
 * provided event stream. The function is pure: it never touches
 * storage, never mutates the events, and never awaits. Callers
 * pre-fetch events via `storage.listEvents` and feed the result
 * here.
 */
export function derivePaneStatus(
  options: DerivePaneStatusOptions,
): PaneStatusSnapshot {
  const events = options.events
  let pendingPermissions = 0
  let pendingScopeBoundaries = 0
  let outOfScopeEvidence = 0
  let lastEventAt: string | undefined
  let lastEventSeq: number | undefined
  let winner: PaneStatus = 'idle'

  for (const event of events) {
    if (!lastEventAt || event.timestamp > lastEventAt) {
      lastEventAt = event.timestamp
    }
    const seq = (event as { eventSeq?: unknown }).eventSeq
    if (typeof seq === 'number' && Number.isFinite(seq)) {
      if (lastEventSeq === undefined || seq > lastEventSeq) {
        lastEventSeq = seq
      }
    }

    switch (event.type) {
      case 'permission_request':
        pendingPermissions += 1
        if (STATUS_PRIORITY.blocked >= STATUS_PRIORITY[winner]) {
          winner = 'blocked'
        }
        break
      case 'permission_response':
        pendingPermissions = Math.max(0, pendingPermissions - 1)
        break
      case 'scope_boundary_detected':
        pendingScopeBoundaries += 1
        if (event.scopeRisk && event.scopeRisk !== 'historical_path') {
          outOfScopeEvidence += 1
        }
        if (STATUS_PRIORITY.drift >= STATUS_PRIORITY[winner]) {
          winner = 'drift'
        }
        break
      case 'scope_boundary_confirmed':
        pendingScopeBoundaries = Math.max(0, pendingScopeBoundaries - 1)
        break
      case 'timeout_budget_exceeded':
      case 'near_timeout_warning':
      case 'context_grounding_required':
        if (STATUS_PRIORITY.waiting >= STATUS_PRIORITY[winner]) {
          winner = 'waiting'
        }
        break
      case 'tool_started':
        if (STATUS_PRIORITY.working >= STATUS_PRIORITY[winner]) {
          winner = 'working'
        }
        break
      case 'tool_completed':
        // tool_completed alone doesn't change status; terminal
        // `result` and the absence of further tool_started
        // collectively produce the `done` projection.
        break
      case 'result':
        if (event.success) {
          if (pendingPermissions === 0 && pendingScopeBoundaries === 0) {
            if (STATUS_PRIORITY.done >= STATUS_PRIORITY[winner]) {
              winner = 'done'
            }
          }
        }
        break
      default:
        break
    }
  }

  if (pendingScopeBoundaries > 0 && STATUS_PRIORITY.drift > STATUS_PRIORITY[winner]) {
    winner = 'drift'
  }
  if (pendingPermissions > 0 && STATUS_PRIORITY.blocked > STATUS_PRIORITY[winner]) {
    winner = 'blocked'
  }

  return {
    status: winner,
    pendingPermissions,
    pendingScopeBoundaries,
    outOfScopeEvidence,
    lastEventSeq,
    lastEventAt,
  }
}

// ─── PR-6 (Track B Phase 2 bbl loop P1 integration) ─────────────────────
//
// Adds `behaviorHint` to PaneStatus without modifying the existing 6-status
// projection. Per INV-12: existing statuses (idle/working/blocked/waiting/
// drift/done) and their priority logic are preserved verbatim. The new
// status is layered on via `applyBehaviorHint()` which takes the existing
// snapshot as input.
//
// Per design (docs/nexus/reference/behavior-monitor.md §6.5.2):
//   - StatusBehaviorHint is a NEW status (priority 6, highest)
//   - When a behavior hint is pending, status overrides to behaviorHint
//   - Three new fields exposed: pendingHints, lastHintAt, lastHintPattern
//
// INV-13: StatusBehaviorHint has highest priority (6)
// INV-12: existing 6 statuses + priority logic unchanged
// (Go mirror is a separate PR; this file is the server projection)

import { DEFAULT_HINT_COOLDOWN_MS } from '../nexus/behaviorMonitor.js'

export type BehaviorHintProjection = {
  /** Number of undispatched behavior hints for this session. */
  pendingHints: number
  /** Timestamp of the most recent dispatched hint (ms since epoch). */
  lastHintAt?: number
  /** Pattern string of the most recent hint (e.g. "/repo/src/foo.ts"). */
  lastHintPattern?: string
  /** Pattern of the *new* hint that triggered this status (if any). */
  currentHintPattern?: string
}

export interface PaneStatusSnapshotWithBehaviorHint extends PaneStatusSnapshot {
  pendingHints: number
  lastHintAt?: number
  lastHintPattern?: string
}

const BEHAVIOR_HINT_PRIORITY = 6

/**
 * Layer behavior-hint projection on top of an existing PaneStatusSnapshot.
 * Pure function: never mutates input, never touches storage.
 *
 * - When `behaviorHint` is null/undefined or pendingHints === 0, the
 *   existing snapshot is returned unchanged (INV-12 preserved).
 * - When pendingHints > 0, the status is overridden to 'behaviorHint'
 *   (INV-13: highest priority).
 * - `currentHintPattern` is the new hint pattern; `lastHintPattern` is
 *   the most recent dispatched one.
 */
export function applyBehaviorHint(
  snapshot: PaneStatusSnapshot,
  behaviorHint: BehaviorHintProjection | null | undefined,
): PaneStatusSnapshotWithBehaviorHint {
  // Fast path: no behavior hint state — pass through unchanged.
  if (!behaviorHint || behaviorHint.pendingHints <= 0) {
    return {
      ...snapshot,
      pendingHints: 0,
    }
  }
  // Decide whether to override: any pending hint that hasn't been
  // confirmed by cooldown expiry. The actual "still relevant" gate is
  // the caller's responsibility (BehaviorMonitor.tryDispatch enforces
  // cooldown); here we trust the projection.
  return {
    ...snapshot,
    status: 'behaviorHint',
    pendingHints: behaviorHint.pendingHints,
    lastHintAt: behaviorHint.lastHintAt,
    lastHintPattern: behaviorHint.lastHintPattern,
  }
}

// Re-export cooldown constant for callers that want to know the
// freshness window.
export { DEFAULT_HINT_COOLDOWN_MS, BEHAVIOR_HINT_PRIORITY }
