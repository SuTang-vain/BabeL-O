import type { NexusEvent } from '../shared/events.js'
import type { WorkingSetEntry } from './workingSet.js'

export type ContextManagerPhase =
  | 'CollectContextSources'
  | 'BuildContextItems'
  | 'ScoreContextItems'
  | 'SelectWithinBudget'
  | 'CompactAndSnip'
  | 'ForkForChildAgent'
  | 'RenderPromptBlocks'
  | 'EstimateAndValidateBudget'
  | 'EmitDiagnostics'

export const CONTEXT_MANAGER_PHASES: ContextManagerPhase[] = [
  'CollectContextSources',
  'BuildContextItems',
  'ScoreContextItems',
  'SelectWithinBudget',
  'CompactAndSnip',
  'RenderPromptBlocks',
  'EstimateAndValidateBudget',
  'EmitDiagnostics',
]

export type ContextItemKind =
  | 'system'
  | 'memory'
  | 'agent_md'
  | 'git'
  | 'working_set'
  | 'event'
  | 'tool_result'
  | 'task_state'
  | 'child_agent_state'
  | 'compact_summary'
  | 'skill'
  | 'mcp'

export type ContextItem = {
  id: string
  kind: ContextItemKind
  text: string
  source: string
  cacheable: boolean
  volatile: boolean
  estimatedTokens: number
  metadata?: Record<string, unknown>
}

export type ScoredContextItem = ContextItem & {
  score: number
  scoreReasons: string[]
}

export type SelectedContextItem = ScoredContextItem & {
  retained: boolean
  droppedReason?: string
}

export type ContextSelectionItemDiagnostic = {
  id: string
  kind: ContextItemKind
  reason: string
  estimatedTokens: number
}

export type ContextSelectionDiagnostics = {
  phases: ContextManagerPhase[]
  estimatedTokens: number
  maxTokens: number
  percentUsed: number
  retained: ContextSelectionItemDiagnostic[]
  dropped: ContextSelectionItemDiagnostic[]
  workingSetPaths: string[]
  compactBoundary?: string
  prefixCacheFingerprint?: string
  fork?: {
    mode: string
    inheritedItems: number
    omittedItems: number
  }
}

export type ContextForkSelectionMetadata = NonNullable<ContextSelectionDiagnostics['fork']>

export function buildContextSelectionDiagnostics(options: {
  maxTokens: number
  projectMemory: string
  sessionSummary: string
  activeSkills: string
  workingSetEntries: WorkingSetEntry[]
  events: NexusEvent[]
  selectedEvents: NexusEvent[]
  rawSelectedEvents: NexusEvent[]
  compactBoundaryId?: string
  fork?: ContextForkSelectionMetadata
  eventIdentity: (event: NexusEvent) => string
}): ContextSelectionDiagnostics {
  const rawSelectedIds = new Set(options.rawSelectedEvents.map(options.eventIdentity))
  const selectedIds = new Set(options.selectedEvents.map(options.eventIdentity))
  const retainedItems: SelectedContextItem[] = []
  const droppedItems: SelectedContextItem[] = []

  addRetainedLayer(retainedItems, {
    id: 'memory:project',
    kind: 'memory',
    text: options.projectMemory,
    source: 'project-memory',
    score: 70,
    scoreReasons: ['memory layer retained within budget'],
  })
  addRetainedLayer(retainedItems, {
    id: 'summary:session',
    kind: 'compact_summary',
    text: options.sessionSummary,
    source: 'session-summary',
    score: 82,
    scoreReasons: ['compact summary and omitted event summary retained'],
  })
  addRetainedLayer(retainedItems, {
    id: 'skill:active',
    kind: 'skill',
    text: options.activeSkills,
    source: 'skill-matcher',
    score: 75,
    scoreReasons: ['skills matched latest prompt'],
  })
  if (options.workingSetEntries.length > 0) {
    addRetainedLayer(retainedItems, {
      id: 'working_set:active',
      kind: 'working_set',
      text: options.workingSetEntries.map(entry => entry.path).join('\n'),
      source: 'working-set',
      score: 86,
      scoreReasons: ['recently mentioned or tool-touched paths retained'],
      metadata: { paths: options.workingSetEntries.map(entry => entry.path) },
    })
  }

  for (let index = 0; index < options.events.length; index += 1) {
    const event = options.events[index]!
    const id = `event:${options.eventIdentity(event)}`
    const retained = selectedIds.has(options.eventIdentity(event))
    const baseItem = scoreContextItem({
      id,
      kind: contextKindForEvent(event),
      text: eventPreviewText(event),
      source: `event:${event.type}`,
      cacheable: false,
      volatile: true,
      metadata: {
        eventType: event.type,
        timestamp: event.timestamp,
        index,
      },
    }, retained ? eventRetentionScore(event, rawSelectedIds.has(options.eventIdentity(event))) : 10, retained
      ? rawSelectedIds.has(options.eventIdentity(event))
        ? ['recent turn selected within event budget']
        : ['paired tool or permission event protected with selected context']
      : ['older event omitted outside recent event budget'])

    if (retained) {
      retainedItems.push({ ...baseItem, retained: true })
    } else {
      droppedItems.push({ ...baseItem, retained: false, droppedReason: 'older event omitted outside recent event budget' })
    }
  }

  const retained = retainedItems
    .sort(compareSelectedItems)
    .slice(0, 12)
    .map(toRetainedDiagnostic)
  const dropped = droppedItems
    .sort(compareDroppedItems)
    .slice(0, 12)
    .map(toDroppedDiagnostic)
  const estimatedTokens = retained.reduce((sum, item) => sum + item.estimatedTokens, 0)

  return {
    phases: CONTEXT_MANAGER_PHASES,
    estimatedTokens,
    maxTokens: options.maxTokens,
    percentUsed: Math.round((estimatedTokens / Math.max(1, options.maxTokens)) * 100),
    retained,
    dropped,
    workingSetPaths: options.workingSetEntries.map(entry => entry.path),
    ...(options.compactBoundaryId && { compactBoundary: options.compactBoundaryId }),
    ...(options.fork && { fork: options.fork }),
  }
}

