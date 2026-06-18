import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  computeMemoryQualityMetrics,
  memoryRetrievalToProviderDiagnostics,
} from '../src/runtime/memoryMetrics.js'
import { NEXUS_EVENT_SCHEMA_VERSION, type NexusEvent } from '../src/shared/events.js'

/**
 * §3.5 of `docs/nexus/reference/agent-runtime-architecture-maturity-plan.md`:
 * Memory Quality Metrics — v1 ships four of the seven plan metrics:
 *  - auto-search triggered / skipped reason distribution,
 *  - hit count / injected chars / truncation rate,
 *  - memory write approval rate,
 *  - memory write denial rate.
 *
 * The pure projector `computeMemoryQualityMetrics` mirrors
 * `projectAgentTrace` / `deriveResumableState` — no storage, no
 * clock, no side effects. The dashboard at
 * `/v1/runtime/memory/status` calls it on a recent window of
 * `memory_retrieval` events; the eval harness calls it on a full
 * session trace.
 */

const V = NEXUS_EVENT_SCHEMA_VERSION
const BASE = Date.parse('2026-06-18T10:00:00.000Z')
const SID = 'session-mem-metrics-test'

function ts(offsetMs: number): string {
  return new Date(BASE + offsetMs).toISOString()
}

function retrieval(partial: {
  timestamp?: string
  autoSearchTriggered?: boolean
  autoSearchReason?: 'aborted' | 'empty_prompt' | 'explicit_memory_cue' | 'current_workspace_only' | 'execution_status_only' | 'permission_response' | 'no_memory_cue'
  autoSearchCue?: string
  hitCount?: number
  injectedChars?: number
  truncated?: boolean
  searchLatencyMs?: number
  error?: string
} = {}): NexusEvent {
  return {
    schemaVersion: V,
    sessionId: SID,
    type: 'memory_retrieval',
    timestamp: partial.timestamp ?? ts(0),
    provider: 'evercore',
    enabled: true,
    scope: 'project',
    namespaceId: 'demo',
    namespaceSource: 'workspace',
    isolationKey: 'projectId',
    autoSearchTriggered: partial.autoSearchTriggered ?? false,
    autoSearchReason: partial.autoSearchReason ?? 'no_memory_cue',
    ...(partial.autoSearchCue && { autoSearchCue: partial.autoSearchCue }),
    hitCount: partial.hitCount ?? 0,
    injectedChars: partial.injectedChars ?? 0,
    budgetChars: 4_000,
    maxHitChars: 800,
    truncated: partial.truncated ?? false,
    ...(partial.searchLatencyMs !== undefined && { searchLatencyMs: partial.searchLatencyMs }),
    ...(partial.error && { error: partial.error }),
  } as unknown as NexusEvent
}

function sessionStarted(offsetMs: number): NexusEvent {
  return { schemaVersion: V, sessionId: SID, type: 'session_started', timestamp: ts(offsetMs), cwd: '/repo' } as unknown as NexusEvent
}

describe('computeMemoryQualityMetrics: empty + non-memory streams', () => {
  test('empty event stream returns all zeros (dashboard renders "no data")', () => {
    const m = computeMemoryQualityMetrics([])
    assert.equal(m.retrievalCount, 0)
    assert.equal(m.autoSearchTriggeredCount, 0)
    assert.equal(m.totalHitCount, 0)
    assert.equal(m.truncatedRetrievalCount, 0)
    assert.equal(m.errorRetrievalCount, 0)
    assert.equal(m.memoryNoteApprovalCount, 0)
    assert.equal(m.memoryNoteDenialCount, 0)
    assert.equal(m.autoSearchReasonDistribution.length, 7)
    // every reason has zero on both triggered and skipped
    for (const entry of m.autoSearchReasonDistribution) {
      assert.equal(entry.triggered, 0)
      assert.equal(entry.skipped, 0)
    }
  })

  test('stream with no memory_retrieval events returns all zeros', () => {
    const events: NexusEvent[] = [sessionStarted(0)]
    const m = computeMemoryQualityMetrics(events)
    assert.equal(m.retrievalCount, 0)
    assert.equal(m.totalHitCount, 0)
  })
})

