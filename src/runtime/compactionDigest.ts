/**
 * Deterministic, structured compaction digest (T2).
 *
 * Unlike the prose summary, this is built from event metadata only: no LLM
 * call, no free-form narrative. Records are keyed by subject, merged
 * idempotently, and bounded by an explicit record budget so the digest cannot
 * grow with session length.
 */
import { createHash } from 'node:crypto'
import type { NexusEvent } from '../shared/events.js'

export type DigestRecordKind =
  | 'contract'
  | 'open_task'
  | 'failure'
  | 'decision'
  | 'artifact'
  | 'fact'

export type DigestRecord = {
  id: string
  kind: DigestRecordKind
  subject: string
  value: string
  evidence: {
    type: 'file' | 'git' | 'tool' | 'user'
    ref: string
    sha256?: string
  }
  turn: number
  status: 'authoritative' | 'provisional'
}

export type CompactionDigest = {
  version: 1
  records: DigestRecord[]
}

export type DigestOptions = {
  maxRecords?: number
  maxValueChars?: number
}

const KIND_PRIORITY: Record<DigestRecordKind, number> = {
  contract: 0,
  open_task: 1,
  failure: 2,
  decision: 3,
  artifact: 4,
  fact: 5,
}

const DEFAULT_MAX_RECORDS = 24
const DEFAULT_MAX_VALUE_CHARS = 220
const MAX_CONTRACTS = 4
const MAX_FAILURES = 4
const MAX_ARTIFACTS = 8
const MAX_FACTS = 12

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function truncate(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length <= maxChars
    ? normalized
    : `${normalized.slice(0, Math.max(0, maxChars - 1))}…`
}

function stringifyOutput(output: unknown): string {
  return typeof output === 'string' ? output : JSON.stringify(output)
}

function boundDigest(digest: CompactionDigest, maxRecords: number): CompactionDigest {
  const sorted = [...digest.records].sort((left, right) =>
    KIND_PRIORITY[left.kind] - KIND_PRIORITY[right.kind]
    || right.turn - left.turn
    || left.subject.localeCompare(right.subject),
  )
  const kept = sorted.slice(0, Math.max(1, maxRecords))
  const ordered = [...kept].sort((left, right) =>
    KIND_PRIORITY[left.kind] - KIND_PRIORITY[right.kind]
    || left.turn - right.turn
    || left.subject.localeCompare(right.subject),
  )
  return { version: 1, records: ordered }
}

export function buildDeterministicDigest(
  events: readonly NexusEvent[],
  options: DigestOptions = {},
): CompactionDigest {
  const maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS
  const maxValueChars = options.maxValueChars ?? DEFAULT_MAX_VALUE_CHARS
  const pathByToolUseId = new Map<string, string>()
  const users: Array<{ turn: number; text: string }> = []
  const reads = new Map<string, { turn: number; toolUseId: string; output: string }>()
  const artifacts = new Map<string, { turn: number; toolUseId: string; name: string }>()
  const failures: Array<{ turn: number; toolUseId: string; name: string; output: string }> = []
  let turn = 0

  for (const event of events) {
    if (event.type === 'user_message') {
      turn += 1
      users.push({ turn, text: event.text })
      continue
    }
    if (event.type === 'tool_started') {
      const path = (event.input as { path?: unknown } | undefined)?.path
      if (typeof path === 'string' && path.length > 0) {
        pathByToolUseId.set(event.toolUseId, path)
      }
      if ((event.name === 'Write' || event.name === 'Edit') && typeof path === 'string') {
        artifacts.set(path, { turn, toolUseId: event.toolUseId, name: event.name })
      }
      continue
    }
    if (event.type !== 'tool_completed') continue
    if (!event.success) {
      failures.push({
        turn,
        toolUseId: event.toolUseId,
        name: event.name,
        output: stringifyOutput(event.output),
      })
      continue
    }
    if (event.name !== 'Read') continue
    const path = pathByToolUseId.get(event.toolUseId)
    if (!path) continue
    reads.set(path, {
      turn,
      toolUseId: event.toolUseId,
      output: stringifyOutput(event.output),
    })
  }

  const records: DigestRecord[] = []
  for (const user of users.slice(-MAX_CONTRACTS)) {
    records.push({
      id: `contract:user:${user.turn}`,
      kind: 'contract',
      subject: `user:${user.turn}`,
      value: truncate(user.text, maxValueChars),
      evidence: { type: 'user', ref: `user:${user.turn}` },
      turn: user.turn,
      status: 'provisional',
    })
  }
  for (const failure of failures.slice(-MAX_FAILURES)) {
    records.push({
      id: `failure:${failure.toolUseId}`,
      kind: 'failure',
      subject: `tool:${failure.name}`,
      value: truncate(failure.output, maxValueChars),
      evidence: { type: 'tool', ref: failure.toolUseId },
      turn: failure.turn,
      status: 'provisional',
    })
  }
  for (const [path, artifact] of [...artifacts.entries()].slice(-MAX_ARTIFACTS)) {
    records.push({
      id: `artifact:${artifact.toolUseId}`,
      kind: 'artifact',
      subject: `file:${path}`,
      value: artifact.name,
      evidence: { type: 'tool', ref: artifact.toolUseId },
      turn: artifact.turn,
      status: 'provisional',
    })
  }
  for (const [path, read] of [...reads.entries()].slice(-MAX_FACTS)) {
    records.push({
      id: `fact:${read.toolUseId}`,
      kind: 'fact',
      subject: `file:${path}`,
      value: `read ${read.output.length} chars`,
      evidence: {
        type: 'tool',
        ref: read.toolUseId,
        sha256: sha256(read.output),
      },
      turn: read.turn,
      status: 'provisional',
    })
  }

  return boundDigest({ version: 1, records }, maxRecords)
}

export function normalizeCompactionDigest(value: unknown): CompactionDigest | undefined {
  if (!value || typeof value !== 'object') return undefined
  const candidate = value as Partial<CompactionDigest>
  if (candidate.version !== 1 || !Array.isArray(candidate.records)) return undefined
  const records = candidate.records.filter((record): record is DigestRecord => {
    return Boolean(record
      && typeof record === 'object'
      && typeof (record as DigestRecord).subject === 'string'
      && typeof (record as DigestRecord).kind === 'string'
      && typeof (record as DigestRecord).turn === 'number')
  })
  return { version: 1, records }
}

export function mergeDigests(
  previous: CompactionDigest,
  delta: CompactionDigest,
  options: DigestOptions = {},
): CompactionDigest {
  const bySubject = new Map<string, DigestRecord>()
  for (const record of [...previous.records, ...delta.records]) {
    const existing = bySubject.get(record.subject)
    if (!existing || record.turn >= existing.turn) {
      bySubject.set(record.subject, record)
    }
  }
  return boundDigest({ version: 1, records: [...bySubject.values()] }, options.maxRecords ?? DEFAULT_MAX_RECORDS)
}

export function renderDigest(digest: CompactionDigest, maxChars = 6_000): string {
  const lines = ['## Compaction Digest (deterministic)']
  let used = lines[0]!.length + 1
  for (const record of digest.records) {
    const sha = record.evidence.sha256 ? ` sha:${record.evidence.sha256.slice(0, 12)}` : ''
    const line = `- [${record.kind}] ${record.subject}: ${record.value}${sha}`
    if (used + line.length + 1 > maxChars) {
      lines.push('- … (digest truncated)')
      break
    }
    lines.push(line)
    used += line.length + 1
  }
  return lines.join('\n')
}
