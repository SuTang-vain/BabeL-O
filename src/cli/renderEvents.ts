import chalk from 'chalk'
import type { NexusEvent } from '../shared/events.js'
import { renderDiff } from './diff.js'

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
}

let tuiMode: 'compact' | 'expanded' = 'compact'
let sessionEvents: NexusEvent[] = []
let printedLinesCount = 0
let currentLineLength = 0
let liveLineStarted = false
let currentOutputBlock: 'none' | 'assistant' | 'thinking' = 'none'

// Track active readline for prompt redraws
let activeReadlineInterface: any = null
let pendingPermissionRequest: NexusEvent | null = null

// Spinner state
let spinnerTimer: NodeJS.Timeout | null = null
const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
let spinnerFrameIndex = 0
let isSpinnerActive = false
let spinnerStatusText = 'Thinking...'
let spinnerStartedAt = 0
let activeSessionModel: string | undefined
const inputPrompt = chalk.blue('> ')
const toolPrefix = chalk.blue('●')
const thoughtPrefix = chalk.magenta('▸')

export function getTuiMode(): 'compact' | 'expanded' {
  return tuiMode
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
  currentOutputBlock = 'none'
  pendingPermissionRequest = null
  activeSessionModel = undefined

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
  printedLinesCount = getLineCount(fullPromptText + '\n', columns)
  currentLineLength = 0
}

export function resumeSessionHistory(events: NexusEvent[]): void {
  stopSpinner()
  sessionEvents = [...events]
  printedLinesCount = 0
  currentLineLength = 0
  liveLineStarted = false
  currentOutputBlock = 'none'
  pendingPermissionRequest = null
  activeSessionModel = events.findLast(e => e.type === 'session_started')?.model
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
  const frame = spinnerFrames[spinnerFrameIndex]
  const elapsed = spinnerStartedAt > 0 ? Math.floor((Date.now() - spinnerStartedAt) / 1000) : 0
  const elapsedText = elapsed > 0 ? ` ${elapsed}s` : ''
  process.stdout.write(`\r\x1b[K${chalk.yellow(frame)} ${chalk.dim(spinnerStatusText)}${chalk.dim(elapsedText)}`)
}

function clearSpinnerLine() {
  process.stdout.write('\r\x1b[K')
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
    if (last && last.type === 'assistant_delta') {
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
      startSpinner('Thinking...')
    }
    return
  }

  // Handle spinner transitions for other events
  if (event.type === 'tool_started' || event.type === 'tool_completed' || event.type === 'tool_denied') {
    stopSpinner()
  } else if (event.type === 'result' || event.type === 'error' || event.type === 'permission_request') {
    stopSpinner()
  }

  sessionEvents.push(event)
  renderLiveEvent(event)
}

export function redrawSession(): void {
  clearPrintedLines()

  const columns = process.stdout.columns || 80
  const buffer = formatSessionHistory(sessionEvents, tuiMode)

  process.stdout.write(buffer)

  printedLinesCount = getLineCount(buffer, columns)

  const lastNewlineIdx = buffer.lastIndexOf('\n')
  const lastLine = lastNewlineIdx === -1 ? buffer : buffer.slice(lastNewlineIdx + 1)
  currentLineLength = lastLine.length

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

  const columns = process.stdout.columns || 80
  const cleanText = stripAnsi(text)
  const lines = cleanText.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) {
      printedLinesCount++
      currentLineLength = 0
    }
    currentLineLength += lines[i]!.length
    if (currentLineLength >= columns) {
      const wraps = Math.floor(currentLineLength / columns)
      printedLinesCount += wraps
      currentLineLength = currentLineLength % columns
    }
  }
}

function handleAssistantDelta(text: string) {
  if (currentOutputBlock !== 'assistant') {
    ensureLiveLine()
    process.stdout.write(`${chalk.green('⏺')} `)
    liveLineStarted = true
    currentOutputBlock = 'assistant'
  }
  handleDelta(text, false)
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
  if (liveLineStarted) {
    process.stdout.write('\n')
  }
  liveLineStarted = false
  currentOutputBlock = 'none'
}

