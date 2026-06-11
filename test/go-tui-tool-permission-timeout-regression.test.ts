import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/**
 * Regression guard for
 * docs/nexus/reference/go-tui-tool-permission-timeout-optimization-plan.md.
 *
 * Real sample: session_dcf7e34e-bc59-41e4-b802-e4d03d32b48d.
 * The important diagnosis is NOT "tool failure" or "permission denied":
 * all tools succeeded and all Bash permissions were approved; the session
 * failed because long-context provider time + repeated read-only Bash
 * approval waits pushed the turn into the 180s request timeout.
 *
 * Hard invariant: this fixture is synthetic and temp-dir backed; it never
 * reads from or writes to the user's real ~/.babel-o/db.sqlite.
 */

const SESSION_ID = 'session_dcf7e34e-bc59-41e4-b802-e4d03d32b48d'

type RegressionSummary = {
  phase: string
  result: string | null
  error: string | null
  eventCount: number
  toolCount: number
  failedToolCount: number
  bashToolCount: number
  permissionRequests: number
  permissionResponses: number
  approvedAudits: number
  deniedAudits: number
  timeoutErrors: number
  executeOutcome: string | null
  nearTimeout: boolean
  timeoutMs: number | null
  executeDurationMs: number | null
  approvalWaitSeconds: number
}

