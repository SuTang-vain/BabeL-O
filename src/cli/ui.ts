import readline from 'node:readline'
import chalk from 'chalk'
import { emitKeypressEvents } from 'node:readline'
import { PendingPermissionRegistry } from '../shared/session.js'
import { getChatPrompt } from './renderEvents.js'
import { inputState } from './inputState.js'
import { normalizeKeyEvent } from './keyEvent.js'
import { getPromptSuggestion, type SessionHintState } from './promptSuggestions.js'
import {
  createPermissionPanelState,
  reducePermissionPanelKey,
  selectedPermissionChoice,
} from './permissionPanel.js'
import { renderedLineCount, visibleTerminalWidth } from './terminalWidth.js'
import { renderBoxedInput, renderFixedInputBox } from './inputBox.js'

export type CliReadline = readline.Interface

export type PermissionChoice =
  | 'approve_once'
  | 'approve_session'
  | 'approve_rule'
  | 'reject'
  | 'reject_instruct'

export interface PermissionDecision {
  approved: boolean
  scope: 'once' | 'session'
  reason?: string
  rule?: string
}

export const defaultPermissionChoices: { id: PermissionChoice; label: string }[] = [
  { id: 'approve_once', label: 'Approve once' },
  { id: 'approve_session', label: 'Approve for this session' },
  { id: 'approve_rule', label: 'Approve with editable rule' },
  { id: 'reject', label: 'Reject' },
  { id: 'reject_instruct', label: 'Reject, tell the model what to do instead' },
]

export const sessionPermissionApprovals = new Map<string, Set<string>>()

export function isSessionPermissionCached(
  sessionId: string,
  event: { name?: string; input?: unknown },
): boolean {
  if (!event.name) return false
  const approvals = sessionPermissionApprovals.get(sessionId)
  if (!approvals) return false
  if (approvals.has(event.name)) return true

  for (const entry of approvals) {
    const parsed = parseSessionPermissionRule(entry)
    if (!parsed) continue
    if (parsed.toolName !== event.name) continue
    if (matchesPermissionRule(event.name, event.input, parsed.rule)) return true
  }
  return false
}

export function encodeSessionPermissionRule(toolName: string, rule: string): string {
  return `${encodeURIComponent(toolName)}:${rule}`
}

function parseSessionPermissionRule(entry: string): { toolName: string; rule: string } | undefined {
  const separatorIndex = entry.indexOf(':')
  if (separatorIndex === -1) return undefined
  const rawToolName = entry.slice(0, separatorIndex)
  const rule = entry.slice(separatorIndex + 1)
  const toolName = rawToolName.includes('%') ? decodeURIComponent(rawToolName) : rawToolName
  return { toolName, rule }
}

export function matchesPermissionRule(
  toolName: string,
  input: unknown,
  rule: string,
): boolean {
  if (!rule || rule === '*') return true
  if (toolName !== 'Bash') return rule === toolName

  const command = typeof input === 'object' && input !== null
    ? (input as Record<string, unknown>).command
    : undefined
  if (typeof command !== 'string') return false
  const normalizedCommand = command.trim().replace(/\s+/g, ' ')
  const normalizedRule = rule.trim().replace(/\s+/g, ' ')
  if (!normalizedCommand || !normalizedRule) return false
  if (!normalizedRule.endsWith(':*')) {
    return normalizedCommand === normalizedRule
  }

  const prefix = normalizedRule.slice(0, -2).trim()
  if (!prefix) return true
  return normalizedCommand === prefix || normalizedCommand.startsWith(`${prefix} `)
}

export function questionAsync(rl: CliReadline, query: string): Promise<string> {
  return new Promise(resolve => {
    rl.question(query, answer => resolve(answer))
  })
}

export async function askChatInput(rl: CliReadline): Promise<string> {
  return questionAsync(rl, getChatPrompt())
}

export function isPermissionApproved(answer: string): boolean {
  return ['y', 'yes'].includes(answer.trim().toLowerCase())
}

