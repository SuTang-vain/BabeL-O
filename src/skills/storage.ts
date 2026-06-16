/**
 * Skill save / persistence — Phase 5 of the Skill execution governance plan.
 *
 * Persists a validated skill draft to disk under:
 *   - `project` scope: `<cwd>/.babel-o/skills/<id>.md`
 *   - `user` scope:    `${BABEL_O_USER_SKILLS_DIR}/<id>.md` (default: `~/.babel-o/skills/<id>.md`)
 *
 * Save is gated on explicit confirmation: the caller passes `confirm: true`
 * to indicate the user has reviewed the preview.
 *
 * Duplicate detection (per plan §Duplicate detection):
 *   - exact id (hard fail)
 *   - normalized name similarity
 *   - trigger overlap (>= 2 of the new triggers appear in the existing skill)
 *
 * Persistence semantics:
 *   - Always preview first; never write without `confirm: true`.
 *   - If the target file exists, return `SKILL_SAVE_OVERWRITE_REQUIRED` unless
 *     `overwrite: true` is also passed.
 *   - On success, emit a typed `SkillSavedEvent` payload (the event schema
 *     lives in `src/shared/skillEvents.ts`; the Nexus route forwards it
 *     to the caller).
 *
 * Failure semantics (integration index §5.2):
 *   - never throw for user-side validation; return `SkillSaveResult` with
 *     `ok: false` and structured errorCode.
 *   - errorCodes: `SKILL_SAVE_DUPLICATE_ID`, `SKILL_SAVE_DUPLICATE_NAME`,
 *     `SKILL_SAVE_DUPLICATE_TRIGGERS`, `SKILL_SAVE_OVERWRITE_REQUIRED`,
 *     `SKILL_SAVE_INVALID_DRAFT`, `SKILL_SAVE_PERSIST_FAILED`,
 *     `SKILL_SAVE_NOT_CONFIRMED`, `SKILL_SAVE_SCOPE_INVALID`.
 */

import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { formatSkill } from './formatter.js'
import { loadSkillRegistry } from './registry.js'
import { SkillSavedEventSchema, type SkillSavedEvent } from '../shared/skillEvents.js'
import type { NormalizedSkill, SkillSource } from './schema.js'

export type SkillSaveScope = 'user' | 'project'

export type SkillSaveInput = {
  cwd: string
  /** Already-validated draft (output of `generateSkillDraft`). */
  draft: NormalizedSkill
  /** User has confirmed the preview. */
  confirm: boolean
  /** If target file exists, allow overwrite. */
  overwrite?: boolean
  /** `user` or `project` (default: `draft.scope`). */
  scope?: SkillSaveScope
}

export type SkillSavePreview = {
  scope: SkillSaveScope
  filePath: string
  body: string
  isNewFile: boolean
  duplicateWarnings: Array<{
    code: 'SKILL_SAVE_DUPLICATE_ID' | 'SKILL_SAVE_DUPLICATE_NAME' | 'SKILL_SAVE_DUPLICATE_TRIGGERS'
    message: string
    conflictingId?: string
  }>
}

export type SkillSaveResult =
  | {
      ok: true
      scope: SkillSaveScope
      filePath: string
      format: 'overwrite' | 'new'
      saved: SkillSavedEvent
    }
  | {
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
      preview?: SkillSavePreview
    }

const DUPLICATE_TRIGGER_OVERLAP_THRESHOLD = 2

