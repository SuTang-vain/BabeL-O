import chalk from 'chalk'
import type { ContextAnalysis } from '../runtime/contextAnalysis.js'
import { terminalWidth, visibleTerminalWidth, truncateToTerminalWidth } from './terminalWidth.js'
import { inputState } from './inputState.js'

type ContextUsageSegment = {
  marker: string
  label: string
  tokens: number
  color: (text: string) => string
  barChar: string
}

export type ContextViewState = {
  expanded: boolean
  scrollOffset: number
}

export function createContextViewState(): ContextViewState {
  return { expanded: false, scrollOffset: 0 }
}

export function renderContextView(
  analysis: ContextAnalysis,
  state: ContextViewState = createContextViewState(),
  options: { rows?: number; columns?: number } = {},
): string {
  const rows = Math.max(12, options.rows ?? process.stdout.rows ?? 24)
  const terminalColumns = Math.max(32, options.columns ?? process.stdout.columns ?? 80)
  const columns = Math.max(31, terminalColumns - 1)
  const bodyHeight = Math.max(1, rows - 4)
  const content = state.expanded
    ? formatContextViewExpanded(analysis, columns)
    : formatContextViewSummary(analysis, columns)
  const maxScrollOffset = Math.max(0, content.length - bodyHeight)
  const scrollOffset = Math.max(0, Math.min(state.scrollOffset, maxScrollOffset))
  const visible = content.slice(scrollOffset, scrollOffset + bodyHeight)
  const header = formatContextViewHeader(analysis, columns)
  const footer = formatContextViewFooter(state.expanded, scrollOffset, maxScrollOffset, columns)
  const output = [header, ...visible]
  while (output.length < rows - 1) output.push('')
  output.push(footer)
  return output.map(line => fitLine(line, columns)).join('\n')
}

export async function openContextView(analysis: ContextAnalysis): Promise<void> {
  const wasRaw = process.stdin.isTTY ? process.stdin.isRaw : false
  const dataListeners = process.stdin.listeners('data')
  const keypressListeners = process.stdin.listeners('keypress')
  process.stdin.removeAllListeners('data')
  process.stdin.removeAllListeners('keypress')
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true)
  }
  inputState.set('contextView')
  process.stdout.write('\x1b[?1049h\x1b[2J\x1b[H\x1b[?25l')

  return new Promise<void>(resolve => {
    const state = createContextViewState()
    let settled = false

    const redraw = () => {
      process.stdout.write('\x1b[H\x1b[2J')
      process.stdout.write(renderContextView(analysis, state))
    }

    const cleanup = () => {
      process.stdin.removeListener('data', onData)
      for (const listener of dataListeners) {
        process.stdin.on('data', listener as any)
      }
      for (const listener of keypressListeners) {
        process.stdin.on('keypress', listener as any)
      }
      if (inputState.current === 'contextView') {
        inputState.set('idle')
      }
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(wasRaw)
      }
      process.stdout.write('\x1b[?25h\x1b[?1049l')
    }

    const exit = () => {
      if (settled) return
      settled = true
      cleanup()
      resolve()
    }

    const scrollBy = (delta: number) => {
      const rows = Math.max(12, process.stdout.rows ?? 24)
      const contentLength = state.expanded
        ? formatContextViewExpanded(analysis, Math.max(31, (process.stdout.columns ?? 80) - 1)).length
        : formatContextViewSummary(analysis, Math.max(31, (process.stdout.columns ?? 80) - 1)).length
      const maxScrollOffset = Math.max(0, contentLength - Math.max(1, rows - 4))
      state.scrollOffset = Math.max(0, Math.min(maxScrollOffset, state.scrollOffset + delta))
      redraw()
    }

    const onData = (chunk: Buffer | string) => {
      if (settled) return
      const text = chunk.toString()
      const key = normalizeContextViewKey(text)
      if (key === 'exit') {
        exit()
        return
      }
      if (key === 'toggle') {
        state.expanded = !state.expanded
        state.scrollOffset = 0
        redraw()
        return
      }
      if (key === 'up') {
        scrollBy(-1)
        return
      }
      if (key === 'down') {
        scrollBy(1)
        return
      }
      if (key === 'page_up') {
        scrollBy(-Math.max(1, (process.stdout.rows ?? 24) - 5))
        return
      }
      if (key === 'page_down') {
        scrollBy(Math.max(1, (process.stdout.rows ?? 24) - 5))
      }
    }

    process.stdin.on('data', onData)
    redraw()
  })
}

