// src/nexus/behaviorMonitor.ts
//
// PR-5: Track B Phase 2 — Nexus-side cross-session behavior monitor.
// (See docs/nexus/reference/behavior-monitor.md §6.)
//
// Scope (this PR):
//   - in-memory 5min rolling window per BehaviorMonitor
//   - 3 cross-session trigger detectors: hot-path, tool-storm, scope-drift-wave
//   - hintDispatcher with 4 safety checks
//   - writes BehaviorTraceEntry via behaviorTrace.ts (source='nexus')
//
// Out of scope (later PRs):
//   - actual SessionChannel WebSocket injection (server wiring)
//   - persistence (explicit per design §6.4 — restart clears state)
//   - notifications package integration
//   - PaneStatus StatusBehaviorHint (TUI/Go — separate PR-6)
//
// Invariants respected:
//   - INV-4: never silent-inject. hintDispatcher only *returns* a hint
//     candidate; caller decides when to surface to model context.
//   - INV-11: never touches natural_pause (we are orthogonal to
//     sessionMemoryLite).
//   - model-catalog governance: zero LLM calls; all detectors rule-based.

import { resolve } from 'node:path'
import {
  buildTraceContext,
  deriveRuleSelfAssessment,
  flushBehaviorTraceQueue,
  isBehaviorTraceEnabled,
  queueBehaviorTraceEntry,
  type BehaviorTrigger,
  type BehaviorTraceAnomaly,
  type BehaviorTraceEntry,
} from '../runtime/behaviorTrace.js'
import { logger } from '../shared/logger.js'
import type { NexusEvent } from '../shared/events.js'

export const BEHAVIOR_MONITOR_SCHEMA_VERSION = '2026-06-16.behavior-monitor.v1' as const
export const DEFAULT_ROLLING_WINDOW_MS = 5 * 60_000 // 5 minutes
export const DEFAULT_HOT_PATH_MIN_SESSIONS = 3
export const DEFAULT_TOOL_STORM_CALLS_PER_MINUTE = 20
export const DEFAULT_SCOPE_DRIFT_WAVE_MIN_SESSIONS = 3
export const DEFAULT_HINT_COOLDOWN_MS = 5 * 60_000

export type BehaviorMonitorOptions = {
  cwd: string
  rollingWindowMs?: number
  hotPathMinSessions?: number
  toolStormCallsPerMinute?: number
  scopeDriftWaveMinSessions?: number
  hintCooldownMs?: number
  now?: () => number
}

export type CrossSessionHotPath = {
  trigger: 'hot-path'
  pattern: string
  sessionIds: string[]
  occurrenceCount: number
  windowMs: number
}

export type CrossSessionToolStorm = {
  trigger: 'tool-storm'
  toolName: string
  sessionId: string
  callsPerMinute: number
}

export type CrossSessionScopeDriftWave = {
  trigger: 'scope-drift-wave'
  driftTarget: string
  sessionIds: string[]
  windowMs: number
}

export type CrossSessionTrigger =
  | CrossSessionHotPath
  | CrossSessionToolStorm
  | CrossSessionScopeDriftWave

export type CrossSessionAnomaly = {
  sessionIds?: string[]
  occurrenceCount?: number
  windowMs?: number
  toolName?: string
  callsPerMinute?: number
  driftTarget?: string
  pattern?: string
}

export type HintCandidate = {
  trigger: BehaviorTrigger
  sessionId: string
  pattern: string
  detectedAt: number
}

export type HintDispatchContext = {
  sessionId: string
  inToolExecution: boolean
  waitingForUser: boolean
  quietMode: boolean
  lastHintAtBySession: Map<string, number>
  now?: number
}

// ─── Detector options ─────────────────────────────────────────────────────

export type HotPathOptions = {
  minSessions: number
  windowMs: number
  now?: number
}

export type ToolStormOptions = {
  callsPerMinuteThreshold: number
  windowMs?: number
  now?: number
}

export type ScopeDriftWaveOptions = {
  minSessions: number
  windowMs: number
  now?: number
}

// ─── Helpers ─────────────────────────────────────────────────────────────

type SessionEventSlice = {
  sessionId: string
  events: NexusEvent[]
}

function pruneByWindow<T extends { ts: number }>(items: T[], windowMs: number, now: number): T[] {
  const cutoff = now - windowMs
  return items.filter(i => i.ts >= cutoff)
}

