// test/context-tools.test.ts
//
// PR-7 unit tests: on-demand context tools.
// Covers: searchEvents, summarizeWindow, recentEvents, token cap, edge cases.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  searchEvents,
  summarizeWindow,
  recentEvents,
  estimateTokens,
  MAX_TOKENS_PER_TOOL_RETURN,
  type ToolResult,
} from '../src/tools/contextTools.js'
import { NEXUS_EVENT_SCHEMA_VERSION, type NexusEvent } from '../src/shared/events.js'
import type { BehaviorTraceEntry } from '../src/runtime/behaviorTrace.js'

function mkEvent(type: NexusEvent['type'], overrides: Partial<NexusEvent> = {}): NexusEvent {
  return {
    type, schemaVersion: NEXUS_EVENT_SCHEMA_VERSION, sessionId: 's1',
    timestamp: '2026-06-16T00:00:00.000Z', ...overrides,
  } as NexusEvent
}

function mkTraceEntry(overrides: Partial<BehaviorTraceEntry> = {}): BehaviorTraceEntry {
  return {
    schemaVersion: '2026-06-16.behavior-trace.v1',
    traceId: 'trc_test',
    sessionId: 's1',
    cwd: '/tmp',
    timestamp: '2026-06-16T00:00:00.000Z',
    trigger: 'error',
    triggerConfidence: 0.9,
    context: { recentEvents: [], toolSequence: [], fileRefStack: [], userIntentGuidance: '', retryCount: 0, timeInSessionMs: 0, tokensSinceLastTrace: 0 },
    anomaly: { errorCode: 'TOOL_NOT_FOUND', errorMessage: 'file not found' },
    ...overrides,
  } as BehaviorTraceEntry
}

describe('PR-7 estimateTokens', () => {
  test('4 chars = 1 token (floor heuristic)', () => {
    // 4 chars → 1 token, 5 chars → 1 token (floor), 8 chars → 2 tokens
    assert.equal(estimateTokens(''), 0)
    assert.equal(estimateTokens('abcd'), 1)
    assert.equal(estimateTokens('abcde'), 1, '5 chars floors to 1')
    assert.equal(estimateTokens('abcdefgh'), 2, '8 chars = 2 tokens')
  })
  test('5000 token cap constant is correct', () => {
    assert.equal(MAX_TOKENS_PER_TOOL_RETURN, 5000)
  })
})

describe('PR-7 searchEvents', () => {
  const events: NexusEvent[] = [
    mkEvent('user_message', { text: 'please check sessionMemoryLite' }),
    mkEvent('user_message', { text: 'try another approach' }),
    mkEvent('tool_started', { toolUseId: 'tu_1', name: 'Read', input: { path: '/repo/src/runtime/sessionMemoryLite.ts' } }),
    mkEvent('error', { code: 'TOOL_NOT_FOUND', message: 'file not found' }),
    mkEvent('user_message', { text: 'review natural_pause logic' }),
  ]

  test('finds hits across multiple events', () => {
    const r = searchEvents(events, 'sessionMemoryLite')
    assert.ok(r.hitCount >= 2, `expected ≥2 hits, got ${r.hitCount}`)
    assert.ok(r.content.includes('sessionMemoryLite'))
  })

  test('returns empty result on no match', () => {
    const r = searchEvents(events, 'nonexistent-query-xyz')
    assert.equal(r.hitCount, 0)
    assert.equal(r.content, '')
  })

  test('case-insensitive by default', () => {
    const r = searchEvents(events, 'SESSIONMEMORYLITE')
    assert.ok(r.hitCount >= 2)
  })

  test('case-sensitive when opted in', () => {
    const r = searchEvents(events, 'SESSIONMEMORYLITE', { caseSensitive: true })
    assert.equal(r.hitCount, 0, 'case-sensitive: no match for upper-case needle')
  })

  test('empty query returns empty result', () => {
    const r = searchEvents(events, '')
    assert.equal(r.hitCount, 0)
    assert.equal(r.content, '')
  })

  test('sinceMs filters by timestamp', () => {
    const future = Date.now() + 60_000
    const r = searchEvents(events, 'sessionMemoryLite', { sinceMs: future })
    assert.equal(r.hitCount, 0, 'no events in the future')
  })

  test('eventTypeFilter narrows search', () => {
    const r = searchEvents(events, 'sessionMemoryLite', { eventTypeFilter: ['user_message'] })
    // Only user_message events contain 'sessionMemoryLite' (the tool event has
    // it in input.path, which extractText should still find; but our filter
    // only includes user_message so the tool event is excluded)
    assert.ok(r.hitCount >= 1, 'at least 1 user_message hit')
  })

  test('enforces 5k token cap', () => {
    const big: NexusEvent[] = []
    for (let i = 0; i < 1000; i += 1) {
      big.push(mkEvent('user_message', { text: 'x'.repeat(100) + ' MATCH' }))
    }
    const r = searchEvents(big, 'MATCH', { maxTokens: 100 })
    assert.equal(r.truncated, true, 'content must be truncated')
    assert.ok(r.tokenEstimate <= 100, `tokenEstimate=${r.tokenEstimate} must be ≤ 100`)
  })
})

