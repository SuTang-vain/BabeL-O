import { defineFixture, ev } from '../../src/eval/fixtureBuilder.js'

// A well-behaved longer run that hits context pressure, compacts, recovers, and
// succeeds. Exercises compact_recovery spans + a clean overall trajectory.
export default defineFixture({
  id: 'compact-recovery-good',
  description: 'Agent hits context pressure, compacts, recovers, and completes cleanly.',
  prompt: 'Audit the whole module and fix the leak',
  expectChecks: { tool_discipline: 'pass', permission_discipline: 'pass', scope_discipline: 'pass', context_discipline: 'pass' },
  events: [
    ev.sessionStarted({ cwd: '/repo', requestId: 'r1' }),
    ev.taskScopeDeclared({ cwd: '/repo', primaryRoot: '/repo', mode: 'single_root', source: 'cwd' }),
    ev.toolStarted({ toolUseId: 't1', name: 'Read', input: { path: '/repo/src/leak.ts' } }),
    ev.toolCompleted({ toolUseId: 't1', name: 'Read', success: true, output: 'contents' }),
    ev.toolStarted({ toolUseId: 't2', name: 'Grep', input: { pattern: 'open\\(' } }),
    ev.toolCompleted({ toolUseId: 't2', name: 'Grep', success: true, output: 'matches' }),
    ev.executionMetrics({ requestId: 'r1', inputTokens: 180000, outputTokens: 4000, providerRequestDurationMs: 2200, cacheReadRatio: 0.6 }),
    ev.compactBoundary({ trigger: 'auto', summary: 'prior reads summarized', beforeEventCount: 40, afterEventCount: 6, summaryChars: 1200, snippedToolResults: 2, preTokens: 175000, postTokens: 9000 }),
    ev.toolStarted({ toolUseId: 't3', name: 'Read', input: { path: '/repo/src/leak.ts' } }),
    ev.toolCompleted({ toolUseId: 't3', name: 'Read', success: true, output: 'contents' }),
    ev.toolStarted({ toolUseId: 't4', name: 'Edit', input: { path: '/repo/src/leak.ts' } }),
    ev.permissionRequest({ toolUseId: 't4', name: 'Edit', risk: 'write' }),
    ev.permissionResponse({ toolUseId: 't4', approved: true, scope: 'once' }),
    ev.toolCompleted({ toolUseId: 't4', name: 'Edit', success: true, output: 'ok' }),
    ev.executionMetrics({ requestId: 'r1', inputTokens: 12000, outputTokens: 800, providerRequestDurationMs: 900, cacheReadRatio: 0.9 }),
    ev.result({ success: true, message: 'leak fixed' }),
  ],
})
