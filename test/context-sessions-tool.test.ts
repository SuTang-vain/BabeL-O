// test/context-sessions-tool.test.ts
//
// Focused regression for the contextSessions tool (Bug 1.1 fix:
// cross-session metadata search). Verifies:
//   - storage gate (CONTEXT_STORAGE_UNAVAILABLE when storage missing)
//   - basic listing without query (newest first, limit honored)
//   - query match against prompt / lastUserInput / result / cwd
//   - cwd / phase / sinceMs filters
//   - case sensitivity flag
//   - empty result graceful payload
//   - token cap with truncated flag

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { contextSessionsTool } from '../src/tools/builtin/contextSessions.js'
import { searchSessionsMetadata, type SessionMetadata } from '../src/tools/contextTools.js'
import type { ToolContext } from '../src/tools/Tool.js'
import type { NexusStorage } from '../src/storage/Storage.js'
import type { SessionSnapshot } from '../src/shared/session.js'

function makeContext(storage: NexusStorage | undefined): ToolContext {
  return {
    sessionId: 'caller-session',
    cwd: '/tmp',
    storage,
    permissions: { askForPermission: async () => 'ALLOWED' },
    abortSignal: new AbortController().signal,
    logEvent: () => {},
  } as unknown as ToolContext
}

function mkSession(overrides: Partial<SessionSnapshot> & { sessionId: string }): SessionSnapshot {
  return {
    sessionId: overrides.sessionId,
    cwd: overrides.cwd ?? '/Users/tangyaoyue/DEV/BABEL/BabeL-O',
    prompt: overrides.prompt ?? '',
    phase: (overrides.phase ?? 'completed') as SessionSnapshot['phase'],
    createdAt: overrides.createdAt ?? '2026-06-20T10:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-06-20T10:00:00.000Z',
    events: [],
    lastUserInput: overrides.lastUserInput,
    result: overrides.result,
    failureReason: overrides.failureReason,
  } as SessionSnapshot
}

// ─── searchSessionsMetadata (data layer) ──────────────────────────────────

test('searchSessionsMetadata: empty list returns no-match payload', () => {
  const result = searchSessionsMetadata([], { query: 'anything' })
  assert.equal(result.hitCount, 0)
  assert.match(result.content, /no matching sessions/)
})

test('searchSessionsMetadata: query matches prompt / lastUserInput / cwd', () => {
  const sessions: SessionMetadata[] = [
    { sessionId: 's1', cwd: '/proj/a', lastUserInput: 'fix memory leak', updatedAt: '2026-06-20T10:00:00.000Z' },
    { sessionId: 's2', cwd: '/proj/b', prompt: 'review the leak fix', updatedAt: '2026-06-20T11:00:00.000Z' },
    { sessionId: 's3', cwd: '/proj/c', lastUserInput: 'deploy build', updatedAt: '2026-06-20T12:00:00.000Z' },
  ]
  const result = searchSessionsMetadata(sessions, { query: 'leak' })
  assert.equal(result.hitCount, 2)
  // Newest first
  assert.match(result.content, /s2[\s\S]*s1/)
  assert.doesNotMatch(result.content, /s3/)
})

test('searchSessionsMetadata: cwd filter narrows to one workspace', () => {
  const sessions: SessionMetadata[] = [
    { sessionId: 's1', cwd: '/proj/a', updatedAt: '2026-06-20T10:00:00.000Z' },
    { sessionId: 's2', cwd: '/proj/b', updatedAt: '2026-06-20T11:00:00.000Z' },
    { sessionId: 's3', cwd: '/proj/a', updatedAt: '2026-06-20T12:00:00.000Z' },
  ]
  const result = searchSessionsMetadata(sessions, { cwd: '/proj/a' })
  assert.equal(result.hitCount, 2)
  assert.match(result.content, /s3[\s\S]*s1/)
  assert.doesNotMatch(result.content, /s2/)
})

test('searchSessionsMetadata: phase filter accepts string or array', () => {
  const sessions: SessionMetadata[] = [
    { sessionId: 's1', phase: 'completed', updatedAt: '2026-06-20T10:00:00.000Z' },
    { sessionId: 's2', phase: 'failed', updatedAt: '2026-06-20T11:00:00.000Z' },
    { sessionId: 's3', phase: 'executing', updatedAt: '2026-06-20T12:00:00.000Z' },
  ]
  const single = searchSessionsMetadata(sessions, { phase: 'failed' })
  assert.equal(single.hitCount, 1)
  assert.match(single.content, /s2/)

  const multi = searchSessionsMetadata(sessions, { phase: ['failed', 'executing'] })
  assert.equal(multi.hitCount, 2)
  assert.doesNotMatch(multi.content, /s1/)
})

test('searchSessionsMetadata: sinceMs filter drops older sessions', () => {
  const sessions: SessionMetadata[] = [
    { sessionId: 's1', updatedAt: '2026-06-20T08:00:00.000Z' },
    { sessionId: 's2', updatedAt: '2026-06-20T11:00:00.000Z' },
    { sessionId: 's3', updatedAt: '2026-06-20T12:00:00.000Z' },
  ]
  const noon = Date.parse('2026-06-20T10:00:00.000Z')
  const result = searchSessionsMetadata(sessions, { sinceMs: noon })
  assert.equal(result.hitCount, 2)
  assert.doesNotMatch(result.content, /s1/)
})

