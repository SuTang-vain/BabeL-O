import { Skill } from './loader.js';

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
        score += countPromptTermHits(skill.description, normalizedPrompt) * 10
      }
      if (!triggerMatched && score === 0) {
        score += countPromptTermHits(`${skill.name} ${skill.id}`, normalizedPrompt)
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

function countPromptTermHits(source: string, normalizedPrompt: string): number {
  let score = 0
  const terms = source
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fff]+/u)
    .map(term => term.trim())
    .filter(term => term.length >= 3)
  const seen = new Set<string>()
  for (const term of terms) {
    if (seen.has(term)) continue
    seen.add(term)
    if (normalizedPrompt.includes(term)) {
      score += 1
    }
  }
  return score
}
