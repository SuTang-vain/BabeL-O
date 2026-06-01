import chalk from 'chalk'
import type { NexusEvent } from '../shared/events.js'
import type { NexusTask, TaskStatus } from '../shared/task.js'
import { renderDiff } from './diff.js'
import { renderMarkdown, containsMarkdown, formatToolOutputMarkdown, MarkdownStreamRenderer } from './markdown.js'
import { renderedLineCount, stripAnsi, terminalWidth, visibleTerminalWidth } from './terminalWidth.js'

let tuiMode: 'compact' | 'expanded' = 'compact'
let sessionEvents: NexusEvent[] = []
let printedLinesCount = 0
let currentLineLength = 0
let liveLineStarted = false
let liveToolLine: { toolUseId: string; renderedLineCount: number; printedLineDelta: number } | undefined
let currentOutputBlock: 'none' | 'assistant' | 'thinking' = 'none'

// Markdown streaming renderer for assistant output
const markdownRenderer = new MarkdownStreamRenderer()
let pendingMarkdownBuffer = ''

// Track active readline for prompt redraws
let activeReadlineInterface: any = null
let pendingPermissionRequest: NexusEvent | null = null

// Spinner / Agent status state
let spinnerTimer: NodeJS.Timeout | null = null
const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
let spinnerFrameIndex = 0
let isSpinnerActive = false
let spinnerRenderedLineCount = 0
let spinnerStatusText = 'Thinking...'
let spinnerStartedAt = 0
let activeSessionModel: string | undefined
let currentAgentStatus: 'thinking' | 'running_tool' | 'waiting_permission' | 'compacting' | 'retrying' | 'idle' = 'idle'
let currentToolName: string | undefined
let lastContextWarning: { percentUsed: number; tokenEstimate: number; maxTokens: number } | undefined
const inputPrompt = `${chalk.dim('>')} `
export const chatInputPlaceholder = 'Ask BabeL-O · / commands · Ctrl+E editor'
const toolPrefix = chalk.blue('●')
const thoughtPrefix = chalk.magenta('▸')
const compactBashOutputLineLimit = 3
const defaultBashTimeoutMs = 60_000

export function getTuiMode(): 'compact' | 'expanded' {
  return tuiMode
}

export function getSessionEvents(): NexusEvent[] {
  return sessionEvents
}

export function toggleTuiMode(): void {
  tuiMode = tuiMode === 'compact' ? 'expanded' : 'compact'
  redrawSession()
}

export function setActiveReadline(rl: any): void {
  activeReadlineInterface = rl
}

export function startSession(prompt?: string): void {
  stopSpinner()
  sessionEvents = []
  printedLinesCount = 0
  currentLineLength = 0
  liveLineStarted = false
  liveToolLine = undefined
  currentOutputBlock = 'none'
  pendingPermissionRequest = null
  activeSessionModel = undefined
  currentAgentStatus = 'idle'
  currentToolName = undefined
  lastContextWarning = undefined

  if (!prompt) {
    return
  }

  sessionEvents.push({
    type: 'user_message',
    schemaVersion: '2026-05-21.babel-o.v1',
    sessionId: '',
    timestamp: new Date().toISOString(),
    text: prompt,
  })

  const fullPromptText = `${chalk.cyan('bbl>')} ${prompt}`
  const columns = process.stdout.columns || 80
  printedLinesCount = renderedLineCount(fullPromptText + '\n', columns)
  currentLineLength = 0
}

export function resumeSessionHistory(events: NexusEvent[]): void {
  stopSpinner()
  sessionEvents = [...events]
  printedLinesCount = 0
  currentLineLength = 0
  liveLineStarted = false
  liveToolLine = undefined
  currentOutputBlock = 'none'
  pendingPermissionRequest = null
  activeSessionModel = events.findLast(e => e.type === 'session_started')?.model
  currentAgentStatus = 'idle'
  currentToolName = undefined
  lastContextWarning = events.findLast(e => e.type === 'context_warning') as { percentUsed: number; tokenEstimate: number; maxTokens: number } | undefined
  redrawSession()
}

export function startSpinner(text: string = 'Thinking...'): void {
  if (isSpinnerActive) {
    spinnerStatusText = text
    return
  }
  isSpinnerActive = true
  spinnerStatusText = text
  spinnerFrameIndex = 0
  spinnerStartedAt = Date.now()

  drawSpinnerLine()

  if (spinnerTimer) {
    clearInterval(spinnerTimer)
  }
  spinnerTimer = setInterval(() => {
    spinnerFrameIndex = (spinnerFrameIndex + 1) % spinnerFrames.length
    drawSpinnerLine()
  }, 100)
}

function setAgentStatus(status: typeof currentAgentStatus, toolName?: string) {
  currentAgentStatus = status
  currentToolName = toolName
}

function formatAgentStatusText(): string {
  switch (currentAgentStatus) {
    case 'thinking':
      return 'Thinking...'
    case 'running_tool':
      return currentToolName ? `Running ${currentToolName}...` : 'Running tool...'
    case 'waiting_permission':
      return 'Waiting for permission...'
    case 'compacting':
      return 'Compacting context...'
    case 'retrying':
      return 'Retrying...'
    default:
      return 'Thinking...'
  }
}

export function stopSpinner(): void {
  if (!isSpinnerActive) return
  if (spinnerTimer) {
    clearInterval(spinnerTimer)
    spinnerTimer = null
  }
  isSpinnerActive = false
  clearSpinnerLine()
}