export function formatContextAnalysis(analysis: ContextAnalysis): string {
  const maxTokens = Math.max(1, analysis.window.maxTokens)
  const usedTokens = Math.max(0, analysis.estimate.totalTokens)
  const availableTokens = Math.max(0, maxTokens - usedTokens)
  const compactBufferTokens = Math.max(0, maxTokens - analysis.window.compactThresholdTokens)
  const freeTokens = Math.max(0, availableTokens - compactBufferTokens)
  const segments = buildContextUsageSegments(analysis)
  const diagnosticRows = buildDiagnosticRows(analysis)
  const signalRows = analysis.diagnostics.signals.map(signal => {
    return `${formatSignalSeverity(signal.severity)} ${signal.message}`
  })
  const recommendationRows = analysis.recommendations.map(recommendation => `- ${recommendation}`)

  return [
    '',
    `${chalk.dim('⎿')}  ${chalk.bold('BABEL Context')}`,
    `   ${chalk.yellow(formatContextModelName(analysis.modelId))} · current context ${chalk.bold(formatTokenCompact(usedTokens))}/${formatTokenCompact(maxTokens)} (${formatPercent(usedTokens, maxTokens)}) · available ${formatTokenCompact(availableTokens)}`,
    `   ${formatContextUsageBar(segments, maxTokens)} ${formatPercent(usedTokens, maxTokens)} used`,
    '',
    `   ${chalk.bold('Current context by source')}`,
    ...segments.map(segment => `   ${contextSourceRow(segment, maxTokens)}`),
    '',
    `   ${chalk.bold('Diagnostics')}`,
    ...diagnosticRows.map(row => `   ${row}`),
    ...(signalRows.length > 0 ? ['', `   ${chalk.bold('Signals')}`, ...signalRows.map(row => `   ${row}`)] : []),
    '',
    `   ${chalk.bold('Recommendations')}`,
    ...recommendationRows.map(row => `   ${row}`),
    '',
    `   ${chalk.bold('Skills')} · ${chalk.cyan('/skills')}`,
    '',
  ].join('\n')
}

function formatContextViewHeader(analysis: ContextAnalysis, columns: number): string {
  const title = ` BABEL Context · ${formatContextModelName(analysis.modelId)} `
  return chalk.inverse(fitLine(title, columns))
}

function formatContextViewFooter(expanded: boolean, scrollOffset: number, maxScrollOffset: number, columns: number): string {
  const details = expanded ? 'details on' : 'details off'
  const scroll = maxScrollOffset > 0 ? ` · ${scrollOffset + 1}/${maxScrollOffset + 1}` : ''
  const text = ` ctrl+o ${expanded ? 'hide diagnostics' : 'show diagnostics'} · esc exit · ${details}${scroll} `
  return chalk.inverse(fitLine(text, columns))
}

