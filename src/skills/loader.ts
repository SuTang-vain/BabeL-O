import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import type { Dirent } from 'fs'
import type { SkillResource } from './schema.js'

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
  license?: string;
  compatibility?: string;
  metadata?: Record<string, unknown>;
  sourceFormat?: 'babel-o-v1' | 'agent-skills-v1';
  packageRoot?: string;
  manifestPath?: string;
  resources?: SkillResource[];
  filePath?: string;
}

/** Parse `[a, b, c]` style YAML list. Returns [] on missing/empty. */
function parseListField(raw: unknown): string[] {
  if (!raw) return []
  if (Array.isArray(raw)) {
    return raw
      .map(value => String(value).trim())
      .filter(Boolean)
  }
  if (typeof raw !== 'string') return []
  return raw
    .replace(/[\[\]]/g, '')
    .split(',')
    .map(s => s.trim())
    .map(s => s.replace(/^['"]|['"]$/g, ''))
    .filter(Boolean)
}

function deriveSkillId(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8)
    .join('-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'skill'
}

function parseAllowedTools(raw: unknown): string[] {
  if (!raw) return []
  if (Array.isArray(raw)) return parseListField(raw)
  if (typeof raw !== 'string') return []
  const parsedList = parseListField(raw)
  return raw.trim().startsWith('[') || parsedList.length > 1
    ? parsedList
    : raw.split(/\s+/).map(s => s.trim()).filter(Boolean)
}

function parseScalarValue(raw: string): unknown {
  const trimmed = raw.trim()
  if (!trimmed) return ''
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) return parseListField(trimmed)
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1)
  }
  if (/^-?\d+$/.test(trimmed)) return parseInt(trimmed, 10)
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  return trimmed
}

function nextIndentedLineIsList(lines: string[], currentIndex: number, currentIndent: number): boolean {
  for (let i = currentIndex + 1; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const indent = line.match(/^ */)?.[0].length ?? 0
    return indent > currentIndent && trimmed.startsWith('- ')
  }
  return false
}

function parseFrontMatterMetadata(metaLines: string[]): Record<string, unknown> {
  const root: Record<string, unknown> = {}
  const stack: Array<{ indent: number; value: Record<string, unknown> | unknown[] }> = [{ indent: -1, value: root }]

  for (let i = 0; i < metaLines.length; i++) {
    const line = metaLines[i]
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const indent = line.match(/^ */)?.[0].length ?? 0

    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
      stack.pop()
    }

    const parent = stack[stack.length - 1].value
    if (trimmed.startsWith('- ')) {
      if (Array.isArray(parent)) {
        parent.push(parseScalarValue(trimmed.slice(2).trim()))
      }
      continue
    }

    const colonIdx = trimmed.indexOf(':')
    if (colonIdx === -1 || Array.isArray(parent)) continue

    const key = trimmed.slice(0, colonIdx).trim()
    const value = trimmed.slice(colonIdx + 1).trim()
    if (!key) continue

    if (!value) {
      const child: Record<string, unknown> | unknown[] = nextIndentedLineIsList(metaLines, i, indent) ? [] : {}
      parent[key] = child
      stack.push({ indent, value: child })
    } else {
      parent[key] = parseScalarValue(value)
    }
  }

  return root
}

