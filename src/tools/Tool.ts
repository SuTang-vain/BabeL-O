import { z } from 'zod'

export type ToolContext = {
  cwd: string
  sessionId: string
  signal?: AbortSignal
  maxOutputBytes: number
  bashMaxBufferBytes: number
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
  execute(input: z.infer<TInput>, context: ToolContext): Promise<ToolResult>
}

export type AnyTool = ToolDefinition<z.ZodType>
