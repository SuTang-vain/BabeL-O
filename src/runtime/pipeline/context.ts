import { eventBase, type NexusEvent } from '../../shared/events.js'

export function buildContextGroundingRequiredEvent(options: {
  sessionId: string
  requestId?: string
  boundaryId?: string
  source: Extract<NexusEvent, { type: 'context_grounding_required' }>['source']
  message?: string
}): Extract<NexusEvent, { type: 'context_grounding_required' }> {
  const requiredFor: Extract<NexusEvent, { type: 'context_grounding_required' }>['requiredFor'] = [
    'file_facts',
    'test_results',
    'git_status',
    'task_completion',
    'implementation_status',
  ]
  const suggestedActions: Extract<NexusEvent, { type: 'context_grounding_required' }>['suggestedActions'] = [
    're_read_referenced_files',
    'inspect_changed_files',
    'inspect_git_status',
    'run_focused_tests',
    'inspect_event_log',
  ]
  return {
    type: 'context_grounding_required',
    ...eventBase(options.sessionId),
    ...(options.requestId && { requestId: options.requestId }),
    ...(options.boundaryId && { boundaryId: options.boundaryId }),
    source: options.source,
    state: 'summary-derived',
    requiredFor,
    suggestedActions,
    message: options.message ?? 'Context was compacted; treat the compact summary as an index only. Re-read current sources before making file, test, git, task, or implementation-status claims.',
  }
}

export function buildWorkspaceDirtyDetectedEvent(options: {
  sessionId: string
  requestId?: string
  source: Extract<NexusEvent, { type: 'workspace_dirty_detected' }>['source']
  gitStatus: string
  maxFiles?: number
}): Extract<NexusEvent, { type: 'workspace_dirty_detected' }> | undefined {
  const maxFiles = options.maxFiles ?? 20
  const changedFiles = extractChangedFilesFromGitStatus(options.gitStatus)
  if (changedFiles.length === 0) return undefined
  const visibleFiles = changedFiles.slice(0, maxFiles)
  return {
    type: 'workspace_dirty_detected',
    ...eventBase(options.sessionId),
    ...(options.requestId && { requestId: options.requestId }),
    source: options.source,
    changedFileCount: changedFiles.length,
    changedFiles: visibleFiles,
    ...(changedFiles.length > visibleFiles.length && { truncated: true }),
    suggestedActions: ['inspect_changed_files', 'inspect_git_status', 'inspect_diff'],
    message: `Workspace has ${changedFiles.length} changed file(s); inspect git status/diff before relying on compact summaries for current implementation facts.`,
  }
}

export function buildPostCompactGroundingEvents(options: {
  sessionId: string
  requestId?: string
  source: Extract<NexusEvent, { type: 'context_grounding_required' }>['source']
  boundaryId?: string
  gitStatus?: string
}): NexusEvent[] {
  const groundingEvent = buildContextGroundingRequiredEvent({
    sessionId: options.sessionId,
    requestId: options.requestId,
    boundaryId: options.boundaryId,
    source: options.source,
  })
  const dirtyEvent = options.gitStatus
    ? buildWorkspaceDirtyDetectedEvent({
      sessionId: options.sessionId,
      requestId: options.requestId,
      source: options.source === 'context_recovery' ? 'post_compact' : options.source,
      gitStatus: options.gitStatus,
    })
    : undefined
  return dirtyEvent ? [groundingEvent, dirtyEvent] : [groundingEvent]
}

type ContextGroundingConfirmedEvent = Extract<NexusEvent, { type: 'context_grounding_confirmed' }>
type ContextGroundingConfirmation = {
  confirmationKind: ContextGroundingConfirmedEvent['confirmationKind']
  confirmedFor: ContextGroundingConfirmedEvent['confirmedFor']
  message: string
}