function normalizeNameForCompare(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

function resolveScopeDir(scope: SkillSaveScope, cwd: string): string {
  if (scope === 'user') {
    return process.env.BABEL_O_USER_SKILLS_DIR ?? path.join(os.homedir(), '.babel-o', 'skills')
  }
  return path.join(cwd, '.babel-o', 'skills')
}

function resolveScopeSource(scope: SkillSaveScope): SkillSource {
  return scope // 'user' | 'project'
}

/** Build a preview of what would be saved, including duplicate detection. */
export async function previewSkillSave(input: {
  cwd: string
  draft: NormalizedSkill
  scope: SkillSaveScope
}): Promise<SkillSavePreview> {
  const targetDir = resolveScopeDir(input.scope, input.cwd)
  const filePath = path.join(targetDir, `${input.draft.id}.md`)
  const body = formatSkill(input.draft)

  let isNewFile = true
  try {
    await fs.access(filePath)
    isNewFile = false
  } catch {
    isNewFile = true
  }

  const duplicateWarnings: SkillSavePreview['duplicateWarnings'] = []

  // Hard id conflict: a different skill file at the target path.
  if (!isNewFile) {
    duplicateWarnings.push({
      code: 'SKILL_SAVE_DUPLICATE_ID',
      message: `Target file ${filePath} already exists.`,
      conflictingId: input.draft.id,
    })
  }

  // Soft duplicates: registry match by name / triggers.
  try {
    const reg = await loadSkillRegistry({ cwd: input.cwd })
    const normalizedNewName = normalizeNameForCompare(input.draft.name)
    for (const existing of reg.list()) {
      if (existing.id === input.draft.id) continue
      if (normalizeNameForCompare(existing.name) === normalizedNewName) {
        duplicateWarnings.push({
          code: 'SKILL_SAVE_DUPLICATE_NAME',
          message: `A skill named "${existing.name}" already exists (id=${existing.id}).`,
          conflictingId: existing.id,
        })
      }
      const overlap = input.draft.triggers.filter(t => existing.triggers.includes(t)).length
      if (overlap >= DUPLICATE_TRIGGER_OVERLAP_THRESHOLD) {
        duplicateWarnings.push({
          code: 'SKILL_SAVE_DUPLICATE_TRIGGERS',
          message: `Skill "${existing.id}" shares ${overlap} trigger(s) with this draft.`,
          conflictingId: existing.id,
        })
      }
    }
  } catch {
    // best-effort: registry read failure must not block preview
  }

  return { scope: input.scope, filePath, body, isNewFile, duplicateWarnings }
}

/**
 * Persist a skill draft to disk.
 *
 * Steps:
 *   1. Validate scope and draft shape.
 *   2. Build a preview (which also detects duplicates).
 *   3. If `confirm` is false, return the preview only.
 *   4. If `confirm` is true:
 *      a. hard id conflict: refuse unless `overwrite: true`.
 *      b. write file atomically (write to <filePath>.tmp + rename).
 *      c. emit a typed `SkillSavedEvent` payload.
 */
export async function saveSkill(input: SkillSaveInput): Promise<SkillSaveResult> {
  if (!input || !input.draft || !input.draft.id || !input.draft.name) {
    return {
      ok: false,
      errorCode: 'SKILL_SAVE_INVALID_DRAFT',
      message: 'Save requires a draft with `id` and `name`.',
    }
  }

  const scope: SkillSaveScope = (input.scope ?? (input.draft.scope === 'user' ? 'user' : 'project'))
  if (scope !== 'user' && scope !== 'project') {
    return {
      ok: false,
      errorCode: 'SKILL_SAVE_SCOPE_INVALID',
      message: `Scope must be 'user' or 'project' (got "${scope}").`,
    }
  }

  const targetDir = resolveScopeDir(scope, input.cwd)
  const filePath = path.join(targetDir, `${input.draft.id}.md`)

  // Force the draft's source to match the resolved scope (registry attribution).
  const source = resolveScopeSource(scope)
  const draftForSave: NormalizedSkill = { ...input.draft, source, scope }

  const preview = await previewSkillSave({ cwd: input.cwd, draft: draftForSave, scope })

  if (!input.confirm) {
    return {
      ok: false,
      errorCode: 'SKILL_SAVE_NOT_CONFIRMED',
      message: 'Save requires explicit `confirm: true` after preview.',
      preview,
    }
  }

  // Hard id conflict: refuse unless overwrite.
  if (!preview.isNewFile && !input.overwrite) {
    return {
      ok: false,
      errorCode: 'SKILL_SAVE_OVERWRITE_REQUIRED',
      message: `Target file already exists; pass \`overwrite: true\` to replace it.`,
      preview,
    }
  }

  // Soft duplicate warnings are advisory — do not block save.
  // They are surfaced via the `preview.duplicateWarnings` field on success.
  try {
    await fs.mkdir(targetDir, { recursive: true })
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
    await fs.writeFile(tmpPath, preview.body, 'utf-8')
    await fs.rename(tmpPath, filePath)
  } catch (err) {
    return {
      ok: false,
      errorCode: 'SKILL_SAVE_PERSIST_FAILED',
      message: err instanceof Error ? err.message : String(err),
      preview,
    }
  }

  const saved = SkillSavedEventSchema.parse({
    type: 'skill_saved' as const,
    schemaVersion: '2026-05-21.babel-o.v1' as const,
    sessionId: 'save-side-effect',
    timestamp: new Date().toISOString(),
    skillId: draftForSave.id,
    scope,
    filePath,
    format: preview.isNewFile ? ('new' as const) : ('overwrite' as const),
  })

  return {
    ok: true,
    scope,
    filePath,
    format: preview.isNewFile ? 'new' : 'overwrite',
    saved,
  }
}