function withTempDb<T>(fn: (dbPath: string) => T): T {
  const tempDir = mkdtempSync(join(tmpdir(), 'babel-o-go-tui-timeout-regression-'))
  try {
    return fn(join(tempDir, 'db.sqlite'))
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

function seedDcf7RegressionFixture(dbPath: string): void {
  const db = new DatabaseSync(dbPath)
  try {
    db.exec(`
      CREATE TABLE sessions (
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
      CREATE TABLE events (
        event_key TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        event_type TEXT NOT NULL,
        event_json TEXT NOT NULL
      );
      CREATE TABLE tool_traces (
        tool_use_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        name TEXT NOT NULL,
        input TEXT NOT NULL,
        output TEXT,
        success INTEGER,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        duration_ms INTEGER,
        remote_runner TEXT
      );
      CREATE TABLE permission_audits (
        audit_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        tool_use_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        tool_risk TEXT NOT NULL,
        tool_input TEXT NOT NULL,
        decision TEXT NOT NULL,
        reason TEXT,
        timestamp TEXT NOT NULL
      );
    `)

    db.prepare(`INSERT INTO sessions
      (session_id, cwd, prompt, phase, created_at, updated_at, result, error, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        SESSION_ID,
        '/Users/tangyaoyue',
        '',
        'failed',
        '2026-06-11T07:35:22.907Z',
        '2026-06-11T07:38:22.894Z',
        'This operation was aborted',
        'This operation was aborted',
        JSON.stringify({ client: 'go-tui', phase: 'session_allocate' }),
      )

    appendEvent(db, 1, 'user_message', '2026-06-11T07:35:22.910Z', {
      text: '查看并分析go tui状态机',
    })
    appendEvent(db, 2, 'session_started', '2026-06-11T07:35:22.914Z', {
      cwd: '/Users/tangyaoyue',
      requestId: 'req_a031270e-9367-4dfb-b521-ab2468d61415',
    })

    const tools: Array<{ id: string; name: string; command?: string; path?: string; durationMs: number }> = [
      { id: 'list-1', name: 'ListDir', path: '/Users/tangyaoyue/DEV/BABEL/BabeL-O/clients/go-tui', durationMs: 3 },
      { id: 'read-1', name: 'Read', path: '/Users/tangyaoyue/DEV/BABEL/BabeL-O/clients/go-tui/internal/tui/tui.go', durationMs: 12 },
      { id: 'grep-1', name: 'Grep', path: '/Users/tangyaoyue/DEV/BABEL/BabeL-O/clients/go-tui/internal/tui/tui.go', durationMs: 31 },
      { id: 'bash-1', name: 'Bash', command: "sed -n '2200,2650p' /Users/tangyaoyue/DEV/BABEL/BabeL-O/clients/go-tui/internal/tui/tui.go | head -c 30000", durationMs: 2012 },
      { id: 'bash-2', name: 'Bash', command: 'grep -n "permission_request\\|streamEvent" /Users/tangyaoyue/DEV/BABEL/BabeL-O/clients/go-tui/internal/tui/tui.go | head -80', durationMs: 2965 },
      { id: 'bash-3', name: 'Bash', command: "sed -n '5820,6000p' /Users/tangyaoyue/DEV/BABEL/BabeL-O/clients/go-tui/internal/tui/tui.go", durationMs: 18084 },
    ]

    for (const [index, tool] of tools.entries()) {
      const startedAt = `2026-06-11T07:36:${(30 + index).toString().padStart(2, '0')}.000Z`
      const completedAt = `2026-06-11T07:36:${(31 + index).toString().padStart(2, '0')}.000Z`
      const input = tool.name === 'Bash'
        ? { command: tool.command, timeoutMs: 10_000 }
        : { path: tool.path }
      db.prepare(`INSERT INTO tool_traces
        (tool_use_id, session_id, name, input, output, success, started_at, completed_at, duration_ms, remote_runner)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(tool.id, SESSION_ID, tool.name, JSON.stringify(input), 'ok', 1, startedAt, completedAt, tool.durationMs, null)

      appendEvent(db, 10 + index * 2, 'tool_started', startedAt, {
        toolUseId: tool.id,
        name: tool.name,
        input,
      })
      appendEvent(db, 11 + index * 2, 'tool_completed', completedAt, {
        toolUseId: tool.id,
        name: tool.name,
        success: true,
        output: 'ok',
      })
    }

    const approvalWaitsMs = [1917, 2873, 17_998]
    for (let i = 0; i < 3; i += 1) {
      const toolUseId = `bash-${i + 1}`
      const reqTs = `2026-06-11T07:37:0${i}.000Z`
      const respTs = new Date(Date.parse(reqTs) + approvalWaitsMs[i]).toISOString()
      appendEvent(db, 50 + i * 2, 'permission_request', reqTs, {
        toolUseId,
        name: 'Bash',
        risk: 'execute',
        input: { command: tools[3 + i].command, timeoutMs: 10_000 },
        message: 'Tool Bash requires user permission to run. Reason: Shell operators require manual review',
      })
      appendEvent(db, 51 + i * 2, 'permission_response', respTs, {
        toolUseId,
        approved: true,
        reason: 'Approved from Go TUI',
      })
      db.prepare(`INSERT INTO permission_audits
        (audit_id, session_id, tool_use_id, tool_name, tool_risk, tool_input, decision, reason, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          `audit-${i + 1}`,
          SESSION_ID,
          toolUseId,
          'Bash',
          'execute',
          JSON.stringify({ command: tools[3 + i].command, timeoutMs: 10_000 }),
          'approved',
          'Approved from Go TUI',
          respTs,
        )
    }

    appendEvent(db, 90, 'error', '2026-06-11T07:38:22.891Z', {
      code: 'REQUEST_TIMEOUT',
      message: 'This operation was aborted',
    })
    appendEvent(db, 91, 'result', '2026-06-11T07:38:22.892Z', {
      success: false,
      message: 'This operation was aborted',
    })
    appendEvent(db, 92, 'execution_metrics', '2026-06-11T07:38:22.893Z', {
      requestId: 'req_a031270e-9367-4dfb-b521-ab2468d61415',
      executeDurationMs: 180005.10445900005,
      providerRequestDurationMs: 125411.67641700001,
      toolCallCount: 19,
      inputTokens: 149378,
      outputTokens: 1799,
    })
    appendEvent(db, 93, 'execute_summary', '2026-06-11T07:38:22.894Z', {
      requestId: 'req_a031270e-9367-4dfb-b521-ab2468d61415',
      timeoutMs: 180000,
      executeDurationMs: 180011,
      nearTimeout: true,
      outcome: 'timeout',
    })
  } finally {
    db.close()
  }
}

function appendEvent(
  db: DatabaseSync,
  index: number,
  eventType: string,
  timestamp: string,
  payload: Record<string, unknown>,
): void {
  const event = {
    type: eventType,
    schemaVersion: '2026-05-21.babel-o.v1',
    sessionId: SESSION_ID,
    timestamp,
    ...payload,
  }
  db.prepare(`INSERT INTO events (event_key, session_id, timestamp, event_type, event_json) VALUES (?, ?, ?, ?, ?)`)
    .run(`${SESSION_ID}:${index.toString().padStart(3, '0')}:${eventType}`, SESSION_ID, timestamp, eventType, JSON.stringify(event))
}

function summarizeRegressionSession(dbPath: string): RegressionSummary {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const row = db.prepare(`SELECT phase, result, error FROM sessions WHERE session_id = ?`).get(SESSION_ID) as {
      phase: string
      result: string | null
      error: string | null
    }
    const eventCounts = db.prepare(`
      SELECT
        COUNT(*) AS eventCount,
        SUM(CASE WHEN event_type = 'permission_request' THEN 1 ELSE 0 END) AS permissionRequests,
        SUM(CASE WHEN event_type = 'permission_response' THEN 1 ELSE 0 END) AS permissionResponses,
        SUM(CASE WHEN event_type = 'error' AND json_extract(event_json, '$.code') = 'REQUEST_TIMEOUT' THEN 1 ELSE 0 END) AS timeoutErrors
      FROM events WHERE session_id = ?
    `).get(SESSION_ID) as {
      eventCount: number
      permissionRequests: number
      permissionResponses: number
      timeoutErrors: number
    }
    const toolCounts = db.prepare(`
      SELECT
        COUNT(*) AS toolCount,
        SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS failedToolCount,
        SUM(CASE WHEN name = 'Bash' THEN 1 ELSE 0 END) AS bashToolCount
      FROM tool_traces WHERE session_id = ?
    `).get(SESSION_ID) as { toolCount: number; failedToolCount: number; bashToolCount: number }
    const auditCounts = db.prepare(`
      SELECT
        SUM(CASE WHEN decision = 'approved' THEN 1 ELSE 0 END) AS approvedAudits,
        SUM(CASE WHEN decision = 'denied' THEN 1 ELSE 0 END) AS deniedAudits
      FROM permission_audits WHERE session_id = ?
    `).get(SESSION_ID) as { approvedAudits: number; deniedAudits: number }
    const summary = db.prepare(`
      SELECT
        json_extract(event_json, '$.outcome') AS executeOutcome,
        json_extract(event_json, '$.nearTimeout') AS nearTimeout,
        json_extract(event_json, '$.timeoutMs') AS timeoutMs,
        json_extract(event_json, '$.executeDurationMs') AS executeDurationMs
      FROM events
      WHERE session_id = ? AND event_type = 'execute_summary'
      ORDER BY timestamp DESC
      LIMIT 1
    `).get(SESSION_ID) as {
      executeOutcome: string | null
      nearTimeout: number | null
      timeoutMs: number | null
      executeDurationMs: number | null
    }
    const wait = db.prepare(`
      WITH req AS (
        SELECT json_extract(event_json, '$.toolUseId') AS id, timestamp AS reqTs
        FROM events WHERE session_id = ? AND event_type = 'permission_request'
      ), resp AS (
        SELECT json_extract(event_json, '$.toolUseId') AS id, timestamp AS respTs
        FROM events WHERE session_id = ? AND event_type = 'permission_response'
      )
      SELECT SUM((julianday(resp.respTs) - julianday(req.reqTs)) * 86400) AS seconds
      FROM req JOIN resp USING(id)
    `).get(SESSION_ID, SESSION_ID) as { seconds: number | null }

    return {
      ...row,
      eventCount: eventCounts.eventCount,
      permissionRequests: eventCounts.permissionRequests,
      permissionResponses: eventCounts.permissionResponses,
      timeoutErrors: eventCounts.timeoutErrors,
      toolCount: toolCounts.toolCount,
      failedToolCount: toolCounts.failedToolCount,
      bashToolCount: toolCounts.bashToolCount,
      approvedAudits: auditCounts.approvedAudits,
      deniedAudits: auditCounts.deniedAudits,
      executeOutcome: summary.executeOutcome,
      nearTimeout: summary.nearTimeout === 1,
      timeoutMs: summary.timeoutMs,
      executeDurationMs: summary.executeDurationMs,
      approvalWaitSeconds: Number((wait.seconds ?? 0).toFixed(3)),
    }
  } finally {
    db.close()
  }
}

test('Go TUI tool/permission/timeout regression: dcf7 failed by request timeout, not tool or permission failure', () => {
  withTempDb((dbPath) => {
    seedDcf7RegressionFixture(dbPath)
    const summary = summarizeRegressionSession(dbPath)

    assert.equal(summary.phase, 'failed')
    assert.equal(summary.result, 'This operation was aborted')
    assert.equal(summary.error, 'This operation was aborted')
    assert.equal(summary.executeOutcome, 'timeout')
    assert.equal(summary.timeoutErrors, 1)
    assert.equal(summary.nearTimeout, true)
    assert.equal(summary.timeoutMs, 180000)
    assert.equal(summary.executeDurationMs, 180011)

    assert.equal(summary.toolCount, 6)
    assert.equal(summary.failedToolCount, 0, 'all tool traces should succeed in this regression shape')
    assert.equal(summary.bashToolCount, 3, 'read-only source inspection went through Bash')

    assert.equal(summary.permissionRequests, 3)
    assert.equal(summary.permissionResponses, 3)
    assert.equal(summary.approvedAudits, 3)
    assert.equal(summary.deniedAudits, 0, 'permission mechanism approved every Bash request')
    assert.ok(summary.approvalWaitSeconds > 20, `expected approval waits to be material, got ${summary.approvalWaitSeconds}s`)
  })
})
