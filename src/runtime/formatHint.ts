// src/runtime/formatHint.ts
//
// PR-A4: Format a BehaviorTraceAnomaly as a single human-readable line
// for downstream hint delivery (see long-running-context-assembly.md
// §6.2 step 3). Conservative by design — a one-liner is enough for the
// Nexus-side observability surface; richer formatting is a future
// concern.
//
// Field choices (per BehaviorTraceAnomaly in behaviorTrace.ts):
//   - "kind"  → anomaly.errorCode (e.g. "HOT_PATH", "TOOL_STORM",
//     "SCOPE_DRIFT_WAVE"; session-internal triggers use the same
//     shared shape).
//   - "message" → anomaly.errorMessage (the canonical human-readable
//     description written by the rule-based detectors).

import type { BehaviorTraceAnomaly } from '../runtime/behaviorTrace.js'

export function formatHint(anomaly: BehaviorTraceAnomaly): string {
  const kind = anomaly.errorCode ?? '(no code)'
  const message = anomaly.errorMessage ?? '(no message)'
  return `[hint: ${kind}] ${message}`
}
