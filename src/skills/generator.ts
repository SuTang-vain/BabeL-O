/**
 * Skill generator — Phase 4 of the Skill execution governance plan.
 *
 * Generates a normalized skill draft from structured inputs:
 *   - user-provided description / title
 *   - optional session summary
 *   - optional tool outcomes
 *   - optional trigger hints
 *
 * The generator never writes files. The draft is an in-memory `NormalizedSkill`
 * with status='draft' and scope=user/project, returned to the caller for
 * preview + validation + explicit save (Phase 5).
 *
 * Quality requirements (per plan §Draft quality requirements):
 *   1. Stable `id` (kebab-case derived from title or description).
 *   2. Clear `description`.
 *   3. At least two meaningful triggers unless `explicitOnly`.
 *   4. `Procedure` + `Failure handling` sections.
 *   5. Tool policy expectations.
 *   6. Redaction pass for tokens / private paths.
 *   7. No claim of permission bypass.
 *
 * Failure semantics (per integration index §5.2):
 *   - Never throw for user-side validation issues; return `SkillDraftResult`
 *     with `ok: false` and structured diagnostics.
 *   - errorCodes: `SKILL_DRAFT_INVALID_TITLE`, `SKILL_DRAFT_REDACTION_FAILED`,
 *     `SKILL_DRAFT_VALIDATION_FAILED`, `SKILL_DRAFT_ID_CONFLICT`.
 */

import { validateSkill } from './validator.js'
import type { NormalizedSkill, SkillDiagnostic } from './schema.js'

export type SkillDraftInput = {
  /** User-provided short title (used to derive id if `idHint` is missing). */
  title: string
  /** Optional longer description. */
  description?: string
  /** Optional explicit id (kebab-case). If omitted, derived from `title`. */
  idHint?: string
  /** Optional trigger hints; defaults are derived from `title` tokens. */
  triggers?: string[]
  /** If true, the draft has no triggers and must be invoked explicitly. */
  explicitOnly?: boolean
  /** Optional session summary excerpt to embed in body. */
  sessionSummary?: string
  /** Optional tool outcomes excerpt to embed in body. */
  toolOutcomes?: string
  /** Optional risk hint; defaults to 'read'. */
  risk?: 'read' | 'write' | 'execute' | 'network' | 'task'
  /** Optional allowedTools list (advisory). */
  allowedTools?: string[]
  /** Target scope for save. */
  scope?: 'user' | 'project'
}

export type SkillDraftResult =
  | {
      ok: true
      draft: NormalizedSkill
      body: string
      redactionWarnings: SkillDiagnostic[]
      validationWarnings: SkillDiagnostic[]
    }
  | {
      ok: false
      errorCode: 'SKILL_DRAFT_INVALID_TITLE' | 'SKILL_DRAFT_ID_CONFLICT' | 'SKILL_DRAFT_VALIDATION_FAILED'
      message: string
      diagnostics: SkillDiagnostic[]
    }

// --- redaction -------------------------------------------------------------

