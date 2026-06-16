// test/runtime-behavior-trace-tap.test.ts
//
// PR-3 integration test: verify that the behaviorTrace tap wrapper
// (wrapWithBehaviorTraceTap, exported from LLMCodingRuntime) correctly:
//   1. Passthrough fidelity — every event from source reaches consumer
//   2. Detects all 5 trigger types from a realistic event stream
//   3. Queues BehaviorTraceEntry writes to cwd/.babel-o/behavior-trace.jsonl
//   4. Respects BABEL_O_BEHAVIOR_TRACE_ENABLED=false (no writes)
//   5. Respects test config isolation (cwd is explicit, HOME is irrelevant)
//   6. Honors BABEL_O_BEHAVIOR_TRAJECTORY_INTERVAL
//
// We test the top-level wrapWithBehaviorTraceTap directly rather than
// spinning up a full LLMCodingRuntime + provider mock, because the
// wrapper is a pure side-effect pass-through.

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { wrapWithBehaviorTraceTap } from '../src/runtime/LLMCodingRuntime.js'
import {
  BEHAVIOR_TRACE_RELATIVE_PATH,
  flushBehaviorTraceQueue,
  isBehaviorTraceEnabled,
} from '../src/runtime/behaviorTrace.js'
import type { NexusEvent } from '../src/shared/events.js'
import type { RuntimeExecuteOptions } from '../src/runtime/Runtime.js'

const NEXUS_EVENT_SCHEMA_VERSION = '2026-05-21.babel-o.v1'

function fakeHome(): string {
  return mkdtempSync(join(tmpdir(), 'babel-o-bt-tap-home-'))
}

function buildTriggerEvents(cwd: string, sessionId: string): NexusEvent[] {
  return [
    {
      type: 'session_started',
      schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
      sessionId,
      timestamp: '2026-06-16T10:00:00.000Z',
      cwd,
    },
    {
      type: 'task_scope_declared',
      schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
      sessionId,
      timestamp: '2026-06-16T10:00:00.500Z',
      cwd,
      primaryRoot: cwd,
      explicitRoots: [],
      confirmedExternalRoots: [],
      inferredCandidateRoots: [],
      mode: 'single_root',
      source: 'cwd',
      message: 'test',
    },
    {
      type: 'user_message',
      schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
      sessionId,
      timestamp: '2026-06-16T10:00:01.000Z',
      text: '分析下这个项目',
    },
    // 1) error trigger
    {
      type: 'tool_started',
      schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
      sessionId,
      timestamp: '2026-06-16T10:00:02.000Z',
      toolUseId: 'tu_1',
      name: 'Read',
      input: { path: '/missing/file.ts' },
    },
    {
      type: 'tool_completed',
      schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
      sessionId,
      timestamp: '2026-06-16T10:00:03.000Z',
      toolUseId: 'tu_1',
      name: 'Read',
      success: false,
      output: 'ENOENT',
    },
    {
      type: 'error',
      schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
      sessionId,
      timestamp: '2026-06-16T10:00:04.000Z',
      code: 'TOOL_NOT_FOUND',
      message: 'file does not exist',
    },
    // 2) denial trigger
    {
      type: 'tool_started',
      schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
      sessionId,
      timestamp: '2026-06-16T10:00:05.000Z',
      toolUseId: 'tu_2',
      name: 'Edit',
      input: { path: '/etc/hosts' },
    },
    {
      type: 'permission_response',
      schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
      sessionId,
      timestamp: '2026-06-16T10:00:06.000Z',
      toolUseId: 'tu_2',
      approved: false,
      reason: 'protected_path',
    },
    // 3) scope-drift trigger (path outside cwd)
    {
      type: 'tool_started',
      schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
      sessionId,
      timestamp: '2026-06-16T10:00:07.000Z',
      toolUseId: 'tu_3',
      name: 'Read',
      input: { path: '/random/path.ts' },
    },
    // 4) user-redirect trigger
    {
      type: 'user_message',
      schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
      sessionId,
      timestamp: '2026-06-16T10:00:08.000Z',
      text: '不对，应该是先看 package.json',
    },
    // 5) trajectory-end trigger (5 tool calls = multiple of 5, with interval=5)
    {
      type: 'tool_started',
      schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
      sessionId,
      timestamp: '2026-06-16T10:00:09.000Z',
      toolUseId: 'tu_4',
      name: 'Glob',
      input: { pattern: '**/*.ts' },
    },
    {
      type: 'tool_started',
      schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
      sessionId,
      timestamp: '2026-06-16T10:00:10.000Z',
      toolUseId: 'tu_5',
      name: 'Read',
      input: { path: join(cwd, 'src', 'main.ts') },
    },
  ]
}

