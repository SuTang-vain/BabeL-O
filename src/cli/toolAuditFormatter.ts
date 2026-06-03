import chalk from 'chalk'
import type { RuntimeToolAuditEntry } from '../runtime/Runtime.js'

export type ToolAuditLike = RuntimeToolAuditEntry[] | { tools?: unknown }

export function formatToolAudit(audit: ToolAuditLike | unknown): string {
  const tools = normalizeToolAudit(audit)
  if (tools.length === 0) return chalk.dim('Tools audit unavailable.')

  const builtinTools = tools.filter(tool => tool.source?.type !== 'mcp')
  const mcpTools = tools.filter(tool => tool.source?.type === 'mcp')
  const lines = [
    chalk.bold('Tools'),
    `  builtin: ${builtinTools.length} · mcp: ${mcpTools.length}`,
  ]

  if (builtinTools.length > 0) {
    lines.push(`  ${chalk.bold('Built-in tools')}`)
    for (const tool of builtinTools) {
      lines.push(`  - ${tool.name} · ${formatRisk(tool.risk)} · ${formatPolicyState(tool.allowed)} · ${formatApproval(tool)}`)
    }
  }

  if (mcpTools.length > 0) {
    lines.push(`  ${chalk.bold('MCP tools')}`)
    for (const tool of mcpTools) {
      lines.push(formatMcpToolRow(tool))
    }
    lines.push(`  ${chalk.bold('MCP resources')}: ${chalk.dim('not exposed by current runtime')}`)
  } else {
    lines.push(`  ${chalk.bold('MCP tools')}: ${chalk.dim('none registered')}`)
  }

  return lines.join('\n')
}

export function normalizeToolAudit(audit: ToolAuditLike | unknown): RuntimeToolAuditEntry[] {
  const tools = Array.isArray(audit)
    ? audit
    : audit && typeof audit === 'object' && Array.isArray((audit as { tools?: unknown }).tools)
      ? (audit as { tools: unknown[] }).tools
      : []
  return tools
    .filter(isRuntimeToolAuditEntry)
    .sort((left, right) => left.name.localeCompare(right.name))
}

function formatMcpToolRow(tool: RuntimeToolAuditEntry): string {
  const server = tool.source?.serverName ?? 'unknown'
  const original = tool.source?.originalName ?? tool.name.replace(/^mcp:[^:]+:/, '')
  const serverState = tool.mcpServerAllowed === undefined
    ? chalk.dim('server unknown')
    : tool.mcpServerAllowed
      ? chalk.green('server enabled')
      : chalk.red('server disabled')
  const allowRule = tool.suggestedAllowRule
    ? ` · allow ${chalk.cyan(tool.suggestedAllowRule)}`
    : ''
  return `  - ${server}.${original} · registered=${tool.name} · ${formatRisk(tool.risk)} · ${formatPolicyState(tool.allowed)} · ${serverState} · ${formatApproval(tool)} · source=mcp/${server}${allowRule}`
}

function formatRisk(risk: RuntimeToolAuditEntry['risk']): string {
  if (risk === 'execute') return chalk.red('execute risk')
  if (risk === 'write') return chalk.yellow('write risk')
  if (risk === 'task') return chalk.cyan('task risk')
  return chalk.green('read risk')
}

function formatPolicyState(allowed: boolean): string {
  return allowed ? chalk.green('policy enabled') : chalk.red('policy disabled')
}

function formatApproval(tool: RuntimeToolAuditEntry): string {
  const required = tool.requiresApproval ?? (tool.risk === 'write' || tool.risk === 'execute')
  return required ? chalk.yellow('approval required') : chalk.dim('approval no')
}

function isRuntimeToolAuditEntry(value: unknown): value is RuntimeToolAuditEntry {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.name === 'string' &&
    typeof record.description === 'string' &&
    typeof record.risk === 'string' &&
    typeof record.allowed === 'boolean'
}
