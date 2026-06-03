import type { NexusEvent } from '../shared/events.js'
import type { Skill } from '../skills/loader.js'

const MAX_RESTORED_FILES = 5
const MAX_RESTORED_FILE_CHARS = 5_000
const MAX_RESTORED_TOTAL_CHARS = 12_000

export type RestoredFileContent = {
  path: string
  content: string
  truncated?: boolean
  originalChars?: number
}

export type PostCompactState = {
  recentReadFiles: string[]
  restoredFileContents: RestoredFileContent[]
  activeToolNames: string[]
  activeSkills: string[]
  skillReminderLines: string[]
  mcpToolLines: string[]
  toolContractLines: string[]
  toolFailureLines: string[]
  taskStatusLines: string[]
  agentStatusLines: string[]
  subTaskStatusLines: string[]
  hookLines: string[]
}

export function derivePostCompactState(events: NexusEvent[], matchedSkills: Skill[]): PostCompactState {
  const recentReadFiles: string[] = []
  const restoredFileContents: RestoredFileContent[] = []
  const seenFiles = new Set<string>()
  let restoredCharsRemaining = MAX_RESTORED_TOTAL_CHARS
  const activeToolNames: string[] = []
  const seenTools = new Set<string>()
  const mcpToolLines: string[] = []
  const seenMcpToolUseIds = new Set<string>()
  const toolFailureLines: string[] = []
  const taskStatusLines: string[] = []
  const agentStatusLines: string[] = []
  const subTaskStatusLines: string[] = []
  const hookLines: string[] = []

  for (let idx = events.length - 1; idx >= 0; idx--) {
    const event = events[idx]
    if (event.type === 'tool_completed') {
      const name = event.name
      if (isMcpToolName(name)) {
        const toolUseId = (event as { toolUseId?: string }).toolUseId
        if (!toolUseId || !seenMcpToolUseIds.has(toolUseId)) {
          if (toolUseId) seenMcpToolUseIds.add(toolUseId)
          mcpToolLines.unshift(`- [${event.success ? 'completed' : 'failed'}] ${name}`)
        }
      }
      if (!event.success) {
        const failureLine = formatToolFailureLine(event)
        if (failureLine) toolFailureLines.unshift(failureLine)
      }
      if (event.success) {
        if (name && !seenTools.has(name)) {
          seenTools.add(name)
          activeToolNames.unshift(name)
        }
        if (name === 'Read' && restoredFileContents.length < MAX_RESTORED_FILES && restoredCharsRemaining > 0) {
          const output = (event as { output?: unknown }).output
          if (typeof output === 'string' && output.length > 0) {
            const toolUseId = (event as { toolUseId?: string }).toolUseId
            const startedEvent = events.find(e => e.type === 'tool_started' && (e as { toolUseId?: string }).toolUseId === toolUseId) as { input?: { path?: string } } | undefined
            const path = startedEvent?.input?.path
            if (path && !seenFiles.has(path)) {
              const restored = buildRestoredFileContent(path, output, restoredCharsRemaining)
              restoredFileContents.unshift(restored)
              restoredCharsRemaining -= restored.content.length
            }
          }
        }
      }
    }
    if (event.type === 'tool_started') {
      const name = event.name
      if (isMcpToolName(name)) {
        const toolUseId = (event as { toolUseId?: string }).toolUseId
        if (!toolUseId || !seenMcpToolUseIds.has(toolUseId)) {
          if (toolUseId) seenMcpToolUseIds.add(toolUseId)
          mcpToolLines.unshift(`- [started] ${name}`)
        }
      }
      if (name === 'Read' || name === 'Write' || name === 'Edit') {
        const input = (event as { input?: Record<string, unknown> }).input
        const path = (event as { path?: string }).path
          || (event as { filePath?: string }).filePath
          || (input && typeof input.path === 'string' ? input.path : undefined)
        if (path && !seenFiles.has(path)) {
          seenFiles.add(path)
          recentReadFiles.unshift(path)
        }
      }
    }
    if (event.type === 'tool_denied') {
      const name = event.name
      if (isMcpToolName(name)) {
        mcpToolLines.unshift(`- [denied] ${name}`)
      }
    }
    if (event.type === 'task_created') {
      const taskEvent = event as { taskId?: string; title?: string }
      if (taskEvent.title) {
        taskStatusLines.unshift(`- [created] ${taskEvent.title}`)
      }
    }
    if (event.type === 'task_session_event') {
      const taskEvent = event as { phase?: string; eventType?: string; eventId?: string; payload?: unknown }
      if (taskEvent.phase || taskEvent.eventType) {
        taskStatusLines.unshift(`- [${taskEvent.eventType ?? 'task'}] ${taskEvent.phase ?? taskEvent.eventId ?? ''}`)
      }
      const agentLine = formatAgentStatusLine(taskEvent)
      if (agentLine) agentStatusLines.unshift(agentLine)
      const subTaskLine = formatSubTaskStatusLine(taskEvent)
      if (subTaskLine) subTaskStatusLines.unshift(subTaskLine)
    }
    if (event.type === 'hook_completed') {
      const hookEvent = event as { hookName?: string; hookEvent?: string }
      hookLines.unshift(`- ${hookEvent.hookName ?? 'hook'} (${hookEvent.hookEvent ?? 'unknown'})`)
    }
  }

  const activeSkills = matchedSkills.map(s => s.id)

  return {
    recentReadFiles: recentReadFiles.slice(0, 10),
    restoredFileContents,
    activeToolNames: activeToolNames.slice(0, 10),
    activeSkills,
    skillReminderLines: matchedSkills.map(formatSkillReminderLine).slice(0, 5),
    mcpToolLines: mcpToolLines.slice(0, 5),
    toolContractLines: buildToolContractLines(activeToolNames, restoredFileContents, mcpToolLines),
    toolFailureLines: toolFailureLines.slice(0, 5),
    taskStatusLines: taskStatusLines.slice(0, 10),
    agentStatusLines: agentStatusLines.slice(0, 8),
    subTaskStatusLines: subTaskStatusLines.slice(0, 8),
    hookLines: hookLines.slice(0, 5),
  }
}

