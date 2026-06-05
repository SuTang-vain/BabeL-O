export interface RemoteToolRunnerDiagnostics {
  runnerId: string
  protocolVersion: string
  durationMs?: number
  roundtripMs?: number
  truncated?: boolean
  originalBytes?: number
  exitCode?: number
  signal?: string
  cancelled?: boolean
  timedOut?: boolean
  errorCode?: string
}

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
  remoteRunner?: RemoteToolRunnerDiagnostics
}
