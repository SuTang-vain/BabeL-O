import { writeSync } from 'node:fs'
import { performance } from 'node:perf_hooks'

const startedAt = performance.now()
const enabled = process.env.BABEL_O_STARTUP_TRACE === '1'
const marks: Array<{ name: string; ms: number }> = []
let flushed = false

if (enabled) {
  process.once('beforeExit', () => flushStartupTrace())
  process.once('exit', () => flushStartupTrace())
}

export function markStartup(name: string): void {
  if (!enabled) return
  marks.push({ name, ms: round(performance.now() - startedAt) })
}

export function flushStartupTrace(): void {
  if (!enabled) return
  if (flushed) return
  flushed = true
  const totalMs = round(performance.now() - startedAt)
  const payload = {
    type: 'startup_trace',
    totalMs,
    marks,
  }
  writeSync(2, `${JSON.stringify(payload)}\n`)
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}
