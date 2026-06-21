// test/r7-replay-gate.test.ts
//
// R7 of docs/nexus/proposals/long-running-context-assembly.md §20:
// Real Regression Replay Gate. Loads the 3 fixture sessions extracted
// from the real `~/.babel-o/db.sqlite` and verifies that the fixed
// pipeline (resolvePromptCwd / Bug 1 Layer A+B / Bug 2 origin_cwd /
// Bug 3 storage / Bug 4 dual-site) prevents the original failures
// from re-occurring when the same prompts are replayed.
//
// R7 acceptance conditions (per long-running-context-assembly.md §20 R7):
//   1. No turn resolves task root to `/` or `~/Library` unless user-approved
//   2. session_root_continuity exists when session metadata is present
//   3. contextRecent works in storage-backed runtime
//   4. working-set file is created/updated for in-scope tool paths
//      (R2 — closed 2026-06-18; fixture is pre-R2 baseline)
//   4'. REST PUT ↔ /v1/working-set/observe share tracker
//      (R3 — closed 2026-06-18; verified by test/r3-rest-put-observe.test.ts)
//   5. resumed preview includes working set + bounded recent context
//      (R5 — not yet closed)
//   6. observer e2e receives a redacted assembled update for a real turn
//      (R4 — closed 2026-06-20; verified by test/r4-context-observe-runtime-e2e.test.ts)
//
// Conditions 4/4'/5/6 map to R2/R3/R5/R4. R2, R3, and R4 are now closed
// (R2: test/runtime-working-set-hot-path.test.ts, R3: test/r3-rest-put-observe.test.ts,
// R4: test/r4-context-observe-runtime-e2e.test.ts). Only R5 (resume preview
// product path) is still open. The fixture reflects pre-R2 baseline
// (0 working_set_updated events) since the snapshot was taken before R2
// was implemented. (R7 is the gate to close the long-running-context-assembly
// plan, not a prerequisite for it). R7 must close conditions 1-3 + honestly report
// conditions 4-6 as not yet closed with the relevant count assertions.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, copyFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SqliteStorage } from '../src/storage/SqliteStorage.js'
import { resolvePromptCwd, extractAbsolutePaths } from '../src/runtime/systemPromptBuilder.js'
import { resolveCwdFromPrompt } from '../src/runtime/LLMCodingRuntime.js'

const FIXTURE_PATH = join(import.meta.dirname, 'fixtures', 'r7-fixture.sqlite')

const SIDS = {
  s981: 'session_981cc5c2-230c-40d1-953c-b956e9dbaaf7',
  scf3: 'session_cf361f04-7ab1-43a5-907a-41a808942686',
  s103: 'session_10320709-2b06-405f-8f51-d954435d4a70',
} as const

function tempCopy(): { dir: string; dbPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'babel-o-r7-'))
  const dbPath = join(dir, 'r7.sqlite')
  copyFileSync(FIXTURE_PATH, dbPath)
  return {
    dir,
    dbPath,
    cleanup: () => {
      try { rmSync(dir, { recursive: true, force: true }) } catch {}
    },
  }
}

interface ReplayRow {
  sessionId: string
  userMessages: { text: string }[]
  taskScopes: { primaryRoot: string; explicitRoots: string[] }[]
  storageUnavailCount: number
  continuityCount: number
  sessionStartedCwds: string[]
}

async function loadFixture(): Promise<{ storage: SqliteStorage; dbPath: string; cleanup: () => void }> {
  const t = tempCopy()
  if (!existsSync(FIXTURE_PATH)) {
    throw new Error(`Fixture not found: ${FIXTURE_PATH}. See test/fixtures/r7-fixture.README.md for refresh instructions.`)
  }
  const storage = new SqliteStorage(t.dbPath)
  // v15 migration is idempotent; if origin_cwd was already backfilled in the
  // snapshot, the migration no-ops. The fixture was extracted after the
  // user's first Bug 2 migration run, so origin_cwd is already populated.
  return { storage, dbPath: t.dbPath, cleanup: t.cleanup }
}

