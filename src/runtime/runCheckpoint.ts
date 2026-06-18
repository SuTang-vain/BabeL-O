import type { NexusEvent } from '../shared/events.js'
import type { SessionPhase, SessionSnapshot } from '../shared/session.js'

/**
 * §3.3 of `docs/nexus/reference/agent-runtime-architecture-maturity-plan.md`:
 * Durable Run Checkpoint / Resume.
 *
 * v1 deliberately defines ONLY checkpoint boundaries and resumable
 * execution states — it does not resume from the middle of a provider
 * token stream, and it does not persist the in-process async
 * iterator / pending promise that the runtime tool loop hangs on
 * (see `active/TODO_runtime.md` §P2 Architecture Boundary: writing
 * only the pending-permission entry to SQLite would create "looks
 * durable, actually unrecoverable" false persistence).
 *
 * Instead, this module projects the *resumability* of a run from
 * already-persisted data (session phase + ordered event stream +
 * pending-permission presence), mirroring how
 * `projectAgentTrace` derives a trajectory from events. The output
 * lets `bbl inspect-session` honestly report where a run stopped,
 * whether it can resume, and what should happen next — without
 * claiming durability the process-local continuation cannot back.
 */

/**
 * The six checkpoint boundaries a run crosses. These are NOT session
 * phases (which are coarser: `created` / `executing` /
 * `waiting_permission` / ...); they are the fine-grained points at
 * which resumability semantics change. v1 reports which boundary the
 * run stopped at; it does not persist a snapshot at each.
 */
export type RunCheckpointBoundary =
  | 'before_provider_invocation'
  | 'after_provider_invocation'
  | 'before_tool_execution'
  | 'waiting_permission'
  | 'after_tool_result'
  | 'before_final_result'

/**
 * The five resumable execution states from §3.3. `cannot_resume` is
 * the honest default when the process-local continuation is gone
 * (process restart) and no durable continuation snapshot exists.
 */
export type ResumableRunState =
  | { state: 'resume_possible'; boundary: RunCheckpointBoundary; reason: string }
  | { state: 'retry_from_provider_turn'; boundary: RunCheckpointBoundary; reason: string }
  | { state: 'waiting_permission'; boundary: RunCheckpointBoundary; reason: string; toolUseId?: string }
  | { state: 'terminal_failed_recoverable'; boundary: RunCheckpointBoundary; reason: string }
  | { state: 'cannot_resume'; boundary: RunCheckpointBoundary | null; reason: string }

export interface DerivedResumableState {
  state: ResumableRunState
  /**
   * True only when a durable continuation snapshot exists for this
   * run — i.e. the process-local provider/tool-loop continuation is
   * backed by something that survives restart. v1 never sets this to
   * true (no such snapshot is persisted yet); callers that know the
   * process is still alive MAY pass `hasContinuationSnapshot: true`
   * to upgrade `cannot_resume` → `resume_possible`. The derived
   * state records what was passed so `inspect-session` can render
   * the honest "process-local, not durable across restart" note.
   */
  hasContinuationSnapshot: boolean
  /**
   * Whether a `permission_request` event has no matching
   * `permission_response` (the run is parked waiting for an
   * approval the operator can still give). This is the one
   * genuinely durable resume vector in v1: the permission audit
   * + the pending entry let the operator decide, even though the
   * tool-loop continuation itself is process-local.
   */
  pendingPermissionToolUseId: string | null
  warnings: string[]
}

export interface DeriveResumableStateInput {
  /**
   * The session snapshot (phase + terminal reason). The events array
   * on the snapshot is ignored in favour of the explicit `events`
   * field so callers can pass a truncated / recent window.
   */
  session: Pick<SessionSnapshot, 'phase' | 'terminalReason' | 'error'>
  /**
   * Ordered event stream (chronological, ascending). Typically
   * `storage.listEvents({ order: 'asc' })`.
   */
  events: ReadonlyArray<NexusEvent>
  /**
   * The toolUseId of a still-pending permission request, if the
   * caller's PendingPermissionRegistry has one for this session.
   * When provided AND the event stream corroborates it
   * (`permission_request` without `permission_response`), the run
   * is `waiting_permission`. When absent but the event stream shows
   * an unresolved `permission_request`, the state is still
   * `waiting_permission` but flagged as "pending entry not found in
   * registry" (the operator may need to re-issue).
   */
  pendingPermissionToolUseId?: string | null
  /**
   * Whether a durable continuation snapshot exists. Defaults to
   * `false` — v1 never persists one. Live-process callers (e.g. a
   * running Nexus inspecting its own session) may pass `true`.
   */
  hasContinuationSnapshot?: boolean
}