export function formatPostCompactState(state: PostCompactState): string {
  const parts: string[] = []
  if (state.recentReadFiles.length > 0) {
    parts.push(`Recently accessed files: ${state.recentReadFiles.join(', ')}`)
  }
  if (state.activeToolNames.length > 0) {
    parts.push(`Active tools: ${state.activeToolNames.join(', ')}`)
  }
  if (state.activeSkills.length > 0) {
    parts.push(`Active skills: ${state.activeSkills.join(', ')}`)
  }
  if (state.skillReminderLines.length > 0) {
    parts.push(`Skill reminders:\n${state.skillReminderLines.join('\n')}`)
  }
  if (state.mcpToolLines.length > 0) {
    parts.push(`MCP tool audit:\n${state.mcpToolLines.join('\n')}`)
  }
  if (state.toolContractLines.length > 0) {
    parts.push(`Tool contract reminders:\n${state.toolContractLines.join('\n')}`)
  }
  if (state.toolFailureLines.length > 0) {
    parts.push(`Recent tool failures:\n${state.toolFailureLines.join('\n')}`)
  }
  if (state.taskStatusLines.length > 0) {
    parts.push(`Task status:\n${state.taskStatusLines.join('\n')}`)
  }
  if (state.agentStatusLines.length > 0) {
    parts.push(`Agent status:\n${state.agentStatusLines.join('\n')}`)
  }
  if (state.subTaskStatusLines.length > 0) {
    parts.push(`Sub-task status:\n${state.subTaskStatusLines.join('\n')}`)
  }
  if (state.hookLines.length > 0) {
    parts.push(`Hook activity:\n${state.hookLines.join('\n')}`)
  }
  if (state.restoredFileContents.length > 0) {
    const fileBlocks = state.restoredFileContents.map(formatRestoredFileContent).join('\n\n')
    parts.push(`## Restored File Contents (from pre-compact reads)\n${fileBlocks}`)
  }
  return parts.length > 0 ? `## Post-Compact State\n${parts.join('\n')}` : ''
}

function buildRestoredFileContent(
  path: string,
  output: string,
  remainingChars: number,
): RestoredFileContent {
  const maxChars = Math.max(0, Math.min(MAX_RESTORED_FILE_CHARS, remainingChars))
  const content = output.slice(0, maxChars)
  return {
    path,
    content,
    ...(content.length < output.length && {
      truncated: true,
      originalChars: output.length,
    }),
  }
}

function formatRestoredFileContent(file: RestoredFileContent): string {
  const suffix = file.truncated
    ? `\n[restored content truncated at ${file.content.length}/${file.originalChars ?? file.content.length} chars]`
    : ''
  return `### ${file.path}\n\`\`\`\n${file.content}${suffix}\n\`\`\``
}

function isMcpToolName(name: string | undefined): boolean {
  return typeof name === 'string' && name.startsWith('mcp:')
}

function formatSkillReminderLine(skill: Skill): string {
  const triggerSuffix = skill.triggers.length > 0 ? ` triggers=${skill.triggers.join(',')}` : ''
  return `- ${skill.id} (${skill.name})${triggerSuffix}`
}

function formatToolFailureLine(event: Extract<NexusEvent, { type: 'tool_completed' }>): string | null {
  const output = (event as { output?: unknown }).output
  const outputRecord = asRecord(output)
  const code = stringValue(outputRecord.code)
  const message = stringValue(outputRecord.message)
  if (!code && !message) return `- [failed] ${event.name}`
  return `- [failed] ${event.name}${code ? ` ${code}` : ''}${message ? ` · ${message}` : ''}`
}

