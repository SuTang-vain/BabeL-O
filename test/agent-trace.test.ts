// test/agent-trace.test.ts
//
// Agent Trace Schema unit tests (agent-runtime-architecture-maturity-plan.md §3.1).
// Covers: span ordering, parent-child linkage, degraded behavior when events
// are missing, permission-denied path, all required span kinds, deterministic
// span IDs, and JSONL round-trip shape.
//
// The projector is a pure function over NexusEvent[] — no storage, no clock.
// Tests build synthetic event streams directly.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  projectAgentTrace,
  traceToJsonl,
  traceToJson,
  AGENT_TRACE_SCHEMA_VERSION,
  type AgentSpan,
} from '../src/runtime/agentTrace.js'
import { NEXUS_EVENT_SCHEMA_VERSION, type NexusEvent } from '../src/shared/events.js'

const SID = 'session-trace-test'
const V = NEXUS_EVENT_SCHEMA_VERSION

function ts(baseMs: number, offsetMs: number): string {
  return new Date(baseMs + offsetMs).toISOString()
}

const BASE = Date.parse('2026-06-17T10:00:00.000Z')

function ev(partial: { type: string; timestamp: string } & Record<string, unknown>): NexusEvent {
  return { schemaVersion: V, sessionId: SID, ...partial } as unknown as NexusEvent
}

// A canonical run: session_started → deltas → tool_started → tool_completed → result.
function canonicalRun(): NexusEvent[] {
  return [
    ev({ type: 'session_started', timestamp: ts(BASE, 0), cwd: '/repo', requestId: 'req-1', model: 'test-model' }),
    ev({ type: 'assistant_delta', timestamp: ts(BASE, 10), text: 'Let me read the file.' }),
    ev({ type: 'thinking_delta', timestamp: ts(BASE, 12), text: 'planning' }),
    ev({ type: 'tool_started', timestamp: ts(BASE, 20), toolUseId: 'tu-1', name: 'Read', input: { path: '/repo/a.ts' } }),
    ev({ type: 'tool_completed', timestamp: ts(BASE, 30), toolUseId: 'tu-1', name: 'Read', success: true, output: 'contents' }),
    ev({ type: 'result', timestamp: ts(BASE, 40), success: true, message: 'done' }),
  ]
}

function findSpan(trace: { spans: AgentSpan[] }, kind: string): AgentSpan | undefined {
  return trace.spans.find(s => s.kind === kind)
}

describe('AgentTrace projector — required span kinds', () => {
  test('covers provider invocation, tool call, permission, scope boundary, and final result', () => {
    const events = [
      ev({ type: 'session_started', timestamp: ts(BASE, 0), cwd: '/repo', requestId: 'req-1' }),
      ev({ type: 'execution_metrics', timestamp: ts(BASE, 5), requestId: 'req-1', inputTokens: 100, outputTokens: 50, providerRequestDurationMs: 40 }),
      ev({ type: 'permission_request', timestamp: ts(BASE, 10), toolUseId: 'tu-1', name: 'Edit', input: { path: '/repo/a.ts' }, risk: 'write' }),
      ev({ type: 'permission_response', timestamp: ts(BASE, 12), toolUseId: 'tu-1', approved: true, scope: 'once' }),
      ev({ type: 'tool_started', timestamp: ts(BASE, 13), toolUseId: 'tu-1', name: 'Edit', input: { path: '/repo/a.ts' } }),
      ev({ type: 'scope_boundary_detected', timestamp: ts(BASE, 14), toolUseId: 'tu-1', toolName: 'Edit', targetRoot: '/other', taskPrimaryRoot: '/repo', boundaryKind: 'external_absolute_path', action: 'require_confirmation', scopeRisk: 'outside_current_project', reason: 'r', suggestedPrompt: 's' }),
      ev({ type: 'tool_completed', timestamp: ts(BASE, 20), toolUseId: 'tu-1', name: 'Edit', success: true, output: 'ok' }),
      ev({ type: 'result', timestamp: ts(BASE, 25), success: true, message: 'done' }),
    ]
    const trace = projectAgentTrace(events)
    const kinds = new Set(trace.spans.map(s => s.kind))
    assert.ok(kinds.has('run'), 'run span present')
    assert.ok(kinds.has('provider_invocation'), 'provider_invocation span present')
    assert.ok(kinds.has('tool_call'), 'tool_call span present')
    assert.ok(kinds.has('permission_decision'), 'permission_decision span present')
    assert.ok(kinds.has('scope_boundary'), 'scope_boundary span present')
    assert.ok(kinds.has('final_result'), 'final_result span present')
  })
})

