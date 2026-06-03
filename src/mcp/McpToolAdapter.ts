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
type JsonSchemaObject = {
  type?: unknown
  properties?: unknown
  required?: unknown
  additionalProperties?: unknown
  enum?: unknown
  items?: unknown
}

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
  const runtimeInputSchema = createRuntimeInputValidator(remoteTool.inputSchema)
  const risk = resolveMcpToolRisk(serverConfig, remoteTool.name)

  return {
    name: registeredName,
    description: remoteTool.description || `MCP tool ${remoteTool.name} from ${serverName}.`,
    risk,
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
    requiresApproval: risk === 'write' || risk === 'execute',
    suggestedAllowRule: registeredName,
    mcpServerAllowed: allowed,
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
      const parsed = runtimeInputSchema.safeParse(input)
      if (!parsed.success) {
        return {
          success: false,
          output: {
            error: 'MCP_INPUT_SCHEMA_VALIDATION_FAILED',
            message: `MCP tool ${remoteTool.name} input failed remote inputSchema validation.`,
            issues: parsed.error.issues.map(issue => ({
              path: issue.path.join('.'),
              message: issue.message,
            })),
          },
        }
      }
      const result = await client.callTool(remoteTool.name, parsed.data)
      return {
        success: !result.isError,
        output: formatMcpResult(result),
      }
    },
  }
}

function createRuntimeInputValidator(inputSchema: unknown): z.ZodType<unknown> {
  return jsonSchemaToZod(inputSchema).default({})
}

function jsonSchemaToZod(schema: unknown): z.ZodType<unknown> {
  if (!schema || typeof schema !== 'object') return z.record(z.string(), z.unknown())
  const jsonSchema = schema as JsonSchemaObject

  if (Array.isArray(jsonSchema.enum)) {
    const values = jsonSchema.enum
    return z.unknown().refine(value => values.includes(value), {
      message: `Expected one of: ${values.map(value => JSON.stringify(value)).join(', ')}`,
    })
  }

  const type = jsonSchema.type
  if (type === 'object' || jsonSchema.properties) {
    const properties = jsonSchema.properties && typeof jsonSchema.properties === 'object'
      ? jsonSchema.properties as Record<string, unknown>
      : {}
    const required = Array.isArray(jsonSchema.required)
      ? new Set(jsonSchema.required.filter((item): item is string => typeof item === 'string'))
      : new Set<string>()
    const shape: Record<string, z.ZodType<unknown>> = {}
    for (const [key, value] of Object.entries(properties)) {
      const propertySchema = jsonSchemaToZod(value)
      shape[key] = required.has(key) ? propertySchema : propertySchema.optional()
    }
    const objectSchema = z.object(shape)
    return jsonSchema.additionalProperties === false ? objectSchema.strict() : objectSchema.passthrough()
  }

  if (type === 'string') return z.string()
  if (type === 'number') return z.number()
  if (type === 'integer') return z.number().int()
  if (type === 'boolean') return z.boolean()
  if (type === 'array') return z.array(jsonSchemaToZod(jsonSchema.items))
  if (Array.isArray(type)) {
    const options = type.map(item => jsonSchemaToZod({ ...jsonSchema, type: item }))
    if (options.length === 0) return z.unknown()
    if (options.length === 1) return options[0] ?? z.unknown()
    return z.union(options as [z.ZodType<unknown>, z.ZodType<unknown>, ...z.ZodType<unknown>[]])
  }

  return z.unknown()
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