export function buildContextGroundingConfirmedEvent(options: {
  sessionId: string
  requestId?: string
  confirmedByToolUseId: string
  toolName: string
  confirmationKind: ContextGroundingConfirmedEvent['confirmationKind']
  confirmedFor: ContextGroundingConfirmedEvent['confirmedFor']
  source?: ContextGroundingConfirmedEvent['source']
  message?: string
}): ContextGroundingConfirmedEvent {
  return {
    type: 'context_grounding_confirmed',
    ...eventBase(options.sessionId),
    ...(options.requestId && { requestId: options.requestId }),
    confirmedByToolUseId: options.confirmedByToolUseId,
    toolName: options.toolName,
    confirmationKind: options.confirmationKind,
    confirmedFor: [...new Set(options.confirmedFor)],
    source: options.source ?? 'tool_result',
    message: options.message ?? `Context grounding confirmed by ${options.toolName} (${options.confirmationKind}).`,
  }
}

export function buildContextGroundingConfirmedEventForToolResult(options: {
  sessionId: string
  requestId?: string
  events: NexusEvent[]
  toolCompleted: Extract<NexusEvent, { type: 'tool_completed' }>
  toolInput?: unknown
}): ContextGroundingConfirmedEvent | undefined {
  const confirmation = classifyContextGroundingConfirmation({
    toolName: options.toolCompleted.name,
    toolInput: options.toolInput,
    success: options.toolCompleted.success,
  })
  if (!confirmation) return undefined
  if (!hasPendingContextGroundingConfirmation(options.events, confirmation.confirmedFor)) return undefined
  return buildContextGroundingConfirmedEvent({
    sessionId: options.sessionId,
    requestId: options.requestId,
    confirmedByToolUseId: options.toolCompleted.toolUseId,
    toolName: options.toolCompleted.name,
    confirmationKind: confirmation.confirmationKind,
    confirmedFor: confirmation.confirmedFor,
    message: confirmation.message,
  })
}

export function classifyContextGroundingConfirmation(options: {
  toolName: string
  toolInput?: unknown
  success: boolean
}): ContextGroundingConfirmation | undefined {
  if (!options.success) return undefined
  const toolName = options.toolName.toLowerCase()
  if (toolName === 'read') {
    return {
      confirmationKind: 'file_read',
      confirmedFor: ['file_facts', 'implementation_status'],
      message: 'Context grounding confirmed by a successful Read result; current file facts now have source evidence.',
    }
  }
  if (toolName === 'grep' || toolName === 'glob' || toolName === 'listdir') {
    return {
      confirmationKind: 'search_result',
      confirmedFor: ['file_facts', 'implementation_status'],
      message: `Context grounding confirmed by a successful ${options.toolName} result; referenced source layout/search facts now have tool evidence.`,
    }
  }
  if (toolName === 'agentwait' || toolName === 'agentlist') {
    return {
      confirmationKind: 'event_log',
      confirmedFor: ['task_completion', 'implementation_status'],
      message: `Context grounding confirmed by ${options.toolName}; child-agent/task status now has runtime event evidence.`,
    }
  }
  if (toolName !== 'bash') return undefined

  const command = extractToolCommand(options.toolInput)
  if (!command) return undefined
  if (hasGitSubcommand(command, 'status')) {
    return {
      confirmationKind: 'git_status',
      confirmedFor: ['git_status', 'implementation_status'],
      message: 'Context grounding confirmed by git status; current workspace status has source evidence.',
    }
  }
  if (hasGitSubcommand(command, 'diff')) {
    return {
      confirmationKind: 'git_diff',
      confirmedFor: ['file_facts', 'git_status', 'implementation_status'],
      message: 'Context grounding confirmed by git diff; current workspace changes have source evidence.',
    }
  }
  if (isTestCommand(command)) {
    return {
      confirmationKind: 'test_output',
      confirmedFor: ['test_results', 'implementation_status'],
      message: 'Context grounding confirmed by test command output; current test-result claims now have tool evidence.',
    }
  }
  if (isSourceSearchCommand(command)) {
    return {
      confirmationKind: 'search_result',
      confirmedFor: ['file_facts', 'implementation_status'],
      message: 'Context grounding confirmed by a source search/listing command; current source facts now have tool evidence.',
    }
  }
  if (isEventLogCommand(command)) {
    return {
      confirmationKind: 'event_log',
      confirmedFor: ['task_completion', 'implementation_status'],
      message: 'Context grounding confirmed by event-log inspection; task/implementation status now has runtime evidence.',
    }
  }
  return undefined
}

