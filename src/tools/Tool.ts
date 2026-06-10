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
  /**
   * Optional per-input risk override. When set, the runtime uses the
   * returned risk value (instead of the static `risk` field) for both
   * policy evaluation and the approval gate. This lets tools like Bash
   * advertise a baseline `risk: 'execute'` for audit clarity while
   * marking read-only subcommands (`git status`, `ls`, `cat`, ...) as
   * `risk: 'read'` for policy purposes.
   *
   * Tools that don't override this fall back to the static `risk` field.
   *
   * The parameter is typed as `any` (not `z.infer<TInput>`) so that
   * `ToolDefinition<TInput>` values can be stored in a heterogeneous
   * `Map<string, AnyTool>` (function parameter contravariance would
   * otherwise reject narrower input types when widening to `unknown`).
   * The runtime casts back to the concrete input type when invoking.
   */
  riskForInput?: (input: any) => ToolRisk
  dispose?(): Promise<void> | void
  execute(input: z.infer<TInput>, context: ToolContext): Promise<ToolResult>
}

export type AnyTool = ToolDefinition<z.ZodType>