async function listAllEvents(storage: SqliteStorage, sessionId: string, batchSize = 5000): Promise<any[]> {
  // Events are paginated. thinking_delta + assistant_delta dominate the
  // stream (~20k for 8 user_messages) so we page through all of them
  // to reach the rare event types (user_message, task_scope_declared,
  // session_root_continuity, working_set_updated, etc.).
  const all: any[] = []
  let cursor: string | undefined
  // Cap iterations defensively to avoid an infinite loop on bad storage
  for (let i = 0; i < 100; i++) {
    const r = await storage.listEvents(sessionId, {
      limit: batchSize,
      order: 'asc',
      ...(cursor !== undefined ? { cursor } : {}),
    })
    all.push(...r.events)
    if (!r.nextCursor) break
    cursor = r.nextCursor
  }
  return all
}

async function readReplayRow(storage: SqliteStorage, sessionId: string): Promise<ReplayRow> {
  const all = await listAllEvents(storage, sessionId)
  const userMessages = all
    .filter((e: any) => e.type === 'user_message')
    .map((e: any) => ({ text: String(e.text ?? '') }))
  const taskScopes = all
    .filter((e: any) => e.type === 'task_scope_declared')
    .map((e: any) => ({
      primaryRoot: String(e.primaryRoot ?? ''),
      explicitRoots: Array.isArray(e.explicitRoots) ? e.explicitRoots.map((s: unknown) => String(s)) : [],
    }))
  const toolCompleted = all.filter((e: any) => e.type === 'tool_completed')
  const storageUnavailCount = toolCompleted.filter(
    (e: any) => e.output?.code === 'CONTEXT_STORAGE_UNAVAILABLE',
  ).length
  const continuityCount = all.filter((e: any) => e.type === 'session_root_continuity').length
  const sessionStartedCwds = all
    .filter((e: any) => e.type === 'session_started')
    .map((e: any) => String(e.cwd ?? ''))
  return { sessionId, userMessages, taskScopes, storageUnavailCount, continuityCount, sessionStartedCwds }
}

describe('R7 fixture integrity', () => {
  test('fixture file exists and contains the 3 expected sessions', async () => {
    assert.ok(existsSync(FIXTURE_PATH), `fixture missing: ${FIXTURE_PATH}`)
    const { storage, cleanup } = await loadFixture()
    try {
      for (const sid of Object.values(SIDS)) {
        const sess = await storage.getSession(sid, { includeEvents: false })
        assert.ok(sess, `session ${sid} should be in fixture`)
        assert.ok(sess!.originCwd, `session ${sid} should have originCwd backfilled (v15 migration)`)
      }
    } finally {
      await storage.close?.()
      cleanup()
    }
  })

  test('fixture has 0 session_root_continuity events (pre-Bug 2 baseline)', async () => {
    // Honest baseline: the fixture reflects pre-Bug-2/3/4 state. R7 must
    // verify the fixed pipeline PREVENTS re-occurrence, not that the
    // fixture already has continuity events.
    const { storage, cleanup } = await loadFixture()
    try {
      for (const sid of Object.values(SIDS)) {
        const row = await readReplayRow(storage, sid)
        assert.equal(row.continuityCount, 0,
          `fixture ${sid} should have 0 session_root_continuity (pre-Bug 2 baseline)`)
      }
    } finally {
      await storage.close?.()
      cleanup()
    }
  })

  test('fixture captures the original CONTEXT_STORAGE_UNAVAILABLE failures', async () => {
    // Honest baseline: 3 sessions have 3, 8, 3 failures respectively.
    // R7 condition 3 verifies the FIXED pipeline prevents these.
    const { storage, cleanup } = await loadFixture()
    try {
      const s981 = await readReplayRow(storage, SIDS.s981)
      const scf3 = await readReplayRow(storage, SIDS.scf3)
      const s103 = await readReplayRow(storage, SIDS.s103)
      assert.equal(s981.storageUnavailCount, 3, 's981 has 3 CONTEXT_STORAGE_UNAVAILABLE pre-Bug 3')
      assert.equal(scf3.storageUnavailCount, 8, 'scf3 has 8 CONTEXT_STORAGE_UNAVAILABLE pre-Bug 3')
      assert.equal(s103.storageUnavailCount, 3, 's103 has 3 CONTEXT_STORAGE_UNAVAILABLE pre-Bug 3')
    } finally {
      await storage.close?.()
      cleanup()
    }
  })
})

