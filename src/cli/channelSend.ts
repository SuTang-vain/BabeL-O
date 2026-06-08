import chalk from 'chalk'
import type { SessionChannel, SessionMessage, SessionMessagePriority, SessionMessageType } from '../shared/sessionChannel.js'
import { shortSessionId } from './inboxOverlay.js'
import { truncateToTerminalWidth, visibleTerminalWidth } from './terminalWidth.js'

const allowedTypes: SessionMessageType[] = [
  'question',
  'answer',
  'finding',
  'request_review',
  'request_validation',
  'hypothesis',
  'decision',
  'blocked',
  'memory_candidate',
  'handoff',
]

const allowedPriorities: SessionMessagePriority[] = ['low', 'normal', 'high']

export type ChannelSendDraft = {
  command: 'channel_send' | 'inbox_reply'
  channelId: string
  fromSessionId: string
  toSessionId?: string
  broadcast?: boolean
  type: SessionMessageType
  priority: SessionMessagePriority
  content: string
  replyToMessageId?: string
}

export type ChannelSendParseResult =
  | { ok: true; draft: Omit<ChannelSendDraft, 'fromSessionId'> }
  | { ok: false; error: string; usage: string }

export function parseChannelSendCommand(input: string): ChannelSendParseResult {
  const trimmed = input.trim()
  if (trimmed.startsWith('/channel send ')) {
    return parseChannelSendArgs('channel_send', trimmed.slice('/channel send '.length).trim())
  }
  if (trimmed.startsWith('/inbox reply ')) {
    return parseChannelSendArgs('inbox_reply', trimmed.slice('/inbox reply '.length).trim())
  }
  return { ok: false, error: 'Unsupported SessionChannel send command.', usage: channelSendUsage() }
}

function parseChannelSendArgs(command: ChannelSendDraft['command'], args: string): ChannelSendParseResult {
  const separator = args.indexOf('--')
  if (separator < 0) {
    return { ok: false, error: 'Message content must follow --.', usage: channelSendUsage() }
  }
  const optionText = args.slice(0, separator).trim()
  const content = args.slice(separator + 2).trim()
  if (!content) {
    return { ok: false, error: 'Message content is required.', usage: channelSendUsage() }
  }

  const options = parseKeyValueOptions(optionText)
  const channelId = command === 'channel_send'
    ? options.get('channel') ?? options.get('channelId')
    : options.get('channel') ?? options.get('channelId')
  const replyToMessageId = command === 'inbox_reply'
    ? options.get('message') ?? options.get('messageId')
    : undefined
  const toSessionId = options.get('to') ?? options.get('toSessionId')
  const broadcast = options.get('broadcast') === 'true'
  const type = parseMessageType(options.get('type') ?? (command === 'inbox_reply' ? 'answer' : 'question'))
  const priority = parsePriority(options.get('priority') ?? 'normal')

  if (!channelId) {
    return { ok: false, error: 'channel=<channelId> is required.', usage: channelSendUsage() }
  }
  if (command === 'inbox_reply' && !replyToMessageId) {
    return { ok: false, error: 'message=<messageId> is required for /inbox reply.', usage: channelSendUsage() }
  }
  if (!type) {
    return { ok: false, error: `Unsupported message type. Allowed: ${allowedTypes.join(', ')}`, usage: channelSendUsage() }
  }
  if (!priority) {
    return { ok: false, error: `Unsupported priority. Allowed: ${allowedPriorities.join(', ')}`, usage: channelSendUsage() }
  }
  if (broadcast && toSessionId) {
    return { ok: false, error: 'Use either broadcast=true or to=<sessionId>, not both.', usage: channelSendUsage() }
  }

  return {
    ok: true,
    draft: {
      command,
      channelId,
      toSessionId,
      broadcast: broadcast || toSessionId === undefined,
      type,
      priority,
      content,
      replyToMessageId,
    },
  }
}

