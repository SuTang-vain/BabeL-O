/**
 * Skill normalizer — convert legacy `RawSkill` to `NormalizedSkill`.
 *
 * Phase 1 minimal: fill in missing fields with safe defaults. Front-matter
 * rewrite is *not* performed here; only an in-memory transformation.
 *
 * The `source` field is loader-derived and is set by `loader.ts` after calling
 * `normalizeSkill(raw, source)` — this module does not know the file path.
 */

import {
  SKILL_DEFAULTS,
  type NormalizedSkill,
  type RawSkill,
  type SkillScope,
  type SkillSource,
} from './schema.js'

/**
 * Normalize a raw skill into the normalized shape.
 *
 * @param raw The raw skill from `parseFrontMatter`
 * @param source The loader-resolved source (`builtin` / `user` / `project`).
 *               Defaults to `raw.scope` if present, else `'project'`.
 */
export function normalizeSkill(
  raw: RawSkill,
  source: SkillSource = 'project',
): NormalizedSkill {
  const scope: SkillScope = (raw.scope ?? source) as SkillScope
  const description = (raw.description ?? '').trim() || raw.name
  const status = (raw.status ?? SKILL_DEFAULTS.status) as NormalizedSkill['status']
  const risk = (raw.risk ?? SKILL_DEFAULTS.risk) as NormalizedSkill['risk']
  const allowedTools = raw.allowedTools ?? [...SKILL_DEFAULTS.allowedTools]
  const version = raw.version ?? SKILL_DEFAULTS.version

  return {
    id: raw.id,
    name: raw.name,
    triggers: raw.triggers,
    priority: raw.priority,
    content: raw.content,
    version,
    status,
    description,
    source,
    scope,
    risk,
    allowedTools,
  }
}

/** Normalize a batch of raw skills. Unknown ids are filtered out (defensive). */
export function normalizeSkills(
  raws: RawSkill[],
  source: SkillSource = 'project',
): NormalizedSkill[] {
  const out: NormalizedSkill[] = []
  for (const raw of raws) {
    if (!raw || !raw.id) continue
    out.push(normalizeSkill(raw, source))
  }
  return out
}
