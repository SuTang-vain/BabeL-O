/**
 * Trajectory Eval Harness — fixture authoring helpers.
 *
 * Source: `docs/nexus/reference/agent-runtime-architecture-maturity-plan.md` §3.2.
 *
 * v1 eval is OFFLINE and deterministic: each fixture is a recorded event stream
 * (the trajectory under test) plus declarative check expectations. The harness
 * projects the stream via `projectAgentTrace` and runs builtin discipline checks.
 * No provider key, no live workspace mutation — a live-workspace mode is a v1.1
 * follow-up (it needs the durable-resume/replay machinery from plan §3.3).
 *
 * This builder keeps fixtures compact and readable: it fills `schemaVersion`,
 * `sessionId`, and auto-incrementing deterministic timestamps so each fixture
 * only states the events that matter for its discipline.
 */

import { NEXUS_EVENT_SCHEMA_VERSION, type NexusEvent } from '../shared/events.js'
import type { CheckKey, CheckSeverity } from './trajectoryEval.js'

const DEFAULT_SESSION_ID = 'session-eval-fixture'
const DEFAULT_BASE_MS = Date.parse('2026-06-17T10:00:00.000Z')

export interface FixtureDefinition {
  id: string
  description: string
  prompt: string
  /**
   * Per-check expected severities. The harness asserts actual === expected for
   * each key present. Checks omitted from this map are still run and reported
   * but not asserted — so a fixture can focus on the discipline it tests.
   */
  expectChecks?: Partial<Record<CheckKey, CheckSeverity>>
  events: NexusEvent[]
  /** Override the default sessionId for all events in this fixture. */
  sessionId?: string
}

export interface Fixture extends FixtureDefinition {
  /** Absolute or relative source path, filled by the loader for reporting. */
  sourcePath?: string
}

export function defineFixture(def: FixtureDefinition): Fixture {
  return def
}

/**
 * Compact event builder. Each call returns a fully-formed `NexusEvent` with
 * `schemaVersion` + `sessionId` filled and a monotonically-incrementing
 * timestamp (1 ms per event by default). Call `ev.reset()` between fixtures
 * or pass an explicit `sessionId`/clock to isolate.
 */
