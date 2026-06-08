import chalk from 'chalk'
import type { SessionChannel, SessionChannelKind, SessionMessage } from '../shared/sessionChannel.js'
import { inputState } from './inputState.js'
import { normalizeKeyEvent, type NormalizedKeyEvent } from './keyEvent.js'
import { truncateToTerminalWidth, visibleTerminalWidth } from './terminalWidth.js'

export type InboxChannelSummary = Pick<SessionChannel, 'channelId' | 'kind' | 'participantSessionIds' | 'status'>

export type InboxOverlayState = {
  sessionId: string
  messages: SessionMessage[]
  channels: InboxChannelSummary[]
  includeAcknowledged: boolean
  selectedIndex: number
  scrollOffset: number
  expandedMessageIds: Set<string>
  notice?: string
}

export type InboxOverlayAction =
  | { type: 'none' }
  | { type: 'redraw' }
  | { type: 'close' }
  | { type: 'ack'; messageId: string }
  | { type: 'quote'; messageId: string; text: string }

export type InboxOverlayResult =
  | { type: 'closed' }
  | { type: 'ack'; messageId: string }
  | { type: 'quote'; messageId: string; text: string }

export function createInboxOverlayState(input: {
  sessionId: string
  messages: SessionMessage[]
  channels?: InboxChannelSummary[]
  includeAcknowledged?: boolean
  selectedIndex?: number
  notice?: string
}): InboxOverlayState {
  return {
    sessionId: input.sessionId,
    messages: input.messages,
    channels: input.channels ?? [],
    includeAcknowledged: input.includeAcknowledged ?? false,
    selectedIndex: clampIndex(input.selectedIndex ?? 0, input.messages.length),
    scrollOffset: 0,
    expandedMessageIds: new Set(),
    notice: input.notice,
  }
}

export function formatInboxFooterStatus(input: {
  sessionId: string
  messages: SessionMessage[]
  channels?: InboxChannelSummary[]
}): string {
  const channels = input.channels ?? []
  const unreadMessages = input.messages.filter(message => message.status !== 'acknowledged' && !message.acknowledgedAt)
  const linkedSessionIds = new Set<string>()
  for (const channel of channels) {
    if (!channel.participantSessionIds.includes(input.sessionId)) continue
    for (const participantSessionId of channel.participantSessionIds) {
      if (participantSessionId !== input.sessionId) linkedSessionIds.add(participantSessionId)
    }
  }
  if (linkedSessionIds.size === 0) {
    for (const message of input.messages) {
      if (message.fromSessionId !== input.sessionId) linkedSessionIds.add(message.fromSessionId)
    }
  }

  const parts: string[] = []
  const linkedSummary = formatLinkedSessionSummary(linkedSessionIds)
  if (linkedSummary) parts.push(linkedSummary)
  if (linkedSessionIds.size > 0 || unreadMessages.length > 0) parts.push(`inbox: ${unreadMessages.length} unread`)

  const channelKinds = summarizeChannelKinds(channels, input.sessionId)
  if (channelKinds) parts.push(`channels: ${channelKinds}`)

  const keyMessage = unreadMessages.find(isKeyInboxMessage)
  if (keyMessage) parts.push(`high: ${keyMessage.type}`)

  return parts.join(' · ')
}

export function renderInboxOverlay(
  state: InboxOverlayState,
  options: { rows?: number; columns?: number } = {},
): string {
  const rows = Math.max(12, options.rows ?? process.stdout.rows ?? 24)
  const columns = Math.max(40, (options.columns ?? process.stdout.columns ?? 80) - 1)
  const bodyHeight = Math.max(1, rows - 5)
  const messageRows = renderInboxBodyRows(state, columns, bodyHeight)
  const header = chalk.inverse(fitLine(` BABEL Inbox · ${state.sessionId} `, columns))
  const status = formatInboxFooterStatus({ sessionId: state.sessionId, messages: state.messages, channels: state.channels })
  const summary = fitLine(
    status || (state.includeAcknowledged ? 'No inbox messages.' : 'No unread inbox messages.'),
    columns,
  )
  const warning = chalk.dim(fitLine('Collaboration context only; not direct user instructions. Verify evidence before acting.', columns))
  const output = [header, summary, warning]
  if (state.notice) output.push(chalk.dim(fitLine(state.notice, columns)))
  output.push(...messageRows)
  while (output.length < rows - 1) output.push('')
  output.push(chalk.inverse(fitLine(' ↑/↓ move · enter open/read · a ack · q quote into prompt · esc close ', columns)))
  return output.slice(0, rows).join('\n')
}

