import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  findSessionInSqlite,
  grepLogForSessionId,
  grepRecentEmbeddedNexusStarts,
  inspectSession,
  registerInspectSessionCommand,
  resolveLogPaths,
  resolveSqlitePath,
  exportSessionTrace,
  exportSessionResumeState,
  formatResumeState,
} from '../src/cli/commands/inspectSession.js'

/**
 * Phase 0 of `docs/nexus/reference/go-tui-session-observability-governance-plan.md`:
 * `bbl inspect-session` CLI tests. Three-tier hint model:
 *   1. (a) Found in SQLite with events
 *   2. (b) Found in client log but not SQLite
 *   3. (c) Not found anywhere (with recent embedded-nexus start log fallback)
 *
 * Hard invariants:
 *  - Test isolation: every test uses `mkdtempSync` + `BABEL_O_CONFIG_DIR`
 *    so the real `~/.babel-o/` is never touched.
 *  - Read-only: tests never call `save*` or write back to the SQLite.
 *  - Pure functions: `inspectSession`, `findSessionInSqlite`,
 *    `grepLogForSessionId`, `grepRecentEmbeddedNexusStarts` are all
 *    side-effect-free and can be called directly.
 */

function withTempConfigDir<T>(fn: (configDir: string) => T): T {
  const prev = process.env.BABEL_O_CONFIG_DIR
  const tempDir = mkdtempSync(join(tmpdir(), 'babel-o-inspect-session-'))
  process.env.BABEL_O_CONFIG_DIR = tempDir
  try {
    return fn(tempDir)
  } finally {
    if (prev === undefined) delete process.env.BABEL_O_CONFIG_DIR
    else process.env.BABEL_O_CONFIG_DIR = prev
    try { rmSync(tempDir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

function seedSqliteWithSession(
  dbPath: string,
  sessionId: string,
  options: { withEvents?: boolean; eventCount?: number; metadata?: Record<string, unknown> } = {},
): void {
  mkdirSync(join(dbPath, '..'), { recursive: true })
  const db = new DatabaseSync(dbPath)
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        cwd TEXT NOT NULL,
        prompt TEXT NOT NULL,
        phase TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        result TEXT,
        error TEXT,
        metadata TEXT
      );
    `)
    db.prepare(
      `INSERT OR REPLACE INTO sessions
        (session_id, cwd, prompt, phase, created_at, updated_at, result, error, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      sessionId,
      '/Users/tangyaoyue/DEV',
      'git status',
      'completed',
      '2026-06-11T02:52:39.000Z',
      '2026-06-11T02:53:01.000Z',
      'On branch main',
      null,
      options.metadata ? JSON.stringify(options.metadata) : null,
    )

    if (options.withEvents !== false) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS events (
          event_key TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          timestamp TEXT NOT NULL,
          event_type TEXT,
          event_json TEXT
        );
      `)
      const count = options.eventCount ?? 3
      for (let i = 0; i < count; i++) {
        db.prepare(
          `INSERT OR REPLACE INTO events (event_key, session_id, timestamp) VALUES (?, ?, ?)`,
        ).run(
          `evt_${sessionId}_${i}`,
          sessionId,
          `2026-06-11T02:52:${(40 + i).toString().padStart(2, '0')}.000Z`,
        )
      }
    }
  } finally {
    try { db.close() } catch { /* ignore */ }
  }
}

test('inspectSession: tier (a) found in SQLite renders the row + event count', () => {
  withTempConfigDir((configDir) => {
    const dbPath = join(configDir, 'db.sqlite')
    seedSqliteWithSession(dbPath, 'session_a1b2c3d4-5981-4024-bb0b-2b5229fbc150', { eventCount: 7 })
    const result = inspectSession('session_a1b2c3d4-5981-4024-bb0b-2b5229fbc150')
    assert.equal(result.tier, 'found-in-sqlite')
    if (result.tier !== 'found-in-sqlite') return
    assert.equal(result.row.sessionId, 'session_a1b2c3d4-5981-4024-bb0b-2b5229fbc150')
    assert.equal(result.row.phase, 'completed')
    assert.equal(result.row.cwd, '/Users/tangyaoyue/DEV')
    assert.equal(result.row.eventCount, 7)
    assert.equal(result.row.prompt, 'git status')
    assert.equal(result.row.result, 'On branch main')
    assert.equal(result.row.error, null)
  })
})

test('inspectSession: tier (a) with no events still returns the row (eventCount=0)', () => {
  withTempConfigDir((configDir) => {
    const dbPath = join(configDir, 'db.sqlite')
    seedSqliteWithSession(dbPath, 'session_no_events-uuid', { withEvents: false })
    const result = inspectSession('session_no_events-uuid')
    assert.equal(result.tier, 'found-in-sqlite')
    if (result.tier !== 'found-in-sqlite') return
    assert.equal(result.row.eventCount, 0)
  })
})

test('inspectSession: tier (a) surfaces clientSessionId from metadata (Go TUI Phase 1 back-reference)', () => {
  // Phase 1.1.1 of the go-tui-session-observability-governance
  // plan: when a Go TUI session allocates a server uuid, it sends
  // the local session_go_<unixnano> placeholder as
  // body.metadata.clientSessionId. The server stores metadata
  // as JSON in the sessions table. This test verifies that
  // `bbl inspect-session <server uuid>` surfaces that back-
  // reference so the operator can pivot back to the client
  // session id without grepping the client log.
  withTempConfigDir((configDir) => {
    const dbPath = join(configDir, 'db.sqlite')
    seedSqliteWithSession(dbPath, 'session_alloc_tier_a-uuid', {
      metadata: { client: 'go-tui', phase: 'session_allocate', clientSessionId: 'session_go_1781146359507755000' },
    })
    const result = inspectSession('session_alloc_tier_a-uuid')
    assert.equal(result.tier, 'found-in-sqlite')
    if (result.tier !== 'found-in-sqlite') return
    assert.equal(result.row.clientSessionId, 'session_go_1781146359507755000')
  })
})

test('inspectSession: tier (a) returns clientSessionId=null when metadata column is missing or empty', () => {
  // Defensive: pre-Phase-1 Nexus rows don't have a metadata
  // column at all (the SQLite schema added it later). bbl chat
  // sessions don't carry a clientSessionId. Both must render
  // without crashing.
  withTempConfigDir((configDir) => {
    const dbPath = join(configDir, 'db.sqlite')
    // No `metadata` option → null in the row.
    seedSqliteWithSession(dbPath, 'session_no_metadata-uuid')
    const result = inspectSession('session_no_metadata-uuid')
    assert.equal(result.tier, 'found-in-sqlite')
    if (result.tier !== 'found-in-sqlite') return
    assert.equal(result.row.clientSessionId, null)
  })
})

test('inspectSession: tier (a) returns clientSessionId=null when metadata is malformed JSON', () => {
  // A row whose metadata blob was written by a buggy Nexus
  // (or someone hand-editing the db) must not break the rest
  // of the row's rendering. Defensive JSON.parse failure.
  withTempConfigDir((configDir) => {
    const dbPath = join(configDir, 'db.sqlite')
    // Insert directly with malformed JSON to bypass the
    // seedSqliteWithSession helper (which stringifies).
    mkdirSync(join(dbPath, '..'), { recursive: true })
    const db = new DatabaseSync(dbPath)
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
          session_id TEXT PRIMARY KEY,
          cwd TEXT NOT NULL,
          prompt TEXT NOT NULL,
          phase TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          result TEXT,
          error TEXT,
          metadata TEXT
        );
      `)
      db.prepare(
        `INSERT INTO sessions
          (session_id, cwd, prompt, phase, created_at, updated_at, result, error, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'session_broken_metadata-uuid',
        '/Users/tangyaoyue/DEV',
        'git status',
        'completed',
        '2026-06-11T02:52:39.000Z',
        '2026-06-11T02:53:01.000Z',
        null,
        null,
        '{this is not valid json',
      )
    } finally {
      db.close()
    }
    const result = inspectSession('session_broken_metadata-uuid')
    assert.equal(result.tier, 'found-in-sqlite')
    if (result.tier !== 'found-in-sqlite') return
    // Malformed metadata → clientSessionId null, but the rest of
    // the row (phase / cwd / events) still renders.
    assert.equal(result.row.clientSessionId, null)
    assert.equal(result.row.phase, 'completed')
  })
})

test('inspectSession: tier (a) renders compact boundary protocol details', () => {
  withTempConfigDir((configDir) => {
    const dbPath = join(configDir, 'db.sqlite')
    const sessionId = 'session_compact_boundary-uuid'
    seedSqliteWithSession(dbPath, sessionId, { withEvents: false })
    const db = new DatabaseSync(dbPath)
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS events (
          event_key TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          timestamp TEXT NOT NULL,
          event_type TEXT,
          event_json TEXT
        );
      `)
      const event = {
        type: 'context_compact_boundary',
        timestamp: '2026-06-12T00:00:00.000Z',
        trigger: 'manual',
        boundaryId: 'boundary_123',
        beforeEventCount: 120,
        afterEventCount: 14,
        preTokens: 42_000,
        postTokens: 7_500,
        estimatedTokensSaved: 34_500,
        summaryChars: 780,
        snippedToolResults: 3,
        messagesSummarized: 119,
        droppedItemCount: 119,
        retainedItemCount: 13,
        retainedEventCount: 13,
        preservedTailEventId: 'event_tail',
        retainedSegmentHash: 'hash_abc',
        userVisibleSummary: 'Earlier context summary for the operator.',
      }
      db.prepare(
        `INSERT OR REPLACE INTO events (event_key, session_id, timestamp, event_type, event_json)
         VALUES (?, ?, ?, ?, ?)`,
      ).run('evt_context_boundary', sessionId, event.timestamp, event.type, JSON.stringify(event))
    } finally {
      try { db.close() } catch { /* ignore */ }
    }

    const result = inspectSession(sessionId)
    assert.equal(result.tier, 'found-in-sqlite')
    if (result.tier !== 'found-in-sqlite') return
    assert.equal(result.row.compactBoundaries.length, 1)
    const boundary = result.row.compactBoundaries[0]
    assert.equal(boundary.type, 'context_compact_boundary')
    assert.equal(boundary.boundaryId, 'boundary_123')
    assert.equal(boundary.beforeEventCount, 120)
    assert.equal(boundary.afterEventCount, 14)
    assert.equal(boundary.preTokens, 42_000)
    assert.equal(boundary.postTokens, 7_500)
    assert.equal(boundary.estimatedTokensSaved, 34_500)
    assert.equal(boundary.retainedEventCount, 13)
    assert.equal(boundary.preservedTailEventId, 'event_tail')
  })
})