export function mapDropdownSelection(selected: string): string {
  const mappings: Record<string, string> = {
    '/read': 'read ',
    '/write': 'write ',
    '/edit': 'edit ',
    '/grep': 'grep ',
    '/glob': 'glob ',
    '/bash': 'bash ',
    '/task': 'task ',
    '/tool': '/tool ',
    '/tools': '/tool ',
    '/tool read': 'read ',
    '/tool write': 'write ',
    '/tool edit': 'edit ',
    '/tool grep': 'grep ',
    '/tool glob': 'glob ',
    '/tool bash': 'bash ',
    '/tool task': 'task ',
    '/model': '/model ',
    '/profile': '/profile ',
    '/history': '/history ',
    '/help': '/help',
    '/clear': '/clear',
    '/compact': '/compact',
    '/agentloop-smoke': '/agentloop-smoke',
    '/exit': '/exit',
    '/status': '/status',
    '/smoke': '/smoke ',
    '/fallback': '/fallback ',
    '/sessions': '/sessions',
    '/inbox': '/inbox',
    '/editor': '/editor',
    '/e': '/editor',
  }
  return mappings[selected] ?? mappings[selected.toLowerCase()] ?? selected
}

export function getAutosuggestion(line: string, history: string[]): string | undefined {
  if (!line) return undefined

  // 1. Check history (most recent first)
  const matchingHistory = history.find(h => h.startsWith(line) && h !== line)
  if (matchingHistory) return matchingHistory

  // 2. Check slash commands
  if (line.startsWith('/')) {
    const slashChoices = [
      '/help', '/clear', '/compact', '/context', '/agentloop-smoke', '/exit', '/model', '/profile', '/status', '/smoke', '/fallback', '/sessions', '/inbox', '/history', '/tool',
      '/read', '/write', '/edit', '/grep', '/glob', '/bash', '/task', '/pager', '/less', '/editor', '/e'
    ]
    const matchingSlash = slashChoices.find(c => c.startsWith(line) && c !== line)
    if (matchingSlash) return matchingSlash
  }

  return undefined
}

export type AutosuggestionRefreshControls = {
  clearCurrentInputBlock: (options?: { afterSubmit?: boolean }) => void
}