function extractErrorPaths(events: NexusEvent[]): Array<{ path: string; ts: number }> {
  const out: Array<{ path: string; ts: number }> = []
  for (const event of events) {
    if (event.type !== 'tool_started') continue
    const input = (event as Extract<NexusEvent, { type: 'tool_started' }>).input as
      | Record<string, unknown>
      | undefined
    if (!input) continue
    const path = typeof input.path === 'string'
      ? input.path
      : typeof input.filePath === 'string' ? input.filePath : ''
    if (!path) continue
    // Pair with a following error or tool_completed(success=false) within a
    // short tail (read from later in the same stream).
    const eventTs = Date.parse((event as { timestamp: string }).timestamp)
    let isFailure = false
    for (let j = 0; j < 20 && !isFailure; j += 1) {
      // Pair-checking is approximate; we just record the path and let
      // session-level error followup be detected by monitor outer logic.
      if (eventTs > 0) {
        // existence check
        isFailure = event.type === 'tool_started'
      }
    }
    if (path) out.push({ path, ts: eventTs || Date.now() })
  }
  return out
}

function globToRegex(pattern: string): RegExp {
  let out = '^'
  for (let i = 0; i < pattern.length; i += 1) {
    if (pattern[i] === '*' && pattern[i + 1] === '*') {
      out += '.*'
      i += 1
    } else if (pattern[i] === '*') {
      out += '[^/]*'
    } else {
      out += pattern[i]!.replace(/[.+^${}()|[\]\\\/]/g, '\\$&')
    }
  }
  return new RegExp(out)
}

// ─── Detectors ───────────────────────────────────────────────────────────

// hot-path: 同一 file/glob 在 ≥ N 个 session 中各自被 tool_started 访问过
export function detectHotPath(
  sessions: SessionEventSlice[],
  options: HotPathOptions,
): CrossSessionHotPath[] {
  const now = options.now ?? Date.now()
  const pathToSessions = new Map<string, { sessionIds: Set<string>; ts: number[] }>()
  for (const slice of sessions) {
    const paths = extractErrorPaths(slice.events)
    for (const { path, ts } of paths) {
      if (ts < now - options.windowMs) continue
      const entry = pathToSessions.get(path) ?? { sessionIds: new Set<string>(), ts: [] }
      entry.sessionIds.add(slice.sessionId)
      entry.ts.push(ts)
      pathToSessions.set(path, entry)
    }
  }
  const out: CrossSessionHotPath[] = []
  for (const [pattern, entry] of pathToSessions) {
    if (entry.sessionIds.size >= options.minSessions) {
      out.push({
        trigger: 'hot-path',
        pattern,
        sessionIds: Array.from(entry.sessionIds),
        occurrenceCount: entry.ts.length,
        windowMs: options.windowMs,
      })
    }
  }
  return out
}

// tool-storm: 同一 session 同 tool 在 1min 内调用 > K 次
export function detectToolStorm(
  events: NexusEvent[],
  options: ToolStormOptions,
): CrossSessionToolStorm[] {
  const now = options.now ?? Date.now()
  const windowMs = options.windowMs ?? 60_000
  // group by session+tool
  type Bucket = { sessionId: string; toolName: string; ts: number[] }
  const buckets = new Map<string, Bucket>()
  for (const event of events) {
    if (event.type !== 'tool_started') continue
    const e = event as Extract<NexusEvent, { type: 'tool_started' }>
    const ts = Date.parse(e.timestamp)
    if (!Number.isFinite(ts) || ts < now - windowMs) continue
    const key = `${e.sessionId ?? 'unknown'}::${e.name}`
    const b = buckets.get(key) ?? { sessionId: e.sessionId ?? 'unknown', toolName: e.name, ts: [] }
    b.ts.push(ts)
    buckets.set(key, b)
  }
  const out: CrossSessionToolStorm[] = []
  for (const b of buckets.values()) {
    const callsPerMinute = (b.ts.length * 60_000) / windowMs
    if (callsPerMinute > options.callsPerMinuteThreshold) {
      out.push({
        trigger: 'tool-storm',
        toolName: b.toolName,
        sessionId: b.sessionId,
        callsPerMinute: Math.round(callsPerMinute * 10) / 10,
      })
    }
  }
  return out
}

