import chalk from 'chalk'
import { Command } from 'commander'
import { NexusClient } from '../NexusClient.js'

import type { SessionSnapshot } from '../../shared/session.js'
import type { SessionChannel, SessionMessage } from '../../shared/sessionChannel.js'

export function registerSessionsCommand(program: Command): void {
  const sessions = program.command('sessions').description('Inspect Nexus sessions')

  sessions
    .command('list')
    .description('List sessions')
    .option('--url <url>', 'Nexus URL')
    .option('--json', 'Print raw JSON response')
    .action(async (options: { url?: string; json?: boolean }) => {
      const client = new NexusClient({ baseUrl: options.url })
      const list = await client.listSessions()
      if (options.json) {
        console.log(JSON.stringify(list, null, 2))
        return
      }
      console.log(formatSessionsList(list, await loadSessionRelationshipSummary(client, parseSessionsList(list))))
    })

  sessions
    .command('tree')
    .description('Show parent-child session tree with relationship markers')
    .argument('[rootSessionId]', 'Optional root session id')
    .option('--url <url>', 'Nexus URL')
    .option('--limit <count>', 'Sessions to fetch', '200')
    .action(async (
      rootSessionId: string | undefined,
      options: { url?: string; limit: string },
    ) => {
      const client = new NexusClient({ baseUrl: options.url })
      const list = await client.listSessions({ limit: Number(options.limit) })
      const sessions = parseSessionsList(list)
      console.log(formatSessionsTree(list, await loadSessionRelationshipSummary(client, sessions), { rootSessionId }))
    })

  sessions
    .command('show')
    .description('Show one session')
    .argument('<sessionId>', 'Session id')
    .option('--url <url>', 'Nexus URL')
    .option('--recent-event-limit <count>', 'Number of recent events to include', '100')
    .action(async (
      sessionId: string,
      options: { url?: string; recentEventLimit: string },
    ) => {
      console.log(
        JSON.stringify(
          await new NexusClient({ baseUrl: options.url }).getSession(sessionId, {
            recentEventLimit: Number(options.recentEventLimit),
          }),
          null,
          2,
        ),
      )
    })

  sessions
    .command('events')
    .description('Page through session events')
    .argument('<sessionId>', 'Session id')
    .option('--url <url>', 'Nexus URL')
    .option('--limit <count>', 'Events to fetch', '100')
    .option('--cursor <cursor>', 'Pagination cursor')
    .option('--order <order>', 'asc or desc', 'asc')
    .action(async (
      sessionId: string,
      options: { url?: string; limit: string; cursor?: string; order: string },
    ) => {
      console.log(
        JSON.stringify(
          await new NexusClient({ baseUrl: options.url }).listSessionEvents(sessionId, {
            limit: Number(options.limit),
            cursor: options.cursor,
            order: options.order === 'desc' ? 'desc' : 'asc',
          }),
          null,
          2,
        ),
      )
    })

  sessions
    .command('inbox')
    .description('Show unread SessionChannel inbox messages')
    .argument('<sessionId>', 'Session id')
    .option('--url <url>', 'Nexus URL')
    .option('--limit <count>', 'Inbox messages to fetch', '20')
    .option('--include-acknowledged', 'Include acknowledged messages')
    .option('--json', 'Print raw JSON response')
    .action(async (
      sessionId: string,
      options: { url?: string; limit: string; includeAcknowledged?: boolean; json?: boolean },
    ) => {
      const inbox = await new NexusClient({ baseUrl: options.url }).listSessionInbox(sessionId, {
        limit: Number(options.limit),
        includeAcknowledged: options.includeAcknowledged === true,
      })
      console.log(options.json ? JSON.stringify(inbox, null, 2) : formatSessionInbox(inbox))
    })

  sessions
    .command('ack')
    .description('Acknowledge one SessionChannel inbox message')
    .argument('<sessionId>', 'Session id')
    .argument('<messageId>', 'Session message id')
    .option('--url <url>', 'Nexus URL')
    .option('--json', 'Print raw JSON response')
    .action(async (
      sessionId: string,
      messageId: string,
      options: { url?: string; json?: boolean },
    ) => {
      const ack = await new NexusClient({ baseUrl: options.url }).ackSessionMessage(sessionId, messageId)
      console.log(options.json ? JSON.stringify(ack, null, 2) : formatSessionAck(ack))
    })

  sessions
    .command('children')
    .description('List child sessions with transcript previews')
    .argument('<sessionId>', 'Parent session id')
    .option('--url <url>', 'Nexus URL')
    .option('--limit <count>', 'Child sessions to fetch', '200')
    .option('--event-limit <count>', 'Recent child events to include', '5')
    .option('--failed-only', 'Only include failed or cancelled child sessions')
    .option('--no-events', 'Do not include event previews')
    .action(async (
      sessionId: string,
      options: { url?: string; limit: string; eventLimit: string; failedOnly?: boolean; events?: boolean },
    ) => {
      console.log(
        JSON.stringify(
          await new NexusClient({ baseUrl: options.url }).listChildSessions(sessionId, {
            limit: Number(options.limit),
            eventLimit: Number(options.eventLimit),
            failedOnly: options.failedOnly === true,
            includeEvents: options.events !== false,
          }),
          null,
          2,
        ),
      )
    })

  sessions
    .command('child-events')
    .description('Page through a child session transcript from its parent session')
    .argument('<sessionId>', 'Parent session id')
    .argument('<childSessionId>', 'Child session id')
    .option('--url <url>', 'Nexus URL')
    .option('--limit <count>', 'Events to fetch', '100')
    .option('--cursor <cursor>', 'Pagination cursor')
    .option('--order <order>', 'asc or desc', 'asc')
    .action(async (
      sessionId: string,
      childSessionId: string,
      options: { url?: string; limit: string; cursor?: string; order: string },
    ) => {
      console.log(
        JSON.stringify(
          await new NexusClient({ baseUrl: options.url }).listChildSessionEvents(
            sessionId,
            childSessionId,
            {
              limit: Number(options.limit),
              cursor: options.cursor,
              order: options.order === 'desc' ? 'desc' : 'asc',
            },
          ),
          null,
          2,
        ),
      )
    })

  sessions
    .command('retry-task')
    .description('Mark a failed task pending again so an operator or AgentLoop can rerun it')
    .argument('<sessionId>', 'Session id')
    .argument('<taskId>', 'Task id')
    .option('--url <url>', 'Nexus URL')
    .option('--reason <reason>', 'Retry reason', 'retry requested from CLI')
    .action(async (sessionId: string, taskId: string, options: { url?: string; reason: string }) => {
      console.log(
        JSON.stringify(
          await new NexusClient({ baseUrl: options.url }).mutateTask(sessionId, taskId, 'retry', {
            actor: 'cli',
            source: 'sessions.retry-task',
            reason: options.reason,
          }),
          null,
          2,
        ),
      )
    })

  sessions
    .command('rerun-subagent')
    .description('Mark a failed sub-agent task pending again with transcript-preserving audit metadata')
    .argument('<sessionId>', 'Parent session id')
    .argument('<taskId>', 'Failed sub-agent task id')
    .option('--url <url>', 'Nexus URL')
    .option('--reason <reason>', 'Rerun reason', 'sub-agent rerun requested from CLI')
    .action(async (sessionId: string, taskId: string, options: { url?: string; reason: string }) => {
      console.log(
        JSON.stringify(
          await new NexusClient({ baseUrl: options.url }).rerunSubAgentTask(sessionId, taskId, {
            actor: 'cli',
            source: 'sessions.rerun-subagent',
            reason: options.reason,
          }),
          null,
          2,
        ),
      )
    })

  sessions
    .command('worktree-recovery')
    .description('Record a worktree conflict recovery action for a task')
    .argument('<sessionId>', 'Session id')
    .argument('<taskId>', 'Task id')
    .argument('<action>', 'continue, abandon, or keep')
    .option('--url <url>', 'Nexus URL')
    .option('--reason <reason>', 'Recovery reason')
    .action(async (
      sessionId: string,
      taskId: string,
      action: string,
      options: { url?: string; reason?: string },
    ) => {
      if (action !== 'continue' && action !== 'abandon' && action !== 'keep') {
        throw new Error(`Invalid worktree recovery action: ${action}`)
      }
      console.log(
        JSON.stringify(
          await new NexusClient({ baseUrl: options.url }).recoverWorktreeTask(sessionId, taskId, action, {
            actor: 'cli',
            source: 'sessions.worktree-recovery',
            reason: options.reason,
          }),
          null,
          2,
        ),
      )
    })

  sessions
    .command('resume')
    .description('Record user input for a session')
    .argument('<sessionId>', 'Session id')
    .argument('<message...>', 'Message to append')
    .option('--url <url>', 'Nexus URL')
    .action(async (sessionId: string, messageParts: string[], options: { url?: string }) => {
      console.log(
        JSON.stringify(
          await new NexusClient({ baseUrl: options.url }).resumeSession(
            sessionId,
            messageParts.join(' '),
          ),
          null,
          2,
        ),
      )
    })

  sessions
    .command('cancel')
    .description('Cancel a session')
    .argument('<sessionId>', 'Session id')
    .option('--url <url>', 'Nexus URL')
    .action(async (sessionId: string, options: { url?: string }) => {
      console.log(
        JSON.stringify(
          await new NexusClient({ baseUrl: options.url }).cancelSession(sessionId),
          null,
          2,
        ),
      )
    })
}