function renderLiveEvent(event: NexusEvent): void {
  ensureLiveLine()

  switch (event.type) {
    case 'session_started':
      activeSessionModel = event.model
      console.log(formatAgentStatusLine(event))
      startSpinner('Thinking...')
      break
    case 'tool_started': {
      console.log(formatToolLiveLine({
        name: event.name,
        input: event.input,
        status: 'running',
      }))
      startSpinner(`Running ${event.name}...`)
      break
    }
    case 'tool_completed': {
      console.log(formatToolLiveLine({
        name: event.name,
        status: event.success ? 'completed' : 'failed',
        output: event.output,
        truncated: event.truncated,
        originalBytes: event.originalBytes,
      }))
      if (event.truncated) {
        console.log(chalk.yellow(`output truncated at ${event.originalBytes ?? 'unknown'} original bytes`))
      }
      if (tuiMode === 'expanded' && event.output !== undefined) {
        console.log(formatOutput(event.output))
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
      console.log(
        event.approved
          ? chalk.green('✓ Permission approved')
          : chalk.red(`✗ Permission denied${event.reason ? `: ${event.reason}` : ''}`),
      )
      break
    case 'error':
      console.log(chalk.red(`${event.code}: ${event.message}`))
      break
    case 'result':
      console.log(event.success ? chalk.green('✓ done') : chalk.red('✗ failed'))
      console.log('')
      break
    case 'task_session_event':
      console.log(formatTaskSessionEvent(event))
      break
    case 'usage':
      if (tuiMode === 'expanded') {
        console.log(chalk.dim(`usage input=${event.inputTokens} output=${event.outputTokens}`))
      }
      break
  }
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
  completed: boolean
}

export function formatSessionHistory(events: NexusEvent[], mode: 'compact' | 'expanded'): string {
  let outputText = ''

  const toolsMap = new Map<string, ToolCallState>()
  for (const ev of events) {
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
    }
  }

  for (const ev of events) {
    switch (ev.type) {
      case 'session_started':
        outputText += `${formatAgentStatusLine(ev)}\n`
        break

      case 'user_message':
        outputText += `${formatUserPrompt(ev.text)}\n`
        break

      case 'assistant_delta':
        outputText += `${chalk.green('⏺')} ${ev.text}\n`
        break

      case 'thinking_delta':
        if (mode === 'expanded') {
          outputText += `${thoughtPrefix} ${chalk.dim('Thought')}\n  ${chalk.dim(ev.text)}\n`
        }
        break

      case 'tool_started': {
        const state = toolsMap.get(ev.toolUseId)
        if (!state) break

        const formattedInput = formatToolInput(state.input)

        if (mode === 'compact') {
          outputText += formatToolHistoryLine(state, formattedInput) + '\n'
        } else {
          let header = chalk.cyan(`● ${state.name}`)
          if (state.completed) header = formatToolHeader(state)
          outputText += `${header}\n`
          outputText += `  Input: ${JSON.stringify(state.input, null, 2)}\n`

          if (state.completed) {
            if (state.denied) {
              outputText += `  Denied: ${state.risk} risk\n`
              if (state.denialMessage) {
                outputText += `  Message: ${state.denialMessage}\n`
              }
            } else {
              outputText += `  Success: ${state.success}\n`
              if (state.truncated) {
                outputText += `  Output truncated: ${state.originalBytes ?? 'unknown'} original bytes\n`
              }
              if (state.success && (state.name === 'Edit' || state.name === 'Write')) {
                const diffText = renderDiff(state.name, state.input)
                if (diffText) {
                  outputText += diffText
                }
              }
              if (state.output !== undefined) {
                outputText += `  Output:\n${formatOutput(state.output)}\n`
              }
            }
          }
        }
        break
      }

      case 'permission_request': {
        if (mode === 'compact') {
          outputText += chalk.bold.yellow(`? Permission requested for ${ev.name} (${ev.risk} risk)\n`)
        } else {
          outputText += chalk.bold.yellow(`? Permission requested for ${ev.name} (${ev.risk} risk)\n`)
          outputText += chalk.dim(`Input: ${JSON.stringify(ev.input, null, 2)}\n`)
          if (ev.message) {
            outputText += `${ev.message}\n`
          }
        }
        break
      }

      case 'permission_response': {
        if (mode === 'compact') {
          outputText += ev.approved
            ? chalk.green(`✓ Permission approved\n`)
            : chalk.red(`✗ Permission denied\n`)
        } else {
          outputText += ev.approved
            ? chalk.green(`✓ Permission approved\n`)
            : chalk.red(`✗ Permission denied${ev.reason ? `: ${ev.reason}` : ''}\n`)
        }
        break
      }

      case 'error':
        outputText += chalk.red(`${ev.code}: ${ev.message}\n`)
        break

      case 'tool_denied': {
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
        outputText += ev.success ? chalk.green('✓ done\n') : chalk.red('✗ failed\n')
        break

      case 'task_session_event':
        outputText += `${formatTaskSessionEvent(ev)}\n`
        break

      case 'usage':
        if (mode === 'expanded') {
          outputText += chalk.dim(`usage input=${ev.inputTokens} output=${ev.outputTokens}\n`)
        }
        break
    }
  }

  outputText += formatTaskStatusPanel(events)

  if (pendingPermissionRequest) {
    const inputSoFar = activeReadlineInterface ? activeReadlineInterface.line : ''
    const tool = 'name' in pendingPermissionRequest ? pendingPermissionRequest.name : 'tool'
    const risk = 'risk' in pendingPermissionRequest ? ` (${pendingPermissionRequest.risk} risk)` : ''
    outputText += chalk.yellow(`Approve ${tool}${risk}? [y/N] `) + inputSoFar
  }

  return outputText
}

export function formatTaskStatusPanel(events: NexusEvent[]): string {
  const tasks: { taskId?: string; title: string; status: 'pending' | 'in_progress' | 'completed' | 'failed' }[] = []
  const taskIdToTitle = new Map<string, string>()

  for (const ev of events) {
    if (ev.type === 'task_created') {
      const title = ev.title
      const taskId = ev.taskId
      const existing = tasks.find(t => t.title === title || t.taskId === taskId)
      if (existing) {
        existing.taskId = taskId
      } else {
        tasks.push({ taskId, title, status: 'pending' })
      }
      taskIdToTitle.set(taskId, title)
    } else if (ev.type === 'task_session_event') {
      interface TaskSessionPayload {
        plannerOutput?: {
          tasks?: Array<{ title?: string; description?: string }>
        }
        taskId?: string
        title?: string
        approved?: boolean
      }
      const payload = ev.payload as TaskSessionPayload | undefined

      if (ev.eventType === 'planner_completed') {
        const plannerOutput = payload?.plannerOutput
        if (plannerOutput && Array.isArray(plannerOutput.tasks)) {
          for (const t of plannerOutput.tasks) {
            if (t && t.title) {
              if (!tasks.some(existing => existing.title === t.title)) {
                tasks.push({ title: t.title, status: 'pending' })
              }
            }
          }
        }
      } else if (ev.eventType === 'task_claimed') {
        if (payload && payload.taskId) {
          taskIdToTitle.set(payload.taskId, payload.title || '')
          let task = tasks.find(t => t.title === payload.title || t.taskId === payload.taskId)
          if (!task) {
            task = { taskId: payload.taskId, title: payload.title || '', status: 'in_progress' }
            tasks.push(task)
          } else {
            task.taskId = payload.taskId
            task.status = 'in_progress'
          }
        }
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
          tasks.push({ title: output.title, status: 'completed' })
        } else {
          existing.status = 'completed'
        }
      }
    }
  }

  if (tasks.length === 0) return ''

  let panel = `\n${chalk.cyan('--- Task Status Board ---')}\n`
  for (const t of tasks) {
    let coloredStatus = ''
    switch (t.status) {
      case 'pending':
        coloredStatus = chalk.yellow('⟳ 规划中')
        break
      case 'in_progress':
        coloredStatus = chalk.cyan('▶ 执行中')
        break
      case 'completed':
        coloredStatus = chalk.green('✓ 已完成')
        break
      case 'failed':
        coloredStatus = chalk.red('✗ 已失败')
        break
    }
    panel += `  ${coloredStatus}  ${t.title}\n`
  }
  return panel
}

function formatAgentStatusLine(event: Extract<NexusEvent, { type: 'session_started' }>): string {
  const model = event.model ?? activeSessionModel ?? 'local/coding-runtime'
  return `${chalk.dim('agent')} ${chalk.cyan(shortSessionId(event.sessionId))} ${chalk.dim('model')} ${chalk.yellow(truncateMiddle(model, 32))}`
}

function formatUserPrompt(text: string): string {
  return `${inputPrompt}${text}`
}

function formatToolHeader(state: ToolCallState): string {
  if (state.denied) return chalk.red(`! ${state.name} denied`)
  if (state.success) return chalk.green(`✓ ${state.name}`)
  return chalk.red(`✗ ${state.name}`)
}

function formatToolHistoryLine(state: ToolCallState, formattedInput: string): string {
  if (!state.completed) {
    return `${toolPrefix} ${chalk.bold(formatToolCallName(state.name, formattedInput))} ${chalk.dim('running')}`
  }
  if (state.denied) {
    return `${chalk.red('●')} ${chalk.bold(state.name)} ${chalk.red('denied')} ${chalk.dim(state.risk ? `${state.risk} risk` : '')}`
  }
  const marker = state.success ? chalk.green('✓') : chalk.red('✗')
  const status = state.success ? chalk.green('done') : chalk.red('failed')
  return `${toolPrefix} ${marker} ${chalk.bold(formatToolCallName(state.name, formattedInput))} ${status} ${chalk.dim('(ctrl+o to expand)')}`
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
  const formattedInput = formatToolInput(options.input)
  if (options.status === 'running') {
    return `${toolPrefix} ${chalk.bold(formatToolCallName(options.name, formattedInput))} ${chalk.dim('running')}`
  }
  if (options.status === 'denied') {
    return `${chalk.red('●')} ${chalk.bold(options.name)} ${chalk.red('denied')} ${chalk.dim(options.risk ? `${options.risk} risk` : '')} ${options.denialMessage ?? ''}`.trimEnd()
  }
  const marker = options.status === 'completed' ? chalk.green('✓') : chalk.red('✗')
  const status = options.status === 'completed' ? chalk.green('done') : chalk.red('failed')
  const truncated = options.truncated ? chalk.yellow(` truncated ${options.originalBytes ?? 'unknown'}b`) : ''
  return `${toolPrefix} ${marker} ${chalk.bold(options.name)} ${status}${truncated}`
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
  if (typeof record.title === 'string') return record.title
  if (typeof record.taskId === 'string') return record.taskId
  if (typeof record.reason === 'string') return record.reason
  return ''
}

function formatToolInput(input: any): string {
  if (input === undefined) return ''
  const str = JSON.stringify(input)
  if (!str) return ''
  return truncateMiddle(str, 72)
}

function formatToolCallName(name: string, formattedInput: string): string {
  if (!formattedInput || formattedInput === undefined) return name
  return `${name}(${formattedInput})`
}

function formatOutput(output: unknown): string {
  if (typeof output === 'string') return output
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

function getLineCount(text: string, columns: number): number {
  const cleanText = stripAnsi(text)
  const lines = cleanText.split('\n')
  let count = 0
  for (let i = 0; i < lines.length; i++) {
    const len = lines[i]!.length
    if (i === lines.length - 1 && len === 0 && cleanText.endsWith('\n')) {
      continue
    }
    count += Math.max(1, Math.ceil(len / columns))
  }
  return count
}
