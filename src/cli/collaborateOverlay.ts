import chalk from 'chalk'
import { inputState } from './inputState.js'
import { normalizeKeyEvent, type NormalizedKeyEvent } from './keyEvent.js'
import { shortSessionId } from './inboxOverlay.js'
import { truncateToTerminalWidth, visibleTerminalWidth } from './terminalWidth.js'
import type { SessionChannel, SessionMessage, SessionMessagePriority, SessionMessageType } from '../shared/sessionChannel.js'

export type CollaborateEntryKind = 'inbox' | 'channels' | 'agents'
export type CollaborateOverlayScreen = 'home' | 'inbox' | 'channels' | 'channelDetail' | 'compose'
export type CollaborateComposeMode = 'channel_send' | 'inbox_reply'

export type CollaborateHomeEntry = {
  kind: CollaborateEntryKind
  label: string
  description: string
  detail?: string
}

export type CollaborateChannelTarget =
  | { kind: 'session'; sessionId: string }
  | { kind: 'broadcast' }

export type CollaborateOverlayState = {
  screen: CollaborateOverlayScreen
  sessionId: string
  sessionPhase?: string
  entries: CollaborateHomeEntry[]
  channels: SessionChannel[]
  messages: SessionMessage[]
  selectedIndex: number
  selectedChannelIndex: number
  selectedMessageIndex: number
  selectedTarget?: CollaborateChannelTarget
  selectedReplyMessage?: SessionMessage
  composeMode: CollaborateComposeMode
  composeText: string
  composeType: SessionMessageType
  composePriority: SessionMessagePriority
  notice?: string
}

export type CollaborateOverlayAction =
  | { type: 'none' }
  | { type: 'redraw' }
  | { type: 'close' }
  | { type: 'open'; entry: CollaborateHomeEntry }
  | {
      type: 'preview_channel_message'
      command: CollaborateComposeMode
      channel: SessionChannel
      target: CollaborateChannelTarget
      content: string
      messageType: SessionMessageType
      priority: SessionMessagePriority
      replyToMessageId?: string
    }

export type CollaborateOverlayResult =
  | { type: 'closed' }
  | { type: 'open'; entry: CollaborateHomeEntry }
  | {
      type: 'channel_message_preview'
      command: CollaborateComposeMode
      channel: SessionChannel
      target: CollaborateChannelTarget
      content: string
      messageType: SessionMessageType
      priority: SessionMessagePriority
      replyToMessageId?: string
    }

export function createCollaborateHomeState(input: {
  sessionId: string
  sessionPhase?: string
  inboxUnreadCount?: number
  messages?: SessionMessage[]
  channelCount?: number
  channels?: SessionChannel[]
  agentCount?: number
  selectedIndex?: number
  selectedChannelIndex?: number
  selectedMessageIndex?: number
  notice?: string
}): CollaborateOverlayState {
  const channels = input.channels ?? []
  const messages = input.messages ?? []
  const channelCount = input.channelCount ?? channels.length
  const inboxUnreadCount = input.inboxUnreadCount ?? messages.length
  const entries: CollaborateHomeEntry[] = [
    {
      kind: 'inbox',
      label: 'Inbox',
      description: 'Unread side-channel messages for current session',
      detail: `${inboxUnreadCount} unread`,
    },
    {
      kind: 'channels',
      label: 'Channels',
      description: 'Channels current session participates in',
      detail: `${channelCount} active`,
    },
    {
      kind: 'agents',
      label: 'Agents',
      description: 'Child / related agent jobs for current session',
      detail: `${input.agentCount ?? 0} jobs`,
    },
  ]
  return {
    screen: 'home',
    sessionId: input.sessionId,
    sessionPhase: input.sessionPhase,
    entries,
    channels,
    messages,
    selectedIndex: clampIndex(input.selectedIndex ?? 0, entries.length),
    selectedChannelIndex: clampIndex(input.selectedChannelIndex ?? 0, channels.length),
    selectedMessageIndex: clampIndex(input.selectedMessageIndex ?? 0, messages.length),
    composeMode: 'channel_send',
    composeText: '',
    composeType: 'question',
    composePriority: 'normal',
    notice: input.notice,
  }
}

