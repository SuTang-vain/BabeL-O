import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { eventBase, type NexusEvent } from '../shared/events.js'
import type { NexusStorage } from '../storage/Storage.js'
import { logger } from '../shared/logger.js'
import { summarizeSessionEvents } from './sessionSummary.js'

const SESSION_MEMORY_RELATIVE_PATH = '.babel-o/session-memory.md'
const MAX_SESSION_MEMORY_CHARS = 24_000
const DEFAULT_PAUSE_SUMMARY_MAX_CHARS = 4_000
const DEFAULT_MIN_ESTIMATED_TOKENS_SINCE_LAST_UPDATE = 30_000
const DEFAULT_MIN_TOOL_CALLS_SINCE_LAST_UPDATE = 15
const DEFAULT_MAX_SUMMARY_CHARS = DEFAULT_PAUSE_SUMMARY_MAX_CHARS

export type SessionMemoryLiteTrigger = 'manual' | 'auto' | 'reactive'
export type SessionMemoryLiteReason = 'compact' | 'pause'
export type SessionMemoryLiteUpdateMode = 'extractive'

export type SessionMemoryLiteCostPolicy = {
  summaryMode: SessionMemoryLiteUpdateMode
  maxSummaryChars: number
  minEstimatedTokensSinceLastUpdate: number
  minToolCallsSinceLastUpdate: number
  modelFallback: 'extractive-only'
}

export type SessionMemoryLiteStatus = {
  enabled: boolean
  path: string
  lastUpdate: {
    trigger: SessionMemoryLiteTrigger
    timestamp: string
    summaryChars: number
    eventCount: number
    reason: SessionMemoryLiteReason | ''
    decisionReason: SessionMemoryLiteDecision['reason'] | ''
    estimatedTokensSinceLastUpdate: number
    toolCallCount: number
  } | null
  nextDecision: SessionMemoryLiteDecision
  costPolicy: SessionMemoryLiteCostPolicy
}

export type SessionMemoryLiteDecision = {
  shouldUpdate: boolean
  reason: 'disabled' | 'duplicate_turn' | 'natural_pause' | 'growth_threshold' | 'forced' | 'insufficient_signal'
  startIndex: number
  eventCount: number
  toolCallCount: number
  estimatedTokensSinceLastUpdate: number
}

let sessionMemoryQueue: Promise<void> = Promise.resolve()

export async function updateSessionMemoryLite(options: {
  sessionId: string
  cwd?: string
  trigger: SessionMemoryLiteTrigger
  summary: string
  eventCount: number
  reason?: SessionMemoryLiteReason
  decisionReason?: SessionMemoryLiteDecision['reason']
  estimatedTokensSinceLastUpdate?: number
  toolCallCount?: number
  summaryMaxChars?: number
}): Promise<Extract<NexusEvent, { type: 'session_memory_updated' }> | null> {
  if (!isSessionMemoryLiteEnabled()) return null
  if (!options.cwd) return null

  const memoryPath = resolve(options.cwd, SESSION_MEMORY_RELATIVE_PATH)
  const allowedPath = resolve(options.cwd, SESSION_MEMORY_RELATIVE_PATH)
  if (memoryPath !== allowedPath) return null

  const summary = options.summary.trim()
  if (!summary) return null

  const reason = options.reason ?? 'compact'
  await mkdir(dirname(memoryPath), { recursive: true })
  const existing = await readExistingMemory(memoryPath)
  const entry = [
    `## ${new Date().toISOString()} ${options.trigger} ${reason}`,
    '',
    `- Session: ${options.sessionId}`,
    reason === 'compact'
      ? `- Omitted events summarized: ${options.eventCount}`
      : `- Events summarized: ${options.eventCount}`,
    '',
    summary,
    '',
  ].join('\n')
  const next = trimMemory(`${existing}${existing ? '\n' : ''}${entry}`)
  await writeFile(memoryPath, next, 'utf8')

  return {
    type: 'session_memory_updated',
    ...eventBase(options.sessionId),
    path: SESSION_MEMORY_RELATIVE_PATH,
    trigger: options.trigger,
    summaryChars: summary.length,
    eventCount: options.eventCount,
    reason,
    decisionReason: options.decisionReason ?? 'forced',
    estimatedTokensSinceLastUpdate: options.estimatedTokensSinceLastUpdate ?? 0,
    toolCallCount: options.toolCallCount ?? 0,
    summaryMaxChars: options.summaryMaxChars ?? DEFAULT_MAX_SUMMARY_CHARS,
    summaryMode: 'extractive',
  }
}

export function queueSessionMemoryLiteUpdate(options: {
  storage: NexusStorage
  sessionId: string
  cwd?: string
  trigger?: SessionMemoryLiteTrigger
  reason?: SessionMemoryLiteReason
  force?: boolean
  minEstimatedTokensSinceLastUpdate?: number
  minToolCallsSinceLastUpdate?: number
  summaryMaxChars?: number
}): void {
  if (!isSessionMemoryLiteEnabled()) return
  sessionMemoryQueue = sessionMemoryQueue
    .then(() => runQueuedSessionMemoryLiteUpdate(options))
    .catch(error => {
      logger.debug('Session Memory Lite background update failed', error)
    })
}

