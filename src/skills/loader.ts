import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

export interface Skill {
  id: string;
  name: string;
  triggers: string[];
  priority: number;
  content: string;
}

export function parseFrontMatter(rawContent: string): Skill | null {
  const lines = rawContent.split(/\r?\n/);
  if (lines.length === 0 || lines[0]?.trim() !== '---') {
    return null;
  }
  const endIdx = lines.findIndex((line, i) => i > 0 && line.trim() === '---');
  if (endIdx === -1) {
    return null;
  }
  const metaLines = lines.slice(1, endIdx);
  const bodyContent = lines.slice(endIdx + 1).join('\n').trim();

  const metadata: Record<string, string> = {};
  for (const line of metaLines) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim().toLowerCase();
    const val = line.slice(colonIdx + 1).trim();
    metadata[key] = val;
  }

  const id = metadata['id'] || '';
  const name = metadata['name'] || id;
  const triggersRaw = metadata['triggers'] || '';
  const triggers = triggersRaw
    .replace(/[\[\]]/g, '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  const priority = parseInt(metadata['priority'] || '0', 10) || 0;

  if (!id) {
    return null;
  }

  return {
    id,
    name,
    triggers,
    priority,
    content: bodyContent
  };
}

export async function loadSkillFromFile(filePath: string): Promise<Skill | null> {
  try {
    const rawContent = await fs.readFile(filePath, 'utf-8');
    return parseFrontMatter(rawContent);
  } catch {
    return null;
  }
}

export async function loadSkillsFromDir(dirPath: string): Promise<Skill[]> {
  const resolvedPath = dirPath.startsWith('~')
    ? path.join(os.homedir(), dirPath.slice(1))
    : path.resolve(dirPath);

  try {
    const files = await fs.readdir(resolvedPath);
    const skills: Skill[] = [];
    for (const file of files) {
      if (file.endsWith('.md')) {
        const filePath = path.join(resolvedPath, file);
        const skill = await loadSkillFromFile(filePath);
        if (skill) {
          skills.push(skill);
        }
      }
    }
    return skills;
  } catch {
    return [];
  }
}

export async function loadAllSkills(cwd: string, builtInDir?: string): Promise<Skill[]> {
  const defaultBuiltInDir = builtInDir || path.join(path.dirname(fileURLToPath(import.meta.url)), 'built-in');
  const builtInSkills = await loadSkillsFromDir(defaultBuiltInDir);
  const userSkills = await loadSkillsFromDir('~/.babel-o/skills');
  const projectSkills = await loadSkillsFromDir(path.join(cwd, '.babel-o/skills'));

  const skillMap = new Map<string, Skill>();
  for (const skill of builtInSkills) {
    skillMap.set(skill.id, skill);
  }
  for (const skill of userSkills) {
    skillMap.set(skill.id, skill);
  }
  for (const skill of projectSkills) {
    skillMap.set(skill.id, skill);
  }

  return Array.from(skillMap.values());
}
