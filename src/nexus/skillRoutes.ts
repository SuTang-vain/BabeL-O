/**
 * Nexus route schemas for `/v1/skills/*`.
 *
 * Phase 3 of the Skill execution governance plan: expose the SkillRegistry
 * via HTTP for the Go TUI and any future clients. Minimum P1 endpoints:
 *   GET  /v1/skills
 *   GET  /v1/skills/:id
 *   POST /v1/skills/validate
 *   POST /v1/skills/invoke
 *
 * Failure semantics (per `tool-governance-reference-integration.md` §5.2):
 *   - Endpoints never throw to fastify; they return `{ ok: false, errorCode, message, ... }`.
 *   - errorCode values: `SKILL_NOT_FOUND`, `SKILL_INVALID_PAYLOAD`, `SKILL_LOAD_FAILED`,
 *     `SKILL_INVOKE_DRY_RUN_FAILED`.
 *   - All error paths include structured diagnostics, not bare throw.
 *
 * Test isolation: endpoints take `cwd` from query / body and never touch the
 * real `~/.babel-o/skills` unless cwd points there explicitly. Tests use a
 * tmp dir as cwd.
 */

import { z } from 'zod'
import { loadSkillRegistry, validateRegistrySkill } from '../skills/registry.js'
import { validateSkill } from '../skills/validator.js'
import { formatSkill } from '../skills/formatter.js'
import { generateSkillDraft, type SkillDraftInput } from '../skills/generator.js'
import { previewSkillSave, saveSkill, type SkillSaveInput } from '../skills/storage.js'
import type { NormalizedSkill, SkillDiagnostic } from '../skills/schema.js'

export const SkillListQuerySchema = z.object({
  cwd: z.string().optional(),
  source: z.enum(['builtin', 'user', 'project']).optional(),
  status: z.enum(['active', 'draft', 'disabled']).optional(),
  builtInDir: z.string().optional(),
})

export const SkillIdParamsSchema = z.object({
  id: z.string().min(1),
})

export const SkillValidateBodySchema = z.object({
  cwd: z.string().optional(),
  body: z.string().optional(),
  id: z.string().optional(),
})

export const SkillInvokeBodySchema = z.object({
  cwd: z.string().optional(),
  builtInDir: z.string().optional(),
  id: z.string(),
  prompt: z.string().min(1),
  mode: z.enum(['explicit', 'implicit']).default('explicit'),
})

export const SkillDraftBodySchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  idHint: z.string().optional(),
  triggers: z.array(z.string()).optional(),
  explicitOnly: z.boolean().optional(),
  sessionSummary: z.string().optional(),
  toolOutcomes: z.string().optional(),
  risk: z.enum(['read', 'write', 'execute', 'network', 'task']).optional(),
  allowedTools: z.array(z.string()).optional(),
  scope: z.enum(['user', 'project']).optional(),
})

const NormalizedSkillSchema = z.object({
  id: z.string(),
  name: z.string(),
  triggers: z.array(z.string()),
  priority: z.number(),
  content: z.string(),
  version: z.number(),
  status: z.string(),
  description: z.string(),
  source: z.enum(['builtin', 'user', 'project']),
  scope: z.enum(['builtin', 'user', 'project']),
  risk: z.enum(['read', 'write', 'execute', 'network', 'task']),
  allowedTools: z.array(z.string()),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  owner: z.string().optional(),
  filePath: z.string().optional(),
})

export const SkillSaveBodySchema = z.object({
  cwd: z.string().optional(),
  builtInDir: z.string().optional(),
  draft: NormalizedSkillSchema,
  confirm: z.boolean().default(false),
  overwrite: z.boolean().optional(),
  scope: z.enum(['user', 'project']).optional(),
})

export type SkillListQuery = z.infer<typeof SkillListQuerySchema>
export type SkillValidateBody = z.infer<typeof SkillValidateBodySchema>
export type SkillInvokeBody = z.infer<typeof SkillInvokeBodySchema>
export type SkillDraftBody = z.infer<typeof SkillDraftBodySchema>
export type SkillSaveBody = z.infer<typeof SkillSaveBodySchema>

export type SkillListResponse = {
  ok: boolean
  skills: Array<{
    id: string
    name: string
    description: string
    source: 'builtin' | 'user' | 'project'
    scope: 'builtin' | 'user' | 'project'
    status: 'active' | 'draft' | 'disabled'
    risk: 'read' | 'write' | 'execute' | 'network' | 'task'
    triggers: string[]
    priority: number
    allowedTools: string[]
    filePath?: string
  }>
  diagnostics: {
    skippedCount: number
    overlaidCount: number
    duplicateCount: number
  }
}