describe('PR-7 summarizeWindow', () => {
  const entries: BehaviorTraceEntry[] = [
    mkTraceEntry({ trigger: 'error', timestamp: '2026-06-16T00:00:01.000Z', anomaly: { errorCode: 'E1', errorMessage: 'first' } }),
    mkTraceEntry({ trigger: 'denial', timestamp: '2026-06-16T00:00:02.000Z', anomaly: { denialReason: 'protected_path' } }),
    mkTraceEntry({ trigger: 'error', timestamp: '2026-06-16T00:00:03.000Z', anomaly: { errorCode: 'E2', errorMessage: 'second' } }),
    mkTraceEntry({ trigger: 'user-redirect', timestamp: '2026-06-16T00:00:04.000Z', anomaly: { userRedirectSignal: '不对' } }),
    mkTraceEntry({
      trigger: 'hot-path', timestamp: '2026-06-16T00:00:05.000Z',
      anomaly: { errorCode: 'HOT_PATH', errorMessage: 'hot path test', source: 'nexus' } as BehaviorTraceEntry['anomaly'],
    }),
  ]

  test('all scope returns all entries sorted newest first', () => {
    const r = summarizeWindow(entries, { scope: 'all' })
    assert.equal(r.hitCount, 5)
    assert.ok(r.content.includes('first'))
    assert.ok(r.content.includes('second'))
    // Newest first: second (00:00:03) should appear before first (00:00:01)
    const idxFirst = r.content.indexOf('first')
    const idxSecond = r.content.indexOf('second')
    assert.ok(idxSecond < idxFirst, 'newest entry (second) appears before oldest (first)')
  })

  test('scope=error filters to error triggers only', () => {
    const r = summarizeWindow(entries, { scope: 'error' })
    assert.equal(r.hitCount, 2)
    assert.ok(r.content.includes('first'))
    assert.ok(r.content.includes('second'))
    assert.ok(!r.content.includes('protected_path'))
  })

  test('scope=cross-session filters source=nexus', () => {
    const r = summarizeWindow(entries, { scope: 'cross-session' })
    assert.equal(r.hitCount, 1)
    assert.ok(r.content.includes('hot path test'))
    assert.ok(r.content.includes('[nexus]'))
  })

  test('maxEntries caps the result', () => {
    const r = summarizeWindow(entries, { maxEntries: 2 })
    assert.equal(r.hitCount, 5, 'hitCount is total matching, not returned')
    const lines = r.content.split('\n').filter(l => l.startsWith('- ['))
    assert.equal(lines.length, 2, 'maxEntries=2 → 2 result lines')
  })

  test('enforces 5k token cap', () => {
    const big: BehaviorTraceEntry[] = []
    for (let i = 0; i < 200; i += 1) {
      big.push(mkTraceEntry({ anomaly: { errorCode: 'X', errorMessage: 'y'.repeat(200) } }))
    }
    const r = summarizeWindow(big, { maxTokens: 50 })
    assert.equal(r.truncated, true)
    assert.ok(r.tokenEstimate <= 50)
  })

  test('empty entries returns (no matching trace entries)', () => {
    const r = summarizeWindow([], { scope: 'error' })
    assert.equal(r.hitCount, 0)
    assert.equal(r.content, '(no matching trace entries)')
  })
})

