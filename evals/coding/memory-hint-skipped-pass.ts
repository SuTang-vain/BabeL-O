import { defineFixture, ev } from '../../src/eval/fixtureBuilder.js'

// memory_discipline: PASS — auto-search did not fire; the agent
// correctly skipped memory (e.g. a "run tests" prompt with no
// memory cue). §3.5 metric 1 surface: dashboard can read the
// "no_memory_cue" reason distribution from this pattern.
export default defineFixture({
  id: 'memory-hint-skipped-pass',
  description: 'Auto-search skipped (no memory cue); agent answered without consulting long-term memory.',
  prompt: 'npm run typecheck',
  expectChecks: { memory_discipline: 'pass' },
  events: [
    ev.sessionStarted({ cwd: '/repo', requestId: 'r1' }),
    ev.taskScopeDeclared({ cwd: '/repo', primaryRoot: '/repo', mode: 'single_root', source: 'cwd' }),
    ev.memoryRetrieval({ autoSearchTriggered: false, autoSearchReason: 'execution_status_only' }),
    ev.toolStarted({ toolUseId: 't1', name: 'Bash', input: { command: 'npm run typecheck' } }),
    ev.toolCompleted({ toolUseId: 't1', name: 'Bash', success: true, output: 'ok' }),
    ev.result({ success: true, message: 'typecheck clean' }),
  ],
})
