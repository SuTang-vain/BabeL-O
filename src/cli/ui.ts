import readline from 'node:readline'
import chalk from 'chalk'
import { emitKeypressEvents } from 'node:readline'
import { PendingPermissionRegistry } from '../shared/session.js'
import { getChatPrompt } from './renderEvents.js'

export type CliReadline = readline.Interface

export type PermissionChoice =
  | 'approve_once'
  | 'approve_session'
  | 'reject'
  | 'reject_instruct'

export interface PermissionDecision {
  approved: boolean
  scope: 'once' | 'session'
  reason?: string
}

export const sessionPermissionApprovals = new Map<string, Set<string>>()

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
    '/exit': '/exit',
    '/status': '/status',
    '/sessions': '/sessions',
  }
  return mappings[selected] ?? mappings[selected.toLowerCase()] ?? selected
}


export function formatPermissionInput(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const record = input as Record<string, unknown>
  if (typeof record.command === 'string') return record.command
  if (typeof record.path === 'string') return record.path
  return JSON.stringify(input)
}

export function countRenderedLines(text: string): number {
  return text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length
}

export function formatPermissionDialog(
  event: { name?: string; risk?: string; input?: unknown },
  choices: { id: PermissionChoice; label: string }[],
  activeIndex: number,
): string {
  const tool = event.name || 'tool'
  const risk = event.risk ? `${event.risk} risk` : 'unknown risk'
  const command = formatPermissionInput(event.input)
  const lines = [
    chalk.yellow(' approval '),
    `│ ${chalk.yellow(`${tool} is requesting approval (${risk})`)}`,
  ]
  if (command) {
    lines.push('│')
    lines.push(`│ ${command}`)
  }

  choices.forEach((choice, index) => {
    const selected = index === activeIndex
    const marker = selected ? chalk.cyan('➜') : ' '
    const label = selected ? chalk.cyan(choice.label) : chalk.dim(choice.label)
    lines.push(`│ ${marker} [${index + 1}] ${label}`)
  })

  lines.push(` ${chalk.dim('▲/▼ select   1/2/3/4 choose   ↵ confirm   esc reject')}`)
  return `${lines.join('\n')}\n`
}

export async function askPermission(
  rl: CliReadline,
  event: { name?: string; risk?: string; input?: unknown },
  signal: AbortSignal,
): Promise<PermissionDecision> {
  const wasRaw = process.stdin.isRaw
  const dataListeners = process.stdin.listeners('data')
  const keypressListeners = process.stdin.listeners('keypress')
  rl.pause()
  process.stdin.removeAllListeners('keypress')

  return new Promise<PermissionDecision>((resolve, reject) => {
    let settled = false
    let activeIndex = 0
    let renderedLines = 0
    const choices: { id: PermissionChoice; label: string }[] = [
      { id: 'approve_once', label: 'Approve once' },
      { id: 'approve_session', label: 'Approve for this session' },
      { id: 'reject', label: 'Reject' },
      { id: 'reject_instruct', label: 'Reject, tell the model what to do instead' },
    ]

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
    }

    const redraw = () => {
      clearRenderedPermissionDialog()
      const dialog = formatPermissionDialog(event, choices, activeIndex)
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
      let decision: PermissionDecision
      if (choice === 'approve_once') {
        decision = { approved: true, scope: 'once' }
      } else if (choice === 'approve_session') {
        decision = { approved: true, scope: 'session' }
      } else if (choice === 'reject_instruct') {
        cleanup()
        const reason = await questionAsync(rl, chalk.yellow('Tell the model what to do instead: '))
        resolve({
          approved: false,
          scope: 'once',
          reason: reason.trim() || 'Denied by user',
        })
        return
      } else {
        decision = { approved: false, scope: 'once', reason: 'Denied by user' }
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

    const move = (delta: number) => {
      activeIndex = (activeIndex + delta + choices.length) % choices.length
      redraw()
    }

    const chooseIndex = (index: number) => {
      activeIndex = index
      void finish(choices[activeIndex]!.id)
    }

    const onData = (chunk: Buffer | string) => {
      const text = chunk.toString('utf8')
      if (text.includes('\u0003')) {
        onAbort()
        return
      }
      if (text.includes('\x1b[A')) {
        move(-1)
        return
      }
      if (text.includes('\x1b[B')) {
        move(1)
        return
      }
      for (const char of text) {
        if (char >= '1' && char <= '4') {
          chooseIndex(Number(char) - 1)
          return
        }
        if (char === '\r' || char === '\n') {
          void finish(choices[activeIndex]!.id)
          return
        }
        if (char === '\x1b') {
          chooseIndex(2)
          return
        }
      }
    }

    const onKeypress = (_chunk: any, key: any) => {
      if (key?.ctrl && key.name === 'c') {
        onAbort()
        return
      }
      if (key?.name === 'up') {
        move(-1)
      } else if (key?.name === 'down') {
        move(1)
      } else if (key?.name === 'return') {
        void finish(choices[activeIndex]!.id)
      } else if (key?.name === 'escape') {
        chooseIndex(2)
      } else if (['1', '2', '3', '4'].includes(key?.name)) {
        chooseIndex(Number(key.name) - 1)
      }
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
  event: { toolUseId: string; name?: string; risk?: string; input?: unknown },
  rl: CliReadline,
  signal: AbortSignal,
): Promise<void> {
  await new Promise(resolve => setImmediate(resolve))
  try {
    const cached = event.name ? sessionPermissionApprovals.get(sessionId)?.has(event.name) : false
    const decision: PermissionDecision = cached
      ? { approved: true, scope: 'session' }
      : await askPermission(rl, event, signal)
    if (decision.approved && decision.scope === 'session' && event.name) {
      const tools = sessionPermissionApprovals.get(sessionId) ?? new Set<string>()
      tools.add(event.name)
      sessionPermissionApprovals.set(sessionId, tools)
    }
    const resolved = PendingPermissionRegistry.getInstance().resolve(sessionId, event.toolUseId, {
      approved: decision.approved,
      reason: decision.approved ? undefined : decision.reason ?? 'Denied by user',
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
    '/exit': { tag: 'command', description: 'Exit chat' },
    '/model': { tag: 'config', description: 'Open model configuration wizard' },
    '/profile': { tag: 'config', description: 'Show, set, or add configurations profiles' },
    '/status': { tag: 'status', description: 'Show current runtime and model' },
    '/sessions': { tag: 'session', description: 'List recent sessions' },
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
