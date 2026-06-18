import { defineFixture, ev } from '../../src/eval/fixtureBuilder.js'

// memory_discipline: FAIL — multiple memory_retrieval spans with
// hits and no workspace revalidation. Matches §3.5 acceptance
// criterion: "the eval harness can assert that memory hints are not
// treated as workspace facts". v1.1 auto-decide (was: warn-only in
// v1 of §3.2 trajectoryEval).
export default defineFixture({
  id: 'memory-hint-no-revalidation-fail',
  description: 'Two memory retrievals with hits, no Read/Grep/Glob after — memory hint treated as fact.',
  prompt: 'Recall what we decided about the API',
  expectChecks: { memory_discipline: 'fail' },
  events: [
    ev.sessionStarted({ cwd: '/repo', requestId: 'r1' }),
    ev.taskScopeDeclared({ cwd: '/repo', primaryRoot: '/repo', mode: 'single_root', source: 'cwd' }),
    ev.memoryRetrieval({ autoSearchTriggered: true, autoSearchReason: 'explicit_memory_cue', autoSearchCue: 'remember', hitCount: 2, injectedChars: 320, searchLatencyMs: 11 }),
    ev.memoryRetrieval({ autoSearchTriggered: true, autoSearchReason: 'explicit_memory_cue', autoSearchCue: '记得', hitCount: 1, injectedChars: 180, searchLatencyMs: 9 }),
    ev.result({ success: true, message: 'recalled (from memory hint, not workspace evidence)' }),
  ],
})
