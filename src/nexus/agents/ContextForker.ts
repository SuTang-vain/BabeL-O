import type { NexusEvent } from '../../shared/events.js'
import type { SessionSnapshot } from '../../shared/session.js'
import { deriveWorkingSet, formatWorkingSet, type WorkingSetEntry } from '../../runtime/workingSet.js'
import type { AgentJob, ContextForkMode } from './types.js'

export type ContextForkDiagnostics = {
  included: string[]
  omitted: string[]
  workingSetPaths: string[]
  eventReferences: Array<{
    type: string
    timestamp: string
    reason: string
  }>
}

export type ContextForkResult = {
  mode: ContextForkMode
  prompt: string
  inheritedItems: number
  omittedItems: number
  allowedPaths?: string[]
  diagnostics: ContextForkDiagnostics
}

type ContextForkBuilderState = {
  mode: ContextForkMode
  parentSession: SessionSnapshot
  job: AgentJob
  explicitPaths: string[]
  workingSetEntries: WorkingSetEntry[]
  summaries: EventSummaries
}

type EventSummaries = {
  latestUserMessages: string[]
  taskEvents: string[]
  failureEvents: string[]
  permissionEvents: string[]
  compactSummaries: string[]
  childAgentEvents: string[]
  debugEvents: string[]
}

export function forkContextForAgent(options: {
  parentSession: SessionSnapshot
  job: AgentJob
  mode?: ContextForkMode
}): ContextForkResult {
  const mode = options.mode ?? options.job.contextForkMode
  const state: ContextForkBuilderState = {
    mode,
    parentSession: options.parentSession,
    job: options.job,
    explicitPaths: extractPromptPaths(options.job.prompt, options.parentSession.cwd),
    workingSetEntries: deriveWorkingSet(options.parentSession.events, options.parentSession.cwd),
    summaries: summarizeEvents(options.parentSession.events),
  }

  switch (mode) {
    case 'minimal':
      return minimalContextFork(state)
    case 'working-set':
      return workingSetContextFork(state)
    case 'task-focused':
      return taskFocusedContextFork(state)
    case 'full-summary':
      return fullSummaryContextFork(state)
    case 'debug-replay':
      return debugReplayContextFork(state)
  }
}

function minimalContextFork(state: ContextForkBuilderState): ContextForkResult {
  const allowedPaths = mergeAllowedPaths(state.parentSession.allowedPaths, state.explicitPaths)
  const prompt = basePromptLines(state, 'You are a read-only Explore Agent.', [
    'Use only Read, Grep, and Glob. Do not edit files, run Bash, or mutate tasks.',
  ]).join('\n')

  return buildForkResult(state, prompt, {
    included: ['stable_rules', 'cwd', 'agent_prompt', 'explicit_paths'],
    omitted: ['parent_history', 'large_tool_results', 'compact_summary', 'child_transcripts'],
    allowedPaths,
    inheritedItems: 4 + state.explicitPaths.length,
    omittedItems: state.parentSession.events.length,
  })
}

function workingSetContextFork(state: ContextForkBuilderState): ContextForkResult {
  const allowedPaths = mergeAllowedPaths(
    state.parentSession.allowedPaths,
    [...state.explicitPaths, ...state.workingSetEntries.map(entry => entry.path)],
  )
  const workingSet = formatWorkingSet(state.workingSetEntries)
  const prompt = [
    ...basePromptLines(state, 'You are a focused Working Set Agent.', [
      'Use the active working set first. Prefer targeted Read/Grep/Glob calls over broad history replay.',
    ]),
    ...(workingSet ? ['', workingSet] : []),
    ...sectionLines('Recent user focus', state.summaries.latestUserMessages),
  ].join('\n')

  return buildForkResult(state, prompt, {
    included: ['stable_rules', 'cwd', 'agent_prompt', 'explicit_paths', 'working_set', 'recent_user_focus'],
    omitted: ['full_parent_history', 'large_tool_results', 'child_transcripts'],
    allowedPaths,
    inheritedItems: 5 + state.explicitPaths.length + state.workingSetEntries.length + state.summaries.latestUserMessages.length,
    omittedItems: countOmittedOutsideSummaries(state),
  })
}

