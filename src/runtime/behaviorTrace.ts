// src/runtime/behaviorTrace.ts
//
// Phase 1 of docs/nexus/reference/behavior-monitor.md (parallel launch, zero
// behavior change):
//
//   - new module: behavior trace capture + JSONL append
//   - 5 session-internal triggers: error / denial / scope-drift /
//     trajectory-end / user-redirect
//   - rule-based self-assessment (NO default LLM)
//   - serialized write queue (same pattern as sessionMemoryLite)
//   - opt-out via BABEL_O_BEHAVIOR_TRACE_ENABLED (default true)
//
// NOT in this module:
//   - LLMCodingRuntime hook integration (Phase 1.5 — separate work)
//   - cross-session BehaviorMonitor (Nexus side — separate work)
//   - live hint injection (Phase 2 — bbl loop P1 integration)
//
// Invariants respected:
//   - INV-4: never silent-inject (no model-side mutation; this module is
//     pure write-side, downstream consumers decide when to surface)
//   - INV-11: do not revive natural_pause (we never call natural_pause
//     here; behavior trace is a parallel capture path)
//   - model-catalog governance: no model selection, no LLM call
//   - test config isolation: writes go to cwd/.babel-o/behavior-trace.jsonl
//     (caller passes cwd; never reads process.env.HOME)

import { appendFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { createId, nowIso } from '../shared/id.js'
import { logger } from '../shared/logger.js'
import type { NexusEvent } from '../shared/events.js'

export const BEHAVIOR_TRACE_RELATIVE_PATH = '.babel-o/behavior-trace.jsonl'
export const BEHAVIOR_TRACE_SCHEMA_VERSION = '2026-06-16.behavior-trace.v1' as const

// 5 session-internal + 3 cross-session (kept here for type unification;
// cross-session types are only emitted by Nexus-side behaviorMonitor)
export type BehaviorTrigger =
  // session-internal (5)
  | 'error'
  | 'denial'
  | 'scope-drift'
  | 'trajectory-end'
  | 'user-redirect'
  // cross-session (4) — declared but not emitted by this module
  | 'hot-path'
  | 'tool-storm'
  | 'scope-drift-wave'
  // Phase D: prompt-cache-miss-wave — emitted by BehaviorMonitor when
  // ≥ N sessions in windowMs all have prompt cache read ratio below
  // targetRatio. See `cache-observability-and-nexus-realtime-detection-plan.md` §5.4.
  | 'prompt-cache-miss-wave'

export type SelfAssessmentSource = 'rule' | 'llm' | ''

export type BehaviorTraceSelfAssessment = {
  likelyCause: string
  confidence: number
  suggestedFix: string
  source: SelfAssessmentSource
}

export type BehaviorTraceContext = {
  recentEvents: NexusEvent[]
  toolSequence: string[]
  fileRefStack: string[]
  userIntentGuidance: string
  retryCount: number
  timeInSessionMs: number
  tokensSinceLastTrace: number
}

export type BehaviorTraceAnomaly = {
  errorCode?: string
  errorMessage?: string
  denialReason?: string
  driftPath?: string
  expectedScope?: string
  userRedirectSignal?: string
}

export type BehaviorTraceEntry = {
  schemaVersion: typeof BEHAVIOR_TRACE_SCHEMA_VERSION
  traceId: string
  sessionId: string
  cwd: string
  timestamp: string
  trigger: BehaviorTrigger
  triggerConfidence: number
  context: BehaviorTraceContext
  anomaly: BehaviorTraceAnomaly
  selfAssessment?: BehaviorTraceSelfAssessment
}

const DEFAULT_TRAJECTORY_INTERVAL = 20
const DEFAULT_MAX_RECENT_EVENTS = 20
const USER_REDIRECT_PATTERN = /^(不|错|重新|其实|wait|wrong|no[ ,]|stop|不对|更正|correct)/i
const TOOL_NAME_FIELDS = ['name', 'toolName'] as const
const PATH_FIELDS = ['path', 'filePath'] as const

let behaviorTraceQueue: Promise<void> = Promise.resolve()

export function isBehaviorTraceEnabled(): boolean {
  const raw = (process.env.BABEL_O_BEHAVIOR_TRACE_ENABLED ?? 'true').trim().toLowerCase()
  if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') return false
  if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on') return true
  // unset or unrecognized → default true (Phase 1 parallel launch)
  return true
}

export function getTrajectoryInterval(envValue?: string): number {
  const raw = (envValue ?? process.env.BABEL_O_BEHAVIOR_TRAJECTORY_INTERVAL ?? '').trim()
  if (!raw) return DEFAULT_TRAJECTORY_INTERVAL
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 5 || parsed > 100) return DEFAULT_TRAJECTORY_INTERVAL
  return parsed
}

