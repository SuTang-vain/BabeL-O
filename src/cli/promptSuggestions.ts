export type SessionHintState = {
  hasSession: boolean
  lastEventType?: string
  taskCount?: number
  pendingTaskCount?: number
  failedTaskCount?: number
  agentRunning?: boolean
  lastToolName?: string
  turnCount?: number
}

const SUGGESTIONS_POOL = [
  'Ask a question about your code...',
  'Describe a task or bug to fix...',
  'Type / for commands, @ to mention files',
]

export function getPromptSuggestion(state: SessionHintState): string | undefined {
  if (state.agentRunning) return undefined

  if (!state.hasSession || !state.turnCount) {
    return SUGGESTIONS_POOL[0]
  }

  if (state.failedTaskCount && state.failedTaskCount > 0) {
    return 'A task failed — ask to retry or investigate'
  }

  if (state.pendingTaskCount && state.pendingTaskCount > 0) {
    return `${state.pendingTaskCount} pending task(s) — continue or ask for status`
  }

  if (state.lastEventType === 'tool_completed' && state.lastToolName === 'Read') {
    return 'File loaded — ask a question or request changes'
  }

  if (state.lastEventType === 'tool_completed' && state.lastToolName === 'Bash') {
    return 'Command finished — ask about the output or next step'
  }

  if (state.lastEventType === 'result') {
    return 'Follow up, start a new task, or type /compact'
  }

  return undefined
}