describe('PR-3 behaviorTrace tap (wrapWithBehaviorTraceTap)', () => {
  let home: string
  let cwd: string
  let sessionId: string
  const ORIGINAL_ENV: Record<string, string | undefined> = {}

  beforeEach(async () => {
    home = fakeHome()
    cwd = mkdtempSync(join(home, 'project-'))
    sessionId = `bt-tap-${Date.now()}-${Math.random()}`

    for (const key of [
      'BABEL_O_BEHAVIOR_TRACE_ENABLED',
      'BABEL_O_BEHAVIOR_TRAJECTORY_INTERVAL',
      'BABEL_O_TEST_CONFIG_WRITE_GUARD',
      'HOME',
    ]) {
      ORIGINAL_ENV[key] = process.env[key]
    }
    process.env.HOME = home
    process.env.BABEL_O_TEST_CONFIG_WRITE_GUARD = '1'
    delete process.env.BABEL_O_BEHAVIOR_TRACE_ENABLED
    delete process.env.BABEL_O_BEHAVIOR_TRAJECTORY_INTERVAL
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

  test('passthrough: every event from source reaches the consumer', async () => {
    const events = buildTriggerEvents(cwd, sessionId)
    const source = (async function* () {
      for (const e of events) yield e
    })()
    const options: RuntimeExecuteOptions = { sessionId, prompt: 'test', cwd }

    const received: NexusEvent[] = []
    for await (const e of wrapWithBehaviorTraceTap(options, source)) {
      received.push(e)
    }
    await flushBehaviorTraceQueue()

    assert.equal(received.length, events.length, 'event count must match exactly')
    for (let i = 0; i < events.length; i += 1) {
      assert.equal(received[i]!.type, events[i]!.type, `event[${i}] type`)
    }
  })

  test('enabled (default): writes 5 behavior trace entries from realistic event stream', async () => {
    process.env.BABEL_O_BEHAVIOR_TRAJECTORY_INTERVAL = '5'
    const events = buildTriggerEvents(cwd, sessionId)
    const source = (async function* () {
      for (const e of events) yield e
    })()
    const options: RuntimeExecuteOptions = { sessionId, prompt: 'test', cwd }

    assert.equal(isBehaviorTraceEnabled(), true, 'default = enabled')

    for await (const _ of wrapWithBehaviorTraceTap(options, source)) {
      // drain
    }
    await flushBehaviorTraceQueue()

    const tracePath = join(cwd, BEHAVIOR_TRACE_RELATIVE_PATH)
    assert.equal(existsSync(tracePath), true, 'trace file must be created')

    const lines = readFileSync(tracePath, 'utf8')
      .split('\n')
      .filter(l => l.trim().length > 0)
    assert.ok(lines.length >= 5, `expected ≥5 trace lines, got ${lines.length}`)

    const triggers = new Set<string>()
    for (const line of lines) {
      const entry = JSON.parse(line)
      assert.equal(entry.schemaVersion, '2026-06-16.behavior-trace.v1')
      assert.equal(entry.sessionId, sessionId)
      assert.equal(entry.cwd, cwd)
      assert.ok(entry.traceId.startsWith('trc_'))
      const source = entry.selfAssessment?.source ?? ''
      assert.ok(source === 'rule' || source === '', `no LLM source allowed, got '${source}'`)
      triggers.add(entry.trigger)
    }
    for (const expected of ['error', 'denial', 'scope-drift', 'user-redirect', 'trajectory-end']) {
      assert.ok(triggers.has(expected), `trigger ${expected} must be present`)
    }
  })

  test('disabled: BABEL_O_BEHAVIOR_TRACE_ENABLED=false yields zero writes', async () => {
    process.env.BABEL_O_BEHAVIOR_TRACE_ENABLED = 'false'
    const events = buildTriggerEvents(cwd, sessionId)
    const source = (async function* () {
      for (const e of events) yield e
    })()
    const options: RuntimeExecuteOptions = { sessionId, prompt: 'test', cwd }

    assert.equal(isBehaviorTraceEnabled(), false, 'must report disabled')

    for await (const _ of wrapWithBehaviorTraceTap(options, source)) {
      // drain
    }
    await flushBehaviorTraceQueue()

    const tracePath = join(cwd, BEHAVIOR_TRACE_RELATIVE_PATH)
    assert.equal(existsSync(tracePath), false, 'no file when disabled')
  })

  test('isolation: trace file is written to cwd, never to HOME', async () => {
    const events = buildTriggerEvents(cwd, sessionId)
    const source = (async function* () {
      for (const e of events) yield e
    })()
    const options: RuntimeExecuteOptions = { sessionId, prompt: 'test', cwd }

    for await (const _ of wrapWithBehaviorTraceTap(options, source)) {
      // drain
    }
    await flushBehaviorTraceQueue()

    const homeTracePath = join(home, BEHAVIOR_TRACE_RELATIVE_PATH)
    const cwdTracePath = join(cwd, BEHAVIOR_TRACE_RELATIVE_PATH)
    assert.equal(existsSync(homeTracePath), false, 'must NOT write to HOME/.babel-o')
    assert.equal(existsSync(cwdTracePath), true, 'must write to cwd/.babel-o')
  })

  test('trajectory interval env var: BABEL_O_BEHAVIOR_TRAJECTORY_INTERVAL=10 fires trajectory-end at tool#10', async () => {
    process.env.BABEL_O_BEHAVIOR_TRAJECTORY_INTERVAL = '10'
    const events: NexusEvent[] = [
      {
        type: 'session_started',
        schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
        sessionId,
        timestamp: '2026-06-16T10:00:00.000Z',
        cwd,
      },
    ]
    for (let i = 0; i < 10; i += 1) {
      events.push({
        type: 'tool_started',
        schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
        sessionId,
        timestamp: `2026-06-16T10:00:0${i}.000Z`,
        toolUseId: `tu_${i}`,
        name: 'Read',
        input: { path: join(cwd, `file-${i}.ts`) },
      })
    }
    const source = (async function* () {
      for (const e of events) yield e
    })()
    const options: RuntimeExecuteOptions = { sessionId, prompt: 'test', cwd }

    for await (const _ of wrapWithBehaviorTraceTap(options, source)) {
      // drain
    }
    await flushBehaviorTraceQueue()

    const tracePath = join(cwd, BEHAVIOR_TRACE_RELATIVE_PATH)
    assert.equal(existsSync(tracePath), true)
    const lines = readFileSync(tracePath, 'utf8')
      .split('\n')
      .filter(l => l.trim().length > 0)
    const trajectoryTraces = lines
      .map(l => JSON.parse(l))
      .filter(e => e.trigger === 'trajectory-end')
    assert.equal(trajectoryTraces.length, 1, 'exactly one trajectory-end trace at tool#10')
  })
})
