import chalk from 'chalk'
import { terminalWidth, visibleTerminalWidth } from './terminalWidth.js'

export interface FixedInputBoxOptions {
  prompt: string
  line: string
  cursor: number
  suggestion?: string
  columns?: number
}

export interface FixedInputBoxRender {
  text: string
  cursorColumn: number
  contentWidth: number
  truncated: boolean
  renderedSuggestion: boolean
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
  const renderedSuggestion = canRenderSuggestion ? chalk.dim(suggestionTail) : ''

  return {
    text: `${options.prompt}${view.text}${renderedSuggestion}`,
    cursorColumn: promptWidth + view.cursorColumn,
    contentWidth,
    truncated: view.truncated,
    renderedSuggestion: canRenderSuggestion,
  }
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
