import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  formatResumeState,
  exportSessionResumeState,
} from '../src/cli/commands/inspectSession.js'
import { createNexusApp } from '../src/nexus/app.js'
import { createDefaultNexusRuntime } from '../src/nexus/createRuntime.js'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * §3.3 slice 3 of
 * `docs/nexus/reference/agent-runtime-architecture-maturity-plan.md`:
 * `bbl inspect-session <id> --resume` wires
 * `deriveResumableState` into the operator-facing CLI.
 *
 * The two halves being tested here:
 *  1. `formatResumeState` — human-readable rendering with state
 *     colour, boundary, reason, warnings, and an honest "next"
 *     hint. This is the answer to "where did this run stop and
 *     what next".
 *  2. `exportSessionResumeState` — open the local SQLite via
 *     `node:sqlite` readOnly, read session row + ordered events,
 *     call the pure projector. Confirms the CLI path is wired
 *     through the same pure function the unit tests already
 *     cover.
 *
 * Hard invariants (per memory `babel-o-test-config-isolation.md`):
 *  - Tests use mkdtemp + per-test storagePath; the real
 *    `~/.babel-o/config.json` is never touched.
 *  - `node:sqlite` is opened with `readOnly: true`; the CLI must
 *    never write to the running Nexus's database.
 */

