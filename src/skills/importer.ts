import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { loadSkillPackageFromDir } from './loader.js'
import { normalizeSkill } from './normalizer.js'
import { loadSkillRegistry } from './registry.js'
import { validateSkill } from './validator.js'
import type { NormalizedSkill, SkillDiagnostic, SkillResource } from './schema.js'

export type SkillImportWarningCode =
  | 'SKILL_IMPORT_UNSUPPORTED_SOURCE'
  | 'SKILL_IMPORT_SOURCE_OUTSIDE_CWD'
  | 'SKILL_IMPORT_DUPLICATE_ID'
  | 'SKILL_IMPORT_DUPLICATE_NAME'
  | 'SKILL_IMPORT_NO_RESOURCES'
  | 'SKILL_IMPORT_VALIDATION_WARNING'

export type SkillImportPreviewInput = {
  cwd: string
  sourcePath: string
  scope?: 'user' | 'project'
  builtInDir?: string
}

export type SkillImportInstallInput = SkillImportPreviewInput & {
  confirm: boolean
  overwrite?: boolean
}

export type SkillImportPreviewSuccess = {
  ok: true
  previewOnly: true
  sourcePath: string
  packageRoot: string
  targetScope: 'user' | 'project'
  targetPath: string
  skill: NormalizedSkill
  manifestPath: string
  resources: SkillResource[]
  body: string
  diagnostics: SkillDiagnostic[]
  warnings: Array<{
    code: SkillImportWarningCode
    message: string
    conflictingId?: string
  }>
  conversion: {
    sourceFormat: 'agent-skills-v1'
    targetFormat: 'agent-skills-v1'
    preservesPackageResources: boolean
  }
}

export type SkillImportPreviewError = {
  ok: false
  errorCode:
    | 'SKILL_IMPORT_INVALID_INPUT'
    | 'SKILL_IMPORT_SOURCE_NOT_FOUND'
    | 'SKILL_IMPORT_NOT_AGENT_SKILL_PACKAGE'
    | 'SKILL_IMPORT_LOAD_FAILED'
  message: string
  diagnostics?: SkillDiagnostic[]
}

export type SkillImportPreviewResult =
  | SkillImportPreviewSuccess
  | SkillImportPreviewError

export type SkillImportInstallResult =
  | {
      ok: true
      sourcePath: string
      targetScope: 'user' | 'project'
      targetPath: string
      skillId: string
      format: 'new' | 'overwrite'
      resources: SkillResource[]
      warnings: SkillImportPreviewSuccess['warnings']
    }
  | {
      ok: false
      errorCode:
        | 'SKILL_IMPORT_NOT_CONFIRMED'
        | 'SKILL_IMPORT_OVERWRITE_REQUIRED'
        | 'SKILL_IMPORT_PERSIST_FAILED'
        | SkillImportPreviewError['errorCode']
      message: string
      preview?: SkillImportPreviewSuccess
      diagnostics?: SkillDiagnostic[]
    }

function resolveSourcePath(cwd: string, sourcePath: string): string {
  return path.resolve(cwd, sourcePath)
}

function resolveScopeDir(scope: 'user' | 'project', cwd: string): string {
  if (scope === 'user') {
    return process.env.BABEL_O_USER_SKILLS_DIR ?? path.join(os.homedir(), '.babel-o', 'skills')
  }
  return path.join(cwd, '.babel-o', 'skills')
}

function resolveTargetPath(cwd: string, scope: 'user' | 'project', id: string): string {
  return path.join(resolveScopeDir(scope, cwd), id)
}

