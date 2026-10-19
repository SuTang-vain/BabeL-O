import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildPrefetchKey,
  createPrefetchCache,
} from '../src/runtime/compactionPrefetch.js'
import type { NexusEvent } from '../src/shared/events.js'

const schemaVersion = '2026-05-21.babel-o.v1' as const

function ev(partial: Partial<NexusEvent> & { type: NexusEvent['type'] }, sessionId: string, seq: number): NexusEvent {
  return {
    schemaVersion,
    sessionId,
    timestamp: `2026-10-19T00:00:${String(seq).padStart(2, '0')}.000Z`,
    ...partial,
  } as NexusEvent
}

/** A small transcript whose content identity is carried by `marker`. */
function transcript(sessionId: string, marker: string): NexusEvent[] {
  return [
    ev({ type: 'user_message', text: `please ${marker}` } as any, sessionId, 1),
    ev({ type: 'assistant_delta', text: `working on ${marker}` } as any, sessionId, 2),
    ev({ type: 'tool_started', toolUseId: `t-${marker}`, name: 'Bash', input: { command: `echo ${marker}` } } as any, sessionId, 3),
    ev({ type: 'tool_completed', toolUseId: `t-${marker}`, name: 'Bash', success: true, output: marker } as any, sessionId, 4),
  ]
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

/** Flush the microtask queue so settlement observers have run. */
const tick = () => new Promise(resolve => setImmediate(resolve))

describe('buildPrefetchKey', () => {
  test('is content-keyed: identical transcripts share a key, any content change rekeys', () => {
    const base = transcript('s1', 'alpha')
    assert.equal(buildPrefetchKey(base), buildPrefetchKey(transcript('s1', 'alpha')))
    assert.notEqual(buildPrefetchKey(base), buildPrefetchKey(transcript('s1', 'beta')))
    assert.notEqual(buildPrefetchKey(base), buildPrefetchKey(transcript('s2', 'alpha')))
    // Same length but different text must rekey (a length-only hash would collide).
    const sameLength = transcript('s1', 'alpha')
    sameLength[1] = ev({ type: 'assistant_delta', text: 'working on betaa' } as any, 's1', 2)
    assert.notEqual(buildPrefetchKey(base), buildPrefetchKey(sameLength))
    // Appending an event rekeys (the omission-set growth case).
    const grown = [...base, ev({ type: 'user_message', text: 'one more thing' } as any, 's1', 5)]
    assert.notEqual(buildPrefetchKey(base), buildPrefetchKey(grown))
  })
})

describe('createPrefetchCache', () => {
  test('hit returns the prefetched summary with the latency saved', async () => {
    let nowMs = 0
    const d = deferred<string>()
    const seen: number[] = []
    const cache = createPrefetchCache({
      summarize: events => { seen.push(events.length); return d.promise },
      now: () => nowMs,
    })
    const events = transcript('s1', 'alpha')
    const key = cache.prefetch(events)
    assert.equal(key, buildPrefetchKey(events))
    assert.equal(seen.length, 1) // summarize started immediately

    nowMs = 120
    d.resolve('SUMMARY-ALPHA')
    await tick()

    const result = await cache.awaitSummary(events, { deadlineMs: 1000 })
    assert.deepEqual(result, { status: 'hit', summary: 'SUMMARY-ALPHA', latencySavedMs: 120 })
  })

  test('miss when nothing was prefetched; summarize is never called', async () => {
    const cache = createPrefetchCache({
      summarize: () => { throw new Error('must not be called') },
    })
    assert.deepEqual(await cache.awaitSummary(transcript('s1', 'x'), { deadlineMs: 100 }), { status: 'miss' })
  })

  test('stale guard: key mismatch invalidates the entry and the old summary is never returned, even after it resolves', async () => {
    let nowMs = 0
    const d = deferred<string>()
    const cache = createPrefetchCache({ summarize: () => d.promise, now: () => nowMs })
    const eventsA = transcript('s1', 'alpha')
    const eventsB = transcript('s1', 'beta')
    cache.prefetch(eventsA)

    assert.deepEqual(await cache.awaitSummary(eventsB, { deadlineMs: 1000 }), { status: 'stale' })
    assert.equal(cache.size(), 0) // mismatched prediction invalidated

    nowMs = 500
    d.resolve('STALE-SUMMARY')
    await tick()

    // The late resolution of the invalidated entry is dropped: not even the
    // ORIGINAL events can retrieve the old summary now.
    assert.deepEqual(await cache.awaitSummary(eventsA, { deadlineMs: 1000 }), { status: 'miss' })
    const again = await cache.awaitSummary(eventsB, { deadlineMs: 1000 })
    assert.equal(again.status, 'miss')
    assert.equal('summary' in again, false)
  })

  test('deadline timeout falls back; the late result stays only under its original key', async () => {
    let nowMs = 0
    const d = deferred<string>()
    const cache = createPrefetchCache({ summarize: () => d.promise, now: () => nowMs })
    const events = transcript('s1', 'gamma')
    const other = transcript('s1', 'delta')
    cache.prefetch(events) // t=0

    nowMs = 10
    const fallback = await cache.awaitSummary(events, { deadlineMs: 50 }) // ~40ms real wait
    assert.deepEqual(fallback, { status: 'fallback', reason: 'timeout' })

    // Deadline already exhausted while still pending -> immediate timeout fallback.
    nowMs = 100
    assert.deepEqual(await cache.awaitSummary(events, { deadlineMs: 50 }), { status: 'fallback', reason: 'timeout' })

    nowMs = 400
    d.resolve('LATE-SUMMARY')
    await tick()

    // Timeout is not eviction: the SAME events can still collect the late result.
    const hit = await cache.awaitSummary(events, { deadlineMs: 1000 })
    assert.deepEqual(hit, { status: 'hit', summary: 'LATE-SUMMARY', latencySavedMs: 400 })

    // But it was never re-keyed: different events are stale and get nothing.
    const stale = await cache.awaitSummary(other, { deadlineMs: 1000 })
    assert.equal(stale.status, 'stale')
    assert.equal('summary' in stale, false)
    assert.equal(cache.size(), 0)
  })

  test('duplicate prefetch for the same content key starts summarize only once', async () => {
    let calls = 0
    const d = deferred<string>()
    const cache = createPrefetchCache({ summarize: () => { calls += 1; return d.promise } })

    const key1 = cache.prefetch(transcript('s1', 'eps'))
    const key2 = cache.prefetch(transcript('s1', 'eps')) // fresh array, same content
    assert.equal(key1, key2)
    assert.equal(calls, 1)

    d.resolve('ONE')
    await tick()
    const result = await cache.awaitSummary(transcript('s1', 'eps'), { deadlineMs: 1000 })
    assert.equal(result.status, 'hit')
    assert.equal(result.status === 'hit' && result.summary, 'ONE')

    // Still a no-op after settlement: the entry is reusable.
    cache.prefetch(transcript('s1', 'eps'))
    assert.equal(calls, 1)
  })

  test('LRU eviction at maxEntries drops the oldest entry and discards its late resolution', async () => {
    let nowMs = 0
    const pending: Array<ReturnType<typeof deferred<string>>> = []
    const cache = createPrefetchCache({
      maxEntries: 2,
      now: () => nowMs,
      summarize: () => { const d = deferred<string>(); pending.push(d); return d.promise },
    })
    const eventsA = transcript('s1', 'a')
    const eventsB = transcript('s1', 'b')
    const eventsC = transcript('s1', 'c')
    cache.prefetch(eventsA) // pending[0]
    cache.prefetch(eventsB) // pending[1]
    cache.prefetch(eventsC) // pending[2] -> evicts A
    assert.equal(cache.size(), 2)
    assert.equal(pending.length, 3) // eviction does not cancel the in-flight call

    nowMs = 20
    pending[1]!.resolve('B-SUMMARY')
    pending[2]!.resolve('C-SUMMARY')
    await tick()
    assert.equal((await cache.awaitSummary(eventsC, { deadlineMs: 1000 })).status, 'hit')
    assert.equal((await cache.awaitSummary(eventsB, { deadlineMs: 1000 })).status, 'hit')

    // Evicted A resolves late: the result is dropped, never served.
    nowMs = 50
    pending[0]!.resolve('A-SUMMARY')
    await tick()
    assert.deepEqual(await cache.awaitSummary(eventsA, { deadlineMs: 1000 }), { status: 'stale' })
    assert.equal(cache.size(), 0)
  })

  test('summarize rejection falls back and removes the entry; sync throw behaves the same', async () => {
    const d = deferred<string>()
    const cache = createPrefetchCache({ summarize: () => d.promise })
    const events = transcript('s1', 'rej')
    cache.prefetch(events)

    d.reject(new Error('provider down'))
    await tick()
    assert.deepEqual(await cache.awaitSummary(events, { deadlineMs: 1000 }), { status: 'fallback', reason: 'error' })
    assert.equal(cache.size(), 0)
    assert.deepEqual(await cache.awaitSummary(events, { deadlineMs: 1000 }), { status: 'miss' })

    const throwing = createPrefetchCache({
      summarize: () => { throw new Error('sync boom') },
    })
    throwing.prefetch(events)
    assert.deepEqual(await throwing.awaitSummary(events, { deadlineMs: 1000 }), { status: 'fallback', reason: 'error' })
  })
})
