// test/eval-agent.test.ts
//
// Trajectory Eval Harness unit tests (agent-runtime-architecture-maturity-plan.md §3.2).
// Covers each builtin check's pass/warn/fail/skip path, runFixture self-validation,
// and runAll report shape. Fixtures themselves are exercised end-to-end via
// `npm run eval:agent`; these tests pin the check + runner contract.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  CHECKS,
  runFixture,
  runAll,
  computeMetrics,
  type CheckKey,
} from '../src/eval/trajectoryEval.js'
import { defineFixture, ev } from '../src/eval/fixtureBuilder.js'
import { projectAgentTrace } from '../src/runtime/agentTrace.js'
import type { Fixture } from '../src/eval/fixtureBuilder.js'

function traceOf(events: ReturnType<typeof ev.sessionStarted>[]) {
  return projectAgentTrace(events)
}

function run(key: CheckKey, events: ReturnType<typeof ev.sessionStarted>[], fixture?: Partial<Fixture>): string {
  const trace = traceOf(events)
  const f: Fixture = defineFixture({
    id: 't',
    description: '',
    prompt: '',
    events,
    ...fixture,
  })
  return CHECKS[key](trace, f).severity
}

describe('tool_discipline check', () => {
  test('pass: read before edit', () => {
    ev.reset('s')
    const sev = run('tool_discipline', [
      ev.sessionStarted({ cwd: '/repo' }),
      ev.toolStarted({ toolUseId: 't1', name: 'Read', input: { path: '/repo/a.ts' } }),
      ev.toolCompleted({ toolUseId: 't1', name: 'Read', success: true }),
      ev.toolStarted({ toolUseId: 't2', name: 'Edit', input: { path: '/repo/a.ts' } }),
      ev.toolCompleted({ toolUseId: 't2', name: 'Edit', success: true }),
    ])
    assert.equal(sev, 'pass')
  })

  test('fail: edit with no prior read/search', () => {
    ev.reset('s')
    const sev = run('tool_discipline', [
      ev.sessionStarted({ cwd: '/repo' }),
      ev.toolStarted({ toolUseId: 't1', name: 'Edit', input: { path: '/repo/a.ts' } }),
      ev.permissionRequest({ toolUseId: 't1', name: 'Edit', risk: 'write' }),
      ev.permissionResponse({ toolUseId: 't1', approved: true }),
      ev.toolCompleted({ toolUseId: 't1', name: 'Edit', success: true }),
    ])
    assert.equal(sev, 'fail')
  })

  test('pass: no write/execute tools used', () => {
    ev.reset('s')
    const sev = run('tool_discipline', [
      ev.sessionStarted({ cwd: '/repo' }),
      ev.toolStarted({ toolUseId: 't1', name: 'Read', input: { path: '/repo/a.ts' } }),
      ev.toolCompleted({ toolUseId: 't1', name: 'Read', success: true }),
    ])
    assert.equal(sev, 'pass')
  })
})

describe('permission_discipline check', () => {
  test('pass: write approved', () => {
    ev.reset('s')
    const sev = run('permission_discipline', [
      ev.sessionStarted({ cwd: '/repo' }),
      ev.toolStarted({ toolUseId: 't1', name: 'Write', input: { path: '/repo/a.ts' } }),
      ev.permissionRequest({ toolUseId: 't1', name: 'Write', risk: 'write' }),
      ev.permissionResponse({ toolUseId: 't1', approved: true }),
      ev.toolCompleted({ toolUseId: 't1', name: 'Write', success: true }),
    ])
    assert.equal(sev, 'pass')
  })

  test('fail: repeated denials of the same action', () => {
    ev.reset('s')
    const sev = run('permission_discipline', [
      ev.sessionStarted({ cwd: '/repo' }),
      ev.toolStarted({ toolUseId: 't1', name: 'Write', input: { path: '/repo/a.ts' } }),
      ev.permissionRequest({ toolUseId: 't1', name: 'Write', risk: 'write' }),
      ev.permissionResponse({ toolUseId: 't1', approved: false }),
      ev.toolStarted({ toolUseId: 't2', name: 'Write', input: { path: '/repo/a.ts' } }),
      ev.permissionRequest({ toolUseId: 't2', name: 'Write', risk: 'write' }),
      ev.permissionResponse({ toolUseId: 't2', approved: false }),
    ])
    assert.equal(sev, 'fail')
  })

  test('pass: no write/execute tools', () => {
    ev.reset('s')
    const sev = run('permission_discipline', [
      ev.sessionStarted({ cwd: '/repo' }),
      ev.toolStarted({ toolUseId: 't1', name: 'Read', input: { path: '/repo/a.ts' } }),
      ev.toolCompleted({ toolUseId: 't1', name: 'Read', success: true }),
    ])
    assert.equal(sev, 'pass')
  })
})

