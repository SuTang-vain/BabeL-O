import { z } from 'zod'
import type { NexusStorage } from '../storage/Storage.js'

export type ToolContext = {
  cwd: string
  sessionId: string
  signal?: AbortSignal
  maxOutputBytes: number
  bashMaxBufferBytes: number
  executionEnvironment?: 'local' | 'docker' | 'remote'
  storage?: NexusStorage
  allowedPaths?: string[]
}

export type ToolResult = {
  success: boolean
  output: unknown
}

export type ToolRisk = 'read' | 'write' | 'execute' | 'task'

export type ToolDefinition<TInput extends z.ZodType = z.ZodType> = {
  name: string
  description: string
  risk: ToolRisk
  inputSchema: TInput
  modelInputSchema?: unknown
  prompt?(): string
  source?: {
    type: 'builtin' | 'mcp'
    serverName?: string
    originalName?: string
  }
  requiresApproval?: boolean
  suggestedAllowRule?: string
  mcpServerAllowed?: boolean
  dispose?(): Promise<void> | void
  execute(input: z.infer<TInput>, context: ToolContext): Promise<ToolResult>
}

export type AnyTool = ToolDefinition<z.ZodType>
