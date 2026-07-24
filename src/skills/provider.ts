/**
 * SkillProvider — abstract interface for skill discovery and matching.
 *
 * This interface decouples the context assembly pipeline from the concrete
 * filesystem-backed skill loading + matching implementation. Callers inject
 * a SkillProvider to control which skills are matched without depending on
 * `loader.ts` or `matcher.ts` directly.
 *
 * See docs/nexus/reference/architecture-optimization-assessment-plan.md T1.
 */

export type SkillMatchResult = {
  id: string
  name: string
  content: string
  /** Trigger keywords that matched the prompt. Used by post-compact state derivation. */
  triggers?: string[]
}

export interface SkillProvider {
  /**
   * Match skills against a user prompt. Returns active skills that are
   * relevant to the given prompt, sorted by relevance (highest first).
   *
   * An empty prompt may return an empty array; implementors that perform
   * filesystem I/O or async discovery MUST NOT throw — return an empty
   * array on failure and surface diagnostics through the provider's own
   * observability channel.
   */
  matchPrompt(prompt: string, cwd: string): Promise<SkillMatchResult[]>
}

/**
 * Default filesystem-backed implementation that delegates to the existing
 * `loadAllSkills` and `matchSkills` functions. This is the production
 * provider; tests inject a stub to avoid filesystem I/O.
 */
export class FilesystemSkillProvider implements SkillProvider {
  async matchPrompt(prompt: string, cwd: string): Promise<SkillMatchResult[]> {
    const { loadAllSkills } = await import('./loader.js')
    const { matchSkills } = await import('./matcher.js')
    const allSkills = await loadAllSkills(cwd)
    const matched = matchSkills(allSkills, prompt)
    return matched.map(skill => ({
      id: skill.id,
      name: skill.name,
      content: skill.content,
      triggers: skill.triggers,
    }))
  }
}
