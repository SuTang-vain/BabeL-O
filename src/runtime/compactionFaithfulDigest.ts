/**
 * Faithful compaction digest (opt-in prototype, P-next).
 *
 * Design contract (differs from the T2 deterministic digest):
 *
 * 1. **Extractive only.** Every carried value is a verbatim slice of a source
 *    event (user text, tool input path/command, tool output excerpt) or a
 *    verbatim structured field (scope/permission metadata). The digest never
 *    paraphrases, rewrites, or re-derives facts.
 * 2. **Immutable anchors.** The most recent user instruction is kept verbatim
 *    and is never truncated below `maxInstructionChars` (default 8000; any
 *    truncation is explicitly marked). Paths, git SHAs, test commands, and
 *    scope/permission constraints are preserved as first-class sections.
 * 3. **No recursive compaction.** A new digest is built ONLY from raw omitted
 *    events. A previous faithful digest is carried as an opaque, verbatim
 *    `carried` subtree — never merged, re-keyed, re-truncated, or otherwise
 *    re-compressed (contrast `mergeDigests`, which re-bounds old records).
 * 4. **Opt-in.** Active only when `BABEL_O_COMPACT_MODE=adaptive` AND
 *    `BABEL_O_COMPACT_FAITHFUL_DIGEST` is truthy. Stock mode is untouched.
 *
 * Stored in the `compact_boundary.digest` field (`z.unknown()`) with
 * `version: 2`, so the T2 `normalizeCompactionDigest` (version 1) safely
 * ignores it and vice versa.
 */
import type { NexusEvent } from '../shared/events.js'

export type FaithfulTestCommand = {
  command: string
  outcome: 'pass' | 'fail' | 'unknown'
}

export type FaithfulFailure = {
  tool: string
  excerpt: string
}

export type FaithfulDigest = {
  version: 2
  kind: 'faithful-digest'
  /** Raw omitted events this delta was built from (evidence count). */
  builtFromEvents: number
  /** Anchors dropped by per-section caps (evicted oldest-first). */
  overflow?: Partial<Record<'paths' | 'shas' | 'constraints' | 'scopeConstraints' | 'testCommands' | 'failures' | 'userQuotes', number>>
  /** Most recent user message in the omitted set; verbatim. */
  instruction?: string
  /**
   * Verbatim prose summary text from a pre-faithful boundary, carried once
   * when a session switches into faithful mode mid-flight. Never re-summarized.
   */
  carriedProse?: string
  /** Verbatim imperative sentences extracted from user messages. */
  constraints: string[]
  /** Verbatim file paths from tool inputs (deduped, newest last). */
  paths: string[]
  /** Verbatim git SHAs (40-hex anywhere; short SHAs from git bash output). */
  shas: string[]
  /** Verbatim Bash commands matching a test-runner pattern, with outcome. */
  testCommands: FaithfulTestCommand[]
  /** Verbatim scope/permission constraint lines (structured event fields). */
  scopeConstraints: string[]
  /** Verbatim failure excerpts (truncated, marked). */
  failures: FaithfulFailure[]
  /** Earlier user messages, verbatim, each capped at maxQuoteChars. */
  userQuotes: string[]
  /** Previous faithful digest, carried verbatim. Never re-built or merged. */
  carried?: FaithfulDigest
}

export type FaithfulDigestOptions = {
  maxInstructionChars?: number
  maxQuotes?: number
  maxQuoteChars?: number
  maxConstraints?: number
  maxPaths?: number
  maxShas?: number
  maxTestCommands?: number
  maxScopeConstraints?: number
  maxFailures?: number
  maxFailureChars?: number
}

const DEFAULTS = {
  maxInstructionChars: 8_000,
  maxQuotes: 6,
  maxQuoteChars: 280,
  maxConstraints: 12,
  maxPaths: 24,
  maxShas: 12,
  maxTestCommands: 12,
  maxScopeConstraints: 12,
  maxFailures: 6,
  maxFailureChars: 200,
} satisfies Required<FaithfulDigestOptions>