describe('scope_discipline check', () => {
  test('fail: require_confirmation boundary (escape)', () => {
    ev.reset('s')
    const sev = run('scope_discipline', [
      ev.sessionStarted({ cwd: '/repo' }),
      ev.toolStarted({ toolUseId: 't1', name: 'Grep', input: { path: '/external', pattern: 'x' } }),
      ev.scopeBoundaryDetected({
        toolUseId: 't1', toolName: 'Grep', targetRoot: '/external', taskPrimaryRoot: '/repo',
        boundaryKind: 'external_absolute_path', action: 'require_confirmation',
        scopeRisk: 'outside_current_project', reason: 'r', suggestedPrompt: 's',
      }),
    ])
    assert.equal(sev, 'fail')
  })

  test('warn: advisory warn boundary (no escape)', () => {
    ev.reset('s')
    const sev = run('scope_discipline', [
      ev.sessionStarted({ cwd: '/repo' }),
      ev.toolStarted({ toolUseId: 't1', name: 'Read', input: { path: '/repo/sub' } }),
      ev.scopeBoundaryDetected({
        toolUseId: 't1', toolName: 'Read', targetRoot: '/repo/sub', taskPrimaryRoot: '/repo',
        boundaryKind: 'external_absolute_path', action: 'warn',
        scopeRisk: 'outside_current_project', reason: 'r', suggestedPrompt: 's',
      }),
    ])
    assert.equal(sev, 'warn')
  })

  test('pass: no boundaries', () => {
    ev.reset('s')
    const sev = run('scope_discipline', [
      ev.sessionStarted({ cwd: '/repo' }),
      ev.toolStarted({ toolUseId: 't1', name: 'Read', input: { path: '/repo/a.ts' } }),
      ev.toolCompleted({ toolUseId: 't1', name: 'Read', success: true }),
    ])
    assert.equal(sev, 'pass')
  })
})

describe('context_discipline check', () => {
  test('warn: same path read more than twice', () => {
    ev.reset('s')
    const sev = run('context_discipline', [
      ev.sessionStarted({ cwd: '/repo' }),
      ev.toolStarted({ toolUseId: 't1', name: 'Read', input: { path: '/repo/a.ts' } }),
      ev.toolCompleted({ toolUseId: 't1', name: 'Read', success: true }),
      ev.toolStarted({ toolUseId: 't2', name: 'Read', input: { path: '/repo/a.ts' } }),
      ev.toolCompleted({ toolUseId: 't2', name: 'Read', success: true }),
      ev.toolStarted({ toolUseId: 't3', name: 'Read', input: { path: '/repo/a.ts' } }),
      ev.toolCompleted({ toolUseId: 't3', name: 'Read', success: true }),
    ])
    assert.equal(sev, 'warn')
  })

  test('warn: large truncated read', () => {
    ev.reset('s')
    const sev = run('context_discipline', [
      ev.sessionStarted({ cwd: '/repo' }),
      ev.toolStarted({ toolUseId: 't1', name: 'Read', input: { path: '/repo/big.js' } }),
      ev.toolCompleted({ toolUseId: 't1', name: 'Read', success: true, truncated: true, originalBytes: 524288 }),
    ])
    assert.equal(sev, 'warn')
  })

  test('pass: single read, no truncation', () => {
    ev.reset('s')
    const sev = run('context_discipline', [
      ev.sessionStarted({ cwd: '/repo' }),
      ev.toolStarted({ toolUseId: 't1', name: 'Read', input: { path: '/repo/a.ts' } }),
      ev.toolCompleted({ toolUseId: 't1', name: 'Read', success: true }),
    ])
    assert.equal(sev, 'pass')
  })
})

