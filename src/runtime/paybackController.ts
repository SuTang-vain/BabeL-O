/**
 * Online realized-payback feedback.
 *
 * A compaction's predicted payback is only a forecast. After the following
 * calls we can compare the realized prompt reduction with the prediction. If
 * the realized/predicted ratio is poor, raise the admission threshold for that
 * session instead of repeating the same mistake.
 */
type PaybackStats = {
  samples: number
  predicted: number
  realized: number
}

const sessions = new Map<string, PaybackStats>()

export function recordPayback(sessionId: string, predicted: number, realized: number): void {
  const stats = sessions.get(sessionId) ?? { samples: 0, predicted: 0, realized: 0 }
  if (Number.isFinite(predicted) && predicted > 0 && Number.isFinite(realized)) {
    stats.samples += 1
    stats.predicted += predicted
    stats.realized += Math.max(0, realized)
  }
  sessions.set(sessionId, stats)
}

export function getPaybackMultiplier(sessionId: string): number {
  const stats = sessions.get(sessionId)
  if (!stats || stats.samples < 2 || stats.predicted <= 0) return 1
  const ratio = stats.realized / stats.predicted
  if (ratio < 0.5) return 1.5
  if (ratio < 0.8) return 1.25
  return 1
}

export function resetPaybackController(sessionId?: string): void {
  if (sessionId === undefined) sessions.clear()
  else sessions.delete(sessionId)
}
