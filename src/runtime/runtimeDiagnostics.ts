export type RuntimeDiagnosticSeverity = 'info' | 'warning' | 'critical'

export type RuntimeDiagnosticSignal = {
  type: string
  severity: RuntimeDiagnosticSeverity
  message: string
}

export type RuntimeDiagnosticAction = {
  mode: string
  status?: string
  description: string
  requiresUserConfirmation?: boolean
  allowSilentModelSwitch: false
  sideEffects?: {
    willSwitchModel?: boolean
    willSwitchProvider?: boolean
    willMutateConfig?: boolean
    willCallProvider?: boolean
    willCreateSession?: boolean
  }
}

export type RuntimeDiagnosticsEnvelope<TDetails = unknown> = {
  domain: 'context' | 'provider'
  name: string
  status: 'ok' | 'warning' | 'critical' | 'blocked'
  summary: string
  signals: RuntimeDiagnosticSignal[]
  recommendations: string[]
  action?: RuntimeDiagnosticAction
  details: TDetails
}

export function buildRuntimeDiagnostics<TDetails>(options: RuntimeDiagnosticsEnvelope<TDetails>): RuntimeDiagnosticsEnvelope<TDetails> {
  return options
}

export function statusFromSignals(signals: RuntimeDiagnosticSignal[], fallback: RuntimeDiagnosticsEnvelope['status'] = 'ok'): RuntimeDiagnosticsEnvelope['status'] {
  if (signals.some(signal => signal.severity === 'critical')) return 'critical'
  if (signals.some(signal => signal.severity === 'warning')) return 'warning'
  return fallback
}
