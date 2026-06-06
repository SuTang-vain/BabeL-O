import chalk from 'chalk'
import type { NexusEvent } from '../shared/events.js'
import type { AgentJob, AgentJobStatus } from '../shared/agentJob.js'
import type { NexusTask, TaskStatus } from '../shared/task.js'
import { renderDiff } from './diff.js'
import { renderMarkdown, containsMarkdown, formatToolOutputMarkdown, MarkdownStreamRenderer } from './markdown.js'
import { renderedLineCount, stripAnsi, terminalWidth, visibleTerminalWidth } from './terminalWidth.js'

let tuiMode: 'compact' | 'expanded' = 'compact'
let sessionEvents: NexusEvent[] = []
let printedLinesCount = 0
let currentLineLength = 0
let liveLineStarted = false
let liveToolLine: { toolUseId: string; renderedLineCount: number; printedLineDelta: number; cursorRowsBelow: number } | undefined
let currentOutputBlock: 'none' | 'assistant' | 'thinking' = 'none'

// Markdown streaming renderer for assistant output
const markdownRenderer = new MarkdownStreamRenderer()
let pendingMarkdownBuffer = ''

// Track active readline for prompt redraws
let activeReadlineInterface: any = null
let pendingPermissionRequest: NexusEvent | null = null

// Spinner / Agent status state
type AgentStatus = 'working' | 'thinking' | 'generating' | 'running_tool' | 'running_subagent' | 'waiting_permission' | 'compacting' | 'retrying' | 'idle'
let spinnerTimer: NodeJS.Timeout | null = null
const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
let spinnerFrameIndex = 0
let isSpinnerActive = false
let spinnerRenderedLineCount = 0
let spinnerCursorRowsBelow = 0
let spinnerStatusText = 'Thinking...'
let spinnerStartedAt = 0
let activeSessionModel: string | undefined
let currentAgentStatus: AgentStatus = 'idle'
let currentToolName: string | undefined
let lastContextWarning: { percentUsed: number; tokenEstimate: number; maxTokens: number } | undefined
const inputPrompt = `${chalk.dim('>')} `
export const chatInputPlaceholder = 'Ask BabeL-O · / commands · Ctrl+E editor'
const toolPrefix = chalk.blue('●')
const thoughtPrefix = chalk.magenta('▸')
const compactBashOutputLineLimit = 3
const defaultBashTimeoutMs = 60_000

// Live agent tree state for concurrent sub-agent / agent job rendering
type LiveAgentEntry = {
  id: string
  title: string
  agentType: string
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  toolUses: number
  tokens: number
  lastActivity?: string
}
let liveAgentTree: LiveAgentEntry[] = []
let liveAgentTreeRenderedLines = 0

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
  lastContextWarning = events.findLast(e => e.type === 'context_warning' || e.type === 'context_blocking') as { percentUsed: number; tokenEstimate: number; maxTokens: number } | undefined
  redrawSession()
}