function drawSpinnerLine() {
  if (spinnerRenderedLineCount > 0) {
    clearSpinnerLine()
  }
  const frame = spinnerFrames[spinnerFrameIndex]!
  const elapsed = spinnerStartedAt > 0 ? Math.floor((Date.now() - spinnerStartedAt) / 1000) : 0
  const elapsedText = elapsed > 0 ? ` ${elapsed}s` : ''

  const columns = process.stdout.columns || 80

  // Left status text
  const leftText = ` ${chalk.yellow(frame)} ${chalk.bold(spinnerStatusText)}${chalk.dim(elapsedText)}`

  // Model info
  const modelText = activeSessionModel ? ` ${chalk.cyan(activeSessionModel)} ` : ''

  // Context usage gauge
  let gaugeText = ''
  if (lastContextWarning) {
    const percent = Math.min(100, Math.max(0, Math.round(lastContextWarning.percentUsed || 0)))
    const barWidth = 10
    const filledCount = Math.round((percent / 100) * barWidth)
    const emptyCount = barWidth - filledCount

    let barColor = chalk.green
    if (percent > 80) barColor = chalk.red
    else if (percent > 60) barColor = chalk.yellow

    const filledStr = barColor('█'.repeat(filledCount))
    const emptyStr = chalk.dim('░'.repeat(emptyCount))

    gaugeText = ` [${filledStr}${emptyStr}] ${percent}%`
  } else {
    gaugeText = ` ${chalk.green('[Context: OK]')}`
  }

  // Right section
  const rightText = `${modelText}|${gaugeText} `

  // Combine with padding
  const leftLen = visibleTerminalWidth(leftText)
  const rightLen = visibleTerminalWidth(rightText)
  const paddingSize = Math.max(0, columns - leftLen - rightLen - 2)
  const padding = ' '.repeat(paddingSize)

  const renderedLine = `${leftText}${padding}${rightText}`
  process.stdout.write(`\r\x1b[K${renderedLine}`)
  spinnerRenderedLineCount = renderedLineCount(renderedLine, columns)
}

function clearSpinnerLine() {
  if (spinnerRenderedLineCount > 1) {
    process.stdout.write(`\r\x1b[K\x1b[${spinnerRenderedLineCount - 1}A\x1b[J`)
  } else {
    process.stdout.write('\r\x1b[K')
  }
  spinnerRenderedLineCount = 0
}

export function renderEventForTest(event: NexusEvent): void {
  renderEvent(event)
}

export function renderEvent(event: NexusEvent): void {
  if (event.type === 'user_message') {
    return
  }

  if (event.type === 'permission_request') {
    pendingPermissionRequest = event
  } else if (event.type === 'permission_response') {
    pendingPermissionRequest = null
  }

  // Direct streaming of assistant text for speed & responsiveness
  if (event.type === 'assistant_delta') {
    const last = sessionEvents[sessionEvents.length - 1]
    const continuesAssistant = last && last.type === 'assistant_delta'
    if (isWhitespaceOnlyAssistantDelta(event.text) && !continuesAssistant) {
      return
    }
    if (continuesAssistant) {
      last.text += event.text
    } else {
      sessionEvents.push({ ...event })
    }

    stopSpinner()
    handleAssistantDelta(event.text)
    return
  }

  // Direct streaming of thinking text in expanded mode, spinner in compact mode
  if (event.type === 'thinking_delta') {
    const last = sessionEvents[sessionEvents.length - 1]
    if (last && last.type === 'thinking_delta') {
      last.text += event.text
    } else {
      sessionEvents.push({ ...event })
    }

    if (tuiMode === 'expanded') {
      stopSpinner()
      handleThinkingDelta(event.text)
    } else {
      ensureLiveLine()
      startSpinner('Thinking...')
    }
    return
  }

  if (isCompactSilentEvent(event)) {
    sessionEvents.push(event)
    return
  }

  if (event.type === 'tool_started') {
    setAgentStatus('running_tool', event.name)
  } else if (event.type === 'tool_completed' || event.type === 'tool_denied') {
    currentAgentStatus = 'idle'
  } else if (event.type === 'permission_request') {
    setAgentStatus('waiting_permission')
  } else if (event.type === 'permission_response') {
    currentAgentStatus = 'idle'
  } else if (event.type === 'compact_boundary') {
    setAgentStatus('compacting')
  } else if (event.type === 'result' || event.type === 'error') {
    currentAgentStatus = 'idle'
  }

  sessionEvents.push(event)
  renderLiveEvent(event)
}

export function redrawSession(): void {
  clearPrintedLines()

  const columns = process.stdout.columns || 80
  const buffer = formatSessionHistory(sessionEvents, tuiMode)

  process.stdout.write(buffer)

  printedLinesCount = renderedLineCount(buffer, columns)

  const lastNewlineIdx = buffer.lastIndexOf('\n')
  const lastLine = lastNewlineIdx === -1 ? buffer : buffer.slice(lastNewlineIdx + 1)
  currentLineLength = visibleTerminalWidth(lastLine)

  if (isSpinnerActive) {
    drawSpinnerLine()
  }
}

function clearPrintedLines() {
  if (isSpinnerActive) {
    clearSpinnerLine()
  }
  if (printedLinesCount > 0) {
    process.stdout.write(`\x1b[${printedLinesCount}A\x1b[J`)
    printedLinesCount = 0
  }
}

function handleDelta(text: string, isThinking: boolean) {
  liveLineStarted = true
  if (isThinking) {
    process.stdout.write(chalk.dim(text))
  } else {
    process.stdout.write(text)
  }

  trackRenderedText(text)
}

function handleAssistantDelta(text: string) {
  if (isWhitespaceOnlyAssistantDelta(text) && currentOutputBlock !== 'assistant') {
    return
  }
  if (currentOutputBlock !== 'assistant') {
    ensureLiveLine()
    process.stdout.write(`${chalk.green('⏺')} `)
    liveLineStarted = true
    currentOutputBlock = 'assistant'
    // Reset markdown renderer on new block
    markdownRenderer.flush()
  }
  // Use markdown renderer for styled output
  const rendered = markdownRenderer.feed(text)
  process.stdout.write(rendered)

  trackRenderedText(rendered)
}

function isWhitespaceOnlyAssistantDelta(text: string): boolean {
  return text.length > 0 && text.trim().length === 0
}

function handleThinkingDelta(text: string) {
  if (currentOutputBlock !== 'thinking') {
    ensureLiveLine()
    process.stdout.write(`${thoughtPrefix} ${chalk.dim('Thought')}\n  `)
    liveLineStarted = true
    currentOutputBlock = 'thinking'
  }
  handleDelta(text, true)
}

function ensureLiveLine(): void {
  flushAssistantMarkdown()
  if (liveLineStarted && currentLineLength > 0) {
    process.stdout.write('\n')
    printedLinesCount++
    currentLineLength = 0
  }
  liveLineStarted = false
  liveToolLine = undefined
  currentOutputBlock = 'none'
}

