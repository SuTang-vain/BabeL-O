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
  /** Advisory allow-list of tool names (Skill governance plan §Proposed skill schema). */
  allowedTools?: string[];
  description?: string;
  version?: number;
  status?: string;
  scope?: string;
  risk?: string;
  createdAt?: string;
  updatedAt?: string;
  owner?: string;
}

/** Parse `[a, b, c]` style YAML list. Returns [] on missing/empty. */
function parseListField(raw: string | undefined): string[] {
  if (!raw) return []
  return raw
    .replace(/[\[\]]/g, '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
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
  const triggers = parseListField(metadata['triggers']);
  const priority = parseInt(metadata['priority'] || '0', 10) || 0;
  const allowedTools = parseListField(metadata['allowedtools']);
  const version = metadata['version'] ? parseInt(metadata['version'], 10) : undefined;
  const status = metadata['status'] || undefined;
  const scope = metadata['scope'] || undefined;
  const risk = metadata['risk'] || undefined;

  if (!id) {
    return null;
  }

  return {
    id,
    name,
    triggers,
    priority,
    content: bodyContent,
    ...(allowedTools.length > 0 ? { allowedTools } : {}),
    ...(version !== undefined && !Number.isNaN(version) ? { version } : {}),
    ...(status ? { status } : {}),
    ...(scope ? { scope } : {}),
    ...(risk ? { risk } : {}),
  }
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
  let hasAsset: any = null
  let getAsset: any = null
  try {
    const sea = await import('node:sea') as any
    hasAsset = sea.hasAsset
    getAsset = sea.getAsset
  } catch {}

  const builtInSkills: Skill[] = []
  const skillFiles = ['coding.md', 'debugging.md', 'git.md', 'optimization.md', 'testing.md']

  if (hasAsset && getAsset && hasAsset('skills/built-in/coding.md')) {
    for (const file of skillFiles) {
      try {
        const content = getAsset(`skills/built-in/${file}`, 'utf8')
        const skill = parseFrontMatter(content)
        if (skill) {
          builtInSkills.push(skill)
        }
      } catch {}
    }
  } else {
    const defaultBuiltInDir = builtInDir || path.join(path.dirname(fileURLToPath(import.meta.url)), 'built-in')
    builtInSkills.push(...await loadSkillsFromDir(defaultBuiltInDir))
  }

  const userSkills = await loadSkillsFromDir('~/.babel-o/skills')
  const projectSkills = await loadSkillsFromDir(path.join(cwd, '.babel-o/skills'))

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