export function renderCollaborateOverlay(
  state: CollaborateOverlayState,
  options: { rows?: number; columns?: number } = {},
): string {
  const rows = Math.max(12, options.rows ?? process.stdout.rows ?? 24)
  const columns = Math.max(40, (options.columns ?? process.stdout.columns ?? 80) - 1)
  const output = renderCollaborateHeader(state, columns)
  if (state.notice) output.push(chalk.dim(fitLine(state.notice, columns)))
  output.push('')
  output.push(...renderCollaborateScreen(state, columns))
  while (output.length < rows - 1) output.push('')
  output.push(chalk.inverse(fitLine(collaborateFooter(state), columns)))
  return output.slice(0, rows).join('\n')
}

export function reduceCollaborateOverlayKey(
  state: CollaborateOverlayState,
  key: NormalizedKeyEvent,
): { state: CollaborateOverlayState; action: CollaborateOverlayAction } {
  if (key.kind === 'ctrl_c' || key.kind === 'escape') {
    return { state, action: { type: 'close' } }
  }
  if (state.screen === 'compose') {
    return reduceCollaborateComposeKey(state, key)
  }
  if (key.kind === 'backspace') {
    return reduceCollaborateBackKey(state)
  }
  const raw = key.raw.toLowerCase()
  if (key.kind === 'down' || raw === 'j') {
    return { state: moveSelection(state, 1), action: { type: 'redraw' } }
  }
  if (key.kind === 'up' || raw === 'k') {
    return { state: moveSelection(state, -1), action: { type: 'redraw' } }
  }
  if (key.kind === 'enter') {
    return reduceCollaborateEnterKey(state)
  }
  return { state, action: { type: 'none' } }
}

export async function openCollaborateOverlay(input: {
  sessionId: string
  sessionPhase?: string
  inboxUnreadCount?: number
  messages?: SessionMessage[]
  channelCount?: number
  channels?: SessionChannel[]
  agentCount?: number
  notice?: string
}): Promise<CollaborateOverlayResult> {
  const wasRaw = process.stdin.isTTY ? process.stdin.isRaw : false
  const dataListeners = process.stdin.listeners('data')
  const keypressListeners = process.stdin.listeners('keypress')
  process.stdin.removeAllListeners('data')
  process.stdin.removeAllListeners('keypress')
  if (process.stdin.isTTY) process.stdin.setRawMode(true)
  inputState.set('inboxOverlay')
  process.stdout.write('\x1b[?1049h\x1b[2J\x1b[H\x1b[?25l')

  return new Promise(resolve => {
    let state = createCollaborateHomeState(input)
    let settled = false

    const redraw = () => {
      process.stdout.write('\x1b[H\x1b[2J')
      process.stdout.write(renderCollaborateOverlay(state))
    }

    const cleanup = () => {
      process.stdin.removeListener('data', onData)
      for (const listener of dataListeners) process.stdin.on('data', listener as any)
      for (const listener of keypressListeners) process.stdin.on('keypress', listener as any)
      if (inputState.current === 'inboxOverlay') inputState.set('idle')
      if (process.stdin.isTTY) process.stdin.setRawMode(wasRaw)
      process.stdout.write('\x1b[?25h\x1b[?1049l')
    }

    const finish = (result: CollaborateOverlayResult) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(result)
    }

    const onData = (chunk: Buffer | string) => {
      if (settled) return
      const reduced = reduceCollaborateOverlayKey(state, normalizeKeyEvent(chunk, undefined))
      state = reduced.state
      if (reduced.action.type === 'close') {
        finish({ type: 'closed' })
        return
      }
      if (reduced.action.type === 'open') {
        finish({ type: 'open', entry: reduced.action.entry })
        return
      }
      if (reduced.action.type === 'preview_channel_message') {
        finish({
          type: 'channel_message_preview',
          command: reduced.action.command,
          channel: reduced.action.channel,
          target: reduced.action.target,
          content: reduced.action.content,
          messageType: reduced.action.messageType,
          priority: reduced.action.priority,
          replyToMessageId: reduced.action.replyToMessageId,
        })
        return
      }
      if (reduced.action.type === 'redraw') redraw()
    }

    process.stdin.on('data', onData)
    redraw()
  })
}