test('inspectSession: tier (b) found in client log only (embedded Nexus memory-storage loss)', () => {
  // The exact `session_go_1781146359507755000` failure mode: client
  // Go TUI wrote the session id to a log line, but the embedded
  // Nexus it talked to used MemoryStorage and never persisted.
  withTempConfigDir((configDir) => {
    const logPath = join(configDir, 'log', 'go-tui-session.log')
    mkdirSync(join(configDir, 'log'), { recursive: true })
    writeFileSync(
      logPath,
      [
        '[2026-06-11T10:52:39+08:00] go-tui starting embedded Nexus clientSessionId=session_go_1781146359507755000',
        '[2026-06-11T10:52:39+08:00] go-tui sent execute request sessionId=session_go_1781146359507755000',
        '[2026-06-11T10:53:55+08:00] user prompt: investigate session_go_1781146359507755000',
      ].join('\n'),
    )
    const result = inspectSession('session_go_1781146359507755000')
    assert.equal(result.tier, 'found-in-client-log-only')
    if (result.tier !== 'found-in-client-log-only') return
    assert.ok(result.clientHits.length >= 2, 'should match the multiple log lines')
    const allMention = result.clientHits.every((hit) => hit.matchedLine.includes('session_go_1781146359507755000'))
    assert.ok(allMention)
  })
})