export function hasPendingContextGroundingConfirmation(
  events: NexusEvent[],
  confirmedFor: ContextGroundingConfirmedEvent['confirmedFor'],
): boolean {
  let latestGroundingRequiredIndex = -1
  let latestDirtyWorkspaceIndex = -1
  let latestAnyConfirmationIndex = -1
  let latestGitConfirmationIndex = -1
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]
    if (!event) continue
    if (event.type === 'context_grounding_required') {
      latestGroundingRequiredIndex = index
    } else if (event.type === 'workspace_dirty_detected' && event.changedFileCount > 0) {
      latestDirtyWorkspaceIndex = index
    } else if (event.type === 'context_grounding_confirmed') {
      latestAnyConfirmationIndex = index
      if (event.confirmedFor.includes('git_status')) {
        latestGitConfirmationIndex = index
      }
    }
  }
  const groundingPending = latestGroundingRequiredIndex >= 0 && latestGroundingRequiredIndex > latestAnyConfirmationIndex
  const dirtyWorkspacePending = latestDirtyWorkspaceIndex >= 0 && latestDirtyWorkspaceIndex > latestGitConfirmationIndex
  return groundingPending || (dirtyWorkspacePending && confirmedFor.includes('git_status'))
}

function extractToolCommand(input: unknown): string {
  if (typeof input === 'string') return input.trim()
  if (!input || typeof input !== 'object') return ''
  const record = input as Record<string, unknown>
  for (const key of ['command', 'CommandLine', 'cmd']) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function hasGitSubcommand(command: string, subcommand: 'status' | 'diff'): boolean {
  const words = shellWords(command)
  for (let index = 0; index < words.length; index += 1) {
    if (words[index] !== 'git') continue
    for (let cursor = index + 1; cursor < words.length; cursor += 1) {
      const word = words[cursor]
      if (!word) continue
      if (word === '-c' || word === '-C' || word === '--git-dir' || word === '--work-tree') {
        cursor += 1
        continue
      }
      if (word.startsWith('-')) continue
      return word === subcommand
    }
  }
  return false
}

function isTestCommand(command: string): boolean {
  const normalized = command.toLowerCase()
  return /\b(?:npm|pnpm|yarn)\s+(?:run\s+)?test\b/.test(normalized) ||
    /\b(?:npx\s+)?tsx\s+--test\b/.test(normalized) ||
    /\bnode\s+--test\b/.test(normalized) ||
    /\b(?:go|cargo)\s+test\b/.test(normalized) ||
    /\b(?:pytest|vitest|jest)\b/.test(normalized)
}

function isSourceSearchCommand(command: string): boolean {
  const first = shellWords(command)[0]
  return first === 'rg' || first === 'grep' || first === 'find' || first === 'ls'
}

function isEventLogCommand(command: string): boolean {
  const normalized = command.toLowerCase()
  return /\bbbl\s+sessions\s+(?:inspect|events|show)\b/.test(normalized) ||
    /\b(?:jq|rg|grep)\b[^\n]*(?:\.jsonl|session|event)/.test(normalized)
}

function shellWords(command: string): string[] {
  return command
    .replace(/[;&|()]/g, ' ')
    .split(/\s+/)
    .map(word => word.trim().replace(/^['"]|['"]$/g, '').toLowerCase())
    .filter(Boolean)
}

export function extractChangedFilesFromGitStatus(gitStatus: string): string[] {
  const files: string[] = []
  const seen = new Set<string>()
  for (const rawLine of gitStatus.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('## ') || line.startsWith('Branch:') || line.startsWith('Status:') || line.startsWith('Recent commits:')) continue
    const match = line.match(/^(?:[ MADRCU?!]{1,2}|[A-Z?]{1,2})\s+(.+)$/)
    if (!match) continue
    const file = normalizeGitStatusPath(match[1] ?? '')
    if (!file || seen.has(file)) continue
    seen.add(file)
    files.push(file)
  }
  return files
}

function normalizeGitStatusPath(value: string): string {
  const renamed = value.includes(' -> ') ? value.slice(value.lastIndexOf(' -> ') + 4) : value
  return renamed.trim().replace(/^"|"$/g, '')
}