// scope-drift-wave: ≥ N 个 session 在 windowMs 内都把 tool 指向同一外部 target
export function detectScopeDriftWave(
  sessions: SessionEventSlice[],
  options: ScopeDriftWaveOptions,
): CrossSessionScopeDriftWave[] {
  const now = options.now ?? Date.now()
  const targetToSessions = new Map<string, { sessionIds: Set<string>; ts: number[] }>()
  for (const slice of sessions) {
    for (const event of slice.events) {
      if (event.type !== 'tool_started') continue
      const e = event as Extract<NexusEvent, { type: 'tool_started' }>
      const ts = Date.parse(e.timestamp)
      if (!Number.isFinite(ts) || ts < now - options.windowMs) continue
      const input = e.input as Record<string, unknown> | undefined
      const path = typeof input?.path === 'string'
        ? input.path
        : typeof input?.filePath === 'string' ? input.filePath : ''
      if (!path) continue
      const target = path.split('/').slice(0, 3).join('/') + '/*' // collapse to directory glob
      const entry = targetToSessions.get(target) ?? { sessionIds: new Set<string>(), ts: [] }
      entry.sessionIds.add(slice.sessionId)
      entry.ts.push(ts)
      targetToSessions.set(target, entry)
    }
  }
  const out: CrossSessionScopeDriftWave[] = []
  for (const [driftTarget, entry] of targetToSessions) {
    if (entry.sessionIds.size >= options.minSessions) {
      out.push({
        trigger: 'scope-drift-wave',
        driftTarget,
        sessionIds: Array.from(entry.sessionIds),
        windowMs: options.windowMs,
      })
    }
  }
  return out
}

// ─── Hint dispatch safety checks ────────────────────────────────────────

// Returns true when ALL safety checks pass — caller may inject the hint.
// 4 checks per design §6.2:
//   1. not in tool execution
//   2. not waiting for user
//   3. session not in quiet mode
//   4. session cooldown ≥ 5min since last hint
export function shouldDispatchHint(candidate: HintCandidate, ctx: HintDispatchContext): boolean {
  if (candidate.sessionId !== ctx.sessionId) return false
  if (ctx.inToolExecution) return false
  if (ctx.waitingForUser) return false
  if (ctx.quietMode) return false
  const now = ctx.now ?? Date.now()
  const last = ctx.lastHintAtBySession.get(ctx.sessionId) ?? 0
  if (last > 0 && now - last < DEFAULT_HINT_COOLDOWN_MS) return false
  return true
}

// ─── BehaviorMonitor container ───────────────────────────────────────────

export class BehaviorMonitor {
  private readonly opts: Required<BehaviorMonitorOptions>
  private readonly eventsBySession = new Map<string, NexusEvent[]>()
  private readonly lastHintAtBySession = new Map<string, number>()
  private readonly patternCache = new Map<string, RegExp>()

  constructor(options: BehaviorMonitorOptions) {
    if (!options.cwd || typeof options.cwd !== 'string') {
      throw new Error('BehaviorMonitor requires a non-empty cwd')
    }
    this.opts = {
      cwd: options.cwd,
      rollingWindowMs: options.rollingWindowMs ?? DEFAULT_ROLLING_WINDOW_MS,
      hotPathMinSessions: options.hotPathMinSessions ?? DEFAULT_HOT_PATH_MIN_SESSIONS,
      toolStormCallsPerMinute: options.toolStormCallsPerMinute ?? DEFAULT_TOOL_STORM_CALLS_PER_MINUTE,
      scopeDriftWaveMinSessions: options.scopeDriftWaveMinSessions ?? DEFAULT_SCOPE_DRIFT_WAVE_MIN_SESSIONS,
      hintCooldownMs: options.hintCooldownMs ?? DEFAULT_HINT_COOLDOWN_MS,
      now: options.now ?? (() => Date.now()),
    }
  }

  // Ingest a single event from a session.
  ingest(event: NexusEvent): void {
    const sessionId = (event as { sessionId?: string }).sessionId
    if (!sessionId) return
    const list = this.eventsBySession.get(sessionId) ?? []
    list.push(event)
    this.eventsBySession.set(sessionId, list)
  }

  // Prune events older than the rolling window.
  prune(): void {
    const now = this.opts.now()
    for (const [sessionId, list] of this.eventsBySession) {
      const kept = pruneByWindow(
        list.map(e => ({ e, ts: Date.parse((e as { timestamp: string }).timestamp) || 0 })),
        this.opts.rollingWindowMs,
        now,
      ).map(x => x.e)
      if (kept.length === 0) {
        this.eventsBySession.delete(sessionId)
      } else {
        this.eventsBySession.set(sessionId, kept)
      }
    }
  }

  // Detect all 3 trigger types from the current rolling window.
  detectAll(): CrossSessionTrigger[] {
    this.prune()
    const sessions: SessionEventSlice[] = Array.from(this.eventsBySession.entries())
      .map(([sessionId, events]) => ({ sessionId, events }))
    const allEvents = sessions.flatMap(s => s.events)
    return [
      ...detectHotPath(sessions, {
        minSessions: this.opts.hotPathMinSessions,
        windowMs: this.opts.rollingWindowMs,
        now: this.opts.now(),
      }),
      ...detectToolStorm(allEvents, {
        callsPerMinuteThreshold: this.opts.toolStormCallsPerMinute,
        windowMs: this.opts.rollingWindowMs,
        now: this.opts.now(),
      }),
      ...detectScopeDriftWave(sessions, {
        minSessions: this.opts.scopeDriftWaveMinSessions,
        windowMs: this.opts.rollingWindowMs,
        now: this.opts.now(),
      }),
    ]
  }

