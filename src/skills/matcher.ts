import { Skill } from './loader.js';

export function matchSkills(skills: Skill[], prompt: string, maxCount = 3): Skill[] {
  if (!prompt) return [];

  const matched = skills
    .map(skill => {
      let score = 0;
      for (const trigger of skill.triggers) {
        if (!trigger) continue;
        const regex = new RegExp(escapeRegExp(trigger), 'gi');
        const matches = prompt.match(regex);
        if (matches) {
          score += matches.length;
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
