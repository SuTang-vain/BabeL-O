import readline from 'node:readline'
import chalk from 'chalk'
import { modelRegistry } from '../providers/registry.js'
import { completePathMention, WorkspacePathIndex } from './pathMention.js'
import { ConfigManager } from '../shared/config.js'
import { getChatPrompt } from './renderEvents.js'
import {
  describeCompletionChoice,
  mapDropdownSelection,
  countRenderedLines
} from './ui.js'
import { inputState } from './inputState.js'
import { currentInputModelLabel } from './inputBox.js'
import { truncateToTerminalWidth, visibleTerminalWidth } from './terminalWidth.js'

type CliReadline = readline.Interface

type SlashPaletteOptions = {
  clearInputBlock?: () => void
}

export function getSlashCompletionChoices(): string[] {
  return [
    '/help', '/clear', '/compact', '/context', '/agentloop-smoke', '/agents', '/exit', '/model', '/profile', '/status', '/smoke', '/fallback', '/sessions', '/history', '/tool',
    '/read', '/write', '/edit', '/grep', '/glob', '/bash', '/task', '/pager', '/less', '/editor', '/e',
  ]
}

export function getToolCompletionChoices(): string[] {
  return [
    '/tool read',
    '/tool write',
    '/tool edit',
    '/tool grep',
    '/tool glob',
    '/tool bash',
    '/tool task',
  ]
}

export function getSlashPaletteChoices(input: string): string[] {
  if (!/^\/[A-Za-z]*$/.test(input)) return []
  const normalized = input.toLowerCase()
  return getSlashCompletionChoices()
    .filter(choice => choice.toLowerCase().startsWith(normalized))
    .sort((left, right) => left.localeCompare(right))
}

export function formatSlashPalette(
  choices: string[],
  activeIndex: number,
  totalCount = choices.length,
  modelLabel = currentInputModelLabel(),
  options: { showSeparator?: boolean; columns?: number } = {},
): string {
  if (choices.length === 0) return ''

  const visibleHeight = 8
  let scrollOffset = 0
  if (activeIndex >= visibleHeight) {
    scrollOffset = activeIndex - visibleHeight + 1
  }

  const visible = choices.slice(scrollOffset, scrollOffset + visibleHeight)
  const terminalColumns = Math.max(24, options.columns ?? process.stdout.columns ?? 80)
  const columns = Math.max(20, terminalColumns - 1)
  const contentColumns = Math.max(18, columns - 2)
  const lines = options.showSeparator === false
    ? []
    : [chalk.dim('─'.repeat(columns))]
  const longestLabelWidth = Math.max(
    0,
    ...visible.map(choice => visibleTerminalWidth(describeCompletionChoice(choice).label)),
  )
  const labelColumnWidth = Math.max(
    10,
    Math.min(Math.max(18, longestLabelWidth + 8), Math.floor(contentColumns * 0.48)),
  )
  for (let index = 0; index < visible.length; index++) {
    const choice = visible[index]!
    const { label, description } = describeCompletionChoice(choice)
    const selected = (index + scrollOffset) === activeIndex
    const marker = selected ? chalk.blue('>') : ' '
    const labelWidth = Math.min(visibleTerminalWidth(label), Math.max(1, labelColumnWidth - 2))
    const renderedLabel = visibleTerminalWidth(label) > labelWidth
      ? `${truncateToTerminalWidth(label, Math.max(1, labelWidth - 1))}…`
      : label
    const left = selected ? chalk.blue(renderedLabel) : chalk.white(renderedLabel)
    const padding = ' '.repeat(Math.max(2, labelColumnWidth - visibleTerminalWidth(renderedLabel)))
    const descriptionBudget = Math.max(0, contentColumns - 2 - labelColumnWidth)
    const renderedDescription = truncateWithEllipsis(description, descriptionBudget)
    const right = renderedDescription ? chalk.dim(renderedDescription) : ''
    lines.push(`${marker} ${left}${padding}${right}`.trimEnd())
  }

  const remainingBelow = Math.max(0, totalCount - (scrollOffset + visible.length))
  const remainingAbove = scrollOffset

  if (remainingAbove > 0) {
    const insertIndex = options.showSeparator === false ? 0 : 1
    lines.splice(insertIndex, 0, `  ${chalk.dim(`↑ ${remainingAbove} more`)}`)
  }
  if (remainingBelow > 0) {
    lines.push(`  ${chalk.dim(`↓ ${remainingBelow} more`)}`)
  }
  lines.push('')
  lines.push(formatSlashPaletteFooter(columns, modelLabel))
  return `${lines.join('\n')}\n`
}