export async function flushSessionMemoryLiteQueue(): Promise<void> {
  await sessionMemoryQueue
}

export function buildSessionMemoryLiteStatus(
  events: NexusEvent[],
  options: {
    summaryMaxChars?: number
    minEstimatedTokensSinceLastUpdate?: number
    minToolCallsSinceLastUpdate?: number
  } = {},
): SessionMemoryLiteStatus {
  const costPolicy = buildSessionMemoryLiteCostPolicy(options)
  const lastUpdate = findLatestSessionMemoryUpdate(events)
  return {
    enabled: isSessionMemoryLiteEnabled(),
    path: SESSION_MEMORY_RELATIVE_PATH,
    lastUpdate: lastUpdate
      ? {
          trigger: lastUpdate.trigger,
          timestamp: lastUpdate.timestamp,
          summaryChars: lastUpdate.summaryChars,
          eventCount: lastUpdate.eventCount,
          reason: getSessionMemoryEventString(lastUpdate, 'reason') as SessionMemoryLiteReason | '',
          decisionReason: getSessionMemoryEventString(lastUpdate, 'decisionReason') as SessionMemoryLiteDecision['reason'] | '',
          estimatedTokensSinceLastUpdate: getSessionMemoryEventNumber(lastUpdate, 'estimatedTokensSinceLastUpdate'),
          toolCallCount: getSessionMemoryEventNumber(lastUpdate, 'toolCallCount'),
        }
      : null,
    nextDecision: shouldUpdateSessionMemoryLite(events, {
      minEstimatedTokensSinceLastUpdate: costPolicy.minEstimatedTokensSinceLastUpdate,
      minToolCallsSinceLastUpdate: costPolicy.minToolCallsSinceLastUpdate,
    }),
    costPolicy,
  }
}

export function buildSessionMemoryLiteCostPolicy(options: {
  summaryMaxChars?: number
  minEstimatedTokensSinceLastUpdate?: number
  minToolCallsSinceLastUpdate?: number
} = {}): SessionMemoryLiteCostPolicy {
  return {
    summaryMode: 'extractive',
    maxSummaryChars: options.summaryMaxChars ?? DEFAULT_MAX_SUMMARY_CHARS,
    minEstimatedTokensSinceLastUpdate: options.minEstimatedTokensSinceLastUpdate ?? DEFAULT_MIN_ESTIMATED_TOKENS_SINCE_LAST_UPDATE,
    minToolCallsSinceLastUpdate: options.minToolCallsSinceLastUpdate ?? DEFAULT_MIN_TOOL_CALLS_SINCE_LAST_UPDATE,
    modelFallback: 'extractive-only',
  }
}

export function shouldUpdateSessionMemoryLite(
  events: NexusEvent[],
  options: {
    force?: boolean
    minEstimatedTokensSinceLastUpdate?: number
    minToolCallsSinceLastUpdate?: number
  } = {},
): SessionMemoryLiteDecision {
  const lastMemoryIndex = findLastEventIndex(events, event => event.type === 'session_memory_updated')
  const latestUserIndex = findLastEventIndex(events, event => event.type === 'user_message')
  const startIndex = Math.max(0, lastMemoryIndex + 1)
  const eventsSinceLastUpdate = events.slice(startIndex)
  const toolCallCount = eventsSinceLastUpdate.filter(event => event.type === 'tool_started').length
  const estimatedTokensSinceLastUpdate = estimateEventsTokens(eventsSinceLastUpdate)
  const eventCount = eventsSinceLastUpdate.filter(event => event.type !== 'session_memory_updated').length

  if (options.force) {
    return {
      shouldUpdate: eventCount > 0,
      reason: eventCount > 0 ? 'forced' : 'insufficient_signal',
      startIndex,
      eventCount,
      toolCallCount,
      estimatedTokensSinceLastUpdate,
    }
  }

  const hasMemoryAfterLatestUser = latestUserIndex >= 0
    ? events.slice(latestUserIndex + 1).some(event => event.type === 'session_memory_updated')
    : false
  if (hasMemoryAfterLatestUser) {
    return {
      shouldUpdate: false,
      reason: 'duplicate_turn',
      startIndex,
      eventCount,
      toolCallCount,
      estimatedTokensSinceLastUpdate,
    }
  }

  const latestTurnEvents = latestUserIndex >= 0 ? events.slice(latestUserIndex + 1) : events
  const latestTurnHasTools = latestTurnEvents.some(event => event.type === 'tool_started')
  // DEPRECATED (Track B Phase 1, see docs/nexus/reference/behavior-monitor.md §13):
  // The `natural_pause` reason is preserved for backward compatibility but is
  // suppressed by default via BABEL_O_NATURAL_PAUSE_SUPPRESS (P0). Phase 2 will
  // reroute this to behaviorTrace.ts as a `user-redirect` / `trajectory-end`
  // trigger. Until then, this branch is dormant in production sessions.
  if (
    latestUserIndex >= 0
    && !latestTurnHasTools
    && eventCount > 0
    && !isNaturalPauseSuppressed()
  ) {
    return {
      shouldUpdate: true,
      reason: 'natural_pause',
      startIndex,
      eventCount,
      toolCallCount,
      estimatedTokensSinceLastUpdate,
    }
  }

  const minTokens = options.minEstimatedTokensSinceLastUpdate
    ?? DEFAULT_MIN_ESTIMATED_TOKENS_SINCE_LAST_UPDATE
  const minToolCalls = options.minToolCallsSinceLastUpdate
    ?? DEFAULT_MIN_TOOL_CALLS_SINCE_LAST_UPDATE
  if (
    estimatedTokensSinceLastUpdate >= minTokens &&
    toolCallCount >= minToolCalls &&
    eventCount > 0
  ) {
    return {
      shouldUpdate: true,
      reason: 'growth_threshold',
      startIndex,
      eventCount,
      toolCallCount,
      estimatedTokensSinceLastUpdate,
    }
  }

  return {
    shouldUpdate: false,
    reason: 'insufficient_signal',
    startIndex,
    eventCount,
    toolCallCount,
    estimatedTokensSinceLastUpdate,
  }
}