test('inspectSession: tier (c) not found + recent embedded-nexus start log gives context', () => {
  withTempConfigDir((configDir) => {
    const logPath = join(configDir, 'log', 'embedded-nexus.log')
    mkdirSync(join(configDir, 'log'), { recursive: true })
    writeFileSync(
      logPath,
      [
        '[2026-06-11T11:08:07+08:00] bbl-go[pid=22886] starting embedded Nexus storage=/Users/tangyaoyue/.babel-o/db.sqlite cwd=/Users/tangyaoyue/DEV',
        '[2026-06-11T11:08:07+08:00] nexus[pid=22886] listen=http://127.0.0.1:3000',
      ].join('\n'),
    )
    const result = inspectSession('session_ghost-id-not-persisted')
    assert.equal(result.tier, 'not-found')
    if (result.tier !== 'not-found') return
    assert.equal(result.clientHits.length, 0)
    assert.ok(result.recentEmbeddedStarts.length >= 1)
    const first = result.recentEmbeddedStarts[0]
    assert.equal(first.pid, 22886)
    assert.equal(first.storage, '/Users/tangyaoyue/.babel-o/db.sqlite')
    assert.equal(first.startedAt, '2026-06-11T11:08:07+08:00')
  })
})

test('inspectSession: tier (c) with no log files still produces a usable not-found result', () => {
  withTempConfigDir(() => {
    // No db.sqlite, no log/ directory, no embedded-nexus.log.
    const result = inspectSession('session_no_logs-anywhere')
    assert.equal(result.tier, 'not-found')
    if (result.tier !== 'not-found') return
    assert.equal(result.recentEmbeddedStarts.length, 0)
    assert.equal(result.clientHits.length, 0)
  })
})

test('inspectSession: missing SQLite file (no Nexus ever ran) returns tier (c) without throwing', () => {
  withTempConfigDir(() => {
    // Config dir exists but no db.sqlite. findSessionInSqlite should
    // gracefully return null, not throw.
    const result = inspectSession('session_anything')
    assert.equal(result.tier, 'not-found')
  })
})