describe('AgentTrace projector — parent-child linkage', () => {
  test('permission_decision and scope_boundary parent to tool_call via toolUseId', () => {
    const events = [
      ev({ type: 'session_started', timestamp: ts(BASE, 0), cwd: '/repo' }),
      ev({ type: 'permission_request', timestamp: ts(BASE, 10), toolUseId: 'tu-1', name: 'Edit', input: {}, risk: 'write' }),
      ev({ type: 'permission_response', timestamp: ts(BASE, 12), toolUseId: 'tu-1', approved: true }),
      ev({ type: 'tool_started', timestamp: ts(BASE, 13), toolUseId: 'tu-1', name: 'Edit', input: {} }),
      ev({ type: 'scope_boundary_detected', timestamp: ts(BASE, 14), toolUseId: 'tu-1', toolName: 'Edit', targetRoot: '/other', taskPrimaryRoot: '/repo', boundaryKind: 'external_absolute_path', action: 'warn', scopeRisk: 'outside_current_project', reason: 'r', suggestedPrompt: 's' }),
      ev({ type: 'tool_completed', timestamp: ts(BASE, 20), toolUseId: 'tu-1', name: 'Edit', success: true, output: 'ok' }),
      ev({ type: 'result', timestamp: ts(BASE, 25), success: true, message: 'done' }),
    ]
    const trace = projectAgentTrace(events)
    const perm = findSpan(trace, 'permission_decision')!
    const scope = findSpan(trace, 'scope_boundary')!
    const tool = findSpan(trace, 'tool_call')!
    assert.equal(perm.parentSpanId, `tool:tu-1`, 'permission_decision parents to tool_call')
    assert.equal(scope.parentSpanId, `tool:tu-1`, 'scope_boundary parents to tool_call')
    assert.equal(tool.parentSpanId, 'run', 'tool_call parents to run')
  })

  test('permission_decision with no matching tool_call falls back to run parent', () => {
    const events = [
      ev({ type: 'session_started', timestamp: ts(BASE, 0), cwd: '/repo' }),
      ev({ type: 'permission_request', timestamp: ts(BASE, 10), toolUseId: 'orphan', name: 'Bash', input: {}, risk: 'execute' }),
      ev({ type: 'permission_response', timestamp: ts(BASE, 12), toolUseId: 'orphan', approved: false }),
      ev({ type: 'result', timestamp: ts(BASE, 25), success: false, message: 'denied' }),
    ]
    const trace = projectAgentTrace(events)
    const perm = findSpan(trace, 'permission_decision')!
    assert.equal(perm.parentSpanId, 'run', 'orphan permission parents to run')
  })

  test('provider, compact, memory, sub-agent, final_result all parent to run', () => {
    const events = [
      ev({ type: 'session_started', timestamp: ts(BASE, 0), cwd: '/repo' }),
      ev({ type: 'execution_metrics', timestamp: ts(BASE, 5), inputTokens: 1, outputTokens: 1 }),
      ev({ type: 'compact_boundary', timestamp: ts(BASE, 6), trigger: 'auto', summary: 's', beforeEventCount: 10, afterEventCount: 2, summaryChars: 100, snippedToolResults: 1 }),
      ev({ type: 'session_memory_updated', timestamp: ts(BASE, 7), path: '/m', trigger: 'auto', summaryChars: 50, eventCount: 10 }),
      ev({ type: 'agent_job_event', timestamp: ts(BASE, 8), eventId: 'e1', eventType: 'agent_job_started', jobId: 'job-1', childSessionId: 'child-1', agentType: 'explore', contextForkMode: 'minimal', status: 'running' }),
      ev({ type: 'agent_job_event', timestamp: ts(BASE, 9), eventId: 'e2', eventType: 'agent_job_completed', jobId: 'job-1', childSessionId: 'child-1', agentType: 'explore', contextForkMode: 'minimal', status: 'completed' }),
      ev({ type: 'result', timestamp: ts(BASE, 25), success: true, message: 'done' }),
    ]
    const trace = projectAgentTrace(events)
    for (const span of trace.spans) {
      if (span.kind === 'run') continue
      assert.equal(span.parentSpanId, 'run', `${span.kind} should parent to run`)
    }
  })
})