async function runQueuedSessionMemoryLiteUpdate(options: {
  storage: NexusStorage
  sessionId: string
  cwd?: string
  trigger?: SessionMemoryLiteTrigger
  reason?: SessionMemoryLiteReason
  force?: boolean
  minEstimatedTokensSinceLastUpdate?: number
  minToolCallsSinceLastUpdate?: number
  summaryMaxChars?: number
}): Promise<void> {
  const { events } = await options.storage.listEvents(options.sessionId, {
    limit: 10_000,
    order: 'asc',
  })
  const decision = shouldUpdateSessionMemoryLite(events, options)
  if (!decision.shouldUpdate) return

  const summaryEvents = events
    .slice(decision.startIndex)
    .filter(event => event.type !== 'session_memory_updated')
  const summary = summarizeSessionEvents(
    summaryEvents,
    options.summaryMaxChars ?? DEFAULT_PAUSE_SUMMARY_MAX_CHARS,
  )
  const summaryMaxChars = options.summaryMaxChars ?? DEFAULT_PAUSE_SUMMARY_MAX_CHARS
  const memoryEvent = await updateSessionMemoryLite({
    sessionId: options.sessionId,
    cwd: options.cwd ?? inferSessionCwd(events),
    trigger: options.trigger ?? 'reactive',
    reason: options.reason ?? 'pause',
    decisionReason: decision.reason,
    estimatedTokensSinceLastUpdate: decision.estimatedTokensSinceLastUpdate,
    toolCallCount: decision.toolCallCount,
    summaryMaxChars,
    summary,
    eventCount: summaryEvents.length,
  })
  if (memoryEvent) {
    await options.storage.appendEvent(options.sessionId, memoryEvent)
  }
}

function isSessionMemoryLiteEnabled(): boolean {
  const raw = (process.env.BABEL_O_SESSION_MEMORY_LITE ?? '').trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on'
}

// Tracks [long-running-context-assembly §13 Phase 0]:
// `natural_pause` fires on every non-tool turn by default, which the
// user reported as overly aggressive. Default = suppressed so users
// get immediate pain relief without opt-in. Tests that need to verify
// the natural_pause path explicitly set BABEL_O_NATURAL_PAUSE_SUPPRESS=false.
function isNaturalPauseSuppressed(): boolean {
  const raw = (process.env.BABEL_O_NATURAL_PAUSE_SUPPRESS ?? '').trim().toLowerCase()
  if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') return false
  if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on') return true
  return true
}

async function readExistingMemory(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return ''
  }
}

function trimMemory(content: string): string {
  if (content.length <= MAX_SESSION_MEMORY_CHARS) return content
  return [
    '<!-- Older session memory trimmed by BabeL-O Session Memory Lite. -->',
    content.slice(content.length - MAX_SESSION_MEMORY_CHARS),
  ].join('\n')
}

function findLatestSessionMemoryUpdate(events: NexusEvent[]): Extract<NexusEvent, { type: 'session_memory_updated' }> | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'session_memory_updated') return event
  }
  return null
}

function getSessionMemoryEventString(event: NexusEvent, key: string): string {
  const value = (event as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : ''
}

function getSessionMemoryEventNumber(event: NexusEvent, key: string): number {
  const value = (event as Record<string, unknown>)[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

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

function estimateEventsTokens(events: NexusEvent[]): number {
  const chars = events.reduce((total, event) => total + JSON.stringify(event).length, 0)
  return Math.ceil(chars / 4)
}

function inferSessionCwd(events: NexusEvent[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'session_started') return event.cwd
  }
  return undefined
}
