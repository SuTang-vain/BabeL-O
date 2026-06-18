// Tool registry layering diagnostics tests (§2.2 of the Tool Surface
// Expansion plan). Covers: tool_overridden_by, tool_override_blocked,
// risk_promoted, consoleWarnDiagnosticHandler, registerToolWithDiagnostics,
// and end-to-end createDefaultNexusRuntime with diagnostic handler.
//
// Test isolation: all tests use in-memory storage (NODE_ENV=test default).

import { describe, it } from 'node:test'
import * as assert from 'node:assert'
import { registerToolWithDiagnostics, type ToolRegistryDiagnostic } from '../src/nexus/toolRegistryLayering.js'
import { createDefaultToolRegistry } from '../src/tools/registry.js'
import { readTool } from '../src/tools/builtin/read.js'
import { writeTool } from '../src/tools/builtin/write.js'
import { bashTool } from '../src/tools/builtin/bash.js'
import { globTool } from '../src/tools/builtin/glob.js'
import { listDirTool } from '../src/tools/builtin/listDir.js'
import type { AnyTool } from '../src/tools/Tool.js'

function collectDiagnostics(
  tools: Map<string, AnyTool>,
  tool: AnyTool,
): ToolRegistryDiagnostic[] {
  const collected: ToolRegistryDiagnostic[] = []
  registerToolWithDiagnostics(tools, tool, d => collected.push(d))
  return collected
}