function renderCollaborateHeader(state: CollaborateOverlayState, columns: number): string[] {
  const output = [
    chalk.inverse(fitLine(' BABEL Collaborate ', columns)),
    fitLine(`from: ${formatCurrentSession(state)}`, columns),
  ]
  if (state.screen === 'home') {
    output.push(chalk.dim(fitLine('Current session is fixed. Selected sessions/channels/agents are targets or context only.', columns)))
    return output
  }
  if (state.screen === 'channels' || state.screen === 'inbox') {
    output.push(fitLine('via: none', columns))
    output.push(fitLine('to: none', columns))
    const hint = state.screen === 'inbox'
      ? 'Choose an inbox message to reply. Replies default to original sender, not broadcast.'
      : 'Choose a channel first. No message is sent and no session state is changed.'
    output.push(chalk.dim(fitLine(hint, columns)))
    return output
  }
  output.push(fitLine(`via: ${formatSelectedChannelRoute(state)}`, columns))
  output.push(fitLine(`to: ${formatSelectedTargetRoute(state)}`, columns))
  output.push(chalk.dim(fitLine('Selection prepares routing context only; Compose/Preview remains a separate confirmation step.', columns)))
  return output
}

function renderCollaborateScreen(state: CollaborateOverlayState, columns: number): string[] {
  if (state.screen === 'inbox') return renderCollaborateInbox(state, columns)
  if (state.screen === 'channels') return renderCollaborateChannels(state, columns)
  if (state.screen === 'channelDetail') return renderCollaborateChannelDetail(state, columns)
  if (state.screen === 'compose') return renderCollaborateCompose(state, columns)
  return renderCollaborateEntries(state, columns)
}

function renderCollaborateEntries(state: CollaborateOverlayState, columns: number): string[] {
  return state.entries.map((entry, index) => {
    const selected = index === state.selectedIndex
    const marker = selected ? '›' : ' '
    const label = selected ? chalk.blue(entry.label) : chalk.white(entry.label)
    const detail = entry.detail ? chalk.dim(entry.detail) : ''
    const left = `${marker} ${label.padEnd(10)} ${entry.description}`
    return fitColumns(left, detail, columns)
  })
}

function renderCollaborateInbox(state: CollaborateOverlayState, columns: number): string[] {
  const rows = [chalk.cyan(fitLine('Inbox', columns))]
  if (state.messages.length === 0) {
    rows.push(chalk.dim(fitLine('No unread inbox messages for the current session.', columns)))
    return rows
  }
  for (const [index, message] of state.messages.entries()) {
    const selected = index === state.selectedIndex
    const marker = selected ? '›' : ' '
    const left = `${marker} ${shortSessionId(message.fromSessionId)} → ${message.toSessionId ? shortSessionId(message.toSessionId) : 'broadcast'} · ${message.type}`
    const detail = chalk.dim(`${message.priority} · ${message.status} · ${formatChannelId(message.channelId)}`)
    rows.push(fitColumns(selected ? chalk.blue(left) : left, detail, columns))
  }
  return rows
}

function renderCollaborateChannels(state: CollaborateOverlayState, columns: number): string[] {
  const rows = [chalk.cyan(fitLine('Channels', columns))]
  if (state.channels.length === 0) {
    rows.push(chalk.dim(fitLine('No active SessionChannel links for the current session.', columns)))
    return rows
  }
  for (const [index, channel] of state.channels.entries()) {
    const selected = index === state.selectedIndex
    const marker = selected ? '›' : ' '
    const left = `${marker} ${channelMarker(channel)} ${formatChannelId(channel.channelId)} · ${channel.kind}`
    const detail = chalk.dim(`${channel.participantSessionIds.length} members · ${channel.status}`)
    rows.push(fitColumns(selected ? chalk.blue(left) : left, detail, columns))
  }
  return rows
}

function renderCollaborateChannelDetail(state: CollaborateOverlayState, columns: number): string[] {
  const channel = currentChannel(state)
  const rows = [chalk.cyan(fitLine('Channel detail', columns))]
  if (!channel) {
    rows.push(chalk.dim(fitLine('Selected channel is no longer available.', columns)))
    return rows
  }
  rows.push(fitLine(`${channel.kind} · ${channel.status} · ${channel.participantSessionIds.length} participant(s)`, columns))
  rows.push(fitLine(`members: ${channel.participantSessionIds.map(shortSessionId).join(', ')}`, columns))
  rows.push('')
  rows.push(chalk.cyan(fitLine('Targets', columns)))
  const targets = channelTargetOptions(state.sessionId, channel)
  if (targets.length === 0) {
    rows.push(chalk.dim(fitLine('No selectable target; this channel has no other member and broadcast is disabled.', columns)))
    return rows
  }
  for (const [index, target] of targets.entries()) {
    const selected = index === state.selectedIndex
    const marker = selected ? '›' : ' '
    const left = `${marker} ${formatTargetLabel(target)}`
    const detail = chalk.dim(formatTargetDetail(target))
    rows.push(fitColumns(selected ? chalk.blue(left) : left, detail, columns))
  }
  return rows
}

