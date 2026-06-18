import type { NexusEvent } from '../shared/events.js'
import type { MemoryProviderDiagnostics } from './memoryProvider.js'

/**
 * §3.5 of `docs/nexus/reference/agent-runtime-architecture-maturity-plan.md`:
 * MemoryOS/EverCore long-term memory quality metrics, aggregated from
 * the `memory_retrieval` event stream.
 *
 * v1 ships four of the seven §3.5 metrics:
 *  - auto-search triggered / skipped reason distribution,
 *  - hit count / injected chars / truncation rate,
 *  - memory write approval rate,
 *  - memory write denial rate.
 *
 * The other three metrics from the plan (memory-derived answer
 * revalidation rate, stale / contradicted memory count, memory hint
 * used in final answer count) require model-side or write-side
 * signals that do not exist yet; they are deferred to v1.1.
 *
 * All functions are pure: they read an ordered event stream and
 * return a frozen snapshot. No storage, no clock, no side effects.
 * This mirrors the projector pattern in `agentTrace.ts` /
 * `runCheckpoint.ts` — recent-window dashboards and the eval harness
 * can call the same function and get the same answer for the same
 * input.
 */

const MEMORY_RETRIEVAL_SENTINEL = 'memory_retrieval' as const

/**
 * Per-reason counts of auto-search decisions in the window. The
 * reason enum is the same one used in `MemoryProviderDiagnostics` —
 * see `src/runtime/memoryProvider.ts` `MemoryAutoSearchDecisionReason`.
 */
export type AutoSearchReasonCount = {
  reason:
    | 'aborted'
    | 'empty_prompt'
    | 'explicit_memory_cue'
    | 'current_workspace_only'
    | 'execution_status_only'
    | 'permission_response'
    | 'no_memory_cue'
  triggered: number
  skipped: number
}

export interface MemoryQualityMetrics {
  /** Total `memory_retrieval` events seen in the window. */
  retrievalCount: number
  /** Number of retrievals where `autoSearchTriggered === true`. */
  autoSearchTriggeredCount: number
  /**
   * Per-reason auto-search decision distribution. `triggered` and
   * `skipped` are summed independently; a reason can have both
   * (e.g. `explicit_memory_cue` always means triggered; `no_memory_cue`
   * always means skipped — but the matrix is kept explicit so future
   * reason changes don't silently invalidate the dashboard).
   */
  autoSearchReasonDistribution: AutoSearchReasonCount[]
  /** Sum of `hitCount` across all retrievals. */
  totalHitCount: number
  /** Sum of `injectedChars` across all retrievals. */
  totalInjectedChars: number
  /** Number of retrievals that returned at least one hit. */
  retrievalsWithHits: number
  /** Number of retrievals where `truncated === true`. */
  truncatedRetrievalCount: number
  /** Sum of `searchLatencyMs` across retrievals that report it. */
  totalSearchLatencyMs: number
  /** Number of retrievals that reported a `searchLatencyMs`. */
  retrievalLatencySampleCount: number
  /** Number of retrievals where `error` is set. */
  errorRetrievalCount: number
  /** Total `memory_note_saved` events seen in the window. */
  memoryNoteSaveCount: number
  /**
   * Counts of `memory_note_saved` outcomes. v1 derives approval /
   * denial from the `metadata` blob on the SessionChannel memory
   * candidate: `governance.decision === 'approved'` for approval,
   * `=== 'rejected'` for denial. v1.1 will read the explicit
   * `approved` / `rejected` markers from the route response; the
   * dashboard already includes `pendingReviewCount` so the operator
   * can spot candidates still awaiting decision.
   */
  memoryNoteApprovalCount: number
  memoryNoteDenialCount: number
  memoryNotePendingReviewCount: number
}

/**
 * Compute the §3.5 memory quality metrics from an ordered event
 * stream. The window is caller-defined: pass all events for a
 * session, or a recent window from `storage.listEvents`. Pure
 * function, no side effects.
 *
 * `memoryNoteApprovals` / `memoryNoteDenials` are passed in
 * separately because the save/denial signals live on SessionChannel
 * messages and the `memory_candidate` governance metadata blob,
 * not on `memory_retrieval` events. Callers that only have the
 * event stream can pass `undefined` and the approval / denial
 * counts stay at 0 — the dashboard still surfaces the retrievals
 * half of §3.5.
 */