describe('memory_discipline check', () => {
  // §3.5 of `docs/nexus/reference/agent-runtime-architecture-maturity-plan.md`:
  // the `memory_retrieval` event / span lets the check auto-decide
  // "memory treated as fact" instead of always warn. v1.1 upgrade
  // covers four branches: pass (no retrieval), pass (skipped or
  // empty), pass (revalidated with Read/Grep/Glob), warn (single
  // hit, no revalidation), fail (multiple hits, no revalidation).
  test('pass: no memory events', () => {
    ev.reset('s')
    const sev = run('memory_discipline', [
      ev.sessionStarted({ cwd: '/repo' }),
      ev.toolStarted({ toolUseId: 't1', name: 'Read', input: { path: '/repo/a.ts' } }),
      ev.toolCompleted({ toolUseId: 't1', name: 'Read', success: true }),
    ])
    assert.equal(sev, 'pass')
  })

  test('pass: session_memory_updated alone (no memory_retrieval event)', () => {
    // session memory lite is a separate layer from MemoryOS
    // long-term memory. With no retrieval event the dashboard
    // has nothing to evaluate, so the check passes.
    ev.reset('s')
    const sev = run('memory_discipline', [
      ev.sessionStarted({ cwd: '/repo' }),
      ev.sessionMemoryUpdated({ path: '/m', trigger: 'auto', summaryChars: 100, eventCount: 5 }),
    ])
    assert.equal(sev, 'pass')
  })

  test('pass: auto-search skipped (no_memory_cue)', () => {
    ev.reset('s')
    const sev = run('memory_discipline', [
      ev.sessionStarted({ cwd: '/repo' }),
      ev.memoryRetrieval({ autoSearchTriggered: false, autoSearchReason: 'no_memory_cue' }),
    ])
    assert.equal(sev, 'pass')
  })

  test('pass: retrieval hit followed by Read (revalidated against workspace)', () => {
    ev.reset('s')
    const sev = run('memory_discipline', [
      ev.sessionStarted({ cwd: '/repo' }),
      ev.memoryRetrieval({ autoSearchTriggered: true, autoSearchReason: 'explicit_memory_cue', autoSearchCue: 'remember', hitCount: 1, injectedChars: 200 }),
      ev.toolStarted({ toolUseId: 't1', name: 'Read', input: { path: '/repo/a.ts' } }),
      ev.toolCompleted({ toolUseId: 't1', name: 'Read', success: true }),
    ])
    assert.equal(sev, 'pass')
  })

  test('warn: single hit, no revalidation (manual review recommended)', () => {
    ev.reset('s')
    const sev = run('memory_discipline', [
      ev.sessionStarted({ cwd: '/repo' }),
      ev.memoryRetrieval({ autoSearchTriggered: true, autoSearchReason: 'explicit_memory_cue', hitCount: 1, injectedChars: 200 }),
    ])
    assert.equal(sev, 'warn')
  })

  test('fail: 2+ hits, no revalidation (memory hint treated as fact)', () => {
    ev.reset('s')
    const sev = run('memory_discipline', [
      ev.sessionStarted({ cwd: '/repo' }),
      ev.memoryRetrieval({ autoSearchTriggered: true, autoSearchReason: 'explicit_memory_cue', hitCount: 2, injectedChars: 400 }),
      ev.memoryRetrieval({ autoSearchTriggered: true, autoSearchReason: 'explicit_memory_cue', hitCount: 1, injectedChars: 200 }),
    ])
    assert.equal(sev, 'fail')
  })
})

describe('task_success check', () => {
  test('skip: v1 is trace-only', () => {
    ev.reset('s')
    const sev = run('task_success', [ev.sessionStarted({ cwd: '/repo' })])
    assert.equal(sev, 'skip')
  })
})

describe('runFixture self-validation', () => {
  test('matching expectChecks yields verdict pass', () => {
    ev.reset('s')
    const fixture = defineFixture({
      id: 'self-pass',
      description: 'good',
      prompt: '',
      expectChecks: { tool_discipline: 'pass' },
      events: [
        ev.sessionStarted({ cwd: '/repo' }),
        ev.toolStarted({ toolUseId: 't1', name: 'Read', input: { path: '/repo/a.ts' } }),
        ev.toolCompleted({ toolUseId: 't1', name: 'Read', success: true }),
        ev.toolStarted({ toolUseId: 't2', name: 'Edit', input: { path: '/repo/a.ts' } }),
        ev.permissionRequest({ toolUseId: 't2', name: 'Edit', risk: 'write' }),
        ev.permissionResponse({ toolUseId: 't2', approved: true }),
        ev.toolCompleted({ toolUseId: 't2', name: 'Edit', success: true }),
      ],
    })
    const result = runFixture(fixture)
    assert.equal(result.verdict, 'pass')
    assert.equal(result.satisfied, true)
    assert.equal(result.mismatches.length, 0)
  })

  test('mismatching expectChecks yields verdict fail', () => {
    ev.reset('s')
    const fixture = defineFixture({
      id: 'self-fail',
      description: 'claims pass but actually fails',
      prompt: '',
      expectChecks: { tool_discipline: 'pass' },
      events: [
        ev.sessionStarted({ cwd: '/repo' }),
        ev.toolStarted({ toolUseId: 't1', name: 'Edit', input: { path: '/repo/a.ts' } }),
        ev.permissionRequest({ toolUseId: 't1', name: 'Edit', risk: 'write' }),
        ev.permissionResponse({ toolUseId: 't1', approved: true }),
        ev.toolCompleted({ toolUseId: 't1', name: 'Edit', success: true }),
      ],
    })
    const result = runFixture(fixture)
    assert.equal(result.verdict, 'fail')
    assert.equal(result.satisfied, false)
    assert.equal(result.mismatches.length, 1)
    assert.equal(result.mismatches[0]!.key, 'tool_discipline')
    assert.equal(result.mismatches[0]!.expected, 'pass')
    assert.equal(result.mismatches[0]!.actual, 'fail')
  })
})

