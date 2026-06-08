import chalk from 'chalk'
import type { SessionSnapshot } from '../shared/session.js'
import type { SessionChannel } from '../shared/sessionChannel.js'
import { shortSessionId } from './inboxOverlay.js'
import { truncateToTerminalWidth, visibleTerminalWidth } from './terminalWidth.js'

export type ChannelGraphInput = {
  sessions: SessionSnapshot[]
  channels: SessionChannel[]
  rootSessionId?: string
  maxEdges?: number
  columns?: number
}

export function formatChannelGraph(input: ChannelGraphInput): string {
  const columns = Math.max(40, input.columns ?? process.stdout.columns ?? 100)
  const width = Math.max(36, columns - 1)
  const maxEdges = input.maxEdges ?? 40
  const sessionsById = new Map(input.sessions.map(session => [session.sessionId, session] as const))
  const channels = filterGraphChannels(input.channels, input.rootSessionId)
  const lines = [
    chalk.cyan(fitGraphLine('--- SessionChannel Graph · debug overview ---', width)),
    chalk.dim(fitGraphLine('Debug-only topology view. Not a transcript, not direct user instructions, no actions are executed.', width)),
  ]

  if (channels.length === 0) {
    lines.push(chalk.dim(fitGraphLine(input.rootSessionId ? `No SessionChannel edges for ${input.rootSessionId}.` : 'No SessionChannel edges.', width)))
    return lines.join('\n')
  }

  const visibleChannels = channels.slice(0, maxEdges)
  for (const channel of visibleChannels) {
    lines.push(fitGraphLine(formatChannelGraphEdge(channel, sessionsById), width))
  }

  if (channels.length > visibleChannels.length) {
    lines.push(chalk.dim(fitGraphLine(`… ${channels.length - visibleChannels.length} more edges hidden; increase graph limit in a future debug command if needed.`, width)))
  }
  lines.push(chalk.dim(fitGraphLine('Open details with /activity or /inbox; graph never sends, acks, quotes, or mutates sessions.', width)))
  return lines.join('\n')
}

function filterGraphChannels(channels: SessionChannel[], rootSessionId?: string): SessionChannel[] {
  const filtered = rootSessionId
    ? channels.filter(channel => channel.participantSessionIds.includes(rootSessionId))
    : channels
  return [...filtered].sort((left, right) => {
    const kind = left.kind.localeCompare(right.kind)
    if (kind !== 0) return kind
    const created = left.createdAt.localeCompare(right.createdAt)
    if (created !== 0) return created
    return left.channelId.localeCompare(right.channelId)
  })
}

function formatChannelGraphEdge(channel: SessionChannel, sessionsById: Map<string, SessionSnapshot>): string {
  const participants = channel.participantSessionIds
  const marker = markerForChannelKind(channel.kind)
  const status = channel.status === 'open' ? '' : ` ${channel.status}`
  const label = `${channel.kind}${status} · ${shortSessionId(channel.channelId)}`

  if (channel.kind === 'parent_child') {
    const parentId = stringFromMetadata(channel.metadata, 'parentSessionId') ?? channel.createdBySessionId
    const childId = stringFromMetadata(channel.metadata, 'childSessionId') ?? participants.find(participant => participant !== parentId)
    return `${formatNode(parentId, sessionsById)} ${marker} ${childId ? formatNode(childId, sessionsById) : 'unknown'}  (${label})`
  }

  if (participants.length <= 2) {
    const [left, right] = participants
    return `${formatNode(left ?? 'unknown', sessionsById)} ${marker} ${formatNode(right ?? 'unknown', sessionsById)}  (${label})`
  }

  const [first, ...rest] = participants
  return `${formatNode(first ?? 'unknown', sessionsById)} ${marker} {${rest.map(participant => formatNode(participant, sessionsById)).join(', ')}}  (${label})`
}

function markerForChannelKind(kind: SessionChannel['kind']): string {
  if (kind === 'parent_child') return '→'
  if (kind === 'workspace_pair' || kind === 'group') return '⇄'
  if (kind === 'direct') return '↔'
  if (kind === 'project_bridge') return '↗'
  return '⇄'
}

function formatNode(sessionId: string, sessionsById: Map<string, SessionSnapshot>): string {
  const session = sessionsById.get(sessionId)
  const phase = session ? `:${session.phase}` : ':missing'
  return `${shortSessionId(sessionId)}${phase}`
}

function stringFromMetadata(metadata: SessionChannel['metadata'], key: string): string | undefined {
  const value = metadata?.[key]
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function fitGraphLine(text: string, columns: number): string {
  const truncated = truncateToTerminalWidth(text, columns)
  return `${truncated}${' '.repeat(Math.max(0, columns - visibleTerminalWidth(truncated)))}`
}