function taskFocusedContextFork(state: ContextForkBuilderState): ContextForkResult {
  const allowedPaths = mergeAllowedPaths(
    state.parentSession.allowedPaths,
    [...state.explicitPaths, ...state.workingSetEntries.map(entry => entry.path)],
  )
  const prompt = [
    ...basePromptLines(state, 'You are a task-focused Agent.', [
      'Focus on the current task, acceptance criteria, relevant failures, and permission constraints.',
    ]),
    ...sectionLines('Task state', state.summaries.taskEvents),
    ...sectionLines('Relevant failures', state.summaries.failureEvents),
    ...sectionLines('Permission context', state.summaries.permissionEvents),
    ...sectionLines('Working set paths', state.workingSetEntries.map(formatWorkingSetEntry)),
  ].join('\n')

  return buildForkResult(state, prompt, {
    included: ['stable_rules', 'cwd', 'agent_prompt', 'task_state', 'failure_context', 'permission_context', 'working_set'],
    omitted: ['full_parent_history', 'unrelated_successful_tool_outputs', 'child_transcript_raw_events'],
    allowedPaths,
    inheritedItems: 4 + state.summaries.taskEvents.length + state.summaries.failureEvents.length + state.summaries.permissionEvents.length + state.workingSetEntries.length,
    omittedItems: countOmittedOutsideSummaries(state),
  })
}

function fullSummaryContextFork(state: ContextForkBuilderState): ContextForkResult {
  const allowedPaths = mergeAllowedPaths(
    state.parentSession.allowedPaths,
    [...state.explicitPaths, ...state.workingSetEntries.map(entry => entry.path)],
  )
  const prompt = [
    ...basePromptLines(state, 'You are a continuation Agent.', [
      'Use summarized parent context. Do not assume omitted raw transcript details unless explicitly provided.',
    ]),
    ...sectionLines('Compact summaries', state.summaries.compactSummaries),
    ...sectionLines('Recent user focus', state.summaries.latestUserMessages),
    ...sectionLines('Task state', state.summaries.taskEvents),
    ...sectionLines('Child agent results', state.summaries.childAgentEvents),
    ...sectionLines('Relevant failures', state.summaries.failureEvents),
    ...sectionLines('Working set paths', state.workingSetEntries.map(formatWorkingSetEntry)),
  ].join('\n')

  return buildForkResult(state, prompt, {
    included: ['stable_rules', 'cwd', 'agent_prompt', 'compact_summary', 'recent_user_focus', 'task_state', 'child_agent_results', 'failure_context', 'working_set'],
    omitted: ['raw_parent_history', 'raw_child_transcripts', 'large_tool_result_bodies'],
    allowedPaths,
    inheritedItems: 4 + state.summaries.compactSummaries.length + state.summaries.latestUserMessages.length + state.summaries.taskEvents.length + state.summaries.childAgentEvents.length + state.summaries.failureEvents.length + state.workingSetEntries.length,
    omittedItems: countOmittedOutsideSummaries(state),
  })
}

function debugReplayContextFork(state: ContextForkBuilderState): ContextForkResult {
  const allowedPaths = mergeAllowedPaths(
    state.parentSession.allowedPaths,
    [...state.explicitPaths, ...state.workingSetEntries.map(entry => entry.path)],
  )
  const prompt = [
    ...basePromptLines(state, 'You are a debug replay Agent.', [
      'Use the selected failure, permission, compact, and tool events to reproduce or explain the issue. Keep output concise.',
    ]),
    ...sectionLines('Debug replay events', state.summaries.debugEvents),
    ...sectionLines('Working set paths', state.workingSetEntries.map(formatWorkingSetEntry)),
  ].join('\n')

  return buildForkResult(state, prompt, {
    included: ['stable_rules', 'cwd', 'agent_prompt', 'debug_replay_events', 'working_set'],
    omitted: ['unselected_parent_history', 'successful_unrelated_tool_outputs', 'raw_child_transcripts'],
    allowedPaths,
    inheritedItems: 4 + state.summaries.debugEvents.length + state.workingSetEntries.length,
    omittedItems: Math.max(0, state.parentSession.events.length - state.summaries.debugEvents.length),
  })
}