function parseKeyValueOptions(text: string): Map<string, string> {
  const options = new Map<string, string>()
  if (!text) return options
  for (const token of text.split(/\s+/)) {
    const index = token.indexOf('=')
    if (index <= 0) continue
    options.set(token.slice(0, index), token.slice(index + 1))
  }
  return options
}

function parseMessageType(value: string): SessionMessageType | undefined {
  return allowedTypes.includes(value as SessionMessageType) ? value as SessionMessageType : undefined
}

function parsePriority(value: string): SessionMessagePriority | undefined {
  return allowedPriorities.includes(value as SessionMessagePriority) ? value as SessionMessagePriority : undefined
}

export function createChannelSendDraft(input: Omit<ChannelSendDraft, 'fromSessionId'> & { fromSessionId: string }): ChannelSendDraft {
  return {
    command: input.command,
    channelId: input.channelId,
    fromSessionId: input.fromSessionId,
    toSessionId: input.toSessionId,
    broadcast: input.broadcast ?? input.toSessionId === undefined,
    type: input.type,
    priority: input.priority,
    content: input.content,
    replyToMessageId: input.replyToMessageId,
  }
}

export function resolveInboxReplyDraftTarget(draft: ChannelSendDraft, message: SessionMessage): ChannelSendDraft {
  if (draft.command !== 'inbox_reply' || draft.toSessionId) return draft
  return {
    ...draft,
    toSessionId: message.fromSessionId,
    broadcast: false,
  }
}

export function formatChannelSendPreview(
  draft: ChannelSendDraft,
  options: { channel?: SessionChannel; columns?: number } = {},
): string {
  const columns = Math.max(40, options.columns ?? process.stdout.columns ?? 100)
  const width = Math.max(36, columns - 1)
  const lines = [
    chalk.cyan(fitSendLine('--- SessionChannel Send Preview ---', width)),
    chalk.dim(fitSendLine('Review-only preview. Nothing has been sent yet; run /channel send confirm to deliver.', width)),
    fitSendLine(`channel: ${shortSessionId(draft.channelId)}${options.channel ? ` · kind=${options.channel.kind}` : ''}`, width),
    fitSendLine(`from: ${shortSessionId(draft.fromSessionId)} → ${draft.toSessionId ? shortSessionId(draft.toSessionId) : 'broadcast'}`, width),
    fitSendLine(`type: ${draft.type} · priority: ${draft.priority}${draft.replyToMessageId ? ` · replyTo=${shortSessionId(draft.replyToMessageId)}` : ''}`, width),
    fitSendLine(`content: ${draft.content}`, width),
    chalk.dim(fitSendLine('Boundary: typed side-channel message only; no transcript sharing, no tool execution, no session mutation.', width)),
  ]
  return lines.join('\n')
}

export function formatChannelSendCreated(message: SessionMessage, options: { columns?: number } = {}): string {
  const columns = Math.max(40, options.columns ?? process.stdout.columns ?? 100)
  const width = Math.max(36, columns - 1)
  return [
    chalk.cyan(fitSendLine('--- SessionChannel Message Sent ---', width)),
    fitSendLine(`${shortSessionId(message.fromSessionId)} → ${message.toSessionId ? shortSessionId(message.toSessionId) : 'broadcast'} · ${message.type} · ${message.priority} · ${message.status}`, width),
    chalk.dim(fitSendLine(`message: ${shortSessionId(message.messageId)} · channel: ${shortSessionId(message.channelId)}`, width)),
  ].join('\n')
}

export function channelSendUsage(): string {
  return [
    'Usage:',
    '  /channel send channel=<channelId> [to=<sessionId>|broadcast=true] [type=question] [priority=normal] -- <message>',
    '  /inbox reply channel=<channelId> message=<messageId> [type=answer] [priority=normal] -- <message>',
    '  /channel send confirm',
    '  /channel send cancel',
  ].join('\n')
}

function fitSendLine(text: string, columns: number): string {
  const truncated = truncateToTerminalWidth(text, columns)
  return `${truncated}${' '.repeat(Math.max(0, columns - visibleTerminalWidth(truncated)))}`
}