const CONSTRAINT_PATTERN = /(?:^|[.!?\n])\s*([^.!?\n]*(?:must|never|always|keep|unchanged|do not|don't|exactly|verbatim|不要|不能|不得|必须|保持不变)[^.!?\n]*)/gi

const FULL_SHA_PATTERN = /\b[0-9a-f]{40}\b/g
const SHORT_SHA_PATTERN = /\b[0-9a-f]{7,10}\b/g

const TEST_COMMAND_PATTERN = /(?:^|\s|&&|;|\|)(npm\s+(?:run\s+)?(?:test|lint|typecheck)|node\s+(?:--test\s+)?\S*test\S*|npx\s+tsx\s+--test\S*|tsx\s+--test\s+\S*|go\s+test\S*|pytest\S*|cargo\s+test\S*|vitest\S*|jest\S*|make\s+test\S*)/

export function isFaithfulDigestEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.BABEL_O_COMPACT_FAITHFUL_DIGEST ?? '').trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on'
}

function truncateMarked(value: string, maxChars: number): string {
  // Byte-faithful: no whitespace normalization; truncation is explicit.
  const trimmed = value.replace(/^\n+|\n+$/g, '')
  return trimmed.length <= maxChars
    ? trimmed
    : `${trimmed.slice(0, Math.max(0, maxChars - 1))}…[truncated ${trimmed.length - maxChars + 1} chars]`
}

function stringifyOutput(output: unknown): string {
  return typeof output === 'string' ? output : JSON.stringify(output)
}

function pushUnique(list: string[], value: string, cap: number, onEvict?: () => void): void {
  if (!value) return
  const existing = list.indexOf(value)
  if (existing !== -1) list.splice(existing, 1)
  list.push(value)
  while (list.length > cap) {
    list.shift()
    onEvict?.()
  }
}

/** Extract verbatim constraint sentences from user text. */
export function extractConstraintSentences(userText: string): string[] {
  const out: string[] = []
  for (const match of userText.matchAll(CONSTRAINT_PATTERN)) {
    const sentence = match[1]?.trim()
    if (sentence && !out.includes(sentence)) out.push(sentence)
  }
  return out
}