function renderCollaborateCompose(state: CollaborateOverlayState, columns: number): string[] {
  const title = state.composeMode === 'inbox_reply' ? 'Reply message' : 'Compose message'
  const rows = [
    chalk.cyan(fitLine(title, columns)),
    fitLine(`type: ${state.composeType} · priority: ${state.composePriority}${state.selectedReplyMessage ? ` · replyTo=${shortSessionId(state.selectedReplyMessage.messageId)}` : ''}`, columns),
    chalk.dim(fitLine('Enter creates a review-only preview; confirm still happens outside the overlay.', columns)),
    '',
    chalk.cyan(fitLine('Message', columns)),
  ]
  const content = state.composeText.length > 0 ? state.composeText : '(empty)'
  rows.push(...wrapPlainLines(content, columns).map(row => state.composeText.length > 0 ? row : chalk.dim(row)))
  return rows
}

function reduceCollaborateBackKey(state: CollaborateOverlayState): { state: CollaborateOverlayState; action: CollaborateOverlayAction } {
  if (state.screen === 'compose') {
    if (state.composeMode === 'inbox_reply') {
      return {
        state: {
          ...state,
          screen: 'inbox',
          selectedIndex: clampIndex(state.selectedMessageIndex, state.messages.length),
          selectedTarget: undefined,
          selectedReplyMessage: undefined,
          composeMode: 'channel_send',
          composeText: '',
          composeType: 'question',
          composePriority: 'normal',
        },
        action: { type: 'redraw' },
      }
    }
    return {
      state: {
        ...state,
        screen: 'channelDetail',
        selectedTarget: undefined,
        composeText: '',
      },
      action: { type: 'redraw' },
    }
  }
  if (state.screen === 'inbox') {
    return {
      state: {
        ...state,
        screen: 'home',
        selectedIndex: homeIndexForKind(state, 'inbox'),
      },
      action: { type: 'redraw' },
    }
  }
  if (state.screen === 'channelDetail') {
    return {
      state: {
        ...state,
        screen: 'channels',
        selectedIndex: clampIndex(state.selectedChannelIndex, state.channels.length),
        selectedTarget: undefined,
      },
      action: { type: 'redraw' },
    }
  }
  if (state.screen === 'channels') {
    return {
      state: {
        ...state,
        screen: 'home',
        selectedIndex: homeIndexForKind(state, 'channels'),
      },
      action: { type: 'redraw' },
    }
  }
  return { state, action: { type: 'close' } }
}

function reduceCollaborateEnterKey(state: CollaborateOverlayState): { state: CollaborateOverlayState; action: CollaborateOverlayAction } {
  if (state.screen === 'home') {
    const entry = state.entries[state.selectedIndex]
    if (!entry) return { state, action: { type: 'none' } }
    if (entry.kind === 'inbox') {
      return {
        state: {
          ...state,
          screen: 'inbox',
          selectedIndex: clampIndex(state.selectedMessageIndex, state.messages.length),
        },
        action: { type: 'redraw' },
      }
    }
    if (entry.kind === 'channels') {
      return {
        state: {
          ...state,
          screen: 'channels',
          selectedIndex: clampIndex(state.selectedChannelIndex, state.channels.length),
        },
        action: { type: 'redraw' },
      }
    }
    return { state, action: { type: 'open', entry } }
  }
  if (state.screen === 'inbox') return reduceCollaborateInboxEnterKey(state)
  if (state.screen === 'channels') return reduceCollaborateChannelsEnterKey(state)
  return reduceCollaborateChannelDetailEnterKey(state)
}