export type SkillShowResponse =
  | {
      ok: true
      skill: SkillListResponse['skills'][number] & { body: string }
    }
  | {
      ok: false
      errorCode: 'SKILL_NOT_FOUND' | 'SKILL_LOAD_FAILED'
      message: string
      id: string
    }

export type SkillValidateResponse = {
  ok: boolean
  skillId?: string
  diagnostics: Array<{
    severity: 'error' | 'warning' | 'info'
    code: string
    message: string
    field?: string
  }>
  errorCount: number
  warningCount: number
}

export type SkillInvokeResponse =
  | {
      ok: true
      skillId: string
      mode: 'explicit' | 'implicit'
      source: 'builtin' | 'user' | 'project'
      promptEnvelope: string
    }
  | {
      ok: false
      errorCode: 'SKILL_NOT_FOUND' | 'SKILL_INVOKE_DRY_RUN_FAILED' | 'SKILL_LOAD_FAILED'
      message: string
      id?: string
    }

export type SkillDraftResponse =
  | {
      ok: true
      draft: SkillListResponse['skills'][number] & {
        body: string
        status: 'draft'
      }
      redactionWarnings: SkillDiagnostic[]
      validationWarnings: SkillDiagnostic[]
    }
  | {
      ok: false
      errorCode:
        | 'SKILL_DRAFT_INVALID_TITLE'
        | 'SKILL_DRAFT_ID_CONFLICT'
        | 'SKILL_DRAFT_VALIDATION_FAILED'
      message: string
      diagnostics: SkillDiagnostic[]
    }

export type SkillSavePreviewResponse = {
  ok: true
  previewOnly: true
  scope: 'user' | 'project'
  filePath: string
  body: string
  isNewFile: boolean
  duplicateWarnings: Array<{
    code: 'SKILL_SAVE_DUPLICATE_ID' | 'SKILL_SAVE_DUPLICATE_NAME' | 'SKILL_SAVE_DUPLICATE_TRIGGERS'
    message: string
    conflictingId?: string
  }>
}

export type SkillSaveSuccessResponse = {
  ok: true
  scope: 'user' | 'project'
  filePath: string
  format: 'overwrite' | 'new'
  saved: {
    type: 'skill_saved'
    schemaVersion: string
    sessionId: string
    timestamp: string
    skillId: string
    scope: 'user' | 'project'
    filePath: string
    format: 'new' | 'overwrite'
  }
}

export type SkillSaveErrorResponse = {
  ok: false
  errorCode:
    | 'SKILL_SAVE_NOT_CONFIRMED'
    | 'SKILL_SAVE_DUPLICATE_ID'
    | 'SKILL_SAVE_DUPLICATE_NAME'
    | 'SKILL_SAVE_DUPLICATE_TRIGGERS'
    | 'SKILL_SAVE_OVERWRITE_REQUIRED'
    | 'SKILL_SAVE_INVALID_DRAFT'
    | 'SKILL_SAVE_PERSIST_FAILED'
    | 'SKILL_SAVE_SCOPE_INVALID'
  message: string
  preview?: SkillSavePreviewResponse
}

export type SkillSaveResponse = SkillSavePreviewResponse | SkillSaveSuccessResponse | SkillSaveErrorResponse

/** List visible skills for a given cwd. */
export async function listSkills(options: {
  cwd: string
  source?: 'builtin' | 'user' | 'project'
  status?: 'active' | 'draft' | 'disabled'
  builtInDir?: string
}): Promise<SkillListResponse> {
  const reg = await loadSkillRegistry({
    cwd: options.cwd,
    ...(options.builtInDir ? { builtInDir: options.builtInDir } : {}),
  })
  let skills = reg.list()
  if (options.source) skills = skills.filter(s => s.source === options.source)
  if (options.status) skills = skills.filter(s => s.status === options.status)
  const diag = reg.diagnose()
  return {
    ok: true,
    skills: skills.map(s => ({
      id: s.id,
      name: s.name,
      description: s.description,
      source: s.source,
      scope: s.scope,
      status: s.status,
      risk: s.risk,
      triggers: s.triggers,
      priority: s.priority,
      allowedTools: s.allowedTools,
      ...(s.filePath ? { filePath: s.filePath } : {}),
    })),
    diagnostics: {
      skippedCount: diag.skipped.length,
      overlaidCount: diag.overlaid.length,
      duplicateCount: diag.duplicateIds.length,
    },
  }
}