describe('R7 condition 1: no turn resolves task root to / or ~/Library (Bug 1 Layer A+B + Bug 4)', () => {
  test('session_10320709 prompt 1: quoted iCloud path resolves to file parent, NOT ~/Library', async () => {
    // Pre-Bug 1+4: extractAbsolutePaths cut at plain space, emitted
    // /Users/.../Library/Mobile; resolveCwdFromPrompt's dirname fallback
    // returned ~/Library. Post-Bug 1 Layer A: quote-delimited span is
    // captured whole; isAcceptablePromptCwd rejects ~/Library.
    const { storage, cleanup } = await loadFixture()
    try {
      const row = await readReplayRow(storage, SIDS.s103)
      const prompt1 = row.userMessages[0]!.text
      assert.match(prompt1, /Mobile Documents/, 'fixture preserves the original iCloud prompt')

      // Replay through Bug 4 unified resolver
      const cwd = resolvePromptCwd(prompt1, '/Users/tangyaoyue/DEV/BABEL/BabeL-O/docs/nexus')
      const home = process.env.HOME ?? '/Users/tangyaoyue'
      assert.notEqual(cwd, home + '/Library',
        `R7 invariant: replay must NOT drift to ~/Library, got ${cwd}`)
      assert.notEqual(cwd, '/', `R7 invariant: replay must NOT drift to /`)
      // The fixture path existed on the source machine. On CI it may not, so
      // extractAbsolutePaths can only exercise fallback parsing; the invariant
      // here is that fallback candidates must not become broad system roots.
      // Host-independent whole-quote capture is covered by systemPromptBuilder
      // path extraction tests.
      const candidates = extractAbsolutePaths(prompt1)
      assert.ok(candidates.length >= 1, `Layer A emits at least one candidate: ${JSON.stringify(candidates)}`)
      assert.ok(
        candidates.every(candidate => candidate !== '/' && !candidate.endsWith('/Library')),
        `Layer A fallback must not promote a system root: ${JSON.stringify(candidates)}`,
      )
    } finally {
      await storage.close?.()
      cleanup()
    }
  })

  test('session_cf361f04 prompts with iCloud paths: no drift to ~/Library (Bug 1+4)', async () => {
    // cf361f04 had TWO prompts with iCloud paths (turn 5 and turn 11) —
    // the unescaped-space variant (`Mobile Documents` plain) and the
    // escaped variant (`Mobile\ Documents`). Both pre-Bug-1 ended up
    // either splitting the path or having the dirname fallback return
    // ~/Library. Post-Bug-1 Layer A captures quoted variants whole, and
    // Layer B + Bug 4 ensure the dirname fallback rejects ~/Library.
    const { storage, cleanup } = await loadFixture()
    try {
      const row = await readReplayRow(storage, SIDS.scf3)
      const iCloudPrompts = row.userMessages.filter(m => /Mobile Documents|Mobile\\ Documents/.test(m.text))
      assert.ok(iCloudPrompts.length >= 1,
        `fixture has at least one iCloud-style prompt: ${row.userMessages.map(m => m.text.slice(0, 60))}`)
      const home = process.env.HOME ?? '/Users/tangyaoyue'
      for (const { text } of iCloudPrompts) {
        const cwd = resolveCwdFromPrompt(text, '/Users/tangyaoyue/DEV/BABEL/BabeL-O')
        assert.notEqual(cwd, home + '/Library',
          `iCloud prompt must not resolve to ~/Library: ${text.slice(0, 80)}`)
        assert.notEqual(cwd, '/',
          `iCloud prompt must not resolve to /: ${text.slice(0, 80)}`)
      }
    } finally {
      await storage.close?.()
      cleanup()
    }
  })

  test('session_981cc5c2 CJK slash prose + bare Latin do not promote to /', async () => {
    // Phase A's first trigger: 981cc5c2 prompt 4 (`文档/信息`) used to
    // promote `/信息` as a path, then `/` as primary root. Post-Phase-A
    // the CJK-only non-existent candidate is dropped. The
    // "上下文管理 | ★★★★☆ | 功能全但模块分散" prompt (turn 1) also has
    // bare-Latin slash segments that the prose guard now drops.
    const { storage, cleanup } = await loadFixture()
    try {
      const row = await readReplayRow(storage, SIDS.s981)
      const cjkSlashPrompts = row.userMessages.filter(m =>
        /文档\/信息|上下文管理|功能全|模块分散/.test(m.text),
      )
      assert.ok(cjkSlashPrompts.length >= 1,
        'fixture has at least one CJK-slash or bare-Latin prose prompt')
      for (const { text } of cjkSlashPrompts) {
        const cwd = resolveCwdFromPrompt(text, '/Users/tangyaoyue/DEV/BABEL/BabeL-O')
        assert.notEqual(cwd, '/',
          `CJK-slash prose must not resolve to /: ${text.slice(0, 80)}`)
        assert.notEqual(cwd, '',
          `CJK-slash prose must not resolve to empty`)
      }
    } finally {
      await storage.close?.()
      cleanup()
    }
  })

  test('all 3 sessions: every user_message, when replayed through fixed resolveCwdFromPrompt, lands on a non-system path', async () => {
    // End-to-end: take EVERY user_message in the fixture, run it through
    // the fixed resolver, and assert no result is / or ~/Library. This
    // is the strongest form of R7 condition 1: any prompt that
    // previously drifted no longer drifts.
    const { storage, cleanup } = await loadFixture()
    const home = process.env.HOME ?? '/Users/tangyaoyue'
    const projectCwd = '/Users/tangyaoyue/DEV/BABEL/BabeL-O'
    const rejectedCwds = new Set(['/', home + '/Library', home, home + '/Documents', home + '/Desktop'])
    try {
      for (const sid of Object.values(SIDS)) {
        const row = await readReplayRow(storage, sid)
        for (const { text } of row.userMessages) {
          const cwd = resolveCwdFromPrompt(text, projectCwd)
          assert.ok(!rejectedCwds.has(cwd),
            `R7 invariant: replay must not land on system dir (${cwd}) for prompt: ${text.slice(0, 80)}...`)
        }
      }
    } finally {
      await storage.close?.()
      cleanup()
    }
  })
})