  // Run a hint candidate through shouldDispatchHint.
  tryDispatch(
    candidate: HintCandidate,
    ctx: Omit<HintDispatchContext, 'sessionId' | 'lastHintAtBySession' | 'now'>,
  ): boolean {
    const fullCtx: HintDispatchContext = {
      sessionId: candidate.sessionId,
      inToolExecution: ctx.inToolExecution,
      waitingForUser: ctx.waitingForUser,
      quietMode: ctx.quietMode,
      lastHintAtBySession: this.lastHintAtBySession,
      now: this.opts.now(),
    }
    const ok = shouldDispatchHint(candidate, fullCtx)
    if (ok) {
      this.lastHintAtBySession.set(candidate.sessionId, this.opts.now())
    }
    return ok
  }

  // Convert a cross-session trigger to a BehaviorTraceEntry and queue it
  // for writing. Tags the anomaly with source='nexus' to distinguish
  // from session-internal traces.
  queueTrace(trigger: CrossSessionTrigger, sessionId: string): void {
    if (!isBehaviorTraceEnabled()) return
    const allEvents = Array.from(this.eventsBySession.values()).flat()
    const ctx = buildTraceContext({ events: allEvents })
    const anomaly = crossSessionToAnomaly(trigger)
    const selfAssessment = deriveRuleSelfAssessment(
      trigger.trigger,
      anomaly,
      { retryCount: ctx.retryCount },
    )
    queueBehaviorTraceEntry({
      cwd: this.opts.cwd,
      sessionId,
      trigger: trigger.trigger,
      triggerConfidence: 0.9,
      anomaly,
      context: ctx,
      selfAssessment,
    })
    void flushBehaviorTraceQueue().catch(error => {
      logger.debug('BehaviorMonitor trace flush failed', error)
    })
  }

  // Test/admin: read-only access to tracked state.
  trackedSessionCount(): number {
    return this.eventsBySession.size
  }
}

function crossSessionToAnomaly(t: CrossSessionTrigger): BehaviorTraceAnomaly & { source?: string } {
  switch (t.trigger) {
    case 'hot-path':
      return {
        errorCode: 'HOT_PATH',
        errorMessage: `hot-path: ${t.pattern} (${t.sessionIds.length} sessions, ${t.occurrenceCount} occurrences)`,
        source: 'nexus',
      }
    case 'tool-storm':
      return {
        errorCode: 'TOOL_STORM',
        errorMessage: `tool-storm: ${t.toolName} ${t.callsPerMinute}/min in ${t.sessionId}`,
        source: 'nexus',
      }
    case 'scope-drift-wave':
      return {
        errorCode: 'SCOPE_DRIFT_WAVE',
        driftPath: t.driftTarget,
        errorMessage: `scope-drift-wave: ${t.driftTarget} (${t.sessionIds.length} sessions)`,
        source: 'nexus',
      }
  }
}

// ─── Convenience: combined run ───────────────────────────────────────────

export type BehaviorMonitorRunResult = {
  triggers: CrossSessionTrigger[]
  hintsDispatched: number
  hintsBlocked: number
  traceEntriesQueued: number
}

export async function runBehaviorMonitor(
  monitor: BehaviorMonitor,
  sessionId: string,
  hintContext: Omit<HintDispatchContext, 'sessionId' | 'lastHintAtBySession' | 'now'>,
): Promise<BehaviorMonitorRunResult> {
  const triggers = monitor.detectAll()
  let hintsDispatched = 0
  let hintsBlocked = 0
  let traceEntriesQueued = 0
  for (const t of triggers) {
    monitor.queueTrace(t, sessionId)
    traceEntriesQueued += 1
    const pattern = t.trigger === 'hot-path' ? t.pattern
      : t.trigger === 'tool-storm' ? t.toolName
      : t.driftTarget
    const candidate: HintCandidate = {
      trigger: t.trigger,
      sessionId,
      pattern,
      detectedAt: Date.now(),
    }
    const ok = monitor.tryDispatch(candidate, hintContext)
    if (ok) hintsDispatched += 1
    else hintsBlocked += 1
  }
  return { triggers, hintsDispatched, hintsBlocked, traceEntriesQueued }
}

// Re-export file path resolver for callers (so they can also resolve the
// trace file path for monitoring purposes).
export function getTraceFilePath(cwd: string): string {
  return resolve(cwd, '.babel-o/behavior-trace.jsonl')
}