export type DetectTriggersInput = {
  events: NexusEvent[]
  cwd: string
  sessionId: string
  taskScope?: string
  trajectoryInterval?: number
  maxRecentEvents?: number
  userIntentGuidance?: string
}

export type DetectedTrigger = {
  trigger: BehaviorTrigger
  confidence: number
  anomaly: BehaviorTraceAnomaly
  relatedEventIndex: number
}

export function detectTriggers(input: DetectTriggersInput): DetectedTrigger[] {
  const triggers: DetectedTrigger[] = []
  const { events } = input
  if (events.length === 0) return triggers

  // error
  const lastErrorIdx = findLastEventIndex(events, e => e.type === 'error')
  if (lastErrorIdx >= 0) {
    const err = events[lastErrorIdx] as Extract<NexusEvent, { type: 'error' }>
    triggers.push({
      trigger: 'error',
      confidence: 0.9,
      anomaly: {
        errorCode: err.code,
        errorMessage: err.message,
      },
      relatedEventIndex: lastErrorIdx,
    })
  }

  // denial
  const lastDenialIdx = findLastEventIndex(
    events,
    e => e.type === 'permission_response' && (e as Extract<NexusEvent, { type: 'permission_response' }>).approved === false,
  )
  if (lastDenialIdx >= 0) {
    const denial = events[lastDenialIdx] as Extract<NexusEvent, { type: 'permission_response' }>
    triggers.push({
      trigger: 'denial',
      confidence: 0.9,
      anomaly: {
        denialReason: (denial as { reason?: string }).reason ?? 'user-declined',
      },
      relatedEventIndex: lastDenialIdx,
    })
  }

  // scope-drift (only if taskScope provided)
  if (input.taskScope) {
    const scopeRegex = globToRegex(input.taskScope)
    const lastDriftIdx = findLastEventIndex(events, e => {
      if (e.type !== 'tool_started') return false
      const path = extractToolPath(e)
      return path !== undefined && !scopeRegex.test(path)
    })
    if (lastDriftIdx >= 0) {
      const driftEvent = events[lastDriftIdx] as Extract<NexusEvent, { type: 'tool_started' }>
      triggers.push({
        trigger: 'scope-drift',
        confidence: 0.85,
        anomaly: {
          driftPath: extractToolPath(driftEvent),
          expectedScope: input.taskScope,
        },
        relatedEventIndex: lastDriftIdx,
      })
    }
  }

  // trajectory-end (every N tool calls)
  const trajectoryInterval = input.trajectoryInterval ?? getTrajectoryInterval()
  const toolCallCount = countToolStarted(events)
  if (toolCallCount > 0 && toolCallCount % trajectoryInterval === 0) {
    const lastToolIdx = findLastEventIndex(events, e => e.type === 'tool_started')
    if (lastToolIdx >= 0) {
      triggers.push({
        trigger: 'trajectory-end',
        confidence: 1.0,
        anomaly: {},
        relatedEventIndex: lastToolIdx,
      })
    }
  }

  // user-redirect
  const lastUserIdx = findLastEventIndex(events, e => e.type === 'user_message')
  if (lastUserIdx >= 0) {
    const userEvent = events[lastUserIdx] as Extract<NexusEvent, { type: 'user_message' }>
    const text = (userEvent.text ?? '').trim()
    if (text && USER_REDIRECT_PATTERN.test(text)) {
      triggers.push({
        trigger: 'user-redirect',
        confidence: 0.85,
        anomaly: {
          userRedirectSignal: text.slice(0, 80),
        },
        relatedEventIndex: lastUserIdx,
      })
    }
  }

  return triggers
}