export function setupAutosuggestions(
  rl: any,
  history: string[],
  isExecutingRef: { current: boolean },
  sessionHintRef?: { current: SessionHintState },
  footerStatusRef?: { current?: string }
): AutosuggestionRefreshControls {
  const rlInt = rl as any
  const defaultPrompt = rlInt._prompt ?? getChatPrompt()
  let lastRenderedLines = 1
  let lastRenderedText = ''
  let lastCursorLineIndex = 0
  let lastCursorColumn = 0
  let lastCursorRowsFromBottom = 0

  const clearCurrentInputBlock = (options?: { afterSubmit?: boolean }) => {
    const columns = process.stdout.columns || 80
    const previousCursorRow = lastRenderedText
      ? renderedCursorRow(lastRenderedText, lastCursorLineIndex, lastCursorColumn, columns)
      : Math.max(0, lastRenderedLines - 1 - lastCursorRowsFromBottom)
    const rowsToBlockTop = previousCursorRow + (options?.afterSubmit ? 1 : 0)
    if (rowsToBlockTop > 0) {
      readline.moveCursor(process.stdout, 0, -rowsToBlockTop)
    }
    readline.cursorTo(process.stdout, 0)
    readline.clearScreenDown(process.stdout)
    lastRenderedLines = 1
    lastRenderedText = ''
    lastCursorLineIndex = 0
    lastCursorColumn = 0
    lastCursorRowsFromBottom = 0
  }

  rlInt._refreshLine = function() {
    const currentInput = String(this.line ?? '')
    const cursor = typeof this.cursor === 'number' ? this.cursor : currentInput.length
    const prompt = typeof this._prompt === 'string' ? this._prompt : defaultPrompt
    const isMainPrompt = prompt === defaultPrompt
    const columns = process.stdout.columns || 80
    const suggestion = isMainPrompt && !isExecutingRef.current && inputState.current === 'idle' && cursor === currentInput.length
      ? getAutosuggestion(currentInput, history)
      : undefined
    const placeholder = isMainPrompt && !isExecutingRef.current && inputState.current === 'idle' && !currentInput
      ? getPromptSuggestion(sessionHintRef?.current ?? { hasSession: false })
      : undefined
    const rendered = isMainPrompt
      ? renderBoxedInput({
        prompt,
        line: currentInput,
        cursor,
        suggestion,
        placeholder,
        columns,
        footerStatus: footerStatusRef?.current,
      })
      : renderFixedInputBox({
        prompt,
        line: currentInput,
        cursor,
        suggestion,
        placeholder,
        columns,
      })
    const renderedLines = Math.max(1, renderedLineCount(rendered.text, columns))

    const cursorRowsFromBottom = rendered.cursorRowsFromBottom ?? 0
    const previousCursorRow = lastRenderedText
      ? renderedCursorRow(lastRenderedText, lastCursorLineIndex, lastCursorColumn, columns)
      : Math.max(0, lastRenderedLines - 1 - lastCursorRowsFromBottom)
    const rowsToBlockTop = Math.max(0, previousCursorRow)
    if (rowsToBlockTop > 0) {
      readline.moveCursor(process.stdout, 0, -rowsToBlockTop)
    }
    readline.cursorTo(process.stdout, 0)
    readline.clearScreenDown(process.stdout)
    process.stdout.write(rendered.text)
    if (cursorRowsFromBottom > 0) {
      readline.moveCursor(process.stdout, 0, -cursorRowsFromBottom)
    }
    readline.cursorTo(process.stdout, rendered.cursorColumn)
    lastRenderedLines = renderedLines
    lastRenderedText = rendered.text
    lastCursorLineIndex = rendered.cursorRow
    lastCursorColumn = rendered.cursorColumn
    lastCursorRowsFromBottom = cursorRowsFromBottom
  }

  return { clearCurrentInputBlock }
}

export function renderSubmittedPrompt(prompt: string): string {
  return `${chalk.magenta('>')} ${chalk.magenta(prompt)}\n`
}

function renderedCursorRow(text: string, logicalCursorRow: number, cursorColumn: number, columns: number): number {
  const lines = text.split('\n')
  let row = 0
  const cursorLine = Math.max(0, Math.min(logicalCursorRow, lines.length - 1))
  for (let i = 0; i < cursorLine; i++) {
    row += Math.max(1, Math.ceil(visibleTerminalWidth(lines[i]!) / columns))
  }
  return row + Math.floor(Math.max(0, cursorColumn) / columns)
}



function formatSuggestedPermissionRule(event: PermissionDialogEvent): string | undefined {
  const tool = event.name || 'tool'
  if (tool === 'Bash' && typeof (event.input as Record<string, unknown>)?.command === 'string') {
    return extractCommandPrefix((event.input as Record<string, unknown>).command)
  }
  if (event.source?.type === 'mcp' && tool) return tool
  return undefined
}

function formatPermissionSource(event: PermissionDialogEvent): string | undefined {
  if (event.source?.type !== 'mcp') return undefined
  const server = event.source.serverName ?? 'unknown'
  const original = event.source.originalName ?? event.name ?? 'tool'
  return `${chalk.cyan(`mcp/${server}`)} · ${original}`
}

export function formatPermissionInput(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const record = input as Record<string, unknown>
  if (typeof record.command === 'string') return record.command
  if (typeof record.path === 'string') return record.path
  return JSON.stringify(input)
}

