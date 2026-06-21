// test/behavior-monitor.test.ts
//
// PR-5 unit tests: BehaviorMonitor (Nexus-side cross-session)
// Covers 3 detectors, hintDispatcher safety checks, BehaviorMonitor container,
// runBehaviorMonitor, persistence integration, isolation.

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

import {
  BehaviorMonitor,
  detectHotPath,
  detectToolStorm,
  detectScopeDriftWave,
  detectPromptCacheMissWave,
  runBehaviorMonitor,
  shouldDispatchHint,
  type CrossSessionTrigger,
  type HintCandidate,
  type HintDispatchContext,
} from '../src/runtime/behaviorMonitor.js'
import {
  BEHAVIOR_TRACE_RELATIVE_PATH,
  flushBehaviorTraceQueue,
} from '../src/runtime/behaviorTrace.js'
import { NEXUS_EVENT_SCHEMA_VERSION, type NexusEvent } from '../src/shared/events.js'

function mkHome(): string {
  return mkdtempSync(join(tmpdir(), 'babel-o-bm-home-'))
}

function tsAt(baseMs: number, offsetMs: number): string {
  return new Date(baseMs + offsetMs).toISOString()
}

describe('PR-5 hot-path detector', () => {
  test('fires when ≥ 3 sessions each touch the same path', () => {
    const now = Date.now()
    const sessions = ['s1', 's2', 's3', 's4'].map(sid => ({
      sessionId: sid,
      events: [
        {
          type: 'tool_started',
          schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
          sessionId: sid,
          timestamp: tsAt(now, -1000),
          toolUseId: `tu_${sid}`,
          name: 'Read',
          input: { path: '/repo/src/runtime/sessionMemoryLite.ts' },
        },
      ] as NexusEvent[],
    }))
    const found = detectHotPath(sessions, { minSessions: 3, windowMs: 60_000, now })
    assert.equal(found.length, 1)
    assert.equal(found[0]!.trigger, 'hot-path')
    assert.equal(found[0]!.pattern, '/repo/src/runtime/sessionMemoryLite.ts')
    assert.equal(found[0]!.sessionIds.length, 4)
  })

  test('does not fire with only 2 sessions (below threshold)', () => {
    const now = Date.now()
    const sessions = ['s1', 's2'].map(sid => ({
      sessionId: sid,
      events: [{
        type: 'tool_started', schemaVersion: NEXUS_EVENT_SCHEMA_VERSION, sessionId: sid,
        timestamp: tsAt(now, -1000), toolUseId: 'tu', name: 'Read', input: { path: '/x' },
      }] as NexusEvent[],
    }))
    const found = detectHotPath(sessions, { minSessions: 3, windowMs: 60_000, now })
    assert.equal(found.length, 0)
  })

  test('respects windowMs — events outside window excluded', () => {
    const now = Date.now()
    const sessions = ['s1', 's2', 's3'].map(sid => ({
      sessionId: sid,
      events: [{
        type: 'tool_started', schemaVersion: NEXUS_EVENT_SCHEMA_VERSION, sessionId: sid,
        timestamp: tsAt(now, -120_000), // 2 min ago
        toolUseId: 'tu', name: 'Read', input: { path: '/x' },
      }] as NexusEvent[],
    }))
    const found = detectHotPath(sessions, { minSessions: 3, windowMs: 60_000, now })
    assert.equal(found.length, 0, 'events outside window excluded')
  })
})