export function createEmptyContextSelectionDiagnostics(maxTokens: number): ContextSelectionDiagnostics {
  return {
    phases: CONTEXT_MANAGER_PHASES,
    estimatedTokens: 0,
    maxTokens,
    percentUsed: 0,
    retained: [],
    dropped: [],
    workingSetPaths: [],
  }
}

function addRetainedLayer(
  items: SelectedContextItem[],
  options: {
    id: string
    kind: ContextItemKind
    text: string
    source: string
    score: number
    scoreReasons: string[]
    metadata?: Record<string, unknown>
  },
): void {
  const text = options.text.trim()
  if (!text) return
  const item = scoreContextItem({
    id: options.id,
    kind: options.kind,
    text,
    source: options.source,
    cacheable: options.kind === 'memory' || options.kind === 'skill',
    volatile: options.kind === 'working_set' || options.kind === 'compact_summary',
    metadata: options.metadata,
  }, options.score, options.scoreReasons)
  items.push({ ...item, retained: true })
}

function scoreContextItem(item: Omit<ContextItem, 'estimatedTokens'>, score: number, scoreReasons: string[]): ScoredContextItem {
  return {
    ...item,
    estimatedTokens: estimateContextItemTokens(item.text),
    score,
    scoreReasons,
  }
}

export function estimateContextItemTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

function contextKindForEvent(event: NexusEvent): ContextItemKind {
  if (event.type === 'tool_completed') return 'tool_result'
  if (event.type === 'agent_job_event') return 'child_agent_state'
  if (event.type === 'task_created' || event.type === 'task_session_event') return isChildAgentStateEvent(event) ? 'child_agent_state' : 'task_state'
  if (event.type === 'compact_boundary') return 'compact_summary'
  return 'event'
}

function isChildAgentStateEvent(event: NexusEvent): boolean {
  if (event.type !== 'task_session_event') return false
  const text = safeStringify(event.payload).toLowerCase()
  return text.includes('agent') || text.includes('transcript') || text.includes('childsession')
}

function eventRetentionScore(event: NexusEvent, rawSelected: boolean): number {
  const base = rawSelected ? 100 : 90
  if (event.type === 'user_message') return base + 8
  if (event.type === 'error' || event.type === 'permission_request' || event.type === 'tool_denied') return base + 6
  if (event.type === 'tool_completed' || event.type === 'tool_started') return base + 4
  return base
}

function eventPreviewText(event: NexusEvent): string {
  switch (event.type) {
    case 'user_message':
    case 'assistant_delta':
    case 'thinking_delta':
      return event.text
    case 'tool_started':
      return `${event.name} ${safeStringify(event.input)}`
    case 'tool_completed':
      return `${event.name} ${safeStringify(event.output)}`
    case 'error':
      return `${event.code} ${event.message}`
    case 'result':
      return `${event.success} ${event.message}`
    case 'compact_boundary':
      return event.summary
    case 'task_created':
      return `${event.taskId} ${event.title}`
    case 'task_session_event':
      return `${event.eventType} ${safeStringify(event.payload)}`
    case 'agent_job_event':
      return `${event.eventType} ${event.status} ${event.agentType} ${event.childSessionId}`
    default:
      return safeStringify(event)
  }
}

function toRetainedDiagnostic(item: SelectedContextItem): ContextSelectionItemDiagnostic {
  return {
    id: item.id,
    kind: item.kind,
    reason: item.scoreReasons.join('; '),
    estimatedTokens: item.estimatedTokens,
  }
}

function toDroppedDiagnostic(item: SelectedContextItem): ContextSelectionItemDiagnostic {
  return {
    id: item.id,
    kind: item.kind,
    reason: item.droppedReason ?? item.scoreReasons.join('; '),
    estimatedTokens: item.estimatedTokens,
  }
}

function compareSelectedItems(left: SelectedContextItem, right: SelectedContextItem): number {
  if (right.score !== left.score) return right.score - left.score
  if (right.estimatedTokens !== left.estimatedTokens) return right.estimatedTokens - left.estimatedTokens
  return left.id.localeCompare(right.id)
}

function compareDroppedItems(left: SelectedContextItem, right: SelectedContextItem): number {
  if (right.estimatedTokens !== left.estimatedTokens) return right.estimatedTokens - left.estimatedTokens
  if (right.score !== left.score) return right.score - left.score
  return left.id.localeCompare(right.id)
}

function safeStringify(value: unknown): string {
  try {
    const text = JSON.stringify(value)
    if (text !== undefined) return text
  } catch {}
  return String(value)
}
