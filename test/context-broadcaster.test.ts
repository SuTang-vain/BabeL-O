// test/context-broadcaster.test.ts
//
// PR-A2 unit tests for the ContextBroadcaster module. No Nexus app,
// no Fastify, no WebSocket. Just the pub/sub + cache behavior.

import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { ContextBroadcaster, defaultContextBroadcaster } from '../src/nexus/contextBroadcaster.js'
import type { AssembledContext } from '../src/runtime/contextAssembler.js'

function makeContext(sessionId: string, cwd: string): AssembledContext {
  // Only the fields the broadcaster/observer actually touch need to be
  // populated. Everything else stays at its zero value.
  return {
    systemPrompt: `sys:${sessionId}`,
    messages: [],
    budget: {
      maxTokens: 1000,
      maxChars: 4000,
      layerBudgets: { system: 100, memory: 100, summary: 100, recent: 100 },
      snipToolOutputChars: 100,
      snipPriorTurnToolOutputChars: 100,
      microcompactToolOutputChars: 100,
      microcompactInternalTextChars: 100,
      recentEventLimit: 10,
      recentTurnLimit: 5,
    },
    selectedEventCount: 0,
    omittedEventCount: 0,
    snippedEventCount: 0,
    sessionSummary: '',
    projectMemory: '',
    activeSkills: '',
    gitStatus: '',
    compactRetainedEventCount: 0,
    compactRetainedSegmentValid: true,
    compactRetainedSegmentWarning: '',
    postCompactState: { kind: 'none' },
    userIntentGuidance: {
      pendingQuestions: [],
      declaredTaskScope: undefined,
      tone: 'neutral',
    },
    memoryTruncated: false,
    microcompactedEventCount: 0,
    microcompactMetrics: {
      toolOutputCharsTrimmed: 0,
      internalTextCharsTrimmed: 0,
      eventsAffected: 0,
    },
    selectionDiagnostics: {
      budgetMaxTokens: 1000,
      selectedEventCount: 0,
      omittedEventCount: 0,
      snippedEventCount: 0,
      byReason: { summary: 0, microcompact: 0, recent: 0, snip: 0 },
    },
    memoryCapabilityAvailable: false,
    scopedMemoryDiagnostics: [],
  } as unknown as AssembledContext
}

