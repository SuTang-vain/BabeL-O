import { defineFixture, ev } from '../../src/eval/fixtureBuilder.js'

// context_discipline: WARN — agent reads the same file path more than twice.
export default defineFixture({
  id: 'context-repeated-reads-bad',
  description: 'Agent reads the same file 3 times instead of reusing the prior result (context discipline warning).',
  prompt: 'Refactor the module',
  expectChecks: { context_discipline: 'warn' },
  events: [
    ev.sessionStarted({ cwd: '/repo', requestId: 'r1' }),
    ev.taskScopeDeclared({ cwd: '/repo', primaryRoot: '/repo', mode: 'single_root', source: 'cwd' }),
    ev.toolStarted({ toolUseId: 't1', name: 'Read', input: { path: '/repo/src/big.ts' } }),
    ev.toolCompleted({ toolUseId: 't1', name: 'Read', success: true, output: 'contents' }),
    ev.toolStarted({ toolUseId: 't2', name: 'Read', input: { path: '/repo/src/big.ts' } }),
    ev.toolCompleted({ toolUseId: 't2', name: 'Read', success: true, output: 'contents' }),
    ev.toolStarted({ toolUseId: 't3', name: 'Read', input: { path: '/repo/src/big.ts' } }),
    ev.toolCompleted({ toolUseId: 't3', name: 'Read', success: true, output: 'contents' }),
    ev.result({ success: true, message: 'done' }),
  ],
})
