import type { NexusEvent } from '../shared/events.js'
import type { RuntimeExecuteOptions } from './Runtime.js'
import type { ModelMessage, SystemPromptBlock } from '../providers/adapters/ModelAdapter.js'
import { getModel } from '../providers/registry.js'
import { snipEventsWithTurnBoundary } from './compactors/snipCompactor.js'
import { loadProjectMemory } from './memory.js'
import { buildSystemPromptSections } from './systemPromptBuilder.js'
import { summarizeSessionEvents } from './sessionSummary.js'
import { loadAgentMdFiles } from './agentMdLoader.js'
import { collectGitContext } from './gitContext.js'
import { loadAllSkills } from '../skills/loader.js'
import { matchSkills } from '../skills/matcher.js'
import type { Skill } from '../skills/loader.js'
import {
  deriveUserIntentGuidance,
  formatUserIntentGuidance,
  type UserIntentGuidance,
} from './intentGuidance.js'

export type ContextBudget = {
  maxTokens: number
  maxChars: number
  layerBudgets: {
    system: number
    memory: number
    summary: number
    recent: number
  }
  snipToolOutputChars: number
  snipPriorTurnToolOutputChars: number
  microcompactToolOutputChars: number
  microcompactInternalTextChars: number
  recentEventLimit: number
  recentTurnLimit: number
}

export type ContextAssemblerOptions = {
  runtimeOptions: RuntimeExecuteOptions
  events: NexusEvent[]
  modelId: string
  buildSystemPrompt: (
    options: RuntimeExecuteOptions,
    projectMemory?: string,
    sessionSummary?: string,
    activeSkills?: string,
  ) => string
  mapEventsToMessages: (events: NexusEvent[], initialPrompt: string) => ModelMessage[]
}

export type AssembledContext = {
  systemPrompt: string
  systemPromptBlocks?: SystemPromptBlock[]
  messages: ModelMessage[]
  budget: ContextBudget
  selectedEventCount: number
  omittedEventCount: number
  snippedEventCount: number
  sessionSummary: string
  projectMemory: string
  activeSkills: string
  compactBoundary?: Extract<NexusEvent, { type: 'compact_boundary' }>
  compactRetainedEventCount: number
  compactRetainedSegmentValid: boolean
  compactRetainedSegmentWarning: string
  postCompactState: PostCompactState
  userIntentGuidance: UserIntentGuidance
  memoryTruncated: boolean
  microcompactedEventCount: number
}

export type RetainedSegmentMetadata = {
  retainedCount: number
  boundaryId?: string
  firstEventId?: string
  lastEventId?: string
  hash: string
}

export const MAX_MEMORY_LINES = 200
export const MAX_MEMORY_BYTES = 25_000

export type MemoryTruncation = {
  content: string
  wasLineTruncated: boolean
  wasByteTruncated: boolean
  originalLines: number
  originalBytes: number
}

export function truncateMemoryContent(raw: string): MemoryTruncation {
  const trimmed = raw.trim()
  const lines = trimmed.split('\n')
  const originalLines = lines.length
  const originalBytes = trimmed.length

  const wasLineTruncated = originalLines > MAX_MEMORY_LINES
  let content = wasLineTruncated ? lines.slice(0, MAX_MEMORY_LINES).join('\n') : trimmed

  const wasByteTruncated = content.length > MAX_MEMORY_BYTES
  if (wasByteTruncated) {
    const cutAt = content.lastIndexOf('\n', MAX_MEMORY_BYTES)
    content = content.slice(0, cutAt > 0 ? cutAt : MAX_MEMORY_BYTES)
  }

  return {
    content,
    wasLineTruncated,
    wasByteTruncated,
    originalLines,
    originalBytes,
  }
}

export type PostCompactState = {
  recentReadFiles: string[]
  restoredFileContents: { path: string; content: string }[]
  activeToolNames: string[]
  activeSkills: string[]
  taskStatusLines: string[]
  hookLines: string[]
}