/** Show a single skill by id, including its body. */
export async function showSkill(options: {
  cwd: string
  id: string
  builtInDir?: string
}): Promise<SkillShowResponse> {
  try {
    const reg = await loadSkillRegistry({
      cwd: options.cwd,
      ...(options.builtInDir ? { builtInDir: options.builtInDir } : {}),
    })
    const skill = reg.get(options.id)
    if (!skill) {
      return {
        ok: false,
        errorCode: 'SKILL_NOT_FOUND',
        id: options.id,
        message: `Skill "${options.id}" not found in registry (cwd=${options.cwd}).`,
      }
    }
    return {
      ok: true,
      skill: {
        id: skill.id,
        name: skill.name,
        description: skill.description,
        source: skill.source,
        scope: skill.scope,
        status: skill.status,
        risk: skill.risk,
        triggers: skill.triggers,
        priority: skill.priority,
        allowedTools: skill.allowedTools,
        ...(skill.filePath ? { filePath: skill.filePath } : {}),
        body: formatSkill(skill),
      },
    }
  } catch (err) {
    return {
      ok: false,
      errorCode: 'SKILL_LOAD_FAILED',
      id: options.id,
      message: err instanceof Error ? err.message : String(err),
    }
  }
}

/** Validate a skill: either by registry id (cwd) or by raw body. */
export async function validateSkillRequest(options: SkillValidateBody): Promise<SkillValidateResponse> {
  if (options.body) {
    // Validate raw markdown body (file-write path, not load path).
    const { parseFrontMatter } = await import('../skills/loader.js')
    const raw = parseFrontMatter(options.body)
    if (!raw) {
      return {
        ok: false,
        diagnostics: [
          {
            severity: 'error',
            code: 'SKILL_PARSE_FAILED',
            message: 'Failed to parse front matter (missing/invalid id or delimiters).',
          },
        ],
        errorCount: 1,
        warningCount: 0,
      }
    }
    const result = validateSkill(raw)
    return {
      ok: result.ok,
      skillId: raw.id,
      diagnostics: result.diagnostics.map(d => ({
        severity: d.severity,
        code: d.code,
        message: d.message,
        ...(d.field ? { field: d.field } : {}),
      })),
      errorCount: result.diagnostics.filter(d => d.severity === 'error').length,
      warningCount: result.diagnostics.filter(d => d.severity === 'warning').length,
    }
  }
  if (options.id) {
    if (!options.cwd) {
      return {
        ok: false,
        diagnostics: [
          {
            severity: 'error',
            code: 'SKILL_INVALID_PAYLOAD',
            message: '`cwd` is required when validating by `id`.',
            field: 'cwd',
          },
        ],
        errorCount: 1,
        warningCount: 0,
      }
    }
    const reg = await loadSkillRegistry({ cwd: options.cwd })
    const result = validateRegistrySkill(reg, options.id)
    if (!result) {
      return {
        ok: false,
        skillId: options.id,
        diagnostics: [
          {
            severity: 'error',
            code: 'SKILL_NOT_FOUND',
            message: `Skill "${options.id}" not found in registry.`,
          },
        ],
        errorCount: 1,
        warningCount: 0,
      }
    }
    return {
      ok: result.ok,
      skillId: options.id,
      diagnostics: result.diagnostics.map(d => ({
        severity: d.severity,
        code: d.code,
        message: d.message,
        ...(d.field ? { field: d.field } : {}),
      })),
      errorCount: result.diagnostics.filter(d => d.severity === 'error').length,
      warningCount: result.diagnostics.filter(d => d.severity === 'warning').length,
    }
  }
  return {
    ok: false,
    diagnostics: [
      {
        severity: 'error',
        code: 'SKILL_INVALID_PAYLOAD',
        message: 'Either `body` (raw markdown) or `id` + `cwd` is required.',
      },
    ],
    errorCount: 1,
    warningCount: 0,
  }
}

/**
 * Invoke a skill. Phase 3 implements a dry-run prompt envelope only — the
 * actual runtime submission is deferred to a later phase. This matches the
 * governance plan §Implementation phases Phase 3 exit criterion:
 *   "/skill run <id> <prompt> using explicit prompt envelope".
 *
 * Returns a `promptEnvelope` string the caller can submit to the runtime.
 */