describe('AgentTrace projector — span ordering', () => {
  test('run span is first; remaining spans ordered by start timestamp', () => {
    const trace = projectAgentTrace(canonicalRun())
    assert.equal(trace.spans[0]!.kind, 'run', 'run span pinned first')
    for (let i = 1; i < trace.spans.length - 1; i += 1) {
      assert.ok(
        trace.spans[i]!.startTimestamp <= trace.spans[i + 1]!.startTimestamp,
        `span ${i} (${trace.spans[i]!.kind}) should not start after span ${i + 1} (${trace.spans[i + 1]!.kind})`,
      )
    }
  })
})

describe('AgentTrace projector — degraded behavior', () => {
  test('no session_started synthesizes run span from first event + warning', () => {
    const events = [
      ev({ type: 'tool_started', timestamp: ts(BASE, 0), toolUseId: 'tu-1', name: 'Read', input: {} }),
      ev({ type: 'tool_completed', timestamp: ts(BASE, 10), toolUseId: 'tu-1', name: 'Read', success: true, output: 'x' }),
    ]
    const trace = projectAgentTrace(events)
    const run = findSpan(trace, 'run')!
    assert.equal(run.status, 'degraded')
    assert.ok(trace.warnings.some(w => w.includes('no session_started')), 'warns about missing session_started')
    assert.ok(trace.warnings.some(w => w.includes('no terminal')), 'warns about missing terminal')
  })

  test('assistant_delta without execution_metrics synthesizes degraded provider spans + warning', () => {
    const events = [
      ev({ type: 'session_started', timestamp: ts(BASE, 0), cwd: '/repo' }),
      ev({ type: 'assistant_delta', timestamp: ts(BASE, 10), text: 'a' }),
      ev({ type: 'assistant_delta', timestamp: ts(BASE, 11), text: 'b' }),
      ev({ type: 'result', timestamp: ts(BASE, 20), success: true, message: 'done' }),
    ]
    const trace = projectAgentTrace(events)
    const providerSpans = trace.spans.filter(s => s.kind === 'provider_invocation')
    assert.equal(providerSpans.length, 1, 'one synthesized provider span per delta burst')
    assert.equal(providerSpans[0]!.status, 'degraded')
    assert.ok(trace.warnings.some(w => w.includes('no execution_metrics')), 'warns about missing execution_metrics')
  })

  test('tool_started without completion/denial produces degraded span + warning', () => {
    const events = [
      ev({ type: 'session_started', timestamp: ts(BASE, 0), cwd: '/repo' }),
      ev({ type: 'tool_started', timestamp: ts(BASE, 10), toolUseId: 'tu-orphan', name: 'Read', input: {} }),
      ev({ type: 'result', timestamp: ts(BASE, 20), success: true, message: 'done' }),
    ]
    const trace = projectAgentTrace(events)
    const tool = trace.spans.find(s => s.kind === 'tool_call' && s.toolUseId === 'tu-orphan')!
    assert.equal(tool.status, 'degraded')
    assert.equal(tool.endTimestamp, null)
    assert.ok(trace.warnings.some(w => w.includes('tu-orphan')), 'warns about orphan tool_started')
  })

  test('permission_request without response produces degraded span + warning', () => {
    const events = [
      ev({ type: 'session_started', timestamp: ts(BASE, 0), cwd: '/repo' }),
      ev({ type: 'permission_request', timestamp: ts(BASE, 10), toolUseId: 'tu-hang', name: 'Bash', input: {}, risk: 'execute' }),
      ev({ type: 'result', timestamp: ts(BASE, 20), success: true, message: 'done' }),
    ]
    const trace = projectAgentTrace(events)
    const perm = findSpan(trace, 'permission_decision')!
    assert.equal(perm.status, 'degraded')
    assert.ok(trace.warnings.some(w => w.includes('tu-hang')), 'warns about orphan permission_request')
  })

  test('empty event stream yields empty trace with warning', () => {
    const trace = projectAgentTrace([])
    assert.equal(trace.spans.length, 0)
    assert.equal(trace.runSpanId, null)
    assert.ok(trace.warnings.some(w => w.includes('no events')))
  })
})

