/**
 * Optional tail placement for the compaction boundary.
 *
 * Stock places the boundary summary in the system prompt (`system`, default).
 * `BABEL_O_COMPACT_BOUNDARY=tail` moves it into a user message immediately
 * before the current instruction, keeping the static prefix stable for prefix
 * caching. The helper enforces ordering, dedupe, and tool-result safety; the
 * assembly path and the CLI `/compact` path share it.
 */
import type { ModelMessage } from '../providers/adapters/ModelAdapter.js'

export type CompactionBoundaryMode = 'system' | 'tail'

export function resolveCompactionBoundaryMode(
  env: NodeJS.ProcessEnv = process.env,
): CompactionBoundaryMode {
  return (env.BABEL_O_COMPACT_BOUNDARY ?? '').trim().toLowerCase() === 'tail'
    ? 'tail'
    : 'system'
}

export function formatCompactionBoundaryText(summary: string): string {
  return `Context Boundary:\nEarlier conversation was compacted. Treat the recent messages below as the authoritative working history.\n\n${summary}`.trim()
}

export function insertCompactionBoundaryMessage(
  messages: ModelMessage[],
  boundaryText: string,
  currentPrompt: string,
): { messages: ModelMessage[]; inserted: boolean; reason: string } {
  if (!boundaryText.trim()) {
    return { messages, inserted: false, reason: 'empty' }
  }
  const duplicate = messages.some(message =>
    message.role === 'user'
    && typeof message.content === 'string'
    && message.content === boundaryText,
  )
  if (duplicate) {
    return { messages, inserted: false, reason: 'duplicate' }
  }

  const boundaryMessage: ModelMessage = { role: 'user', content: boundaryText }
  const next = [...messages]
  const promptIndex = messages.findLastIndex(message =>
    message.role === 'user'
    && typeof message.content === 'string'
    && message.content === currentPrompt,
  )
  if (promptIndex >= 0) {
    next.splice(promptIndex, 0, boundaryMessage)
    return { messages: next, inserted: true, reason: 'before-current-instruction' }
  }

  const lastUserIndex = messages.findLastIndex(message =>
    message.role === 'user' && typeof message.content === 'string',
  )
  if (lastUserIndex >= 0) {
    next.splice(lastUserIndex, 0, boundaryMessage)
    return { messages: next, inserted: true, reason: 'before-last-user-message' }
  }

  next.push(boundaryMessage)
  return { messages: next, inserted: true, reason: 'appended' }
}
