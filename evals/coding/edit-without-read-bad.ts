import { defineFixture, ev } from '../../src/eval/fixtureBuilder.js'

// tool_discipline: FAIL — agent edits a file without reading or searching first.
export default defineFixture({
  id: 'edit-without-read-bad',
  description: 'Agent edits a file with no prior read/search (tool discipline violated).',
  prompt: 'Fix the typo in src/config.ts',
  expectChecks: { tool_discipline: 'fail' },
  events: [
    ev.sessionStarted({ cwd: '/repo', requestId: 'r1' }),
    ev.taskScopeDeclared({ cwd: '/repo', primaryRoot: '/repo', mode: 'single_root', source: 'cwd' }),
    ev.toolStarted({ toolUseId: 't1', name: 'Edit', input: { path: '/repo/src/config.ts' } }),
    ev.permissionRequest({ toolUseId: 't1', name: 'Edit', risk: 'write' }),
    ev.permissionResponse({ toolUseId: 't1', approved: true, scope: 'once' }),
    ev.toolCompleted({ toolUseId: 't1', name: 'Edit', success: true, output: 'ok' }),
    ev.result({ success: true, message: 'fixed' }),
  ],
})