/** Build a faithful digest delta from RAW omitted events only. */
export function buildFaithfulDigest(
  events: readonly NexusEvent[],
  options: FaithfulDigestOptions = {},
): FaithfulDigest {
  const opts = { ...DEFAULTS, ...options }
  const digest: FaithfulDigest = {
    version: 2,
    kind: 'faithful-digest',
    builtFromEvents: events.length,
    constraints: [],
    paths: [],
    shas: [],
    testCommands: [],
    scopeConstraints: [],
    failures: [],
    userQuotes: [],
  }

  const users: string[] = []
  const bashOutcomeByToolUseId = new Map<string, boolean>()
  const bashCommandByToolUseId = new Map<string, string>()
  const testCommandByToolUseId = new Map<string, string>()
  const permissionNameByToolUseId = new Map<string, string>()
  const overflow: NonNullable<FaithfulDigest['overflow']> = {}
  const evict = (key: keyof NonNullable<FaithfulDigest['overflow']>) => () => {
    overflow[key] = (overflow[key] ?? 0) + 1
  }

  for (const event of events) {
    switch (event.type) {
      case 'user_message': {
        users.push(event.text)
        for (const sha of event.text.match(FULL_SHA_PATTERN) ?? []) {
          pushUnique(digest.shas, sha, opts.maxShas)
        }
        for (const sentence of extractConstraintSentences(event.text)) {
          pushUnique(digest.constraints, truncateMarked(sentence, opts.maxQuoteChars), opts.maxConstraints, evict('constraints'))
        }
        break
      }
      case 'tool_started': {
        const input = event.input as { path?: unknown, command?: unknown, pattern?: unknown } | undefined
        const path = typeof input?.path === 'string' ? input.path
          : typeof input?.pattern === 'string' ? input.pattern
          : undefined
        if (path) pushUnique(digest.paths, path, opts.maxPaths, evict('paths'))
        if (event.name === 'Bash' && typeof input?.command === 'string') {
          bashCommandByToolUseId.set(event.toolUseId, input.command)
          if (TEST_COMMAND_PATTERN.test(input.command)) {
            testCommandByToolUseId.set(event.toolUseId, input.command)
          }
        }
        break
      }
      case 'tool_completed': {
        const output = stringifyOutput(event.output) ?? ''
        if (!event.success) {
          digest.failures.push({
            tool: event.name,
            excerpt: truncateMarked(output, opts.maxFailureChars),
          })
          if (digest.failures.length > opts.maxFailures) {
            digest.failures.shift()
            evict('failures')()
          }
        }
        if (bashOutcomeByToolUseId.has(event.toolUseId) || testCommandByToolUseId.has(event.toolUseId)) {
          bashOutcomeByToolUseId.set(event.toolUseId, event.success)
        }
        for (const sha of output.match(FULL_SHA_PATTERN) ?? []) {
          pushUnique(digest.shas, sha, opts.maxShas, evict('shas'))
        }
        // Short SHAs are anchors too, but only inside git-command output
        // (elsewhere 7-10 hex tokens are too ambiguous).
        const bashCommand = bashCommandByToolUseId.get(event.toolUseId)
        if (bashCommand && /\bgit\b/.test(bashCommand)) {
          for (const sha of output.match(SHORT_SHA_PATTERN) ?? []) {
            if (!/^\d+$/.test(sha)) pushUnique(digest.shas, sha, opts.maxShas, evict('shas'))
          }
        }
        break
      }
      case 'permission_request': {
        permissionNameByToolUseId.set(event.toolUseId, event.name)
        if (event.scopeRisk && event.scopeRisk !== 'none') {
          pushUnique(
            digest.scopeConstraints,
            `scope boundary: ${event.name} -> ${event.targetRoot ?? '?'} risk=${event.scopeRisk}`,
            opts.maxScopeConstraints,
            evict('scopeConstraints'),
          )
        }
        break
      }
      case 'permission_response': {
        const name = permissionNameByToolUseId.get(event.toolUseId) ?? event.toolUseId
        const rule = event.rule ? ` rule=${event.rule}` : ''
        pushUnique(
          digest.scopeConstraints,
          `permission: ${name} ${event.approved ? 'approved' : 'DENIED'} scope=${event.scope ?? 'once'}${rule}`,
          opts.maxScopeConstraints,
          evict('scopeConstraints'),
        )
        break
      }
      case 'tool_denied': {
        pushUnique(
          digest.scopeConstraints,
          `denied: ${event.name} kind=${event.denialKind ?? 'policy'} ${truncateMarked(event.message, 120)}`,
          opts.maxScopeConstraints,
          evict('scopeConstraints'),
        )
        break
      }
      case 'scope_boundary_detected': {
        pushUnique(
          digest.scopeConstraints,
          `scope boundary: ${event.toolName} -> ${event.targetRoot} kind=${event.boundaryKind} action=${event.action}`,
          opts.maxScopeConstraints,
          evict('scopeConstraints'),
        )
        break
      }
      case 'scope_boundary_confirmed': {
        pushUnique(
          digest.scopeConstraints,
          `scope confirmed: ${event.targetRoot} scope=${event.confirmationScope} by=${event.confirmedBy}`,
          opts.maxScopeConstraints,
          evict('scopeConstraints'),
        )
        break
      }
      default:
        break
    }
  }

  if (users.length > 0) {
    digest.instruction = truncateMarked(users[users.length - 1]!, opts.maxInstructionChars)
    const earlier = users.slice(0, -1)
    for (const text of earlier.slice(-opts.maxQuotes)) {
      digest.userQuotes.push(truncateMarked(text, opts.maxQuoteChars))
    }
    if (earlier.length > opts.maxQuotes) overflow.userQuotes = earlier.length - opts.maxQuotes
  }

  for (const [toolUseId, command] of testCommandByToolUseId) {
    const success = bashOutcomeByToolUseId.get(toolUseId)
    digest.testCommands.push({
      command,
      outcome: success === undefined ? 'unknown' : success ? 'pass' : 'fail',
    })
    if (digest.testCommands.length > opts.maxTestCommands) {
      digest.testCommands.shift()
      evict('testCommands')()
    }
  }

  if (Object.keys(overflow).length > 0) digest.overflow = overflow
  return digest
}

/**
 * Carry a previous faithful digest verbatim into the new one. The carried
 * subtree is attached by reference-semantics (deep-copied at render/storage
 * time by JSON serialization) and is NEVER merged into or rebuilt from the
 * new delta.
 */
export function carryFaithfulDigest(
  previous: FaithfulDigest,
  delta: FaithfulDigest,
): FaithfulDigest {
  return { ...delta, carried: previous }
}

