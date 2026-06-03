import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const PERSIST_THRESHOLD = parseInt(process.env.BABEL_O_TOOL_RESULT_THRESHOLD ?? '50000', 10)
const MESSAGE_BUDGET = parseInt(process.env.BABEL_O_TOOL_RESULT_MESSAGE_BUDGET ?? '200000', 10)
const READ_MESSAGE_BUDGET_RATIO = parseFloat(process.env.BABEL_O_READ_MESSAGE_BUDGET_RATIO ?? '0.12')
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

type ContentBlock = { type: string; toolUseId?: string; content?: string; toolName?: string; [key: string]: unknown }

type EnforceMessageBudgetOptions = {
  budget?: number
  contextMaxTokens?: number
  readBudgetChars?: number
}

type ToolResultCandidate = { idx: number; size: number; id: string; toolName?: string }

function resolveBudgetOptions(budgetOrOptions?: number | EnforceMessageBudgetOptions): Required<EnforceMessageBudgetOptions> {
  if (typeof budgetOrOptions === 'number') {
    return {
      budget: budgetOrOptions,
      contextMaxTokens: 0,
      readBudgetChars: Math.max(1, Math.floor(budgetOrOptions * READ_MESSAGE_BUDGET_RATIO)),
    }
  }
  const budget = budgetOrOptions?.budget ?? MESSAGE_BUDGET
  const contextBudget = budgetOrOptions?.contextMaxTokens
    ? Math.max(1, Math.floor(budgetOrOptions.contextMaxTokens * 4 * READ_MESSAGE_BUDGET_RATIO))
    : 0
  return {
    budget,
    contextMaxTokens: budgetOrOptions?.contextMaxTokens ?? 0,
    readBudgetChars: budgetOrOptions?.readBudgetChars ?? (contextBudget || Math.max(1, Math.floor(budget * READ_MESSAGE_BUDGET_RATIO))),
  }
}

async function replaceCandidatesUntilWithinBudget(options: {
  candidates: ToolResultCandidate[]
  blocks: ContentBlock[]
  excess: number
  state: ToolResultReplacementState
  sessionId: string
  cwd: string
}) {
  const candidates = [...options.candidates].sort((a, b) => b.size - a.size)
  let excess = options.excess
  for (const candidate of candidates) {
    if (excess <= 0) break
    const block = options.blocks[candidate.idx]
    const content = block.content as string
    const persisted = await persistToolResult(content, candidate.id, options.sessionId, options.cwd)
    if (persisted) {
      const replacement = buildPersistedMessage(content.length, persisted.preview, persisted.filepath)
      options.blocks[candidate.idx] = { ...block, content: replacement }
      options.state.replacements.set(candidate.id, replacement)
      excess -= (content.length - replacement.length)
    }
  }
}

export async function enforceMessageBudget<T extends { role: string; content: string | ContentBlock[] }>(
  messages: T[],
  state: ToolResultReplacementState,
  sessionId: string,
  cwd: string,
  budgetOrOptions?: number | EnforceMessageBudgetOptions,
): Promise<T[]> {
  const budgets = resolveBudgetOptions(budgetOrOptions)
  const result: T[] = []

  for (const msg of messages) {
    if (msg.role !== 'user' || typeof msg.content === 'string' || !Array.isArray(msg.content)) {
      result.push(msg)
      continue
    }

    let totalChars = 0
    let readChars = 0
    const freshCandidates: ToolResultCandidate[] = []
    const readCandidates: ToolResultCandidate[] = []
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
      const candidate = { idx: i, size: block.content.length, id, toolName: block.toolName }
      totalChars += candidate.size
      freshCandidates.push(candidate)
      if (candidate.toolName === 'Read') {
        readChars += candidate.size
        readCandidates.push(candidate)
      }
    }

    if (readChars > budgets.readBudgetChars && readCandidates.length > 0) {
      await replaceCandidatesUntilWithinBudget({
        candidates: readCandidates,
        blocks,
        excess: readChars - budgets.readBudgetChars,
        state,
        sessionId,
        cwd,
      })
    }

    if (totalChars > budgets.budget && freshCandidates.length > 0) {
      await replaceCandidatesUntilWithinBudget({
        candidates: freshCandidates.filter(candidate => !state.replacements.has(candidate.id)),
        blocks,
        excess: totalChars - budgets.budget,
        state,
        sessionId,
        cwd,
      })
    }

    for (const candidate of freshCandidates) {
      state.seenIds.add(candidate.id)
    }

    result.push({ ...msg, content: blocks } as T)
  }

  return result
}
