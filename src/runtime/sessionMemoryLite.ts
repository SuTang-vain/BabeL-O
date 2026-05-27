import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { eventBase, type NexusEvent } from '../shared/events.js'

const SESSION_MEMORY_RELATIVE_PATH = '.babel-o/session-memory.md'
const MAX_SESSION_MEMORY_CHARS = 24_000

export async function updateSessionMemoryLite(options: {
  sessionId: string
  cwd?: string
  trigger: 'manual' | 'auto' | 'reactive'
  summary: string
  eventCount: number
}): Promise<Extract<NexusEvent, { type: 'session_memory_updated' }> | null> {
  if (!isSessionMemoryLiteEnabled()) return null
  if (!options.cwd) return null

  const memoryPath = resolve(options.cwd, SESSION_MEMORY_RELATIVE_PATH)
  const allowedPath = resolve(options.cwd, SESSION_MEMORY_RELATIVE_PATH)
  if (memoryPath !== allowedPath) return null

  const summary = options.summary.trim()
  if (!summary) return null

  await mkdir(dirname(memoryPath), { recursive: true })
  const existing = await readExistingMemory(memoryPath)
  const entry = [
    `## ${new Date().toISOString()} ${options.trigger} compact`,
    '',
    `- Session: ${options.sessionId}`,
    `- Omitted events summarized: ${options.eventCount}`,
    '',
    summary,
    '',
  ].join('\n')
  const next = trimMemory(`${existing}${existing ? '\n' : ''}${entry}`)
  await writeFile(memoryPath, next, 'utf8')

  return {
    type: 'session_memory_updated',
    ...eventBase(options.sessionId),
    path: SESSION_MEMORY_RELATIVE_PATH,
    trigger: options.trigger,
    summaryChars: summary.length,
    eventCount: options.eventCount,
  }
}

function isSessionMemoryLiteEnabled(): boolean {
  const raw = (process.env.BABEL_O_SESSION_MEMORY_LITE ?? '').trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on'
}

async function readExistingMemory(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return ''
  }
}

function trimMemory(content: string): string {
  if (content.length <= MAX_SESSION_MEMORY_CHARS) return content
  return [
    '<!-- Older session memory trimmed by BabeL-O Session Memory Lite. -->',
    content.slice(content.length - MAX_SESSION_MEMORY_CHARS),
  ].join('\n')
}