function formatContextViewSummary(analysis: ContextAnalysis, columns: number): string[] {
  const maxTokens = Math.max(1, analysis.window.maxTokens)
  const usedTokens = Math.max(0, analysis.estimate.totalTokens)
  const availableTokens = Math.max(0, maxTokens - usedTokens)
  const compactBufferTokens = Math.max(0, maxTokens - analysis.window.compactThresholdTokens)
  const freeTokens = Math.max(0, availableTokens - compactBufferTokens)
  const segments = buildContextUsageSegments(analysis)
  const lines = [
    '',
    centerText(chalk.bold('Current context'), columns),
    centerText(`${formatTokenCompact(usedTokens)}/${formatTokenCompact(maxTokens)} · ${formatPercent(usedTokens, maxTokens)} used · ${formatTokenCompact(availableTokens)} available`, columns),
    '',
    centerText(formatContextUsageBar(segments, maxTokens, Math.min(48, Math.max(24, columns - 12))), columns),
    '',
    sectionTitle('Current context by source'),
    ...segments.map(segment => `  ${contextSourceRow(segment, maxTokens)}`),
    '',
    sectionTitle('Capacity'),
    `  Remaining          ${formatTokenCount(analysis.diagnostics.remainingTokens)} (${analysis.diagnostics.remainingPercent}%)`,
    `  Compact headroom   ${formatTokenCount(analysis.diagnostics.compactRemainingTokens)}`,
    `  Blocking headroom  ${formatTokenCount(analysis.diagnostics.blockingRemainingTokens)}`,
    `  Autocompact buffer ${formatTokenCount(compactBufferTokens)}`,
    `  Free space         ${formatTokenCount(freeTokens)}`,
    '',
    sectionTitle('State'),
    `  Assembled events   selected=${analysis.sections.selectedEventCount} omitted=${analysis.sections.omittedEventCount} messages=${analysis.sections.messageCount}`,
    `  Compact boundary   ${analysis.compact.hasBoundary ? `yes · retained=${analysis.compact.retainedEventCount}` : 'none'}`,
    `  Recovery boundary  ${analysis.diagnostics.resumeRecovery.active ? chalk.yellow(analysis.diagnostics.resumeRecovery.code) : 'none'}`,
    '',
    chalk.dim('  Press ctrl+o to expand Diagnostics, Signals, Recommendations, and history-derived details.'),
    chalk.dim('  Press esc to return to the normal chat input box.'),
  ]
  return wrapLines(lines, columns)
}

function formatContextViewExpanded(analysis: ContextAnalysis, columns: number): string[] {
  const signalRows = analysis.diagnostics.signals.map(signal => `${formatSignalSeverity(signal.severity)} ${signal.message}`)
  const recommendationRows = analysis.recommendations.map(recommendation => `- ${recommendation}`)
  const lines = [
    ...formatContextViewSummary(analysis, columns).filter(line => !line.includes('Press ctrl+o') && !line.includes('Press esc')),
    '',
    sectionTitle('Diagnostics'),
    chalk.dim('  Diagnostics scan full session history; they are not always part of the current assembled context.'),
    ...buildDiagnosticRows(analysis).map(row => `  ${row}`),
    ...(signalRows.length > 0 ? ['', sectionTitle('Signals'), ...signalRows.map(row => `  ${row}`)] : []),
    '',
    sectionTitle('Recommendations'),
    ...recommendationRows.map(row => `  ${row}`),
    '',
    sectionTitle('Skills'),
    `  ${chalk.cyan('/skills')}`,
  ]
  return wrapLines(lines, columns)
}

function buildContextUsageSegments(analysis: ContextAnalysis): ContextUsageSegment[] {
  const maxTokens = Math.max(1, analysis.window.maxTokens)
  const usedTokens = Math.max(0, analysis.estimate.totalTokens)
  const availableTokens = Math.max(0, maxTokens - usedTokens)
  const compactBufferTokens = Math.max(0, maxTokens - analysis.window.compactThresholdTokens)
  const freeTokens = Math.max(0, availableTokens - compactBufferTokens)
  const activeSkillsTokens = estimateCharsAsTokens(analysis.sections.activeSkillsChars)
  const systemPromptTokens = Math.max(0, analysis.estimate.systemPromptTokens - activeSkillsTokens)
  return [
    { marker: '■', label: 'System prompt', tokens: systemPromptTokens, color: text => chalk.blue(text), barChar: '■' },
    { marker: '■', label: 'System tools', tokens: analysis.estimate.toolDefinitionTokens, color: text => chalk.magenta(text), barChar: '■' },
    { marker: '■', label: 'Skills', tokens: activeSkillsTokens, color: text => chalk.cyan(text), barChar: '■' },
    { marker: '■', label: 'Messages', tokens: analysis.estimate.messageTokens, color: text => chalk.green(text), barChar: '■' },
    { marker: '~', label: 'Autocompact buffer', tokens: compactBufferTokens, color: text => chalk.yellow(text), barChar: '■' },
    { marker: '□', label: 'Free space', tokens: freeTokens, color: text => chalk.dim(text), barChar: '□' },
  ]
}

