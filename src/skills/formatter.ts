/**
 * Skill formatter — convert a normalized skill back into canonical Markdown.
 *
 * Phase 1 minimal: front-matter only. The body is preserved as-is. Section
 * rewrites (e.g. ensuring `# Purpose` / `# Procedure` headers) are deferred
 * to Phase 5 (draft generation) since they require semantic understanding.
 *
 * Per the Skill governance plan §Backward compatibility: normalization is
 * in-memory only; files are rewritten only through an explicit format/save
 * action. This module exposes the canonical writer; the registry does not
 * call it during load.
 */

import type { NormalizedSkill } from './schema.js'

function yamlString(value: string): string {
  // Avoid quoting when the value is simple; otherwise wrap in double quotes
  // and escape embedded double quotes.
  if (/^[A-Za-z0-9 _.\-/()]+$/.test(value)) return value
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function yamlList(values: string[]): string {
  if (values.length === 0) return '[]'
  return values.map(v => `  - ${yamlString(v)}`).join('\n')
}

/**
 * Render a normalized skill as canonical Markdown (front matter + body).
 *
 * The body is taken from `skill.content` as-is. If the body lacks the
 * recommended sections (`# Purpose` / `# Procedure` / etc.), they are NOT
 * injected automatically — that's a Phase 5 (draft generation) concern.
 */
export function formatSkill(skill: NormalizedSkill): string {
  const lines: string[] = ['---']
  lines.push(`id: ${yamlString(skill.id)}`)
  lines.push(`name: ${yamlString(skill.name)}`)
  if (skill.description) {
    lines.push(`description: ${yamlString(skill.description)}`)
  }
  lines.push(`version: ${skill.version}`)
  lines.push(`status: ${skill.status}`)
  lines.push(`source: ${skill.source}`)
  lines.push(`scope: ${skill.scope}`)
  lines.push(`triggers:`)
  lines.push(yamlList(skill.triggers).split('\n').map(l => l.replace(/^  - /, '  - ')).join('\n'))
  lines.push(`priority: ${skill.priority}`)
  lines.push(`risk: ${skill.risk}`)
  if (skill.allowedTools.length > 0) {
    lines.push(`allowedTools:`)
    lines.push(yamlList(skill.allowedTools))
  }
  if (skill.createdAt) lines.push(`createdAt: ${yamlString(skill.createdAt)}`)
  if (skill.updatedAt) lines.push(`updatedAt: ${yamlString(skill.updatedAt)}`)
  if (skill.owner) lines.push(`owner: ${yamlString(skill.owner)}`)
  lines.push('---')
  lines.push('')
  lines.push(skill.content.trim())
  lines.push('')
  return lines.join('\n')
}