export function extractCommandPrefix(command: unknown): string {
  if (typeof command !== 'string') return '*'
  const trimmed = command.trim()
  const tokens = trimmed.split(/\s+/)
  if (tokens.length === 0) return '*'
  const first = tokens[0]!
  if (tokens.length === 1) return `${first}:*`
  // For npm/yarn/npx/uvx/uv, keep the subcommand
  if (['npm', 'yarn', 'npx', 'pnpm', 'uvx', 'uv'].includes(first) && tokens.length >= 2) {
    return `${first} ${tokens[1]}:*`
  }
  // For git, keep the subcommand
  if (first === 'git' && tokens.length >= 2) {
    return `git ${tokens[1]}:*`
  }
  return `${first}:*`
}

export function countRenderedLines(text: string): number {
  return renderedLineCount(text)
}

export function permissionDecisionFromChoice(
  choice: PermissionChoice,
  options?: { rule?: string; reason?: string },
): PermissionDecision | 'needs_rule_input' | 'needs_reject_instruction' {
  if (choice === 'approve_once') return { approved: true, scope: 'once' }
  if (choice === 'approve_session') return { approved: true, scope: 'session' }
  if (choice === 'approve_rule') {
    if (options?.rule) {
      return {
        approved: true,
        scope: 'session',
        reason: `Approved with rule: ${options.rule}`,
        rule: options.rule,
      }
    }
    return 'needs_rule_input'
  }
  if (choice === 'reject_instruct') {
    if (options?.reason !== undefined) {
      return {
        approved: false,
        scope: 'once',
        reason: options.reason.trim() || 'Denied by user',
      }
    }
    return 'needs_reject_instruction'
  }
  return { approved: false, scope: 'once', reason: 'Denied by user' }
}

type PermissionDialogEvent = {
  name?: string
  risk?: string
  input?: unknown
  source?: {
    type?: string
    serverName?: string
    originalName?: string
  }
}

export function formatPermissionDialog(
  event: PermissionDialogEvent,
  choices: { id: PermissionChoice; label: string }[],
  activeIndex: number,
): string {
  const tool = event.name || 'tool'
  const risk = event.risk ? `${event.risk} risk` : 'unknown risk'
  const command = formatPermissionInput(event.input)
  const suggestedRule = formatSuggestedPermissionRule(event)
  const source = formatPermissionSource(event)
  const lines = [
    `${chalk.yellow('◉')} ${chalk.dim('Waiting for permission...')}`,
    chalk.yellow(' approval '),
    `│ ${chalk.yellow(`${tool} is requesting approval (${risk})`)}`,
  ]
  if (source) {
    lines.push(`│ ${chalk.dim('Source:')} ${source}`)
  }
  if (command) {
    lines.push('│')
    lines.push(`│ ${command}`)
  }
  if (suggestedRule) {
    lines.push('│')
    lines.push(`│ ${chalk.dim('Suggested rule:')} ${chalk.cyan(suggestedRule)}`)
  }

  choices.forEach((choice, index) => {
    const selected = index === activeIndex
    const marker = selected ? chalk.cyan('~') : ' '
    const label = selected ? chalk.cyan(choice.label) : chalk.dim(choice.label)
    lines.push(`│ ${marker} [${index + 1}] ${label}`)
  })

  lines.push(` ${chalk.dim('▲/▼ select   1/2/3/4/5 choose   ↵ confirm   esc cancel')}`)
  return `${lines.join('\n')}\n`
}