test('searchSessionsMetadata: limit honors newest-first order', () => {
  const sessions: SessionMetadata[] = Array.from({ length: 10 }, (_, i) => ({
    sessionId: `s${i}`,
    updatedAt: `2026-06-20T1${i}:00:00.000Z`,
  }))
  const result = searchSessionsMetadata(sessions, { limit: 3 })
  assert.equal(result.hitCount, 10)
  // Top 3 newest = s9, s8, s7
  assert.match(result.content, /s9[\s\S]*s8[\s\S]*s7/)
  assert.doesNotMatch(result.content, /s0|s1|s2|s3|s4|s5|s6/)
})

test('searchSessionsMetadata: caseSensitive controls matching', () => {
  const sessions: SessionMetadata[] = [
    { sessionId: 's1', lastUserInput: 'Fix Memory Leak', updatedAt: '2026-06-20T10:00:00.000Z' },
  ]
  const insensitive = searchSessionsMetadata(sessions, { query: 'memory' })
  assert.equal(insensitive.hitCount, 1)
  const sensitive = searchSessionsMetadata(sessions, { query: 'memory', caseSensitive: true })
  assert.equal(sensitive.hitCount, 0)
})

test('searchSessionsMetadata: token cap truncates long output', () => {
  const longInput = 'x'.repeat(500)
  const sessions: SessionMetadata[] = Array.from({ length: 50 }, (_, i) => ({
    sessionId: `session-${i}`,
    lastUserInput: longInput,
    updatedAt: `2026-06-${20 - i}T10:00:00.000Z`,
  }))
  // Tight cap forces truncation
  const result = searchSessionsMetadata(sessions, { maxTokens: 50 })
  assert.equal(result.truncated, true)
  assert.match(result.content, /\[\.\.\.truncated\]/)
})

// ─── contextSessionsTool (builtin wrapper) ────────────────────────────────

test('contextSessionsTool: storage missing -> CONTEXT_STORAGE_UNAVAILABLE', async () => {
  const result = await contextSessionsTool.execute({}, makeContext(undefined))
  assert.equal(result.success, false)
  const out = result.output as { code?: string }
  assert.equal(out.code, 'CONTEXT_STORAGE_UNAVAILABLE')
})

test('contextSessionsTool: wires storage.listSessions -> searchSessionsMetadata', async () => {
  const fixtureSessions = [
    mkSession({ sessionId: 's-old', updatedAt: '2026-06-20T08:00:00.000Z', lastUserInput: 'older' }),
    mkSession({ sessionId: 's-new', updatedAt: '2026-06-20T12:00:00.000Z', lastUserInput: 'newer' }),
  ]
  const storage = {
    listSessions: async () => fixtureSessions,
  } as unknown as NexusStorage

  const result = await contextSessionsTool.execute({ limit: 5 }, makeContext(storage))
  assert.equal(result.success, true)
  const out = result.output as { content: string; hitCount: number }
  assert.equal(out.hitCount, 2)
  // Newest first
  assert.match(out.content, /s-new[\s\S]*s-old/)
})

test('contextSessionsTool: query forwarded into searchSessionsMetadata', async () => {
  const fixtureSessions = [
    mkSession({ sessionId: 's-leak', lastUserInput: 'fix memory leak', updatedAt: '2026-06-20T10:00:00.000Z' }),
    mkSession({ sessionId: 's-other', lastUserInput: 'unrelated work', updatedAt: '2026-06-20T11:00:00.000Z' }),
  ]
  const storage = {
    listSessions: async () => fixtureSessions,
  } as unknown as NexusStorage

  const result = await contextSessionsTool.execute({ query: 'leak' }, makeContext(storage))
  assert.equal(result.success, true)
  const out = result.output as { hitCount: number; content: string }
  assert.equal(out.hitCount, 1)
  assert.match(out.content, /s-leak/)
  assert.doesNotMatch(out.content, /s-other/)
})

test('contextSessionsTool: storage error -> CONTEXT_SESSIONS_FAILED', async () => {
  const storage = {
    listSessions: async () => { throw new Error('storage broke') },
  } as unknown as NexusStorage

  const result = await contextSessionsTool.execute({}, makeContext(storage))
  assert.equal(result.success, false)
  const out = result.output as { code?: string; message?: string }
  assert.equal(out.code, 'CONTEXT_SESSIONS_FAILED')
  assert.match(out.message ?? '', /storage broke/)
})

test('contextSessionsTool: tool metadata is read-risk and no-approval', () => {
  assert.equal(contextSessionsTool.name, 'contextSessions')
  assert.equal(contextSessionsTool.risk, 'read')
  assert.equal(contextSessionsTool.requiresApproval, false)
  assert.match(contextSessionsTool.prompt?.() ?? '', /cross-session/i)
})
