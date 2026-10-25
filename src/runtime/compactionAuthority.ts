/**
 * SHA-backed authority for post-compaction grounding.
 *
 * A digest record may be treated as authoritative only when it binds a
 * machine-checkable fact to the current artifact hash. Instructions
 * (`contract` / `open_task`) are never "authoritative": they are pinned, not
 * verified. Grounding is narrowed to the records that are actually
 * provisional, instead of the blanket five-kind re-read.
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { NexusEvent } from '../shared/events.js'

export type GroundingKind =
  | 'file_facts'
  | 'test_results'
  | 'git_status'
  | 'task_completion'
  | 'implementation_status'

export type GroundingAction =
  | 're_read_referenced_files'
  | 'inspect_changed_files'
  | 'inspect_git_status'
  | 'run_focused_tests'
  | 'inspect_event_log'

export type AuthorityRecordKind =
  | 'fact'
  | 'failure'
  | 'artifact'
  | 'contract'
  | 'open_task'
  | 'test_result'
  | 'git_status'

export type AuthorityRecord = {
  id: string
  kind: AuthorityRecordKind
  subject: string
  value: string
  evidence: {
    type: 'file' | 'git' | 'tool'
    ref: string
    sha256?: string
  }
  status: 'authoritative' | 'provisional' | 'superseded'
  turn: number
}

export type AuthorityContext = {
  currentTurn: number
  fileHashes?: Readonly<Record<string, string>>
  trustTurns?: number
}

export type AuthorityClass = 'authoritative' | 'provisional' | 'superseded' | 'pinned'

export type GroundingScope = {
  requiredFor: GroundingKind[]
  suggestedActions: GroundingAction[]
  provisionalSubjects: string[]
  pinnedSubjects: string[]
}

const PINNED_KINDS: ReadonlySet<AuthorityRecordKind> = new Set(['contract', 'open_task'])

export function classifyAuthority(
  record: AuthorityRecord,
  context: AuthorityContext,
): AuthorityClass {
  if (record.status === 'superseded') return 'superseded'
  if (PINNED_KINDS.has(record.kind)) return 'pinned'
  if (record.kind === 'test_result') return 'provisional'
  if (record.kind === 'git_status' && !record.evidence.sha256) return 'provisional'

  const trustTurns = context.trustTurns ?? 0
  const fresh = record.turn >= context.currentTurn - trustTurns
  const hasProvenance = Boolean(record.evidence.sha256)
    && (record.evidence.type === 'file' || record.evidence.type === 'git' || record.evidence.type === 'tool')
  const hashMatches = hasProvenance
    && record.evidence.sha256 === context.fileHashes?.[record.subject]
  return fresh && hasProvenance && hashMatches ? 'authoritative' : 'provisional'
}

export function deriveGroundingScope(
  records: readonly AuthorityRecord[],
  context: AuthorityContext,
): GroundingScope {
  const requiredFor = new Set<GroundingKind>()
  const suggestedActions = new Set<GroundingAction>()
  const provisionalSubjects: string[] = []
  const pinnedSubjects: string[] = []

  for (const record of records) {
    const authority = classifyAuthority(record, context)
    if (authority === 'authoritative' || authority === 'superseded') continue
    if (authority === 'pinned') {
      pinnedSubjects.push(record.subject)
      continue
    }
    provisionalSubjects.push(record.subject)
    if (record.kind === 'failure' || record.kind === 'test_result') {
      requiredFor.add('test_results')
      suggestedActions.add('run_focused_tests')
    } else if (record.kind === 'git_status') {
      requiredFor.add('git_status')
      suggestedActions.add('inspect_git_status')
    } else {
      requiredFor.add('file_facts')
      suggestedActions.add('re_read_referenced_files')
    }
  }

  return {
    requiredFor: [...requiredFor],
    suggestedActions: [...suggestedActions],
    provisionalSubjects,
    pinnedSubjects,
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function resolvePath(cwd: string, path: string): string {
  return isAbsolute(path) ? path : join(cwd, path)
}

/**
 * Derive a grounding scope from the events instead of assuming every compact
 * boundary invalidates every fact. Only files whose latest Read content no
 * longer matches disk, and test evidence that was actually observed, require
 * re-grounding.
 */
export async function computeGroundingScopeFromEvents(
  events: readonly NexusEvent[],
  cwd: string,
): Promise<GroundingScope | undefined> {
  if (!cwd) return undefined

  const readPathByToolUseId = new Map<string, string>()
  const latestReadOutputs = new Map<string, string>()
  const testToolUseIds = new Set<string>()

  for (const event of events) {
    if (event.type === 'tool_started') {
      if (event.name === 'Read') {
        const path = (event.input as { path?: unknown } | undefined)?.path
        if (typeof path === 'string' && path.length > 0) {
          readPathByToolUseId.set(event.toolUseId, path)
        }
      } else if (event.name === 'Bash') {
        const command = (event.input as { command?: unknown } | undefined)?.command
        if (typeof command === 'string'
          && /\b(npm (run )?test|node --test|pytest|vitest|jest|go test|cargo test)\b/.test(command)) {
          testToolUseIds.add(event.toolUseId)
        }
      }
      continue
    }
    if (event.type !== 'tool_completed' || !event.success) continue
    const readPath = readPathByToolUseId.get(event.toolUseId)
    if (readPath && typeof event.output === 'string') {
      latestReadOutputs.set(readPath, event.output)
    }
  }

  const requiredFor = new Set<GroundingKind>()
  const suggestedActions = new Set<GroundingAction>()
  const provisionalSubjects: string[] = []

  for (const [path, output] of latestReadOutputs) {
    let current: string
    try {
      current = await readFile(resolvePath(cwd, path), 'utf8')
    } catch {
      requiredFor.add('file_facts')
      suggestedActions.add('re_read_referenced_files')
      provisionalSubjects.push(path)
      continue
    }
    if (sha256(current) !== sha256(output)) {
      requiredFor.add('file_facts')
      suggestedActions.add('re_read_referenced_files')
      provisionalSubjects.push(path)
    }
  }

  if (testToolUseIds.size > 0) {
    requiredFor.add('test_results')
    suggestedActions.add('run_focused_tests')
  }

  return {
    requiredFor: [...requiredFor],
    suggestedActions: [...suggestedActions],
    provisionalSubjects,
    pinnedSubjects: [],
  }
}