export const ev = {
  _sessionId: DEFAULT_SESSION_ID,
  _nextMs: DEFAULT_BASE_MS,

  reset(sessionId: string = DEFAULT_SESSION_ID, baseMs: number = DEFAULT_BASE_MS): void {
    this._sessionId = sessionId
    this._nextMs = baseMs
  },

  setSessionId(sessionId: string): void {
    this._sessionId = sessionId
  },

  _ts(): string {
    const iso = new Date(this._nextMs).toISOString()
    this._nextMs += 1
    return iso
  },

  _base<T extends { type: string }>(type: string, extra: Omit<T, 'type'>): NexusEvent {
    return {
      type,
      schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
      sessionId: this._sessionId,
      timestamp: this._ts(),
      ...(extra as Record<string, unknown>),
    } as unknown as NexusEvent
  },

  sessionStarted(extra: { cwd: string; requestId?: string; model?: string; budget?: number }): NexusEvent {
    return this._base('session_started', extra)
  },
  userMessage(text: string): NexusEvent {
    return this._base('user_message', { text })
  },
  assistantDelta(text: string): NexusEvent {
    return this._base('assistant_delta', { text })
  },
  thinkingDelta(text: string): NexusEvent {
    return this._base('thinking_delta', { text })
  },
  executionMetrics(extra: {
    requestId?: string
    inputTokens?: number
    outputTokens?: number
    providerRequestDurationMs?: number
    cacheReadInputTokens?: number
    cacheCreationInputTokens?: number
    cacheReadRatio?: number
  }): NexusEvent {
    return this._base('execution_metrics', extra)
  },
  toolStarted(extra: { toolUseId: string; name: string; input: unknown; effectiveRisk?: 'read' | 'write' | 'execute' | 'task' }): NexusEvent {
    return this._base('tool_started', extra)
  },
  toolCompleted(extra: { toolUseId: string; name: string; success: boolean; output?: unknown; truncated?: boolean; originalBytes?: number }): NexusEvent {
    return this._base('tool_completed', extra)
  },
  toolDenied(extra: { name: string; risk: 'read' | 'write' | 'execute' | 'task'; message: string; denialKind?: 'policy' | 'hook' | 'optimizer_safety' | 'permission'; recoverable?: boolean; terminal?: boolean }): NexusEvent {
    return this._base('tool_denied', extra)
  },
  permissionRequest(extra: { toolUseId: string; name: string; input?: unknown; risk: 'read' | 'write' | 'execute' | 'task'; scopeRisk?: string; suggestedRule?: string }): NexusEvent {
    return this._base('permission_request', extra)
  },
  permissionResponse(extra: { toolUseId: string; approved: boolean; scope?: 'once' | 'session' | 'rule'; rule?: string; feedback?: string; reason?: string }): NexusEvent {
    return this._base('permission_response', extra)
  },
  scopeBoundaryDetected(extra: { toolUseId: string; toolName: string; targetRoot: string; taskPrimaryRoot: string; boundaryKind: string; action: 'warn' | 'require_confirmation' | 'deny'; scopeRisk: string; reason: string; suggestedPrompt: string }): NexusEvent {
    return this._base('scope_boundary_detected', extra)
  },
  taskScopeDeclared(extra: { cwd: string; primaryRoot: string; explicitRoots?: string[]; confirmedExternalRoots?: string[]; mode: 'single_root' | 'multi_root' | 'cross_project'; source: 'cwd' | 'prompt_paths' | 'user_confirmation' | 'session_metadata'; message?: string }): NexusEvent {
    return this._base('task_scope_declared', { explicitRoots: [], confirmedExternalRoots: [], message: '', ...extra })
  },
  compactBoundary(extra: { trigger: 'manual' | 'auto' | 'reactive'; summary: string; beforeEventCount: number; afterEventCount: number; summaryChars: number; snippedToolResults: number; preTokens?: number; postTokens?: number }): NexusEvent {
    return this._base('compact_boundary', extra)
  },
  sessionMemoryUpdated(extra: { path: string; trigger: 'manual' | 'auto' | 'reactive'; summaryChars: number; eventCount: number; reason?: 'compact' | 'pause'; decisionReason?: string }): NexusEvent {
    return this._base('session_memory_updated', extra)
  },
  // §3.5 Memory Quality Metrics: helper for the long-term
  // MemoryOS/EverCore retrieval event. Defaults to a
  // "skipped, no cue" retrieval so fixtures that just want a
  // presence marker (and pass severity) don't have to spell out
  // the full diagnostics shape.
  memoryRetrieval(extra: {
    provider?: string
    enabled?: boolean
    scope?: 'project' | 'user' | 'channel' | 'unknown'
    autoSearchTriggered?: boolean
    autoSearchReason?: 'aborted' | 'empty_prompt' | 'explicit_memory_cue' | 'current_workspace_only' | 'execution_status_only' | 'permission_response' | 'no_memory_cue'
    autoSearchCue?: string
    hitCount?: number
    injectedChars?: number
    truncated?: boolean
    searchLatencyMs?: number
    error?: string
  } = {}): NexusEvent {
    return this._base('memory_retrieval', {
      provider: extra.provider ?? 'evercore',
      enabled: extra.enabled ?? true,
      scope: extra.scope ?? 'project',
      autoSearchTriggered: extra.autoSearchTriggered ?? false,
      autoSearchReason: extra.autoSearchReason ?? 'no_memory_cue',
      ...(extra.autoSearchCue && { autoSearchCue: extra.autoSearchCue }),
      hitCount: extra.hitCount ?? 0,
      injectedChars: extra.injectedChars ?? 0,
      budgetChars: 4_000,
      maxHitChars: 800,
      truncated: extra.truncated ?? false,
      ...(extra.searchLatencyMs !== undefined && { searchLatencyMs: extra.searchLatencyMs }),
      ...(extra.error && { error: extra.error }),
    } as Record<string, unknown>)
  },
  result(extra: { success: boolean; message: string }): NexusEvent {
    return this._base('result', extra)
  },
  error(extra: { code: string; message: string; details?: unknown }): NexusEvent {
    return this._base('error', extra)
  },
}
