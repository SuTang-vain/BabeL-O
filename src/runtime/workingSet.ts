import { existsSync, lstatSync } from 'node:fs'
import { isAbsolute, normalize, resolve } from 'node:path'
import type { NexusEvent } from '../shared/events.js'
import { resolvePromptPath } from './systemPromptBuilder.js'

export type WorkingSetEntry = {
  path: string
  touches: number
  lastTurn: number
  isDir: boolean
  source: 'user' | 'tool'
}

type MutableWorkingSetEntry = WorkingSetEntry & {
  lastSeenTurn: number
}

export const WORKING_SET_LIMIT = 16

export function deriveWorkingSet(events: NexusEvent[], cwd: string): WorkingSetEntry[] {
  const entries = new Map<string, MutableWorkingSetEntry>()
  let turn = 0

  for (const event of events) {
    if (event.type === 'user_message') {
      turn += 1
      for (const path of extractPathsFromText(event.text, cwd)) {
        touchWorkingSetEntry(entries, path, turn, 'user')
      }
    } else if (event.type === 'tool_started') {
      for (const path of extractPathsFromToolInput(event.input, cwd)) {
        touchWorkingSetEntry(entries, path, turn, 'tool')
      }
    }
  }

  return [...entries.values()]
    .sort((left, right) => {
      const scoreCmp = workingSetScore(right, turn) - workingSetScore(left, turn)
      if (scoreCmp !== 0) return scoreCmp
      const touchesCmp = right.touches - left.touches
      if (touchesCmp !== 0) return touchesCmp
      return left.path.localeCompare(right.path)
    })
    .slice(0, WORKING_SET_LIMIT)
    .sort((left, right) => {
      const touchesCmp = right.touches - left.touches
      if (touchesCmp !== 0) return touchesCmp
      return left.path.localeCompare(right.path)
    })
    .map(({ lastSeenTurn: _lastSeenTurn, ...entry }) => entry)
}

export function formatWorkingSet(entries: WorkingSetEntry[]): string {
  if (entries.length === 0) return ''
  return [
    'Working Set:',
    'These paths were recently mentioned or touched by tools. Prefer them for follow-up searches and targeted Read calls unless the latest user request names different paths.',
    ...entries.map(entry => {
      const kind = entry.isDir ? 'dir' : 'file'
      return `- ${entry.path} (${kind}, touches=${entry.touches}, lastTurn=${entry.lastTurn}, source=${entry.source})`
    }),
  ].join('\n')
}

function touchWorkingSetEntry(
  entries: Map<string, MutableWorkingSetEntry>,
  path: string,
  turn: number,
  source: WorkingSetEntry['source'],
): void {
  const normalized = normalize(path)
  const existing = entries.get(normalized)
  if (existing) {
    existing.touches += 1
    existing.lastTurn = turn
    existing.lastSeenTurn = turn
    if (source === 'user') existing.source = 'user'
    return
  }
  entries.set(normalized, {
    path: normalized,
    touches: 1,
    lastTurn: turn,
    lastSeenTurn: turn,
    isDir: isDirectoryPath(normalized),
    source,
  })
}

function workingSetScore(entry: MutableWorkingSetEntry, currentTurn: number): number {
  return entry.touches * 4 + recencyBonus(currentTurn - entry.lastSeenTurn)
}

function recencyBonus(turnsAgo: number): number {
  if (turnsAgo <= 0) return 6
  if (turnsAgo === 1) return 4
  if (turnsAgo === 2) return 3
  if (turnsAgo <= 5) return 2
  if (turnsAgo <= 10) return 1
  return 0
}

function extractPathsFromText(text: string, cwd: string): string[] {
  const paths = new Set<string>()
  for (const path of extractAbsolutePaths(text)) paths.add(path)
  for (const path of extractRelativePaths(text, cwd)) paths.add(path)
  return [...paths]
}

function extractPathsFromToolInput(input: unknown, cwd: string): string[] {
  const paths = new Set<string>()
  collectToolInputPaths(input, cwd, paths)
  return [...paths]
}

function collectToolInputPaths(value: unknown, cwd: string, paths: Set<string>): void {
  if (typeof value === 'string') {
    addPathCandidate(value, cwd, paths)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectToolInputPaths(item, cwd, paths)
    return
  }
  if (typeof value !== 'object' || value === null) return
  for (const [key, nested] of Object.entries(value)) {
    if (isPathKey(key) && typeof nested === 'string') {
      addPathCandidate(nested, cwd, paths)
    } else if (typeof nested === 'object' && nested !== null) {
      collectToolInputPaths(nested, cwd, paths)
    }
  }
}

function addPathCandidate(candidate: string, cwd: string, paths: Set<string>): void {
  if (candidate.trim().length === 0) return
  const resolved = isAbsolute(candidate)
    ? resolvePromptPath(candidate)
    : resolve(cwd, candidate)
  if (isUsefulPath(resolved)) paths.add(resolved)
}

function extractAbsolutePaths(text: string): string[] {
  const paths = new Set<string>()
  const pathPattern = /\/[\w.\-/]+/g
  for (const match of text.matchAll(pathPattern)) {
    if (!hasAbsolutePathBoundary(text, match.index ?? 0)) continue
    const cleaned = match[0].replace(/[.,;:!?]+$/u, '')
    const resolved = resolvePromptPath(cleaned)
    if (isUsefulPath(resolved)) paths.add(resolved)
  }
  return [...paths]
}

function hasAbsolutePathBoundary(text: string, index: number): boolean {
  if (index === 0) return true
  return /[\s"'`([{<，。！？；：、]/u.test(text[index - 1] ?? '')
}

function extractRelativePaths(text: string, cwd: string): string[] {
  const paths = new Set<string>()
  const pathPattern = /(?:\.\.?\/|[\w.-]+\/)[\w.\-/]*/g
  for (const match of text.matchAll(pathPattern)) {
    const candidate = match[0].replace(/[.,;:!?]+$/u, '')
    if (candidate.includes('://')) continue
    addPathCandidate(candidate, cwd, paths)
  }
  return [...paths]
}

function isPathKey(key: string): boolean {
  return key === 'path' || key.endsWith('Path') || key.endsWith('File') || key.endsWith('Dir') || key.endsWith('Directory')
}

function isUsefulPath(path: string): boolean {
  return path !== '/' && path.length > 1
}

function isDirectoryPath(path: string): boolean {
  try {
    return existsSync(path) && lstatSync(path).isDirectory()
  } catch {
    return false
  }
}