export function allocateBudget(modelId: string): ContextBudget {
  let contextWindow = 8192
  try {
    contextWindow = getModel(modelId).contextWindow
  } catch {
    contextWindow = 8192
  }

  const maxTokens = Math.min(Math.floor(contextWindow * 0.8), 120_000)
  const maxChars = maxTokens * 4
  const fixedBudget = 11_000

  return {
    maxTokens,
    maxChars,
    layerBudgets: {
      system: 5_000,
      memory: 2_000,
      summary: 4_000,
      recent: Math.max(1_000, maxTokens - fixedBudget),
    },
    snipToolOutputChars: Math.max(2_000, Math.min(20_000, Math.floor(maxChars * 0.08))),
    snipPriorTurnToolOutputChars: Math.max(500, Math.min(3_000, Math.floor(maxChars * 0.015))),
    microcompactToolOutputChars: Math.max(500, Math.min(4_000, Math.floor(maxChars * 0.012))),
    microcompactInternalTextChars: Math.max(200, Math.min(1_000, Math.floor(maxChars * 0.004))),
    recentEventLimit: Math.max(20, Math.min(300, Math.floor(maxTokens / 400))),
    recentTurnLimit: contextWindow >= 100_000 ? 4 : 2,
  }
}

export async function assembleContext(options: ContextAssemblerOptions): Promise<AssembledContext> {
  const budget = allocateBudget(options.modelId)
  const [projectMemory, agentMdContent, gitStatus] = await Promise.all([
    loadProjectMemory(options.runtimeOptions.cwd),
    loadAgentMdFiles(options.runtimeOptions.cwd),
    collectGitContext(options.runtimeOptions.cwd),
  ])
  const compactBoundary = findLatestCompactBoundary(options.events)
  const retainedBoundaryEvents = compactBoundary
    ? normalizeRetainedEvents(compactBoundary.event.retainedEvents)
    : []
  const retainedSegmentCheck = compactBoundary
    ? verifyRetainedSegment(retainedBoundaryEvents, compactBoundary.event.retainedSegment, compactBoundary.event)
    : { valid: true, warning: '' }
  const compactAwareEvents = compactBoundary && retainedSegmentCheck.valid
    ? [...retainedBoundaryEvents, ...options.events.slice(compactBoundary.index + 1)]
    : options.events
  const userIntentGuidance = deriveUserIntentGuidance({
    events: compactAwareEvents,
    latestPrompt: options.runtimeOptions.prompt,
    cwd: options.runtimeOptions.cwd,
  })
  const selectedEvents = protectToolPairs(
    compactAwareEvents,
    selectRecentEvents(compactAwareEvents, budget),
  )
  const omittedEvents = selectOmittedEvents(compactAwareEvents, selectedEvents)
  const compactSummary = compactBoundary?.event.summary.trim() ?? ''
  let sessionSummary = [
    compactSummary,
    summarizeSessionEvents(omittedEvents, budget.layerBudgets.summary * 4),
  ]
    .filter(part => part.trim().length > 0)
    .join('\n')
    .trim()
  const microcompactedEvents = microcompactEvents(selectedEvents, budget)
  const snippedEvents = snipEventsWithTurnBoundary(
    microcompactedEvents,
    budget.snipToolOutputChars,
    budget.snipPriorTurnToolOutputChars,
  )
  const messages = options.mapEventsToMessages(
    snippedEvents,
    options.runtimeOptions.prompt,
  )

  const allSkills = await loadAllSkills(options.runtimeOptions.cwd)
  const matched = matchSkills(allSkills, options.runtimeOptions.prompt)
  let activeSkills = ''
  if (matched.length > 0) {
    activeSkills = `Active Developer Skills:\n` + matched.map(skill => {
      return `## Skill: ${skill.name} (id: ${skill.id})\n${skill.content}`
    }).join('\n\n')
  }
  const postCompactState = derivePostCompactState(compactAwareEvents, matched)
  const stateBlock = formatPostCompactState(postCompactState)
  const compactCapabilityReminder = compactBoundary
    ? buildCompactCapabilityReminder(postCompactState)
    : ''
  if (compactBoundary && stateBlock) {
    sessionSummary = [sessionSummary, stateBlock]
      .filter(part => part.trim().length > 0)
      .join('\n')
      .trim()
  }
  if (compactCapabilityReminder) {
    sessionSummary = [sessionSummary, compactCapabilityReminder]
      .filter(part => part.trim().length > 0)
      .join('\n')
      .trim()
  }
  if (compactBoundary && !retainedSegmentCheck.valid) {
    sessionSummary = [
      sessionSummary,
      `Preserved Segment Warning: ${retainedSegmentCheck.warning}. Falling back to full session history for this context build.`,
    ]
      .filter(part => part.trim().length > 0)
      .join('\n')
      .trim()
  }

  const { projectMemory: budgetedProjectMemory, sessionSummary: budgetedSessionSummary, activeSkills: budgetedActiveSkills } =
    enforceDynamicLayerBudgets({
      projectMemory,
      sessionSummary,
      activeSkills,
      budget,
    })

  const memoryTruncation = truncateMemoryContent(budgetedProjectMemory)
  const sections = buildSystemPromptSections({
    cwd: options.runtimeOptions.cwd,
    platform: process.platform,
    projectMemory: memoryTruncation.content || undefined,
    sessionSummary: budgetedSessionSummary.trim() || undefined,
    activeSkills: budgetedActiveSkills.trim() || undefined,
    agentMdContent: agentMdContent || undefined,
    gitStatus: gitStatus || undefined,
    userIntentGuidance: formatUserIntentGuidance(userIntentGuidance),
    prompt: options.runtimeOptions.prompt,
  })
  const systemPromptBlocks: SystemPromptBlock[] = sections.map(s => ({
    text: s.content,
    cacheable: s.cacheable,
  }))
  const systemPrompt = sections.map(s => s.content).join('\n\n')

  return {
    systemPrompt,
    systemPromptBlocks,
    messages,
    budget,
    selectedEventCount: selectedEvents.length,
    omittedEventCount: omittedEvents.length,
    snippedEventCount: snippedEvents.filter((event, index) => event !== microcompactedEvents[index]).length,
    sessionSummary: budgetedSessionSummary,
    projectMemory: budgetedProjectMemory,
    activeSkills: budgetedActiveSkills,
    compactBoundary: compactBoundary?.event,
    compactRetainedEventCount: retainedBoundaryEvents.length,
    compactRetainedSegmentValid: retainedSegmentCheck.valid,
    compactRetainedSegmentWarning: retainedSegmentCheck.warning,
    postCompactState,
    userIntentGuidance,
    memoryTruncated: memoryTruncation.wasLineTruncated || memoryTruncation.wasByteTruncated,
    microcompactedEventCount: selectedEvents.filter((event, index) => {
      const micro = microcompactedEvents[index]
      if (!micro) return false
      if (event.type !== 'tool_completed' && event.type !== 'tool_denied') return false
      if (micro.type !== event.type) return false
      return event !== micro
    }).length,
  }
}