function clearLiveToolLine(toolUseId: string): boolean {
  if (!liveToolLine || liveToolLine.toolUseId !== toolUseId) return false
  if (liveToolLine.renderedLineCount > 1) {
    process.stdout.write(`\r\x1b[K\x1b[${liveToolLine.renderedLineCount - 1}A\x1b[J`)
  } else {
    process.stdout.write('\r\x1b[K')
  }
  printedLinesCount = Math.max(0, printedLinesCount - liveToolLine.printedLineDelta)
  currentLineLength = 0
  liveLineStarted = false
  liveToolLine = undefined
  return true
}

function renderToolLine(text: string, toolUseId: string): void {
  const beforePrintedLines = printedLinesCount
  process.stdout.write(text)
  const columns = process.stdout.columns || 80
  trackRenderedText(text)
  liveToolLine = {
    toolUseId,
    renderedLineCount: renderedLineCount(text, columns),
    printedLineDelta: printedLinesCount - beforePrintedLines,
  }
  liveLineStarted = true
}

function flushAssistantMarkdown(): void {
  if (currentOutputBlock !== 'assistant') return
  const rendered = markdownRenderer.flush()
  if (!rendered) return
  process.stdout.write(rendered)
  trackRenderedText(rendered)
}

function trackRenderedText(text: string): void {
  const columns = process.stdout.columns || 80
  const cleanText = stripAnsi(text)
  const lines = cleanText.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) {
      printedLinesCount++
      currentLineLength = 0
    }
    currentLineLength += terminalWidth(lines[i]!)
    if (currentLineLength >= columns) {
      const wraps = Math.floor(currentLineLength / columns)
      printedLinesCount += wraps
      currentLineLength = currentLineLength % columns
    }
  }
}

function isCompactSilentEvent(event: NexusEvent): boolean {
  return tuiMode === 'compact' && (
    event.type === 'usage' ||
    event.type === 'hook_started' ||
    event.type === 'hook_completed' ||
    event.type === 'user_intake_guidance' ||
    event.type === 'execution_metrics' ||
    event.type === 'session_memory_updated'
  )
}

function renderLiveEvent(event: NexusEvent): void {
  stopSpinner()
  const replacedLiveToolLine = event.type === 'tool_completed' ? clearLiveToolLine(event.toolUseId) : false
  if (!replacedLiveToolLine) {
    ensureLiveLine()
  }

  switch (event.type) {
    case 'session_started':
      activeSessionModel = event.model
      console.log(formatAgentStatusLine(event))
      currentAgentStatus = 'thinking'
      break
    case 'tool_started': {
      renderToolLine(formatToolLiveLine({
        name: event.name,
        input: event.input,
        status: 'running',
      }), event.toolUseId)
      break
    }
    case 'tool_completed': {
      renderToolLine(formatToolLiveLine({
        name: event.name,
        input: findToolInput(event.toolUseId),
        status: event.success ? 'completed' : 'failed',
        output: event.output,
        truncated: event.truncated,
        originalBytes: event.originalBytes,
      }), event.toolUseId)
      if (event.truncated || (tuiMode === 'expanded' && event.output !== undefined)) {
        ensureLiveLine()
      }
      if (event.truncated) {
        console.log(chalk.yellow(`output truncated at ${event.originalBytes ?? 'unknown'} original bytes`))
      }
      if (tuiMode === 'expanded' && event.output !== undefined) {
        console.log(formatToolOutputMarkdown(String(event.output)))
      }
      break
    }
    case 'tool_denied':
      console.log(formatToolLiveLine({
        name: event.name,
        status: 'denied',
        risk: event.risk,
        denialMessage: event.message,
      }))
      break
    case 'permission_request':
      break
    case 'permission_response':
      if (!event.approved) {
        console.log(chalk.red(`✗ Permission denied${event.reason ? `: ${event.reason}` : ''}`))
      }
      break
    case 'error':
      console.log(chalk.red(`${event.code}: ${event.message}`))
      process.stdout.write(formatErrorRecoveryDetails(event.details))
      break
    case 'compact_boundary':
      console.log(
        chalk.cyan(
          `context compacted: ${event.beforeEventCount} -> ${event.afterEventCount} events (${event.summaryChars} chars summary)`,
        ),
      )
      if (event.summary) {
        console.log(chalk.dim(event.summary))
      }
      break
    case 'context_warning':
      lastContextWarning = { percentUsed: event.percentUsed, tokenEstimate: event.tokenEstimate, maxTokens: event.maxTokens }
      console.log(
        chalk.yellow(
          `context warning: ${event.percentUsed}% of window used (${event.tokenEstimate}/${event.maxTokens} tokens). consider /compact.`,
        ),
      )
      break
    case 'compact_failure':
      console.log(
        chalk.yellow(
          `context compact failed (${event.failureCount}/${event.maxFailures}): ${event.message}`,
        ),
      )
      break
    case 'result':
      if (!event.success) {
        console.log(chalk.red('✗ failed'))
      }
      console.log('')
      break
    case 'task_session_event':
      console.log(formatTaskSessionEvent(event))
      break
    case 'hook_started':
      if (tuiMode === 'expanded') {
        console.log(`${chalk.dim('◆')} hook ${chalk.dim(event.hookName)} started`)
      }
      break
    case 'hook_completed':
      if (tuiMode === 'expanded') {
        console.log(`${chalk.dim('◆')} hook ${chalk.dim(event.hookName)} completed`)
      }
      break
    case 'hook_failed':
      if (tuiMode === 'expanded') {
        console.log(`${chalk.red('◆')} hook ${chalk.dim(event.hookName)} failed: ${event.message}`)
      }
      break
    case 'usage':
      if (tuiMode === 'expanded') {
        console.log(chalk.dim(`usage input=${event.inputTokens} output=${event.outputTokens}`))
      }
      break
  }
}

function formatErrorRecoveryDetails(details: unknown): string {
  if (!details || typeof details !== 'object') return ''
  const record = details as Record<string, unknown>
  if (typeof record.recoveryReason !== 'string') return ''
  const parts = [
    `recovery=${record.recoveryReason}`,
    typeof record.kind === 'string' ? `kind=${record.kind}` : '',
    typeof record.httpStatus === 'number' ? `status=${record.httpStatus}` : '',
  ].filter(Boolean)
  const suggestion = typeof record.suggestion === 'string' ? ` ${record.suggestion}` : ''
  const fallbackPolicy = formatFallbackPolicy(record.fallbackPolicy)
  return chalk.yellow(`  ${parts.join(' ')}.${suggestion}${fallbackPolicy}\n`)
}