function reduceCollaborateInboxEnterKey(state: CollaborateOverlayState): { state: CollaborateOverlayState; action: CollaborateOverlayAction } {
  if (state.messages.length === 0) return { state, action: { type: 'none' } }
  const selectedMessageIndex = clampIndex(state.selectedIndex, state.messages.length)
  const message = state.messages[selectedMessageIndex]
  if (!message) return { state, action: { type: 'none' } }
  const channelIndex = state.channels.findIndex(channel => channel.channelId === message.channelId)
  if (channelIndex < 0) {
    return {
      state: { ...state, notice: `Reply channel not available: ${message.channelId}` },
      action: { type: 'redraw' },
    }
  }
  return {
    state: {
      ...state,
      screen: 'compose',
      selectedMessageIndex,
      selectedChannelIndex: channelIndex,
      selectedTarget: { kind: 'session', sessionId: message.fromSessionId },
      selectedReplyMessage: message,
      composeMode: 'inbox_reply',
      composeText: '',
      composeType: 'answer',
      composePriority: 'normal',
      notice: undefined,
    },
    action: { type: 'redraw' },
  }
}

function reduceCollaborateChannelsEnterKey(state: CollaborateOverlayState): { state: CollaborateOverlayState; action: CollaborateOverlayAction } {
  if (state.channels.length === 0) return { state, action: { type: 'none' } }
  const selectedChannelIndex = clampIndex(state.selectedIndex, state.channels.length)
  return {
    state: {
      ...state,
      screen: 'channelDetail',
      selectedChannelIndex,
      selectedIndex: 0,
      selectedTarget: undefined,
      selectedReplyMessage: undefined,
      composeMode: 'channel_send',
      composeType: 'question',
      composePriority: 'normal',
    },
    action: { type: 'redraw' },
  }
}

function reduceCollaborateChannelDetailEnterKey(state: CollaborateOverlayState): { state: CollaborateOverlayState; action: CollaborateOverlayAction } {
  const channel = currentChannel(state)
  if (!channel) return { state, action: { type: 'none' } }
  const target = channelTargetOptions(state.sessionId, channel)[state.selectedIndex]
  return target
    ? {
        state: {
          ...state,
          screen: 'compose',
          selectedTarget: target,
          selectedReplyMessage: undefined,
          composeMode: 'channel_send',
          composeText: '',
          composeType: 'question',
          composePriority: 'normal',
        },
        action: { type: 'redraw' },
      }
    : { state, action: { type: 'none' } }
}

function reduceCollaborateComposeKey(state: CollaborateOverlayState, key: NormalizedKeyEvent): { state: CollaborateOverlayState; action: CollaborateOverlayAction } {
  if (key.kind === 'backspace') {
    if (state.composeText.length === 0) return reduceCollaborateBackKey(state)
    return {
      state: { ...state, composeText: state.composeText.slice(0, -1) },
      action: { type: 'redraw' },
    }
  }
  if (key.kind === 'shift_enter') {
    return {
      state: { ...state, composeText: `${state.composeText}\n` },
      action: { type: 'redraw' },
    }
  }
  if (key.kind === 'enter') {
    const channel = currentChannel(state)
    const target = state.selectedTarget
    const content = state.composeText.trim()
    if (!channel || !target || !content) {
      return {
        state: { ...state, notice: 'Message content is required before preview.' },
        action: { type: 'redraw' },
      }
    }
    return {
      state,
      action: {
        type: 'preview_channel_message',
        command: state.composeMode,
        channel,
        target,
        content,
        messageType: state.composeType,
        priority: state.composePriority,
        replyToMessageId: state.selectedReplyMessage?.messageId,
      },
    }
  }
  if (key.kind === 'text') {
    const text = sanitizeComposeText(key.raw)
    if (!text) return { state, action: { type: 'none' } }
    return {
      state: { ...state, composeText: `${state.composeText}${text}`, notice: undefined },
      action: { type: 'redraw' },
    }
  }
  return { state, action: { type: 'none' } }
}

function moveSelection(state: CollaborateOverlayState, delta: number): CollaborateOverlayState {
  const length = selectionLength(state)
  const selectedIndex = clampIndex(state.selectedIndex + delta, length)
  if (state.screen === 'channels') {
    return { ...state, selectedIndex, selectedChannelIndex: selectedIndex }
  }
  if (state.screen === 'inbox') {
    return { ...state, selectedIndex, selectedMessageIndex: selectedIndex }
  }
  return { ...state, selectedIndex }
}

function selectionLength(state: CollaborateOverlayState): number {
  if (state.screen === 'inbox') return state.messages.length
  if (state.screen === 'channels') return state.channels.length
  if (state.screen === 'channelDetail') {
    const channel = currentChannel(state)
    return channel ? channelTargetOptions(state.sessionId, channel).length : 0
  }
  return state.entries.length
}

