import { performance } from 'node:perf_hooks'
import { eventBase, type NexusEvent } from '../shared/events.js'
import type { NexusStorage } from '../storage/Storage.js'
import type { ModelMessage } from '../providers/adapters/ModelAdapter.js'
import {
  allocateBudget,
  buildRetainedSegmentMetadata,
  protectToolPairs,
  selectOmittedEvents,
} from './contextAssembler.js'
import { summarizeSessionEvents } from './sessionSummary.js'
import { llmSummarizeEventsWithUsage } from './compactSummary.js'
import { estimateContextTokens } from './tokenEstimator.js'
import { shouldUpdateSessionMemoryLite, updateSessionMemoryLite } from './sessionMemoryLite.js'
import { resolveCompactionMode } from './compactionMode.js'
import { computeGroundingScopeFromEvents, type GroundingScope } from './compactionAuthority.js'
import { buildDeterministicDigest, mergeDigests, normalizeCompactionDigest, renderDigest } from './compactionDigest.js'
import { buildRetrievalIndex, isRetrievalCompactionEnabled, renderRetrievalPointers } from './retrievalDigest.js'
import { buildSummaryCacheKey, getCachedSummary, isSummaryCacheEnabled, setCachedSummary } from './summaryCache.js'
import { recordPayback } from './paybackController.js'

export type CompactTrigger = 'manual' | 'auto' | 'reactive'

export type CompactSessionOptions = {
  storage: NexusStorage
  sessionId: string
  modelId?: string
  trigger?: CompactTrigger
  persist?: boolean
  mapEventsToMessages?: (events: NexusEvent[], initialPrompt: string) => ModelMessage[]
  initialPrompt?: string
}

export type CompactSessionResult = {
  event: Extract<NexusEvent, { type: 'compact_boundary' }>
  contextEvent: Extract<NexusEvent, { type: 'context_compact_boundary' }>
  beforeEventCount: number
  afterEventCount: number
  summaryLatencyMs: number
  /** Present only in `adaptive` mode; narrows post-compact grounding. */
  groundingScope?: GroundingScope
}

export type AutoCompactDecision = {
  enabled: boolean
  shouldCompact: boolean
  thresholdPercent: number
  failureCount: number
  failureLimit: number
  fuseOpen: boolean
}