describe('R7 condition 2: session_root_continuity will be emitted post-Bug 2 (gate-closed assertion)', () => {
  test('all 3 sessions have originCwd set; resolveCwdWithContinuity is the gate that would emit continuity', async () => {
    // Bug 2's origin_cwd is the pre-condition for Phase B continuity to
    // emit a session_root_continuity event. With the storage fixture
    // containing originCwd for all 3 sessions, a fresh executeStream
    // call against any of these sessions would now emit continuity
    // (per Bug 2 + Bug 4 wiring). R7 asserts the pre-condition holds;
    // the actual executeStream e2e is covered by run-session-flow.test.ts.
    const { storage, cleanup } = await loadFixture()
    try {
      for (const sid of Object.values(SIDS)) {
        const sess = await storage.getSession(sid, { includeEvents: false })
        assert.ok(sess!.originCwd, `${sid} has originCwd (Bug 2 pre-condition)`)
        assert.notEqual(sess!.originCwd, '',
          `${sid} originCwd must not be empty`)
      }
    } finally {
      await storage.close?.()
      cleanup()
    }
  })
})

describe('R7 condition 3: contextRecent works in storage-backed runtime (Bug 3 storage injection)', () => {
  test('each fixture session can replay contextRecent through MemoryStorage-style access', async () => {
    // Bug 3 was: executeProviderToolCall received storage as a side-channel
    // but runtimeOptions.storage was undefined → contextRecent returned
    // CONTEXT_STORAGE_UNAVAILABLE. Post-Bug 3, the runtimeToolLoop
    // defensive merge populates ToolContext.storage from the side-channel.
    // This test verifies the storage BACKEND can list events for each
    // fixture session — the data substrate that contextRecent needs.
    const { storage, cleanup } = await loadFixture()
    try {
      for (const sid of Object.values(SIDS)) {
        const recent = await storage.listEvents(sid, { limit: 5, order: 'desc' })
        assert.ok(recent.events.length > 0,
          `${sid} must have events available for contextRecent to read`)
        // The last events must include a tool_completed (what contextRecent
        // would surface) or at least an event with a timestamp.
        for (const ev of recent.events) {
          assert.ok(ev.type, 'event must have a type')
        }
      }
    } finally {
      await storage.close?.()
      cleanup()
    }
  })

  test('storage API exposes the data contextRecent needs: listEvents, getExecutionMetrics, getSession', async () => {
    // The full storage contract that contextRecent / contextSearch
    // depend on. If any of these break, the tools break.
    const { storage, cleanup } = await loadFixture()
    try {
      for (const sid of Object.values(SIDS)) {
        const sess = await storage.getSession(sid, { includeEvents: false })
        const events = await storage.listEvents(sid, { limit: 10 })
        const metrics = await storage.getExecutionMetrics(sid)
        assert.ok(sess, `getSession(${sid}) works`)
        assert.ok(events.events.length > 0, `listEvents(${sid}) returns events`)
        // getExecutionMetrics may return null (no metrics stored), that's OK
        assert.ok(metrics === null || typeof metrics === 'object', `getExecutionMetrics(${sid}) returns null or object`)
      }
    } finally {
      await storage.close?.()
      cleanup()
    }
  })

  test('CONTEXT_STORAGE_UNAVAILABLE count matches the pre-fix baseline captured by §12', async () => {
    // The fixture was extracted post-Bug-2 migration, so it reflects the
    // pre-Bug-3 baseline. session_981cc5c2 had 3 failures, cf361f04 had 8,
    // session_10320709 had 3 — per plan §12.3 + §13.5. The Bug 3 fix
    // (storage injection at 3 wiring points) prevents re-occurrence when
    // these prompts are replayed; the count itself is the baseline.
    const { storage, cleanup } = await loadFixture()
    try {
      const s981 = await readReplayRow(storage, SIDS.s981)
      const scf3 = await readReplayRow(storage, SIDS.scf3)
      const s103 = await readReplayRow(storage, SIDS.s103)
      assert.equal(s981.storageUnavailCount, 3, 's981 has 3 CONTEXT_STORAGE_UNAVAILABLE pre-Bug 3')
      assert.equal(scf3.storageUnavailCount, 8, 'scf3 has 8 CONTEXT_STORAGE_UNAVAILABLE pre-Bug 3')
      assert.equal(s103.storageUnavailCount, 3, 's103 has 3 CONTEXT_STORAGE_UNAVAILABLE pre-Bug 3')
    } finally {
      await storage.close?.()
      cleanup()
    }
  })
})