function findLatestCompactBoundary(events: NexusEvent[]): { event: Extract<NexusEvent, { type: 'compact_boundary' }>; index: number } | null {
  for (let idx = events.length - 1; idx >= 0; idx--) {
    const event = events[idx]
    if (event.type === 'compact_boundary') {
      return { event: event as Extract<NexusEvent, { type: 'compact_boundary' }>, index: idx }
    }
  }
  return null
}

function normalizeRetainedEvents(retainedEvents: unknown[] | undefined): NexusEvent[] {
  if (!Array.isArray(retainedEvents)) return []
  return retainedEvents
    .map(raw => (typeof raw === 'object' && raw !== null && 'type' in raw ? raw : null))
    .filter((e): e is NexusEvent => e !== null)
}

export function eventIdentity(event: NexusEvent): string {
  return [
    event.type,
    event.sessionId,
    event.timestamp,
    (event as { eventId?: string }).eventId ?? '',
    (event as { toolUseId?: string }).toolUseId ?? '',
    eventContentFingerprint(event),
  ].join(':')
}

export function buildRetainedSegmentMetadata(
  events: NexusEvent[],
  boundary?: NexusEvent,
): RetainedSegmentMetadata {
  const identities = events.map(eventIdentity)
  return {
    retainedCount: events.length,
    boundaryId: boundary ? eventIdentity(boundary) : undefined,
    firstEventId: identities[0],
    lastEventId: identities.at(-1),
    hash: hashEventIdentities(identities),
  }
}