export async function askPermission(
  rl: CliReadline,
  event: PermissionDialogEvent,
  signal: AbortSignal,
): Promise<PermissionDecision> {
  const wasRaw = process.stdin.isRaw
  const dataListeners = process.stdin.listeners('data')
  const keypressListeners = process.stdin.listeners('keypress')
  rl.pause()
  process.stdin.removeAllListeners('keypress')
  inputState.set('permissionPanel', { toolName: event.name, toolRisk: event.risk })

  return new Promise<PermissionDecision>((resolve, reject) => {
    let settled = false
    let panelState = createPermissionPanelState()
    let renderedLines = 0
    const choices = defaultPermissionChoices

    const cleanup = () => {
      clearRenderedPermissionDialog()
      process.stdin.removeListener('data', onData)
      process.stdin.removeListener('keypress', onKeypress)
      for (const listener of dataListeners) {
        process.stdin.on('data', listener as any)
      }
      for (const listener of keypressListeners) {
        process.stdin.on('keypress', listener as any)
      }
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(wasRaw)
      }
      signal.removeEventListener('abort', onAbort)
      rl.resume()
      process.stdin.resume()
      if (inputState.current === 'permissionPanel') {
        inputState.set('idle')
      }
    }

    const redraw = () => {
      clearRenderedPermissionDialog()
      const dialog = formatPermissionDialog(event, choices, panelState.activeIndex)
      process.stdout.write(dialog)
      renderedLines = countRenderedLines(dialog)
    }

    const clearRenderedPermissionDialog = () => {
      if (renderedLines <= 0) return
      process.stdout.write(`\x1b[${renderedLines}A\x1b[J`)
      renderedLines = 0
    }

    const finish = async (choice: PermissionChoice) => {
      if (settled) return
      settled = true
      const decision = permissionDecisionFromChoice(choice)
      if (decision === 'needs_rule_input') {
        cleanup()
        const defaultRule = formatSuggestedPermissionRule(event) ?? event.name ?? '*'
        const ruleInput = await questionAsync(rl, chalk.yellow(`Enter allow rule prefix (default: ${defaultRule}): `))
        const rule = ruleInput.trim() || defaultRule
        resolve(permissionDecisionFromChoice(choice, { rule }) as PermissionDecision)
        return
      }
      if (decision === 'needs_reject_instruction') {
        cleanup()
        const reason = await questionAsync(rl, chalk.yellow('Tell the model what to do instead: '))
        resolve(permissionDecisionFromChoice(choice, { reason }) as PermissionDecision)
        return
      }
      cleanup()
      resolve(decision)
    }

    const onAbort = () => {
      if (settled) return
      settled = true
      process.stdout.write('\n')
      cleanup()
      const err = new Error('Aborted')
      err.name = 'AbortError'
      reject(err)
    }

    const applyPanelKey = (chunk: any, key: any) => {
      const reduced = reducePermissionPanelKey(panelState, normalizeKeyEvent(chunk, key))
      panelState = reduced.state
      if (reduced.action.type === 'abort') {
        onAbort()
      } else if (reduced.action.type === 'redraw') {
        redraw()
      } else if (reduced.action.type === 'finish') {
        void finish(selectedPermissionChoice(choices, reduced.action.choiceIndex))
      }
    }

    const onData = (chunk: Buffer | string) => {
      applyPanelKey(chunk, undefined)
    }

    const onKeypress = (chunk: any, key: any) => {
      applyPanelKey(chunk, key)
    }

    for (const listener of dataListeners) {
      process.stdin.removeListener('data', listener as any)
    }
    process.stdin.on('data', onData)
    process.stdin.on('keypress', onKeypress)
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true)
    }
    process.stdin.resume()
    signal.addEventListener('abort', onAbort, { once: true })
    redraw()
  })
}

export async function handleLocalPermissionRequest(
  sessionId: string,
  event: PermissionDialogEvent & { toolUseId: string },
  rl: CliReadline,
  signal: AbortSignal,
): Promise<void> {
  await new Promise(resolve => setImmediate(resolve))
  try {
    const cached = isSessionPermissionCached(sessionId, event)
    const decision: PermissionDecision = cached
      ? { approved: true, scope: 'session', reason: 'Approved from session permission cache' }
      : await askPermission(rl, event, signal)
    if (decision.approved && decision.scope === 'session' && event.name) {
      const tools = sessionPermissionApprovals.get(sessionId) ?? new Set<string>()
      if (decision.rule) {
        tools.add(encodeSessionPermissionRule(event.name, decision.rule))
      } else {
        tools.add(event.name)
      }
      sessionPermissionApprovals.set(sessionId, tools)
    }
    const resolved = PendingPermissionRegistry.getInstance().resolve(sessionId, event.toolUseId, {
      approved: decision.approved,
      reason: decision.approved ? decision.reason : decision.reason ?? 'Denied by user',
    })
    if (!resolved) {
      console.error(chalk.red(`Permission request not found: ${event.toolUseId}`))
    }
  } catch (err: any) {
    if (err.name === 'AbortError') {
      PendingPermissionRegistry.getInstance().resolve(sessionId, event.toolUseId, {
        approved: false,
        reason: 'Cancelled by user',
      })
    } else {
      throw err
    }
  }
}