function buildDiagnosticRows(analysis: ContextAnalysis): string[] {
  const usage = analysis.diagnostics.usageSummary
  const cache = analysis.diagnostics.cacheEconomics
  const diagnosticRows = [
    `remaining ${formatTokenCount(analysis.diagnostics.remainingTokens)} (${analysis.diagnostics.remainingPercent}%) · compact headroom ${formatTokenCount(analysis.diagnostics.compactRemainingTokens)} · blocking headroom ${formatTokenCount(analysis.diagnostics.blockingRemainingTokens)}`,
    `assembled events selected=${analysis.sections.selectedEventCount} omitted=${analysis.sections.omittedEventCount} snipped=${analysis.sections.snippedEventCount} microcompacted=${analysis.sections.microcompactedEventCount}`,
    `usage input=${formatTokenCompact(usage.inputTokens)} cached=${formatTokenCompact(usage.cacheReadInputTokens)} output=${formatTokenCompact(usage.outputTokens)} reasoning≈${formatTokenCompact(usage.estimatedReasoningTokens)}`,
    `cache policy read=${formatPercent(cache.cacheReadRatio, 1)} cacheable=${formatPercent(cache.cacheableSystemPromptRatio, 1)} · preserving=${yesNo(cache.cachePreservationMode)} long-context=${yesNo(cache.longContextUtilizationMode)} · ceiling ${formatTokenCompact(cache.effectiveContextCeiling)}/${formatTokenCompact(cache.legacyContextCeiling)} legacy`,
    `cache policy reason ${cache.reason}`,
    `microcompact saved≈${formatTokenCompact(analysis.sections.microcompactEstimatedTokensSaved)} tokens · duplicate results=${analysis.sections.microcompactDeduplicatedToolResultCount}`,
    `auto compact floor ${formatTokenCompact(analysis.diagnostics.autoCompactFloor.currentTokens)}/${formatTokenCompact(analysis.diagnostics.autoCompactFloor.thresholdTokens)} (${analysis.diagnostics.autoCompactFloor.thresholdPercent}%) · budget ${formatTokenCompact(analysis.diagnostics.autoCompactFloor.assemblyBudgetTokens)}`,
    `selection items retained=${analysis.diagnostics.selection.retained.length} dropped=${analysis.diagnostics.selection.dropped.length} · phases=${analysis.diagnostics.selection.phases.length}`,
  ]
  const fork = analysis.diagnostics.selection.fork
  if (fork) {
    diagnosticRows.push(`context fork mode=${fork.mode} inherited=${fork.inheritedItems} omitted=${fork.omittedItems}`)
  }
  const retainedItem = analysis.diagnostics.selection.retained[0]
  if (retainedItem) {
    diagnosticRows.push(`selection retained ${retainedItem.kind} · ${retainedItem.reason} · ${formatTokenCompact(retainedItem.estimatedTokens)} tokens`)
  }
  const droppedItem = analysis.diagnostics.selection.dropped[0]
  if (droppedItem) {
    diagnosticRows.push(`selection dropped ${droppedItem.kind} · ${droppedItem.reason} · ${formatTokenCompact(droppedItem.estimatedTokens)} tokens`)
  }
  if (analysis.diagnostics.autoCompact.fuseOpen) {
    diagnosticRows.push(`auto compact paused after ${analysis.diagnostics.autoCompact.failureCount}/${analysis.diagnostics.autoCompact.failureLimit} failures`)
  } else if (analysis.diagnostics.autoCompact.shouldCompact) {
    diagnosticRows.push(`auto compact threshold reached at ${analysis.diagnostics.autoCompact.thresholdPercent}%`)
  }
  if (analysis.diagnostics.compactRetention.hasBoundary) {
    diagnosticRows.push(`retained segment ${analysis.diagnostics.compactRetention.retainedSegmentValid ? 'valid' : 'fallback'} · events=${analysis.diagnostics.compactRetention.retainedEventCount}${analysis.diagnostics.compactRetention.retainedSegmentWarning ? ` · ${analysis.diagnostics.compactRetention.retainedSegmentWarning}` : ''}`)
  }
  if (analysis.diagnostics.compactTokenDelta.hasBoundary) {
    const delta = analysis.diagnostics.compactTokenDelta
    diagnosticRows.push(`compact delta events ${delta.beforeEventCount}→${delta.afterEventCount} · saved≈${formatTokenCompact(delta.estimatedTokensSaved)} tokens`)
  }
  if (analysis.diagnostics.workingSetPaths.length > 0) {
    const paths = analysis.diagnostics.workingSetPaths.slice(0, 3).map(entry => `${entry.path}×${entry.touches}`)
    diagnosticRows.push(`working set paths ${paths.join(', ')}`)
  }
  if (analysis.diagnostics.resumeRecovery.active) {
    diagnosticRows.push(`resume recovery boundary ${analysis.diagnostics.resumeRecovery.code} · ${analysis.diagnostics.resumeRecovery.message}`)
  }
  if (analysis.diagnostics.largeToolResults.length > 0) {
    const largest = analysis.diagnostics.largeToolResults[0]!
    diagnosticRows.push(`historical largest tool result ${largest.name} ${formatCharCount(largest.outputChars)} · ${largest.inputPreview}`)
  }
  if (analysis.diagnostics.repeatedToolInputs.length > 0) {
    const repeated = analysis.diagnostics.repeatedToolInputs[0]!
    diagnosticRows.push(`repeated tool input ${repeated.name} ×${repeated.count} · ${repeated.inputPreview}`)
  }
  if (analysis.diagnostics.memory.truncated || analysis.diagnostics.memory.pressurePercent >= 70) {
    diagnosticRows.push(`project memory ${formatCharCount(analysis.diagnostics.memory.projectMemoryChars)}/${formatCharCount(analysis.diagnostics.memory.projectMemoryBudgetChars)} (${analysis.diagnostics.memory.pressurePercent}%)${analysis.diagnostics.memory.truncated ? ' · truncated' : ''}`)
  }
  const sessionMemory = analysis.diagnostics.sessionMemoryLite
  const sessionMemoryLast = sessionMemory.lastUpdate
    ? `last ${sessionMemory.lastUpdate.trigger}/${sessionMemory.lastUpdate.reason || 'unknown'} ${formatCharCount(sessionMemory.lastUpdate.summaryChars)} events=${sessionMemory.lastUpdate.eventCount}`
    : 'last none'
  diagnosticRows.push(`session memory lite ${sessionMemory.enabled ? 'enabled' : 'disabled'} · ${sessionMemoryLast} · next=${sessionMemory.nextDecision.reason}${sessionMemory.nextDecision.shouldUpdate ? ' update' : ' skip'} · policy=${sessionMemory.costPolicy.summaryMode} max=${formatCharCount(sessionMemory.costPolicy.maxSummaryChars)}`)
  return diagnosticRows
}

