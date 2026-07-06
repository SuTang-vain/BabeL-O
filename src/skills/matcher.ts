import { Skill } from './loader.js';

/**
 * Implicit discovery quality gates (Phase B of the resource-coverage plan).
 *
 * - `LONG_DESCRIPTION_THRESHOLD`: descriptions at or above this term-count are
 *   considered "long-form" (Anthropic / OpenAI Codex style). Long descriptions
 *   are penalized so a single tangential term hit cannot outrank a focused
 *   short-description hit.
 * - `LONG_DESCRIPTION_HIT_RATIO_FLOOR`: when a description is long, the
 *   fraction of description terms that hit the prompt must clear this floor
 *   to count as a real match. Otherwise the description match is demoted.
 * - `DESCRIPTION_ABSOLUTE_HIT_FLOOR`: descriptions of any length must yield
 *   at least this many absolute term hits to count. Single-substring
 *   coincidence is dropped.
 */
const LONG_DESCRIPTION_THRESHOLD = 200;
const LONG_DESCRIPTION_HIT_RATIO_FLOOR = 0.05;
const LONG_DESCRIPTION_HIT_RATIO_PENALTY = 0.25;
const DESCRIPTION_ABSOLUTE_HIT_FLOOR = 2;

export function matchSkills(skills: Skill[], prompt: string, maxCount = 3): Skill[] {
  if (!prompt) return [];
  const normalizedPrompt = prompt.toLowerCase()

  const matched = skills
    .map(skill => {
      let score = 0;
      let triggerMatched = false
      for (const trigger of skill.triggers) {
        if (!trigger) continue;
        const regex = new RegExp(escapeRegExp(trigger), 'gi');
        const matches = prompt.match(regex);
        if (matches) {
          score += matches.length * 100;
          triggerMatched = true
        }
      }
      if (!triggerMatched && skill.description) {
        const { hitCount, termCount } = countPromptTermHitsDetailed(
          skill.description,
          normalizedPrompt,
        )
        if (hitCount >= DESCRIPTION_ABSOLUTE_HIT_FLOOR) {
          let descriptionScore = hitCount * 10
          if (termCount >= LONG_DESCRIPTION_THRESHOLD) {
            const ratio = hitCount / Math.max(1, termCount)
            if (ratio < LONG_DESCRIPTION_HIT_RATIO_FLOOR) {
              descriptionScore *= LONG_DESCRIPTION_HIT_RATIO_PENALTY
            } else {
              const lengthPenalty = Math.max(
                0.5,
                LONG_DESCRIPTION_THRESHOLD / Math.max(1, termCount),
              )
              descriptionScore *= lengthPenalty
            }
          }
          score += descriptionScore
        }
      }
      if (!triggerMatched && score === 0) {
        const { hitCount } = countPromptTermHitsDetailed(
          `${skill.name} ${skill.id}`,
          normalizedPrompt,
        )
        if (hitCount >= 1) {
          score += hitCount
        }
      }
      return { skill, score };
    })
    .filter(item => item.score > 0);

  matched.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    if (b.skill.priority !== a.skill.priority) {
      return b.skill.priority - a.skill.priority;
    }
    return a.skill.id.localeCompare(b.skill.id);
  });

  return matched.slice(0, maxCount).map(item => item.skill);
}

function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function countPromptTermHitsDetailed(
  source: string,
  normalizedPrompt: string,
): { hitCount: number; termCount: number } {
  let hitCount = 0
  let termCount = 0
  const terms = source
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fff]+/u)
    .map(term => term.trim())
    .filter(term => term.length >= 3)
  const seen = new Set<string>()
  for (const term of terms) {
    if (seen.has(term)) continue
    seen.add(term)
    termCount += 1
    if (normalizedPrompt.includes(term)) {
      hitCount += 1
    }
  }
  return { hitCount, termCount }
}