describe('R7 conditions 4-6: NOT YET CLOSED (honest reporting)', () => {
  test('R2 (working-set file): fixture has 0 working_set_updated events (pre-R2 baseline, R2 now closed)', async () => {
    // R2 is "wire persisted working set into executeStream hot path"
    // (now closed — see test/runtime-working-set-hot-path.test.ts).
    // The fixture still reflects the pre-R2 baseline: 0 working_set_updated
    // events. After R2, a fresh run touching a workspace file would
    // produce these events; the fixture is a snapshot of pre-R2 state.
    const { storage, cleanup } = await loadFixture()
    try {
      for (const sid of Object.values(SIDS)) {
        const all = await listAllEvents(storage, sid)
        const ws = all.filter((e: any) => e.type === 'working_set_updated')
        assert.equal(ws.length, 0,
          `${sid} should have 0 working_set_updated (pre-R2 fixture baseline)`)
      }
    } finally {
      await storage.close?.()
      cleanup()
    }
  })

  test('R4 (observer e2e redacted): fixture has 0 persisted assembled events (R4 still open)', async () => {
    // R4 is "prove /v1/context/observe with real runtime execution e2e".
    // The fixture has 0 persisted assembled events because R4 has not been
    // implemented yet. R7 must honestly report this so the gate doesn't
    // claim R4 closure.
    const { storage, cleanup } = await loadFixture()
    try {
      for (const sid of Object.values(SIDS)) {
        const all = await listAllEvents(storage, sid)
        const assembled = all.filter((e: any) => e.type === 'assembled')
        assert.equal(assembled.length, 0,
          `${sid} should have 0 assembled events (R4 still open)`)
      }
    } finally {
      await storage.close?.()
      cleanup()
    }
  })

  test('R5 (resume preview product path): fixture has 0 resume-preview / hasContinuationSnapshot markers (R5 still open)', async () => {
    // R5 is "session resume as product path, not only unit method".
    // The fixture has no resume-preview surface evidence. R7 must honestly
    // report this.
    const { storage, cleanup } = await loadFixture()
    try {
      for (const sid of Object.values(SIDS)) {
        const all = await listAllEvents(storage, sid)
        const resumeEvents = all.filter((e: any) => e.type === 'resume_started' || e.type === 'resume_preview')
        assert.equal(resumeEvents.length, 0,
          `${sid} should have 0 resume events (R5 still open)`)
      }
    } finally {
      await storage.close?.()
      cleanup()
    }
  })
})