/**
 * Derive the resumable execution state of a run from persisted data.
 *
 * Pure: no storage, no clock, no side effects. The derivation walks
 * the event stream from the end to find the last meaningful boundary,
 * then maps (boundary, terminal presence, continuation snapshot,
 * pending permission) to one of the five §3.3 states.
 *
 * Degraded paths (empty stream, no session_started, orphan
 * tool_started) emit human-readable warnings rather than throwing —
 * `inspect-session` renders them so the operator can tell a
 * genuinely stuck run apart from an incompletely-persisted one.
 */
export function deriveResumableState(input: DeriveResumableStateInput): DerivedResumableState {
  const warnings: string[] = []
  const { session, events } = input
  const hasContinuationSnapshot = input.hasContinuationSnapshot ?? false

  // --- terminal: a result/error event means the run finished. ---
  const terminalIndex = findLastIndex(events, e => e.type === 'result' || e.type === 'error')
  if (terminalIndex >= 0) {
    const terminal = events[terminalIndex]!
    if (terminal.type === 'result') {
      // Successful terminal — nothing to resume. Report as
      // terminal_failed_recoverable only when success=false; a
      // success is a clean stop, not a resumable state.
      const success = (terminal as { success?: boolean }).success
      if (success) {
        return {
          state: {
            state: 'cannot_resume',
            boundary: null,
            reason: 'run completed successfully; nothing to resume',
          },
          hasContinuationSnapshot,
          pendingPermissionToolUseId: null,
          warnings,
        }
      }
      return {
        state: {
          state: 'terminal_failed_recoverable',
          boundary: 'before_final_result',
          reason: `run ended with a failed result event: ${(terminal as { message?: string }).message ?? ''}`.trim(),
        },
        hasContinuationSnapshot,
        pendingPermissionToolUseId: null,
        warnings,
      }
    }
    // error event
    return {
      state: {
        state: 'terminal_failed_recoverable',
        boundary: 'before_final_result',
        reason: `run ended with an error event (code=${(terminal as { code?: string }).code ?? 'unknown'}): ${(terminal as { message?: string }).message ?? ''}`.trim(),
      },
      hasContinuationSnapshot,
      pendingPermissionToolUseId: null,
      warnings,
    }
  }

  // --- session phase shortcut: cancelled is terminal, non-resumable. ---
  if (session.phase === 'cancelled') {
    return {
      state: {
        state: 'cannot_resume',
        boundary: null,
        reason: 'session phase is cancelled; nothing to resume',
      },
      hasContinuationSnapshot,
      pendingPermissionToolUseId: null,
      warnings,
    }
  }

  if (events.length === 0) {
    warnings.push('no events in stream; cannot locate a checkpoint boundary')
    return {
      state: {
        state: 'cannot_resume',
        boundary: null,
        reason: 'no events persisted; run continuation is process-local and not recoverable from storage',
      },
      hasContinuationSnapshot,
      pendingPermissionToolUseId: null,
      warnings,
    }
  }

  // --- pending permission: the one durable resume vector in v1. ---
  // A permission_request with no matching permission_response means
  // the run is parked. The operator can still approve/deny; the
  // permission audit + pending entry survive restart even though the
  // tool-loop continuation does not.
  const pendingPermission = findPendingPermission(events)
  if (pendingPermission) {
    const registryCorroborated =
      input.pendingPermissionToolUseId != null && input.pendingPermissionToolUseId === pendingPermission.toolUseId
    if (!registryCorroborated) {
      warnings.push(
        `permission_request (toolUseId=${pendingPermission.toolUseId}) has no matching permission_response, ` +
          `and the pending entry was not found in the live registry — the operator may need to re-issue the approval`,
      )
    }
    return {
      state: {
        state: 'waiting_permission',
        boundary: 'waiting_permission',
        reason: registryCorroborated
          ? `run is parked waiting for permission on tool ${pendingPermission.name} (toolUseId=${pendingPermission.toolUseId}); approve or deny to resume`
          : `run was waiting for permission on tool ${pendingPermission.name} (toolUseId=${pendingPermission.toolUseId}), but the live pending entry is gone — re-issue the approval or retry from the provider turn`,
        toolUseId: pendingPermission.toolUseId,
      },
      hasContinuationSnapshot,
      pendingPermissionToolUseId: pendingPermission.toolUseId,
      warnings,
    }
  }

  // --- non-terminal, no pending permission: locate the last
  //     meaningful boundary and decide retry vs cannot-resume. ---
  const lastBoundary = locateLastBoundary(events, warnings)

  // Without a continuation snapshot, the process-local provider/tool
  // loop is gone on restart. v1 is honest: only `waiting_permission`
  // (handled above) is durable; everything else is `cannot_resume`
  // unless the caller asserts a live continuation.
  if (!hasContinuationSnapshot) {
    return {
      state: {
        state: 'cannot_resume',
        boundary: lastBoundary,
        reason: `run stopped at ${lastBoundary}; the provider/tool-loop continuation is process-local and was not persisted. Re-run the prompt to start a fresh continuation.`,
      },
      hasContinuationSnapshot,
      pendingPermissionToolUseId: null,
      warnings,
    }
  }

  // Continuation snapshot exists (live process or future durable
  // backend). Map the boundary to the appropriate retry state.
  if (lastBoundary === 'before_tool_execution') {
    return {
      state: {
        state: 'retry_from_provider_turn',
        boundary: lastBoundary,
        reason: 'run stopped before a tool call executed; retry from the provider turn to re-request the tool call',
      },
      hasContinuationSnapshot,
      pendingPermissionToolUseId: null,
      warnings,
    }
  }
  if (lastBoundary === 'after_tool_result') {
    return {
      state: {
        state: 'retry_from_provider_turn',
        boundary: lastBoundary,
        reason: 'run stopped after a tool result was persisted but before the next provider turn; retry from the provider turn to continue',
      },
      hasContinuationSnapshot,
      pendingPermissionToolUseId: null,
      warnings,
    }
  }
  return {
    state: {
      state: 'resume_possible',
      boundary: lastBoundary,
      reason: `run stopped at ${lastBoundary} and a continuation snapshot exists; resume from the checkpoint`,
    },
    hasContinuationSnapshot,
    pendingPermissionToolUseId: null,
    warnings,
  }
}