export function formatCompletionChoice(choice: string, selected: boolean): string {
  const { label, tag, description } = describeCompletionChoice(choice)
  const prefix = selected ? '~ ' : '  '
  const row = `${prefix}${label.padEnd(16)} [${tag}]  ${description}`
  return selected ? chalk.black.bgCyan(row) : chalk.dim(row)
}

export function describeCompletionChoice(choice: string): { label: string; tag: string; description: string } {
  const details: Record<string, { tag: string; description: string }> = {
    '/help': { tag: 'command', description: 'Show command help' },
    '/clear': { tag: 'command', description: 'Clear the terminal' },
    '/compact': { tag: 'session', description: 'Compact current session context' },
    '/pager': { tag: 'command', description: 'Open the last output in terminal pager' },
    '/less': { tag: 'command', description: 'Open the last output in terminal pager' },
    '/context': { tag: 'session', description: 'Inspect context budget and compact state' },
    '/agentloop-smoke': { tag: 'agent', description: 'Render mock AgentLoop sub-agent hierarchy' },
    '/exit': { tag: 'command', description: 'Exit chat' },
    '/model': { tag: 'config', description: 'Open model configuration wizard' },
    '/profile': { tag: 'config', description: 'Show, set, or add configurations profiles' },
    '/status': { tag: 'status', description: 'Show current runtime and model' },
    '/smoke': { tag: 'status', description: 'Run provider smoke readiness or live probe' },
    '/fallback': { tag: 'status', description: 'Show non-silent provider fallback plan' },
    '/sessions': { tag: 'session', description: 'List recent sessions' },
    '/inbox': { tag: 'session', description: 'Show unread SessionChannel messages' },
    '/history': { tag: 'history', description: 'Search and replay prompt history' },
    '/tool': { tag: 'tools', description: 'Open the tool picker' },
    '/read': { tag: 'tool', description: 'Insert read prompt prefix' },
    '/write': { tag: 'tool', description: 'Insert write prompt prefix' },
    '/edit': { tag: 'tool', description: 'Insert edit prompt prefix' },
    '/grep': { tag: 'tool', description: 'Insert grep prompt prefix' },
    '/glob': { tag: 'tool', description: 'Insert glob prompt prefix' },
    '/bash': { tag: 'tool', description: 'Insert bash prompt prefix' },
    '/task': { tag: 'tool', description: 'Insert task prompt prefix' },
    '/tool read': { tag: 'read', description: 'Read a file inside the workspace' },
    '/tool write': { tag: 'write', description: 'Write a file with permission' },
    '/tool edit': { tag: 'write', description: 'Replace text in a file with permission' },
    '/tool grep': { tag: 'read', description: 'Search file contents' },
    '/tool glob': { tag: 'read', description: 'Find files by pattern' },
    '/tool bash': { tag: 'execute', description: 'Run a shell command with permission' },
    '/tool task': { tag: 'task', description: 'Create a task record' },
  }
  return {
    label: choice,
    tag: details[choice]?.tag ?? 'path',
    description: details[choice]?.description ?? 'Workspace path',
  }
}