describe('PR-5 tool-storm detector', () => {
  test('fires when same tool called > threshold in 1min in one session', () => {
    const now = Date.now()
    const events: NexusEvent[] = []
    for (let i = 0; i < 25; i += 1) {
      events.push({
        type: 'tool_started', schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
        sessionId: 's1', timestamp: tsAt(now, -i * 1000),
        toolUseId: `tu_${i}`, name: 'Read', input: { path: '/x' },
      })
    }
    const found = detectToolStorm(events, { callsPerMinuteThreshold: 20, windowMs: 60_000, now })
    assert.equal(found.length, 1)
    assert.equal(found[0]!.trigger, 'tool-storm')
    assert.equal(found[0]!.toolName, 'Read')
    assert.equal(found[0]!.sessionId, 's1')
    assert.ok(found[0]!.callsPerMinute > 20)
  })

  test('does not fire when calls are spread across 2 sessions', () => {
    const now = Date.now()
    const events: NexusEvent[] = []
    for (let i = 0; i < 25; i += 1) {
      events.push({
        type: 'tool_started', schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
        sessionId: i % 2 === 0 ? 's1' : 's2',
        timestamp: tsAt(now, -i * 1000),
        toolUseId: `tu_${i}`, name: 'Read', input: { path: '/x' },
      })
    }
    const found = detectToolStorm(events, { callsPerMinuteThreshold: 20, windowMs: 60_000, now })
    // s1 has ~13 calls, s2 has ~12, both < 20
    assert.equal(found.length, 0)
  })

  test('different tools in same session do not combine', () => {
    const now = Date.now()
    const events: NexusEvent[] = []
    for (let i = 0; i < 25; i += 1) {
      events.push({
        type: 'tool_started', schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
        sessionId: 's1', timestamp: tsAt(now, -i * 1000),
        toolUseId: `tu_${i}`, name: i % 2 === 0 ? 'Read' : 'Glob', input: { path: '/x' },
      })
    }
    const found = detectToolStorm(events, { callsPerMinuteThreshold: 20, windowMs: 60_000, now })
    // 12-13 of each, below threshold
    assert.equal(found.length, 0)
  })
})

describe('PR-5 scope-drift-wave detector', () => {
  test('fires when ≥ 3 sessions drift to same target', () => {
    const now = Date.now()
    const sessions = ['s1', 's2', 's3'].map(sid => ({
      sessionId: sid,
      events: [{
        type: 'tool_started', schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
        sessionId: sid, timestamp: tsAt(now, -1000),
        toolUseId: 'tu', name: 'Read', input: { path: `/external/proj/some/file-${sid}.ts` },
      }] as NexusEvent[],
    }))
    const found = detectScopeDriftWave(sessions, { minSessions: 3, windowMs: 60_000, now })
    assert.equal(found.length, 1)
    assert.equal(found[0]!.trigger, 'scope-drift-wave')
    // All three share the same /external/proj/* prefix
    assert.equal(found[0]!.sessionIds.length, 3)
  })

  test('does not fire with only 2 sessions', () => {
    const now = Date.now()
    const sessions = ['s1', 's2'].map(sid => ({
      sessionId: sid,
      events: [{
        type: 'tool_started', schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
        sessionId: sid, timestamp: tsAt(now, -1000),
        toolUseId: 'tu', name: 'Read', input: { path: `/external/${sid}/f.ts` },
      }] as NexusEvent[],
    }))
    const found = detectScopeDriftWave(sessions, { minSessions: 3, windowMs: 60_000, now })
    assert.equal(found.length, 0)
  })
})

describe('PR-5 shouldDispatchHint (4 safety checks)', () => {
  function mkCandidate(sessionId = 's1'): HintCandidate {
    return { trigger: 'hot-path', sessionId, pattern: '/x', detectedAt: Date.now() }
  }
  function mkCtx(overrides: Partial<HintDispatchContext> = {}): HintDispatchContext {
    return {
      sessionId: 's1',
      inToolExecution: false,
      waitingForUser: false,
      quietMode: false,
      lastHintAtBySession: new Map(),
      ...overrides,
    }
  }

  test('passes when all 4 checks pass', () => {
    assert.equal(shouldDispatchHint(mkCandidate(), mkCtx()), true)
  })

  test('blocks when in tool execution', () => {
    assert.equal(shouldDispatchHint(mkCandidate(), mkCtx({ inToolExecution: true })), false)
  })

  test('blocks when waiting for user', () => {
    assert.equal(shouldDispatchHint(mkCandidate(), mkCtx({ waitingForUser: true })), false)
  })

  test('blocks when in quiet mode', () => {
    assert.equal(shouldDispatchHint(mkCandidate(), mkCtx({ quietMode: true })), false)
  })

  test('blocks when session mismatch', () => {
    assert.equal(shouldDispatchHint(mkCandidate('s2'), mkCtx()), false)
  })

  test('blocks when last hint < 5min ago', () => {
    const lastHintAtBySession = new Map<string, number>()
    lastHintAtBySession.set('s1', Date.now() - 60_000) // 1 min ago
    assert.equal(shouldDispatchHint(mkCandidate(), mkCtx({ lastHintAtBySession })), false)
  })

  test('passes when last hint ≥ 5min ago', () => {
    const lastHintAtBySession = new Map<string, number>()
    lastHintAtBySession.set('s1', Date.now() - 6 * 60_000) // 6 min ago
    assert.equal(shouldDispatchHint(mkCandidate(), mkCtx({ lastHintAtBySession })), true)
  })
})

