import type { NexusEvent } from '../shared/events.js'
import type { ToolRisk } from '../tools/Tool.js'

export type RuntimeExecuteOptions = {
  sessionId: string
  prompt: string
  cwd: string
  role?: string
  signal?: AbortSignal
  timeoutSignal?: AbortSignal
  maxToolOutputBytes?: number
  bashMaxBufferBytes?: number
  skipPermissionCheck?: boolean
  requestId?: string
  model?: string
  budget?: number
  executionEnvironment?: 'local' | 'docker' | 'remote'
}

export interface NexusRuntime {
  executeStream(options: RuntimeExecuteOptions): AsyncIterable<NexusEvent>
  listTools?(): RuntimeToolAuditEntry[]
}

export type RuntimeToolAuditEntry = {
  name: string
  description: string
  risk: ToolRisk
  allowed: boolean
  inputSchema?: unknown
  source?: {
    type: 'builtin' | 'mcp'
    serverName?: string
    originalName?: string
  }
}
