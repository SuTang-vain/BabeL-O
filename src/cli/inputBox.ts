import chalk from 'chalk'
import { ConfigManager } from '../shared/config.js'
import { modelRegistry } from '../providers/registry.js'
import { terminalWidth, truncateToTerminalWidth, visibleTerminalWidth } from './terminalWidth.js'

export interface FixedInputBoxOptions {
  prompt: string
  line: string
  cursor: number
  suggestion?: string
  placeholder?: string
  columns?: number
}

export interface FixedInputBoxRender {
  text: string
  cursorColumn: number
  cursorRow: number
  cursorRowsFromBottom: number
  contentWidth: number
  truncated: boolean
  renderedSuggestion: boolean
  renderedPlaceholder: boolean
}

export function renderFixedInputBox(options: FixedInputBoxOptions): FixedInputBoxRender {
  const columns = Math.max(20, options.columns ?? process.stdout.columns ?? 80)
  const promptWidth = visibleTerminalWidth(options.prompt)
  const contentWidth = Math.max(1, columns - promptWidth - 1)
  const cursor = Math.max(0, Math.min(options.cursor, options.line.length))
  const view = createInputViewport(options.line, cursor, contentWidth)
  const suggestionTail = getSuggestionTail(options.line, options.suggestion)
  const canRenderSuggestion = !view.truncated &&
    suggestionTail.length > 0 &&
    terminalWidth(view.text) + terminalWidth(suggestionTail) <= contentWidth
  const hasInputContent = options.line.length > 0
  const canRenderPlaceholder = !hasInputContent &&
    options.placeholder !== undefined &&
    options.placeholder.length > 0
  const renderedSuggestion = canRenderSuggestion ? chalk.dim(suggestionTail) : ''
  const renderedPlaceholder = canRenderPlaceholder
    ? chalk.dim(truncateToTerminalWidth(options.placeholder!, contentWidth))
    : ''

  return {
    text: `${options.prompt}${view.text}${renderedSuggestion}${renderedPlaceholder}`,
    cursorColumn: promptWidth + view.cursorColumn,
    cursorRow: 0,
    cursorRowsFromBottom: 0,
    contentWidth,
    truncated: view.truncated,
    renderedSuggestion: canRenderSuggestion,
    renderedPlaceholder: canRenderPlaceholder,
  }
}

export function renderBoxedInput(options: FixedInputBoxOptions & { modelId?: string }): FixedInputBoxRender {
  const columns = Math.max(20, options.columns ?? process.stdout.columns ?? 80)
  const lineWidth = Math.max(1, columns - 1)
  const separator = chalk.dim('─'.repeat(lineWidth))
  const prompt = '> '
  const promptWidth = visibleTerminalWidth(prompt)
  const contentWidth = Math.max(1, lineWidth - promptWidth)
  const cursor = Math.max(0, Math.min(options.cursor, options.line.length))
  const wrapped = wrapInputLines(options.line, cursor, contentWidth)
  const suggestionTail = getSuggestionTail(options.line, options.suggestion)
  const canRenderSuggestion = wrapped.lines.length === 1 &&
    suggestionTail.length > 0 &&
    terminalWidth(wrapped.lines[0]!) + terminalWidth(suggestionTail) <= contentWidth
  const hasInputContent = options.line.length > 0
  const canRenderPlaceholder = !hasInputContent &&
    options.placeholder !== undefined &&
    options.placeholder.length > 0
  const renderedSuggestion = canRenderSuggestion ? chalk.dim(suggestionTail) : ''
  const renderedPlaceholder = canRenderPlaceholder
    ? chalk.dim(truncateToTerminalWidth(options.placeholder!, contentWidth))
    : ''
  const inputLines = wrapped.lines.map((line, index) => {
    const prefix = index === 0 ? prompt : ' '.repeat(promptWidth)
    const suffix = index === 0 ? renderedSuggestion || renderedPlaceholder : ''
    return `${prefix}${line}${suffix}`
  })
  const footer = formatInputFooter(lineWidth, options.modelId)
  const cursorRow = 1 + wrapped.cursorRow
  const totalRows = inputLines.length + 3

  return {
    text: `${separator}\r\n${inputLines.join('\r\n')}\r\n${separator}\r\n${footer}`,
    cursorColumn: promptWidth + wrapped.cursorColumn,
    cursorRow,
    cursorRowsFromBottom: totalRows - 1 - cursorRow,
    contentWidth,
    truncated: false,
    renderedSuggestion: canRenderSuggestion,
    renderedPlaceholder: canRenderPlaceholder,
  }
}