export async function invokeSkill(options: SkillInvokeBody): Promise<SkillInvokeResponse> {
  try {
    const cwd = options.cwd ?? process.cwd()
    const reg = await loadSkillRegistry({
      cwd,
      ...(options.builtInDir ? { builtInDir: options.builtInDir } : {}),
    })
    const skill = reg.get(options.id)
    if (!skill) {
      return {
        ok: false,
        errorCode: 'SKILL_NOT_FOUND',
        message: `Skill "${options.id}" not found in registry (cwd=${cwd}).`,
        id: options.id,
      }
    }
    const promptEnvelope = `Use the following developer skill explicitly for this task.\n\n<skill id="${skill.id}" name="${skill.name}" source="${skill.source}" risk="${skill.risk}">\n${formatSkill(skill)}\n</skill>\n\nUser task:\n${options.prompt}\n`
    return {
      ok: true,
      skillId: skill.id,
      mode: options.mode,
      source: skill.source,
      promptEnvelope,
    }
  } catch (err) {
    return {
      ok: false,
      errorCode: 'SKILL_INVOKE_DRY_RUN_FAILED',
      message: err instanceof Error ? err.message : String(err),
    }
  }
}

/**
 * Generate a normalized skill draft. Phase 4 of the governance plan.
 *
 * The draft is *not* persisted. The caller is expected to:
 *   1. Surface a preview (incl. body + diagnostics).
 *   2. Get explicit user confirmation.
 *   3. Call Phase 5 save endpoint to persist (future work).
 *
 * Redaction warnings (e.g. detected API key in `sessionSummary`) are returned
 * alongside validation warnings so the user can see what was stripped.
 */
export async function generateDraftHandler(input: SkillDraftInput): Promise<SkillDraftResponse> {
  const result = generateSkillDraft(input)
  if (!result.ok) {
    return {
      ok: false,
      errorCode: result.errorCode,
      message: result.message,
      diagnostics: result.diagnostics,
    }
  }
  return {
    ok: true,
    draft: normalizeDraftForResponse(result.draft, result.body),
    redactionWarnings: result.redactionWarnings,
    validationWarnings: result.validationWarnings,
  }
}

function normalizeDraftForResponse(
  draft: NormalizedSkill,
  body: string,
): SkillDraftResponse extends { ok: true; draft: infer D } ? D : never {
  return {
    id: draft.id,
    name: draft.name,
    description: draft.description,
    source: draft.source,
    scope: draft.scope,
    status: 'draft' as const,
    risk: draft.risk,
    triggers: draft.triggers,
    priority: draft.priority,
    allowedTools: draft.allowedTools,
    ...(draft.filePath ? { filePath: draft.filePath } : {}),
    body,
  } as unknown as SkillDraftResponse extends { ok: true; draft: infer D } ? D : never
}

/**
 * Save a skill draft to disk. Phase 5 of the governance plan.
 *
 * Flow:
 *   - If `confirm: false` or absent, return a preview only (no file write).
 *   - If `confirm: true`:
 *     - If target file exists and `overwrite: false`, return 409.
 *     - Otherwise write atomically and return the typed `skill_saved` event.
 *
 * Failure semantics: see `src/skills/storage.ts` §header for the errorCode list.
 */
export async function saveSkillHandler(input: SkillSaveInput): Promise<SkillSaveResponse> {
  const result = await saveSkill(input)
  if (!result.ok) {
    if (result.errorCode === 'SKILL_SAVE_NOT_CONFIRMED' && result.preview) {
      return {
        ok: true,
        previewOnly: true,
        scope: result.preview.scope,
        filePath: result.preview.filePath,
        body: result.preview.body,
        isNewFile: result.preview.isNewFile,
        duplicateWarnings: result.preview.duplicateWarnings,
      }
    }
    if (result.preview) {
      return {
        ok: false,
        errorCode: result.errorCode,
        message: result.message,
        preview: {
          ok: true,
          previewOnly: true,
          scope: result.preview.scope,
          filePath: result.preview.filePath,
          body: result.preview.body,
          isNewFile: result.preview.isNewFile,
          duplicateWarnings: result.preview.duplicateWarnings,
        },
      }
    }
    return { ok: false, errorCode: result.errorCode, message: result.message }
  }
  return {
    ok: true,
    scope: result.scope,
    filePath: result.filePath,
    format: result.format,
    saved: result.saved,
  }
}
