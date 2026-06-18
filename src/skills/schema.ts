/**
 * Skill schema — normalized types for the BabeL-O skill system.
 *
 * Phase 1: introduces type-level normalization on top of the legacy `Skill` shape
 * in `./loader.ts`. The runtime path is unchanged in Phase 1; loaders still return
 * the legacy shape. `normalizer.ts` converts legacy → normalized.
 *
 * Why a separate schema module: a single source of truth for skill metadata
 * lets validator, formatter, registry, and the model-visible tool layer all
 * share the same shape, while loader.ts can keep its minimal contract for
 * back-compat.
 */

export type SkillRisk = 'read' | 'write' | 'execute' | 'network' | 'task'

export type SkillStatus = 'active' | 'draft' | 'disabled'

export type SkillSource = 'builtin' | 'user' | 'project'

export type SkillScope = SkillSource

/**
 * Raw, parsed shape — what `parseFrontMatter` returns today in `loader.ts`.
 * Kept as-is for back-compat; the normalized shape extends it.
 *
 * Real front matter may carry additional fields (`description` / `version` /
 * `status` / `scope` / `risk` / `allowedTools` / `createdAt` / ...). The
 * shape is `RawSkill & RawSkillExtensions` so callers and tests can pass
 * the legacy subset while authors can include the new fields.
 */
export type RawSkillExtensions = {
  description?: string
  version?: number
  status?: string
  scope?: string
  risk?: string
  allowedTools?: string[]
  createdAt?: string
  updatedAt?: string
  owner?: string
}

export type RawSkill = {
  id: string
  name: string
  triggers: string[]
  priority: number
  content: string
} & RawSkillExtensions

/**
 * Normalized skill shape — the contract used by validator / registry / tools.
 *
 * - `version` starts at 1
 * - `status` defaults to 'active'
 * - `description` defaults to `name` when missing in legacy skills
 * - `scope` defaults to the loader-resolved source
 * - `risk` defaults to 'read'
 * - `allowedTools` is advisory; runtime policy remains authoritative
 */
export type NormalizedSkill = RawSkill & {
  version: number
  status: SkillStatus
  description: string
  source: SkillSource
  scope: SkillScope
  risk: SkillRisk
  allowedTools: string[]
  createdAt?: string
  updatedAt?: string
  owner?: string
  /** Resolved filesystem path; populated by the loader, not the file front matter. */
  filePath?: string
}

export type SkillDiagnosticSeverity = 'error' | 'warning' | 'info'

export type SkillDiagnostic = {
  severity: SkillDiagnosticSeverity
  code: string
  message: string
  field?: string
  line?: number
  suggestion?: string
}

export type SkillValidationResult = {
  ok: boolean
  diagnostics: SkillDiagnostic[]
  normalized?: NormalizedSkill
}

/** Default normalized values used when a legacy skill is missing a field. */
export const SKILL_DEFAULTS = {
  version: 1,
  status: 'active' as SkillStatus,
  description: '',
  scope: 'project' as SkillScope,
  risk: 'read' as SkillRisk,
  allowedTools: [] as string[],
  priority: 0,
} as const
