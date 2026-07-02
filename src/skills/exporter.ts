import fs from 'fs/promises'
import path from 'path'
import { loadSkillRegistry } from './registry.js'
import type { NormalizedSkill, SkillDiagnostic, SkillResource } from './schema.js'

export type SkillExportPreviewInput = {
  cwd: string
  id: string
  targetDir?: string
  builtInDir?: string
}

export type SkillExportWriteInput = SkillExportPreviewInput & {
  confirm: boolean
  overwrite?: boolean
}

export type SkillExportPreviewResult =
  | {
      ok: true
      previewOnly: true
      skillId: string
      targetDir: string
      packageRoot: string
      manifestPath: string
      manifest: string
      resources: SkillResource[]
      diagnostics: SkillDiagnostic[]
      conversion: {
        sourceFormat: NormalizedSkill['sourceFormat']
        targetFormat: 'agent-skills-v1'
        preservesPackageResources: boolean
      }
    }
  | {
      ok: false
      errorCode: 'SKILL_EXPORT_INVALID_INPUT' | 'SKILL_NOT_FOUND' | 'SKILL_EXPORT_LOAD_FAILED'
      message: string
      id?: string
      diagnostics?: SkillDiagnostic[]
    }

export type SkillExportWriteResult =
  | {
      ok: true
      skillId: string
      targetDir: string
      packageRoot: string
      manifestPath: string
      format: 'new' | 'overwrite'
      resources: SkillResource[]
      conversion: Extract<SkillExportPreviewResult, { ok: true }>['conversion']
    }
  | {
      ok: false
      errorCode:
        | 'SKILL_EXPORT_NOT_CONFIRMED'
        | 'SKILL_EXPORT_OVERWRITE_REQUIRED'
        | 'SKILL_EXPORT_PERSIST_FAILED'
        | Extract<SkillExportPreviewResult, { ok: false }>['errorCode']
      message: string
      preview?: Extract<SkillExportPreviewResult, { ok: true }>
      id?: string
      diagnostics?: SkillDiagnostic[]
    }