export function deriveRuleSelfAssessment(
  trigger: BehaviorTrigger,
  anomaly: BehaviorTraceAnomaly,
  context: { retryCount: number } = { retryCount: 0 },
): BehaviorTraceSelfAssessment {
  if (anomaly.errorCode === 'TOOL_NOT_FOUND' && context.retryCount >= 2) {
    return {
      likelyCause: 'repeated-read-after-not-found',
      confidence: 0.8,
      suggestedFix: 'use glob search or path validation before read',
      source: 'rule',
    }
  }
  if (anomaly.denialReason === 'protected_path') {
    return {
      likelyCause: 'scope-violation',
      confidence: 0.95,
      suggestedFix: 'check task scope before edit',
      source: 'rule',
    }
  }
  if (trigger === 'scope-drift') {
    return {
      likelyCause: 'scope-drift',
      confidence: 0.85,
      suggestedFix: 'tighten task scope declaration',
      source: 'rule',
    }
  }
  if (trigger === 'denial') {
    return {
      likelyCause: 'user-declined-tool',
      confidence: 0.9,
      suggestedFix: 'avoid this tool or ask user for explicit scope expansion',
      source: 'rule',
    }
  }
  if (trigger === 'user-redirect') {
    return {
      likelyCause: 'user-corrected-trajectory',
      confidence: 0.85,
      suggestedFix: 're-read recent events and recent user message for new intent',
      source: 'rule',
    }
  }
  if (trigger === 'trajectory-end') {
    return {
      likelyCause: 'checkpoint',
      confidence: 1.0,
      suggestedFix: 'review trajectory before continuing',
      source: 'rule',
    }
  }
  if (trigger === 'error') {
    return {
      likelyCause: classifyErrorLikelyCause(anomaly.errorCode),
      confidence: 0.6,
      suggestedFix: 'inspect error code and recent tool calls',
      source: 'rule',
    }
  }
  return { likelyCause: 'unknown', confidence: 0, suggestedFix: '', source: 'rule' }
}

export type BuildContextInput = {
  events: NexusEvent[]
  maxRecentEvents?: number
  userIntentGuidance?: string
  tokensSinceLastTrace?: number
  sessionStartTimeMs?: number
}

export function buildTraceContext(input: BuildContextInput): BehaviorTraceContext {
  const maxRecent = input.maxRecentEvents ?? DEFAULT_MAX_RECENT_EVENTS
  const recentEvents = input.events.slice(-maxRecent)
  const toolSequence = recentEvents
    .filter(e => e.type === 'tool_started' || e.type === 'tool_completed')
    .map(e => {
      if (e.type === 'tool_started') return (e as Extract<NexusEvent, { type: 'tool_started' }>).name
      return (e as Extract<NexusEvent, { type: 'tool_completed' }>).name
    })
  const fileRefStack = recentEvents
    .map(extractToolPath)
    .filter((p): p is string => typeof p === 'string')
  const retryCount = countRetries(input.events)
  const sessionStart = input.sessionStartTimeMs ?? extractSessionStartMs(input.events)
  const timeInSessionMs = sessionStart !== undefined ? Date.now() - sessionStart : 0
  return {
    recentEvents,
    toolSequence,
    fileRefStack,
    userIntentGuidance: input.userIntentGuidance ?? '',
    retryCount,
    timeInSessionMs,
    tokensSinceLastTrace: input.tokensSinceLastTrace ?? 0,
  }
}

export type QueueBehaviorTraceInput = {
  cwd: string
  sessionId: string
  trigger: BehaviorTrigger
  triggerConfidence: number
  anomaly: BehaviorTraceAnomaly
  context: BehaviorTraceContext
  selfAssessment?: BehaviorTraceSelfAssessment
}

export function queueBehaviorTraceEntry(input: QueueBehaviorTraceInput): void {
  if (!isBehaviorTraceEnabled()) return
  behaviorTraceQueue = behaviorTraceQueue
    .then(() => writeBehaviorTraceEntry(input).then(() => undefined))
    .catch(error => {
      logger.debug('Behavior Trace background write failed', error)
    })
}