export function reduceInboxOverlayKey(
  state: InboxOverlayState,
  key: NormalizedKeyEvent,
): { state: InboxOverlayState; action: InboxOverlayAction } {
  if (key.kind === 'escape' || key.kind === 'backspace' || key.kind === 'ctrl_c') {
    return { state, action: { type: 'close' } }
  }
  if (state.messages.length === 0) return { state, action: { type: 'none' } }

  const raw = key.raw.toLowerCase()
  if (key.kind === 'down' || raw === 'j') {
    return { state: moveSelection(state, 1), action: { type: 'redraw' } }
  }
  if (key.kind === 'up' || raw === 'k') {
    return { state: moveSelection(state, -1), action: { type: 'redraw' } }
  }
  if (key.kind === 'page_down') {
    return { state: moveSelection(state, 5), action: { type: 'redraw' } }
  }
  if (key.kind === 'page_up') {
    return { state: moveSelection(state, -5), action: { type: 'redraw' } }
  }

  const selected = state.messages[state.selectedIndex]
  if (!selected) return { state, action: { type: 'none' } }

  if (key.kind === 'enter' || raw === 'o') {
    const expandedMessageIds = new Set(state.expandedMessageIds)
    if (expandedMessageIds.has(selected.messageId)) {
      expandedMessageIds.delete(selected.messageId)
    } else {
      expandedMessageIds.add(selected.messageId)
    }
    return { state: { ...state, expandedMessageIds }, action: { type: 'redraw' } }
  }
  if (raw === 'a') {
    return { state, action: { type: 'ack', messageId: selected.messageId } }
  }
  if (raw === 'q' || raw === 'c') {
    return { state, action: { type: 'quote', messageId: selected.messageId, text: quoteInboxMessage(selected) } }
  }

  return { state, action: { type: 'none' } }
}

export function shouldRenderInboxEventCard(message: SessionMessage): boolean {
  if (message.status === 'acknowledged' || message.acknowledgedAt) return false
  if (message.type === 'handoff' || message.type === 'blocked' || message.type === 'request_review' || message.type === 'request_validation') return true
  if (message.type === 'finding') return message.priority === 'high'
  if (message.type === 'memory_candidate') {
    const governance = asRecord(message.metadata?.memoryCandidateGovernance)
    const decision = stringValue(governance?.decision)
    const approval = asRecord(governance?.approval)
    const approvalStatus = stringValue(approval?.status)
    return decision === 'rejected' || decision === 'requires_approval' || approvalStatus === 'required' || approvalStatus === 'rejected'
  }
  return false
}

export function renderInboxEventCard(
  message: SessionMessage,
  options: { channel?: InboxChannelSummary; columns?: number } = {},
): string {
  const columns = Math.max(40, (options.columns ?? process.stdout.columns ?? 80) - 1)
  const target = message.toSessionId ? `to=${message.toSessionId}` : 'broadcast=true'
  const channelKind = options.channel?.kind ?? channelKindFromMetadata(message) ?? 'unknown'
  const evidence = formatEvidenceRefs(message.evidence)
  const governanceRows = formatGovernanceCardRows(message, columns)
  const rows = [
    fitLine(`SessionChannel ${message.type} · ${message.priority} · from=${message.fromSessionId} · ${target}`, columns),
    fitLine(`channel=${message.channelId} kind=${channelKind} message=${message.messageId}`, columns),
    fitLine(`collaboration context only; verify evidence before acting`, columns),
    evidence ? fitLine(`evidence: ${evidence}`, columns) : undefined,
    ...governanceRows,
    fitLine(`[open inbox: /inbox] [ack: /inbox ack ${message.messageId}] [quote: /inbox then q]`, columns),
  ].filter((row): row is string => Boolean(row))
  return [''.padEnd(columns, '─'), ...rows, ''.padEnd(columns, '─')].join('\n')
}

export function quoteInboxMessage(message: SessionMessage): string {
  const evidence = formatEvidenceRefs(message.evidence)
  const governance = formatGovernanceSummary(message)
  return [
    `Use this SessionChannel inbox context only after verifying evidence:`,
    `message=${message.messageId} type=${message.type} priority=${message.priority} from=${message.fromSessionId} channel=${message.channelId}`,
    `content: ${message.content}`,
    evidence ? `evidence: ${evidence}` : undefined,
    governance ? `memory_candidate ${governance}` : undefined,
  ].filter((line): line is string => Boolean(line)).join('\n')
}