function formatSlashPaletteFooter(columns: number, modelLabel: string): string {
  const navigation = columns < 54
    ? `${chalk.dim('↑/↓ ·')} ${chalk.blue('tab')} ${chalk.dim('Complete')}`
    : `${chalk.dim('↑/↓ Navigate ·')} ${chalk.blue('tab')} ${chalk.dim('Complete ·')} ${chalk.blue('enter')} ${chalk.dim('Run')}`
  const cancel = chalk.dim('esc to cancel')
  const model = chalk.dim(truncateWithEllipsis(modelLabel, Math.max(8, Math.floor(columns * 0.45))))
  const navLine = alignRight(navigation, columns)
  const bottomLeft = visibleTerminalWidth(cancel) + visibleTerminalWidth(model) + 1 <= columns
    ? `${cancel}${' '.repeat(Math.max(1, columns - visibleTerminalWidth(cancel) - visibleTerminalWidth(model)))}${model}`
    : model
  return `${navLine}\n${bottomLeft}`
}

function alignRight(text: string, columns: number): string {
  const width = visibleTerminalWidth(text)
  if (width >= columns) return truncateWithEllipsis(text, columns)
  return `${' '.repeat(columns - width)}${text}`
}

function truncateWithEllipsis(text: string, width: number): string {
  if (width <= 0) return ''
  if (visibleTerminalWidth(text) <= width) return text
  if (width === 1) return '…'
  return `${truncateToTerminalWidth(text, width - 1)}…`
}

export function makeCompleter(cwd: string) {
  const pathIndex = new WorkspacePathIndex(cwd)
  return (line: string, callback?: (err: Error | null, result?: [string[], string]) => void) => {
    let hits: string[] = []
    let substring = line

    if (line.startsWith('/') && !line.includes(' ')) {
      const commands = getSlashCompletionChoices()
      hits = commands.filter(c => c.startsWith(line))
      substring = line
    } else if (line.startsWith('/tool')) {
      const toolPrefix = line.slice('/tool'.length).trimStart().toLowerCase()
      const toolChoices = getToolCompletionChoices()
      hits = toolChoices.filter(c => c.toLowerCase().startsWith(`/tool ${toolPrefix}`))
      substring = line
    } else if (line.startsWith('/model ')) {
      const modelPrefix = line.slice('/model '.length)
      const modelIds = modelRegistry.map(m => m.id)
      hits = modelIds.filter(id => id.startsWith(modelPrefix)).map(id => `/model ${id}`)
      substring = line
    } else if (line.startsWith('/profile ')) {
      const profilePrefix = line.slice('/profile '.length)
      const profiles = Object.keys(ConfigManager.getInstance().getProfiles())
      const subCommands = ['clear', 'add']
      const allOptions = [...subCommands, ...profiles]
      hits = allOptions.filter(opt => opt.startsWith(profilePrefix)).map(opt => `/profile ${opt}`)
      substring = line
    } else if (line.startsWith('/smoke ')) {
      const smokePrefix = line.slice('/smoke '.length).trimStart().toLowerCase()
      hits = ['dry-run', 'live', 'live tool-call', 'tool-call']
        .filter(option => option.startsWith(smokePrefix))
        .map(option => `/smoke ${option}`)
      substring = line
    } else if (line.startsWith('/fallback ')) {
      const fallbackPrefix = line.slice('/fallback '.length).trimStart().toLowerCase()
      hits = ['max-output-tokens', 'context-window', 'rate-limit', 'auth-or-billing', 'provider-protocol', 'provider-unavailable', 'unknown']
        .filter(option => option.startsWith(fallbackPrefix))
        .map(option => `/fallback ${option}`)
      substring = line
    } else {
      const pathCompletion = completePathMention(line, cwd, pathIndex)
      if (pathCompletion) {
        hits = pathCompletion.hits
        substring = pathCompletion.substring
      }
    }

    const complete = (result: [string[], string]) => {
      if (callback) {
        callback(null, result)
        return
      }
      return result
    }

    if (hits.length === 0) {
      return complete([[], substring])
    } else if (hits.length === 1) {
      const mapped = mapDropdownSelection(hits[0]!)
      return complete([[mapped], substring])
    } else {
      return complete([hits, substring])
    }
  }
}

