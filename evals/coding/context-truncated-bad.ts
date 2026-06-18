import { defineFixture, ev } from '../../src/eval/fixtureBuilder.js'

// context_discipline: WARN — a single Read returns a large truncated payload.
export default defineFixture({
  id: 'context-truncated-bad',
  description: 'Agent reads a huge file that gets truncated (context discipline warning).',
  prompt: 'Inspect the generated bundle',
  expectChecks: { context_discipline: 'warn' },
  events: [
    ev.sessionStarted({ cwd: '/repo', requestId: 'r1' }),
    ev.taskScopeDeclared({ cwd: '/repo', primaryRoot: '/repo', mode: 'single_root', source: 'cwd' }),
    ev.toolStarted({ toolUseId: 't1', name: 'Read', input: { path: '/repo/dist/bundle.js' } }),
    ev.toolCompleted({ toolUseId: 't1', name: 'Read', success: true, output: '...', truncated: true, originalBytes: 524288 }),
    ev.result({ success: true, message: 'inspected' }),
  ],
})
