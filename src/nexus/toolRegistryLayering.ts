// Tool registry layering diagnostics (§2.2 of the Tool Surface Expansion plan).
//
// When createDefaultNexusRuntime registers tools across layers (Layer 1
// builtin → Layer 2 MCP → Layer 3 EverCore MCP → Layer 4 Agent tools),
// each `tools.set(name, tool)` call is unconditional. This module adds a
// diagnostic wrapper that detects:
//
//   tool_overridden_by   – same-name override across layers
//   tool_override_blocked – EverCore prefix tool would override non-evercore
//   risk_promoted        – new tool has higher risk than the overridden tool
//
// These diagnostics are defense-in-depth: MCP tools currently use the
// `mcp:<server>:<name>` prefix convention so builtin collisions are
// unlikely, but a future naming change or a misconfigured server could
// still cause silent overrides. The diagnostic logger makes every
// override visible.
//
// Risk ordering: read (0) < write (1) < execute (2) < task (3)

import type { AnyTool, ToolRisk } from '../tools/Tool.js'

// ---- public types ----

export type ToolRegistryDiagnostic = {
  kind: 'tool_overridden_by' | 'tool_override_blocked' | 'risk_promoted'
  toolName: string
  /** The tool that was already in the registry (the "victim"). */
  existingSource?: string
  existingRisk?: ToolRisk
  /** The tool that is attempting to register (the "override"). */
  newSource: string
  newRisk: ToolRisk
  message: string
}

export type ToolRegistryDiagnosticHandler = (
  diagnostic: ToolRegistryDiagnostic,
) => void

// ---- risk helpers ----

const RISK_SCORE: Record<ToolRisk, number> = {
  read: 0,
  write: 1,
  execute: 2,
  task: 3,
}

function riskScore(r: ToolRisk): number {
  return RISK_SCORE[r]
}

function describeSource(tool: AnyTool): string {
  const src = tool.source
  if (!src) return 'builtin'
  if (src.type === 'mcp') return `mcp:${src.serverName ?? 'unknown'}`
  return src.type
}

function isEverCoreTool(tool: AnyTool): boolean {
  return tool.source?.serverName === 'evercore'
}

function hasEverCorePrefix(tool: AnyTool): boolean {
  return tool.name.startsWith('mcp:evercore:')
}

// ---- diagnostic builder ----

function buildDiagnostic(params: {
  kind: ToolRegistryDiagnostic['kind']
  toolName: string
  existing?: AnyTool
  newTool: AnyTool
  reason?: string
}): ToolRegistryDiagnostic {
  const { kind, toolName, existing, newTool, reason } = params
  const newSource = describeSource(newTool)
  const newRisk = newTool.risk

  let message: string
  switch (kind) {
    case 'tool_overridden_by':
      message =
        `[tool_registry] ${toolName}: overridden by ${newSource} ` +
        `(was ${existing ? describeSource(existing) : 'none'})` +
        (reason ? ` — ${reason}` : '')
      break
    case 'tool_override_blocked':
      message =
        `[tool_registry] ${toolName}: override BLOCKED — ` +
        `${newSource} would override non-evercore tool ` +
        `${existing ? describeSource(existing) : 'unknown'}` +
        (reason ? ` — ${reason}` : '')
      break
    case 'risk_promoted':
      message =
        `[tool_registry] ${toolName}: risk PROMOTED ` +
        `${existing?.risk ?? '?'} → ${newRisk} by ${newSource}` +
        (reason ? ` — ${reason}` : '')
      break
  }

  return {
    kind,
    toolName,
    existingSource: existing ? describeSource(existing) : undefined,
    existingRisk: existing?.risk,
    newSource,
    newRisk,
    message,
  }
}

// ---- registration helper ----

const EVERCORE_PREFIX = 'mcp:evercore:'

/**
 * Register `newTool` into `tools`, emitting diagnostics when the
 * registration would override an existing tool.
 *
 * Rules (in order):
 * 1. If the name is already registered AND the new tool is an EverCore
 *    tool overriding a non-EverCore tool → `tool_override_blocked` (skip
 *    the set, do not register).
 * 2. If the name is already registered → `tool_overridden_by` WARN.
 * 3. If rule 2 fired AND the new tool has higher risk → additionally
 *    emit `risk_promoted`.
 *
 * Returns `true` if the tool was actually registered, `false` if blocked.
 */
export function registerToolWithDiagnostics(
  tools: Map<string, AnyTool>,
  newTool: AnyTool,
  onDiagnostic?: ToolRegistryDiagnosticHandler,
): boolean {
  const existing = tools.get(newTool.name)

  if (!existing) {
    tools.set(newTool.name, newTool)
    return true
  }

  // Rule 1: EverCore prefix override of non-evercore → blocked.
  // EverCore tools have source.serverName === 'evercore'. If an external
  // MCP server registered a tool at the `mcp:evercore:*` namespace
  // (unusual but possible), the true EverCore registration must not
  // silently overwrite it.
  const newIsEverCore = isEverCoreTool(newTool)
  const existingIsEverCore = isEverCoreTool(existing)

  if (newIsEverCore && !existingIsEverCore) {
    if (onDiagnostic) {
      onDiagnostic(
        buildDiagnostic({
          kind: 'tool_override_blocked',
          toolName: newTool.name,
          existing,
          newTool,
          reason: 'evercore tool may not override non-evercore registration',
        }),
      )
    }
    return false // skip registration
  }

  // Rule 2: same-name override → diagnostic.
  if (onDiagnostic) {
    onDiagnostic(
      buildDiagnostic({
        kind: 'tool_overridden_by',
        toolName: newTool.name,
        existing,
        newTool,
      }),
    )
  }

  // Rule 3: risk escalation check.
  if (riskScore(newTool.risk) > riskScore(existing.risk)) {
    if (onDiagnostic) {
      onDiagnostic(
        buildDiagnostic({
          kind: 'risk_promoted',
          toolName: newTool.name,
          existing,
          newTool,
          reason: `risk escalated from ${existing.risk} to ${newTool.risk}`,
        }),
      )
    }
  }

  tools.set(newTool.name, newTool)
  return true
}

/**
 * Default diagnostic handler: logs to console.warn. Callers that want
 * structured collection (e.g. for `/v1/runtime/status` or tests) should
 * pass their own handler.
 */
export function consoleWarnDiagnosticHandler(
  diagnostic: ToolRegistryDiagnostic,
): void {
  console.warn(diagnostic.message)
}