describe('computeMemoryQualityMetrics: auto-search reason distribution', () => {
  test('explicit_memory_cue → triggered; no_memory_cue / execution_status_only / current_workspace_only → skipped', () => {
    const events: NexusEvent[] = [
      retrieval({ autoSearchTriggered: true, autoSearchReason: 'explicit_memory_cue', autoSearchCue: 'remember', hitCount: 3, injectedChars: 240 }),
      retrieval({ autoSearchTriggered: false, autoSearchReason: 'no_memory_cue' }),
      retrieval({ autoSearchTriggered: false, autoSearchReason: 'execution_status_only' }),
      retrieval({ autoSearchTriggered: false, autoSearchReason: 'current_workspace_only' }),
    ]
    const m = computeMemoryQualityMetrics(events)
    assert.equal(m.retrievalCount, 4)
    assert.equal(m.autoSearchTriggeredCount, 1)
    const byReason = Object.fromEntries(m.autoSearchReasonDistribution.map(e => [e.reason, e]))
    assert.equal(byReason.explicit_memory_cue.triggered, 1)
    assert.equal(byReason.explicit_memory_cue.skipped, 0)
    assert.equal(byReason.no_memory_cue.triggered, 0)
    assert.equal(byReason.no_memory_cue.skipped, 1)
    assert.equal(byReason.execution_status_only.triggered, 0)
    assert.equal(byReason.execution_status_only.skipped, 1)
    assert.equal(byReason.current_workspace_only.triggered, 0)
    assert.equal(byReason.current_workspace_only.skipped, 1)
  })

  test('every reason slot is present in the distribution (stable shape for dashboards)', () => {
    const m = computeMemoryQualityMetrics([])
    const reasons = m.autoSearchReasonDistribution.map(e => e.reason)
    assert.deepEqual(reasons, [
      'aborted', 'empty_prompt', 'explicit_memory_cue',
      'current_workspace_only', 'execution_status_only',
      'permission_response', 'no_memory_cue',
    ])
  })
})

describe('computeMemoryQualityMetrics: hit / inject / truncation / latency', () => {
  test('sums hitCount, injectedChars, truncations, and latency across retrievals', () => {
    const events: NexusEvent[] = [
      retrieval({ hitCount: 2, injectedChars: 800, truncated: false, searchLatencyMs: 12 }),
      retrieval({ hitCount: 5, injectedChars: 2400, truncated: true, searchLatencyMs: 8 }),
      retrieval({ hitCount: 0, injectedChars: 0, truncated: false, searchLatencyMs: 6 }),
    ]
    const m = computeMemoryQualityMetrics(events)
    assert.equal(m.totalHitCount, 7)
    assert.equal(m.totalInjectedChars, 3200)
    assert.equal(m.retrievalsWithHits, 2)
    assert.equal(m.truncatedRetrievalCount, 1)
    assert.equal(m.totalSearchLatencyMs, 26)
    assert.equal(m.retrievalLatencySampleCount, 3)
  })

  test('counts error retrievals separately from healthy ones', () => {
    const events: NexusEvent[] = [
      retrieval({ error: 'evercore unreachable' }),
      retrieval({ hitCount: 1 }),
    ]
    const m = computeMemoryQualityMetrics(events)
    assert.equal(m.errorRetrievalCount, 1)
    assert.equal(m.retrievalCount, 2)
  })
})

describe('computeMemoryQualityMetrics: save / deny counters', () => {
  test('approvals and denials come from caller options (route counters, not events)', () => {
    const events: NexusEvent[] = [retrieval({ hitCount: 1 })]
    const m = computeMemoryQualityMetrics(events, {
      memoryNoteApprovals: 4,
      memoryNoteDenials: 1,
      memoryNotePendingReviews: 2,
    })
    assert.equal(m.memoryNoteApprovalCount, 4)
    assert.equal(m.memoryNoteDenialCount, 1)
    assert.equal(m.memoryNotePendingReviewCount, 2)
    // saveCount is the sum of all three recent-window vote outcomes
    assert.equal(m.memoryNoteSaveCount, 7)
  })

  test('zero approvals / denials when caller has no counters', () => {
    const m = computeMemoryQualityMetrics([retrieval()])
    assert.equal(m.memoryNoteApprovalCount, 0)
    assert.equal(m.memoryNoteDenialCount, 0)
    assert.equal(m.memoryNotePendingReviewCount, 0)
    assert.equal(m.memoryNoteSaveCount, 0)
  })
})

describe('memoryRetrievalToProviderDiagnostics: shape compatibility', () => {
  test('reconstructs a MemoryProviderDiagnostics-compatible envelope from a memory_retrieval event', () => {
    const event = retrieval({
      autoSearchTriggered: true,
      autoSearchReason: 'explicit_memory_cue',
      autoSearchCue: '记得',
      hitCount: 2,
      injectedChars: 480,
      truncated: true,
      searchLatencyMs: 9,
    })
    const diag = memoryRetrievalToProviderDiagnostics(event as Extract<NexusEvent, { type: 'memory_retrieval' }>)
    assert.equal(diag.provider, 'evercore')
    assert.equal(diag.enabled, true)
    assert.equal(diag.hitCount, 2)
    assert.equal(diag.injectedChars, 480)
    assert.equal(diag.truncated, true)
    assert.equal(diag.searchLatencyMs, 9)
    assert.deepEqual(diag.autoSearch, { triggered: true, reason: 'explicit_memory_cue', cue: '记得' })
  })

  test('omits optional fields when the event does not set them', () => {
    const event = retrieval()
    const diag = memoryRetrievalToProviderDiagnostics(event as Extract<NexusEvent, { type: 'memory_retrieval' }>)
    assert.equal(diag.error, undefined)
    assert.equal(diag.searchLatencyMs, undefined)
    assert.equal(diag.autoSearch?.cue, undefined)
  })
})