export function normalizeContextViewKey(text: string): 'exit' | 'toggle' | 'up' | 'down' | 'page_up' | 'page_down' | 'none' {
  if (text === '\x1b' || text === '' || text === '' || text === 'q' || text === 'Q') return 'exit'
  if (text === '\x0f') return 'toggle'
  if (text === '\x1b[A') return 'up'
  if (text === '\x1b[B') return 'down'
  if (text === '\x1b[5~') return 'page_up'
  if (text === '\x1b[6~' || text === ' ') return 'page_down'
  return 'none'
}

function contextSourceRow(segment: ContextUsageSegment, maxTokens: number): string {
  return `${segment.color(segment.marker)} ${segment.label} · ${formatTokenCount(segment.tokens)} · ${formatPercent(segment.tokens, maxTokens)}`
}

function formatContextUsageBar(segments: ContextUsageSegment[], maxTokens: number, width = 36): string {
  const total = Math.max(1, maxTokens)
  const rawCounts = segments.map(segment => segment.tokens > 0 ? (segment.tokens / total) * width : 0)
  const counts = rawCounts.map(count => Math.floor(count))
  let remaining = width - counts.reduce((sum, count) => sum + count, 0)
  rawCounts
    .map((count, index) => ({ index, fraction: count - Math.floor(count) }))
    .sort((a, b) => b.fraction - a.fraction)
    .forEach(({ index }) => {
      if (remaining <= 0) return
      if (segments[index]!.tokens <= 0) return
      counts[index]! += 1
      remaining -= 1
    })
  for (let index = counts.length - 1; remaining < 0 && index >= 0; index -= 1) {
    const removable = Math.min(counts[index]!, -remaining)
    counts[index]! -= removable
    remaining += removable
  }
  const bar = segments
    .map((segment, index) => segment.color(segment.barChar.repeat(Math.max(0, counts[index]!))))
    .join('')
  return `[${bar}]`
}