test('inspectSession: malformed SQLite file (not actually a database) does not crash', () => {
  withTempConfigDir((configDir) => {
    const dbPath = join(configDir, 'db.sqlite')
    mkdirSync(configDir, { recursive: true })
    writeFileSync(dbPath, 'this is not a sqlite database file')
    const result = inspectSession('session_anything')
    // Either tier (c) or a graceful no-match. Must not throw.
    assert.ok(result.tier === 'not-found' || result.tier === 'found-in-sqlite')
  })
})

test('findSessionInSqlite: pure function, no BABEL_O_CONFIG_DIR mutation', () => {
  // Direct sqlitePath argument: should work regardless of env.
  withTempConfigDir((configDir) => {
    const dbPath = join(configDir, 'db.sqlite')
    seedSqliteWithSession(dbPath, 'session_direct-uuid')
    const row = findSessionInSqlite('session_direct-uuid', { sqlitePath: dbPath })
    assert.ok(row)
    assert.equal(row?.phase, 'completed')
  })
})

test('findSessionInSqlite: returns null for non-existent session id', () => {
  withTempConfigDir((configDir) => {
    const dbPath = join(configDir, 'db.sqlite')
    seedSqliteWithSession(dbPath, 'session_real-uuid')
    const row = findSessionInSqlite('session_does_not_exist', { sqlitePath: dbPath })
    assert.equal(row, null)
  })
})

test('grepLogForSessionId: pure function, line-number indexing, maxLines cap', () => {
  withTempConfigDir((configDir) => {
    const logPath = join(configDir, 'sample.log')
    writeFileSync(
      logPath,
      [
        'line 1: no match',
        'line 2: mentions session_abc',
        'line 3: no match',
        'line 4: session_abc again',
        'line 5: another session_abc',
      ].join('\n'),
    )
    const hits = grepLogForSessionId(logPath, 'session_abc', { maxLines: 10 })
    assert.equal(hits.length, 3)
    assert.deepEqual(
      hits.map((h) => h.lineNumber),
      [2, 4, 5],
    )
  })
})

test('grepLogForSessionId: truncates very long lines to keep CLI output readable', () => {
  withTempConfigDir((configDir) => {
    const logPath = join(configDir, 'long.log')
    const longLine = `prefix session_x ${'x'.repeat(500)} suffix`
    writeFileSync(logPath, longLine)
    const hits = grepLogForSessionId(logPath, 'session_x', { maxLineLength: 50 })
    assert.equal(hits.length, 1)
    assert.ok(hits[0].matchedLine.endsWith('…'))
    assert.ok(hits[0].matchedLine.length <= 51)
  })
})

test('grepRecentEmbeddedNexusStarts: parses pid / storage / cwd / startedAt from bbl-go and nexus lines', () => {
  withTempConfigDir((configDir) => {
    const logPath = join(configDir, 'embedded.log')
    writeFileSync(
      logPath,
      [
        '[2026-06-11T10:00:00+08:00] bbl-go[pid=12345] starting embedded Nexus storage=/tmp/x.db cwd=/tmp',
        '[2026-06-11T10:00:00+08:00] nexus[pid=12345] listen=http://127.0.0.1:3000',
        'unrelated line',
      ].join('\n'),
    )
    const starts = grepRecentEmbeddedNexusStarts(logPath, { maxLines: 10 })
    // 2 bbl-go/nexus lines (the third is unrelated).
    assert.equal(starts.length, 2)
    assert.equal(starts[0].pid, 12345)
    assert.equal(starts[0].storage, '/tmp/x.db')
    assert.equal(starts[0].cwd, '/tmp')
    assert.equal(starts[0].startedAt, '2026-06-11T10:00:00+08:00')
  })
})

test('grepRecentEmbeddedNexusStarts: respects maxLines cap', () => {
  withTempConfigDir((configDir) => {
    const logPath = join(configDir, 'embedded.log')
    const lines = []
    for (let i = 0; i < 50; i++) {
      lines.push(`[2026-06-11T10:${i.toString().padStart(2, '0')}:00+08:00] bbl-go[pid=${1000 + i}] starting embedded Nexus storage=/tmp/x.db`)
    }
    writeFileSync(logPath, lines.join('\n'))
    const starts = grepRecentEmbeddedNexusStarts(logPath, { maxLines: 10 })
    assert.equal(starts.length, 10)
  })
})