export function verifyRetainedSegment(
  events: NexusEvent[],
  metadata: unknown,
  boundary?: NexusEvent,
): { valid: boolean; warning: string } {
  if (!metadata || typeof metadata !== 'object') {
    return { valid: true, warning: '' }
  }
  const record = metadata as Partial<RetainedSegmentMetadata>
  const actual = buildRetainedSegmentMetadata(events)
  if (record.boundaryId && boundary && record.boundaryId !== eventIdentity(boundary)) {
    return { valid: false, warning: 'retained boundary anchor mismatch' }
  }
  if (record.retainedCount !== actual.retainedCount) {
    return {
      valid: false,
      warning: `retained count mismatch: expected ${record.retainedCount}, got ${actual.retainedCount}`,
    }
  }
  if (record.firstEventId && record.firstEventId !== actual.firstEventId) {
    return { valid: false, warning: 'retained first event mismatch' }
  }
  if (record.lastEventId && record.lastEventId !== actual.lastEventId) {
    return { valid: false, warning: 'retained last event mismatch' }
  }
  if (record.hash && record.hash !== actual.hash) {
    return { valid: false, warning: 'retained hash mismatch' }
  }
  return { valid: true, warning: '' }
}

function eventContentFingerprint(event: NexusEvent): string {
  switch (event.type) {
    case 'user_message':
      return hashString(event.text)
    case 'user_intake_guidance':
      return hashString(`${event.userText}:${event.intent}:${event.actionHint}:${event.requiresTools}:${event.source}:${event.guidance}`)
    case 'assistant_delta':
    case 'thinking_delta':
      return hashString(event.text)
    case 'tool_started':
      return hashString(`${event.name}:${stableStringify(event.input)}`)
    case 'tool_completed':
      return hashString(`${event.name}:${event.success}:${stableStringify(event.output)}`)
    case 'tool_denied':
      return hashString(`${event.name}:${event.risk}:${event.message}`)
    case 'permission_request':
      return hashString(`${event.name}:${event.risk}:${event.toolUseId}:${stableStringify(event.input)}`)
    case 'permission_response':
      return hashString(`${event.toolUseId}:${event.approved}:${event.reason ?? ''}`)
    case 'result':
      return hashString(`${event.success}:${event.message}`)
    case 'error':
      return hashString(`${event.code}:${event.message}`)
    case 'compact_boundary':
      return hashString(`${event.trigger}:${event.beforeEventCount}:${event.afterEventCount}:${event.summaryChars}`)
    case 'compact_failure':
      return hashString(`${event.trigger}:${event.failureCount}:${event.message}`)
    case 'context_warning':
      return hashString(`${event.modelId ?? ''}:${event.tokenEstimate}:${event.maxTokens}:${event.message}`)
    case 'session_memory_updated':
      return hashString(`${event.path}:${event.trigger}:${event.summaryChars}:${event.eventCount}`)
    case 'usage':
      return hashString(`${event.inputTokens}:${event.outputTokens}:${event.cacheCreationInputTokens ?? ''}:${event.cacheReadInputTokens ?? ''}`)
    case 'task_created':
      return hashString(`${event.taskId}:${event.title}`)
    case 'task_session_event':
      return hashString(`${event.eventId}:${event.eventType}:${event.phase}:${stableStringify(event.payload)}`)
    case 'hook_started':
      return hashString(`${event.hookName}:${event.hookEvent}:${event.toolUseId ?? ''}:${event.toolName ?? ''}`)
    case 'hook_completed':
      return hashString(`${event.hookName}:${event.hookEvent}:${event.toolUseId ?? ''}:${event.toolName ?? ''}:${stableStringify(event.output)}`)
    case 'hook_failed':
      return hashString(`${event.hookName}:${event.hookEvent}:${event.toolUseId ?? ''}:${event.toolName ?? ''}:${event.message}`)
    case 'session_started':
      return hashString(`${event.cwd}:${event.requestId ?? ''}:${event.model ?? ''}:${event.budget ?? ''}`)
    default:
      return hashString(stableStringify(event))
  }
}