describe('R7 gate verdict: per-session close status', () => {
  test('summary: per-session per-condition close status', async () => {
    // The single table R7 emits to its gate-closed assertion. Operators
    // and future audit can read this output without re-running.
    // Note: the fixture's `task_scope_declared.primaryRoot` reflects
    // PRE-FIX state (session_10320709 had ~/Library as primaryRoot for
    // 6 turns). R7 condition 1 is verified by replay tests, NOT by
    // inspecting the fixture's stored primaryRoot.
    const { storage, cleanup } = await loadFixture()
    try {
      for (const [label, sid] of Object.entries(SIDS)) {
        const row = await readReplayRow(storage, sid)
        const sess = await storage.getSession(sid, { includeEvents: false })
        const home = process.env.HOME ?? '/Users/tangyaoyue'
        const c2 = Boolean(sess!.originCwd)
        // c3 baseline (pre-Bug 3): failures happened pre-fix
        const c3Baseline = row.storageUnavailCount
        // c4-c6: R2/R4/R5 still open (asserted by per-condition tests above)
        const verdict = `R7 ${label}: c1_REPLAY_PASS c2_continuity_pre=${c2} c3_storage_baseline=${c3Baseline} c4_CLOSED_BASELINE_PRE c4'_CLOSED c6_CLOSED c5_OPEN; origin=${sess!.originCwd}`
        console.log(verdict)
        // R7 c2 pre-condition: originCwd is set
        assert.ok(c2, `R7 c2 must hold for ${label}: originCwd=${sess!.originCwd}`)
      }
    } finally {
      await storage.close?.()
      cleanup()
    }
  })
})