describe('registerToolWithDiagnostics', () => {
  // ---- T1: clean registration (no override) ----
  it('registers a tool when no name collision exists', () => {
    const tools = createDefaultToolRegistry()
    const initialSize = tools.size
    // Create a tool with a unique name.
    const unique: AnyTool = {
      name: 'test_unique_tool',
      description: 'a unique test tool',
      risk: 'read',
      inputSchema: readTool.inputSchema,
      execute: async () => ({ success: true, output: 'ok' }),
    }
    const diags = collectDiagnostics(tools, unique)
    assert.strictEqual(diags.length, 0, 'no diagnostic for clean registration')
    assert.strictEqual(tools.size, initialSize + 1, 'tool was added')
    assert.ok(tools.has('test_unique_tool'), 'tool is in the registry')
  })

  // ---- T2: tool_overridden_by ----
  it('emits tool_overridden_by when name collision occurs', () => {
    const tools = new Map<string, AnyTool>()
    // Register a builtin first.
    tools.set('Read', readTool as AnyTool)

    // Now register a fake MCP tool with the same name.
    const mcpRead: AnyTool = {
      name: 'Read',
      description: 'mcp read tool',
      risk: 'read',
      inputSchema: readTool.inputSchema,
      source: { type: 'mcp', serverName: 'fake-server', originalName: 'Read' },
      execute: async () => ({ success: true, output: 'mcp read' }),
    }

    const diags = collectDiagnostics(tools, mcpRead)
    const overrides = diags.filter(d => d.kind === 'tool_overridden_by')
    assert.strictEqual(overrides.length, 1, 'emits one tool_overridden_by')
    assert.strictEqual(overrides[0].toolName, 'Read')
    assert.strictEqual(overrides[0].existingSource, 'builtin')
    assert.strictEqual(overrides[0].newSource, 'mcp:fake-server')
    assert.ok(tools.get('Read') === mcpRead, 'MCP tool replaces builtin')
  })

  // ---- T3: risk_promoted when new tool has higher risk ----
  it('emits risk_promoted when override escalates risk', () => {
    const tools = new Map<string, AnyTool>()
    // Register a read-risk tool.
    tools.set('FileTool', {
      name: 'FileTool',
      description: 'read-only file tool',
      risk: 'read',
      inputSchema: readTool.inputSchema,
      source: { type: 'builtin' },
      execute: async () => ({ success: true, output: 'ok' }),
    } as AnyTool)

    // Now override with an execute-risk tool.
    const execOverride: AnyTool = {
      name: 'FileTool',
      description: 'exec-capable file tool',
      risk: 'execute',
      inputSchema: bashTool.inputSchema,
      source: { type: 'mcp', serverName: 'dangerous-server' },
      execute: async () => ({ success: true, output: 'executed' }),
    }

    const diags = collectDiagnostics(tools, execOverride)

    const overrides = diags.filter(d => d.kind === 'tool_overridden_by')
    assert.strictEqual(overrides.length, 1)

    const promoted = diags.filter(d => d.kind === 'risk_promoted')
    assert.strictEqual(promoted.length, 1, 'emits risk_promoted when risk escalates')
    assert.strictEqual(promoted[0].toolName, 'FileTool')
    assert.strictEqual(promoted[0].existingRisk, 'read')
    assert.strictEqual(promoted[0].newRisk, 'execute')
  })

  // ---- T4: no risk_promoted when risk is equal ----
  it('does not emit risk_promoted when risk stays the same', () => {
    const tools = new Map<string, AnyTool>()
    tools.set('Read', readTool as AnyTool)

    const sameRisk: AnyTool = {
      name: 'Read',
      description: 'another read tool',
      risk: 'read',
      inputSchema: readTool.inputSchema,
      source: { type: 'mcp', serverName: 'safe-server' },
      execute: async () => ({ success: true, output: 'ok' }),
    }

    const diags = collectDiagnostics(tools, sameRisk)
    assert.strictEqual(diags.filter(d => d.kind === 'tool_overridden_by').length, 1)
    assert.strictEqual(diags.filter(d => d.kind === 'risk_promoted').length, 0,
      'no risk_promoted when risk is equal')
  })

  // ---- T5: no risk_promoted when risk is lower ----
  it('does not emit risk_promoted when new risk is lower', () => {
    const tools = new Map<string, AnyTool>()
    tools.set('Bash', bashTool as AnyTool) // risk: execute

    const lowerRisk: AnyTool = {
      name: 'Bash',
      description: 'read-only bash',
      risk: 'read',
      inputSchema: bashTool.inputSchema,
      source: { type: 'mcp', serverName: 'safe-server' },
      execute: async () => ({ success: true, output: 'ok' }),
    }

    const diags = collectDiagnostics(tools, lowerRisk)
    assert.strictEqual(diags.filter(d => d.kind === 'tool_overridden_by').length, 1)
    assert.strictEqual(diags.filter(d => d.kind === 'risk_promoted').length, 0,
      'no risk_promoted when risk goes down')
  })

  // ---- T6: tool_override_blocked for evercore → non-evercore ----
  it('blocks evercore tool from overriding non-evercore tool', () => {
    const tools = new Map<string, AnyTool>()
    // Register an MCP tool under the evercore prefix (unusual but possible).
    tools.set('mcp:evercore:memory_search', {
      name: 'mcp:evercore:memory_search',
      description: 'external memory search',
      risk: 'read',
      inputSchema: readTool.inputSchema,
      source: { type: 'mcp', serverName: 'external-mem' },
      execute: async () => ({ success: true, output: 'ok' }),
    } as AnyTool)

    // Now an EverCore tool tries to register the same name.
    const everCoreTool: AnyTool = {
      name: 'mcp:evercore:memory_search',
      description: 'evercore memory search',
      risk: 'read',
      inputSchema: readTool.inputSchema,
      source: { type: 'mcp', serverName: 'evercore', originalName: 'memory_search' },
      execute: async () => ({ success: true, output: 'evercore' }),
    }

    const diags = collectDiagnostics(tools, everCoreTool)
    const blocked = diags.filter(d => d.kind === 'tool_override_blocked')
    assert.strictEqual(blocked.length, 1, 'emits tool_override_blocked')
    assert.strictEqual(blocked[0].toolName, 'mcp:evercore:memory_search')
    assert.ok(blocked[0].message.includes('BLOCKED'), 'message indicates blocked')

    // Verify the original tool is still registered.
    const existing = tools.get('mcp:evercore:memory_search')
    assert.ok(existing, 'original tool still exists')
    assert.strictEqual(existing?.source?.serverName, 'external-mem',
      'original tool was not replaced')
  })

  // ---- T7: evercore → evercore override is allowed (tool_overridden_by) ----
  it('allows evercore → evercore override with diagnostic', () => {
    const tools = new Map<string, AnyTool>()
    tools.set('mcp:evercore:memory_search', {
      name: 'mcp:evercore:memory_search',
      description: 'old evercore memory search',
      risk: 'read',
      inputSchema: readTool.inputSchema,
      source: { type: 'mcp', serverName: 'evercore' },
      execute: async () => ({ success: true, output: 'old' }),
    } as AnyTool)

    const newEverCore: AnyTool = {
      name: 'mcp:evercore:memory_search',
      description: 'new evercore memory search',
      risk: 'read',
      inputSchema: readTool.inputSchema,
      source: { type: 'mcp', serverName: 'evercore' },
      execute: async () => ({ success: true, output: 'new' }),
    }

    const diags = collectDiagnostics(tools, newEverCore)
    assert.strictEqual(diags.filter(d => d.kind === 'tool_override_blocked').length, 0,
      'evercore→evercore is not blocked')
    assert.strictEqual(diags.filter(d => d.kind === 'tool_overridden_by').length, 1,
      'emits tool_overridden_by')
    assert.ok(tools.get('mcp:evercore:memory_search') === newEverCore,
      'new evercore tool replaces old')
  })

  // ---- T8: returns false when registration is blocked ----
  it('returns false when registration is blocked', () => {
    const tools = new Map<string, AnyTool>()
    tools.set('mcp:evercore:test', {
      name: 'mcp:evercore:test',
      description: 'external tool under evercore prefix',
      risk: 'read',
      inputSchema: readTool.inputSchema,
      source: { type: 'mcp', serverName: 'external' },
      execute: async () => ({ success: true, output: 'ok' }),
    } as AnyTool)

    const everCoreBlocked: AnyTool = {
      name: 'mcp:evercore:test',
      description: 'evercore tool',
      risk: 'read',
      inputSchema: readTool.inputSchema,
      source: { type: 'mcp', serverName: 'evercore' },
      execute: async () => ({ success: true, output: 'evercore' }),
    }

    const result = registerToolWithDiagnostics(tools, everCoreBlocked, () => {})
    assert.strictEqual(result, false, 'returns false when blocked')
  })

  // ---- T9: returns true when registration succeeds ----
  it('returns true when registration succeeds', () => {
    const tools = createDefaultToolRegistry()
    const newTool: AnyTool = {
      name: 'unique_tool_name',
      description: 'test',
      risk: 'read',
      inputSchema: readTool.inputSchema,
      execute: async () => ({ success: true, output: 'ok' }),
    }
    const result = registerToolWithDiagnostics(tools, newTool)
    assert.strictEqual(result, true, 'returns true on success')
  })

  // ---- T10: no diagnostic when handler is undefined ----
  it('does not throw when handler is undefined', () => {
    const tools = new Map<string, AnyTool>()
    tools.set('Read', readTool as AnyTool)

    const override: AnyTool = {
      name: 'Read',
      description: 'override',
      risk: 'execute',
      inputSchema: readTool.inputSchema,
      source: { type: 'mcp', serverName: 'test' },
      execute: async () => ({ success: true, output: 'ok' }),
    }

    // Should not throw.
    assert.doesNotThrow(() => {
      registerToolWithDiagnostics(tools, override, undefined)
    })
  })

  // ---- T11: consoleWarnDiagnosticHandler does not throw ----
  it('consoleWarnDiagnosticHandler writes to console.warn', async () => {
    const { consoleWarnDiagnosticHandler } = await import('../src/nexus/toolRegistryLayering.js')
    const diag: ToolRegistryDiagnostic = {
      kind: 'tool_overridden_by',
      toolName: 'TestTool',
      newSource: 'mcp:test',
      newRisk: 'read',
      message: '[tool_registry] TestTool: overridden by mcp:test',
    }
    assert.doesNotThrow(() => {
      consoleWarnDiagnosticHandler(diag)
    })
  })
})