test('resolveSqlitePath + resolveLogPaths: honour BABEL_O_CONFIG_DIR', () => {
  withTempConfigDir((configDir) => {
    const sqlitePath = resolveSqlitePath()
    assert.equal(sqlitePath, join(configDir, 'db.sqlite'))
    const { clientLogPath, embeddedNexusLogPath } = resolveLogPaths()
    assert.equal(clientLogPath, join(configDir, 'log', 'go-tui-session.log'))
    assert.equal(embeddedNexusLogPath, join(configDir, 'log', 'embedded-nexus.log'))
  })
})

test('registerInspectSessionCommand: registers the subcommand with the expected description', async () => {
  // Use commander.Command to construct a stub program. We just need to
  // confirm that registration adds an `inspect-session` subcommand.
  // We don't run the action — that would touch the real filesystem.
  const { Command } = await import('commander')
  const program = new Command()
  registerInspectSessionCommand(program)
  const sub = program.commands.find((c) => c.name() === 'inspect-session')
  assert.ok(sub, 'inspect-session subcommand should be registered')
  assert.match(sub!.description(), /Diagnose where a Go TUI \/ Nexus session was persisted/)
})

test('inspectSession: matches `session_go_` IDs against go-tui-session.log (the real failure mode)', () => {
  // End-to-end: simulate the exact `session_go_1781146359507755000`
  // case from the governance plan. Go TUI logged the id, embedded
  // Nexus used MemoryStorage, the row is gone — this CLI must give
  // tier (b).
  withTempConfigDir((configDir) => {
    const logPath = join(configDir, 'log', 'go-tui-session.log')
    mkdirSync(join(configDir, 'log'), { recursive: true })
    writeFileSync(
      logPath,
      '[2026-06-11T10:52:39+08:00] go-tui starting embedded Nexus clientSessionId=session_go_1781146359507755000 serverSessionId=null',
    )
    const result = inspectSession('session_go_1781146359507755000')
    assert.equal(result.tier, 'found-in-client-log-only')
  })
})

// ---------------------------------------------------------------------------
// Agent Trace Schema export (`bbl inspect-session <id> --trace`).
// agent-runtime-architecture-maturity-plan.md §3.1.
// ---------------------------------------------------------------------------

const TRACE_SCHEMA_VERSION = '2026-05-21.babel-o.v1'

function seedTraceEvents(dbPath: string, sessionId: string): void {
  mkdirSync(join(dbPath, '..'), { recursive: true })
  const db = new DatabaseSync(dbPath)
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        event_key TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        event_type TEXT,
        event_json TEXT,
        event_seq INTEGER
      );
    `)
    const events = [
      { type: 'session_started', timestamp: '2026-06-17T10:00:00.000Z', cwd: '/repo', requestId: 'req-1', model: 'm' },
      { type: 'permission_request', timestamp: '2026-06-17T10:00:01.000Z', toolUseId: 'tu-1', name: 'Edit', input: {}, risk: 'write' },
      { type: 'permission_response', timestamp: '2026-06-17T10:00:02.000Z', toolUseId: 'tu-1', approved: true, scope: 'once' },
      { type: 'tool_started', timestamp: '2026-06-17T10:00:03.000Z', toolUseId: 'tu-1', name: 'Edit', input: { path: '/repo/a.ts' } },
      { type: 'tool_completed', timestamp: '2026-06-17T10:00:04.000Z', toolUseId: 'tu-1', name: 'Edit', success: true, output: 'ok' },
      { type: 'result', timestamp: '2026-06-17T10:00:05.000Z', success: true, message: 'done' },
    ].map(e => ({ schemaVersion: TRACE_SCHEMA_VERSION, sessionId, ...e }))
    let i = 0
    for (const event of events) {
      db.prepare(
        `INSERT OR REPLACE INTO events (event_key, session_id, timestamp, event_type, event_json, event_seq)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(`evt_${i}`, sessionId, event.timestamp, event.type, JSON.stringify(event), i)
      i += 1
    }
  } finally {
    try { db.close() } catch { /* ignore */ }
  }
}

test('exportSessionTrace: projects a persisted event stream into a reconstructable trace', () => {
  withTempConfigDir((configDir) => {
    const dbPath = join(configDir, 'db.sqlite')
    const sessionId = 'session_trace-uuid'
    seedTraceEvents(dbPath, sessionId)
    const trace = exportSessionTrace(sessionId, { sqlitePath: dbPath })
    assert.ok(trace, 'trace should be projected from persisted events')
    if (!trace) return
    assert.equal(trace.runSpanId, 'run')
    assert.equal(trace.spanCountByKind.run, 1)
    assert.equal(trace.spanCountByKind.tool_call, 1)
    assert.equal(trace.spanCountByKind.permission_decision, 1)
    assert.equal(trace.spanCountByKind.final_result, 1)
    // Run span is first.
    assert.equal(trace.spans[0]!.kind, 'run')
    // permission_decision parents to the tool_call via shared toolUseId.
    const perm = trace.spans.find(s => s.kind === 'permission_decision')!
    assert.equal(perm.parentSpanId, 'tool:tu-1')
  })
})

