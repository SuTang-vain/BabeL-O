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
  options: { withEvents?: boolean; eventCount?: number } = {},
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
        error TEXT
      );
    `)
    db.prepare(
      `INSERT OR REPLACE INTO sessions
        (session_id, cwd, prompt, phase, created_at, updated_at, result, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      sessionId,
      '/Users/tangyaoyue/DEV',
      'git status',
      'completed',
      '2026-06-11T02:52:39.000Z',
      '2026-06-11T02:53:01.000Z',
      'On branch main',
      null,
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