export async function compactSession(
  options: CompactSessionOptions,
): Promise<CompactSessionResult> {
  const modelId = options.modelId ?? 'local/coding-runtime'
  const budget = allocateBudget(modelId)
  // Load the newest events, then restore chronological order. The previous
  // `order: 'asc' + limit` read the OLDEST 10k events, so any session with
  // more than 10k events (delta events count) compacted a stale window and
  // could drop the current user instruction.
  const listed = await options.storage.listEvents(options.sessionId, {
    limit: 10_000,
    order: 'desc',
  })
  const events = [...listed.events].reverse()
  const mapFn = options.mapEventsToMessages
  const sessionCwd = inferSessionCwd(events) ?? await inferStoredSessionCwd(options.storage, options.sessionId)
  const groundingScope = resolveCompactionMode() === 'adaptive' && sessionCwd
    ? await computeGroundingScopeFromEvents(events, sessionCwd)
    : undefined

  const previousBoundary = findLatestCompactBoundary(events)
  const previousRetainedEvents = previousBoundary
    ? normalizeRetainedEvents(previousBoundary.event.retainedEvents)
    : []
  const compactableEvents = previousBoundary
    ? [...previousRetainedEvents, ...events.slice(previousBoundary.index + 1)]
    : events
  const selectedEvents = protectToolPairs(
    compactableEvents,
    selectCompactionWindow(compactableEvents, budget, options.initialPrompt ?? '', mapFn),
  )
  // Fail closed if the window would drop the instruction the turn is acting on.
  const newestUserMessage = [...compactableEvents].reverse().find(event => event.type === 'user_message')
  if (newestUserMessage && !selectedEvents.includes(newestUserMessage)) {
    throw new Error('compaction window would drop the current user message')
  }
  const omittedEvents = selectOmittedEvents(compactableEvents, selectedEvents)
  const beforeTokenEstimate = estimateEventsAsProviderTokens(
    compactableEvents,
    options.initialPrompt ?? '',
    undefined,
    mapFn,
  )
  const priorSummary = previousBoundary?.event.summary.trim()
  const summaryStartMs = performance.now()
  let newSummary: string
  let summaryUsage = { inputTokens: 0, outputTokens: 0 }
  let digestState: ReturnType<typeof buildDeterministicDigest> | undefined
  if (resolveCompactionMode() === 'adaptive') {
    // T2: deterministic structured digest. P3 opt-in: pointers instead of a
    // digest, so the model retrieves exact slices via contextSearch.
    if (isRetrievalCompactionEnabled()) {
      newSummary = renderRetrievalPointers(
        buildRetrievalIndex(omittedEvents),
        budget.layerBudgets.summary * 4,
      )
    } else {
      const previousDigest = normalizeCompactionDigest(previousBoundary?.event.digest)
      const deltaDigest = buildDeterministicDigest(omittedEvents)
      digestState = previousDigest ? mergeDigests(previousDigest, deltaDigest) : deltaDigest
      newSummary = renderDigest(digestState, budget.layerBudgets.summary * 4)
    }
  } else if (mapFn && modelId !== 'local/coding-runtime') {
    const cacheEnabled = isSummaryCacheEnabled()
    const cacheKey = cacheEnabled ? buildSummaryCacheKey(omittedEvents, modelId) : undefined
    const cached = cacheKey ? getCachedSummary(cacheKey) : undefined
    if (cached) {
      newSummary = cached.text
      summaryUsage = cached.usage
    } else {
      const summarized = await llmSummarizeEventsWithUsage(omittedEvents, modelId, {
        mapEventsToMessages: mapFn,
        initialPrompt: options.initialPrompt,
      })
      newSummary = summarized.text
      summaryUsage = summarized.usage
      if (cacheKey) {
        setCachedSummary(cacheKey, { text: newSummary, usage: summaryUsage })
      }
    }
  } else {
    newSummary = summarizeSessionEvents(
      omittedEvents,
      budget.layerBudgets.summary * 4,
    )
  }
  const summaryLatencyMs = performance.now() - summaryStartMs
  const summary = [priorSummary, newSummary]
    .filter((part): part is string => Boolean(part && part.trim()))
    .join('\n')
    .trim()
  const fallbackSummary = summary || 'Manual compact boundary created; no earlier events required summarization.'
  const afterTokenEstimate = estimateEventsAsProviderTokens(
    selectedEvents,
    options.initialPrompt ?? '',
    fallbackSummary,
    mapFn,
  )

  const event: Extract<NexusEvent, { type: 'compact_boundary' }> = {
    type: 'compact_boundary',
    ...eventBase(options.sessionId),
    trigger: options.trigger ?? 'manual',
    summary: fallbackSummary,
    beforeEventCount: events.length,
    afterEventCount: selectedEvents.length + 1,
    summaryChars: fallbackSummary.length,
    snippedToolResults: countLargeToolResults(omittedEvents, budget.snipToolOutputChars),
    preTokens: beforeTokenEstimate,
    postTokens: afterTokenEstimate,
    estimatedTokensSaved: Math.max(0, beforeTokenEstimate - afterTokenEstimate),
    ...(summaryUsage.inputTokens > 0 || summaryUsage.outputTokens > 0
      ? {
          summaryInputTokens: summaryUsage.inputTokens,
          summaryOutputTokens: summaryUsage.outputTokens,
        }
      : {}),
    ...(digestState ? { digest: digestState } : {}),
    retainedEvents: selectedEvents,
    modelId,
    budget,
  }
  event.retainedSegment = buildRetainedSegmentMetadata(selectedEvents, event)
  const contextEvent = buildContextCompactBoundaryEvent(event)

  if (options.persist !== false) {
    await options.storage.appendEvent(options.sessionId, event)
    await options.storage.appendEvent(options.sessionId, contextEvent)
    const memoryDecision = shouldUpdateSessionMemoryLite(events, { force: true })
    const memoryEvent = await updateSessionMemoryLite({
      sessionId: options.sessionId,
      cwd: sessionCwd,
      trigger: event.trigger,
      reason: 'compact',
      decisionReason: memoryDecision.reason,
      estimatedTokensSinceLastUpdate: memoryDecision.estimatedTokensSinceLastUpdate,
      toolCallCount: memoryDecision.toolCallCount,
      summaryMaxChars: budget.layerBudgets.summary * 4,
      summary: fallbackSummary,
      eventCount: omittedEvents.length,
    })
    if (memoryEvent) {
      await options.storage.appendEvent(options.sessionId, memoryEvent)
    }
  }

  return {
    event,
    contextEvent,
    beforeEventCount: event.beforeEventCount,
    afterEventCount: event.afterEventCount,
    summaryLatencyMs,
    ...(groundingScope ? { groundingScope } : {}),
  }
}