export function normalizeFaithfulDigest(value: unknown): FaithfulDigest | undefined {
  if (!value || typeof value !== 'object') return undefined
  const candidate = value as Partial<FaithfulDigest>
  if (candidate.version !== 2 || candidate.kind !== 'faithful-digest') return undefined
  const stringArray = (v: unknown): string[] => Array.isArray(v) ? v.filter(x => typeof x === 'string') : []
  const carried = normalizeFaithfulDigest(candidate.carried)
  return {
    version: 2,
    kind: 'faithful-digest',
    builtFromEvents: typeof candidate.builtFromEvents === 'number' ? candidate.builtFromEvents : 0,
    ...(typeof candidate.instruction === 'string' ? { instruction: candidate.instruction } : {}),
    constraints: stringArray(candidate.constraints),
    paths: stringArray(candidate.paths),
    shas: stringArray(candidate.shas),
    testCommands: Array.isArray(candidate.testCommands)
      ? candidate.testCommands.filter((c): c is FaithfulTestCommand => Boolean(
          c && typeof c === 'object'
          && typeof (c as FaithfulTestCommand).command === 'string'
          && ['pass', 'fail', 'unknown'].includes((c as FaithfulTestCommand).outcome),
        ))
      : [],
    ...(typeof candidate.carriedProse === 'string' ? { carriedProse: candidate.carriedProse } : {}),
    ...(candidate.overflow && typeof candidate.overflow === 'object'
      ? { overflow: Object.fromEntries(Object.entries(candidate.overflow).filter(([, v]) => typeof v === 'number')) as FaithfulDigest['overflow'] }
      : {}),
    scopeConstraints: stringArray(candidate.scopeConstraints),
    failures: Array.isArray(candidate.failures)
      ? candidate.failures.filter((f): f is FaithfulFailure => Boolean(
          f && typeof f === 'object'
          && typeof (f as FaithfulFailure).tool === 'string'
          && typeof (f as FaithfulFailure).excerpt === 'string',
        ))
      : [],
    userQuotes: stringArray(candidate.userQuotes),
    ...(carried ? { carried } : {}),
  }
}

/**
 * Render with a hard character budget. The instruction section is always
 * emitted in full; remaining sections are emitted in anchor-priority order;
 * the carried previous digest is rendered last and truncated (render-only —
 * the stored carried subtree is never altered).
 */
export function renderFaithfulDigest(digest: FaithfulDigest, maxChars = 6_000): string {
  const lines: string[] = ['## Faithful Compaction Digest (extractive; no rewriting)']
  let used = lines[0]!.length + 1

  const push = (line: string): boolean => {
    if (used + line.length + 1 > maxChars) return false
    lines.push(line)
    used += line.length + 1
    return true
  }

  if (digest.instruction) {
    lines.push('### Most recent user instruction (verbatim)')
    lines.push(digest.instruction)
    used += digest.instruction.length + 42
  }
  const sections: Array<[string, string[]]> = [
    ['Constraints (verbatim from user)', digest.constraints],
    ['Test commands (verbatim)', digest.testCommands.map(c => `\`${c.command}\` -> ${c.outcome}`)],
    ['Scope / permission constraints', digest.scopeConstraints],
    ['Paths', digest.paths],
    ['Git SHAs', digest.shas],
    ['Tool failures (verbatim excerpts)', digest.failures.map(f => `${f.tool}: ${f.excerpt}`)],
    ['Earlier user messages (verbatim)', digest.userQuotes],
  ]
  let truncated = false
  for (const [title, items] of sections) {
    if (items.length === 0) continue
    if (!push(`### ${title}`)) { truncated = true; break }
    for (const item of items) {
      if (!push(`- ${item}`)) { truncated = true; break }
    }
    if (truncated) break
  }
  const overflowNotes = Object.entries(digest.overflow ?? {})
  if (overflowNotes.length > 0) {
    push(`### Anchor overflow (oldest evicted): ${overflowNotes.map(([k, v]) => `${k} -${v}`).join(', ')}`)
  }
  if (digest.carriedProse) {
    const marker = '### Carried prior prose summary (verbatim, not re-summarized)'
    if (push(marker)) {
      const remaining = maxChars - used - 40
      if (remaining > 80) {
        push(digest.carriedProse.length <= remaining
          ? digest.carriedProse
          : `${digest.carriedProse.slice(0, remaining)}\n- …[carried prose render truncated]`)
      } else {
        truncated = true
      }
    } else {
      truncated = true
    }
  }
  if (digest.carried) {
    const marker = '### Carried previous digest (verbatim, not re-summarized)'
    if (push(marker)) {
      // Render the carried chain directly into the remaining budget; the
      // stored subtree is never altered (render-only truncation), and we
      // never materialize an unbounded intermediate string.
      const remaining = maxChars - used - 40
      if (remaining > 80) {
        const nested = renderFaithfulDigest(digest.carried, remaining)
        push(nested)
      } else {
        truncated = true
      }
    } else {
      truncated = true
    }
  }
  if (truncated) lines.push('- … (digest truncated to budget)')
  return lines.join('\n')
}