function stableStringify(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, nestedValue) => {
      if (!nestedValue || typeof nestedValue !== 'object' || Array.isArray(nestedValue)) {
        return nestedValue
      }
      return Object.fromEntries(
        Object.entries(nestedValue as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right)),
      )
    })
  } catch {
    return String(value)
  }
}

function hashString(value: string): string {
  return hashEventIdentities([value])
}

function hashEventIdentities(identities: string[]): string {
  let hash = 2166136261
  for (const identity of identities) {
    for (let index = 0; index < identity.length; index += 1) {
      hash ^= identity.charCodeAt(index)
      hash = Math.imul(hash, 16777619)
    }
  }
  return (hash >>> 0).toString(36)
}

export function selectRecentEvents(events: NexusEvent[], budget: ContextBudget): NexusEvent[] {
  const maxTurns = budget.recentTurnLimit
  const maxEvents = budget.recentEventLimit

  let recoveryIdx = 0
  for (let idx = events.length - 1; idx >= 0; idx--) {
    const event = events[idx]!
    if (event.type === 'error') {
      const code = (event as { code?: string }).code
      if (isRecoveryBoundaryError(code)) {
        recoveryIdx = idx
        break
      }
    }
  }
  const effectiveEvents = recoveryIdx > 0 ? events.slice(recoveryIdx) : events

  const userMsgIdxs: number[] = []
  for (let idx = 0; idx < effectiveEvents.length; idx++) {
    if (effectiveEvents[idx]!.type === 'user_message') {
      userMsgIdxs.push(idx)
    }
  }
  let keptTurns = 0
  let startIdx = effectiveEvents.length
  for (let t = userMsgIdxs.length - 1; t >= 0; t--) {
    const candidateStart = userMsgIdxs[t]!
    const candidateLen = effectiveEvents.length - candidateStart
    if (keptTurns + 1 > maxTurns) break
    if (candidateLen > maxEvents && keptTurns > 0) break
    startIdx = candidateStart
    keptTurns++
  }

  const turnSlice = effectiveEvents.slice(startIdx)
  return trimSelectedWindow(turnSlice, maxEvents)
}

export function isRecoveryBoundaryError(code: string | undefined): boolean {
  return code === 'REQUEST_CANCELLED' ||
    code === 'REQUEST_TIMEOUT' ||
    code === 'EXECUTION_TIMEOUT' ||
    code === 'PROVIDER_ERROR' ||
    code === 'EMPTY_PROVIDER_RESPONSE' ||
    code === 'CONTEXT_LIMIT_EXCEEDED' ||
    code === 'MAX_LOOPS_EXCEEDED' ||
    code === 'MAX_OUTPUT_TOKENS_EXCEEDED' ||
    code === 'TOOL_LOOP_FINAL_RESPONSE_ONLY'
}

function trimSelectedWindow(events: NexusEvent[], maxEvents: number): NexusEvent[] {
  if (events.length <= maxEvents) return events
  const head = events[0]!
  const tail = events.slice(events.length - (maxEvents - 1))
  return [head, ...tail]
}

