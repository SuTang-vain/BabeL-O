/**
 * Skill validator — return structured diagnostics, never throw.
 *
 * Phase 1 minimal: implement the `Error` rules from the Skill governance plan
 * §Validator design. `Warning` and `Info` rules are deferred to a later phase
 * to keep this iteration focused on correctness.
 *
 * The validator is intentionally pure: it takes a `RawSkill` (or
 * `NormalizedSkill`) and returns a `SkillValidationResult`. It does not read
 * disk, does not rewrite files, and does not depend on the registry.
 */

import {
  type NormalizedSkill,
  type RawSkill,
  type SkillDiagnostic,
  type SkillValidationResult,
} from './schema.js'
import { normalizeSkill } from './normalizer.js'

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/
const VALID_STATUS = new Set(['active', 'draft', 'disabled'])
const VALID_RISK = new Set(['read', 'write', 'execute', 'network', 'task'])

/**
 * Validate a raw skill. The function never throws; all failures are returned
 * as `SkillDiagnostic` entries.
 */
export function validateSkill(raw: RawSkill): SkillValidationResult {
  const diagnostics: SkillDiagnostic[] = []

  if (!raw || typeof raw !== 'object') {
    diagnostics.push({
      severity: 'error',
      code: 'SKILL_INVALID_PAYLOAD',
      message: 'Skill payload must be an object.',
    })
    return { ok: false, diagnostics }
  }

  // id
  if (!raw.id) {
    diagnostics.push({
      severity: 'error',
      code: 'SKILL_ID_MISSING',
      message: 'Skill front matter is missing required field `id`.',
      field: 'id',
    })
  } else if (!ID_PATTERN.test(raw.id)) {
    diagnostics.push({
      severity: 'error',
      code: 'SKILL_ID_INVALID',
      message: `Skill id "${raw.id}" must be lowercase kebab-case (2..64 chars, [a-z0-9-]).`,
      field: 'id',
      suggestion: 'Use a stable kebab-case identifier like "babel-o-permission-denial-recovery".',
    })
  }

  // name
  if (!raw.name || !raw.name.trim()) {
    diagnostics.push({
      severity: 'error',
      code: 'SKILL_NAME_MISSING',
      message: 'Skill front matter is missing required field `name`.',
      field: 'name',
    })
  }

  // triggers — required for active skills, optional for draft / disabled.
  // Phase 4 explicitOnly drafts ship with empty triggers; the validator
  // must not reject them so long as `status` is not 'active'.
  const rawStatus = typeof raw.status === 'string' ? raw.status : 'active'
  if ((!Array.isArray(raw.triggers) || raw.triggers.length === 0) && rawStatus === 'active') {
    diagnostics.push({
      severity: 'error',
      code: 'SKILL_TRIGGERS_EMPTY',
      message: 'Active skill front matter must declare at least one trigger.',
      field: 'triggers',
    })
  } else if (!Array.isArray(raw.triggers)) {
    diagnostics.push({
      severity: 'error',
      code: 'SKILL_TRIGGERS_NOT_ARRAY',
      message: 'Skill `triggers` must be an array.',
      field: 'triggers',
    })
  }

  // body
  if (typeof raw.content !== 'string' || !raw.content.trim()) {
    diagnostics.push({
      severity: 'error',
      code: 'SKILL_BODY_EMPTY',
      message: 'Skill body is empty; skills must contain non-empty Markdown body.',
      field: 'content',
    })
  }

  // status (optional)
  const status = raw.status
  if (status !== undefined && !VALID_STATUS.has(status)) {
    diagnostics.push({
      severity: 'error',
      code: 'SKILL_STATUS_INVALID',
      message: `Skill status "${status}" is not one of: active, draft, disabled.`,
      field: 'status',
    })
  }

  // risk (optional)
  const risk = raw.risk
  if (risk !== undefined && !VALID_RISK.has(risk)) {
    diagnostics.push({
      severity: 'error',
      code: 'SKILL_RISK_INVALID',
      message: `Skill risk "${risk}" is not one of: read, write, execute, network, task.`,
      field: 'risk',
    })
  }

  // allowedTools (optional, advisory)
  const allowedTools = raw.allowedTools
  if (allowedTools !== undefined && !Array.isArray(allowedTools)) {
    diagnostics.push({
      severity: 'error',
      code: 'SKILL_ALLOWED_TOOLS_NOT_ARRAY',
      message: 'Skill `allowedTools` must be an array of tool names (advisory).',
      field: 'allowedTools',
    })
  }

  const errors = diagnostics.filter(d => d.severity === 'error')
  const normalized: NormalizedSkill | undefined = errors.length === 0 ? normalizeSkill(raw) : undefined

  return {
    ok: errors.length === 0,
    diagnostics,
    normalized,
  }
}

/** Convenience: validate a normalized skill. Re-validates key fields. */
export function validateNormalizedSkill(skill: NormalizedSkill): SkillValidationResult {
  return validateSkill(skill)
}