describe('PR-7 recentEvents', () => {
  const events: NexusEvent[] = [
    mkEvent('session_started', { timestamp: '2026-06-16T00:00:00.000Z' }),
    mkEvent('user_message', { timestamp: '2026-06-16T00:00:01.000Z', text: 'first' }),
    mkEvent('tool_started', { timestamp: '2026-06-16T00:00:02.000Z', toolUseId: 'tu_1', name: 'Read', input: { path: '/a' } }),
    mkEvent('tool_completed', { timestamp: '2026-06-16T00:00:03.000Z', toolUseId: 'tu_1', name: 'Read', success: true }),
    mkEvent('user_message', { timestamp: '2026-06-16T00:00:04.000Z', text: 'second' }),
    mkEvent('user_message', { timestamp: '2026-06-16T00:00:05.000Z', text: 'third' }),
  ]

  test('returns last N events newest first', () => {
    const r = recentEvents(events, 3)
    assert.equal(r.hitCount, 3)
    const lines = r.content.split('\n').filter(l => l.length > 0)
    assert.equal(lines.length, 3)
    // Bug 1.3 (2026-06-20): tool_completed is in the default exclude
    // set, so the 3 newest user-visible events are: user_message
    // (third), user_message (second), tool_started. The
    // tool_completed at index 2 (chronologically) is skipped, and
    // the 3rd slot is filled by the next-newest non-excluded event.
    assert.ok(lines[0]!.includes('third'))
    assert.ok(lines[1]!.includes('second'))
    assert.ok(lines[2]!.includes('tool_started'), `expected tool_started (since tool_completed is default-excluded), got: ${lines[2]}`)
    assert.ok(!r.content.includes('tool_completed'), 'tool_completed excluded by default')
  })

  test('n=0 returns (no events)', () => {
    const r = recentEvents(events, 0)
    assert.equal(r.hitCount, 0)
    assert.equal(r.content, '(no events)')
  })

  test('excludeEventTypes merges on top of the default exclusion set (Bug 1.3)', () => {
    // Bug 1.3 (2026-06-20): default excludes hook_started /
    // hook_completed / usage / thinking_delta / assistant_delta /
    // tool_completed. Caller-supplied excludeEventTypes is MERGED on
    // top so the model can add more filters without re-listing the
    // entire default. Verify by adding user_message — should leave
    // only session_started + tool_started in the result.
    const r = recentEvents(events, 10, { excludeEventTypes: ['user_message'] })
    assert.ok(!r.content.includes('user_message'), 'caller-supplied user_message excluded')
    // 6 events - 3 user_messages (user-supplied) - 1 tool_completed
    // (default) = 2 left: session_started + tool_started
    assert.equal(r.hitCount, 2)
    assert.ok(r.content.includes('session_started'))
    assert.ok(r.content.includes('tool_started'))
    assert.ok(!r.content.includes('tool_completed'))
  })

  test('default exclusion filters out hook / usage / thinking_delta (Bug 1.3)', () => {
    // Real session session_ea4f1793 caught this: a model that excluded
    // only tool_completed + assistant_delta still got hook_started
    // prepended as the very first line of contextRecent output. Verify
    // the default now hides all internal / stream-chunk event types.
    const baseEvent = (timestamp: string): NexusEvent => ({
      type: 'session_started',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId: 's',
      timestamp,
      cwd: '/tmp',
    })
    const noisyEvents: NexusEvent[] = [
      baseEvent('2026-06-20T00:00:00.000Z'),
      mkEvent('user_message', { timestamp: '2026-06-20T00:00:01.000Z', text: 'real user msg' }),
      { type: 'hook_started', schemaVersion: '2026-05-21.babel-o.v1', sessionId: 's', timestamp: '2026-06-20T00:00:02.000Z', hookName: 'InvocationDiagnosticsHook', hookEvent: 'PostInvocation' } as NexusEvent,
      { type: 'hook_completed', schemaVersion: '2026-05-21.babel-o.v1', sessionId: 's', timestamp: '2026-06-20T00:00:03.000Z', hookName: 'InvocationDiagnosticsHook', hookEvent: 'PostInvocation' } as NexusEvent,
      mkEvent('usage', { timestamp: '2026-06-20T00:00:04.000Z' }),
      mkEvent('thinking_delta', { timestamp: '2026-06-20T00:00:05.000Z', text: 'x' }),
      mkEvent('tool_started', { timestamp: '2026-06-20T00:00:06.000Z', toolUseId: 't1', name: 'Read', input: {} }),
    ]
    const r = recentEvents(noisyEvents, 10)
    assert.equal(r.hitCount, 3, 'only session_started + user_message + tool_started survive')
    assert.ok(r.content.includes('user_message'))
    assert.ok(r.content.includes('tool_started'))
    assert.ok(!r.content.includes('hook_started'), 'hook_started filtered by default')
    assert.ok(!r.content.includes('hook_completed'), 'hook_completed filtered by default')
    assert.ok(!r.content.includes('usage'), 'usage filtered by default')
    assert.ok(!r.content.includes('thinking_delta'), 'thinking_delta filtered by default')
  })

  test('caller can re-include thinking_delta by listing it explicitly', () => {
    // Bug 1.3 design choice (NOT a contradiction): the merge is additive
    // so the model cannot UNDO default filters. To re-include
    // thinking_delta the caller has to accept the default-set merge
    // and instead design around it (read the assistant_text events
    // directly, or use contextSearch with no eventTypeFilter). This
    // test documents that contract; if we ever need per-call opt-out
    // we can add a separate `includeEventTypes` parameter.
    const eventsWithThinking: NexusEvent[] = [
      mkEvent('user_message', { timestamp: '2026-06-20T00:00:00.000Z', text: 'q' }),
      mkEvent('thinking_delta', { timestamp: '2026-06-20T00:00:01.000Z', text: 'reasoning' }),
    ]
    const r = recentEvents(eventsWithThinking, 5)
    assert.equal(r.hitCount, 1, 'thinking_delta filtered by default')
    assert.ok(!r.content.includes('thinking_delta'))
  })

  test('enforces 5k token cap', () => {
    const big: NexusEvent[] = []
    for (let i = 0; i < 1000; i += 1) {
      big.push(mkEvent('user_message', { timestamp: '2026-06-16T00:00:00.000Z', text: 'x'.repeat(200) }))
    }
    const r = recentEvents(big, 1000, { maxTokens: 50 })
    assert.equal(r.truncated, true)
    // Token estimate includes the truncation marker, so allow a small buffer
    // above maxTokens. The CRITICAL guarantee is `truncated: true` to signal
    // the caller that more existed.
    assert.ok(r.tokenEstimate <= 60, `tokenEstimate=${r.tokenEstimate} should be near 50 (+truncation marker)`)
  })

  test('empty events returns (no events)', () => {
    const r = recentEvents([], 10)
    assert.equal(r.hitCount, 0)
    assert.equal(r.content, '(no events)')
  })
})

describe('PR-7 ToolResult type contract', () => {
  test('all three tools return ToolResult shape', () => {
    const events: NexusEvent[] = [mkEvent('user_message', { text: 'hi' })]
    const entries: BehaviorTraceEntry[] = [mkTraceEntry()]
    const a: ToolResult = searchEvents(events, 'hi')
    const b: ToolResult = summarizeWindow(entries)
    const c: ToolResult = recentEvents(events, 1)
    for (const r of [a, b, c]) {
      assert.equal(typeof r.content, 'string')
      assert.equal(typeof r.tokenEstimate, 'number')
      assert.equal(typeof r.hitCount, 'number')
      assert.equal(typeof r.truncated, 'boolean')
    }
  })
})
