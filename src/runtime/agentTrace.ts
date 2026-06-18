/**
 * Agent Trace Schema — pure projection from `NexusEvent[]` to a reconstructable
 * agent trajectory.
 *
 * Source: `docs/nexus/reference/agent-runtime-architecture-maturity-plan.md` §3.1.
 *
 * Design invariants (plan §3.1 v1):
 *  - Derived ONLY from existing `NexusEvent` records. toolTrace / execution_metrics
 *    side tables are already projections of the same event stream, so reading the
 *    event stream is sufficient and avoids a second source of truth.
 *  - Span IDs are deterministic and rebuildable from a replayed event stream
 *    (content-derived, not random).
 *  - Field names are kept exporter-friendly (OpenTelemetry/LangSmith-compatible
 *    shape) but v1 requires no such integration.
 *  - The projector is defensive: unknown event types are skipped, missing
 *    expected events produce a degraded span + a human-readable warning rather
 *    than throwing.
 *
 * The projector is a pure function — no storage, no I/O, no clock. Callers
 * (CLI, tests) supply the ordered event stream.
 */

import type { NexusEvent } from '../shared/events.js'

export const AGENT_TRACE_SCHEMA_VERSION = '2026-06-17.agent-trace.v1'

export type AgentSpanKind =
  | 'run'
  | 'provider_invocation'
  | 'tool_call'
  | 'permission_decision'
  | 'scope_boundary'
  | 'compact_recovery'
  | 'memory_update'
  | 'memory_retrieval'
  | 'sub_agent_handoff'
  | 'final_result'

export type AgentSpanStatus = 'ok' | 'error' | 'degraded' | 'unknown'

export interface AgentSpan {
  spanId: string
  parentSpanId: string | null
  kind: AgentSpanKind
  name: string
  startTimestamp: string
  endTimestamp: string | null
  durationMs: number | null
  status: AgentSpanStatus
  /**
   * Positions in the input events array that fed this span. Stable for a
   * given event ordering, so a replayed stream reproduces identical
   * provenance. Used as the deterministic basis for span IDs that have no
   * natural identifier (execution_metrics, compact, memory events).
   */
  sourceEventIndices: number[]
  sourceEventTypes: string[]
  toolUseId?: string
  requestId?: string
  jobId?: string
  attributes: Record<string, unknown>
}

export interface AgentTrace {
  schemaVersion: string
  sessionId: string | null
  runSpanId: string | null
  spans: AgentSpan[]
  derivedFrom: 'events'
  warnings: string[]
  spanCountByKind: Record<AgentSpanKind, number>
}

const RUN_SPAN_ID = 'run'
const FINAL_RESULT_SPAN_ID = 'result'

const EMPTY_COUNTS: Record<AgentSpanKind, number> = {
  run: 0,
  provider_invocation: 0,
  tool_call: 0,
  permission_decision: 0,
  scope_boundary: 0,
  compact_recovery: 0,
  memory_update: 0,
  memory_retrieval: 0,
  sub_agent_handoff: 0,
  final_result: 0,
}

/**
 * Project an ordered event stream into an `AgentTrace`.
 *
 * Events should be in chronological order (as produced by storage
 * `listEvents({ order: 'asc' })`). The projector does not re-sort by time
 * except to pin the run span first in output; it relies on the caller's
 * ordering for span provenance indices.
 */