interface ReadlineInternal extends CliReadline {
  line: string
  cursor: number
  _refreshLine?: () => void
  _ttyWrite?: (text: string, key: any) => void
  history: string[]
}

export function createSlashPalette(rl: CliReadline, options: SlashPaletteOptions = {}) {
  const rlInt = rl as ReadlineInternal
  let activeIndex = 0
  let currentChoices: string[] = []
  let consumedNavigationKey = false
  let isOpen = false
  let query = ''
  let renderedLines = 0
  let cursorRowInOverlay = 0
  let pendingRefresh: NodeJS.Timeout | null = null
  let clearedInputBlock = false

  const originalTtyWrite = typeof rlInt._ttyWrite === 'function'
    ? rlInt._ttyWrite.bind(rlInt)
    : null

  const cancelPendingRefresh = () => {
    if (pendingRefresh) {
      clearTimeout(pendingRefresh)
      pendingRefresh = null
    }
  }

  const scheduleRefresh = () => {
    cancelPendingRefresh()
    pendingRefresh = setTimeout(() => {
      pendingRefresh = null
      refresh()
    }, 0)
  }

  const refresh = () => {
    const line = rlInt.line ?? ''
    if (!isOpen || line !== currentChoices[activeIndex]) {
      query = line
    }
    currentChoices = getSlashPaletteChoices(query)
    if (currentChoices.length === 0) {
      close()
      return
    }
    isOpen = true
    inputState.set('slashPalette')
    activeIndex = Math.min(activeIndex, currentChoices.length - 1)
    renderOverlay()
  }

  const renderOverlay = () => {
    if (!clearedInputBlock) {
      options.clearInputBlock?.()
      clearedInputBlock = true
    }
    clear()
    const columns = process.stdout.columns || 80
    const palette = formatSlashPalette(currentChoices, activeIndex, currentChoices.length, currentInputModelLabel(), { showSeparator: false, columns })
    if (!palette) return
    const line = rlInt.line ?? ''
    const prompt = getChatPrompt()
    const separator = chalk.dim('─'.repeat(Math.max(1, columns - 1)))
    process.stdout.write(`\r\x1b[K${separator}`)
    process.stdout.write(`\n\r\x1b[K${prompt}${line}`)
    process.stdout.write(`\n\r\x1b[K${separator}`)
    process.stdout.write('\n')
    process.stdout.write(palette)
    renderedLines = 3 + countRenderedLines(palette)
    cursorRowInOverlay = 1

    const promptWidth = visibleTerminalWidth(prompt)

    readline.moveCursor(process.stdout, 0, -renderedLines + 1)
    readline.cursorTo(process.stdout, promptWidth + visibleTerminalWidth(line.slice(0, rlInt.cursor ?? line.length)))
  }

  const clear = () => {
    if (!isOpen || renderedLines <= 0) return
    if (cursorRowInOverlay > 0) {
      readline.moveCursor(process.stdout, 0, -cursorRowInOverlay)
    }
    readline.cursorTo(process.stdout, 0)
    readline.clearScreenDown(process.stdout)
    renderedLines = 0
    cursorRowInOverlay = 0
  }

  const close = () => {
    cancelPendingRefresh()
    const wasOpen = isOpen
    clear()
    currentChoices = []
    activeIndex = 0
    isOpen = false
    query = ''
    clearedInputBlock = false
    if (inputState.current === 'slashPalette') {
      inputState.set('idle')
    }
    if (wasOpen) {
      refreshReadline()
    }
  }

  const setInputLine = (value: string) => {
    rlInt.line = value
    rlInt.cursor = value.length
  }

  const preview = () => {
    const selected = currentChoices[activeIndex]
    if (!selected) return false
    setInputLine(selected)
    return true
  }

  const refreshFromCurrentInput = (previewSelection: boolean) => {
    const line = rlInt.line ?? ''
    query = line
    currentChoices = getSlashPaletteChoices(query)
    if (currentChoices.length === 0) {
      close()
      return
    }
    isOpen = true
    activeIndex = Math.min(activeIndex, currentChoices.length - 1)
    if (previewSelection) {
      preview()
    }
    renderOverlay()
  }

  const select = () => {
    const selected = currentChoices[activeIndex]
    if (!selected) return false
    const mapped = mapDropdownSelection(selected)
    setInputLine(mapped)
    close()
    // Move cursor to end of line to avoid partial input issues
    rlInt.cursor = rlInt.line.length
    return true
  }

  const move = (delta: number) => {
    if (currentChoices.length === 0) return false
    activeIndex = (activeIndex + delta + currentChoices.length) % currentChoices.length
    preview()
    renderOverlay()
    return true
  }

  const handleKey = (chunk: any, key: any): boolean => {
    const raw = chunk ? chunk.toString('utf8') : ''
    const keyName = key?.name
    const duplicateNavigationKey = keyName === 'up' || keyName === 'down' || keyName === 'tab' ||
      raw.includes('\x1b[A') || raw.includes('\x1b[B') || raw === '\t'
    if (consumedNavigationKey && duplicateNavigationKey) {
      consumedNavigationKey = false
      return true
    }
    consumedNavigationKey = false
    // If permission panel is open, do not intercept keys
    if (inputState.current === 'permissionPanel') {
      return false
    }
    const line = rlInt.line ?? ''
    const shouldShow = getSlashPaletteChoices(line).length > 0
    if (!shouldShow) {
      close()
      return false
    }
    if (raw.includes('\x1b[A')) return move(-1)
    if (raw.includes('\x1b[B')) return move(1)
    if (raw === '\t') return select()
    if (raw === '\r' || raw === '\n') return false
    if (key?.name === 'up') return move(-1)
    if (key?.name === 'down') return move(1)
    if (key?.name === 'tab') return select()
    if (key?.name === 'return') return false
    if (key?.name === 'escape' || raw === '\x1b') {
      // Restore original query line when escaping palette
      if (query && query !== rlInt.line) {
        setInputLine(query)
      }
      close()
      return true
    }
    scheduleRefresh()
    return false
  }

  if (originalTtyWrite) {
    rlInt._ttyWrite = (text: string, key: any) => {
      const raw = typeof text === 'string' ? text : ''
      const keyName = key?.name
      const navigationKey = keyName === 'up' || keyName === 'down' || keyName === 'tab' ||
        raw.includes('\x1b[A') || raw.includes('\x1b[B') || raw === '\t'
      const escapeKey = keyName === 'escape' || raw === '\x1b'
      const backspaceKey = keyName === 'backspace' || raw === '\x7f' || raw === '\b'
      const line = rlInt.line ?? ''
      const choices = isOpen ? currentChoices : getSlashPaletteChoices(line)

      if (escapeKey && isOpen) {
        cancelPendingRefresh()
        consumedNavigationKey = true
        // Restore original query line when escaping palette
        if (query && query !== rlInt.line) {
          setInputLine(query)
        }
        close()
        return
      }

      if (backspaceKey && isOpen) {
        cancelPendingRefresh()
        clear()
        const cursor = rlInt.cursor ?? line.length
        if (cursor > 0) {
          const nextLine = line.slice(0, cursor - 1) + line.slice(cursor)
          rlInt.line = nextLine
          rlInt.cursor = cursor - 1
        }
        // If backspace removed the leading '/', close palette immediately
        if (!rlInt.line.startsWith('/')) {
          close()
          consumedNavigationKey = true
          return
        }
        refreshFromCurrentInput(false)
        consumedNavigationKey = true
        return
      }

      if (navigationKey && choices.length > 0) {
        cancelPendingRefresh()
        currentChoices = choices
        if (!isOpen) {
          query = line
          isOpen = true
        }
        activeIndex = Math.min(activeIndex, currentChoices.length - 1)
        consumedNavigationKey = true
        if (keyName === 'up' || raw.includes('\x1b[A')) move(-1)
        else if (keyName === 'down' || raw.includes('\x1b[B')) move(1)
        else select()
        return
      }
      return originalTtyWrite(text, key)
    }
  }

  const refreshReadline = () => {
    if (typeof rlInt._refreshLine === 'function') {
      rlInt._refreshLine()
    }
  }

  const dispose = () => {
    cancelPendingRefresh()
    close()
    if (originalTtyWrite) {
      rlInt._ttyWrite = originalTtyWrite
    }
  }

  return { close, dispose, handleKey }
}