const REDACTION_PATTERNS: Array<{ code: string; re: RegExp; label: string }> = [
  // Bearer / API key style tokens
  { code: 'TOKEN_BEARER', re: /\b[A-Za-z0-9_-]{32,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g, label: 'bearer-style token' },
  // sk-..., ghp_..., gho_..., ghu_..., ghs_..., ghr_...
  { code: 'TOKEN_PROVIDER_PREFIX', re: /\b(sk-|ghp_|gho_|ghu_|ghs_|ghr_|xai-|ant-|sk_|sk-)[A-Za-z0-9_-]{8,}\b/g, label: 'provider API key' },
  // Bearer "..."
  { code: 'TOKEN_BEARER_HEADER', re: /Bearer\s+[A-Za-z0-9._\-+/=]{8,}/g, label: 'Bearer header' },
  // Long opaque hex / base64
  { code: 'TOKEN_LONG_HEX', re: /\b[a-f0-9]{40,}\b/gi, label: 'long hex token' },
  // Long base64
  { code: 'TOKEN_LONG_BASE64', re: /\b[A-Za-z0-9+/]{64,}={0,2}\b/g, label: 'long base64 token' },
  // Common absolute private paths (Linux/macOS user home)
  { code: 'PATH_PRIVATE_HOME', re: /\/(home|Users)\/[A-Za-z0-9._-]+\/(?:[^\s)"]*)/g, label: 'absolute private home path' },
]

export type RedactionResult = {
  redacted: string
  warnings: SkillDiagnostic[]
}

/** Strip dangerous tokens / paths from a string. Returns redacted text + warnings. */
export function redact(input: string): RedactionResult {
  const warnings: SkillDiagnostic[] = []
  let redacted = input
  for (const { code, re, label } of REDACTION_PATTERNS) {
    redacted = redacted.replace(re, match => {
      warnings.push({
        severity: 'warning',
        code,
        message: `Redacted ${label} (${match.length} chars) from draft body.`,
      })
      return `[REDACTED:${label}]`
    })
  }
  return { redacted, warnings }
}

// --- id derivation ---------------------------------------------------------

const ID_KEBAB_RE = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/

/** Derive a stable kebab-case id from free text. Returns null if no usable token. */
export function deriveId(text: string): string | null {
  if (!text) return null
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6)
    .join('-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!slug) return null
  if (!ID_KEBAB_RE.test(slug)) return null
  return slug
}

// --- main entry point ------------------------------------------------------

/**
 * Generate a normalized skill draft.
 *
 * The draft is *not* persisted. The caller decides whether to surface a
 * preview, then call Phase 5 `SkillSave` (a future endpoint) after explicit
 * confirmation.
 */
export function generateSkillDraft(input: SkillDraftInput): SkillDraftResult {
  // 1. Title is mandatory.
  const title = (input.title ?? '').trim()
  if (!title) {
    return {
      ok: false,
      errorCode: 'SKILL_DRAFT_INVALID_TITLE',
      message: 'Skill draft requires a non-empty `title`.',
      diagnostics: [
        {
          severity: 'error',
          code: 'SKILL_DRAFT_INVALID_TITLE',
          message: 'Title is required to generate a skill draft.',
          field: 'title',
        },
      ],
    }
  }

  // 2. idHint or derived id.
  const requestedId = (input.idHint ?? '').trim() || deriveId(title) || ''
  if (!requestedId) {
    return {
      ok: false,
      errorCode: 'SKILL_DRAFT_INVALID_TITLE',
      message: 'Could not derive a stable kebab-case id from title or idHint.',
      diagnostics: [
        {
          severity: 'error',
          code: 'SKILL_DRAFT_ID_CONFLICT',
          message: 'id derivation failed; provide an explicit `idHint` in kebab-case.',
          field: 'idHint',
        },
      ],
    }
  }
  if (!ID_KEBAB_RE.test(requestedId)) {
    return {
      ok: false,
      errorCode: 'SKILL_DRAFT_ID_CONFLICT',
      message: `Derived id "${requestedId}" is not a valid kebab-case identifier.`,
      diagnostics: [
        {
          severity: 'error',
          code: 'SKILL_DRAFT_ID_CONFLICT',
          message: 'id must be lowercase kebab-case (2..64 chars, [a-z0-9-]).',
          field: 'idHint',
        },
      ],
    }
  }

  // 3. Triggers: explicit ones OR derived from title tokens OR empty (explicitOnly).
  let triggers: string[]
  if (input.triggers && input.triggers.length > 0) {
    triggers = input.triggers.map(t => t.trim()).filter(Boolean)
  } else if (input.explicitOnly) {
    triggers = []
  } else {
    // Derive triggers from title tokens: keep 2..4 short tokens.
    const tokens = title
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(t => t.length >= 3 && t.length <= 20)
      .slice(0, 4)
    triggers = tokens
  }
  if (!input.explicitOnly && triggers.length < 2) {
    return {
      ok: false,
      errorCode: 'SKILL_DRAFT_INVALID_TITLE',
      message: 'Implicit skill drafts require at least 2 trigger tokens. Pass `explicitOnly: true` to skip.',
      diagnostics: [
        {
          severity: 'error',
          code: 'SKILL_DRAFT_TRIGGERS_INSUFFICIENT',
          message: 'Provide more trigger tokens or set `explicitOnly: true`.',
          field: 'triggers',
        },
      ],
    }
  }

  // 4. Body: redacted, structured.
  const rawBody = buildBody(input)
  const redaction = redact(rawBody)

  // 5. Description: prefer input.description; fall back to title.
  const description = (input.description ?? '').trim() || title

  // 6. Compose raw skill for validator.
  const raw = {
    id: requestedId,
    name: title,
    description,
    version: 1,
    status: 'draft' as const,
    scope: input.scope ?? 'project',
    triggers,
    priority: 50,
    risk: input.risk ?? 'read',
    allowedTools: input.allowedTools ?? [],
    content: redaction.redacted,
  }

  // 7. Validate.
  const validation = validateSkill(raw)
  if (!validation.ok || !validation.normalized) {
    return {
      ok: false,
      errorCode: 'SKILL_DRAFT_VALIDATION_FAILED',
      message: `Draft for "${requestedId}" failed validation.`,
      diagnostics: validation.diagnostics,
    }
  }

  // Force status='draft' and version=1 regardless of validator output.
  const draft: NormalizedSkill = {
    ...validation.normalized,
    status: 'draft',
    version: 1,
  }

  // 8. Validation warnings (not errors) get surfaced alongside redaction.
  const validationWarnings = validation.diagnostics.filter(d => d.severity !== 'error')

  return {
    ok: true,
    draft,
    body: redaction.redacted,
    redactionWarnings: redaction.warnings,
    validationWarnings,
  }
}

// --- body template ---------------------------------------------------------

function buildBody(input: SkillDraftInput): string {
  const lines: string[] = []
  lines.push(`# Purpose`)
  lines.push('')
  lines.push((input.description ?? '').trim() || `Help with: ${input.title}.`)
  lines.push('')

  if (input.explicitOnly) {
    lines.push(`# When to use`)
    lines.push('')
    lines.push(`- Explicit invocation only (no implicit triggers).`)
    lines.push('')
  } else {
    const triggerList = (input.triggers && input.triggers.length > 0
      ? input.triggers
      : (input.title
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          .filter(t => t.length >= 3 && t.length <= 20)
          .slice(0, 4)
        )
    ).map(t => `- \`${t}\``).join('\n')
    lines.push(`# When to use`)
    lines.push('')
    if (triggerList) lines.push(triggerList)
    lines.push('')
  }

  lines.push(`# Inputs`)
  lines.push('')
  lines.push(`- User prompt context`)
  if (input.sessionSummary) {
    lines.push(`- Session summary (provided at capture time)`)
  }
  if (input.toolOutcomes) {
    lines.push(`- Tool outcomes (provided at capture time)`)
  }
  lines.push('')

  lines.push(`# Procedure`)
  lines.push('')
  lines.push(`1. Read the user task carefully.`)
  lines.push(`2. Apply the relevant guidance.`)
  if (input.sessionSummary) {
    lines.push(`3. Reference the captured session summary as background.`)
  }
  if (input.toolOutcomes) {
    lines.push(`4. Reference the captured tool outcomes as evidence.`)
  }
  lines.push('')

  lines.push(`# Tool policy`)
  lines.push('')
  lines.push(`- Prefer read-only tools where possible.`)
  if (input.allowedTools && input.allowedTools.length > 0) {
    lines.push(`- May use: ${input.allowedTools.map(t => `\`${t}\``).join(', ')}`)
  }
  lines.push(`- All tool calls still go through runtime permission gates.`)
  lines.push('')

  lines.push(`# Output format`)
  lines.push('')
  lines.push(`- Return the result in the same form as a normal assistant turn.`)
  lines.push('')

  lines.push(`# Failure handling`)
  lines.push('')
  lines.push(`- If the requested tool is denied, surface the soft-deny diagnostic and try a read-only alternative.`)
  lines.push(`- If required context is missing, ask the user for clarification.`)
  lines.push(`- Do not claim authority to bypass runtime permissions.`)
  lines.push('')

  if (input.sessionSummary) {
    lines.push(`# Captured session summary`)
    lines.push('')
    lines.push(input.sessionSummary.trim())
    lines.push('')
  }

  if (input.toolOutcomes) {
    lines.push(`# Captured tool outcomes`)
    lines.push('')
    lines.push(input.toolOutcomes.trim())
    lines.push('')
  }

  return lines.join('\n')
}