function buildForkResult(
  state: ContextForkBuilderState,
  prompt: string,
  options: {
    included: string[]
    omitted: string[]
    allowedPaths: string[]
    inheritedItems: number
    omittedItems: number
  },
): ContextForkResult {
  return {
    mode: state.mode,
    prompt,
    inheritedItems: options.inheritedItems,
    omittedItems: options.omittedItems,
    allowedPaths: options.allowedPaths.length > 0 ? options.allowedPaths : undefined,
    diagnostics: {
      included: options.included,
      omitted: options.omitted,
      workingSetPaths: state.workingSetEntries.map(entry => entry.path),
      eventReferences: buildEventReferences(state),
    },
  }
}

function basePromptLines(
  state: ContextForkBuilderState,
  identity: string,
  rules: string[],
): string[] {
  return [
    identity,
    ...rules,
    '',
    'Parent session:',
    state.parentSession.sessionId,
    '',
    'Working directory:',
    state.parentSession.cwd,
    '',
    'Context fork mode:',
    state.mode,
    '',
    'Agent task:',
    state.job.prompt,
    ...(state.explicitPaths.length > 0 ? ['', 'Explicit paths:', ...state.explicitPaths] : []),
  ]
}

function sectionLines(title: string, lines: string[]): string[] {
  const present = lines.filter(line => line.trim().length > 0)
  if (present.length === 0) return []
  return ['', `${title}:`, ...present.map(line => `- ${line}`)]
}

function summarizeEvents(events: NexusEvent[]): EventSummaries {
  const summaries: EventSummaries = {
    latestUserMessages: [],
    taskEvents: [],
    failureEvents: [],
    permissionEvents: [],
    compactSummaries: [],
    childAgentEvents: [],
    debugEvents: [],
  }

  for (const event of events) {
    if (event.type === 'user_message') {
      summaries.latestUserMessages.push(truncateLine(event.text, 240))
    } else if (event.type === 'task_created') {
      summaries.taskEvents.push(`${event.taskId}: ${event.title}`)
    } else if (event.type === 'task_session_event') {
      const line = `${event.eventType} (${event.phase}) ${truncateLine(safeStringify(event.payload), 240)}`.trim()
      if (isChildAgentEvent(event)) summaries.childAgentEvents.push(line)
      else summaries.taskEvents.push(line)
    } else if (event.type === 'error') {
      summaries.failureEvents.push(`${event.code}: ${event.message}`)
    } else if (event.type === 'tool_denied') {
      summaries.permissionEvents.push(`${event.name} denied (${event.risk}): ${event.message}`)
    } else if (event.type === 'permission_request') {
      summaries.permissionEvents.push(`${event.name} permission requested (${event.risk})`)
    } else if (event.type === 'permission_response') {
      summaries.permissionEvents.push(`permission ${event.approved ? 'approved' : 'rejected'} for ${event.toolUseId}${event.reason ? `: ${event.reason}` : ''}`)
    } else if (event.type === 'compact_boundary') {
      summaries.compactSummaries.push(truncateLine(event.summary, 500))
    } else if (event.type === 'compact_failure') {
      summaries.failureEvents.push(`compact ${event.trigger} failed ${event.failureCount}/${event.maxFailures}: ${event.message}`)
    }

    if (isDebugReplayEvent(event)) {
      summaries.debugEvents.push(formatDebugEvent(event))
    }
  }

  summaries.latestUserMessages = summaries.latestUserMessages.slice(-3)
  summaries.taskEvents = summaries.taskEvents.slice(-8)
  summaries.failureEvents = summaries.failureEvents.slice(-8)
  summaries.permissionEvents = summaries.permissionEvents.slice(-8)
  summaries.compactSummaries = summaries.compactSummaries.slice(-2)
  summaries.childAgentEvents = summaries.childAgentEvents.slice(-6)
  summaries.debugEvents = summaries.debugEvents.slice(-12)
  return summaries
}

function buildEventReferences(state: ContextForkBuilderState): ContextForkDiagnostics['eventReferences'] {
  return state.parentSession.events
    .filter(event => isReferencedEvent(state.mode, event))
    .slice(-12)
    .map(event => ({
      type: event.type,
      timestamp: event.timestamp,
      reason: eventReferenceReason(state.mode, event),
    }))
}

function isReferencedEvent(mode: ContextForkMode, event: NexusEvent): boolean {
  if (mode === 'minimal') return false
  if (mode === 'working-set') return event.type === 'user_message' || event.type === 'tool_started'
  if (mode === 'task-focused') return event.type === 'task_created' || event.type === 'task_session_event' || event.type === 'error' || event.type === 'tool_denied' || event.type === 'permission_request' || event.type === 'permission_response'
  if (mode === 'full-summary') return event.type === 'compact_boundary' || event.type === 'user_message' || event.type === 'task_created' || event.type === 'task_session_event' || event.type === 'error'
  return isDebugReplayEvent(event)
}