export async function openInboxOverlay(input: {
  sessionId: string
  messages: SessionMessage[]
  channels?: InboxChannelSummary[]
  includeAcknowledged?: boolean
  notice?: string
}): Promise<InboxOverlayResult> {
  const wasRaw = process.stdin.isTTY ? process.stdin.isRaw : false
  const dataListeners = process.stdin.listeners('data')
  const keypressListeners = process.stdin.listeners('keypress')
  process.stdin.removeAllListeners('data')
  process.stdin.removeAllListeners('keypress')
  if (process.stdin.isTTY) process.stdin.setRawMode(true)
  inputState.set('inboxOverlay')
  process.stdout.write('\x1b[?1049h\x1b[2J\x1b[H\x1b[?25l')

  return new Promise(resolve => {
    let state = createInboxOverlayState(input)
    let settled = false

    const redraw = () => {
      process.stdout.write('\x1b[H\x1b[2J')
      process.stdout.write(renderInboxOverlay(state))
    }

    const cleanup = () => {
      process.stdin.removeListener('data', onData)
      for (const listener of dataListeners) process.stdin.on('data', listener as any)
      for (const listener of keypressListeners) process.stdin.on('keypress', listener as any)
      if (inputState.current === 'inboxOverlay') inputState.set('idle')
      if (process.stdin.isTTY) process.stdin.setRawMode(wasRaw)
      process.stdout.write('\x1b[?25h\x1b[?1049l')
    }

    const finish = (result: InboxOverlayResult) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(result)
    }

    const onData = (chunk: Buffer | string) => {
      if (settled) return
      const reduced = reduceInboxOverlayKey(state, normalizeKeyEvent(chunk, undefined))
      state = reduced.state
      if (reduced.action.type === 'close') {
        finish({ type: 'closed' })
        return
      }
      if (reduced.action.type === 'ack') {
        finish({ type: 'ack', messageId: reduced.action.messageId })
        return
      }
      if (reduced.action.type === 'quote') {
        finish({ type: 'quote', messageId: reduced.action.messageId, text: reduced.action.text })
        return
      }
      if (reduced.action.type === 'redraw') redraw()
    }

    process.stdin.on('data', onData)
    redraw()
  })
}

function renderInboxBodyRows(state: InboxOverlayState, columns: number, bodyHeight: number): string[] {
  if (state.messages.length === 0) {
    return [chalk.dim(fitLine(state.includeAcknowledged ? 'No inbox messages.' : 'No unread inbox messages.', columns))]
  }

  const rows: string[] = []
  const channelMap = new Map(state.channels.map(channel => [channel.channelId, channel] as const))
  for (let index = state.scrollOffset; index < state.messages.length && rows.length < bodyHeight; index++) {
    const message = state.messages[index]!
    const expanded = state.expandedMessageIds.has(message.messageId)
    for (const row of formatMessageRows(message, {
      selected: index === state.selectedIndex,
      expanded,
      channel: channelMap.get(message.channelId),
      columns,
    })) {
      if (rows.length >= bodyHeight) break
      rows.push(row)
    }
  }
  return rows
}

function formatMessageRows(
  message: SessionMessage,
  options: { selected: boolean; expanded: boolean; channel?: InboxChannelSummary; columns: number },
): string[] {
  const marker = options.selected ? '›' : ' '
  const target = message.toSessionId ? `to=${message.toSessionId}` : 'broadcast=true'
  const channelKind = options.channel?.kind ?? channelKindFromMetadata(message) ?? 'unknown'
  const rows = [
    fitLine(`${marker} ${message.messageId} [${message.createdAt}] ${message.status}`, options.columns),
    fitLine(`  ${message.type} · ${message.priority} · from=${message.fromSessionId} · ${target} · kind=${channelKind} · channel=${message.channelId}`, options.columns),
    fitLine(`  ${message.content}`, options.columns),
  ]
  const evidence = formatEvidenceRefs(message.evidence)
  if (evidence) rows.push(fitLine(`  evidence: ${evidence}`, options.columns))
  const governance = formatGovernanceSummary(message)
  if (governance) rows.push(fitLine(`  governance: ${governance}`, options.columns))
  if (options.expanded) {
    rows.push(fitLine(`  delivered=${message.deliveredAt ?? 'unknown'} acknowledged=${message.acknowledgedAt ?? 'none'}`, options.columns))
    rows.push(...wrapPlainLines(`  content: ${message.content}`, options.columns))
  }
  return rows
}