function withTempNexus<T>(fn: (ctx: { app: Awaited<ReturnType<typeof createNexusApp>>; storage: any; storagePath: string; tempDir: string }) => Promise<T>): Promise<T> {
  const prevConfigFile = process.env.BABEL_O_CONFIG_FILE
  const prevConfigDir = process.env.BABEL_O_CONFIG_DIR
  const tempDir = mkdtempSync(join(tmpdir(), 'babel-o-section33-slice3-'))
  const storagePath = join(tempDir, 'db.sqlite')
  process.env.BABEL_O_CONFIG_DIR = tempDir
  delete process.env.BABEL_O_CONFIG_FILE
  return (async () => {
    const cwd = join(tempDir, 'workspace')
    const { runtime, storage } = await createDefaultNexusRuntime({ storagePath, cwd })
    const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })
    try {
      return await fn({ app, storage, storagePath, tempDir })
    } finally {
      try { await app.close() } catch { /* ignore */ }
      if (prevConfigFile === undefined) delete process.env.BABEL_O_CONFIG_FILE
      else process.env.BABEL_O_CONFIG_FILE = prevConfigFile
      if (prevConfigDir === undefined) delete process.env.BABEL_O_CONFIG_DIR
      else process.env.BABEL_O_CONFIG_DIR = prevConfigDir
      try { rmSync(tempDir, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  })()
}

describe('formatResumeState: human-readable rendering', () => {
  test('renders all five state-specific fields for resume_possible', () => {
    const out = formatResumeState('session_test', {
      state: { state: 'resume_possible', boundary: 'after_provider_invocation', reason: 'mid-flight, OK to resume' },
      hasContinuationSnapshot: true,
      pendingPermissionToolUseId: null,
      warnings: [],
    })
    assert.match(out, /▶ resume_possible/)
    assert.match(out, /session_id : session_test/)
    assert.match(out, /boundary   : after_provider_invocation/)
    assert.match(out, /reason     : mid-flight, OK to resume/)
    assert.match(out, /continuation_snapshot: true/)
    assert.match(out, /next: resume from this boundary in the live process/)
    // No "note" line when continuation snapshot exists.
    assert.doesNotMatch(out, /note: derived without a continuation snapshot/)
  })

  test('renders waiting_permission with toolUseId + pending_permission field', () => {
    const out = formatResumeState('session_test', {
      state: { state: 'waiting_permission', boundary: 'waiting_permission', reason: 'parked', toolUseId: 'tu-9' },
      hasContinuationSnapshot: false,
      pendingPermissionToolUseId: 'tu-9',
      warnings: [],
    })
    assert.match(out, /▶ waiting_permission/)
    assert.match(out, /tool_use_id: tu-9/)
    assert.match(out, /pending_permission   : tu-9/)
    // No continuation snapshot → re-issue hint, not approve/deny.
    assert.match(out, /re-issue the approval/)
  })

  test('renders warnings block when projector emits any', () => {
    const out = formatResumeState('session_test', {
      state: { state: 'cannot_resume', boundary: 'after_tool_result', reason: 'tool result persisted, continuation gone' },
      hasContinuationSnapshot: false,
      pendingPermissionToolUseId: null,
      warnings: ['orphan tool_started (toolUseId=tu-7, name=Edit)'],
    })
    assert.match(out, /▶ cannot_resume/)
    assert.match(out, /warnings:/)
    assert.match(out, /- orphan tool_started \(toolUseId=tu-7, name=Edit\)/)
    assert.match(out, /note: derived without a continuation snapshot/)
  })

  test('renders the four other next-action hints distinctly', () => {
    const baseFields = { hasContinuationSnapshot: false, pendingPermissionToolUseId: null, warnings: [] }
    const retry = formatResumeState('s', { ...baseFields, state: { state: 'retry_from_provider_turn', boundary: 'before_tool_execution', reason: 'r' } })
    assert.match(retry, /next: retry from the provider turn/)
    const failed = formatResumeState('s', { ...baseFields, state: { state: 'terminal_failed_recoverable', boundary: 'before_final_result', reason: 'f' } })
    assert.match(failed, /next: re-run the prompt; the run ended with a failed terminal event/)
    const cannot = formatResumeState('s', { ...baseFields, state: { state: 'cannot_resume', boundary: null, reason: 'c' } })
    assert.match(cannot, /next: cannot resume — re-run the prompt to start a fresh continuation/)
  })
})

describe('exportSessionResumeState: CLI wiring', () => {
  test('returns null only when the sqlite path itself is missing (no DB at all)', async () => {
    // The CLI's contract: return `null` only when the local SQLite does
    // not exist (e.g. embedded Nexus never ran in this storage). When
    // the DB exists but a specific session has no events, the
    // projector still emits a `cannot_resume` state — that's the
    // honest answer to "is there a recoverable run here?". The CLI
    // action handler maps `null` to a red error and a non-zero exit.
    const nonexistentPath = '/tmp/babel-o-no-such-sqlite-xyz.sqlite'
    const out = exportSessionResumeState('session_anything', { sqlitePath: nonexistentPath })
    assert.equal(out, null)
  })

  test('returns a derived state for a real session with events', async () => {
    await withTempNexus(async ({ app, storage, storagePath }) => {
      const res = await app.inject({ method: 'POST', url: '/v1/sessions', payload: { cwd: '/repo' } })
      assert.equal(res.statusCode, 201)
      const sessionId = res.json().sessionId
      // Persist a small event stream that lands in `cannot_resume` at
      // a provider boundary (we never supply a continuation snapshot,
      // which is the CLI's default — see the honesty note in
      // `formatResumeState`).
      const t0 = new Date().toISOString()
      await storage.appendEvent(sessionId, {
        schemaVersion: 1,
        sessionId,
        type: 'session_started',
        timestamp: t0,
        cwd: '/repo',
      } as any)
      await storage.appendEvent(sessionId, {
        schemaVersion: 1,
        sessionId,
        type: 'assistant_delta',
        timestamp: new Date(Date.parse(t0) + 10).toISOString(),
        text: 'thinking',
      } as any)
      const out = exportSessionResumeState(sessionId, { sqlitePath: storagePath })
      assert.ok(out, 'expected a derived state')
      // The pure projector (run-checkpoint.test.ts) pins the exact
      // matrix; this integration test just confirms the read path
      // opens the per-test sqlite, reads events in order, and runs
      // through the same projector.
      assert.ok(['cannot_resume', 'resume_possible', 'retry_from_provider_turn', 'waiting_permission', 'terminal_failed_recoverable']
        .includes(out.state.state))
    })
  })

  test('storage file at the resolved path is honored (CLI never touches the real config)', async () => {
    await withTempNexus(async ({ storagePath }) => {
      assert.ok(existsSync(storagePath), 'expected the temp sqlite file to exist')
      // Unknown session id — events table exists but has no rows for
      // it. `readOrderedEvents` returns `[]`, the projector emits
      // `cannot_resume` with a "no events persisted" warning. The CLI
      // path goes through the per-test sqlitePath, never touching the
      // user's real config.
      const out = exportSessionResumeState('session_does_not_exist', { sqlitePath: storagePath })
      assert.ok(out, 'expected a derived state for an unknown session id (events table is empty)')
      assert.equal(out.state.state, 'cannot_resume')
      assert.ok(out.warnings.some(w => /no events/.test(w)))
    })
  })
})