export function runInteractiveDropdown(
  choices: string[],
  originalWord: string,
  onSelect: (selected: string) => void
) {
  let activeIndex = 0
  const displayChoices = choices.slice(0, 10)

  const keypressListeners = process.stdin.listeners('keypress')
  const wasRaw = process.stdin.isRaw

  process.stdin.removeAllListeners('keypress')

  const redraw = () => {
    process.stdout.write('\x1b[s')
    process.stdout.write('\n\x1b[J')
    for (let i = 0; i < displayChoices.length; i++) {
      const isSelected = i === activeIndex
      process.stdout.write(formatCompletionChoice(displayChoices[i]!, isSelected) + '\n')
    }
    process.stdout.write('\x1b[u')
  }

  const cleanup = () => {
    process.stdout.write('\x1b[s\n\x1b[J\x1b[u')
    process.stdin.removeListener('keypress', handleKey)
    for (const l of keypressListeners) {
      process.stdin.addListener('keypress', l as any)
    }
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(wasRaw)
    }
  }

  const handleKey = (chunk: any, key: any) => {
    const name = key?.name || (chunk ? chunk.toString() : '')
    const ctrl = key?.ctrl || (key && key.ctrl)

    if (ctrl && name === 'c') {
      cleanup()
      process.exit(0)
    }
    if (name === 'up' || name === '\u001b[A' || name === '\x1b[A') {
      activeIndex = (activeIndex - 1 + displayChoices.length) % displayChoices.length
      redraw()
      return
    }
    if (name === 'down' || name === '\u001b[B' || name === '\x1b[B') {
      activeIndex = (activeIndex + 1) % displayChoices.length
      redraw()
      return
    }
    if (name === 'enter' || name === 'return' || name === '\r' || name === '\n') {
      cleanup()
      onSelect(displayChoices[activeIndex]!)
      return
    }
    if (name === 'escape' || name === '\u001b' || name === '\x1b') {
      cleanup()
      onSelect('')
      return
    }

    cleanup()
    onSelect('')
    if (chunk || key) {
      process.stdin.emit('keypress', chunk, key)
    }
  }

  process.stdin.on('keypress', handleKey)
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true)
  }

  redraw()
}

export function pickCompletionChoice(choices: string[]): Promise<string> {
  return new Promise(resolve => {
    runInteractiveDropdown(choices, '', selected => resolve(selected))
  })
}

export function chooseInteractive(
  question: string,
  choices: string[],
  onSelect: (selected: string) => void
) {
  let activeIndex = 0

  emitKeypressEvents(process.stdin)
  process.stdin.resume()

  const keypressListeners = process.stdin.listeners('keypress')
  const wasRaw = process.stdin.isRaw

  process.stdin.removeAllListeners('keypress')

  const redraw = () => {
    process.stdout.write('\x1b[s')
    process.stdout.write('\n\x1b[J')
    process.stdout.write(chalk.cyan(question) + '\n')
    for (let i = 0; i < choices.length; i++) {
      const isSelected = i === activeIndex
      const prefix = isSelected ? chalk.cyan('> ') : '  '
      const text = isSelected ? chalk.black.bgCyan(choices[i]!) : chalk.dim(choices[i]!)
      process.stdout.write(prefix + text + '\n')
    }
    process.stdout.write('\x1b[u')
  }

  const cleanup = () => {
    process.stdout.write('\x1b[s\n\x1b[J\x1b[u')
    process.stdin.removeListener('keypress', handleKey)
    for (const l of keypressListeners) {
      process.stdin.addListener('keypress', l as any)
    }
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(wasRaw)
    }
  }

  const handleKey = (chunk: any, key: any) => {
    const name = key?.name || (chunk ? chunk.toString() : '')
    const ctrl = key?.ctrl || (key && key.ctrl)

    if (ctrl && name === 'c') {
      cleanup()
      process.exit(0)
    }
    if (name === 'up' || name === '\u001b[A' || name === '\x1b[A') {
      activeIndex = (activeIndex - 1 + choices.length) % choices.length
      redraw()
      return
    }
    if (name === 'down' || name === '\u001b[B' || name === '\x1b[B') {
      activeIndex = (activeIndex + 1) % choices.length
      redraw()
      return
    }
    if (name === 'enter' || name === 'return' || name === '\r' || name === '\n') {
      cleanup()
      onSelect(choices[activeIndex]!)
      return
    }
    if (name === 'escape' || name === '\u001b' || name === '\x1b') {
      cleanup()
      onSelect('')
      return
    }
  }

  process.stdin.on('keypress', handleKey)
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true)
  }

  redraw()
}