describe('PR-5 BehaviorMonitor container', () => {
  let home: string
  let cwd: string
  const ORIGINAL_ENV: Record<string, string | undefined> = {}

  beforeEach(async () => {
    home = mkHome()
    cwd = mkdtempSync(join(home, 'project-'))
    for (const key of ['BABEL_O_BEHAVIOR_TRACE_ENABLED', 'HOME', 'BABEL_O_TEST_CONFIG_WRITE_GUARD']) {
      ORIGINAL_ENV[key] = process.env[key]
    }
    process.env.HOME = home
    process.env.BABEL_O_TEST_CONFIG_WRITE_GUARD = '1'
    delete process.env.BABEL_O_BEHAVIOR_TRACE_ENABLED
    await flushBehaviorTraceQueue()
  })

  afterEach(async () => {
    await flushBehaviorTraceQueue()
    rmSync(home, { recursive: true, force: true })
    for (const [key, val] of Object.entries(ORIGINAL_ENV)) {
      if (val === undefined) delete process.env[key]
      else process.env[key] = val
    }
  })

  test('constructor requires cwd', () => {
    assert.throws(() => new BehaviorMonitor({ cwd: '' }), /non-empty cwd/)
  })

  test('ingest + detectAll produces cross-session triggers', () => {
    // Tight 60s window so 25 events at 1s spacing = 25/min > 20 threshold
    const monitor = new BehaviorMonitor({ cwd, rollingWindowMs: 60_000, toolStormCallsPerMinute: 20 })
    const now = Date.now()
    for (const sid of ['s1', 's2', 's3', 's4']) {
      for (let i = 0; i < 25; i += 1) {
        monitor.ingest({
          type: 'tool_started', schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
          sessionId: sid, timestamp: tsAt(now, -i * 1000),
          toolUseId: `tu_${sid}_${i}`, name: 'Read', input: { path: '/repo/src/runtime/sessionMemoryLite.ts' },
        })
      }
    }
    const triggers = monitor.detectAll()
    const types = new Set(triggers.map(t => t.trigger))
    assert.ok(types.has('hot-path'), 'hot-path detected')
    assert.ok(types.has('tool-storm'), 'tool-storm detected')
  })

  test('queueTrace writes JSONL entry with source=nexus', async () => {
    const monitor = new BehaviorMonitor({ cwd })
    const now = Date.now()
    for (const sid of ['s1', 's2', 's3']) {
      monitor.ingest({
        type: 'tool_started', schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
        sessionId: sid, timestamp: tsAt(now, -1000),
        toolUseId: 'tu', name: 'Read', input: { path: '/shared/file.ts' },
      })
    }
    const triggers = monitor.detectAll()
    for (const t of triggers) {
      monitor.queueTrace(t, 's1')
    }
    await flushBehaviorTraceQueue()

    const path = join(cwd, BEHAVIOR_TRACE_RELATIVE_PATH)
    assert.equal(existsSync(path), true)
    const lines = readFileSync(path, 'utf8').split('\n').filter(l => l.trim().length > 0)
    assert.ok(lines.length >= 1, 'at least one trace line written')
    for (const line of lines) {
      const entry = JSON.parse(line)
      assert.equal(entry.anomaly.source, 'nexus', 'source=nexus for cross-session traces')
    }
  })

  test('tryDispatch returns true first time, false on cooldown', () => {
    const monitor = new BehaviorMonitor({ cwd })
    const candidate: HintCandidate = {
      trigger: 'hot-path', sessionId: 's1', pattern: '/x', detectedAt: Date.now(),
    }
    const ctx = { inToolExecution: false, waitingForUser: false, quietMode: false }
    assert.equal(monitor.tryDispatch(candidate, ctx), true)
    assert.equal(monitor.tryDispatch(candidate, ctx), false, 'cooldown blocks second dispatch')
  })

  test('isolation: trace file is written to cwd, never HOME', async () => {
    const monitor = new BehaviorMonitor({ cwd })
    const now = Date.now()
    for (const sid of ['s1', 's2', 's3']) {
      monitor.ingest({
        type: 'tool_started', schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
        sessionId: sid, timestamp: tsAt(now, -1000),
        toolUseId: 'tu', name: 'Read', input: { path: '/shared/file.ts' },
      })
    }
    const triggers = monitor.detectAll()
    for (const t of triggers) {
      monitor.queueTrace(t, 's1')
    }
    await flushBehaviorTraceQueue()

    const homePath = join(home, BEHAVIOR_TRACE_RELATIVE_PATH)
    const cwdPath = join(cwd, BEHAVIOR_TRACE_RELATIVE_PATH)
    assert.equal(existsSync(homePath), false)
    assert.equal(existsSync(cwdPath), true)
  })
})