export function projectAgentTrace(events: ReadonlyArray<NexusEvent>): AgentTrace {
  const warnings: string[] = []
  const spans: AgentSpan[] = []
  const sessionId = events.length > 0 ? (events[0]!.sessionId ?? null) : null

  // --- run span (root) ---------------------------------------------------
  const sessionStartedIndex = events.findIndex(e => e.type === 'session_started')
  const terminalIndex = events.findIndex(e => e.type === 'result' || e.type === 'error')
  const hasSessionStarted = sessionStartedIndex >= 0
  const hasTerminal = terminalIndex >= 0

  const runStartIndex = hasSessionStarted ? sessionStartedIndex : 0
  const runEndIndex = hasTerminal ? terminalIndex : events.length - 1
  const runStartEvent = events[runStartIndex]
  const runEndEvent = events[runEndIndex]

  if (events.length === 0) {
    warnings.push('no events in stream; trace is empty')
  } else {
    if (!hasSessionStarted) {
      warnings.push('no session_started event; run span synthesized from first event')
    }
    if (!hasTerminal) {
      warnings.push('no terminal result/error event; run span end inferred from last event')
    }
  }

  // Phase B of docs/nexus/reference/context-cwd-drift-and-recall-governance-plan.md:
  // capture the most-recent `session_root_continuity` event (if any)
  // as a run-level attribute. The continuity event documents why the
  // runtime kept / switched cwd; surfacing it on the run span lets
  // `bbl inspect-session <id> --trace` show the operator the decision
  // + reason without parsing the raw event stream. The
  // `session_root_continuity` event itself is also still in the
  // `events` projection (see `exportSessionTrace` for raw access).
  const continuityEvent = [...events].reverse().find(e => e.type === 'session_root_continuity') as
    | (NexusEvent & { type: 'session_root_continuity' })
    | undefined

  let runSpan: AgentSpan | null = null
  if (events.length > 0) {
    const terminalEvent = hasTerminal ? events[terminalIndex] : null
    const runStatus: AgentSpanStatus = terminalEvent
      ? terminalEvent.type === 'error'
        ? 'error'
        : terminalEvent.type === 'result'
          ? (terminalEvent as { success?: boolean }).success
            ? 'ok'
            : 'error'
          : 'unknown'
      : 'degraded'
    runSpan = {
      spanId: RUN_SPAN_ID,
      parentSpanId: null,
      kind: 'run',
      name: hasSessionStarted
        ? `run ${(events[sessionStartedIndex] as { cwd?: string }).cwd ?? ''}`.trim()
        : 'run (synthesized)',
      startTimestamp: runStartEvent!.timestamp,
      endTimestamp: runEndEvent ? runEndEvent.timestamp : null,
      durationMs: runEndEvent ? durationMsBetween(runStartEvent!.timestamp, runEndEvent.timestamp) : null,
      status: runStatus,
      sourceEventIndices: hasSessionStarted ? [sessionStartedIndex] : [0],
      sourceEventTypes: hasSessionStarted ? ['session_started'] : [runStartEvent!.type],
      ...(hasSessionStarted && (events[sessionStartedIndex] as { requestId?: string }).requestId
        ? { requestId: (events[sessionStartedIndex] as { requestId?: string }).requestId }
        : {}),
      attributes: {
        ...(hasSessionStarted
          ? {
              cwd: (events[sessionStartedIndex] as { cwd?: string }).cwd,
              model: (events[sessionStartedIndex] as { model?: string }).model,
              budget: (events[sessionStartedIndex] as { budget?: number }).budget,
            }
          : {}),
        eventCount: events.length,
        terminalOutcome: terminalEvent ? terminalEvent.type : 'none',
        // Phase B: surface the latest continuity decision so the
        // trace is self-describing. `lastContinuityReason` mirrors
        // `lastContinuityDecision` for grep-ability.
        ...(continuityEvent
          ? {
              lastContinuityDecision: continuityEvent.decision,
              lastContinuityReason: continuityEvent.reason,
              lastContinuityResolvedCwd: continuityEvent.resolvedCwd,
              lastContinuityWasProjectRootKept: continuityEvent.wasProjectRootKept,
              lastContinuityIsExternalRoot: continuityEvent.isExternalRoot,
              lastContinuityMessage: continuityEvent.message,
            }
          : {}),
      },
    }
    spans.push(runSpan)
  }

  // --- tool_call spans (indexed by toolUseId) ----------------------------
  // Built first so permission/scope spans can parent to them.
  const toolSpanByUseId = new Map<string, AgentSpan>()
  const openToolStarts = new Map<string, { event: NexusEvent; index: number }>()
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i]!
    if (event.type === 'tool_started') {
      const started = event as Extract<NexusEvent, { type: 'tool_started' }>
      openToolStarts.set(started.toolUseId, { event: started, index: i })
    } else if (event.type === 'tool_completed') {
      const completed = event as Extract<NexusEvent, { type: 'tool_completed' }>
      const open = openToolStarts.get(completed.toolUseId)
      const startIndex = open?.index ?? i
      const startEvent = open?.event ?? completed
      const span: AgentSpan = {
        spanId: `tool:${completed.toolUseId}`,
        parentSpanId: RUN_SPAN_ID,
        kind: 'tool_call',
        name: completed.name,
        startTimestamp: startEvent.timestamp,
        endTimestamp: completed.timestamp,
        durationMs: durationMsBetween(startEvent.timestamp, completed.timestamp),
        status: completed.success ? 'ok' : 'error',
        sourceEventIndices: open ? [open.index, i] : [i],
        sourceEventTypes: open ? ['tool_started', 'tool_completed'] : ['tool_completed'],
        toolUseId: completed.toolUseId,
        attributes: {
          toolName: completed.name,
          success: completed.success,
          truncated: completed.truncated,
          originalBytes: completed.originalBytes,
          remoteRunner: completed.remoteRunner,
          ...(extractToolPathAttr(open?.event) ?? {}),
        },
      }
      toolSpanByUseId.set(completed.toolUseId, span)
      spans.push(span)
      openToolStarts.delete(completed.toolUseId)
    } else if (event.type === 'tool_denied') {
      const denied = event as Extract<NexusEvent, { type: 'tool_denied' }>
      // tool_denied has no toolUseId; close any single open tool_started if
      // exactly one is pending (best-effort attribution). Otherwise emit a
      // standalone degraded tool_call span.
      let attributedUseId: string | undefined
      if (openToolStarts.size === 1) {
        attributedUseId = openToolStarts.keys().next().value
      }
      const startIndex = attributedUseId ? openToolStarts.get(attributedUseId)!.index : i
      const startEvent = attributedUseId ? openToolStarts.get(attributedUseId)!.event : denied
      const span: AgentSpan = {
        spanId: attributedUseId ? `tool:${attributedUseId}` : `tool:denied:${i}`,
        parentSpanId: RUN_SPAN_ID,
        kind: 'tool_call',
        name: denied.name,
        startTimestamp: startEvent.timestamp,
        endTimestamp: denied.timestamp,
        durationMs: durationMsBetween(startEvent.timestamp, denied.timestamp),
        status: 'error',
        sourceEventIndices: attributedUseId ? [startIndex, i] : [i],
        sourceEventTypes: attributedUseId ? ['tool_started', 'tool_denied'] : ['tool_denied'],
        ...(attributedUseId ? { toolUseId: attributedUseId } : {}),
        attributes: {
          toolName: denied.name,
          risk: denied.risk,
          denialKind: denied.denialKind,
          recoverable: denied.recoverable,
          terminal: denied.terminal,
          message: denied.message,
          ...(extractToolPathAttr(attributedUseId ? openToolStarts.get(attributedUseId)!.event : undefined) ?? {}),
        },
      }
      if (attributedUseId) {
        toolSpanByUseId.set(attributedUseId, span)
        openToolStarts.delete(attributedUseId)
      }
      spans.push(span)
    }
  }
  // Orphan tool_started (never completed/denied) → degraded span + warning.
  for (const [toolUseId, { event, index }] of openToolStarts) {
    const started = event as Extract<NexusEvent, { type: 'tool_started' }>
    warnings.push(`tool_started without matching tool_completed/tool_denied (toolUseId=${toolUseId})`)
    const span: AgentSpan = {
      spanId: `tool:${toolUseId}`,
      parentSpanId: RUN_SPAN_ID,
      kind: 'tool_call',
      name: started.name,
      startTimestamp: started.timestamp,
      endTimestamp: null,
      durationMs: null,
      status: 'degraded',
      sourceEventIndices: [index],
      sourceEventTypes: ['tool_started'],
      toolUseId,
      attributes: { toolName: started.name, effectiveRisk: started.effectiveRisk, ...(extractToolPathAttr(event) ?? {}) },
    }
    toolSpanByUseId.set(toolUseId, span)
    spans.push(span)
  }

  // --- provider_invocation spans ----------------------------------------
  const executionMetricsIndices: number[] = []
  for (let i = 0; i < events.length; i += 1) {
    if (events[i]!.type === 'execution_metrics') executionMetricsIndices.push(i)
  }
  const hasStreamDeltas = events.some(e => e.type === 'assistant_delta' || e.type === 'thinking_delta')

  if (executionMetricsIndices.length > 0) {
    for (const i of executionMetricsIndices) {
      const m = events[i] as Extract<NexusEvent, { type: 'execution_metrics' }>
      const span: AgentSpan = {
        spanId: `provider:${i}`,
        parentSpanId: RUN_SPAN_ID,
        kind: 'provider_invocation',
        name: 'provider invocation',
        startTimestamp: m.timestamp,
        endTimestamp: m.timestamp,
        durationMs: m.providerRequestDurationMs ?? m.executeDurationMs ?? null,
        status: 'ok',
        sourceEventIndices: [i],
        sourceEventTypes: ['execution_metrics'],
        ...(m.requestId ? { requestId: m.requestId } : {}),
        attributes: {
          inputTokens: m.inputTokens,
          outputTokens: m.outputTokens,
          cacheCreationInputTokens: m.cacheCreationInputTokens,
          cacheReadInputTokens: m.cacheReadInputTokens,
          providerFirstTokenMs: m.providerFirstTokenMs,
          streamDeltaCount: m.streamDeltaCount,
          toolCallCount: m.toolCallCount,
          cacheReadRatio: m.cacheReadRatio,
        },
      }
      spans.push(span)
    }
  } else if (hasStreamDeltas) {
    warnings.push('stream deltas present but no execution_metrics; provider_invocation spans synthesized from delta bursts (degraded)')
    // Synthesize one provider span per maximal burst of consecutive deltas.
    let burstStart: { index: number; ts: string } | null = null
    let burstEnd: { index: number; ts: string } | null = null
    const flushBurst = () => {
      if (!burstStart || !burstEnd) return
      const span: AgentSpan = {
        spanId: `provider:burst:${burstStart.index}`,
        parentSpanId: RUN_SPAN_ID,
        kind: 'provider_invocation',
        name: 'provider invocation (synthesized)',
        startTimestamp: burstStart.ts,
        endTimestamp: burstEnd.ts,
        durationMs: durationMsBetween(burstStart.ts, burstEnd.ts),
        status: 'degraded',
        sourceEventIndices: [burstStart.index, burstEnd.index],
        sourceEventTypes: ['stream_delta_burst'],
        attributes: { synthesized: true },
      }
      spans.push(span)
      burstStart = null
      burstEnd = null
    }
    for (let i = 0; i < events.length; i += 1) {
      const event = events[i]!
      if (event.type === 'assistant_delta' || event.type === 'thinking_delta') {
        if (!burstStart) burstStart = { index: i, ts: event.timestamp }
        burstEnd = { index: i, ts: event.timestamp }
      } else {
        flushBurst()
      }
    }
    flushBurst()
  }

  // --- permission_decision spans ----------------------------------------
  const openPermissionRequests = new Map<string, { event: NexusEvent; index: number }>()
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i]!
    if (event.type === 'permission_request') {
      const req = event as Extract<NexusEvent, { type: 'permission_request' }>
      openPermissionRequests.set(req.toolUseId, { event: req, index: i })
    } else if (event.type === 'permission_response') {
      const resp = event as Extract<NexusEvent, { type: 'permission_response' }>
      const open = openPermissionRequests.get(resp.toolUseId)
      const startIndex = open?.index ?? i
      const startEvent = open?.event ?? resp
      const parentSpanId = toolSpanByUseId.has(resp.toolUseId)
        ? `tool:${resp.toolUseId}`
        : RUN_SPAN_ID
      const span: AgentSpan = {
        spanId: `perm:${resp.toolUseId}`,
        parentSpanId,
        kind: 'permission_decision',
        name: `permission ${resp.approved ? 'approved' : 'denied'}`,
        startTimestamp: startEvent.timestamp,
        endTimestamp: resp.timestamp,
        durationMs: durationMsBetween(startEvent.timestamp, resp.timestamp),
        status: resp.approved ? 'ok' : 'error',
        sourceEventIndices: open ? [open.index, i] : [i],
        sourceEventTypes: open ? ['permission_request', 'permission_response'] : ['permission_response'],
        toolUseId: resp.toolUseId,
        attributes: {
          approved: resp.approved,
          scope: resp.scope,
          rule: resp.rule,
          feedback: resp.feedback,
          reason: resp.reason,
        },
      }
      spans.push(span)
      openPermissionRequests.delete(resp.toolUseId)
    }
  }
  for (const [toolUseId, { event, index }] of openPermissionRequests) {
    const req = event as Extract<NexusEvent, { type: 'permission_request' }>
    warnings.push(`permission_request without matching permission_response (toolUseId=${toolUseId})`)
    const parentSpanId = toolSpanByUseId.has(toolUseId) ? `tool:${toolUseId}` : RUN_SPAN_ID
    spans.push({
      spanId: `perm:${toolUseId}`,
      parentSpanId,
      kind: 'permission_decision',
      name: 'permission (awaiting response)',
      startTimestamp: req.timestamp,
      endTimestamp: null,
      durationMs: null,
      status: 'degraded',
      sourceEventIndices: [index],
      sourceEventTypes: ['permission_request'],
      toolUseId,
      attributes: { risk: req.risk, scopeRisk: req.scopeRisk, suggestedRule: req.suggestedRule },
    })
  }

  // --- scope_boundary spans ---------------------------------------------
  const confirmedByTargetRoot = new Map<string, NexusEvent>()
  for (const event of events) {
    if (event.type === 'scope_boundary_confirmed') {
      const c = event as Extract<NexusEvent, { type: 'scope_boundary_confirmed' }>
      confirmedByTargetRoot.set(c.targetRoot, c)
    }
  }
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i]!
    if (event.type !== 'scope_boundary_detected') continue
    const det = event as Extract<NexusEvent, { type: 'scope_boundary_detected' }>
    const confirmed = confirmedByTargetRoot.get(det.targetRoot)
    const parentSpanId = toolSpanByUseId.has(det.toolUseId) ? `tool:${det.toolUseId}` : RUN_SPAN_ID
    const sourceIndices = confirmed ? [i, events.indexOf(confirmed)] : [i]
    const sourceTypes = confirmed ? ['scope_boundary_detected', 'scope_boundary_confirmed'] : ['scope_boundary_detected']
    spans.push({
      spanId: `scope:${det.toolUseId}:${i}`,
      parentSpanId,
      kind: 'scope_boundary',
      name: `scope boundary: ${det.boundaryKind}`,
      startTimestamp: det.timestamp,
      endTimestamp: confirmed ? confirmed.timestamp : det.timestamp,
      durationMs: confirmed ? durationMsBetween(det.timestamp, confirmed.timestamp) : null,
      status: det.action === 'deny' ? 'error' : 'ok',
      sourceEventIndices: sourceIndices,
      sourceEventTypes: sourceTypes,
      toolUseId: det.toolUseId,
      ...(det.requestId ? { requestId: det.requestId } : {}),
      attributes: {
        boundaryKind: det.boundaryKind,
        action: det.action,
        scopeRisk: det.scopeRisk,
        targetRoot: det.targetRoot,
        taskPrimaryRoot: det.taskPrimaryRoot,
        confirmedBy: confirmed ? (confirmed as Extract<NexusEvent, { type: 'scope_boundary_confirmed' }>).confirmedBy : null,
        confirmationScope: confirmed ? (confirmed as Extract<NexusEvent, { type: 'scope_boundary_confirmed' }>).confirmationScope : null,
      },
    })
  }

  // --- compact_recovery spans -------------------------------------------
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i]!
    if (
      event.type !== 'compact_boundary' &&
      event.type !== 'context_compact_boundary' &&
      event.type !== 'compact_failure' &&
      event.type !== 'context_recovery_attempted'
    ) {
      continue
    }
    const e = event as NexusEvent & { trigger?: string; message?: string }
    const detail = compactDetail(event)
    spans.push({
      spanId: `compact:${i}`,
      parentSpanId: RUN_SPAN_ID,
      kind: 'compact_recovery',
      name: `compact/recovery: ${event.type}`,
      startTimestamp: event.timestamp,
      endTimestamp: event.timestamp,
      durationMs: null,
      status: event.type === 'compact_failure' ? 'error' : 'ok',
      sourceEventIndices: [i],
      sourceEventTypes: [event.type],
      attributes: { trigger: e.trigger, ...detail },
    })
  }

  // --- memory_update spans (session-memory-lite) -----------------------
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i]!
    if (event.type !== 'session_memory_updated') continue
    const m = event as Extract<NexusEvent, { type: 'session_memory_updated' }>
    spans.push({
      spanId: `memory:${i}`,
      parentSpanId: RUN_SPAN_ID,
      kind: 'memory_update',
      name: `memory update: ${m.trigger}`,
      startTimestamp: m.timestamp,
      endTimestamp: m.timestamp,
      durationMs: null,
      status: 'ok',
      sourceEventIndices: [i],
      sourceEventTypes: ['session_memory_updated'],
      attributes: {
        trigger: m.trigger,
        summaryChars: m.summaryChars,
        eventCount: m.eventCount,
        reason: m.reason,
        decisionReason: m.decisionReason,
      },
    })
  }

  // --- memory_retrieval spans (long-term MemoryOS / EverCore) ----------
  // §3.5 of `docs/nexus/reference/agent-runtime-architecture-maturity-plan.md`:
  // each retrieval (including auto-search *skips*) becomes a span so the
  // trace and `/v1/runtime/memory/status` dashboard can answer
  // "was long-term memory consulted, why, and what came back?" per
  // turn. Skips surface as `status: 'ok'` with `hitCount: 0`; transport
  // errors surface as `status: 'error'`.
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i]!
    if (event.type !== 'memory_retrieval') continue
    const r = event as Extract<NexusEvent, { type: 'memory_retrieval' }>
    const status: AgentSpan['status'] = r.error ? 'error' : 'ok'
    const nameSuffix = r.autoSearchTriggered
      ? `${r.hitCount} hit${r.hitCount === 1 ? '' : 's'}`
      : `skipped (${r.autoSearchReason})`
    spans.push({
      spanId: `memory_retrieval:${i}`,
      parentSpanId: RUN_SPAN_ID,
      kind: 'memory_retrieval',
      name: `memory retrieval: ${nameSuffix}`,
      startTimestamp: r.timestamp,
      endTimestamp: r.timestamp,
      durationMs: r.searchLatencyMs ?? null,
      status,
      sourceEventIndices: [i],
      sourceEventTypes: ['memory_retrieval'],
      attributes: {
        provider: r.provider,
        enabled: r.enabled,
        scope: r.scope,
        namespaceId: r.namespaceId,
        namespaceSource: r.namespaceSource,
        isolationKey: r.isolationKey,
        autoSearchTriggered: r.autoSearchTriggered,
        autoSearchReason: r.autoSearchReason,
        autoSearchCue: r.autoSearchCue,
        hitCount: r.hitCount,
        injectedChars: r.injectedChars,
        budgetChars: r.budgetChars,
        maxHitChars: r.maxHitChars,
        truncated: r.truncated,
        searchLatencyMs: r.searchLatencyMs,
        error: r.error,
      },
    })
  }

  // --- sub_agent_handoff spans (grouped by jobId) -----------------------
  const agentJobEventsByJob = new Map<string, { indices: number[]; events: NexusEvent[] }>()
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i]!
    if (event.type !== 'agent_job_event') continue
    const je = event as Extract<NexusEvent, { type: 'agent_job_event' }>
    if (!agentJobEventsByJob.has(je.jobId)) {
      agentJobEventsByJob.set(je.jobId, { indices: [], events: [] })
    }
    const bucket = agentJobEventsByJob.get(je.jobId)!
    bucket.indices.push(i)
    bucket.events.push(je)
  }
  for (const [jobId, { indices, events: jobEvents }] of agentJobEventsByJob) {
    const first = jobEvents[0] as Extract<NexusEvent, { type: 'agent_job_event' }>
    const last = jobEvents[jobEvents.length - 1] as Extract<NexusEvent, { type: 'agent_job_event' }>
    const failed = jobEvents.some(e => (e as Extract<NexusEvent, { type: 'agent_job_event' }>).eventType === 'agent_job_failed')
    const cancelled = jobEvents.some(e => (e as Extract<NexusEvent, { type: 'agent_job_event' }>).eventType === 'agent_job_cancelled')
    const completed = jobEvents.some(e => (e as Extract<NexusEvent, { type: 'agent_job_event' }>).eventType === 'agent_job_completed')
    const status: AgentSpanStatus = failed ? 'error' : cancelled ? 'unknown' : completed ? 'ok' : 'degraded'
    spans.push({
      spanId: `agent:${jobId}`,
      parentSpanId: RUN_SPAN_ID,
      kind: 'sub_agent_handoff',
      name: `sub-agent: ${first.agentType}`,
      startTimestamp: first.timestamp,
      endTimestamp: last.timestamp,
      durationMs: durationMsBetween(first.timestamp, last.timestamp),
      status,
      sourceEventIndices: indices,
      sourceEventTypes: jobEvents.map(e => e.type),
      jobId,
      attributes: {
        agentType: first.agentType,
        contextForkMode: first.contextForkMode,
        childSessionId: first.childSessionId,
        finalStatus: last.status,
        eventTypes: jobEvents.map(e => (e as Extract<NexusEvent, { type: 'agent_job_event' }>).eventType),
      },
    })
  }

  // --- final_result span -------------------------------------------------
  if (hasTerminal) {
    const terminal = events[terminalIndex]!
    const isError = terminal.type === 'error'
    spans.push({
      spanId: FINAL_RESULT_SPAN_ID,
      parentSpanId: RUN_SPAN_ID,
      kind: 'final_result',
      name: isError ? 'final result: error' : 'final result',
      startTimestamp: terminal.timestamp,
      endTimestamp: terminal.timestamp,
      durationMs: null,
      status: isError ? 'error' : (terminal as { success?: boolean }).success ? 'ok' : 'error',
      sourceEventIndices: [terminalIndex],
      sourceEventTypes: [terminal.type],
      attributes: isError
        ? { code: (terminal as Extract<NexusEvent, { type: 'error' }>).code, message: (terminal as Extract<NexusEvent, { type: 'error' }>).message }
        : { success: (terminal as Extract<NexusEvent, { type: 'result' }>).success, message: (terminal as Extract<NexusEvent, { type: 'result' }>).message },
    })
  }

  // --- output ordering: run first, then by startTimestamp ---------------
  const sortedSpans = spans.slice().sort((a, b) => {
    if (a.kind === 'run' && b.kind !== 'run') return -1
    if (b.kind === 'run' && a.kind !== 'run') return 1
    if (a.startTimestamp < b.startTimestamp) return -1
    if (a.startTimestamp > b.startTimestamp) return 1
    return 0
  })

  const spanCountByKind = { ...EMPTY_COUNTS }
  for (const span of sortedSpans) spanCountByKind[span.kind] += 1

  return {
    schemaVersion: AGENT_TRACE_SCHEMA_VERSION,
    sessionId,
    runSpanId: runSpan ? RUN_SPAN_ID : null,
    spans: sortedSpans,
    derivedFrom: 'events',
    warnings,
    spanCountByKind,
  }
}