export type SessionsListResponse = {
  type: 'sessions_list'
  sessions: SessionSnapshot[]
}

export type SessionRelationshipSummary = {
  channels?: SessionChannel[]
  inboxBySessionId?: Map<string, SessionMessage[]>
}

export type SessionsTreeOptions = {
  rootSessionId?: string
}

export function formatSessionsList(input: unknown, relationships: SessionRelationshipSummary = {}): string {
  const sessions = parseSessionsList(input)
  const lines = [chalk.cyan('--- Sessions ---')]
  if (sessions.length === 0) {
    lines.push(chalk.dim('No sessions.'))
    return lines.join('\n')
  }

  for (const session of sessions) {
    const badge = formatSessionRelationshipBadge(session, relationships)
    const cwd = session.cwd ? ` · ${session.cwd}` : ''
    lines.push(`${chalk.bold(session.sessionId)} ${chalk.dim(session.phase)}${badge ? ` ${badge}` : ''}${cwd}`)
  }
  lines.push(chalk.dim('Open details with: bbl sessions inbox <sessionId> or /inbox inside bbl go.'))
  return lines.join('\n')
}

export function formatSessionsTree(
  input: unknown,
  relationships: SessionRelationshipSummary = {},
  options: SessionsTreeOptions = {},
): string {
  const sessions = parseSessionsList(input)
  const lines = [chalk.cyan('--- Session Tree ---')]
  if (sessions.length === 0) {
    lines.push(chalk.dim('No sessions.'))
    return lines.join('\n')
  }

  const byParent = new Map<string, SessionSnapshot[]>()
  const sessionIds = new Set(sessions.map(session => session.sessionId))
  for (const session of sessions) {
    const parentId = session.parentSessionId && sessionIds.has(session.parentSessionId)
      ? session.parentSessionId
      : ''
    const siblings = byParent.get(parentId) ?? []
    siblings.push(session)
    byParent.set(parentId, siblings)
  }
  for (const siblings of byParent.values()) siblings.sort(compareSessionsForTree)

  const root = options.rootSessionId ? sessions.find(session => session.sessionId === options.rootSessionId) : undefined
  const roots = root ? [root] : (byParent.get('') ?? [])
  if (options.rootSessionId && !root) {
    lines.push(chalk.yellow(`Root session not found in fetched session list: ${options.rootSessionId}`))
    return lines.join('\n')
  }

  const rendered = new Set<string>()
  for (let index = 0; index < roots.length; index++) {
    appendSessionTreeRows(lines, roots[index]!, {
      byParent,
      relationships,
      prefix: '',
      isLast: index === roots.length - 1,
      rendered,
    })
  }
  lines.push(chalk.dim('Tree shows parent-child session structure only; non-tree channels stay as row badges.'))
  lines.push(chalk.dim('Open message details with: /inbox in bbl go or bbl sessions inbox <sessionId>.'))
  return lines.join('\n')
}