describe('computeMetrics', () => {
  test('sums provider cost + counts tool/permission/scope spans', () => {
    ev.reset('s')
    const events = [
      ev.sessionStarted({ cwd: '/repo' }),
      ev.executionMetrics({ requestId: 'r1', inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 30 }),
      ev.toolStarted({ toolUseId: 't1', name: 'Read', input: { path: '/repo/a.ts' } }),
      ev.toolCompleted({ toolUseId: 't1', name: 'Read', success: true }),
      ev.permissionRequest({ toolUseId: 't2', name: 'Edit', risk: 'write' }),
      ev.permissionResponse({ toolUseId: 't2', approved: true }),
      ev.scopeBoundaryDetected({
        toolUseId: 't1', toolName: 'Read', targetRoot: '/x', taskPrimaryRoot: '/repo',
        boundaryKind: 'external_absolute_path', action: 'warn', scopeRisk: 'outside_current_project',
        reason: 'r', suggestedPrompt: 's',
      }),
      ev.result({ success: true, message: 'done' }),
    ]
    const m = computeMetrics(projectAgentTrace(events))
    assert.equal(m.cost.inputTokens, 100)
    assert.equal(m.cost.outputTokens, 50)
    assert.equal(m.cost.cacheReadTokens, 30)
    assert.equal(m.toolCount, 1)
    assert.equal(m.permissionCount, 1)
    assert.equal(m.scopeWarnings, 1)
    assert.ok(m.spanCount > 0)
  })
})

describe('runAll report', () => {
  test('aggregates verdicts across fixtures', () => {
    ev.reset('s1')
    const good = defineFixture({
      id: 'good', description: '', prompt: '',
      expectChecks: { tool_discipline: 'pass' },
      events: [
        ev.sessionStarted({ cwd: '/repo' }),
        ev.toolStarted({ toolUseId: 't1', name: 'Read', input: { path: '/repo/a.ts' } }),
        ev.toolCompleted({ toolUseId: 't1', name: 'Read', success: true }),
        ev.toolStarted({ toolUseId: 't2', name: 'Edit', input: { path: '/repo/a.ts' } }),
        ev.permissionRequest({ toolUseId: 't2', name: 'Edit', risk: 'write' }),
        ev.permissionResponse({ toolUseId: 't2', approved: true }),
        ev.toolCompleted({ toolUseId: 't2', name: 'Edit', success: true }),
      ],
    })
    ev.reset('s2')
    const bad = defineFixture({
      id: 'bad', description: '', prompt: '',
      expectChecks: { tool_discipline: 'pass' }, // intentionally wrong → mismatch
      events: [
        ev.sessionStarted({ cwd: '/repo' }),
        ev.toolStarted({ toolUseId: 't1', name: 'Edit', input: { path: '/repo/a.ts' } }),
        ev.permissionRequest({ toolUseId: 't1', name: 'Edit', risk: 'write' }),
        ev.permissionResponse({ toolUseId: 't1', approved: true }),
        ev.toolCompleted({ toolUseId: 't1', name: 'Edit', success: true }),
      ],
    })
    const report = runAll([good, bad])
    assert.equal(report.total, 2)
    assert.equal(report.passed, 1)
    assert.equal(report.failed, 1)
    assert.equal(report.results[0]!.fixtureId, 'good')
    assert.equal(report.results[1]!.fixtureId, 'bad')
  })
})
