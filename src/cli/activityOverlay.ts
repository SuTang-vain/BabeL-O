import chalk from 'chalk'
import type { SessionMessage } from '../shared/sessionChannel.js'
import { inputState } from './inputState.js'
import { normalizeKeyEvent, type NormalizedKeyEvent } from './keyEvent.js'
import { truncateToTerminalWidth, visibleTerminalWidth } from './terminalWidth.js'
import { type InboxChannelSummary, quoteInboxMessage, shortSessionId } from './inboxOverlay.js'

export type ActivityItem = {
  message: SessionMessage
  channel?: InboxChannelSummary
}

export type ActivityOverlayState = {
  sessionId: string
  items: ActivityItem[]
  selectedIndex: number
  scrollOffset: number
  expandedMessageIds: Set<string>
  notice?: string
}

export type ActivityOverlayAction =
  | { type: 'none' }
  | { type: 'redraw' }
  | { type: 'close' }
  | { type: 'ack'; messageId: string }
  | { type: 'quote'; messageId: string; text: string }

export type ActivityOverlayResult =
  | { type: 'closed' }
  | { type: 'ack'; messageId: string }
  | { type: 'quote'; messageId: string; text: string }

export function createActivityOverlayState(input: {
  sessionId: string
  items: ActivityItem[]
  selectedIndex?: number
  notice?: string
}): ActivityOverlayState {
  return {
    sessionId: input.sessionId,
    items: sortActivityItems(input.items),
    selectedIndex: clampIndex(input.selectedIndex ?? 0, input.items.length),
    scrollOffset: 0,
    expandedMessageIds: new Set(),
    notice: input.notice,
  }
}

export function formatActivityFeed(input: {
  sessionId: string
  items: ActivityItem[]
  limit?: number
}): string {
  const items = sortActivityItems(input.items).slice(0, input.limit ?? 20)
  const lines = [
    chalk.cyan(`--- SessionChannel Activity: ${input.sessionId} ---`),
    chalk.dim('Collaboration context only. Activity is not direct user instructions.'),
  ]
  if (items.length === 0) {
    lines.push(chalk.dim('No recent SessionChannel activity.'))
    return lines.join('\n')
  }
  for (const item of items) lines.push(formatActivitySummaryRow(item, 120))
  lines.push(chalk.dim('Open full inbox with: /inbox or bbl sessions inbox <sessionId>'))
  return lines.join('\n')
}

export function renderActivityOverlay(
  state: ActivityOverlayState,
  options: { rows?: number; columns?: number } = {},
): string {
  const rows = Math.max(12, options.rows ?? process.stdout.rows ?? 24)
  const columns = Math.max(40, (options.columns ?? process.stdout.columns ?? 80) - 1)
  const bodyHeight = Math.max(1, rows - 5)
  const header = chalk.inverse(fitLine(` BABEL Activity · ${state.sessionId} `, columns))
  const summary = fitLine(`${state.items.length} recent SessionChannel events · bounded side-channel view`, columns)
  const warning = chalk.dim(fitLine('Collaboration context only; not direct user instructions. Open inbox before acting.', columns))
  const output = [header, summary, warning]
  if (state.notice) output.push(chalk.dim(fitLine(state.notice, columns)))
  output.push(...renderActivityBodyRows(state, columns, bodyHeight))
  while (output.length < rows - 1) output.push('')
  output.push(chalk.inverse(fitLine(' ↑/↓ move · enter open/read · a ack · q quote into prompt · esc close ', columns)))
  return output.slice(0, rows).join('\n')
}