function getRecordField(record: Record<string, unknown> | undefined, ...keys: string[]): Record<string, unknown> | undefined {
  const value = getField(record, ...keys)
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function getField(record: Record<string, unknown> | undefined, ...keys: string[]): unknown {
  if (!record) return undefined
  const wanted = new Set(keys.map(key => key.toLowerCase()))
  for (const [key, value] of Object.entries(record)) {
    if (wanted.has(key.toLowerCase())) return value
  }
  return undefined
}

function getStringField(record: Record<string, unknown> | undefined, ...keys: string[]): string | undefined {
  const value = getField(record, ...keys)
  return typeof value === 'string' ? value : undefined
}

function getNumberField(record: Record<string, unknown> | undefined, ...keys: string[]): number | undefined {
  const value = getField(record, ...keys)
  if (typeof value === 'number') return value
  if (typeof value !== 'string') return undefined
  const parsed = parseInt(value, 10)
  return Number.isNaN(parsed) ? undefined : parsed
}

function parseMetadataFromFlatKeys(metadata: Record<string, unknown>): Record<string, unknown> | undefined {
  const parsed: Record<string, unknown> = {}
  const nestedMetadata = getRecordField(metadata, 'metadata')
  if (nestedMetadata) {
    Object.assign(parsed, nestedMetadata)
  }

  const babelO: Record<string, unknown> = {
    ...(getRecordField(parsed, 'babel-o') || {}),
  }
  for (const [key, value] of Object.entries(metadata)) {
    const normalizedKey = key.toLowerCase()
    if (!normalizedKey.startsWith('metadata.babel-o.')) continue
    const field = key.slice('metadata.babel-o.'.length)
    const normalizedField = field.toLowerCase()
    if (!field) continue
    if (normalizedField === 'triggers' || normalizedField === 'allowedtools' || normalizedField === 'allowed-tools') {
      babelO[normalizedField === 'allowed-tools' ? 'allowedTools' : normalizedField] = parseListField(value)
    } else if (normalizedField === 'priority' || normalizedField === 'version') {
      const parsedValue = getNumberField({ value }, 'value')
      babelO[field] = parsedValue ?? value
    } else {
      babelO[field] = value
    }
  }
  if (Object.keys(babelO).length > 0) {
    parsed['babel-o'] = babelO
  }
  return Object.keys(parsed).length > 0 ? parsed : undefined
}

function getBabelOMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  return getRecordField(metadata, 'babel-o') || {}
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

  const metadata = parseFrontMatterMetadata(metaLines)

  const parsedMetadata = parseMetadataFromFlatKeys(metadata)
  const babelOMetadata = getBabelOMetadata(parsedMetadata)
  const standardName = getStringField(metadata, 'name') || ''
  const description = getStringField(metadata, 'description') || getStringField(babelOMetadata, 'description')
  const looksLikeAgentSkill = Boolean(
    description ||
    getField(metadata, 'allowed-tools', 'allowedTools') ||
    getStringField(metadata, 'license') ||
    getStringField(metadata, 'compatibility') ||
    parsedMetadata,
  )
  const metadataId = getStringField(babelOMetadata, 'id') || ''
  const id = getStringField(metadata, 'id') || metadataId || (looksLikeAgentSkill ? deriveSkillId(standardName) : '')
  const name = getStringField(babelOMetadata, 'displayName', 'displayname') ||
    standardName ||
    id
  const triggers = parseListField(getField(metadata, 'triggers'))
    .concat(parseListField(getField(babelOMetadata, 'triggers')))
  const priority = getNumberField(metadata, 'priority') ?? getNumberField(babelOMetadata, 'priority') ?? 0
  const allowedTools = parseAllowedTools(
    getField(metadata, 'allowedtools', 'allowed-tools', 'allowedTools') ??
    getField(babelOMetadata, 'allowedtools', 'allowed-tools', 'allowedTools'),
  )
  const version = getNumberField(metadata, 'version') ?? getNumberField(babelOMetadata, 'version')
  const status = getStringField(metadata, 'status') || getStringField(babelOMetadata, 'status')
  const scope = getStringField(metadata, 'scope') || getStringField(babelOMetadata, 'scope')
  const risk = getStringField(metadata, 'risk') || getStringField(babelOMetadata, 'risk')
  const license = getStringField(metadata, 'license')
  const compatibility = getStringField(metadata, 'compatibility')

  if (!id) {
    return null;
  }

  return {
    id,
    name,
    triggers,
    priority,
    content: bodyContent,
    ...(description ? { description } : {}),
    ...(allowedTools.length > 0 ? { allowedTools } : {}),
    ...(version !== undefined && !Number.isNaN(version) ? { version } : {}),
    ...(status ? { status } : {}),
    ...(scope ? { scope } : {}),
    ...(risk ? { risk } : {}),
    ...(license ? { license } : {}),
    ...(compatibility ? { compatibility } : {}),
    ...(parsedMetadata ? { metadata: parsedMetadata } : {}),
  }
}

export async function loadSkillFromFile(filePath: string): Promise<Skill | null> {
  try {
    const rawContent = await fs.readFile(filePath, 'utf-8');
    const skill = parseFrontMatter(rawContent);
    return skill ? { ...skill, filePath, sourceFormat: 'babel-o-v1' } : null
  } catch {
    return null;
  }
}

/** Canonical Agent Skills resource directories. */
const SPEC_RESOURCE_DIRS: ReadonlyArray<{ kind: SkillResource['kind']; dirName: string }> = [
  { kind: 'script', dirName: 'scripts' },
  { kind: 'reference', dirName: 'references' },
  { kind: 'asset', dirName: 'assets' },
]

/** Top-level package entries that are never indexed as resources. */
const SKIPPED_TOP_LEVEL_ENTRIES = new Set<string>([
  'SKILL.md',
  'LICENSE',
  'LICENSE.txt',
  'LICENSE.md',
  'NOTICE',
  'NOTICE.txt',
  'README',
  'README.md',
  'CHANGELOG',
  'CHANGELOG.md',
])

/**
 * Top-level subdirectories that must be skipped before any I/O so a hostile
 * package cannot blow up resource indexing (e.g. `.git/HEAD` blob walk).
 * Keep this conservative — every entry must have a concrete reason.
 */