function formatFallbackPolicy(value: unknown): string {
  if (!value || typeof value !== 'object') return ''
  const policy = value as Record<string, unknown>
  if (typeof policy.mode !== 'string') return ''
  const nextAction = typeof policy.nextAction === 'string' ? ` next=${policy.nextAction}` : ''
  return ` fallback=${policy.mode} silentSwitch=false.${nextAction}`
}

interface ToolCallState {
  name: string
  input: any
  success?: boolean
  output?: any
  denied?: boolean
  truncated?: boolean
  originalBytes?: number
  risk?: string
  denialMessage?: string
  permissionRequest?: Extract<NexusEvent, { type: 'permission_request' }>
  permissionResponse?: Extract<NexusEvent, { type: 'permission_response' }>
  completed: boolean
}

export function formatSessionHistory(events: NexusEvent[], mode: 'compact' | 'expanded'): string {
  let outputText = ''

  const processedEvents: NexusEvent[] = []
  const ignorableTypes = new Set([
    'usage',
    'hook_started',
    'hook_completed',
    'user_intake_guidance',
    'execution_metrics',
  ])

  for (const ev of events) {
    if (ev.type === 'assistant_delta') {
      let foundIndex = -1
      for (let j = processedEvents.length - 1; j >= 0; j--) {
        const prev = processedEvents[j]!
        if (prev.type === 'assistant_delta') {
          foundIndex = j
          break
        }
        if (!ignorableTypes.has(prev.type)) {
          break
        }
      }
      if (foundIndex !== -1) {
        (processedEvents[foundIndex] as any).text += ev.text
        continue
      }
      if (isWhitespaceOnlyAssistantDelta(ev.text)) {
        continue
      }
    } else if (ev.type === 'thinking_delta') {
      let foundIndex = -1
      for (let j = processedEvents.length - 1; j >= 0; j--) {
        const prev = processedEvents[j]!
        if (prev.type === 'thinking_delta') {
          foundIndex = j
          break
        }
        if (!ignorableTypes.has(prev.type)) {
          break
        }
      }
      if (foundIndex !== -1) {
        (processedEvents[foundIndex] as any).text += ev.text
        continue
      }
    }
    processedEvents.push({ ...ev })
  }

  const toolsMap = new Map<string, ToolCallState>()
  for (const ev of processedEvents) {
    if (ev.type === 'tool_started') {
      toolsMap.set(ev.toolUseId, {
        name: ev.name,
        input: ev.input,
        completed: false,
      })
    } else if (ev.type === 'tool_completed') {
      const state = toolsMap.get(ev.toolUseId)
      if (state) {
        state.completed = true
        state.success = ev.success
        state.output = ev.output
        state.truncated = ev.truncated
        state.originalBytes = ev.originalBytes
      }
    } else if (ev.type === 'tool_denied') {
      const state = findLatestIncompleteTool(toolsMap, ev.name)
      if (state) {
        state.completed = true
        state.denied = true
        state.risk = ev.risk
        state.denialMessage = ev.message
      }
    } else if (ev.type === 'permission_request') {
      const state = toolsMap.get(ev.toolUseId)
      if (state) {
        state.permissionRequest = ev
      }
    } else if (ev.type === 'permission_response') {
      const state = toolsMap.get(ev.toolUseId)
      if (state) {
        state.permissionResponse = ev
      }
    }
  }

  for (const ev of processedEvents) {
    switch (ev.type) {
      case 'session_started':
        outputText += `${formatAgentStatusLine(ev)}\n`
        break

      case 'user_message':
        outputText += `${formatUserPrompt(ev.text)}\n`
        break

      case 'assistant_delta': {
        // Render assistant text with markdown if it contains formatting
        if (containsMarkdown(ev.text)) {
          outputText += `${chalk.green('⏺')} \n${renderMarkdown(ev.text)}\n`
        } else {
          outputText += `${chalk.green('⏺')} ${ev.text}\n`
        }
        break
      }

      case 'thinking_delta':
        if (mode === 'expanded') {
          outputText += `${thoughtPrefix} ${chalk.dim('Thought')}\n  ${chalk.dim(ev.text)}\n`
        }
        break

      case 'tool_started': {
        const state = toolsMap.get(ev.toolUseId)
        if (!state) break

        const formattedInput = formatToolInput(state.name, state.input)

        if (mode === 'compact') {
          outputText += formatToolHistoryLine(state, formattedInput) + '\n'
        } else {
          outputText += formatExpandedToolDetails(state) + '\n'
        }
        break
      }

      case 'permission_request': {
        if (mode === 'compact') {
          outputText += chalk.bold.yellow(`? Permission requested for ${ev.name} (${ev.risk} risk)\n`)
        }
        break
      }

      case 'permission_response': {
        if (mode === 'compact' && !ev.approved) {
          outputText += chalk.red(`✗ Permission denied\n`)
        }
        break
      }

      case 'error':
        outputText += chalk.red(`${ev.code}: ${ev.message}\n`)
        outputText += formatErrorRecoveryDetails(ev.details)
        break

      case 'compact_boundary':
        outputText += chalk.cyan(
          `context compacted: ${ev.beforeEventCount} -> ${ev.afterEventCount} events (${ev.summaryChars} chars summary)\n`,
        )
        if (ev.summary) {
          outputText += chalk.dim(`${ev.summary}\n`)
        }
        break

      case 'context_warning':
        outputText += chalk.yellow(
          `context warning: ${ev.percentUsed}% of window used (${ev.tokenEstimate}/${ev.maxTokens} tokens). consider /compact.\n`,
        )
        break

      case 'compact_failure':
        outputText += chalk.yellow(
          `context compact failed (${ev.failureCount}/${ev.maxFailures}): ${ev.message}\n`,
        )
        break

      case 'tool_denied': {
        if (isDeniedToolAlreadyRendered(toolsMap, ev.name, ev.message)) break
        if (mode === 'compact') {
          outputText += `${chalk.red('●')} ${ev.name} denied (${ev.risk} risk) - ${ev.message}\n`
        } else {
          outputText += `${chalk.red(`! ${ev.name} denied`)}\n`
          outputText += `  Risk: ${ev.risk}\n`
          outputText += `  Message: ${ev.message}\n`
        }
        break
      }

      case 'result':
        if (!ev.success) outputText += chalk.red('✗ failed\n')
        break

      case 'task_session_event':
        outputText += `${formatTaskSessionEvent(ev)}\n`
        break

      case 'usage':
        break
    }
  }

  outputText += formatTaskStatusPanel(events)
  outputText += formatAgentRunningFooter()
  outputText += formatContextFooter()

  if (pendingPermissionRequest) {
    const inputSoFar = activeReadlineInterface ? activeReadlineInterface.line : ''
    const tool = 'name' in pendingPermissionRequest ? pendingPermissionRequest.name : 'tool'
    const risk = 'risk' in pendingPermissionRequest ? ` (${pendingPermissionRequest.risk} risk)` : ''
    outputText += chalk.yellow(`Approve ${tool}${risk}? [y/N] `) + inputSoFar
  }

  return outputText
}