function buildToolContractLines(
  activeToolNames: string[],
  restoredFileContents: RestoredFileContent[],
  mcpToolLines: string[],
): string[] {
  const lines = ['- Preserve exact tool_use/tool_result pairing across compact boundaries.']
  if (activeToolNames.includes('Read') || restoredFileContents.length > 0) {
    lines.push('- Treat restored file contents as a snapshot; re-read before editing if freshness matters.')
  }
  if (activeToolNames.includes('Write') || activeToolNames.includes('Edit')) {
    lines.push('- Do not infer file writes from history; verify current file state before reporting edits.')
  }
  if (mcpToolLines.length > 0) {
    lines.push('- MCP tools may have external side effects; rely only on completed audit entries.')
  }
  return lines
}

function formatAgentStatusLine(event: { eventType?: string; phase?: string; payload?: unknown }): string | null {
  if (!event.eventType || !isAgentEventType(event.eventType)) return null
  const payload = asRecord(event.payload)
  const status = stringValue(payload.status) ?? statusFromAgentEventType(event.eventType)
  const title = stringValue(payload.title)
  const taskId = stringValue(payload.taskId)
  const subSessionId = stringValue(payload.subSessionId)
  const label = title ?? taskId ?? subSessionId ?? event.phase ?? 'agent'
  return `- [${status}] ${event.eventType} ${label}`
}

function formatSubTaskStatusLine(event: { eventType?: string; payload?: unknown }): string | null {
  if (!event.eventType) return null
  const payload = asRecord(event.payload)
  if (event.eventType === 'subtasks_delegated') {
    const subTasks = Array.isArray(payload.subTasks) ? payload.subTasks : []
    const titles = subTasks
      .map(subTask => stringValue(asRecord(subTask).title))
      .filter((title): title is string => Boolean(title))
      .slice(0, 3)
    const ids = Array.isArray(payload.subTaskIds) ? payload.subTaskIds.map(String).slice(0, 3) : []
    const accepted = numberValue(payload.accepted)
    const count = accepted ?? (subTasks.length || ids.length)
    const summary = titles.length > 0 ? titles.join(', ') : ids.join(', ')
    return `- [delegated] ${count} sub-task(s)${summary ? `: ${summary}` : ''}`
  }
  if (event.eventType === 'subtasks_rejected_depth_limit') {
    return `- [rejected] sub-tasks depth limit reached`
  }
  if (event.eventType === 'task_blocked') {
    const task = asRecord(payload.task)
    const title = stringValue(task.title)
    const taskId = stringValue(task.taskId)
    return `- [blocked] ${title ?? taskId ?? 'parent task'}`
  }
  return null
}

function isAgentEventType(eventType: string): boolean {
  return eventType === 'sub_agent_session_started'
    || eventType === 'sub_agent_session_completed'
    || eventType === 'sub_agent_session_failed'
    || eventType === 'sub_agent_session_error'
    || eventType === 'subagent_started'
    || eventType === 'subagent_completed'
    || eventType === 'subagent_cancelled'
    || eventType === 'subagent_failed'
    || eventType === 'subagent_permission_inheritance'
}

function statusFromAgentEventType(eventType: string): string {
  if (eventType.includes('completed')) return 'completed'
  if (eventType.includes('cancelled')) return 'cancelled'
  if (eventType.includes('failed') || eventType.includes('error')) return 'failed'
  if (eventType.includes('permission')) return 'permission'
  return 'running'
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function buildCompactCapabilityReminder(state: PostCompactState): string {
  const lines: string[] = []
  lines.push('## Compact Capability Reminder')
  lines.push('The conversation above has been compacted. The summary above captures the key context.')
  if (state.restoredFileContents.length > 0) {
    lines.push(`File contents restored above for ${state.restoredFileContents.length} file(s). Only re-read if you need to verify changes since then.`)
  } else if (state.recentReadFiles.length > 0) {
    lines.push(`Previously read files: ${state.recentReadFiles.join(', ')}. Contents were too large to restore — re-read only the specific sections you need.`)
  }
  if (state.skillReminderLines.length > 0) {
    lines.push('Active skill reminders have been re-announced above; continue following those instructions until the prompt changes scope.')
  }
  if (state.mcpToolLines.length > 0) {
    lines.push('MCP tool activity is listed above for audit continuity; do not assume an MCP side effect succeeded unless the audit line says it completed.')
  }
  if (state.taskStatusLines.length > 0) {
    lines.push('The task list above shows current progress. Continue working on incomplete items.')
  }
  if (state.agentStatusLines.length > 0 || state.subTaskStatusLines.length > 0) {
    lines.push('Agent and sub-task summaries above identify delegated work that may need resume, review, or cleanup.')
  }
  if (state.toolContractLines.length > 0) {
    lines.push(`Tool contract reminders: ${state.toolContractLines.join(' ')}`)
  }
  lines.push('Important: tool_use and tool_result pairs must remain matched — do not generate one without the other.')
  return lines.join(' ')
}