export function startSpinner(text: string = 'Thinking...'): void {
  if (isSpinnerActive) {
    spinnerStatusText = text
    drawSpinnerLine()
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

export function startAgentStatus(status: Exclude<AgentStatus, 'idle'> = 'working', toolName?: string): void {
  setAgentStatus(status, toolName)
  ensureLiveLine()
  startSpinner(formatAgentStatusText())
}

export function stopAgentStatus(): void {
  setAgentStatus('idle')
  stopSpinner()
}

function setAgentStatus(status: AgentStatus, toolName?: string) {
  currentAgentStatus = status
  currentToolName = toolName
}

function formatAgentStatusText(): string {
  switch (currentAgentStatus) {
    case 'working':
      return 'Working...'
    case 'thinking':
      return 'Thinking...'
    case 'generating':
      return 'Generating...'
    case 'running_tool':
      return currentToolName ? `Running ${currentToolName}...` : 'Running tool...'
    case 'running_subagent':
      return currentToolName ? `Running sub-agent ${currentToolName}...` : 'Running sub-agent...'
    case 'waiting_permission':
      return 'Waiting for permission...'
    case 'compacting':
      return 'Compacting conversation...'
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
  if (liveAgentTree.length > 0 && currentAgentStatus === 'running_subagent') return
  if (spinnerRenderedLineCount > 0) {
    clearSpinnerLine()
  }
  const columns = process.stdout.columns || 80
  const renderedLine = currentAgentStatus === 'compacting'
    ? formatCompactingStatusLine(columns)
    : formatDefaultStatusLine(columns)
  process.stdout.write(`\r\x1b[K${renderedLine}`)
  spinnerRenderedLineCount = renderedLineCount(renderedLine, columns)
}

function formatDefaultStatusLine(columns: number): string {
  const frame = spinnerFrames[spinnerFrameIndex]!
  const elapsed = spinnerStartedAt > 0 ? Date.now() - spinnerStartedAt : 0
  const elapsedText = elapsed >= 1000 ? ` ${formatElapsedDuration(elapsed)}` : ''
  const leftText = ` ${chalk.yellow(frame)} ${chalk.bold(spinnerStatusText)}${chalk.dim(elapsedText)}`
  const modelText = activeSessionModel ? ` ${chalk.cyan(activeSessionModel)} ` : ''
  const rightText = `${modelText}|${formatContextGauge()} `
  const leftLen = visibleTerminalWidth(leftText)
  const rightLen = visibleTerminalWidth(rightText)
  const padding = ' '.repeat(Math.max(0, columns - leftLen - rightLen - 2))
  return `${leftText}${padding}${rightText}`
}

function formatCompactingStatusLine(columns: number): string {
  const elapsed = spinnerStartedAt > 0 ? Date.now() - spinnerStartedAt : 0
  const elapsedText = formatElapsedDuration(elapsed)
  const progress = Math.min(95, 8 + Math.floor((elapsed / 1000) % 88))
  const prefix = ` ${chalk.yellow('◒')} ${chalk.bold(spinnerStatusText)} ${chalk.dim(`(${elapsedText})`)}`
  const suffix = ` ${chalk.dim(`${progress}%`)}`
  const availableBarWidth = Math.max(8, Math.min(40, columns - visibleTerminalWidth(prefix) - visibleTerminalWidth(suffix) - 4))
  const filledCount = Math.max(1, Math.floor((progress / 100) * availableBarWidth))
  const emptyCount = Math.max(0, availableBarWidth - filledCount)
  const bar = `${chalk.green('▰'.repeat(filledCount))}${chalk.dim('▱'.repeat(emptyCount))}`
  return `${prefix} ${bar}${suffix}`
}

function formatContextGauge(): string {
  if (!lastContextWarning) return ` ${chalk.green('[Context: OK]')}`
  const percent = Math.min(100, Math.max(0, Math.round(lastContextWarning.percentUsed || 0)))
  const barWidth = 10
  const filledCount = Math.round((percent / 100) * barWidth)
  const emptyCount = barWidth - filledCount
  let barColor = chalk.green
  if (percent > 80) barColor = chalk.red
  else if (percent > 60) barColor = chalk.yellow
  const filledStr = barColor('█'.repeat(filledCount))
  const emptyStr = chalk.dim('░'.repeat(emptyCount))
  return ` [${filledStr}${emptyStr}] ${percent}%`
}

function formatElapsedDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

// --- Live Agent Tree ---

function addLiveAgentEntry(id: string, agentType: string, title: string): void {
  if (liveAgentTree.some(e => e.id === id)) return
  liveAgentTree.push({ id, title, agentType, status: 'running', toolUses: 0, tokens: 0, lastActivity: 'Initializing…' })
  redrawLiveAgentTree()
}

function completeLiveAgentEntry(id: string, status: 'completed' | 'failed' | 'cancelled'): void {
  const entry = liveAgentTree.find(e => e.id === id)
  if (entry) {
    entry.status = status
    entry.lastActivity = status === 'completed' ? 'Done' : status
  }
  redrawLiveAgentTree()
  if (liveAgentTree.length > 0 && liveAgentTree.every(e => e.status !== 'running')) {
    printFinalAgentTreeSummary()
    liveAgentTree = []
    liveAgentTreeRenderedLines = 0
  }
}

export function updateLiveAgentActivity(id: string, toolUses?: number, tokens?: number, activity?: string): void {
  const entry = liveAgentTree.find(e => e.id === id)
  if (!entry) return
  if (toolUses !== undefined) entry.toolUses = toolUses
  if (tokens !== undefined) entry.tokens = tokens
  if (activity) entry.lastActivity = activity
  redrawLiveAgentTree()
}

function clearLiveAgentTreeLines(): void {
  if (liveAgentTreeRenderedLines > 0) {
    process.stdout.write(`\x1b[${liveAgentTreeRenderedLines}A\x1b[J`)
    liveAgentTreeRenderedLines = 0
  }
}

function redrawLiveAgentTree(): void {
  if (liveAgentTree.length === 0) return
  clearLiveAgentTreeLines()
  const lines = formatLiveAgentTreeLines()
  const output = lines.join('\n') + '\n'
  process.stdout.write(output)
  liveAgentTreeRenderedLines = lines.length
}

function formatLiveAgentTreeLines(): string[] {
  const running = liveAgentTree.filter(e => e.status === 'running')
  const finished = liveAgentTree.filter(e => e.status !== 'running')
  const allDone = running.length === 0
  const agentTypes = [...new Set(liveAgentTree.map(e => capitalizeFirst(e.agentType)))]
  const typeLabel = agentTypes.length === 1 ? agentTypes[0]! : 'mixed'
  const header = allDone
    ? `${chalk.green('⏺')} ${liveAgentTree.length} ${typeLabel} agent${liveAgentTree.length > 1 ? 's' : ''} finished ${chalk.dim('(ctrl+o to expand)')}`
    : `${chalk.yellow('⏺')} Running ${liveAgentTree.length} ${typeLabel} agent${liveAgentTree.length > 1 ? 's' : ''}… ${chalk.dim('(ctrl+o to expand)')}`
  const lines = [header]
  const entries = [...running, ...finished]
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!
    const isLast = i === entries.length - 1
    const prefix = isLast ? '└' : '├'
    const statusIcon = entry.status === 'running' ? chalk.cyan('▶') : entry.status === 'completed' ? chalk.green('✓') : chalk.red('✗')
    const stats = `${entry.toolUses} tool use${entry.toolUses !== 1 ? 's' : ''} · ${entry.tokens} tokens`
    lines.push(`   ${prefix} ${statusIcon} ${entry.title} · ${chalk.dim(stats)}`)
    if (entry.lastActivity && entry.status === 'running') {
      const actPrefix = isLast ? ' ' : '│'
      lines.push(`   ${actPrefix} ⎿  ${chalk.dim(entry.lastActivity)}`)
    }
  }
  if (!allDone) {
    lines.push(chalk.dim('     (ctrl+b to run in background)'))
  }
  return lines
}

function printFinalAgentTreeSummary(): void {
  clearLiveAgentTreeLines()
  const lines = formatLiveAgentTreeLines()
  process.stdout.write(lines.join('\n') + '\n\n')
  liveAgentTreeRenderedLines = 0
}

function capitalizeFirst(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

export function getLiveAgentTree(): LiveAgentEntry[] {
  return liveAgentTree
}

export function resetLiveAgentTreeForTest(): void {
  liveAgentTree = []
  liveAgentTreeRenderedLines = 0
}

function clearSpinnerLine() {
  const rowsToMoveUp = spinnerCursorRowsBelow + Math.max(0, spinnerRenderedLineCount - 1)
  if (rowsToMoveUp > 0) {
    process.stdout.write(`\r\x1b[K\x1b[${rowsToMoveUp}A\x1b[J`)
  } else {
    process.stdout.write('\r\x1b[K')
  }
  spinnerRenderedLineCount = 0
  spinnerCursorRowsBelow = 0
}

function moveCursorBelowLiveToolLine(): void {
  if (!liveToolLine || liveToolLine.cursorRowsBelow > 0) return
  process.stdout.write('\n')
  liveToolLine.cursorRowsBelow = 1
  printedLinesCount++
  currentLineLength = 0
  liveLineStarted = false
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

    setAgentStatus('generating')
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

    setAgentStatus('thinking')
    if (tuiMode === 'expanded') {
      stopSpinner()
      handleThinkingDelta(event.text)
    } else {
      ensureLiveLine()
      startSpinner(formatAgentStatusText())
    }
    return
  }

  updateAgentStatusFromEvent(event)

  if (isCompactSilentEvent(event)) {
    sessionEvents.push(event)
    updateSpinnerForCurrentStatus()
    return
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
  const rowsToMoveUp = liveToolLine.cursorRowsBelow + Math.max(0, liveToolLine.renderedLineCount - 1)
  if (rowsToMoveUp > 0) {
    process.stdout.write(`\r\x1b[K\x1b[${rowsToMoveUp}A\x1b[J`)
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
    cursorRowsBelow: 0,
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

function updateAgentStatusFromEvent(event: NexusEvent): void {
  switch (event.type) {
    case 'session_started':
      setAgentStatus('generating')
      break
    case 'tool_started':
      setAgentStatus('running_tool', event.name)
      break
    case 'permission_request':
      setAgentStatus('waiting_permission')
      break
    case 'permission_response':
      setAgentStatus(event.approved ? 'running_tool' : 'idle', findToolName(event.toolUseId))
      break
    case 'tool_completed':
      setAgentStatus('generating')
      break
    case 'tool_denied':
    case 'result':
    case 'error':
      setAgentStatus('idle')
      break
    case 'compact_boundary':
      setAgentStatus('compacting')
      break
    case 'compact_failure':
      setAgentStatus('generating')
      break
    case 'task_session_event':
      if (event.eventType === 'subagent_started' || event.eventType === 'sub_agent_session_started') {
        setAgentStatus('running_subagent', summarizeSubAgentTitle(event.payload))
        const payload = event.payload as Record<string, unknown> | undefined
        const subId = (payload?.agentId ?? payload?.subSessionId ?? event.eventId) as string
        const subTitle = summarizeSubAgentTitle(payload) ?? 'sub-agent'
        addLiveAgentEntry(subId, 'subagent', subTitle)
      } else if (event.eventType === 'subagent_completed' || event.eventType === 'subagent_failed' || event.eventType === 'subagent_cancelled' || event.eventType === 'sub_agent_session_completed' || event.eventType === 'sub_agent_session_failed' || event.eventType === 'sub_agent_session_error') {
        const payload = event.payload as Record<string, unknown> | undefined
        const subId = (payload?.agentId ?? payload?.subSessionId ?? event.eventId) as string
        const terminal = (event.eventType === 'subagent_completed' || event.eventType === 'sub_agent_session_completed') ? 'completed' : 'failed'
        completeLiveAgentEntry(subId, terminal)
        if (liveAgentTree.every(e => e.status !== 'running')) {
          setAgentStatus('generating')
        }
      }
      break
    case 'agent_job_event':
      if (event.eventType === 'agent_job_started') {
        setAgentStatus('running_subagent', event.agentType)
        addLiveAgentEntry(event.jobId ?? event.eventId, event.agentType ?? 'agent', (event as any).prompt ?? event.agentType ?? 'agent')
      } else if (event.eventType === 'agent_job_completed' || event.eventType === 'agent_job_failed' || event.eventType === 'agent_job_cancelled') {
        completeLiveAgentEntry(event.jobId ?? event.eventId, event.eventType === 'agent_job_completed' ? 'completed' : event.eventType === 'agent_job_failed' ? 'failed' : 'cancelled')
        if (liveAgentTree.every(e => e.status !== 'running')) {
          setAgentStatus('generating')
        }
      }
      break
  }
}

function summarizeSubAgentTitle(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const record = payload as Record<string, unknown>
  if (typeof record.title === 'string') return truncateMiddle(record.title, 32)
  if (typeof record.taskId === 'string') return `#${record.taskId}`
  return undefined
}

function updateSpinnerForCurrentStatus(): void {
  if (!isSpinnerActive || currentAgentStatus === 'idle') return
  startSpinner(formatAgentStatusText())
}

function renderLiveEvent(event: NexusEvent): void {
  const hadSpinner = isSpinnerActive
  stopSpinner()
  const replacedLiveToolLine = event.type === 'tool_completed' ? clearLiveToolLine(event.toolUseId) : false
  if (!replacedLiveToolLine && event.type !== 'permission_request') {
    ensureLiveLine()
  }

  switch (event.type) {
    case 'session_started':
      activeSessionModel = event.model
      console.log(formatAgentStatusLine(event))
      if (hadSpinner) startSpinner(formatAgentStatusText())
      break
    case 'tool_started': {
      renderToolLine(formatToolLiveLine({
        name: event.name,
        input: event.input,
        status: 'running',
      }), event.toolUseId)
      moveCursorBelowLiveToolLine()
      startSpinner(formatAgentStatusText())
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
      ensureLiveLine()
      startSpinner(formatAgentStatusText())
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
      break
    case 'context_warning':
      lastContextWarning = { percentUsed: event.percentUsed, tokenEstimate: event.tokenEstimate, maxTokens: event.maxTokens }
      console.log(
        chalk.yellow(
          `context warning: ${event.percentUsed}% of window used (${event.tokenEstimate}/${event.maxTokens} tokens). consider /compact.`,
        ),
      )
      break
    case 'context_blocking':
      lastContextWarning = { percentUsed: event.percentUsed, tokenEstimate: event.tokenEstimate, maxTokens: event.maxTokens }
      console.log(
        chalk.red(
          `context blocked: ${event.percentUsed}% of window used (${event.tokenEstimate}/${event.maxTokens} tokens). run /compact or /context before retrying.`,
        ),
      )
      break
    case 'compact_failure':
      console.log(
        chalk.yellow(
          `context compact failed (${event.failureCount}/${event.maxFailures}): ${event.message}`,
        ),
      )
      startSpinner(formatAgentStatusText())
      break
    case 'result':
      if (!event.success) {
        console.log(chalk.red('✗ failed'))
      }
      console.log('')
      break
    case 'task_session_event':
      console.log(formatTaskSessionEvent(event))
      if (hadSpinner && currentAgentStatus !== 'idle') startSpinner(formatAgentStatusText())
      break
    case 'agent_job_event':
      console.log(formatAgentJobEvent(event))
      if (hadSpinner && currentAgentStatus !== 'idle') startSpinner(formatAgentStatusText())
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
        if (mode === 'expanded') {
          outputText += chalk.dim(`context compacted: ${ev.beforeEventCount} -> ${ev.afterEventCount} events\n`)
        }
        break

      case 'context_warning':
        outputText += chalk.yellow(
          `context warning: ${ev.percentUsed}% of window used (${ev.tokenEstimate}/${ev.maxTokens} tokens). consider /compact.\n`,
        )
        break

      case 'context_blocking':
        outputText += chalk.red(
          `context blocked: ${ev.percentUsed}% of window used (${ev.tokenEstimate}/${ev.maxTokens} tokens). run /compact or /context before retrying.\n`,
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

      case 'agent_job_event':
        outputText += `${formatAgentJobEvent(ev)}\n`
        break

      case 'usage':
        break
    }
  }

  outputText += formatTaskStatusPanel(events)
  outputText += formatContextFooter()

  if (pendingPermissionRequest) {
    const inputSoFar = activeReadlineInterface ? activeReadlineInterface.line : ''
    const tool = 'name' in pendingPermissionRequest ? pendingPermissionRequest.name : 'tool'
    const risk = 'risk' in pendingPermissionRequest ? ` (${pendingPermissionRequest.risk} risk)` : ''
    outputText += chalk.yellow(`Approve ${tool}${risk}? [y/N] `) + inputSoFar
  }

  return outputText
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
  transcriptPath?: string
}

type MultiAgentStatusRow = {
  id: string
  source: 'AgentJob' | 'AgentLoop'
  agentType: string
  status: AgentJobStatus
  title: string
  childSessionId?: string
  transcriptPath?: string
  depth?: number
  updatedAt?: string
  details?: string[]
}

export function formatMultiAgentStatusView(options: {
  sessionId?: string
  jobs?: AgentJob[]
  events?: NexusEvent[]
  columns?: number
}): string {
  const rows = [
    ...formatAgentJobRows(options.jobs ?? []),
    ...formatAgentLoopRows(options.events ?? []),
  ]
  rows.sort(compareMultiAgentRows)

  const columns = Math.max(64, options.columns ?? process.stdout.columns ?? 100)
  const width = Math.max(58, Math.min(columns - 4, 110))
  const title = options.sessionId
    ? ` Multi-Agent Status · ${shortSessionId(options.sessionId)} `
    : ' Multi-Agent Status '
  const headerPadding = '─'.repeat(Math.max(0, width - title.length))
  let panel = `\n  ${chalk.cyan(`┌${title}${headerPadding}┐`)}\n`

  if (rows.length === 0) {
    panel += formatMultiAgentPanelLine(chalk.dim('No agent jobs or AgentLoop sub-agents found for this session.'), width)
    panel += `  ${chalk.cyan('└' + '─'.repeat(width) + '┘')}\n`
    return panel
  }

  const counts = summarizeMultiAgentRows(rows)
  panel += formatMultiAgentPanelLine(chalk.dim(counts), width)
  panel += `  ${chalk.cyan('├' + '─'.repeat(width) + '┤')}\n`

  for (const row of rows) {
    for (const line of formatMultiAgentRow(row, width).split('\n')) {
      panel += formatMultiAgentPanelLine(line, width)
    }
  }

  panel += `  ${chalk.cyan('└' + '─'.repeat(width) + '┘')}\n`
  return panel
}

function formatAgentJobRows(jobs: AgentJob[]): MultiAgentStatusRow[] {
  return jobs.map(job => ({
    id: job.jobId,
    source: 'AgentJob',
    agentType: job.agentType,
    status: job.status,
    title: job.result?.summary || job.prompt,
    childSessionId: job.childSessionId,
    transcriptPath: job.transcriptPath ?? `nexus://sessions/${job.childSessionId}/events`,
    depth: job.governance?.depth,
    updatedAt: job.updatedAt,
    details: compactStringList([
      job.contextForkMode,
      job.isolation !== 'none' ? job.isolation : '',
      job.governance ? `active ${job.governance.activeAgents}/${job.governance.maxConcurrentAgents}` : '',
      job.error?.code,
    ]),
  }))
}

function formatAgentLoopRows(events: NexusEvent[]): MultiAgentStatusRow[] {
  const rows = new Map<string, MultiAgentStatusRow>()

  for (const event of events) {
    if (event.type !== 'task_session_event') continue
    if (!isSubAgentLifecycleEvent(event.eventType)) continue
    const payload = event.payload && typeof event.payload === 'object'
      ? event.payload as Record<string, unknown>
      : {}
    const id = firstPayloadString(payload, ['agentId', 'subSessionId', 'taskId'])
    if (!id) continue

    const existing = rows.get(id)
    const nextStatus = statusFromSubAgentLifecycleEvent(event.eventType)
    const title = firstPayloadString(payload, ['title', 'taskTitle', 'summary']) ?? existing?.title ?? 'sub-agent task'
    const childSessionId = firstPayloadString(payload, ['subSessionId', 'childSessionId']) ?? existing?.childSessionId
    const transcriptPath = firstPayloadString(payload, ['transcriptPath']) ?? existing?.transcriptPath
    const depth = firstPayloadNumber(payload, ['depth']) ?? existing?.depth
    const parentTaskId = firstPayloadString(payload, ['parentTaskId'])
    const taskId = firstPayloadString(payload, ['taskId'])
    rows.set(id, {
      id,
      source: 'AgentLoop',
      agentType: 'subagent',
      status: nextStatus,
      title,
      childSessionId,
      transcriptPath,
      depth,
      updatedAt: event.timestamp,
      details: compactStringList([
        parentTaskId ? `parent #${parentTaskId}` : '',
        taskId ? `task #${taskId}` : '',
      ]),
    })
  }

  return [...rows.values()]
}

function isSubAgentLifecycleEvent(eventType: string): boolean {
  return eventType === 'sub_agent_session_started' ||
    eventType === 'subagent_started' ||
    eventType === 'sub_agent_session_completed' ||
    eventType === 'subagent_completed' ||
    eventType === 'sub_agent_session_failed' ||
    eventType === 'sub_agent_session_error' ||
    eventType === 'subagent_failed' ||
    eventType === 'subagent_cancelled'
}

function statusFromSubAgentLifecycleEvent(eventType: string): AgentJobStatus {
  if (eventType === 'sub_agent_session_completed' || eventType === 'subagent_completed') return 'completed'
  if (eventType === 'subagent_cancelled') return 'cancelled'
  if (eventType === 'sub_agent_session_failed' || eventType === 'sub_agent_session_error' || eventType === 'subagent_failed') return 'failed'
  return 'running'
}

function compareMultiAgentRows(left: MultiAgentStatusRow, right: MultiAgentStatusRow): number {
  const statusOrder = ['running', 'waiting_permission', 'queued', 'failed', 'cancelled', 'completed']
  const leftStatus = statusOrder.indexOf(left.status)
  const rightStatus = statusOrder.indexOf(right.status)
  if (leftStatus !== rightStatus) return leftStatus - rightStatus
  return (right.updatedAt ?? '').localeCompare(left.updatedAt ?? '')
}

function summarizeMultiAgentRows(rows: MultiAgentStatusRow[]): string {
  const counts = new Map<AgentJobStatus, number>()
  for (const row of rows) counts.set(row.status, (counts.get(row.status) ?? 0) + 1)
  return ['running', 'waiting_permission', 'queued', 'failed', 'cancelled', 'completed']
    .map(status => [status, counts.get(status as AgentJobStatus) ?? 0] as const)
    .filter(([, count]) => count > 0)
    .map(([status, count]) => `${status} ${count}`)
    .join(' · ')
}

function formatMultiAgentRow(row: MultiAgentStatusRow, width: number): string {
  const status = formatMultiAgentStatus(row.status)
  const source = row.source === 'AgentJob' ? chalk.blue('job') : chalk.magenta('loop')
  const depth = typeof row.depth === 'number' ? chalk.dim(` d${row.depth}`) : ''
  const prefix = `${status} ${source} ${chalk.bold(row.agentType)}${depth}`
  const titleBudget = Math.max(24, width - visibleTerminalWidth(stripAnsi(prefix)) - 4)
  const lines = [`${prefix} ${truncateMiddle(row.title, titleBudget)}`]
  const meta = [
    row.childSessionId ? `child=${shortSessionId(row.childSessionId)}` : '',
    ...(row.details ?? []),
    row.transcriptPath ? `transcript=${row.transcriptPath}` : '',
  ].filter(Boolean)
  if (meta.length > 0) lines.push(chalk.dim(`  ${meta.join(' · ')}`))
  return lines.join('\n')
}

function formatMultiAgentStatus(status: AgentJobStatus): string {
  switch (status) {
    case 'queued':
      return chalk.yellow('⟳ queued')
    case 'running':
      return chalk.cyan('▶ running')
    case 'waiting_permission':
      return chalk.magenta('? permission')
    case 'completed':
      return chalk.green('✓ completed')
    case 'failed':
      return chalk.red('✗ failed')
    case 'cancelled':
      return chalk.red('✗ cancelled')
  }
}

function formatMultiAgentPanelLine(content: string, width: number): string {
  const visibleLength = visibleTerminalWidth(content)
  const padding = ' '.repeat(Math.max(0, width - visibleLength))
  return `  ${chalk.cyan('│')}${content}${padding}${chalk.cyan('│')}\n`
}

function compactStringList(values: Array<string | undefined>): string[] {
  return values.filter((value): value is string => typeof value === 'string' && value.length > 0)
}

function firstPayloadString(payload: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = payload[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

function firstPayloadNumber(payload: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = payload[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return undefined
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
      } else if (ev.eventType === 'sub_agent_session_started' || ev.eventType === 'subagent_started') {
        const payload = ev.payload as { taskId?: string; subSessionId?: string; title?: string; transcriptPath?: string; depth?: number; parentTaskId?: string } | undefined
        if (payload?.taskId) {
          let task = tasks.find(t => t.taskId === payload.taskId)
          if (!task && payload.title) {
            task = {
              taskId: payload.taskId,
              title: payload.title,
              status: 'in_progress',
              parentTaskId: payload.parentTaskId,
              depth: typeof payload.depth === 'number' ? payload.depth : 0,
            }
            tasks.push(task)
          }
          if (task) {
            task.subSessionId = payload.subSessionId
            task.transcriptPath = payload.transcriptPath
            if (typeof payload.depth === 'number') task.depth = payload.depth
            if (typeof payload.parentTaskId === 'string') task.parentTaskId = payload.parentTaskId
            if (task.status !== 'completed') task.status = 'in_progress'
          }
        }
      } else if (ev.eventType === 'sub_agent_session_completed' || ev.eventType === 'subagent_completed') {
        const payload = ev.payload as { taskId?: string; transcriptPath?: string } | undefined
        if (payload?.taskId) {
          const task = tasks.find(t => t.taskId === payload.taskId)
          if (task && task.status !== 'completed') {
            task.status = 'completed'
            if (typeof payload.transcriptPath === 'string') task.transcriptPath = payload.transcriptPath
          }
        }
      } else if (ev.eventType === 'sub_agent_session_failed' || ev.eventType === 'sub_agent_session_error' || ev.eventType === 'subagent_failed' || ev.eventType === 'subagent_cancelled') {
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
    if (t.transcriptPath) meta.push(`transcript=${t.transcriptPath}`)
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
    transcriptPath: typeof task.metadata?.transcriptPath === 'string'
      ? task.metadata.transcriptPath
      : typeof (task.metadata?.subAgent as Record<string, unknown> | undefined)?.transcriptPath === 'string'
        ? (task.metadata?.subAgent as Record<string, unknown>).transcriptPath as string
        : undefined,
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

function formatAgentJobEvent(event: Extract<NexusEvent, { type: 'agent_job_event' }>): string {
  const label = event.eventType.replace(/_/g, ' ')
  const phase = chalk.dim(event.status)
  const payload = summarizePayload({
    agentType: event.agentType,
    childSessionId: event.childSessionId,
    transcriptPath: `nexus://sessions/${event.childSessionId}/events`,
    governance: event.governance,
    result: event.result,
    error: event.error,
  })
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
  if (record.agentType === 'subagent' || typeof record.transcriptPath === 'string') {
    const pieces = [
      typeof record.status === 'string' ? record.status : '',
      typeof record.title === 'string' ? record.title : '',
      typeof record.depth === 'number' ? `depth=${record.depth}` : '',
      typeof record.parentTaskId === 'string' ? `parentTaskId=${record.parentTaskId}` : '',
      typeof record.subSessionId === 'string' ? `subSession=${shortSessionId(record.subSessionId)}` : '',
      typeof record.transcriptPath === 'string' ? `transcript=${record.transcriptPath}` : '',
    ].filter(Boolean)
    if (pieces.length > 0) return truncateMiddle(pieces.join(' '), 240)
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

function findToolName(toolUseId: string): string | undefined {
  for (let i = sessionEvents.length - 1; i >= 0; i--) {
    const event = sessionEvents[i]!
    if (event.type === 'tool_started' && event.toolUseId === toolUseId) {
      return event.name
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