describe('PR-5 runBehaviorMonitor end-to-end', () => {
  let cwd: string

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'babel-o-bmrun-'))
    delete process.env.BABEL_O_BEHAVIOR_TRACE_ENABLED
  })

  afterEach(async () => {
    await flushBehaviorTraceQueue()
    rmSync(cwd, { recursive: true, force: true })
  })

  test('runs detectors + dispatches hints + queues traces', async () => {
    const monitor = new BehaviorMonitor({ cwd })
    const now = Date.now()
    for (const sid of ['s1', 's2', 's3']) {
      monitor.ingest({
        type: 'tool_started', schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
        sessionId: sid, timestamp: tsAt(now, -1000),
        toolUseId: 'tu', name: 'Read', input: { path: '/shared/x.ts' },
      })
    }
    const result = await runBehaviorMonitor(monitor, 's1', {
      inToolExecution: false, waitingForUser: false, quietMode: false,
    })
    assert.ok(result.triggers.length >= 1)
    assert.equal(result.traceEntriesQueued, result.triggers.length)
    // First call: hint dispatched (no prior cooldown)
    // Second call (same trigger session) would be blocked — but each trigger
    // here is a different pattern, so 1 dispatch expected
    assert.ok(result.hintsDispatched >= 1)
  })
})