export function protectToolPairs(events: NexusEvent[], selected: NexusEvent[]): NexusEvent[] {
  if (selected.length === 0) return selected
  const selectedToolIds = new Set(selected
    .filter(e => e.type === 'tool_completed' || e.type === 'tool_started' || e.type === 'tool_denied' || e.type === 'permission_request')
    .map(e => (e as { toolUseId?: string }).toolUseId)
    .filter(Boolean))
  const selectedEventIds = new Set(selected.map(e => eventIdentity(e)))
  const result = [...selected]
  const firstSelectedIdx = events.findIndex(e => eventIdentity(e) === eventIdentity(result[0]!))
  for (let idx = firstSelectedIdx - 1; idx >= 0; idx--) {
    const event = events[idx]!
    const toolUseId = (event.type === 'tool_completed' || event.type === 'tool_started' || event.type === 'tool_denied' || event.type === 'permission_request')
      ? (event as { toolUseId?: string }).toolUseId
      : undefined
    if (toolUseId && selectedToolIds.has(toolUseId) && !selectedEventIds.has(eventIdentity(event))) {
      result.unshift(event)
      selectedEventIds.add(eventIdentity(event))
    } else if (event.type === 'user_message' || event.type === 'session_started') {
      break
    }
  }
  return result
}

export function selectOmittedEvents(events: NexusEvent[], selected: NexusEvent[]): NexusEvent[] {
  const selectedIds = new Set(selected.map(e => eventIdentity(e)))
  return events.filter(e => !selectedIds.has(eventIdentity(e)))
}

export function microcompactEvents(events: NexusEvent[], budget: ContextBudget): NexusEvent[] {
  return events.map(event => {
    if (event.type !== 'tool_completed') return event
    const output = typeof event.output === 'string' ? event.output : JSON.stringify(event.output)
    if (output.length <= budget.microcompactToolOutputChars) return event
    const headLen = Math.floor(budget.microcompactToolOutputChars * 0.6)
    const tailLen = budget.microcompactToolOutputChars - headLen
    return {
      ...event,
      output: `${output.slice(0, headLen)}\n\n[microcompacted ${event.name} output (${output.length} chars)]\n\n${output.slice(-tailLen)}`,
      truncated: true,
      _originalOutputLength: output.length,
    } as NexusEvent
  })
}

function enforceDynamicLayerBudgets(options: {
  projectMemory: string
  sessionSummary: string
  activeSkills: string
  budget: ContextBudget
}): { projectMemory: string; sessionSummary: string; activeSkills: string } {
  const { budget } = options
  return {
    projectMemory: truncateToBudget(options.projectMemory, budget.layerBudgets.memory * 4),
    sessionSummary: truncateToBudget(options.sessionSummary, budget.layerBudgets.summary * 4),
    activeSkills: truncateToBudget(options.activeSkills, budget.layerBudgets.system * 4),
  }
}

function truncateToBudget(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return text.slice(0, maxChars)
}