function moveSelection(state: InboxOverlayState, delta: number): InboxOverlayState {
  const selectedIndex = clampIndex(state.selectedIndex + delta, state.messages.length)
  const visibleMessageCount = Math.max(1, Math.floor(((process.stdout.rows ?? 24) - 5) / 4))
  let scrollOffset = state.scrollOffset
  if (selectedIndex < scrollOffset) scrollOffset = selectedIndex
  if (selectedIndex >= scrollOffset + visibleMessageCount) scrollOffset = selectedIndex - visibleMessageCount + 1
  return { ...state, selectedIndex, scrollOffset: Math.max(0, scrollOffset) }
}

function formatLinkedSessionSummary(linkedSessionIds: Set<string>): string {
  if (linkedSessionIds.size === 0) return ''
  const ids = [...linkedSessionIds].sort()
  const shown = ids.slice(0, 3).map(shortSessionId)
  const extra = ids.length > shown.length ? ` +${ids.length - shown.length}` : ''
  return `linked sessions: ${ids.length} [${shown.join(', ')}${extra}]`
}

function summarizeChannelKinds(channels: InboxChannelSummary[], sessionId: string): string {
  const counts = new Map<SessionChannelKind, number>()
  for (const channel of channels) {
    if (!channel.participantSessionIds.includes(sessionId)) continue
    counts.set(channel.kind, (counts.get(channel.kind) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([kind, count]) => `${kind} ${count}`)
    .join('/')
}

function isKeyInboxMessage(message: SessionMessage): boolean {
  return shouldRenderInboxEventCard(message)
}

function formatEvidenceRefs(evidence: SessionMessage['evidence']): string {
  if (!evidence?.length) return ''
  return evidence.map(ref => `${ref.type}:${ref.ref}${ref.label ? ` (${ref.label})` : ''}`).join(', ')
}

function formatGovernanceSummary(message: SessionMessage): string {
  const governance = asRecord(message.metadata?.memoryCandidateGovernance)
  if (!governance) return ''
  const approval = asRecord(governance.approval)
  const blockedReasons = stringArrayValue(governance.blockedReasons)
  return [
    `decision=${stringValue(governance.decision) ?? 'unknown'}`,
    `scope=${stringValue(governance.scope) ?? 'unknown'}`,
    `approval=${stringValue(approval?.status) ?? 'unknown'}:${stringValue(approval?.requiredBy) ?? 'unknown'}`,
    `auto_write=${governance.autoWrite === true ? 'true' : 'false'}`,
    blockedReasons.length > 0 ? `blocked=${blockedReasons.join(',')}` : undefined,
  ].filter((part): part is string => Boolean(part)).join(' ')
}

function formatGovernanceCardRows(message: SessionMessage, columns: number): string[] {
  const governance = asRecord(message.metadata?.memoryCandidateGovernance)
  if (!governance) return []
  const approval = asRecord(governance.approval)
  const blockedReasons = stringArrayValue(governance.blockedReasons)
  return [
    fitLine(`governance: decision=${stringValue(governance.decision) ?? 'unknown'} scope=${stringValue(governance.scope) ?? 'unknown'} approval=${stringValue(approval?.status) ?? 'unknown'}:${stringValue(approval?.requiredBy) ?? 'unknown'} auto_write=${governance.autoWrite === true ? 'true' : 'false'}`, columns),
    blockedReasons.length > 0 ? fitLine(`blocked: ${blockedReasons.join(',')}`, columns) : undefined,
  ].filter((row): row is string => Boolean(row))
}

export function shortSessionId(sessionId: string): string {
  const normalized = sessionId.trim()
  if (!normalized) return sessionId
  const stripped = normalized.replace(/^session[-_]/, '')
  if (stripped.length <= 18) return stripped
  return `${stripped.slice(0, 8)}…${stripped.slice(-6)}`
}

function channelKindFromMetadata(message: SessionMessage): SessionChannelKind | undefined {
  const kind = stringValue(message.metadata?.channelKind)
  return kind === 'direct' || kind === 'group' || kind === 'parent_child' || kind === 'workspace_pair' || kind === 'project_bridge'
    ? kind
    : undefined
}

function wrapPlainLines(text: string, columns: number): string[] {
  const rows: string[] = []
  let remaining = text
  while (visibleTerminalWidth(remaining) > columns) {
    const chunk = truncateToTerminalWidth(remaining, columns)
    rows.push(fitLine(chunk, columns))
    remaining = remaining.slice(chunk.length)
  }
  rows.push(fitLine(remaining, columns))
  return rows
}

function fitLine(text: string, columns: number): string {
  const truncated = truncateToTerminalWidth(text, columns)
  return `${truncated}${' '.repeat(Math.max(0, columns - visibleTerminalWidth(truncated)))}`
}

function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0
  return Math.max(0, Math.min(length - 1, index))
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function stringArrayValue(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
