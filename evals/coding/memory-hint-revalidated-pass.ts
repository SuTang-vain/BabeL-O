import { defineFixture, ev } from '../../src/eval/fixtureBuilder.js'

// memory_discipline: PASS — memory retrieval returned a hint, the
// agent revalidated with a workspace Read afterwards. The answer
// was grounded in workspace evidence even though memory was
// consulted. §3.5 acceptance: the eval harness auto-decides
// "revalidated" is pass (not just "no memory events").
export default defineFixture({
  id: 'memory-hint-revalidated-pass',
  description: 'Memory retrieval with hit, followed by a workspace Read — hint consulted but revalidated.',
  prompt: 'Recall what we decided about the API',
  expectChecks: { memory_discipline: 'pass' },
  events: [
    ev.sessionStarted({ cwd: '/repo', requestId: 'r1' }),
    ev.taskScopeDeclared({ cwd: '/repo', primaryRoot: '/repo', mode: 'single_root', source: 'cwd' }),
    ev.memoryRetrieval({ autoSearchTriggered: true, autoSearchReason: 'explicit_memory_cue', autoSearchCue: 'remember', hitCount: 1, injectedChars: 180, searchLatencyMs: 9 }),
    ev.toolStarted({ toolUseId: 't1', name: 'Read', input: { path: '/repo/docs/api.md' } }),
    ev.toolCompleted({ toolUseId: 't1', name: 'Read', success: true, output: 'contents' }),
    ev.result({ success: true, message: 'recalled (revalidated against /repo/docs/api.md)' }),
  ],
})