export function currentInputModelLabel(modelId = ConfigManager.getInstance().resolveSettings().modelId): string {
  if (modelId === 'local/coding-runtime') return 'Embedded Local'
  const registered = modelRegistry.find(model => model.id === modelId)
  if (registered) return registered.name
  const rawName = modelId.includes('/') ? modelId.slice(modelId.indexOf('/') + 1) : modelId
  const words = rawName
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, char => char.toUpperCase())
  return words.replace(/\s+(Low|Medium|High|Fast|Slow)$/i, ' ($1)')
}

export function formatInputFooter(columns = process.stdout.columns ?? 80, modelId?: string): string {
  const left = chalk.dim('? for shortcuts')
  const right = chalk.dim(currentInputModelLabel(modelId))
  const gap = Math.max(1, columns - visibleTerminalWidth(left) - visibleTerminalWidth(right))
  return `${left}${' '.repeat(gap)}${right}`
}

export function shouldClearInputGhostBeforeWrite(line: string, chunk: string): boolean {
  return line.length === 0 && isPrintableInputChunk(chunk)
}

export function shouldConsumeBlankInputEnter(line: string, keyKind: string): boolean {
  return keyKind === 'enter' && line.trim().length === 0
}

function isPrintableInputChunk(chunk: string): boolean {
  if (chunk.length === 0 || chunk.startsWith('\x1b')) return false
  for (let i = 0; i < chunk.length; i++) {
    const codePoint = chunk.codePointAt(i)!
    if (codePoint > 0xffff) i++
    if (codePoint < 32 || codePoint === 127) return false
  }
  return true
}

function wrapInputLines(line: string, cursor: number, width: number): { lines: string[]; cursorRow: number; cursorColumn: number } {
  const lines: string[] = ['']
  let currentWidth = 0
  let cursorRow = 0
  let cursorColumn = 0
  const clampedCursor = Math.max(0, Math.min(cursor, line.length))

  for (let i = 0; i < line.length;) {
    if (i === clampedCursor) {
      cursorRow = lines.length - 1
      cursorColumn = currentWidth
    }
    const codePoint = line.codePointAt(i)!
    const char = String.fromCodePoint(codePoint)
    const charWidth = terminalWidth(char)
    if (currentWidth > 0 && currentWidth + charWidth > width) {
      lines.push('')
      currentWidth = 0
    }
    lines[lines.length - 1] += char
    currentWidth += charWidth
    i += codePoint > 0xffff ? 2 : 1
  }

  if (clampedCursor === line.length) {
    cursorRow = lines.length - 1
    cursorColumn = currentWidth
  }

  return { lines, cursorRow, cursorColumn }
}

function createInputViewport(line: string, cursor: number, width: number): { text: string; cursorColumn: number; truncated: boolean } {
  if (terminalWidth(line) <= width) {
    return {
      text: line,
      cursorColumn: terminalWidth(line.slice(0, cursor)),
      truncated: false,
    }
  }

  const beforeCursor = line.slice(0, cursor)
  const afterCursor = line.slice(cursor)
  const marker = '…'
  const markerWidth = terminalWidth(marker)
  const afterBudget = Math.min(terminalWidth(afterCursor), Math.max(0, Math.floor((width - markerWidth) / 3)))
  const visibleAfter = takeLeftByTerminalWidth(afterCursor, afterBudget)
  const beforeBudget = Math.max(0, width - markerWidth - terminalWidth(visibleAfter))
  const visibleBefore = takeRightByTerminalWidth(beforeCursor, beforeBudget)
  const text = `${marker}${visibleBefore}${visibleAfter}`

  return {
    text,
    cursorColumn: markerWidth + terminalWidth(visibleBefore),
    truncated: true,
  }
}

function getSuggestionTail(line: string, suggestion: string | undefined): string {
  if (!suggestion || !line || suggestion === line) return ''
  return suggestion.startsWith(line) ? suggestion.slice(line.length) : ''
}

function takeLeftByTerminalWidth(text: string, width: number): string {
  let result = ''
  let currentWidth = 0
  for (let i = 0; i < text.length; i++) {
    const codePoint = text.codePointAt(i)!
    const char = String.fromCodePoint(codePoint)
    const charWidth = terminalWidth(char)
    if (currentWidth + charWidth > width) break
    result += char
    currentWidth += charWidth
    if (codePoint > 0xffff) i++
  }
  return result
}

function takeRightByTerminalWidth(text: string, width: number): string {
  let result = ''
  let currentWidth = 0
  for (let i = text.length; i > 0;) {
    const codePoint = text.codePointAt(i - 1)!
    const charLength = codePoint >= 0xdc00 && codePoint <= 0xdfff && i >= 2 ? 2 : 1
    const start = i - charLength
    const char = text.slice(start, i)
    const charWidth = terminalWidth(char)
    if (currentWidth + charWidth > width) break
    result = char + result
    currentWidth += charWidth
    i = start
  }
  return result
}
