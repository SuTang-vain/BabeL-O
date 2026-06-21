import assert from 'node:assert/strict'
import { test } from 'node:test'
import { NexusMetrics } from '../src/nexus/metrics.js'

// Bug fix 2026-06-21 (watchdog observability): when the provider
// stream goes silent, no `recordStreamEvent` fires, so
// `stream.activeAgeMs` was never updated and operators couldn't
// see "is a stream hung right now" via /v1/runtime/status. The fix
// is two parts:
//   1. `snapshot()` now calls `recordStreamActiveAge(now)` just
//      before returning, so each /v1/runtime/status poll drives
//      the timer forward.
//   2. `recordStreamActiveAge` accumulates the delta-since-last-
//      sample when activeCount > 0, and resets to 0 when
//      activeCount drops to 0.
//
// Implementation note: the FIRST sample after a stream starts
// (when lastStreamActiveSampleMs is still 0) does not add any
// delta — it just seeds the timer. This is the "first call seeds
// the clock" pattern. Subsequent samples add delta-since-last.

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

test('stream.activeAgeMs is zero when no stream is active', () => {
  const metrics = new NexusMetrics()
  assert.equal(metrics.snapshot().stream.activeAgeMs, 0)
})

test('stream.activeAgeMs grows as snapshots are taken while a stream is active', async () => {
  // The core fix contract: even if the provider stream emits
  // ZERO events, taking snapshots must surface a growing
  // activeAgeMs. Before the fix, activeAgeMs was stuck at 0.
  const metrics = new NexusMetrics()
  metrics.recordStreamStart()
  await wait(20)
  // First snapshot: seeds the timer (activeAgeMs = 0).
  const first = metrics.snapshot().stream.activeAgeMs
  assert.equal(first, 0, 'first snapshot should seed the timer at 0')
  await wait(20)
  const second = metrics.snapshot().stream.activeAgeMs
  assert.ok(second >= 15, `second snapshot should be >= 15ms (real elapsed), got ${second}`)
  await wait(30)
  const third = metrics.snapshot().stream.activeAgeMs
  assert.ok(third >= second, `third snapshot should be >= second (${second}), got ${third}`)
  assert.ok(third >= 40, `third snapshot should be >= 40ms (cumulative elapsed), got ${third}`)
})

test('stream.activeAgeMs resets to 0 once stream finishes, surfaced by next snapshot', async () => {
  const metrics = new NexusMetrics()
  metrics.recordStreamStart()
  await wait(20)
  // Hang: emit no events. Snapshots show growing activeAgeMs.
  const hang = metrics.snapshot().stream.activeAgeMs
  await wait(20)
  assert.ok(metrics.snapshot().stream.activeAgeMs > hang, 'hung stream should show growing activeAgeMs')
  // Hard watchdog (or other timeout) fires; stream finishes.
  metrics.recordStreamFinish({ success: false, timedOut: true, clientClosed: false, durationMs: 50 })
  // Next snapshot: activeCount=0 → recordStreamActiveAge resets
  // activeAgeMs to 0. Operators rely on this to know the hang
  // is cleared.
  assert.equal(metrics.snapshot().stream.activeAgeMs, 0)
})

test('recordStreamActiveAge explicit samples advance the timer without snapshot', async () => {
  // Operators or callers can also drive the timer via explicit
  // recordStreamActiveAge calls (e.g. from a heartbeat). The
  // resulting activeAgeMs should accumulate real elapsed time
  // between samples, and the next snapshot should not re-seed.
  const metrics = new NexusMetrics()
  metrics.recordStreamStart()
  // Seed: activeCount>0, lastSampleMs=0, so first explicit
  // recordStreamActiveAge(0) does NOT add delta.
  metrics.recordStreamActiveAge(0)
  assert.equal(metrics.snapshot().stream.activeAgeMs, 0)
  await wait(20)
  // Second explicit sample at "real" time t: delta = t - 0 = t,
  // but lastSampleMs=0 so the guard `lastSampleMs > 0` still
  // skips the add. This is by design — the first call always
  // seeds.
  metrics.recordStreamActiveAge(metrics.now())
  // The next snapshot uses performance.now() (real time) which
  // is > the explicit sample, so the snapshot advances further.
  await wait(20)
  assert.ok(metrics.snapshot().stream.activeAgeMs >= 15, 'snapshot after explicit samples should reflect real elapsed time')
})

test('snapshot returns 0 activeAgeMs once stream finishes, even with no prior snapshot', () => {
  // Stream finishes before any sample is taken. Next snapshot
  // must still report 0 (the activeCount=0 early-return path).
  const metrics = new NexusMetrics()
  metrics.recordStreamStart()
  metrics.recordStreamFinish({ success: true, timedOut: false, clientClosed: false, durationMs: 0 })
  assert.equal(metrics.snapshot().stream.activeAgeMs, 0)
})