export async function loadSessionRelationshipSummary(
  client: Pick<NexusClient, 'listSessionChannels' | 'listSessionInbox'>,
  sessions: SessionSnapshot[],
): Promise<SessionRelationshipSummary> {
  let channels: SessionChannel[] = []
  try {
    channels = (await client.listSessionChannels({ limit: 200 })).channels
  } catch {
    channels = []
  }
  const channelSessionIds = new Set(channels.flatMap(channel => channel.participantSessionIds))
  const inboxBySessionId = new Map<string, SessionMessage[]>()
  await Promise.all(sessions.map(async session => {
    if (!channelSessionIds.has(session.sessionId)) return
    try {
      inboxBySessionId.set(session.sessionId, (await client.listSessionInbox(session.sessionId, { limit: 20 })).messages)
    } catch {
      inboxBySessionId.set(session.sessionId, [])
    }
  }))
  return { channels, inboxBySessionId }
}

export type SessionInboxResponse = {
  type: 'session_inbox'
  sessionId: string
  messages: SessionMessage[]
  limit: number
  includeAcknowledged: boolean
}

export type SessionAckResponse = {
  type: 'session_message_acknowledged'
  sessionId: string
  message: SessionMessage | null
}

export function formatSessionInbox(inbox: SessionInboxResponse): string {
  const lines = [
    chalk.cyan(`--- Session Inbox: ${inbox.sessionId} ---`),
    chalk.dim('Collaboration context only. Verify claims before acting.'),
  ]
  if (inbox.messages.length === 0) {
    lines.push(chalk.dim(inbox.includeAcknowledged ? 'No inbox messages.' : 'No unread inbox messages.'))
    return lines.join('\n')
  }

  for (const message of inbox.messages) {
    lines.push(formatSessionInboxMessage(message))
  }
  lines.push(chalk.dim(`Ack with: /inbox ack <messageId> or bbl sessions ack ${inbox.sessionId} <messageId>`))
  return lines.join('\n')
}