function yamlString(value: string): string {
  if (/^[A-Za-z0-9 _.\-/()]+$/.test(value)) return value
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function yamlList(values: string[], indent = '      '): string[] {
  if (values.length === 0) return [`${indent}[]`]
  return values.map(value => `${indent}- ${yamlString(value)}`)
}

function buildAgentSkillManifest(skill: NormalizedSkill): string {
  const lines: string[] = ['---']
  lines.push(`name: ${yamlString(skill.id)}`)
  lines.push(`description: ${yamlString(skill.description || skill.name)}`)
  if (skill.license) lines.push(`license: ${yamlString(skill.license)}`)
  if (skill.compatibility) lines.push(`compatibility: ${yamlString(skill.compatibility)}`)
  if (skill.allowedTools.length > 0) {
    lines.push(`allowed-tools: ${skill.allowedTools.map(yamlString).join(' ')}`)
  }
  lines.push('metadata:')
  lines.push('  babel-o:')
  lines.push(`    schemaVersion: 2026-07-02.skill.v2`)
  lines.push(`    id: ${yamlString(skill.id)}`)
  lines.push(`    displayName: ${yamlString(skill.name)}`)
  lines.push(`    status: ${skill.status}`)
  lines.push(`    scope: ${skill.scope}`)
  lines.push(`    priority: ${skill.priority}`)
  lines.push(`    risk: ${skill.risk}`)
  lines.push('    triggers:')
  lines.push(...yamlList(skill.triggers))
  lines.push('---')
  lines.push('')
  lines.push(skill.content.trim())
  lines.push('')
  return lines.join('\n')
}

export async function previewSkillExport(input: SkillExportPreviewInput): Promise<SkillExportPreviewResult> {
  if (!input.id.trim()) {
    return {
      ok: false,
      errorCode: 'SKILL_EXPORT_INVALID_INPUT',
      message: '`id` is required.',
    }
  }

  try {
    const reg = await loadSkillRegistry({
      cwd: input.cwd,
      ...(input.builtInDir ? { builtInDir: input.builtInDir } : {}),
    })
    const skill = reg.get(input.id)
    if (!skill) {
      return {
        ok: false,
        errorCode: 'SKILL_NOT_FOUND',
        message: `Skill "${input.id}" not found in registry (cwd=${input.cwd}).`,
        id: input.id,
      }
    }

    const targetDir = path.resolve(input.cwd, input.targetDir ?? path.join('skill-exports', skill.id))
    const packageRoot = path.join(targetDir, skill.id)
    const manifestPath = path.join(packageRoot, 'SKILL.md')
    const resources = skill.resources.map(resource => ({ ...resource }))

    return {
      ok: true,
      previewOnly: true,
      skillId: skill.id,
      targetDir,
      packageRoot,
      manifestPath,
      manifest: buildAgentSkillManifest(skill),
      resources,
      diagnostics: [],
      conversion: {
        sourceFormat: skill.sourceFormat,
        targetFormat: 'agent-skills-v1',
        preservesPackageResources: skill.sourceFormat === 'agent-skills-v1',
      },
    }
  } catch (err) {
    return {
      ok: false,
      errorCode: 'SKILL_EXPORT_LOAD_FAILED',
      message: err instanceof Error ? err.message : String(err),
      id: input.id,
    }
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

async function copyExportResources(resources: SkillResource[], packageRoot: string): Promise<void> {
  for (const resource of resources) {
    if (!resource.absolutePath) continue
    const targetPath = path.join(packageRoot, resource.path)
    try {
      const linkStat = await fs.lstat(resource.absolutePath)
      if (linkStat.isSymbolicLink() || !linkStat.isFile()) continue
      await fs.mkdir(path.dirname(targetPath), { recursive: true })
      await fs.copyFile(resource.absolutePath, targetPath)
    } catch {
      // Resource copying is best effort for export: missing resources should not
      // prevent exporting the portable manifest.
    }
  }
}

export async function writeSkillExport(input: SkillExportWriteInput): Promise<SkillExportWriteResult> {
  const preview = await previewSkillExport(input)
  if (!preview.ok) {
    return preview
  }
  if (!input.confirm) {
    return {
      ok: false,
      errorCode: 'SKILL_EXPORT_NOT_CONFIRMED',
      message: 'Export requires explicit `confirm: true` after preview.',
      preview,
    }
  }

  const isNewTarget = !await pathExists(preview.packageRoot)
  if (!isNewTarget && !input.overwrite) {
    return {
      ok: false,
      errorCode: 'SKILL_EXPORT_OVERWRITE_REQUIRED',
      message: `Target package already exists; pass \`overwrite: true\` to replace it.`,
      preview,
    }
  }

  const targetParent = path.dirname(preview.packageRoot)
  const tmpTarget = path.join(targetParent, `.${path.basename(preview.packageRoot)}.${process.pid}.${Date.now()}.tmp`)
  try {
    await fs.mkdir(targetParent, { recursive: true })
    await fs.rm(tmpTarget, { recursive: true, force: true })
    await fs.mkdir(tmpTarget, { recursive: true })
    await fs.writeFile(path.join(tmpTarget, 'SKILL.md'), preview.manifest, 'utf-8')
    await copyExportResources(preview.resources, tmpTarget)
    if (!isNewTarget) {
      await fs.rm(preview.packageRoot, { recursive: true, force: true })
    }
    await fs.rename(tmpTarget, preview.packageRoot)
  } catch (err) {
    await fs.rm(tmpTarget, { recursive: true, force: true }).catch(() => {})
    return {
      ok: false,
      errorCode: 'SKILL_EXPORT_PERSIST_FAILED',
      message: err instanceof Error ? err.message : String(err),
      preview,
    }
  }

  return {
    ok: true,
    skillId: preview.skillId,
    targetDir: preview.targetDir,
    packageRoot: preview.packageRoot,
    manifestPath: preview.manifestPath,
    format: isNewTarget ? 'new' : 'overwrite',
    resources: preview.resources,
    conversion: preview.conversion,
  }
}