test('exportSessionTrace: returns null when the session has no events', () => {
  withTempConfigDir((configDir) => {
    const dbPath = join(configDir, 'db.sqlite')
    seedSqliteWithSession(dbPath, 'session_empty-uuid', { withEvents: false })
    const trace = exportSessionTrace('session_empty-uuid', { sqlitePath: dbPath })
    assert.equal(trace, null)
  })
})

test('exportSessionTrace: returns null when the SQLite file is absent', () => {
  withTempConfigDir((configDir) => {
    const trace = exportSessionTrace('session_ghost-uuid', {
      sqlitePath: join(configDir, 'no-such.sqlite'),
    })
    assert.equal(trace, null)
  })
})

// Phase B of docs/nexus/reference/context-cwd-drift-and-recall-governance-plan.md:
// the new `session_root_continuity` event must surface on the run span
// of the projected AgentTrace so `bbl inspect-session <id> --trace`
// can show the operator the decision + reason. Regression guard for
// session_cf361f04-7ab1-43a5-907a-41a808942686 (iCloud article paste
// drift) and session_981cc5c2-230c-40d1-953c-b956e9dbaaf7 (CJK prose
// drift).
test('exportSessionTrace: session_root_continuity decision is surfaced on the run span (cf361f04 regression)', () => {
  withTempConfigDir((configDir) => {
    const dbPath = join(configDir, 'db.sqlite')
    const sessionId = 'session_cf361f04-7ab1-43a5-907a-41a808942686'
    mkdirSync(join(dbPath, '..'), { recursive: true })
    const db = new DatabaseSync(dbPath)
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS events (
          event_key TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          timestamp TEXT NOT NULL,
          event_type TEXT,
          event_json TEXT,
          event_seq INTEGER
        );
      `)
      const events = [
        { type: 'session_started', timestamp: '2026-06-17T10:00:00.000Z', cwd: '/repo', requestId: 'req-1' },
        {
          type: 'session_root_continuity',
          timestamp: '2026-06-17T10:00:00.500Z',
          requestCwd: '/repo',
          storedSessionCwd: '/repo',
          promptPathCandidates: [],
          resolvedCwd: '/repo',
          decision: 'keep_request_cwd',
          reason: 'url_excluded',
          isExternalRoot: false,
          wasProjectRootKept: true,
          warnings: [],
          message: 'Session cwd kept at request cwd /repo (reason: url_excluded).',
        },
        { type: 'result', timestamp: '2026-06-17T10:00:05.000Z', success: true, message: 'done' },
      ].map(e => ({ schemaVersion: TRACE_SCHEMA_VERSION, sessionId, ...e }))
      let i = 0
      for (const event of events) {
        db.prepare(
          `INSERT OR REPLACE INTO events (event_key, session_id, timestamp, event_type, event_json, event_seq)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(`evt_${i}`, sessionId, event.timestamp, event.type, JSON.stringify(event), i)
        i += 1
      }
    } finally {
      try { db.close() } catch { /* ignore */ }
    }
    const trace = exportSessionTrace(sessionId, { sqlitePath: dbPath })
    assert.ok(trace, 'trace should be projected from persisted events')
    if (!trace) return
    const runSpan = trace.spans.find(s => s.kind === 'run')
    assert.ok(runSpan, 'run span must exist')
    if (!runSpan) return
    // Phase B: the continuity event's decision + reason must be on the
    // run span's attributes (cf361f04: URL-heavy prompt → url_excluded
    // → keep_request_cwd). This is the same surface the operator sees
    // via `bbl inspect-session <id> --trace`.
    assert.equal(runSpan.attributes.lastContinuityDecision, 'keep_request_cwd')
    assert.equal(runSpan.attributes.lastContinuityReason, 'url_excluded')
    assert.equal(runSpan.attributes.lastContinuityResolvedCwd, '/repo')
    assert.equal(runSpan.attributes.lastContinuityWasProjectRootKept, true)
    assert.equal(runSpan.attributes.lastContinuityIsExternalRoot, false)
    assert.match(
      String(runSpan.attributes.lastContinuityMessage ?? ''),
      /url_excluded/,
    )
  })
})