export function buildContextCompactBoundaryEvent(
  boundary: Extract<NexusEvent, { type: 'compact_boundary' }>,
): Extract<NexusEvent, { type: 'context_compact_boundary' }> {
  const retainedSegment = boundary.retainedSegment
  const retainedEventCount = Array.isArray(boundary.retainedEvents)
    ? boundary.retainedEvents.length
    : (retainedSegment?.retainedCount ?? Math.max(0, boundary.afterEventCount - 1))
  const messagesSummarized = Math.max(0, boundary.beforeEventCount - retainedEventCount)
  const droppedItemCount = Math.max(0, boundary.beforeEventCount - retainedEventCount)
  const boundaryId = retainedSegment?.boundaryId ?? `${boundary.sessionId}:${boundary.timestamp}:compact_boundary`
  const summary = boundary.summary.trim()
  const userVisibleSummary = summary ? truncate(summary, 500) : undefined
  const droppedReasons = boundary.snippedToolResults > 0
    ? { large_tool_result: boundary.snippedToolResults }
    : undefined
  return {
    type: 'context_compact_boundary',
    ...eventBase(boundary.sessionId),
    boundaryId,
    sourceBoundaryTimestamp: boundary.timestamp,
    trigger: boundary.trigger,
    beforeEventCount: boundary.beforeEventCount,
    afterEventCount: boundary.afterEventCount,
    ...(boundary.preTokens !== undefined && { preTokens: boundary.preTokens }),
    ...(boundary.postTokens !== undefined && { postTokens: boundary.postTokens }),
    ...(boundary.estimatedTokensSaved !== undefined && { estimatedTokensSaved: boundary.estimatedTokensSaved }),
    ...(boundary.summaryInputTokens !== undefined && { summaryInputTokens: boundary.summaryInputTokens }),
    ...(boundary.summaryOutputTokens !== undefined && { summaryOutputTokens: boundary.summaryOutputTokens }),
    summaryChars: boundary.summaryChars,
    snippedToolResults: boundary.snippedToolResults,
    messagesSummarized,
    droppedItemCount,
    retainedEventCount,
    retainedItemCount: retainedEventCount,
    ...(droppedReasons && { droppedReasons }),
    ...(retainedSegment?.firstEventId && { preservedFirstEventId: retainedSegment.firstEventId }),
    ...(retainedSegment?.lastEventId && { preservedTailEventId: retainedSegment.lastEventId }),
    ...(retainedSegment?.hash && { retainedSegmentHash: retainedSegment.hash }),
    ...(boundary.modelId && { modelId: boundary.modelId }),
    ...(userVisibleSummary && { userVisibleSummary }),
    message: `Context compact boundary ${boundary.trigger}: ${boundary.beforeEventCount} -> ${boundary.afterEventCount} events; retained ${retainedEventCount}.`,
  }
}

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, Math.max(0, maxChars - 1))}…`
}

const MIN_RETAINED_TURNS = 2
const RETAINED_TOKEN_FRACTION = 0.2

function estimateEventsForSelection(
  events: NexusEvent[],
  initialPrompt: string,
  mapFn?: (events: NexusEvent[], initialPrompt: string) => ModelMessage[],
): number {
  if (mapFn) {
    return estimateContextTokens({ messages: mapFn(events, initialPrompt) }).totalTokens
  }
  return estimateEventsAsProviderTokens(events, initialPrompt)
}

/**
 * Newest-first, soft token-budgeted window. Always keeps the current user
 * message and at least the previous turn so a single oversized tool result
 * cannot evict the instruction the turn is acting on.
 */
function selectCompactionWindow(
  events: NexusEvent[],
  budget: ReturnType<typeof allocateBudget>,
  initialPrompt: string,
  mapFn?: (events: NexusEvent[], initialPrompt: string) => ModelMessage[],
): NexusEvent[] {
  const userIndexes: number[] = []
  events.forEach((event, index) => {
    if (event.type === 'user_message') userIndexes.push(index)
  })
  if (userIndexes.length === 0) return events

  const lastUserIndex = userIndexes[userIndexes.length - 1]!
  const maxRetainedTokens = Math.max(
    2_000,
    Math.floor(budget.maxTokens * RETAINED_TOKEN_FRACTION),
  )
  let startIndex = lastUserIndex
  let keptTurns = 1

  for (let index = userIndexes.length - 2; index >= 0; index -= 1) {
    const candidateStart = userIndexes[index]!
    const candidateEstimate = estimateEventsForSelection(
      events.slice(candidateStart),
      initialPrompt,
      mapFn,
    )
    if (keptTurns >= MIN_RETAINED_TURNS && candidateEstimate > maxRetainedTokens) break
    startIndex = candidateStart
    keptTurns += 1
  }

  return events.slice(startIndex)
}

function estimateEventsAsProviderTokens(
  events: NexusEvent[],
  initialPrompt: string,
  summary?: string,
  mapFn?: (events: NexusEvent[], initialPrompt: string) => ModelMessage[],
): number {
  if (mapFn) {
    const messages = mapFn(events, initialPrompt)
    const messageTokens = estimateContextTokens({ messages }).totalTokens
    return messageTokens + (summary ? Math.ceil(summary.length / 4) : 0)
  }

  // Content-only fallback: never stringify event metadata/delta streams, which
  // inflated the old pre/post ledger by 3-13x relative to the trigger estimate.
  const content = events
    .map(event => {
      if (event.type === 'user_message') return `user: ${event.text}`
      if (event.type === 'tool_started') return `tool call: ${JSON.stringify(event.input)}`
      if (event.type === 'tool_completed') {
        const output = typeof event.output === 'string'
          ? event.output
          : JSON.stringify(event.output)
        return `tool result (${event.name}): ${output}`
      }
      return ''
    })
    .filter(Boolean)
    .join('\n')
  const text = [
    summary ? `Compact summary:\n${summary}` : '',
    content,
    initialPrompt,
  ].filter(Boolean).join('\n')
  return estimateContextTokens({ messages: [{ role: 'user', content: text }] }).totalTokens
}

const recordedBoundaryPaybacks = new Set<string>()

/**
 * Record the realized payback of the latest compact boundary once usage for
 * the following call exists. The prediction is the boundary's pre/post delta;
 * the realization is the actual provider prompt reduction. This feeds
 * `getPaybackMultiplier` used by adaptive admission.
 */
export function recordBoundaryPayback(sessionId: string, events: NexusEvent[]): void {
  let boundaryIndex = -1
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.type === 'compact_boundary') {
      boundaryIndex = index
      break
    }
  }
  if (boundaryIndex < 0) return
  const boundary = events[boundaryIndex] as Extract<NexusEvent, { type: 'compact_boundary' }>
  const key = `${sessionId}:${boundary.timestamp}`
  if (recordedBoundaryPaybacks.has(key)) return
  let before: Extract<NexusEvent, { type: 'usage' }> | undefined
  for (let index = boundaryIndex - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'usage') { before = event; break }
  }
  let after: Extract<NexusEvent, { type: 'usage' }> | undefined
  for (let index = boundaryIndex + 1; index < events.length; index += 1) {
    const event = events[index]
    if (event?.type === 'usage') { after = event; break }
  }
  if (!before || !after) return
  const predicted = Math.max(0, (boundary.preTokens ?? 0) - (boundary.postTokens ?? 0))
  if (predicted <= 0) return
  const realized = Math.max(0, before.inputTokens - after.inputTokens)
  recordPayback(sessionId, predicted, realized)
  recordedBoundaryPaybacks.add(key)
}

function inferSessionCwd(events: NexusEvent[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'session_started') {
      return event.cwd
    }
  }
  return undefined
}

async function inferStoredSessionCwd(
  storage: NexusStorage,
  sessionId: string,
): Promise<string | undefined> {
  try {
    const session = await storage.getSession(sessionId, { includeEvents: false })
    return session?.cwd
  } catch {
    return undefined
  }
}

export function getAutoCompactDecision(options: {
  events: NexusEvent[]
  tokenEstimate: number
  maxTokens: number
  enabled?: boolean
  thresholdPercent?: number
  failureLimit?: number
}): AutoCompactDecision {
  const enabled = options.enabled ?? isAutoCompactEnabled()
  // The documented env knob wins over the caller's runtime default. Before
  // this, contextRefresh always passed the hardcoded 90% and the env var was
  // silently ignored.
  const thresholdPercent = clampPercent(
    readPercentEnv('BABEL_O_AUTO_COMPACT_THRESHOLD_PERCENT', options.thresholdPercent ?? 90),
  )
  const failureLimit = Math.max(
    1,
    readPositiveIntEnv('BABEL_O_AUTO_COMPACT_FAILURE_LIMIT', options.failureLimit ?? 2),
  )
  const failureCount = countConsecutiveAutoCompactFailures(options.events)
  const fuseOpen = failureCount >= failureLimit
  const percentUsed = options.maxTokens > 0
    ? (options.tokenEstimate / options.maxTokens) * 100
    : 0

  return {
    enabled,
    shouldCompact: enabled && !fuseOpen && percentUsed >= thresholdPercent,
    thresholdPercent,
    failureCount,
    failureLimit,
    fuseOpen,
  }
}

export function buildCompactFailureEvent(options: {
  sessionId: string
  trigger: CompactTrigger
  modelId?: string
  failureCount: number
  maxFailures: number
  message: string
}): Extract<NexusEvent, { type: 'compact_failure' }> {
  return {
    type: 'compact_failure',
    ...eventBase(options.sessionId),
    trigger: options.trigger,
    modelId: options.modelId,
    failureCount: options.failureCount,
    maxFailures: options.maxFailures,
    message: options.message,
  }
}

export function countConsecutiveAutoCompactFailures(events: NexusEvent[]): number {
  let count = 0
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (!event) continue
    if (event.type === 'compact_boundary') {
      return count
    }
    if (event.type === 'compact_failure' && event.trigger === 'auto') {
      count += 1
      continue
    }
  }
  return count
}

function findLatestCompactBoundary(events: NexusEvent[]): {
  event: Extract<NexusEvent, { type: 'compact_boundary' }>
  index: number
} | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'compact_boundary') {
      return { event, index }
    }
  }
  return undefined
}

function countLargeToolResults(events: NexusEvent[], thresholdChars: number): number {
  let count = 0
  for (const event of events) {
    if (event.type !== 'tool_completed') continue
    const output = typeof event.output === 'string'
      ? event.output
      : JSON.stringify(event.output)
    if (output.length > thresholdChars) count += 1
  }
  return count
}

function normalizeRetainedEvents(value: unknown): NexusEvent[] {
  if (!Array.isArray(value)) return []
  return value.filter(isNexusEventLike)
}

function isNexusEventLike(value: unknown): value is NexusEvent {
  return Boolean(
    value &&
    typeof value === 'object' &&
    'type' in value &&
    'sessionId' in value &&
    'timestamp' in value,
  )
}

function isAutoCompactEnabled(): boolean {
  const raw = (process.env.BABEL_O_AUTO_COMPACT ?? '').trim().toLowerCase()
  if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') return false
  if (raw === '' || raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on') return true
  return true
}

function readPercentEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : fallback
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 90
  return Math.max(50, Math.min(99, value))
}
