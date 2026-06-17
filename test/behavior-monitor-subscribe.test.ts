// test/behavior-monitor-subscribe.test.ts
//
// PR-A4 unit tests: BehaviorMonitor.subscribe + pushHint (additive API
// added in behaviorMonitor.ts). No breaking changes to ingest/detectAll.
// Covers:
//   T1: subscribe returns an unsubscribe fn; after unsubscribe, no more
//       hints delivered.
//   T2: pushHint fans out to all subscribers for that sessionId.
//   T3: pushHint does not affect subscribers of a different sessionId.
//   T4: Throwing handler does not affect other handlers.
//   T5: Multiple subscribers per sessionId.
//
// HOME isolation: every test uses BABEL_O_TEST_CONFIG_WRITE_GUARD=1 and
// a per-test mkdtemp HOME so cwd-relative writes never touch the real
// ~/.babel-o (memory: babel-o-test-config-isolation).

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BehaviorMonitor } from '../src/nexus/behaviorMonitor.js'
import type { BehaviorTraceAnomaly } from '../src/runtime/behaviorTrace.js'

const ORIGINAL_ENV: Record<string, string | undefined> = {}

describe('PR-A4 BehaviorMonitor.subscribe + pushHint (additive API)', () => {
  let home: string
  let cwd: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'babel-o-prA4-home-'))
    cwd = mkdtempSync(join(home, 'project-'))
    mkdirSync(join(cwd, '.babel-o'), { recursive: true })
    for (const key of ['HOME', 'BABEL_O_TEST_CONFIG_WRITE_GUARD']) {
      ORIGINAL_ENV[key] = process.env[key]
    }
    process.env.HOME = home
    process.env.BABEL_O_TEST_CONFIG_WRITE_GUARD = '1'
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
    for (const [key, val] of Object.entries(ORIGINAL_ENV)) {
      if (val === undefined) delete process.env[key]
      else process.env[key] = val
    }
  })

  function newMonitor(): BehaviorMonitor {
    return new BehaviorMonitor({ cwd })
  }

  function makeAnomaly(overrides: Partial<BehaviorTraceAnomaly> = {}): BehaviorTraceAnomaly {
    return {
      errorCode: 'HOT_PATH',
      errorMessage: 'hot-path: /x/y (3 sessions, 5 occurrences)',
      ...overrides,
    }
  }

  // T1
  test('subscribe returns an unsubscribe fn; after unsubscribe, no more hints delivered', () => {
    const monitor = newMonitor()
    const received: BehaviorTraceAnomaly[] = []
    const unsub = monitor.subscribe('s1', (hint) => received.push(hint))
    assert.equal(monitor.subscriberCount('s1'), 1)
    monitor.pushHint('s1', makeAnomaly({ errorCode: 'A' }))
    assert.equal(received.length, 1)
    unsub()
    assert.equal(monitor.subscriberCount('s1'), 0)
    monitor.pushHint('s1', makeAnomaly({ errorCode: 'B' }))
    assert.equal(received.length, 1, 'no more hints after unsubscribe')
    // Calling unsub twice is a no-op.
    unsub()
  })

  // T2
  test('pushHint fans out to all subscribers for that sessionId', () => {
    const monitor = newMonitor()
    const a: BehaviorTraceAnomaly[] = []
    const b: BehaviorTraceAnomaly[] = []
    monitor.subscribe('s1', (hint) => a.push(hint))
    monitor.subscribe('s1', (hint) => b.push(hint))
    assert.equal(monitor.subscriberCount('s1'), 2)
    const hint = makeAnomaly()
    monitor.pushHint('s1', hint)
    assert.equal(a.length, 1)
    assert.equal(b.length, 1)
    assert.equal(a[0]!.errorCode, hint.errorCode)
    assert.equal(b[0]!.errorMessage, hint.errorMessage)
  })

  // T3
  test('pushHint does not affect subscribers of a different sessionId', () => {
    const monitor = newMonitor()
    const s1Received: BehaviorTraceAnomaly[] = []
    const s2Received: BehaviorTraceAnomaly[] = []
    monitor.subscribe('s1', (hint) => s1Received.push(hint))
    monitor.subscribe('s2', (hint) => s2Received.push(hint))
    monitor.pushHint('s1', makeAnomaly({ errorCode: 'X' }))
    assert.equal(s1Received.length, 1)
    assert.equal(s2Received.length, 0, 's2 subscriber must not receive a s1 hint')
    monitor.pushHint('s2', makeAnomaly({ errorCode: 'Y' }))
    assert.equal(s1Received.length, 1, 's1 subscriber must not receive a s2 hint')
    assert.equal(s2Received.length, 1)
    assert.equal(s2Received[0]!.errorCode, 'Y')
  })

  // T4
  test('throwing handler does not affect other handlers', () => {
    const monitor = newMonitor()
    const good: BehaviorTraceAnomaly[] = []
    monitor.subscribe('s1', () => {
      throw new Error('boom from handler 1')
    })
    monitor.subscribe('s1', (hint) => good.push(hint))
    // Swallow console.warn from the monitor so the test output stays clean.
    const origWarn = console.warn
    console.warn = () => { /* swallow */ }
    try {
      monitor.pushHint('s1', makeAnomaly({ errorCode: 'Z' }))
    } finally {
      console.warn = origWarn
    }
    assert.equal(good.length, 1, 'second handler must still receive the hint')
    assert.equal(good[0]!.errorCode, 'Z')
  })

  // T5
  test('multiple subscribers per sessionId are tracked independently', () => {
    const monitor = newMonitor()
    const counts = { a: 0, b: 0, c: 0 }
    const unsubA = monitor.subscribe('s1', () => {
      counts.a += 1
    })
    monitor.subscribe('s1', () => {
      counts.b += 1
    })
    monitor.subscribe('s1', () => {
      counts.c += 1
    })
    assert.equal(monitor.subscriberCount('s1'), 3)
    monitor.pushHint('s1', makeAnomaly())
    assert.deepEqual(counts, { a: 1, b: 1, c: 1 })
    unsubA()
    assert.equal(monitor.subscriberCount('s1'), 2)
    monitor.pushHint('s1', makeAnomaly())
    assert.deepEqual(counts, { a: 1, b: 2, c: 2 })
  })
})