function formatAgentRunningFooter(): string {
  if (currentAgentStatus === 'idle') return ''
  const statusText = formatAgentStatusText()
  return `${chalk.dim('─'.repeat(20))}\n${chalk.yellow('◉')} ${chalk.dim(statusText)}\n`
}

function formatContextFooter(): string {
  if (!lastContextWarning) return ''
  const { percentUsed, tokenEstimate, maxTokens } = lastContextWarning
  const barWidth = 20
  const filled = Math.min(barWidth, Math.round((percentUsed / 100) * barWidth))
  const bar = chalk.green('█'.repeat(filled)) + chalk.dim('░'.repeat(barWidth - filled))
  return `${chalk.dim('context')} ${bar} ${chalk.yellow(`${percentUsed}%`)} ${chalk.dim(`(${tokenEstimate}/${maxTokens})`)} ${chalk.cyan('/compact')}\n`
}

type TaskBoardItem = {
  taskId?: string
  title: string
  status: TaskStatus
  parentTaskId?: string
  depth: number
  delegatedSubTaskIds?: string[]
  worktree?: boolean
  subSessionId?: string
}

export function formatTaskStatusPanel(events: NexusEvent[]): string {
  const tasks: TaskBoardItem[] = []
  const taskIdToTitle = new Map<string, string>()

  for (const ev of events) {
    if (ev.type === 'task_created') {
      const title = ev.title
      const taskId = ev.taskId
      const existing = tasks.find(t => t.title === title || t.taskId === taskId)
      if (existing) {
        existing.taskId = taskId
      } else {
        tasks.push({ taskId, title, status: 'pending', depth: 0 })
      }
      taskIdToTitle.set(taskId, title)
    } else if (ev.type === 'task_session_event') {
      interface TaskSessionPayload {
        plannerOutput?: {
          tasks?: Array<{ title?: string; description?: string }>
        }
        task?: NexusTask
        parentTask?: NexusTask
        subTasks?: NexusTask[]
        taskId?: string
        title?: string
        approved?: boolean
      }
      const payload = ev.payload as TaskSessionPayload | undefined
      if (payload?.task) upsertTaskBoardItem(tasks, taskIdToTitle, payload.task)

      if (ev.eventType === 'planner_completed') {
        const plannerOutput = payload?.plannerOutput
        if (plannerOutput && Array.isArray(plannerOutput.tasks)) {
          for (const t of plannerOutput.tasks) {
            if (t && t.title) {
              if (!tasks.some(existing => existing.title === t.title)) {
                tasks.push({ title: t.title, status: 'pending', depth: 0 })
              }
            }
          }
        }
      } else if (ev.eventType === 'planner_review_approved') {
        const approvedTasks = Array.isArray((payload as any)?.tasks) ? (payload as any).tasks : []
        for (const task of approvedTasks) {
          if (task && typeof task.title === 'string' && !tasks.some(existing => existing.title === task.title)) {
            tasks.push({ title: task.title, status: 'pending', depth: 0 })
          }
        }
      } else if (ev.eventType === 'subtasks_delegated') {
        if (payload?.parentTask) upsertTaskBoardItem(tasks, taskIdToTitle, payload.parentTask)
        if (Array.isArray(payload?.subTasks)) {
          for (const subTask of payload.subTasks) upsertTaskBoardItem(tasks, taskIdToTitle, subTask)
        }
      } else if (ev.eventType === 'task_claimed') {
        if (payload?.task) {
          upsertTaskBoardItem(tasks, taskIdToTitle, { ...payload.task, status: 'in_progress' })
        } else if (payload && payload.taskId) {
          taskIdToTitle.set(payload.taskId, payload.title || '')
          let task = tasks.find(t => t.title === payload.title || t.taskId === payload.taskId)
          if (!task) {
            task = { taskId: payload.taskId, title: payload.title || '', status: 'in_progress', depth: 0 }
            tasks.push(task)
          } else {
            task.taskId = payload.taskId
            task.status = 'in_progress'
          }
        }
      } else if (ev.eventType === 'task_blocked') {
        if (payload?.task) upsertTaskBoardItem(tasks, taskIdToTitle, { ...payload.task, status: 'blocked' })
      } else if (ev.eventType === 'task_completed' || ev.eventType === 'task_updated' || ev.eventType === 'task_created') {
        if (payload?.task) upsertTaskBoardItem(tasks, taskIdToTitle, payload.task)
      } else if (ev.eventType === 'critic_completed') {
        if (payload && payload.taskId) {
          const title = taskIdToTitle.get(payload.taskId)
          const task = tasks.find(t => t.taskId === payload.taskId || (title && t.title === title))
          if (task) {
            task.status = payload.approved ? 'completed' : 'pending'
          }
        }
      } else if (ev.eventType === 'executor_failed_error' || ev.eventType === 'critic_failed_error') {
        if (payload && payload.taskId) {
          const title = taskIdToTitle.get(payload.taskId)
          const task = tasks.find(t => t.taskId === payload.taskId || (title && t.title === title))
          if (task) {
            task.status = 'pending'
          }
        }
      } else if (ev.eventType === 'sub_agent_session_started') {
        const payload = ev.payload as { taskId?: string; subSessionId?: string; title?: string } | undefined
        if (payload?.taskId) {
          const task = tasks.find(t => t.taskId === payload.taskId)
          if (task) {
            task.subSessionId = payload.subSessionId
          }
        }
      } else if (ev.eventType === 'sub_agent_session_completed') {
        const payload = ev.payload as { taskId?: string } | undefined
        if (payload?.taskId) {
          const task = tasks.find(t => t.taskId === payload.taskId)
          if (task && task.status !== 'completed') {
            task.status = 'completed'
          }
        }
      } else if (ev.eventType === 'sub_agent_session_failed' || ev.eventType === 'sub_agent_session_error') {
        const payload = ev.payload as { taskId?: string } | undefined
        if (payload?.taskId) {
          const task = tasks.find(t => t.taskId === payload.taskId)
          if (task && task.status !== 'completed') {
            task.status = 'failed'
          }
        }
      } else if (ev.eventType === 'task_session_failed') {
        for (const t of tasks) {
          if (t.status !== 'completed') {
            t.status = 'failed'
          }
        }
      } else if (ev.eventType === 'session_completed_success') {
        for (const t of tasks) {
          t.status = 'completed'
        }
      }
    } else if (ev.type === 'tool_completed' && ev.name === 'TaskCreate') {
      const output = ev.output as { title?: string } | undefined
      if (output && output.title) {
        const existing = tasks.find(t => t.title === output.title)
        if (!existing) {
          tasks.push({ title: output.title, status: 'completed', depth: 0 })
        } else {
          existing.status = 'completed'
        }
      }
    }
  }

  if (tasks.length === 0) return ''

  const width = Math.max(70, ...tasks.map(t => {
    const depth = Math.max(0, t.depth)
    const suffixLen = t.taskId ? t.taskId.length + 15 : 0
    return t.title.length + depth * 3 + suffixLen + 20
  }))

  const boxTop = chalk.cyan('┌' + '─'.repeat(width) + '┐')
  const boxBottom = chalk.cyan('└' + '─'.repeat(width) + '┘')
  const titleStr = ' ❖ Task Status Board '
  const headerPadding = '─'.repeat(Math.max(0, width - titleStr.length))
  let panel = `\n  ${chalk.cyan(`┌${titleStr}${headerPadding}┐`)}\n`

  for (let idx = 0; idx < tasks.length; idx++) {
    const t = tasks[idx]!
    let coloredStatus = ''
    switch (t.status) {
      case 'pending':
        coloredStatus = chalk.yellow('⟳ 规划中')
        break
      case 'in_progress':
        coloredStatus = chalk.cyan('▶ 执行中')
        break
      case 'blocked':
        coloredStatus = chalk.magenta('Ⅱ 等待子任务')
        break
      case 'completed':
        coloredStatus = chalk.green('✓ 已完成')
        break
      case 'failed':
        coloredStatus = chalk.red('✗ 已失败')
        break
      case 'cancelled':
        coloredStatus = chalk.red('✗ 已取消')
        break
    }

    const depth = Math.max(0, t.depth)
    let treePrefix = ''
    if (depth > 0) {
      for (let d = 0; d < depth - 1; d++) {
        treePrefix += '│  '
      }
      const hasSibling = tasks.slice(idx + 1).some(sibling => sibling.depth === depth && sibling.parentTaskId === t.parentTaskId)
      treePrefix += hasSibling ? '├─ ' : '└─ '
    }

    const meta: string[] = []
    if (t.taskId) meta.push(`#${t.taskId}`)
    if (t.parentTaskId) meta.push(`parent #${t.parentTaskId}`)
    if (t.delegatedSubTaskIds?.length) meta.push(`delegated ${t.delegatedSubTaskIds.map(id => `#${id}`).join(',')}`)
    if (t.worktree) meta.push('worktree')
    if (t.subSessionId) meta.push(`sub=${shortSessionId(t.subSessionId)}`)
    const suffix = meta.length > 0 ? chalk.dim(` (${meta.join(' · ')})`) : ''

    const content = `  ${treePrefix}${coloredStatus}  ${t.title}${suffix}`
    const visibleLength = visibleTerminalWidth(content)
    const padding = ' '.repeat(Math.max(0, width - visibleLength))
    panel += `  ${chalk.cyan('│')}${content}${padding}${chalk.cyan('│')}\n`
  }

  panel += `  ${boxBottom}\n`
  return panel
}

function upsertTaskBoardItem(
  tasks: TaskBoardItem[],
  taskIdToTitle: Map<string, string>,
  task: NexusTask,
) {
  taskIdToTitle.set(task.taskId, task.title)
  const existing = tasks.find(item => item.taskId === task.taskId || item.title === task.title)
  const next: TaskBoardItem = {
    taskId: task.taskId,
    title: task.title,
    status: task.status,
    parentTaskId: typeof task.metadata?.parentTaskId === 'string' ? task.metadata.parentTaskId : undefined,
    depth: typeof task.metadata?.depth === 'number' ? task.metadata.depth : 0,
    delegatedSubTaskIds: Array.isArray(task.metadata?.delegatedSubTaskIds)
      ? task.metadata.delegatedSubTaskIds.filter(id => typeof id === 'string')
      : undefined,
    worktree: task.metadata?.requiresIsolation === true || typeof task.metadata?.worktreePath === 'string',
    subSessionId: typeof task.metadata?.subSessionId === 'string' ? task.metadata.subSessionId : undefined,
  }
  if (!existing) {
    tasks.push(next)
    return
  }
  Object.assign(existing, next)
}

function findLatestIncompleteTool(toolsMap: Map<string, ToolCallState>, name: string): ToolCallState | undefined {
  return [...toolsMap.values()].findLast(state => state.name === name && !state.completed)
}

function isDeniedToolAlreadyRendered(toolsMap: Map<string, ToolCallState>, name: string, message: string): boolean {
  return [...toolsMap.values()].some(state => state.name === name && state.denied && state.denialMessage === message)
}

function formatAgentStatusLine(event: Extract<NexusEvent, { type: 'session_started' }>): string {
  const model = event.model ?? activeSessionModel ?? 'local/coding-runtime'
  return `${chalk.dim('agent')} ${chalk.cyan(shortSessionId(event.sessionId))} ${chalk.dim('model')} ${chalk.yellow(truncateMiddle(model, 32))}`
}

function formatUserPrompt(text: string): string {
  return `${inputPrompt}${text}`
}

function formatToolHeader(state: ToolCallState): string {
  const label = formatToolCallLabel(state.name, state.input)
  if (state.denied) return chalk.red(`! ${label} denied`)
  if (state.success) return chalk.green(`✓ ${label}`)
  return chalk.red(`✗ ${label}`)
}

function formatToolHistoryLine(state: ToolCallState, formattedInput: string): string {
  const label = formatToolCallName(state.name, formattedInput)
  if (!state.completed) {
    return `${toolPrefix} ${chalk.bold(label)}`
  }
  if (state.denied) {
    return `${chalk.red('●')} ${chalk.bold(label)} ${chalk.red('denied')} ${chalk.dim(state.risk ? `${state.risk} risk` : '')}`
  }
  const status = state.success ? '' : ` ${chalk.red('failed')}`
  const truncated = state.truncated ? ` ${chalk.yellow('truncated')}` : ''
  return `${toolPrefix} ${chalk.bold(label)}${status}${truncated}${formatCompactToolOutputPreview(state.name, state.output, state.input)}`
}

function formatExpandedToolDetails(state: ToolCallState): string {
  const label = formatToolCallLabel(state.name, state.input)
  const header = state.completed ? formatToolHeader(state) : chalk.cyan(`● ${label}`)
  const lines = [header]
  lines.push(`${chalk.dim('  Input')}:`)
  lines.push(indentBlock(formatOutput(state.input), '    '))

  if (state.permissionRequest || state.permissionResponse) {
    lines.push(formatExpandedPermissionDetails(state))
  }

  if (!state.completed) return lines.join('\n')

  if (state.denied) {
    lines.push(`${chalk.red('  Denied')}: ${state.risk ?? state.permissionRequest?.risk ?? 'unknown'} risk`)
    if (state.denialMessage) lines.push(`${chalk.dim('  Message')}: ${state.denialMessage}`)
    return lines.join('\n')
  }

  lines.push(`${chalk.dim('  Status')}: ${state.success ? chalk.green('success') : chalk.red('failed')}`)
  if (state.truncated) {
    lines.push(`${chalk.yellow('  Output truncated')}: ${state.originalBytes ?? 'unknown'} original bytes`)
  }
  if (state.success && (state.name === 'Edit' || state.name === 'Write')) {
    const diffText = renderDiff(state.name, state.input)
    if (diffText) lines.push(diffText.trimEnd())
  }
  if (state.output !== undefined) {
    lines.push(`${chalk.dim('  Output')}:`)
    lines.push(indentBlock(formatOutput(state.output), '    '))
  }
  return lines.join('\n')
}

function formatExpandedPermissionDetails(state: ToolCallState): string {
  const request = state.permissionRequest
  const response = state.permissionResponse
  const risk = request?.risk ? ` (${request.risk} risk)` : ''
  const status = response
    ? response.approved ? chalk.green('approved') : chalk.red('denied')
    : chalk.yellow('requested')
  const reason = response?.reason ? `: ${response.reason}` : ''
  return `${chalk.dim('  Permission')}: ${status}${risk}${reason}`
}

function indentBlock(text: string, prefix: string): string {
  if (!text) return `${prefix}(empty)`
  return text.split('\n').map(line => `${prefix}${line}`).join('\n')
}

function formatToolLiveLine(options: {
  name: string
  input?: unknown
  status: 'running' | 'completed' | 'failed' | 'denied'
  output?: unknown
  risk?: string
  denialMessage?: string
  truncated?: boolean
  originalBytes?: number
}): string {
  const formattedInput = formatToolInput(options.name, options.input)
  const label = formatToolCallName(options.name, formattedInput)
  if (options.status === 'running') {
    return `${toolPrefix} ${chalk.bold(label)}`
  }
  if (options.status === 'denied') {
    return `${chalk.red('●')} ${chalk.bold(label)} ${chalk.red('denied')} ${chalk.dim(options.risk ? `${options.risk} risk` : '')} ${options.denialMessage ?? ''}`.trimEnd()
  }
  const status = options.status === 'completed' ? '' : ` ${chalk.red('failed')}`
  const truncated = options.truncated ? ` ${chalk.yellow(`truncated ${options.originalBytes ?? 'unknown'}b`)}` : ''
  return `${toolPrefix} ${chalk.bold(label)}${status}${truncated}${formatCompactToolOutputPreview(options.name, options.output, options.input)}`
}

function formatCompactToolOutputPreview(name: string, output: unknown, input?: unknown): string {
  if (name !== 'Bash' || output === undefined) return ''
  const summary = getBashOutputSummary(output)
  if (!summary.text) return ''

  const lines = summary.text.split('\n')
  const previewLines = lines.slice(0, compactBashOutputLineLimit)
  const hiddenLineCount = Math.max(0, lines.length - previewLines.length)
  const renderedLines = previewLines.map(line => `${chalk.dim('  ⎿')}  ${line}`)
  const meta: string[] = []
  if (hiddenLineCount > 0) meta.push(`+${hiddenLineCount} lines`)
  if (summary.exitCode !== undefined && summary.exitCode !== 0) meta.push(`exit ${summary.exitCode}`)
  if (meta.length > 0) renderedLines.push(`${chalk.dim('  ⎿')}  ${chalk.dim(`… ${meta.join(', ')} (ctrl+o to expand)`)}`)
  const timeoutMs = getBashTimeoutMs(input)
  if (timeoutMs && timeoutMs !== defaultBashTimeoutMs) renderedLines.push(`${chalk.dim('  ⎿')}  ${chalk.dim(`(timeout ${formatDuration(timeoutMs)})`)}`)
  return `\n${renderedLines.join('\n')}`
}

function getBashOutputSummary(output: unknown): { text: string; exitCode?: number } {
  if (typeof output === 'string') return { text: output.trimEnd() }
  if (!output || typeof output !== 'object') return { text: '' }
  const record = output as Record<string, unknown>
  const pieces: string[] = []
  if (typeof record.stdout === 'string' && record.stdout.trimEnd()) pieces.push(record.stdout.trimEnd())
  if (typeof record.stderr === 'string' && record.stderr.trimEnd()) pieces.push(record.stderr.trimEnd())
  if (pieces.length === 0 && typeof record.message === 'string') pieces.push(record.message)
  return {
    text: pieces.join('\n').trimEnd(),
    exitCode: typeof record.exitCode === 'number' ? record.exitCode : undefined,
  }
}

function getBashTimeoutMs(input: unknown): number | undefined {
  if (!input || typeof input !== 'object') return undefined
  const value = (input as Record<string, unknown>).timeoutMs
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function formatDuration(ms: number): string {
  if (ms % 60000 === 0) return `${ms / 60000}m`
  if (ms % 1000 === 0) return `${ms / 1000}s`
  return `${ms}ms`
}

function formatTaskSessionEvent(event: Extract<NexusEvent, { type: 'task_session_event' }>): string {
  const label = event.eventType.replace(/_/g, ' ')
  const phase = chalk.dim(event.phase)
  const payload = summarizePayload(event.payload)
  return `${chalk.magenta('agent')} ${phase} ${label}${payload ? ` ${chalk.dim(payload)}` : ''}`
}

function summarizePayload(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  const record = payload as Record<string, unknown>
  const diagnostics = record.diagnostics
  if (diagnostics && typeof diagnostics === 'object') {
    const summary = diagnostics as Record<string, unknown>
    const structuredOutput = summary.structuredOutput && typeof summary.structuredOutput === 'object'
      ? summary.structuredOutput as Record<string, unknown>
      : undefined
    const pieces = [
      typeof structuredOutput?.failureType === 'string' ? `structured=${structuredOutput.failureType}` : '',
      Array.isArray(structuredOutput?.missingRequiredKeys) && structuredOutput.missingRequiredKeys.length > 0
        ? `missing=${structuredOutput.missingRequiredKeys.join(',')}`
        : '',
      Array.isArray(structuredOutput?.candidateSources) && structuredOutput.candidateSources.length > 0
        ? `sources=${structuredOutput.candidateSources.join(',')}`
        : '',
      typeof record.error === 'string' ? record.error : '',
      typeof summary.errorCode === 'string' ? summary.errorCode : '',
      typeof summary.errorMessage === 'string' ? summary.errorMessage : '',
      typeof summary.resultMessage === 'string' ? summary.resultMessage : '',
      typeof summary.lastToolName === 'string' ? `lastTool=${summary.lastToolName}` : '',
      typeof summary.lastToolOutputPreview === 'string' ? summary.lastToolOutputPreview : '',
      typeof structuredOutput?.assistantTextPreview === 'string' ? structuredOutput.assistantTextPreview : '',
    ].filter(Boolean)
    if (pieces.length > 0) return truncateMiddle(pieces.join(' | '), 240)
  }
  const task = record.task
  if (task && typeof task === 'object') {
    const taskRecord = task as Record<string, unknown>
    if (typeof taskRecord.title === 'string') {
      return truncateMiddle(`${typeof taskRecord.status === 'string' ? `${taskRecord.status} ` : ''}${taskRecord.title}`, 120)
    }
    if (typeof taskRecord.taskId === 'string') return taskRecord.taskId
  }
  const tasks = record.tasks
  if (Array.isArray(tasks)) {
    const firstTask = tasks.find(item => item && typeof item === 'object') as Record<string, unknown> | undefined
    if (!firstTask) return '0 tasks'
    const suffix = tasks.length > 1 ? ` +${tasks.length - 1} more` : ''
    const title = typeof firstTask.title === 'string' ? firstTask.title : String(firstTask.taskId ?? 'task')
    return truncateMiddle(`${tasks.length} task${tasks.length === 1 ? '' : 's'}: ${typeof firstTask.status === 'string' ? `${firstTask.status} ` : ''}${title}${suffix}`, 120)
  }
  if (typeof record.error === 'string') return truncateMiddle(record.error, 120)
  if (typeof record.title === 'string') return record.title
  if (typeof record.taskId === 'string') return record.taskId
  if (typeof record.reason === 'string') return record.reason
  return ''
}

function findToolInput(toolUseId: string): unknown {
  for (let i = sessionEvents.length - 1; i >= 0; i--) {
    const event = sessionEvents[i]!
    if (event.type === 'tool_started' && event.toolUseId === toolUseId) {
      return event.input
    }
  }
  return undefined
}

function formatToolInput(name: string, input: any): string {
  if (input === undefined || input === null) return ''
  const record = typeof input === 'object' ? input as Record<string, unknown> : undefined

  if (name === 'Read') {
    return firstString(record, ['path', 'file_path', 'filePath'])
  }
  if (name === 'Write' || name === 'Edit') {
    return firstString(record, ['path', 'file_path', 'filePath'])
  }
  if (name === 'Glob' || name === 'Grep') {
    return firstString(record, ['pattern', 'Pattern', 'path', 'directory', 'DirectoryPath'])
  }
  if (name === 'ListDir') {
    return firstString(record, ['DirectoryPath', 'path', 'directory'])
  }
  if (name === 'Bash') {
    return firstString(record, ['command', 'CommandLine'])
  }
  if (name === 'TaskCreate') {
    return firstString(record, ['title'])
  }

  if (typeof input === 'string') return input
  return firstString(record, ['path', 'file_path', 'filePath', 'command', 'CommandLine'])
}

function firstString(record: Record<string, unknown> | undefined, keys: string[]): string {
  if (!record) return ''
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.length > 0) {
      return truncateMiddle(value, 96)
    }
  }
  return ''
}

function formatToolCallName(name: string, formattedInput: string): string {
  if (!formattedInput || formattedInput === undefined) return name
  return `${name}(${formattedInput})`
}

function formatToolCallLabel(name: string, input: unknown): string {
  return formatToolCallName(name, formatToolInput(name, input))
}

function formatOutput(output: unknown): string {
  if (typeof output === 'string') {
    if (containsMarkdown(output)) {
      return formatToolOutputMarkdown(output)
    }
    return output
  }
  return JSON.stringify(output, null, 2)
}

export function getChatPrompt(): string {
  return inputPrompt
}

function shortSessionId(sessionId: string): string {
  if (!sessionId.startsWith('session_')) return truncateMiddle(sessionId, 18)
  return `session_${truncateMiddle(sessionId.slice('session_'.length), 12)}`
}

function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  if (maxLength <= 3) return value.slice(0, maxLength)
  const edge = Math.floor((maxLength - 3) / 2)
  const tail = maxLength - 3 - edge
  return `${value.slice(0, edge)}...${value.slice(-tail)}`
}