export function promptSecret(question: string, callback: (secret: string) => void) {
  emitKeypressEvents(process.stdin)
  process.stdin.resume()

  process.stdout.write(chalk.cyan(question))
  let value = ''

  const keypressListeners = process.stdin.listeners('keypress')
  const wasRaw = process.stdin.isRaw

  process.stdin.removeAllListeners('keypress')

  const handleKey = (chunk: any, key: any) => {
    const name = key?.name || (chunk ? chunk.toString() : '')
    const ctrl = key?.ctrl || (key && key.ctrl)

    if (ctrl && name === 'c') {
      cleanup()
      process.exit(0)
    }
    if (name === 'escape' || name === '\u001b' || name === '\x1b') {
      process.stdout.write('\n')
      cleanup()
      callback('')
      return
    }
    if (name === 'enter' || name === 'return' || name === '\r' || name === '\n') {
      process.stdout.write('\n')
      cleanup()
      callback(value)
      return
    }
    if (name === 'backspace' || name === '\x7f' || name === '\b') {
      if (value.length > 0) {
        value = value.slice(0, -1)
        process.stdout.write('\b\x1b[K')
      }
      return
    }

    if (chunk && chunk !== '\r' && chunk !== '\n' && chunk !== '\u001b' && chunk !== '\x1b' && chunk !== '\x7f' && chunk !== '\b') {
      if (!chunk.toString().startsWith('\x1b')) {
        value += chunk
        process.stdout.write('*')
      }
    }
  }

  const cleanup = () => {
    process.stdin.removeListener('keypress', handleKey)
    for (const l of keypressListeners) {
      process.stdin.addListener('keypress', l as any)
    }
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(wasRaw)
    }
  }

  process.stdin.on('keypress', handleKey)
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true)
  }
}

export function promptText(question: string, defaultValue: string, callback: (text: string) => void) {
  emitKeypressEvents(process.stdin)
  process.stdin.resume()

  const showDefault = defaultValue ? chalk.dim(` (${defaultValue})`) : ''
  process.stdout.write(chalk.cyan(question) + showDefault + ': ')
  let value = ''

  const keypressListeners = process.stdin.listeners('keypress')
  const wasRaw = process.stdin.isRaw

  process.stdin.removeAllListeners('keypress')

  const handleKey = (chunk: any, key: any) => {
    const name = key?.name || (chunk ? chunk.toString() : '')
    const ctrl = key?.ctrl || (key && key.ctrl)

    if (ctrl && name === 'c') {
      cleanup()
      process.exit(0)
    }
    if (name === 'escape' || name === '\u001b' || name === '\x1b') {
      process.stdout.write('\n')
      cleanup()
      callback('')
      return
    }
    if (name === 'enter' || name === 'return' || name === '\r' || name === '\n') {
      process.stdout.write('\n')
      cleanup()
      callback(value || defaultValue)
      return
    }
    if (name === 'backspace' || name === '\x7f' || name === '\b') {
      if (value.length > 0) {
        value = value.slice(0, -1)
        process.stdout.write('\b\x1b[K')
      }
      return
    }

    if (chunk && chunk !== '\r' && chunk !== '\n' && chunk !== '\u001b' && chunk !== '\x1b' && chunk !== '\x7f' && chunk !== '\b') {
      if (!chunk.toString().startsWith('\x1b')) {
        value += chunk
        process.stdout.write(chunk)
      }
    }
  }

  const cleanup = () => {
    process.stdin.removeListener('keypress', handleKey)
    for (const l of keypressListeners) {
      process.stdin.addListener('keypress', l as any)
    }
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(wasRaw)
    }
  }

  process.stdin.on('keypress', handleKey)
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true)
  }
}