function fitLine(line: string, columns: number): string {
  const width = Math.max(1, columns)
  if (visibleTerminalWidth(line) <= width) return line
  if (width === 1) return '…'
  const reset = line.includes('\x1b') ? '\x1b[0m' : ''
  return `${truncateAnsiToTerminalWidth(line, width - 1)}…${reset}`
}

function truncateAnsiToTerminalWidth(text: string, width: number): string {
  let output = ''
  let currentWidth = 0
  for (let index = 0; index < text.length;) {
    if (text[index] === '\x1b') {
      const match = text.slice(index).match(/^\x1b\[[0-9;?]*[ -/]*[@-~]/)
      if (match) {
        output += match[0]
        index += match[0].length
        continue
      }
    }
    const codePoint = text.codePointAt(index)!
    const char = String.fromCodePoint(codePoint)
    const charWidth = terminalWidth(char)
    if (currentWidth + charWidth > width) break
    output += char
    currentWidth += charWidth
    index += char.length
  }
  return output
}

function centerText(text: string, columns: number): string {
  const width = visibleTerminalWidth(text)
  if (width >= columns) return fitLine(text, columns)
  return `${' '.repeat(Math.floor((columns - width) / 2))}${text}`
}

function sectionTitle(title: string): string {
  return chalk.bold(title)
}

function wrapLines(lines: string[], columns: number): string[] {
  return lines.map(line => fitLine(line, columns))
}

function formatContextModelName(modelId: string): string {
  const [, name] = modelId.split('/')
  return name || modelId
}

function formatTokenCompact(tokens: number): string {
  if (tokens >= 1000) {
    const value = tokens / 1000
    return `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)}k`
  }
  return `${Math.round(tokens)}`
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1000) return `${formatTokenCompact(tokens)} tokens`
  return `${Math.round(tokens)} tokens`
}

function formatCharCount(chars: number): string {
  if (chars >= 1000) {
    const value = chars / 1000
    return `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)}k chars`
  }
  return `${Math.round(chars)} chars`
}

function formatSignalSeverity(severity: string): string {
  if (severity === 'critical') return chalk.red('critical')
  if (severity === 'warning') return chalk.yellow('warning')
  return chalk.dim('info')
}

function formatPercent(tokens: number, maxTokens: number): string {
  const percent = (tokens / Math.max(1, maxTokens)) * 100
  return `${percent >= 10 ? Math.round(percent) : Math.round(percent * 10) / 10}%`
}

function estimateCharsAsTokens(chars: number): number {
  return Math.max(0, Math.ceil(chars / 4))
}

function yesNo(value: unknown): string {
  return value ? 'yes' : 'no'
}