export function formatSessionAck(response: SessionAckResponse): string {
  if (!response.message) return chalk.yellow(`No message acknowledged for session ${response.sessionId}.`)
  return [
    chalk.green(`Acknowledged ${response.message.messageId} for session ${response.sessionId}.`),
    formatSessionInboxMessage(response.message),
  ].join('\n')
}

function appendSessionTreeRows(
  lines: string[],
  session: SessionSnapshot,
  options: {
    byParent: Map<string, SessionSnapshot[]>
    relationships: SessionRelationshipSummary
    prefix: string
    isLast: boolean
    rendered: Set<string>
  },
): void {
  if (options.rendered.has(session.sessionId)) return
  options.rendered.add(session.sessionId)
  const connector = options.prefix ? (options.isLast ? '└─ ' : '├─ ') : ''
  lines.push(`${options.prefix}${connector}${formatSessionTreeNode(session, options.relationships)}`)
  const children = options.byParent.get(session.sessionId) ?? []
  const childPrefix = options.prefix + (options.isLast ? '   ' : '│  ')
  for (let index = 0; index < children.length; index++) {
    appendSessionTreeRows(lines, children[index]!, {
      ...options,
      prefix: childPrefix,
      isLast: index === children.length - 1,
    })
  }
}

function formatSessionTreeNode(session: SessionSnapshot, relationships: SessionRelationshipSummary): string {
  const badge = formatSessionRelationshipBadge(session, relationships)
  const label = `● ${session.sessionId}`
  const status = chalk.dim(session.phase)
  const agent = stringFromMetadata(session.metadata, 'agentType') ?? session.assignedAgentId
  const meta = [status, agent ? chalk.dim(`agent=${agent}`) : '', badge].filter(Boolean).join(' ')
  return `${chalk.bold(label)} ${meta}`.trimEnd()
}

function compareSessionsForTree(left: SessionSnapshot, right: SessionSnapshot): number {
  const created = left.createdAt.localeCompare(right.createdAt)
  if (created !== 0) return created
  return left.sessionId.localeCompare(right.sessionId)
}