// ---------------------------------------------------------------------------
// §3.3 Durable Run Checkpoint / Resume integration tests
//
// Coverage:
//   1. waiting_permission: run parked on an unresolved permission_request
//      (registry ID supplied → state is `waiting_permission`).
//   2. terminal success: a `result` event with `success: true` short-circuits
//      to `cannot_resume` with boundary=null.
//   3. terminal error: a `result` event with `success: false` short-circuits
//      to `terminal_failed_recoverable` at `before_final_result`.
//   4. non-terminal mid-run: a session_started + a single tool_completed but
//      no result/error and no permission_request → locateLastBoundary gives
//      `after_tool_result`; without a continuation snapshot the state is
//      `cannot_resume` at that boundary.
//   5. absent session: empty SQLite (no row, no events) returns null.
// ---------------------------------------------------------------------------

interface ResumeSessionRow {
  phase: 'executing' | 'completed' | 'failed' | 'cancelled' | 'waiting_permission' | 'created' | 'planning' | 'reviewing' | 'waiting_user'
  terminalReason?: string
  error?: string | null
}

function seedResumeEvents(
  dbPath: string,
  sessionId: string,
  events: Array<{ type: string; [k: string]: unknown }>,
  sessionRow?: ResumeSessionRow,
): void {
  mkdirSync(join(dbPath, '..'), { recursive: true })
  const db = new DatabaseSync(dbPath)
  try {
    if (sessionRow) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
          session_id TEXT PRIMARY KEY,
          cwd TEXT NOT NULL,
          prompt TEXT NOT NULL,
          phase TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          result TEXT,
          error TEXT,
          terminal_reason TEXT,
          metadata TEXT
        );
      `)
      db.prepare(
        `INSERT OR REPLACE INTO sessions
          (session_id, cwd, prompt, phase, created_at, updated_at, result, error, terminal_reason, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        sessionId,
        '/Users/tangyaoyue/DEV',
        'test prompt',
        sessionRow.phase,
        '2026-06-18T00:00:00.000Z',
        '2026-06-18T00:00:05.000Z',
        null,
        sessionRow.error ?? null,
        sessionRow.terminalReason ??
          (sessionRow.phase === 'failed'
            ? JSON.stringify({ category: 'runtime', code: 'test_failure', message: 'simulated failure' })
            : null),
        null,
      )
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        event_key TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        event_type TEXT,
        event_json TEXT,
        event_seq INTEGER
      );
    `)
    let i = 0
    for (const event of events) {
      const full = { schemaVersion: TRACE_SCHEMA_VERSION, sessionId, ...event }
      const ts = (event.timestamp as string | undefined) ?? `2026-06-18T00:00:0${i}.000Z`
      db.prepare(
        `INSERT OR REPLACE INTO events (event_key, session_id, timestamp, event_type, event_json, event_seq)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(`evt_resume_${i}`, sessionId, ts, event.type, JSON.stringify(full), i)
      i += 1
    }
  } finally {
    try { db.close() } catch { /* ignore */ }
  }
}

test('exportSessionResumeState: waiting_permission — unresolved permission_request + registry id', () => {
  withTempConfigDir((configDir) => {
    const dbPath = join(configDir, 'db.sqlite')
    const sessionId = 'session_resume-waiting-uuid'
    seedResumeEvents(
      dbPath,
      sessionId,
      [
        { type: 'session_started', timestamp: '2026-06-18T00:00:00.000Z', cwd: '/repo', requestId: 'req-1', model: 'm' },
        { type: 'tool_started', timestamp: '2026-06-18T00:00:01.000Z', toolUseId: 'tu-1', name: 'Edit', input: { path: '/repo/a.ts' } },
        { type: 'permission_request', timestamp: '2026-06-18T00:00:02.000Z', toolUseId: 'tu-1', name: 'Edit', input: { path: '/repo/a.ts' }, risk: 'write' },
      ],
      { phase: 'waiting_permission' },
    )
    const state = exportSessionResumeState(sessionId, {
      sqlitePath: dbPath,
      pendingPermissionToolUseId: 'tu-1',
    })
    assert.ok(state, 'resume state should be derived from persisted events')
    if (!state) return
    assert.equal(state.state.state, 'waiting_permission')
    assert.equal(state.state.boundary, 'waiting_permission')
    assert.equal(state.pendingPermissionToolUseId, 'tu-1')
    assert.equal(state.hasContinuationSnapshot, false)
    // No warnings: the live registry corroborated the pending entry.
    assert.deepEqual(state.warnings, [])
  })
})