function eventReferenceReason(mode: ContextForkMode, event: NexusEvent): string {
  if (mode === 'working-set') return 'working set relevance'
  if (mode === 'task-focused') return event.type.includes('permission') || event.type === 'tool_denied' ? 'permission constraint' : 'task or failure relevance'
  if (mode === 'full-summary') return event.type === 'compact_boundary' ? 'compact summary' : 'continuation summary'
  if (event.type === 'tool_completed') return event.success ? 'selected tool output' : 'failed tool output'
  if (event.type === 'compact_failure') return 'compact failure'
  return 'debug replay relevance'
}

function isDebugReplayEvent(event: NexusEvent): boolean {
  return event.type === 'error' ||
    event.type === 'tool_denied' ||
    event.type === 'permission_request' ||
    event.type === 'permission_response' ||
    event.type === 'compact_failure' ||
    event.type === 'context_blocking' ||
    event.type === 'context_warning' ||
    (event.type === 'tool_completed' && !event.success) ||
    (event.type === 'task_session_event' && (event.phase === 'failed' || event.phase === 'cancelled'))
}

function formatDebugEvent(event: NexusEvent): string {
  switch (event.type) {
    case 'error':
      return `error ${event.code}: ${event.message}`
    case 'tool_completed':
      return `tool ${event.name} ${event.success ? 'completed' : 'failed'}: ${truncateLine(safeStringify(event.output), 240)}`
    case 'tool_denied':
      return `tool ${event.name} denied: ${event.message}`
    case 'permission_request':
      return `permission requested for ${event.name} (${event.risk})`
    case 'permission_response':
      return `permission ${event.approved ? 'approved' : 'rejected'} for ${event.toolUseId}${event.reason ? `: ${event.reason}` : ''}`
    case 'compact_failure':
      return `compact ${event.trigger} failed ${event.failureCount}/${event.maxFailures}: ${event.message}`
    case 'context_blocking':
      return `context blocking ${event.percentUsed}%: ${event.message}`
    case 'context_warning':
      return `context warning ${event.percentUsed}%: ${event.message}`
    case 'task_session_event':
      return `${event.eventType} (${event.phase}) ${truncateLine(safeStringify(event.payload), 240)}`.trim()
    default:
      return truncateLine(safeStringify(event), 240)
  }
}

function isChildAgentEvent(event: Extract<NexusEvent, { type: 'task_session_event' }>): boolean {
  const text = `${event.eventType} ${safeStringify(event.payload)}`.toLowerCase()
  return text.includes('agent') || text.includes('childsession') || text.includes('transcript')
}

function countOmittedOutsideSummaries(state: ContextForkBuilderState): number {
  const referenced = new Set(state.summaries.debugEvents)
  return Math.max(0, state.parentSession.events.length - referenced.size)
}

function formatWorkingSetEntry(entry: WorkingSetEntry): string {
  const kind = entry.isDir ? 'dir' : 'file'
  return `${entry.path} (${kind}, touches=${entry.touches}, source=${entry.source})`
}

function extractPromptPaths(prompt: string, cwd: string): string[] {
  return deriveWorkingSet([{
    type: 'user_message',
    schemaVersion: '2026-05-21.babel-o.v1',
    sessionId: 'context-fork-prompt',
    timestamp: '2026-06-04T00:00:00.000Z',
    text: prompt,
  }], cwd).map(entry => entry.path)
}

function mergeAllowedPaths(
  sessionAllowedPaths: string[] | undefined,
  paths: string[],
): string[] {
  return [...new Set([...(sessionAllowedPaths ?? []), ...paths])]
}

function safeStringify(value: unknown): string {
  try {
    const text = JSON.stringify(value)
    if (text !== undefined) return text
  } catch {}
  return String(value)
}

function truncateLine(text: string, maxLength: number): string {
  const singleLine = text.replace(/\s+/g, ' ').trim()
  if (singleLine.length <= maxLength) return singleLine
  return `${singleLine.slice(0, Math.max(0, maxLength - 1))}…`
}