describe('AgentTrace projector — permission denied path', () => {
  test('tool_denied produces tool_call span with error status', () => {
    const events = [
      ev({ type: 'session_started', timestamp: ts(BASE, 0), cwd: '/repo' }),
      ev({ type: 'tool_started', timestamp: ts(BASE, 10), toolUseId: 'tu-d', name: 'Bash', input: { command: 'rm -rf /' } }),
      ev({ type: 'tool_denied', timestamp: ts(BASE, 12), name: 'Bash', risk: 'execute', message: 'destructive', denialKind: 'permission', recoverable: true }),
      ev({ type: 'result', timestamp: ts(BASE, 20), success: false, message: 'denied' }),
    ]
    const trace = projectAgentTrace(events)
    const tool = trace.spans.find(s => s.kind === 'tool_call')!
    assert.equal(tool.status, 'error')
    assert.equal(tool.toolUseId, 'tu-d', 'denied tool attributed to the single open tool_started')
  })

  test('permission_response approved=false produces permission_decision with error status', () => {
    const events = [
      ev({ type: 'session_started', timestamp: ts(BASE, 0), cwd: '/repo' }),
      ev({ type: 'permission_request', timestamp: ts(BASE, 10), toolUseId: 'tu-p', name: 'Bash', input: {}, risk: 'execute' }),
      ev({ type: 'permission_response', timestamp: ts(BASE, 12), toolUseId: 'tu-p', approved: false, feedback: 'use a safer command' }),
      ev({ type: 'result', timestamp: ts(BASE, 20), success: false, message: 'denied' }),
    ]
    const trace = projectAgentTrace(events)
    const perm = findSpan(trace, 'permission_decision')!
    assert.equal(perm.status, 'error')
    assert.equal((perm.attributes as { approved: boolean }).approved, false)
  })

  test('error terminal event marks run + final_result as error', () => {
    const events = [
      ev({ type: 'session_started', timestamp: ts(BASE, 0), cwd: '/repo' }),
      ev({ type: 'error', timestamp: ts(BASE, 20), code: 'PROVIDER_FAILED', message: 'boom' }),
    ]
    const trace = projectAgentTrace(events)
    const run = findSpan(trace, 'run')!
    const result = findSpan(trace, 'final_result')!
    assert.equal(run.status, 'error')
    assert.equal(result.status, 'error')
    assert.equal((result.attributes as { code: string }).code, 'PROVIDER_FAILED')
  })
})

describe('AgentTrace projector — determinism', () => {
  test('same event stream reproduces identical span IDs', () => {
    const a = projectAgentTrace(canonicalRun())
    const b = projectAgentTrace(canonicalRun())
    assert.deepEqual(
      a.spans.map(s => s.spanId),
      b.spans.map(s => s.spanId),
      'span IDs must be deterministic across projections',
    )
    assert.deepEqual(a.warnings, b.warnings)
  })

  test('spanCountByKind tallies each kind', () => {
    const trace = projectAgentTrace(canonicalRun())
    assert.equal(trace.spanCountByKind.run, 1)
    assert.equal(trace.spanCountByKind.tool_call, 1)
    assert.equal(trace.spanCountByKind.final_result, 1)
    // Canonical run has assistant_delta/thinking_delta but no execution_metrics,
    // so the projector synthesizes one degraded provider_invocation span.
    assert.equal(trace.spanCountByKind.provider_invocation, 1)
    const total = Object.values(trace.spanCountByKind).reduce((a, b) => a + b, 0)
    assert.equal(total, trace.spans.length, 'sum of kind counts equals span count')
  })
})