test('exportSessionResumeState: terminal success result → cannot_resume at null boundary', () => {
  withTempConfigDir((configDir) => {
    const dbPath = join(configDir, 'db.sqlite')
    const sessionId = 'session_resume-success-uuid'
    seedResumeEvents(
      dbPath,
      sessionId,
      [
        { type: 'session_started', timestamp: '2026-06-18T00:00:00.000Z', cwd: '/repo', requestId: 'req-1', model: 'm' },
        { type: 'result', timestamp: '2026-06-18T00:00:01.000Z', success: true, message: 'done' },
      ],
      { phase: 'completed' },
    )
    const state = exportSessionResumeState(sessionId, { sqlitePath: dbPath })
    assert.ok(state)
    if (!state) return
    assert.equal(state.state.state, 'cannot_resume')
    assert.equal(state.state.boundary, null)
    assert.match(state.state.reason, /run completed successfully/)
    // No pending permission and no continuation snapshot.
    assert.equal(state.pendingPermissionToolUseId, null)
    assert.equal(state.hasContinuationSnapshot, false)
  })
})

test('exportSessionResumeState: terminal error result → terminal_failed_recoverable at before_final_result', () => {
  withTempConfigDir((configDir) => {
    const dbPath = join(configDir, 'db.sqlite')
    const sessionId = 'session_resume-failed-uuid'
    seedResumeEvents(
      dbPath,
      sessionId,
      [
        { type: 'session_started', timestamp: '2026-06-18T00:00:00.000Z', cwd: '/repo', requestId: 'req-1', model: 'm' },
        { type: 'result', timestamp: '2026-06-18T00:00:01.000Z', success: false, message: 'tool execution failed' },
      ],
      { phase: 'failed', error: 'tool execution failed' },
    )
    const state = exportSessionResumeState(sessionId, { sqlitePath: dbPath })
    assert.ok(state)
    if (!state) return
    assert.equal(state.state.state, 'terminal_failed_recoverable')
    assert.equal(state.state.boundary, 'before_final_result')
    assert.match(state.state.reason, /run ended with a failed result event/)
  })
})

test('exportSessionResumeState: non-terminal mid-run (after_tool_result) without snapshot → cannot_resume', () => {
  withTempConfigDir((configDir) => {
    const dbPath = join(configDir, 'db.sqlite')
    const sessionId = 'session_resume-mid-uuid'
    seedResumeEvents(
      dbPath,
      sessionId,
      [
        { type: 'session_started', timestamp: '2026-06-18T00:00:00.000Z', cwd: '/repo', requestId: 'req-1', model: 'm' },
        { type: 'tool_started', timestamp: '2026-06-18T00:00:01.000Z', toolUseId: 'tu-1', name: 'Read', input: { path: '/repo/a.ts' } },
        { type: 'tool_completed', timestamp: '2026-06-18T00:00:02.000Z', toolUseId: 'tu-1', name: 'Read', success: true, output: 'file contents' },
      ],
      { phase: 'executing' },
    )
    const state = exportSessionResumeState(sessionId, { sqlitePath: dbPath })
    assert.ok(state)
    if (!state) return
    assert.equal(state.state.state, 'cannot_resume')
    assert.equal(state.state.boundary, 'after_tool_result')
    assert.match(state.state.reason, /process-local and was not persisted/)
    assert.equal(state.hasContinuationSnapshot, false)
  })
})

test('exportSessionResumeState: absent session (no events, no row) returns null', () => {
  withTempConfigDir((configDir) => {
    const dbPath = join(configDir, 'db.sqlite')
    // Seed an unrelated session row, but never reference it.
    seedSqliteWithSession(dbPath, 'session_other-uuid', { withEvents: false })
    const state = exportSessionResumeState('session_ghost-uuid', { sqlitePath: dbPath })
    assert.equal(state, null)
  })
})

test('formatResumeState: renders the §3.3 state with boundary, reason, warnings, and next-action hint', () => {
  withTempConfigDir((configDir) => {
    const dbPath = join(configDir, 'db.sqlite')
    const sessionId = 'session_resume-format-uuid'
    seedResumeEvents(
      dbPath,
      sessionId,
      [
        { type: 'session_started', timestamp: '2026-06-18T00:00:00.000Z', cwd: '/repo', requestId: 'req-1', model: 'm' },
        { type: 'tool_started', timestamp: '2026-06-18T00:00:01.000Z', toolUseId: 'tu-9', name: 'Bash', input: { cmd: 'rm -rf /' }, risk: 'exec' },
      ],
      { phase: 'executing' },
    )
    const state = exportSessionResumeState(sessionId, { sqlitePath: dbPath })
    assert.ok(state)
    if (!state) return
    const text = formatResumeState(sessionId, state)
    assert.match(text, /cannot_resume/)
    assert.match(text, /session_id : session_resume-format-uuid/)
    // locateLastBoundary on a stream ending with a bare tool_started
    // (no completion, no permission_request) returns before_tool_execution
    // + emits the orphan tool_started warning.
    assert.match(text, /boundary   : before_tool_execution/)
    assert.match(text, /orphan tool_started/)
    assert.match(text, /note: derived without a continuation snapshot/)
  })
})