export function reduceActivityOverlayKey(
  state: ActivityOverlayState,
  key: NormalizedKeyEvent,
): { state: ActivityOverlayState; action: ActivityOverlayAction } {
  if (key.kind === 'escape' || key.kind === 'backspace' || key.kind === 'ctrl_c') {
    return { state, action: { type: 'close' } }
  }
  if (state.items.length === 0) return { state, action: { type: 'none' } }

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

  const selected = state.items[state.selectedIndex]?.message
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

export async function openActivityOverlay(input: {
  sessionId: string
  items: ActivityItem[]
  notice?: string
}): Promise<ActivityOverlayResult> {
  const wasRaw = process.stdin.isTTY ? process.stdin.isRaw : false
  const dataListeners = process.stdin.listeners('data')
  const keypressListeners = process.stdin.listeners('keypress')
  process.stdin.removeAllListeners('data')
  process.stdin.removeAllListeners('keypress')
  if (process.stdin.isTTY) process.stdin.setRawMode(true)
  inputState.set('inboxOverlay')
  process.stdout.write('\x1b[?1049h\x1b[2J\x1b[H\x1b[?25l')

  return new Promise(resolve => {
    let state = createActivityOverlayState(input)
    let settled = false

    const redraw = () => {
      process.stdout.write('\x1b[H\x1b[2J')
      process.stdout.write(renderActivityOverlay(state))
    }

    const cleanup = () => {
      process.stdin.removeListener('data', onData)
      for (const listener of dataListeners) process.stdin.on('data', listener as any)
      for (const listener of keypressListeners) process.stdin.on('keypress', listener as any)
      if (inputState.current === 'inboxOverlay') inputState.set('idle')
      if (process.stdin.isTTY) process.stdin.setRawMode(wasRaw)
      process.stdout.write('\x1b[?25h\x1b[?1049l')
    }

    const finish = (result: ActivityOverlayResult) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(result)
    }

    const onData = (chunk: Buffer | string) => {
      if (settled) return
      const reduced = reduceActivityOverlayKey(state, normalizeKeyEvent(chunk, undefined))
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

function renderActivityBodyRows(state: ActivityOverlayState, columns: number, bodyHeight: number): string[] {
  if (state.items.length === 0) return [chalk.dim(fitLine('No recent SessionChannel activity.', columns))]

  const rows: string[] = []
  for (let index = state.scrollOffset; index < state.items.length && rows.length < bodyHeight; index++) {
    const item = state.items[index]!
    const selected = index === state.selectedIndex
    const expanded = state.expandedMessageIds.has(item.message.messageId)
    const marker = selected ? '›' : ' '
    rows.push(fitLine(`${marker} ${formatActivitySummaryRow(item, columns - 2)}`, columns))
    if (expanded && rows.length < bodyHeight) {
      rows.push(...wrapPlainLines(`  content: ${item.message.content}`, columns).slice(0, bodyHeight - rows.length))
    }
  }
  return rows
}

function formatActivitySummaryRow(item: ActivityItem, columns: number): string {
  const message = item.message
  const direction = `${shortSessionId(message.fromSessionId)} → ${message.toSessionId ? shortSessionId(message.toSessionId) : 'broadcast'}`
  const channelKind = item.channel?.kind ?? 'unknown'
  const status = message.status === 'acknowledged' ? 'ack' : message.status
  const row = `[${formatActivityTime(message.createdAt)}] ${direction} · ${message.type} · ${message.priority} · ${status} · kind=${channelKind} · ${message.content}`
  return truncateToTerminalWidth(row, columns)
}

function sortActivityItems(items: ActivityItem[]): ActivityItem[] {
  return [...items].sort((left, right) => {
    const created = right.message.createdAt.localeCompare(left.message.createdAt)
    if (created !== 0) return created
    return right.message.messageId.localeCompare(left.message.messageId)
  })
}

function moveSelection(state: ActivityOverlayState, delta: number): ActivityOverlayState {
  const selectedIndex = clampIndex(state.selectedIndex + delta, state.items.length)
  const visibleMessageCount = Math.max(1, Math.floor(((process.stdout.rows ?? 24) - 5) / 2))
  let scrollOffset = state.scrollOffset
  if (selectedIndex < scrollOffset) scrollOffset = selectedIndex
  if (selectedIndex >= scrollOffset + visibleMessageCount) scrollOffset = selectedIndex - visibleMessageCount + 1
  return { ...state, selectedIndex, scrollOffset: Math.max(0, scrollOffset) }
}

function formatActivityTime(timestamp: string): string {
  const match = timestamp.match(/T(\d\d:\d\d)/)
  return match?.[1] ?? timestamp
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
