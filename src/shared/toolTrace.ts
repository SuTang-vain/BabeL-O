export interface ToolTrace {
  toolUseId: string
  sessionId: string
  name: string
  input: unknown
  output?: unknown
  success?: boolean
  startedAt: string
  completedAt?: string
  durationMs?: number
}