export function computeMemoryQualityMetrics(
  events: ReadonlyArray<NexusEvent>,
  options: {
    memoryNoteApprovals?: number
    memoryNoteDenials?: number
    memoryNotePendingReviews?: number
  } = {},
): MemoryQualityMetrics {
  const reasonKeys = [
    'aborted',
    'empty_prompt',
    'explicit_memory_cue',
    'current_workspace_only',
    'execution_status_only',
    'permission_response',
    'no_memory_cue',
  ] as const
  const distribution: Record<typeof reasonKeys[number], { triggered: number; skipped: number }> =
    reasonKeys.reduce((acc, key) => {
      acc[key] = { triggered: 0, skipped: 0 }
      return acc
    }, {} as Record<typeof reasonKeys[number], { triggered: number; skipped: number }>)

  let retrievalCount = 0
  let autoSearchTriggeredCount = 0
  let totalHitCount = 0
  let totalInjectedChars = 0
  let retrievalsWithHits = 0
  let truncatedRetrievalCount = 0
  let totalSearchLatencyMs = 0
  let retrievalLatencySampleCount = 0
  let errorRetrievalCount = 0

  for (const event of events) {
    if (event.type === MEMORY_RETRIEVAL_SENTINEL) {
      retrievalCount += 1
      const r = event as Extract<NexusEvent, { type: 'memory_retrieval' }>
      const reasonEntry = distribution[r.autoSearchReason]
      if (reasonEntry) {
        if (r.autoSearchTriggered) {
          reasonEntry.triggered += 1
          autoSearchTriggeredCount += 1
        } else {
          reasonEntry.skipped += 1
        }
      }
      totalHitCount += r.hitCount
      totalInjectedChars += r.injectedChars
      if (r.hitCount > 0) retrievalsWithHits += 1
      if (r.truncated) truncatedRetrievalCount += 1
      if (r.searchLatencyMs !== undefined && Number.isFinite(r.searchLatencyMs)) {
        totalSearchLatencyMs += r.searchLatencyMs
        retrievalLatencySampleCount += 1
      }
      if (r.error && r.error.length > 0) errorRetrievalCount += 1
    }
  }

  return {
    retrievalCount,
    autoSearchTriggeredCount,
    autoSearchReasonDistribution: reasonKeys.map(reason => ({
      reason,
      triggered: distribution[reason].triggered,
      skipped: distribution[reason].skipped,
    })),
    totalHitCount,
    totalInjectedChars,
    retrievalsWithHits,
    truncatedRetrievalCount,
    totalSearchLatencyMs,
    retrievalLatencySampleCount,
    errorRetrievalCount,
    memoryNoteSaveCount: (options.memoryNoteApprovals ?? 0) + (options.memoryNoteDenials ?? 0) + (options.memoryNotePendingReviews ?? 0),
    memoryNoteApprovalCount: options.memoryNoteApprovals ?? 0,
    memoryNoteDenialCount: options.memoryNoteDenials ?? 0,
    memoryNotePendingReviewCount: options.memoryNotePendingReviews ?? 0,
  }
}

/**
 * Convenience: build a `MemoryProviderDiagnostics`-shaped envelope
 * from a `memory_retrieval` event, for callers that want to
 * surface the most-recent retrieval inline in `/context` /
 * `/v1/sessions/:id/context` output.
 */
export function memoryRetrievalToProviderDiagnostics(
  event: Extract<NexusEvent, { type: 'memory_retrieval' }>,
): MemoryProviderDiagnostics {
  return {
    provider: event.provider,
    enabled: event.enabled,
    hitCount: event.hitCount,
    injectedChars: event.injectedChars,
    budgetChars: event.budgetChars,
    maxHitChars: event.maxHitChars,
    truncated: event.truncated,
    scope: event.scope,
    ...(event.namespaceId && { namespaceId: event.namespaceId }),
    ...(event.namespaceSource && { namespaceSource: event.namespaceSource }),
    ...(event.isolationKey && { isolationKey: event.isolationKey }),
    autoSearch: {
      triggered: event.autoSearchTriggered,
      reason: event.autoSearchReason,
      ...(event.autoSearchCue && { cue: event.autoSearchCue }),
    },
    ...(event.searchLatencyMs !== undefined && { searchLatencyMs: event.searchLatencyMs }),
    ...(event.error && { error: event.error }),
  }
}