function normalizeNameForCompare(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

export async function previewSkillImport(input: SkillImportPreviewInput): Promise<SkillImportPreviewResult> {
  if (!input.sourcePath.trim()) {
    return {
      ok: false,
      errorCode: 'SKILL_IMPORT_INVALID_INPUT',
      message: '`sourcePath` is required.',
    }
  }

  const resolvedSourcePath = resolveSourcePath(input.cwd, input.sourcePath)
  let stat
  try {
    stat = await fs.stat(resolvedSourcePath)
  } catch {
    return {
      ok: false,
      errorCode: 'SKILL_IMPORT_SOURCE_NOT_FOUND',
      message: `Skill import source not found: ${resolvedSourcePath}`,
    }
  }
  if (!stat.isDirectory()) {
    return {
      ok: false,
      errorCode: 'SKILL_IMPORT_NOT_AGENT_SKILL_PACKAGE',
      message: 'Only local Agent Skills directories containing SKILL.md are supported in this preview slice.',
    }
  }

  const raw = await loadSkillPackageFromDir(resolvedSourcePath)
  if (!raw) {
    return {
      ok: false,
      errorCode: 'SKILL_IMPORT_NOT_AGENT_SKILL_PACKAGE',
      message: `No valid SKILL.md package manifest found at ${resolvedSourcePath}.`,
    }
  }

  const targetScope = input.scope ?? 'project'
  const skill = {
    ...normalizeSkill(raw, targetScope),
    scope: targetScope,
  }
  const validation = validateSkill(skill)
  const warnings: SkillImportPreviewSuccess['warnings'] = []
  const sourceRelativeToCwd = path.relative(input.cwd, resolvedSourcePath)
  if (sourceRelativeToCwd.startsWith('..') || path.isAbsolute(sourceRelativeToCwd)) {
    warnings.push({
      code: 'SKILL_IMPORT_SOURCE_OUTSIDE_CWD',
      message: `Import source is outside cwd: ${resolvedSourcePath}`,
    })
  }
  if (skill.resources.length === 0) {
    warnings.push({
      code: 'SKILL_IMPORT_NO_RESOURCES',
      message: 'Package has no indexed scripts, references, or assets.',
    })
  }
  for (const diagnostic of validation.diagnostics) {
    if (diagnostic.severity !== 'error') {
      warnings.push({
        code: 'SKILL_IMPORT_VALIDATION_WARNING',
        message: diagnostic.message,
      })
    }
  }

  try {
    const reg = await loadSkillRegistry({
      cwd: input.cwd,
      ...(input.builtInDir ? { builtInDir: input.builtInDir } : {}),
    })
    const normalizedNewName = normalizeNameForCompare(skill.name)
    for (const existing of reg.list()) {
      if (existing.id === skill.id) {
        warnings.push({
          code: 'SKILL_IMPORT_DUPLICATE_ID',
          message: `A skill with id "${skill.id}" already exists in ${existing.source} scope.`,
          conflictingId: existing.id,
        })
        continue
      }
      if (normalizeNameForCompare(existing.name) === normalizedNewName) {
        warnings.push({
          code: 'SKILL_IMPORT_DUPLICATE_NAME',
          message: `A skill named "${existing.name}" already exists (id=${existing.id}).`,
          conflictingId: existing.id,
        })
      }
    }
  } catch {
    // Best-effort duplicate warnings; source parsing remains the primary preview.
  }

  return {
    ok: true,
    previewOnly: true,
    sourcePath: resolvedSourcePath,
    packageRoot: raw.packageRoot ?? resolvedSourcePath,
    targetScope,
    targetPath: resolveTargetPath(input.cwd, targetScope, skill.id),
    skill,
    manifestPath: raw.manifestPath ?? path.join(resolvedSourcePath, 'SKILL.md'),
    resources: skill.resources,
    body: raw.content,
    diagnostics: validation.diagnostics,
    warnings,
    conversion: {
      sourceFormat: 'agent-skills-v1',
      targetFormat: 'agent-skills-v1',
      preservesPackageResources: true,
    },
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

async function copyPackageDirectorySafe(sourceRoot: string, targetRoot: string): Promise<void> {
  const sourceRealPath = await fs.realpath(sourceRoot)
  const isInsideSource = (targetPath: string): boolean => {
    const relativePath = path.relative(sourceRealPath, targetPath)
    return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath))
  }
  const copyDir = async (currentSource: string, currentTarget: string) => {
    await fs.mkdir(currentTarget, { recursive: true })
    const entries = await fs.readdir(currentSource, { withFileTypes: true })
    for (const entry of entries) {
      const sourcePath = path.join(currentSource, entry.name)
      const targetPath = path.join(currentTarget, entry.name)
      const linkStat = await fs.lstat(sourcePath)
      if (linkStat.isSymbolicLink()) continue
      const realPath = await fs.realpath(sourcePath)
      if (!isInsideSource(realPath)) continue
      if (linkStat.isDirectory()) {
        await copyDir(sourcePath, targetPath)
      } else if (linkStat.isFile()) {
        await fs.copyFile(sourcePath, targetPath)
      }
    }
  }
  await copyDir(sourceRoot, targetRoot)
}

export async function installSkillImport(input: SkillImportInstallInput): Promise<SkillImportInstallResult> {
  const preview = await previewSkillImport(input)
  if (!preview.ok) {
    return preview
  }
  if (!input.confirm) {
    return {
      ok: false,
      errorCode: 'SKILL_IMPORT_NOT_CONFIRMED',
      message: 'Import requires explicit `confirm: true` after preview.',
      preview,
    }
  }

  const isNewTarget = !await pathExists(preview.targetPath)
  if (!isNewTarget && !input.overwrite) {
    return {
      ok: false,
      errorCode: 'SKILL_IMPORT_OVERWRITE_REQUIRED',
      message: `Target package already exists; pass \`overwrite: true\` to replace it.`,
      preview,
    }
  }

  const targetParent = path.dirname(preview.targetPath)
  const tmpTarget = path.join(targetParent, `.${path.basename(preview.targetPath)}.${process.pid}.${Date.now()}.tmp`)
  try {
    await fs.mkdir(targetParent, { recursive: true })
    await fs.rm(tmpTarget, { recursive: true, force: true })
    await copyPackageDirectorySafe(preview.packageRoot, tmpTarget)
    if (!isNewTarget) {
      await fs.rm(preview.targetPath, { recursive: true, force: true })
    }
    await fs.rename(tmpTarget, preview.targetPath)
  } catch (err) {
    await fs.rm(tmpTarget, { recursive: true, force: true }).catch(() => {})
    return {
      ok: false,
      errorCode: 'SKILL_IMPORT_PERSIST_FAILED',
      message: err instanceof Error ? err.message : String(err),
      preview,
    }
  }

  return {
    ok: true,
    sourcePath: preview.sourcePath,
    targetScope: preview.targetScope,
    targetPath: preview.targetPath,
    skillId: preview.skill.id,
    format: isNewTarget ? 'new' : 'overwrite',
    resources: preview.resources,
    warnings: preview.warnings,
  }
}