describe('Phase D prompt-cache-miss-wave detector (plan §5.4)', () => {
  const NOW = Date.now()
  const RATIO_BELOW = 0.4   // < 0.85 target → below
  const RATIO_OK    = 0.9   // > 0.85 → ok

  function execMetrics(sid: string, ratio: number, tsOffset = -1000) {
    return {
      type: 'execution_metrics' as const,
      schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
      sessionId: sid,
      cwd: '/tmp',
      timestamp: tsAt(NOW, tsOffset),
      requestId: `r-${sid}`,
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationInputTokens: ratio > 0.85 ? 10 : 0,
      cacheReadInputTokens: ratio > 0.85 ? 900 : 40,
      cacheReadRatio: ratio,
    } as unknown as NexusEvent
  }

  function sessionSlice(sid: string, ratio: number, tsOffset?: number) {
    return { sessionId: sid, events: [execMetrics(sid, ratio, tsOffset ?? -1000)] }
  }

  test('fires when ≥ 3 sessions below target in window', () => {
    const sessions = ['s1', 's2', 's3'].map(sid => sessionSlice(sid, RATIO_BELOW))
    const found = detectPromptCacheMissWave(sessions, {
      minSessions: 3, windowMs: 60_000, targetRatio: 0.85, now: NOW,
    })
    assert.equal(found.length, 1)
    assert.equal(found[0]!.trigger, 'prompt-cache-miss-wave')
    assert.equal(found[0]!.sessionIds.length, 3)
    assert.equal(found[0]!.occurrenceCount, 3)
    for (const sid of ['s1', 's2', 's3']) {
      assert.ok(found[0]!.observedRatios[sid] !== undefined)
    }
  })

  test('does not fire with only 2 sessions below target', () => {
    const sessions = ['s1', 's2'].map(sid => sessionSlice(sid, RATIO_BELOW))
    const found = detectPromptCacheMissWave(sessions, {
      minSessions: 3, windowMs: 60_000, targetRatio: 0.85, now: NOW,
    })
    assert.equal(found.length, 0)
  })

  test('ignores sessions with ratio >= target', () => {
    const sessions = [
      sessionSlice('s-ok', RATIO_OK),
      sessionSlice('s-low', RATIO_BELOW),
      sessionSlice('s-low2', RATIO_BELOW),
    ]
    const found = detectPromptCacheMissWave(sessions, {
      minSessions: 2, windowMs: 60_000, targetRatio: 0.85, now: NOW,
    })
    assert.equal(found.length, 1)
    assert.equal(found[0]!.sessionIds.length, 2)
    // s-ok should NOT be in the result
    assert.ok(!found[0]!.sessionIds.includes('s-ok'))
  })

  test('fires via BehaviorMonitor.detectAll() when events have low ratios', () => {
    const monitor = new BehaviorMonitor({
      cwd: '/tmp',
      rollingWindowMs: 60_000,
      promptCacheMissWaveMinSessions: 2,
      promptCacheMissWaveTargetRatio: 0.85,
      now: () => NOW,
    })
    for (const sid of ['s1', 's2', 's3']) {
      monitor.ingest(execMetrics(sid, RATIO_BELOW))
    }
    const triggers = monitor.detectAll()
    // One of the triggers should be prompt-cache-miss-wave
    const hit = triggers.filter(t => t.trigger === 'prompt-cache-miss-wave')
    assert.equal(hit.length, 1)
    assert.equal((hit[0] as any).sessionIds.length, 3)
  })

  test('detectAll() does not fire when ratios are ok', () => {
    const monitor = new BehaviorMonitor({
      cwd: '/tmp',
      rollingWindowMs: 60_000,
      promptCacheMissWaveMinSessions: 2,
      promptCacheMissWaveTargetRatio: 0.85,
      now: () => NOW,
    })
    for (const sid of ['s1', 's2', 's3']) {
      monitor.ingest(execMetrics(sid, RATIO_OK))
    }
    const triggers = monitor.detectAll()
    const hit = triggers.filter(t => t.trigger === 'prompt-cache-miss-wave')
    assert.equal(hit.length, 0)
  })

  test('custom target ratio via options', () => {
    const sessions = ['s1', 's2', 's3'].map(sid =>
      sessionSlice(sid, 0.7), // 0.7 < 0.75 custom target
    )
    const found = detectPromptCacheMissWave(sessions, {
      minSessions: 3, windowMs: 60_000, targetRatio: 0.75, now: NOW,
    })
    assert.equal(found.length, 1)
    assert.equal(found[0]!.targetRatio, 0.75)
  })

  test('ignores sessions without execution_metrics', () => {
    const sessions = ['s1', 's2', 's3'].map(sid => ({
      sessionId: sid,
      events: [{
        type: 'user_message', schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
        sessionId: sid, cwd: '/tmp', timestamp: tsAt(NOW, -1000), text: 'hi',
      }] as unknown as NexusEvent[],
    }))
    const found = detectPromptCacheMissWave(sessions, {
      minSessions: 3, windowMs: 60_000, targetRatio: 0.85, now: NOW,
    })
    assert.equal(found.length, 0)
  })

  test('prefers latest execution_metrics per session', () => {
    const s = { sessionId: 's1', events: [
      execMetrics('s1', 0.9, -2000),   // ok, old
      execMetrics('s1', 0.3, -1000),   // low, recent → wins
    ]}
    const found = detectPromptCacheMissWave([s], {
      minSessions: 1, windowMs: 60_000, targetRatio: 0.85, now: NOW,
    })
    assert.equal(found.length, 1)
    assert.equal(found[0]!.observedRatios['s1'], 0.3)
  })
})