function currentChannel(state: CollaborateOverlayState): SessionChannel | undefined {
  return state.channels[clampIndex(state.selectedChannelIndex, state.channels.length)]
}

function channelTargetOptions(sessionId: string, channel: SessionChannel): CollaborateChannelTarget[] {
  const sessionTargets = channel.participantSessionIds
    .filter(participantSessionId => participantSessionId !== sessionId)
    .map(participantSessionId => ({ kind: 'session' as const, sessionId: participantSessionId }))
  return channel.policy.allowBroadcast
    ? [...sessionTargets, { kind: 'broadcast' as const }]
    : sessionTargets
}

function formatCurrentSession(state: CollaborateOverlayState): string {
  const phase = state.sessionPhase ? `:${state.sessionPhase}` : ''
  return `${shortSessionId(state.sessionId)}${phase}`
}

function formatSelectedChannelRoute(state: CollaborateOverlayState): string {
  const channel = currentChannel(state)
  return channel ? `${formatChannelId(channel.channelId)} · ${channel.kind} · ${channel.status}` : 'none'
}

function formatSelectedTargetRoute(state: CollaborateOverlayState): string {
  const channel = currentChannel(state)
  if (!channel) return 'none'
  const target = state.screen === 'compose' && state.selectedTarget
    ? state.selectedTarget
    : channelTargetOptions(state.sessionId, channel)[state.selectedIndex]
  if (!target) return 'none'
  return target.kind === 'broadcast' ? 'broadcast' : shortSessionId(target.sessionId)
}

function formatTargetLabel(target: CollaborateChannelTarget): string {
  return target.kind === 'broadcast' ? 'broadcast' : shortSessionId(target.sessionId)
}

function formatTargetDetail(target: CollaborateChannelTarget): string {
  return target.kind === 'broadcast'
    ? 'send to channel broadcast'
    : `to=${target.sessionId}`
}

function formatChannelId(channelId: string): string {
  const stripped = channelId.trim().replace(/^channel[-_]/, '')
  if (stripped.length <= 22) return stripped
  return `${stripped.slice(0, 9)}…${stripped.slice(-7)}`
}

function channelMarker(channel: SessionChannel): string {
  if (channel.kind === 'parent_child') return '→'
  if (channel.kind === 'direct') return '↔'
  if (channel.kind === 'project_bridge') return '↗'
  return '⇄'
}

function collaborateFooter(state: CollaborateOverlayState): string {
  if (state.screen === 'inbox') return ' ↑/↓ move · enter reply · backspace home · esc close '
  if (state.screen === 'channels') return ' ↑/↓ move · enter detail · backspace home · esc close '
  if (state.screen === 'channelDetail') return ' ↑/↓ target · enter compose · backspace channels · esc close '
  if (state.screen === 'compose') return ' type message · shift+enter newline · enter preview · backspace edit/back · esc close '
  return ' ↑/↓ move · enter open · esc close '
}

function homeIndexForKind(state: CollaborateOverlayState, kind: CollaborateEntryKind): number {
  return Math.max(0, state.entries.findIndex(entry => entry.kind === kind))
}

function sanitizeComposeText(text: string): string {
  return text.replace(/[\x00-\x08\x0B-\x1F\x7F]/g, '')
}

function wrapPlainLines(text: string, columns: number): string[] {
  const rows: string[] = []
  for (const line of text.split(/\r?\n/)) {
    let remaining = line
    if (!remaining) {
      rows.push(fitLine('', columns))
      continue
    }
    while (visibleTerminalWidth(remaining) > columns) {
      const chunk = truncateToTerminalWidth(remaining, columns)
      rows.push(fitLine(chunk, columns))
      remaining = remaining.slice(chunk.length)
    }
    rows.push(fitLine(remaining, columns))
  }
  return rows
}

function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0
  return Math.max(0, Math.min(length - 1, index))
}

function fitColumns(left: string, detail: string, columns: number): string {
  const padding = ' '.repeat(Math.max(2, columns - visibleTerminalWidth(left) - visibleTerminalWidth(detail)))
  return fitLine(`${left}${padding}${detail}`, columns)
}

function fitLine(text: string, columns: number): string {
  const truncated = truncateToTerminalWidth(text, columns)
  return `${truncated}${' '.repeat(Math.max(0, columns - visibleTerminalWidth(truncated)))}`
}