// --- helpers -----------------------------------------------------------

function findPendingPermission(
  events: ReadonlyArray<NexusEvent>,
): { toolUseId: string; name: string } | null {
  // Walk from the end; the most recent unresolved permission_request
  // is the one that parks the run.
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!
    if (event.type !== 'permission_request') continue
    const toolUseId = (event as { toolUseId: string }).toolUseId
    const resolved = events.some(
      e => e.type === 'permission_response' && (e as { toolUseId: string }).toolUseId === toolUseId,
    )
    if (!resolved) {
      return { toolUseId, name: (event as { name: string }).name }
    }
  }
  return null
}

/**
 * Locate the last checkpoint boundary the run crossed, based on the
 * most recent meaningful event. Emits a warning for orphan
 * tool_started (tool call started but never completed/denied and no
 * permission_request followed — the run died mid-tool).
 */
function locateLastBoundary(
  events: ReadonlyArray<NexusEvent>,
  warnings: string[],
): RunCheckpointBoundary {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!
    switch (event.type) {
      case 'tool_completed':
      case 'tool_denied':
        return 'after_tool_result'
      case 'permission_response':
        // Permission resolved but no tool_completed followed → the
        // provider turn was about to continue.
        return 'after_provider_invocation'
      case 'permission_request':
        // Handled by findPendingPermission; if we reach here the
        // request was resolved. Treat as after_provider_invocation.
        return 'after_provider_invocation'
      case 'tool_started': {
        // tool_started with no subsequent tool_completed / tool_denied
        // AND no permission_request → the run died before the tool
        // executed (or before permission was even requested).
        const toolUseId = (event as { toolUseId: string }).toolUseId
        const hasResolution = events.slice(i + 1).some(
          e =>
            (e.type === 'tool_completed' || e.type === 'tool_denied' || e.type === 'permission_request') &&
            (e as { toolUseId?: string }).toolUseId === toolUseId,
        )
        if (!hasResolution) {
          warnings.push(
            `orphan tool_started (toolUseId=${toolUseId}, name=${(event as { name: string }).name}); run stopped before the tool executed`,
          )
          return 'before_tool_execution'
        }
        // tool_started was followed by a resolution we already passed
        // in this backward walk — keep scanning.
        continue
      }
      case 'usage':
      case 'assistant_delta':
      case 'thinking_delta':
        return 'after_provider_invocation'
      case 'session_started':
        return 'before_provider_invocation'
      default:
        // Compact / context / scope / memory / hook / task events
        // don't change the resumability boundary on their own; keep
        // scanning backward for a provider/tool/permission event.
        continue
    }
  }
  // Only non-boundary events (compact/context/scope/...) seen.
  warnings.push('no provider/tool/permission boundary event found in stream; defaulting to before_provider_invocation')
  return 'before_provider_invocation'
}

function findLastIndex<T>(arr: ReadonlyArray<T>, predicate: (value: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (predicate(arr[i]!)) return i
  }
  return -1
}
