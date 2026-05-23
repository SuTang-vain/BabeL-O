import { z } from 'zod'
import { McpClient, type McpToolDefinition } from './McpClient.js'
import {
  isMcpToolAllowed,
  loadMcpRegistry,
  resolveMcpToolRisk,
  type McpServerConfig,
} from './McpRegistry.js'
import type { AnyTool, ToolDefinition } from '../tools/Tool.js'

const mcpInputSchema = z.record(z.string(), z.unknown()).default({})

export async function createMcpToolRegistry(cwd: string): Promise<Map<string, AnyTool>> {
  const registry = await loadMcpRegistry(cwd)
  const tools = new Map<string, AnyTool>()

  for (const [serverName, serverConfig] of Object.entries(registry.servers)) {
    const client = new McpClient(serverConfig)
    await client.initialize()
    const remoteTools = await client.listTools()
    for (const remoteTool of remoteTools) {
      const toolName = toRegisteredToolName(serverName, remoteTool.name)
      tools.set(toolName, createMcpTool(serverName, serverConfig, client, remoteTool, toolName))
    }
  }

  return tools
}

export function toRegisteredToolName(serverName: string, toolName: string): string {
  return `mcp:${serverName}:${toolName}`
}

function createMcpTool(
  serverName: string,
  serverConfig: McpServerConfig,
  client: McpClient,
  remoteTool: McpToolDefinition,
  registeredName: string,
): ToolDefinition<typeof mcpInputSchema> {
  const allowed = isMcpToolAllowed(serverConfig, remoteTool.name)

  return {
    name: registeredName,
    description: remoteTool.description || `MCP tool ${remoteTool.name} from ${serverName}.`,
    risk: resolveMcpToolRisk(serverConfig, remoteTool.name),
    inputSchema: mcpInputSchema,
    modelInputSchema: remoteTool.inputSchema ?? {
      type: 'object',
      additionalProperties: true,
    },
    source: {
      type: 'mcp',
      serverName,
      originalName: remoteTool.name,
    },
    dispose() {
      return client.shutdown()
    },
    async execute(input) {
      if (!allowed) {
        return {
          success: false,
          output: `MCP tool ${remoteTool.name} is not allowlisted for server ${serverName}.`,
        }
      }
      const result = await client.callTool(remoteTool.name, input)
      return {
        success: !result.isError,
        output: formatMcpResult(result),
      }
    },
  }
}

function formatMcpResult(result: unknown): unknown {
  const content = (result as { content?: unknown })?.content
  if (!Array.isArray(content)) return content ?? result
  return content
    .map(item => {
      if (item && typeof item === 'object' && 'text' in item) {
        return String((item as { text: unknown }).text)
      }
      return JSON.stringify(item)
    })
    .join('\n')
}