export async function flushBehaviorTraceQueue(): Promise<void> {
  await behaviorTraceQueue
}

export async function writeBehaviorTraceEntry(input: QueueBehaviorTraceInput): Promise<BehaviorTraceEntry | null> {
  if (!isBehaviorTraceEnabled()) return null
  const tracePath = resolve(input.cwd, BEHAVIOR_TRACE_RELATIVE_PATH)
  const allowedPath = resolve(input.cwd, BEHAVIOR_TRACE_RELATIVE_PATH)
  if (tracePath !== allowedPath) return null

  const entry: BehaviorTraceEntry = {
    schemaVersion: BEHAVIOR_TRACE_SCHEMA_VERSION,
    traceId: createId('trc'),
    sessionId: input.sessionId,
    cwd: input.cwd,
    timestamp: nowIso(),
    trigger: input.trigger,
    triggerConfidence: input.triggerConfidence,
    context: input.context,
    anomaly: input.anomaly,
    selfAssessment: input.selfAssessment,
  }

  await mkdir(dirname(tracePath), { recursive: true })
  await appendFile(tracePath, `${JSON.stringify(entry)}\n`, 'utf8')
  return entry
}

// ─── internals ─────────────────────────────────────────────────────────────

function findLastEventIndex(
  events: NexusEvent[],
  predicate: (event: NexusEvent) => boolean,
): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event && predicate(event)) return index
  }
  return -1
}

function countToolStarted(events: NexusEvent[]): number {
  let n = 0
  for (const event of events) {
    if (event?.type === 'tool_started') n += 1
  }
  return n
}

function extractToolPath(event: NexusEvent): string | undefined {
  if (event.type !== 'tool_started') return undefined
  const input = (event as Extract<NexusEvent, { type: 'tool_started' }>).input as Record<string, unknown> | undefined
  if (!input || typeof input !== 'object') return undefined
  for (const field of PATH_FIELDS) {
    const value = input[field]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

function extractToolName(event: NexusEvent): string | undefined {
  if (event.type !== 'tool_started') return undefined
  const evt = event as Extract<NexusEvent, { type: 'tool_started' }>
  for (const field of TOOL_NAME_FIELDS) {
    const value = (evt as unknown as Record<string, unknown>)[field]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

function countRetries(events: NexusEvent[]): number {
  const toolUseIds = new Map<string, number>()
  for (const event of events) {
    if (event.type === 'tool_started') {
      const id = (event as Extract<NexusEvent, { type: 'tool_started' }>).toolUseId
      if (id) toolUseIds.set(id, (toolUseIds.get(id) ?? 0) + 1)
    }
  }
  let retries = 0
  for (const count of toolUseIds.values()) {
    if (count > 1) retries += count - 1
  }
  return retries
}

function extractSessionStartMs(events: NexusEvent[]): number | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'session_started') {
      const ts = (event as Extract<NexusEvent, { type: 'session_started' }>).timestamp
      const ms = Date.parse(ts)
      if (Number.isFinite(ms)) return ms
    }
  }
  return undefined
}

function globToRegex(pattern: string): RegExp {
  // Char-by-char conversion:
  //   ** → .*   (greedy multi-segment)
  //    * → [^/]* (single segment, no slashes)
  //   all other regex specials → escaped literal
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

function classifyErrorLikelyCause(errorCode: string | undefined): string {
  if (!errorCode) return 'unknown-error'
  if (errorCode.startsWith('TOOL_NOT_FOUND')) return 'tool-or-path-missing'
  if (errorCode.startsWith('TOOL_ERROR')) return 'tool-execution-failed'
  if (errorCode.startsWith('PROVIDER_ERROR')) return 'upstream-provider-error'
  if (errorCode.startsWith('TOOL_CALL_SUPPRESSED')) return 'tool-suppressed-by-intent'
  if (errorCode.startsWith('REQUEST_TIMEOUT') || errorCode.startsWith('EXECUTION_TIMEOUT')) {
    return 'timeout'
  }
  return errorCode.toLowerCase()
}

// Re-export tool-name extraction for testing only; not part of public surface.
export const __test__ = { extractToolName, extractToolPath, globToRegex, classifyErrorLikelyCause }