const SKIPPED_TOP_LEVEL_DIRS = new Set<string>([
  '.git',
  '.github',
  '.svn',
  '.hg',
  'node_modules',
  '__pycache__',
  '.venv',
  'venv',
  '.idea',
  '.vscode',
])

/** True if a top-level dir name is the canonical spec dirs we already walk. */
function isSpecResourceDir(name: string): boolean {
  return SPEC_RESOURCE_DIRS.some(d => d.dirName === name)
}

async function listPackageResources(packageRoot: string): Promise<SkillResource[]> {
  const resources: SkillResource[] = []
  let packageRealPath: string
  try {
    packageRealPath = await fs.realpath(packageRoot)
  } catch {
    return resources
  }
  const isInsidePackage = (targetPath: string): boolean => {
    const relativePath = path.relative(packageRealPath, targetPath)
    return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath))
  }

  const walkRecursive = async (
    kind: SkillResource['kind'],
    prefix: string,
    currentDir: string,
    relativeDir: string,
  ): Promise<void> => {
    let entries: Dirent[]
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const absolutePath = path.join(currentDir, entry.name)
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name
      try {
        const linkStat = await fs.lstat(absolutePath)
        if (linkStat.isSymbolicLink()) continue
        const realPath = await fs.realpath(absolutePath)
        if (!isInsidePackage(realPath)) continue
        if (linkStat.isDirectory()) {
          await walkRecursive(kind, prefix, absolutePath, relativePath)
          continue
        }
        if (!linkStat.isFile()) continue
      } catch {
        continue
      }
      resources.push({
        kind,
        path: `${prefix}/${relativePath}`,
        absolutePath,
      })
    }
  }

  const collectSpecDir = async (kind: SkillResource['kind'], dirName: string): Promise<void> => {
    const dir = path.join(packageRoot, dirName)
    try {
      const realPath = await fs.realpath(dir)
      if (!isInsidePackage(realPath)) return
    } catch {
      return
    }
    await walkRecursive(kind, dirName, dir, '')
  }

  for (const spec of SPEC_RESOURCE_DIRS) {
    await collectSpecDir(spec.kind, spec.dirName)
  }

  // Top-level companion *.md files (excluding SKILL.md and standard LICENSE/README/...).
  let topEntries: Dirent[]
  try {
    topEntries = await fs.readdir(packageRoot, { withFileTypes: true })
  } catch {
    return resources
  }
  for (const entry of topEntries) {
    if (entry.isSymbolicLink()) continue
    const name = entry.name
    if (name.startsWith('.')) continue
    if (SKIPPED_TOP_LEVEL_ENTRIES.has(name)) continue
    const absolutePath = path.join(packageRoot, name)
    try {
      const linkStat = await fs.lstat(absolutePath)
      if (linkStat.isSymbolicLink()) continue
      const realPath = await fs.realpath(absolutePath)
      if (!isInsidePackage(realPath)) continue
      if (linkStat.isFile() && name.endsWith('.md')) {
        resources.push({ kind: 'reference', path: name, absolutePath })
        continue
      }
      if (linkStat.isDirectory()) {
        if (SKIPPED_TOP_LEVEL_DIRS.has(name)) continue
        if (isSpecResourceDir(name)) continue
        // Non-canonical top-level asset directory: walk recursively, kind=asset.
        await walkRecursive('asset', name, absolutePath, '')
      }
    } catch {
      continue
    }
  }
  return resources
}

export async function loadSkillPackageFromDir(packageRoot: string): Promise<Skill | null> {
  const manifestPath = path.join(packageRoot, 'SKILL.md')
  try {
    const rawContent = await fs.readFile(manifestPath, 'utf-8')
    const skill = parseFrontMatter(rawContent)
    if (!skill) return null
    const resources = await listPackageResources(packageRoot)
    return {
      ...skill,
      sourceFormat: 'agent-skills-v1',
      packageRoot,
      manifestPath,
      filePath: manifestPath,
      resources,
    }
  } catch {
    return null
  }
}

export async function loadSkillsFromDir(dirPath: string): Promise<Skill[]> {
  const resolvedPath = dirPath.startsWith('~')
    ? path.join(os.homedir(), dirPath.slice(1))
    : path.resolve(dirPath);

  try {
    const files = await fs.readdir(resolvedPath, { withFileTypes: true });
    const skills: Skill[] = [];
    for (const file of files) {
      if (file.isFile() && file.name.endsWith('.md')) {
        const filePath = path.join(resolvedPath, file.name);
        const skill = await loadSkillFromFile(filePath);
        if (skill) {
          skills.push(skill);
        }
      } else if (file.isDirectory()) {
        const skill = await loadSkillPackageFromDir(path.join(resolvedPath, file.name))
        if (skill) {
          skills.push(skill)
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
