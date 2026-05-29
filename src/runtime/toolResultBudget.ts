import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const PERSIST_THRESHOLD = parseInt(process.env.BABEL_O_TOOL_RESULT_THRESHOLD ?? '50000', 10)
const MESSAGE_BUDGET = parseInt(process.env.BABEL_O_TOOL_RESULT_MESSAGE_BUDGET ?? '200000', 10)
const PREVIEW_CHARS = parseInt(process.env.BABEL_O_TOOL_RESULT_PREVIEW_CHARS ?? '2000', 10)

export type ToolResultReplacementState = {
  seenIds: Set<string>
  replacements: Map<string, string>
}

export function createReplacementState(): ToolResultReplacementState {
  return { seenIds: new Set(), replacements: new Map() }
}

export async function persistToolResult(
  content: string,
  toolUseId: string,
  sessionId: string,
  cwd: string,
): Promise<{ preview: string; filepath: string } | null> {
  const dir = join(cwd, '.babel-o', 'tool-results', sessionId)
  const filepath = join(dir, `${toolUseId}.txt`)
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(filepath, content, { flag: 'wx' })
  } catch {
    return null
  }
  const preview = content.slice(0, PREVIEW_CHARS)
  return { preview, filepath }
}

function buildPersistedMessage(originalSize: number, preview: string, filepath: string): string {
  const sizeKB = Math.round(originalSize / 1024)
  return `<persisted-output>\nOutput too large (${sizeKB}KB). Full output saved to: ${filepath}\nPreview (first ${PREVIEW_CHARS} chars):\n${preview}\n</persisted-output>`
}

export async function replaceLargeToolResult(options: {
  content: string
  toolUseId: string
  toolName: string
  sessionId: string
  cwd: string
  threshold?: number
}): Promise<string> {
  const threshold = options.toolName === 'Read' ? Infinity : (options.threshold ?? PERSIST_THRESHOLD)
  if (options.content.length <= threshold) return options.content
  const persisted = await persistToolResult(options.content, options.toolUseId, options.sessionId, options.cwd)
  if (!persisted) return options.content
  return buildPersistedMessage(options.content.length, persisted.preview, persisted.filepath)
}

type ContentBlock = { type: string; toolUseId?: string; content?: string; [key: string]: unknown }

export async function enforceMessageBudget<T extends { role: string; content: string | ContentBlock[] }>(
  messages: T[],
  state: ToolResultReplacementState,
  sessionId: string,
  cwd: string,
  budget?: number,
): Promise<T[]> {
  const maxChars = budget ?? MESSAGE_BUDGET
  const result: T[] = []

  for (const msg of messages) {
    if (msg.role !== 'user' || typeof msg.content === 'string' || !Array.isArray(msg.content)) {
      result.push(msg)
      continue
    }

    let totalChars = 0
    const freshCandidates: { idx: number; size: number; id: string }[] = []
    const blocks = [...msg.content]

    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i]
      if (block.type !== 'tool_result' || !block.content || !block.toolUseId) {
        continue
      }
      const id = block.toolUseId
      if (state.seenIds.has(id)) {
        const replacement = state.replacements.get(id)
        if (replacement) {
          blocks[i] = { ...block, content: replacement }
        }
        continue
      }
      totalChars += block.content.length
      freshCandidates.push({ idx: i, size: block.content.length, id })
    }

    if (totalChars > maxChars && freshCandidates.length > 0) {
      freshCandidates.sort((a, b) => b.size - a.size)
      let excess = totalChars - maxChars
      for (const candidate of freshCandidates) {
        if (excess <= 0) break
        const block = blocks[candidate.idx]
        const content = block.content as string
        const persisted = await persistToolResult(content, candidate.id, sessionId, cwd)
        if (persisted) {
          const replacement = buildPersistedMessage(content.length, persisted.preview, persisted.filepath)
          blocks[candidate.idx] = { ...block, content: replacement }
          state.replacements.set(candidate.id, replacement)
          excess -= (content.length - replacement.length)
        }
      }
    }

    for (const candidate of freshCandidates) {
      state.seenIds.add(candidate.id)
    }

    result.push({ ...msg, content: blocks } as T)
  }

  return result
}