function durationMsBetween(startIso: string, endIso: string): number | null {
  const start = Date.parse(startIso)
  const end = Date.parse(endIso)
  if (Number.isNaN(start) || Number.isNaN(end)) return null
  const ms = end - start
  return ms >= 0 ? ms : null
}

/**
 * Best-effort extraction of a `path` attribute for path-bearing tools
 * (Read/Edit/Write/Grep/Glob/ListDir). The `tool_started` event carries the
 * input; `tool_completed`/`tool_denied` do not, so callers pass the started
 * event when available. Returns `{ path }` to spread into span attributes, or
 * `undefined` when no usable path is present. Keeps the trace self-contained so
 * checks (e.g. repeated-read detection) can work purely over the trace.
 */
function extractToolPathAttr(startedEvent: NexusEvent | undefined): { path: string } | undefined {
  if (!startedEvent || startedEvent.type !== 'tool_started') return undefined
  const input = (startedEvent as Extract<NexusEvent, { type: 'tool_started' }>).input
  if (!input || typeof input !== 'object') return undefined
  const path = (input as { path?: unknown }).path
  if (typeof path === 'string' && path.length > 0) return { path }
  return undefined
}


function compactDetail(event: NexusEvent): Record<string, unknown> {
  switch (event.type) {
    case 'compact_boundary': {
      const e = event as Extract<NexusEvent, { type: 'compact_boundary' }>
      return {
        beforeEventCount: e.beforeEventCount,
        afterEventCount: e.afterEventCount,
        summaryChars: e.summaryChars,
        snippedToolResults: e.snippedToolResults,
        preTokens: e.preTokens,
        postTokens: e.postTokens,
      }
    }
    case 'context_compact_boundary': {
      const e = event as Extract<NexusEvent, { type: 'context_compact_boundary' }>
      return {
        boundaryId: e.boundaryId,
        beforeEventCount: e.beforeEventCount,
        afterEventCount: e.afterEventCount,
        summaryChars: e.summaryChars,
        retainedEventCount: e.retainedEventCount,
      }
    }
    case 'compact_failure': {
      const e = event as Extract<NexusEvent, { type: 'compact_failure' }>
      return { failureCount: e.failureCount, maxFailures: e.maxFailures }
    }
    case 'context_recovery_attempted': {
      const e = event as Extract<NexusEvent, { type: 'context_recovery_attempted' }>
      return {
        providerErrorCode: e.providerErrorCode,
        strategy: e.strategy,
        attempt: e.attempt,
        maxAttempts: e.maxAttempts,
      }
    }
    default:
      return {}
  }
}

/**
 * Serialize a trace as JSONL: one header record (`{ record: 'trace', ... }`)
 * followed by one span record per line (`{ record: 'span', ... }`).
 * Rebuildable line-by-line; suitable for append-only export.
 */
export function traceToJsonl(trace: AgentTrace): string {
  const lines: string[] = []
  const { spans, ...header } = trace
  lines.push(JSON.stringify({ record: 'trace' as const, ...header }))
  for (const span of spans) {
    lines.push(JSON.stringify({ record: 'span' as const, ...span }))
  }
  return lines.join('\n')
}

/** Serialize a trace as a single pretty-printed JSON blob. */
export function traceToJson(trace: AgentTrace): string {
  return JSON.stringify(trace, null, 2)
}