describe('PR-A2 ContextBroadcaster (unit)', () => {
  let broadcaster: ContextBroadcaster
  const cwd = '/tmp/cb-test'
  const cwd2 = '/tmp/cb-test-2'

  beforeEach(() => {
    broadcaster = new ContextBroadcaster()
  })

  // T1: publish to cwd with no subscribers → no throw
  test('T1: publish to cwd with no subscribers is a no-op', () => {
    assert.doesNotThrow(() => {
      broadcaster.publish(cwd, {
        type: 'assembled',
        sessionId: 's1',
        context: makeContext('s1', cwd),
        timestamp: new Date().toISOString(),
      })
    })
    // Cached for snapshot-on-connect, but no subscribers allocated.
    assert.equal(broadcaster.size(), 1)
    assert.equal(broadcaster.subscriberCount(cwd), 0)
  })

  // T2: subscribe returns unsubscribe; after unsubscribe, no more events
  test('T2: subscribe returns an unsubscribe fn', () => {
    const events: unknown[] = []
    const unsub = broadcaster.subscribe(cwd, (e) => { events.push(e) })
    assert.equal(broadcaster.subscriberCount(cwd), 1)
    broadcaster.publish(cwd, {
      type: 'assembled',
      sessionId: 's1',
      context: makeContext('s1', cwd),
      timestamp: 't1',
    })
    assert.equal(events.length, 1)
    unsub()
    assert.equal(broadcaster.subscriberCount(cwd), 0)
    broadcaster.publish(cwd, {
      type: 'assembled',
      sessionId: 's1',
      context: makeContext('s1', cwd),
      timestamp: 't2',
    })
    assert.equal(events.length, 1, 'no event after unsubscribe')
  })

  // T3: multi-subscriber fan-out
  test('T3: multi-subscriber fan-out', () => {
    const a: unknown[] = []
    const b: unknown[] = []
    broadcaster.subscribe(cwd, (e) => { a.push(e) })
    broadcaster.subscribe(cwd, (e) => { b.push(e) })
    broadcaster.publish(cwd, {
      type: 'assembled',
      sessionId: 's1',
      context: makeContext('s1', cwd),
      timestamp: 't1',
    })
    assert.equal(a.length, 1)
    assert.equal(b.length, 1)
  })

  // T4: getLast returns most recent AssembledContext per sessionId
  test('T4: getLast returns the most recent context per sessionId', () => {
    // Subscribe first so the cwd entry is allocated; publish() only
    // updates the last-by-session cache when an entry exists (by
    // design — no allocation when there is no observer).
    broadcaster.subscribe(cwd, () => {})
    const c1 = makeContext('s1', cwd)
    const c2_2 = { ...c1, systemPrompt: 'updated' } as AssembledContext
    const s2Context = makeContext('s2', cwd)
    broadcaster.publish(cwd, { type: 'assembled', sessionId: 's1', context: c1, timestamp: 't1' })
    broadcaster.publish(cwd, { type: 'assembled', sessionId: 's2', context: s2Context, timestamp: 't1' })
    assert.equal(broadcaster.getLast(cwd, 's1'), c1)
    broadcaster.publish(cwd, { type: 'assembled', sessionId: 's1', context: c2_2, timestamp: 't2' })
    assert.equal(broadcaster.getLast(cwd, 's1'), c2_2, 'most recent wins')
    assert.equal(broadcaster.getLast(cwd, 's2'), s2Context)
    assert.equal(broadcaster.getLast(cwd, 's_missing'), undefined)
  })

  // T5: clear empties entries
  test('T5: clear empties all entries', () => {
    broadcaster.subscribe(cwd, () => {})
    broadcaster.publish(cwd, { type: 'assembled', sessionId: 's1', context: makeContext('s1', cwd), timestamp: 't' })
    assert.equal(broadcaster.size(), 1)
    broadcaster.clear()
    assert.equal(broadcaster.size(), 0)
    assert.equal(broadcaster.getLast(cwd, 's1'), undefined)
  })

  // T6: throwing subscriber does not affect other subscribers
  test('T6: throwing subscriber does not affect other subscribers', () => {
    const good: unknown[] = []
    broadcaster.subscribe(cwd, () => { throw new Error('boom') })
    broadcaster.subscribe(cwd, (e) => { good.push(e) })
    // Swallow console.warn noise from the broadcaster's safety net.
    const origWarn = console.warn
    console.warn = () => {}
    try {
      broadcaster.publish(cwd, {
        type: 'assembled',
        sessionId: 's1',
        context: makeContext('s1', cwd),
        timestamp: 't',
      })
    } finally {
      console.warn = origWarn
    }
    assert.equal(good.length, 1, 'good subscriber still received event')
  })

  // T7: subscribeSession filters by sessionId
  test('T7: subscribeSession filters events by sessionId', () => {
    const events: unknown[] = []
    broadcaster.subscribeSession(cwd, 's_target', (e) => { events.push(e) })
    broadcaster.publish(cwd, { type: 'assembled', sessionId: 's_other', context: makeContext('s_other', cwd), timestamp: 't' })
    broadcaster.publish(cwd, { type: 'assembled', sessionId: 's_target', context: makeContext('s_target', cwd), timestamp: 't' })
    assert.equal(events.length, 1)
    assert.equal((events[0] as { sessionId: string }).sessionId, 's_target')
  })

  // T8: per-cwd isolation
  test('T8: subscribers for cwd do not see events for cwd2', () => {
    const events: unknown[] = []
    broadcaster.subscribe(cwd, (e) => { events.push(e) })
    broadcaster.publish(cwd2, {
      type: 'assembled',
      sessionId: 's1',
      context: makeContext('s1', cwd2),
      timestamp: 't',
    })
    assert.equal(events.length, 0)
  })

  // T9: defaultContextBroadcaster is a real instance
  test('T9: defaultContextBroadcaster is a ContextBroadcaster instance', () => {
    assert.ok(defaultContextBroadcaster instanceof ContextBroadcaster)
    // publishing to the singleton should not throw
    assert.doesNotThrow(() => {
      defaultContextBroadcaster.publish('/tmp/singleton-test', {
        type: 'assembled',
        sessionId: 's1',
        context: makeContext('s1', '/tmp/singleton-test'),
        timestamp: 't',
      })
    })
  })
})