export function derivePostCompactState(events: NexusEvent[], matchedSkills: Skill[]): PostCompactState {
  const recentReadFiles: string[] = []
  const restoredFileContents: { path: string; content: string }[] = []
  const seenFiles = new Set<string>()
  const activeToolNames: string[] = []
  const seenTools = new Set<string>()
  const taskStatusLines: string[] = []
  const hookLines: string[] = []

  for (let idx = events.length - 1; idx >= 0; idx--) {
    const event = events[idx]
    if (event.type === 'tool_completed' && event.success) {
      const name = event.name
      if (name && !seenTools.has(name)) {
        seenTools.add(name)
        activeToolNames.unshift(name)
      }
      if (name === 'Read' && restoredFileContents.length < 5) {
        const output = (event as { output?: unknown }).output
        if (typeof output === 'string' && output.length > 0 && output.length <= 5000) {
          const toolUseId = (event as { toolUseId?: string }).toolUseId
          const startedEvent = events.find(e => e.type === 'tool_started' && (e as { toolUseId?: string }).toolUseId === toolUseId) as { input?: { path?: string } } | undefined
          const path = startedEvent?.input?.path
          if (path && !seenFiles.has(path)) {
            restoredFileContents.unshift({ path, content: output })
          }
        }
      }
    }
    if (event.type === 'tool_started') {
      const name = event.name
      if (name === 'Read' || name === 'Write' || name === 'Edit') {
        const input = (event as { input?: Record<string, unknown> }).input
        const path = (event as { path?: string }).path
          || (event as { filePath?: string }).filePath
          || (input && typeof input.path === 'string' ? input.path : undefined)
        if (path && !seenFiles.has(path)) {
          seenFiles.add(path)
          recentReadFiles.unshift(path)
        }
      }
    }
    if (event.type === 'task_created') {
      const taskEvent = event as { taskId?: string; title?: string }
      if (taskEvent.title) {
        taskStatusLines.unshift(`- [created] ${taskEvent.title}`)
      }
    }
    if (event.type === 'task_session_event') {
      const taskEvent = event as { phase?: string; eventType?: string; eventId?: string }
      if (taskEvent.phase || taskEvent.eventType) {
        taskStatusLines.unshift(`- [${taskEvent.eventType ?? 'task'}] ${taskEvent.phase ?? taskEvent.eventId ?? ''}`)
      }
    }
    if (event.type === 'hook_completed') {
      const hookEvent = event as { hookName?: string; hookEvent?: string }
      hookLines.unshift(`- ${hookEvent.hookName ?? 'hook'} (${hookEvent.hookEvent ?? 'unknown'})`)
    }
  }

  return {
    recentReadFiles: recentReadFiles.slice(0, 10),
    restoredFileContents,
    activeToolNames: activeToolNames.slice(0, 10),
    activeSkills: matchedSkills.map(s => s.id),
    taskStatusLines: taskStatusLines.slice(0, 10),
    hookLines: hookLines.slice(0, 5),
  }
}

function formatPostCompactState(state: PostCompactState): string {
  const parts: string[] = []
  if (state.recentReadFiles.length > 0) {
    parts.push(`Recently accessed files: ${state.recentReadFiles.join(', ')}`)
  }
  if (state.activeToolNames.length > 0) {
    parts.push(`Active tools: ${state.activeToolNames.join(', ')}`)
  }
  if (state.activeSkills.length > 0) {
    parts.push(`Active skills: ${state.activeSkills.join(', ')}`)
  }
  if (state.taskStatusLines.length > 0) {
    parts.push(`Task status:\n${state.taskStatusLines.join('\n')}`)
  }
  if (state.hookLines.length > 0) {
    parts.push(`Hook activity:\n${state.hookLines.join('\n')}`)
  }
  if (state.restoredFileContents.length > 0) {
    const fileBlocks = state.restoredFileContents.map(f => `### ${f.path}\n\`\`\`\n${f.content}\n\`\`\``).join('\n\n')
    parts.push(`## Restored File Contents (from pre-compact reads)\n${fileBlocks}`)
  }
  return parts.length > 0 ? `## Post-Compact State\n${parts.join('\n')}` : ''
}

function buildCompactCapabilityReminder(state: PostCompactState): string {
  const lines: string[] = []
  lines.push('## Compact Capability Reminder')
  lines.push('The conversation above has been compacted. The summary above captures the key context.')
  if (state.restoredFileContents.length > 0) {
    lines.push(`File contents restored above for ${state.restoredFileContents.length} file(s). Only re-read if you need to verify changes since then.`)
  } else if (state.recentReadFiles.length > 0) {
    lines.push(`Previously read files: ${state.recentReadFiles.join(', ')}. Contents were too large to restore — re-read only the specific sections you need.`)
  }
  if (state.taskStatusLines.length > 0) {
    lines.push('The task list above shows current progress. Continue working on incomplete items.')
  }
  lines.push('Important: tool_use and tool_result pairs must remain matched — do not generate one without the other.')
  return lines.join(' ')
}
