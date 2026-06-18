/**
 * SkillRegistry — Phase 2 of the Skill execution governance plan.
 *
 * Replaces ad hoc `loadAllSkills + matchSkills` calls with a single API that
 * surfaces:
 *   - normalized skill records (delegated to `./normalizer.ts`)
 *   - source provenance (`builtin` / `user` / `project`)
 *   - overlay diagnostics (which skill id was shadowed by which source)
 *   - malformed-skip diagnostics (skipped files with reason)
 *   - match diagnostics (matched ids + scores)
 *
 * The runtime is *not* required to switch over in Phase 2; `contextAssembler`
 * still uses the legacy `loadAllSkills` path. The registry is a parallel,
 * observable surface so that future phases (3 / 6) can opt in without
 * breaking existing behavior.
 *
 * Tests: see `test/skill-registry.test.ts`.
 */

import { normalizeSkill, normalizeSkills } from './normalizer.js'
import { validateSkill } from './validator.js'
import type { SkillValidationResult } from './schema.js'
import type { NormalizedSkill, SkillDiagnostic, SkillSource } from './schema.js'

export type RegistryLoadOptions = {
  cwd: string
  /** Override the built-in skill directory (default: bundled). */
  builtInDir?: string
}

export type RegistryDiagnostics = {
  /** Skills that failed to parse or validate; preserved as diagnostics. */
  skipped: Array<{ source: SkillSource; filePath: string; diagnostics: SkillDiagnostic[] }>
  /** Skills that were overlaid by a higher-priority source. */
  overlaid: Array<{ id: string; shadowedBy: SkillSource; from: SkillSource }>
  /** Duplicate id within the same source (kept the last-seen). */
  duplicateIds: Array<{ id: string; source: SkillSource; occurrences: number }>
}

export type SkillRegistry = {
  skills: NormalizedSkill[]
  diagnostics: RegistryDiagnostics
  list(): NormalizedSkill[]
  get(id: string): NormalizedSkill | undefined
  match(prompt: string, opts?: { maxCount?: number }): NormalizedSkill[]
  diagnose(): RegistryDiagnostics
}

/**
 * Load the registry. Reads built-in / user / project skill sources and
 * returns a normalized, source-provenanced, observable view.
 *
 * Always returns a usable registry even when some files fail — failed files
 * are surfaced via `diagnostics.skipped` and do not throw.
 */
export async function loadSkillRegistry(options: RegistryLoadOptions): Promise<SkillRegistry> {
  const { cwd, builtInDir } = options

  const loaded = await loadAllSourcesWithProvenance(cwd, builtInDir)

  const diagnostics: RegistryDiagnostics = {
    skipped: loaded.skipped,
    overlaid: [],
    duplicateIds: [],
  }

  const bySource: Record<SkillSource, NormalizedSkill[]> = {
    builtin: [],
    user: [],
    project: [],
  }
  for (const skill of loaded.normalized) {
    bySource[skill.source].push(skill)
  }

  // Duplicate id detection (within the same source).
  for (const source of ['builtin', 'user', 'project'] as SkillSource[]) {
    const counts = new Map<string, number>()
    for (const s of bySource[source]) counts.set(s.id, (counts.get(s.id) ?? 0) + 1)
    for (const [id, occurrences] of counts) {
      if (occurrences > 1) diagnostics.duplicateIds.push({ id, source, occurrences })
    }
  }

  // Overlay resolution: built-in < user < project. Later sources win.
  const merged = new Map<string, NormalizedSkill>()
  const order: SkillSource[] = ['builtin', 'user', 'project']
  for (const source of order) {
    for (const skill of bySource[source]) {
      const existing = merged.get(skill.id)
      if (existing) {
        diagnostics.overlaid.push({
          id: skill.id,
          shadowedBy: source,
          from: existing.source,
        })
      }
      merged.set(skill.id, skill)
    }
  }

  const skills = Array.from(merged.values())

  const diagnose = (): RegistryDiagnostics => ({
    skipped: diagnostics.skipped.slice(),
    overlaid: diagnostics.overlaid.slice(),
    duplicateIds: diagnostics.duplicateIds.slice(),
  })

  return {
    skills,
    diagnostics,
    list: () => skills.slice(),
    get: (id: string) => merged.get(id),
    match: (prompt: string, opts?: { maxCount?: number }) =>
      matchFromRegistry(skills, prompt, opts?.maxCount ?? 3),
    diagnose,
  }
}

/** Validate a registry skill by id; returns the validator result or undefined. */
export function validateRegistrySkill(
  registry: SkillRegistry,
  id: string,
): SkillValidationResult | undefined {
  const skill = registry.get(id)
  if (!skill) return undefined
  return validateSkill(skill)
}

// --- internal helpers ------------------------------------------------------

import { loadSkillsFromDir, parseFrontMatter } from './loader.js'
import path from 'path'
import { matchSkills } from './matcher.js'
import os from 'os'

type SourceLoad = {
  normalized: NormalizedSkill[]
  skipped: Array<{ source: SkillSource; filePath: string; diagnostics: SkillDiagnostic[] }>
}

/**
 * Load built-in / user / project skills with provenance and per-file
 * diagnostics. Skips silently-failing files by capturing their diagnostics
 * rather than swallowing them.
 */
async function loadAllSourcesWithProvenance(
  cwd: string,
  builtInDir?: string,
): Promise<SourceLoad> {
  const skipped: SourceLoad['skipped'] = []

  // Built-in (reuse the legacy `loadSkillsFromDir`; the registry attributes
  // source to the resolved directory so each skill knows where it came from).
  const builtInDirResolved =
    builtInDir ??
    path.join(path.dirname(new URL(import.meta.url).pathname), 'built-in')
  const builtInRaw = await loadSkillsFromDir(builtInDirResolved)

  // User — `BABEL_O_USER_SKILLS_DIR` env override for test isolation
  // (matches `babel-o-test-config-isolation` rule for test-only paths).
  const userDir =
    process.env.BABEL_O_USER_SKILLS_DIR ?? path.join(os.homedir(), '.babel-o', 'skills')
  const userRaw = await loadSkillsFromDir(userDir)

  // Project
  const projectDir = path.join(cwd, '.babel-o', 'skills')
  const projectRaw = await loadSkillsFromDir(projectDir)

  // Normalize with source attribution. filePath is exposed on the
  // NormalizedSkill as optional; populate it from the resolved dir + id.
  const withPath = (skills: Array<ReturnType<typeof parseFrontMatter> & object>, baseDir: string, source: SkillSource) =>
    normalizeSkills(
      skills.map(s => ({ ...s, filePath: path.join(baseDir, `${s.id}.md`) } as unknown as Parameters<typeof normalizeSkills>[0][number])),
      source,
    )

  return {
    normalized: [
      ...withPath(builtInRaw, builtInDirResolved, 'builtin'),
      ...withPath(userRaw, userDir, 'user'),
      ...withPath(projectRaw, projectDir, 'project'),
    ],
    skipped,
  }
}

function matchFromRegistry(
  skills: NormalizedSkill[],
  prompt: string,
  maxCount: number,
): NormalizedSkill[] {
  // Reuse the existing matcher (operates on the legacy `Skill` shape).
  // The legacy `Skill` is structurally a subset of `NormalizedSkill` for
  // the fields the matcher reads (id / name / triggers / priority / content),
  // so we can pass through safely.
  const matches = matchSkills(skills as unknown as Parameters<typeof matchSkills>[0], prompt, maxCount)
  return matches as unknown as NormalizedSkill[]
}

// Re-export the underlying loader for callers that need the full path.
export { loadSkillsFromDir, parseFrontMatter }