function formatSessionRelationshipBadge(session: SessionSnapshot, relationships: SessionRelationshipSummary): string {
  const channels = (relationships.channels ?? []).filter(channel => channel.participantSessionIds.includes(session.sessionId))
  const messages = relationships.inboxBySessionId?.get(session.sessionId) ?? []
  const unreadMessages = messages.filter(message => message.status !== 'acknowledged' && !message.acknowledgedAt)
  const parts: string[] = []

  const parentChannel = channels.find(channel => channel.kind === 'parent_child')
  if (parentChannel) {
    const parentId = session.parentSessionId ?? parentChannel.createdBySessionId
    if (parentId && parentId !== session.sessionId) parts.push(`← ${shortSessionId(parentId)}`)
    const children = parentChannel.participantSessionIds.filter(participant => participant !== session.sessionId && participant !== parentId)
    if (children.length > 0) parts.push(`→ ${children.slice(0, 2).map(shortSessionId).join(',')}${children.length > 2 ? ` +${children.length - 2}` : ''}`)
  }

  for (const channel of channels) {
    if (parts.length >= 2) break
    if (channel.kind === 'parent_child') continue
    const marker = markerForChannelKind(channel.kind)
    const peers = channel.participantSessionIds.filter(participant => participant !== session.sessionId)
    if (peers.length === 0) continue
    parts.push(`${marker} ${peers.slice(0, 2).map(shortSessionId).join(',')}${peers.length > 2 ? ` +${peers.length - 2}` : ''}`)
  }

  if (unreadMessages.length > 0) {
    parts.push(unreadMessages.some(message => message.priority === 'high' || isKeyInboxMessage(message)) ? `!!${unreadMessages.length}` : `!${unreadMessages.length}`)
    const keyMessage = unreadMessages.find(isKeyInboxMessage) ?? unreadMessages.find(message => message.priority === 'high')
    if (keyMessage) parts.push(keyMessage.type)
  }

  return parts.length > 0 ? chalk.dim(parts.join(' · ')) : ''
}

function markerForChannelKind(kind: SessionChannel['kind']): string {
  if (kind === 'workspace_pair' || kind === 'group') return '⇄'
  if (kind === 'direct') return '↔'
  if (kind === 'project_bridge') return '↗'
  return '⇄'
}

function isKeyInboxMessage(message: SessionMessage): boolean {
  if (message.status === 'acknowledged' || message.acknowledgedAt) return false
  if (message.type === 'handoff' || message.type === 'blocked' || message.type === 'request_review' || message.type === 'request_validation') return true
  return message.type === 'finding' && message.priority === 'high'
}

function shortSessionId(sessionId: string): string {
  const normalized = sessionId.trim()
  if (!normalized) return sessionId
  const stripped = normalized.replace(/^session[-_]/, '')
  if (stripped.length <= 18) return stripped
  return `${stripped.slice(0, 8)}…${stripped.slice(-6)}`
}

function stringFromMetadata(metadata: SessionSnapshot['metadata'], key: string): string | undefined {
  const value = metadata?.[key]
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function parseSessionsList(input: unknown): SessionSnapshot[] {
  const value = input as Partial<SessionsListResponse>
  return Array.isArray(value.sessions) ? value.sessions : []
}

function formatSessionInboxMessage(message: SessionMessage): string {
  const status = message.status === 'acknowledged'
    ? chalk.green(message.status)
    : chalk.yellow(message.status)
  const target = message.toSessionId ? `to=${message.toSessionId}` : 'broadcast=true'
  const lines = [
    '',
    `${chalk.bold(message.messageId)} ${chalk.dim(`[${message.createdAt}]`)} ${status}`,
    `  ${chalk.cyan(message.type)} · ${message.priority} · from=${message.fromSessionId} · ${target} · channel=${message.channelId}`,
    `  ${message.content}`,
  ]
  if (message.evidence?.length) {
    lines.push(`  evidence: ${message.evidence.map(formatEvidenceRef).join(', ')}`)
  }
  return lines.join('\n')
}

function formatEvidenceRef(ref: NonNullable<SessionMessage['evidence']>[number]): string {
  const label = ref.label ? ` (${ref.label})` : ''
  return `${ref.type}:${ref.ref}${label}`
}
