import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import os from 'node:os'
import { z } from 'zod'
import type { ToolRisk } from '../tools/Tool.js'

const McpServerConfigSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  cwd: z.string().optional(),
  allowedTools: z.array(z.string()).default([]),
  toolRisk: z.record(z.string(), z.enum(['read', 'write', 'execute', 'task'])).default({}),
})

const McpConfigSchema = z.object({
  servers: z.record(z.string(), McpServerConfigSchema).default({}),
})

export type McpServerConfig = z.infer<typeof McpServerConfigSchema>
export type McpConfig = z.infer<typeof McpConfigSchema>

export async function loadMcpRegistry(cwd: string): Promise<McpConfig> {
  const userConfig = await readConfig(join(os.homedir(), '.babel-o', 'mcp.json'))
  const projectConfig = await readConfig(join(cwd, '.babel-o', 'mcp.json'))

  return {
    servers: {
      ...userConfig.servers,
      ...projectConfig.servers,
    },
  }
}

export function isMcpToolAllowed(server: McpServerConfig, toolName: string): boolean {
  return server.allowedTools.includes(toolName)
}

export function resolveMcpToolRisk(server: McpServerConfig, toolName: string): ToolRisk {
  return server.toolRisk[toolName] ?? 'read'
}

async function readConfig(path: string): Promise<McpConfig> {
  try {
    const raw = await readFile(path, 'utf8')
    return McpConfigSchema.parse(JSON.parse(raw))
  } catch (err: any) {
    if (err?.code === 'ENOENT') return { servers: {} }
    throw err
  }
}