describe('AgentTrace serializers', () => {
  test('traceToJsonl emits one header line + one line per span', () => {
    const trace = projectAgentTrace(canonicalRun())
    const jsonl = traceToJsonl(trace)
    const lines = jsonl.split('\n')
    assert.equal(lines.length, trace.spans.length + 1, 'header + one per span')
    const header = JSON.parse(lines[0]!)
    assert.equal(header.record, 'trace')
    assert.equal(header.schemaVersion, AGENT_TRACE_SCHEMA_VERSION)
    assert.equal(header.sessionId, SID)
    for (let i = 1; i < lines.length; i += 1) {
      const rec = JSON.parse(lines[i]!)
      assert.equal(rec.record, 'span')
      assert.ok(rec.spanId, `span line ${i} has spanId`)
      assert.ok(rec.kind, `span line ${i} has kind`)
    }
  })

  test('traceToJson produces a single parseable JSON blob with spans array', () => {
    const trace = projectAgentTrace(canonicalRun())
    const json = traceToJson(trace)
    const parsed = JSON.parse(json)
    assert.equal(parsed.schemaVersion, AGENT_TRACE_SCHEMA_VERSION)
    assert.ok(Array.isArray(parsed.spans))
    assert.equal(parsed.spans.length, trace.spans.length)
    assert.equal(parsed.derivedFrom, 'events')
  })

  test('JSONL header carries warnings and spanCountByKind', () => {
    const events = [
      ev({ type: 'assistant_delta', timestamp: ts(BASE, 0), text: 'x' }),
    ]
    const trace = projectAgentTrace(events)
    const jsonl = traceToJsonl(trace)
    const header = JSON.parse(jsonl.split('\n')[0]!)
    assert.ok(Array.isArray(header.warnings))
    assert.ok(header.warnings.length > 0, 'degraded warnings surfaced in header')
    assert.ok(header.spanCountByKind)
  })
})

describe('AgentTrace projector — sub-agent handoff grouping', () => {
  test('groups agent_job_events by jobId into a single span', () => {
    const events = [
      ev({ type: 'session_started', timestamp: ts(BASE, 0), cwd: '/repo' }),
      ev({ type: 'agent_job_event', timestamp: ts(BASE, 10), eventId: 'e1', eventType: 'agent_job_queued', jobId: 'job-1', childSessionId: 'c1', agentType: 'explore', contextForkMode: 'minimal', status: 'queued' }),
      ev({ type: 'agent_job_event', timestamp: ts(BASE, 12), eventId: 'e2', eventType: 'agent_job_started', jobId: 'job-1', childSessionId: 'c1', agentType: 'explore', contextForkMode: 'minimal', status: 'running' }),
      ev({ type: 'agent_job_event', timestamp: ts(BASE, 20), eventId: 'e3', eventType: 'agent_job_failed', jobId: 'job-1', childSessionId: 'c1', agentType: 'explore', contextForkMode: 'minimal', status: 'failed' }),
      ev({ type: 'result', timestamp: ts(BASE, 25), success: false, message: 'sub-agent failed' }),
    ]
    const trace = projectAgentTrace(events)
    const handoffs = trace.spans.filter(s => s.kind === 'sub_agent_handoff')
    assert.equal(handoffs.length, 1, 'one span per jobId')
    assert.equal(handoffs[0]!.status, 'error', 'failed job → error status')
    assert.equal(handoffs[0]!.jobId, 'job-1')
    assert.equal(handoffs[0]!.sourceEventIndices.length, 3, 'all 3 job events feed the span')
  })
})
