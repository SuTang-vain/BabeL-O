import { test } from 'node:test'
import assert from 'node:assert'
import {
  describeCompletionChoice,
  formatCompletionChoice,
  formatPermissionDialog,
  formatSlashPalette,
  getSlashCompletionChoices,
  getSlashPaletteChoices,
  getToolCompletionChoices,
  isSessionPermissionCached,
  mapDropdownSelection,
  sessionPermissionApprovals,
} from '../src/cli/program.js'

test('mapDropdownSelection correctly translates tool shortcuts', () => {
  assert.strictEqual(mapDropdownSelection('/read'), 'read ')
  assert.strictEqual(mapDropdownSelection('/write'), 'write ')
  assert.strictEqual(mapDropdownSelection('/edit'), 'edit ')
  assert.strictEqual(mapDropdownSelection('/grep'), 'grep ')
  assert.strictEqual(mapDropdownSelection('/glob'), 'glob ')
  assert.strictEqual(mapDropdownSelection('/bash'), 'bash ')
  assert.strictEqual(mapDropdownSelection('/task'), 'task ')
  assert.strictEqual(mapDropdownSelection('/tool'), '/tool ')
  assert.strictEqual(mapDropdownSelection('/tool read'), 'read ')
  assert.strictEqual(mapDropdownSelection('/tool bash'), 'bash ')
  assert.strictEqual(mapDropdownSelection('/model'), '/model ')
  assert.strictEqual(mapDropdownSelection('/history'), '/history ')
})

test('mapDropdownSelection preserves control commands', () => {
  assert.strictEqual(mapDropdownSelection('/help'), '/help')
  assert.strictEqual(mapDropdownSelection('/clear'), '/clear')
  assert.strictEqual(mapDropdownSelection('/compact'), '/compact')
  assert.strictEqual(mapDropdownSelection('/context'), '/context')
  assert.strictEqual(mapDropdownSelection('/exit'), '/exit')
  assert.strictEqual(mapDropdownSelection('/status'), '/status')
  assert.strictEqual(mapDropdownSelection('/sessions'), '/sessions')
})

test('mapDropdownSelection preserves unknown inputs', () => {
  assert.strictEqual(mapDropdownSelection('foo'), 'foo')
  assert.strictEqual(mapDropdownSelection('/unknown'), '/unknown')
})

test('tool and slash completion choices expose productized metadata', () => {
  assert.ok(getSlashCompletionChoices().includes('/tool'))
  assert.ok(getSlashCompletionChoices().includes('/compact'))
  assert.ok(getSlashCompletionChoices().includes('/context'))
  assert.ok(getToolCompletionChoices().includes('/tool bash'))

  const bash = describeCompletionChoice('/tool bash')
  assert.strictEqual(bash.tag, 'execute')
  assert.match(bash.description, /shell command/)

  const compact = describeCompletionChoice('/compact')
  assert.strictEqual(compact.tag, 'session')
  assert.match(compact.description, /Compact current session context/)

  const context = describeCompletionChoice('/context')
  assert.strictEqual(context.tag, 'session')
  assert.match(context.description, /Inspect context budget/)

  const formatted = formatCompletionChoice('/tool read', true)
  assert.ok(formatted.includes('/tool read'))
  assert.ok(formatted.includes('[read]'))
})

test('slash palette filters and renders command descriptions', () => {
  const choices = getSlashPaletteChoices('/')
  assert.ok(choices.includes('/help'))
  assert.ok(choices.includes('/tool'))

  const modelChoices = getSlashPaletteChoices('/mo')
  assert.deepStrictEqual(modelChoices, ['/model'])

  const output = formatSlashPalette(['/help', '/tool'], 1, 2)
  assert.ok(output.includes('/help'))
  assert.ok(output.includes('/tool'))
  assert.ok(output.includes('Show command help'))
  assert.ok(output.includes('Open the tool picker'))
  assert.ok(output.includes('Navigate'))
  assert.ok(output.includes('Complete'))
  assert.ok(output.includes('Run'))
})

test('slash palette does not open after command arguments', () => {
  assert.deepStrictEqual(getSlashPaletteChoices('/model '), [])
  assert.deepStrictEqual(getSlashPaletteChoices('hello /'), [])
  assert.deepStrictEqual(getSlashPaletteChoices('/Users/tangyaoyue/DEV/BABEL/BabeL-O'), [])
  assert.deepStrictEqual(getSlashPaletteChoices('/tmp/foo'), [])
  assert.deepStrictEqual(getSlashPaletteChoices('/tool/read'), [])
})

test('formatPermissionDialog renders multi-level approval choices', () => {
  const output = formatPermissionDialog(
    {
      name: 'Bash',
      risk: 'execute',
      input: { command: 'npm test' },
    },
    [
      { id: 'approve_once', label: 'Approve once' },
      { id: 'approve_session', label: 'Approve for this session' },
      { id: 'approve_rule', label: 'Approve with editable rule' },
      { id: 'reject', label: 'Reject' },
      { id: 'reject_instruct', label: 'Reject, tell the model what to do instead' },
    ],
    1,
  )

  assert.ok(output.includes('approval'))
  assert.ok(output.includes('Bash is requesting approval'))
  assert.ok(output.includes('npm test'))
  assert.ok(output.includes('Suggested rule:'))
  assert.ok(output.includes('npm test:*'))
  assert.ok(output.includes('[1] Approve once'))
  assert.ok(output.includes('[2] Approve for this session'))
  assert.ok(output.includes('[3] Approve with editable rule'))
  assert.ok(output.includes('[4] Reject'))
  assert.ok(output.includes('[5] Reject, tell the model what to do instead'))
  assert.ok(output.includes('▲/▼ select'))
  assert.ok(output.includes('1/2/3/4/5 choose'))
})

test('session permission rules only match the approved command prefix', () => {
  const sessionId = 'session-permission-rule'
  sessionPermissionApprovals.set(sessionId, new Set(['Bash:npm test:*']))
  try {
    assert.equal(
      isSessionPermissionCached(sessionId, {
        name: 'Bash',
        input: { command: 'npm test -- --runInBand' },
      }),
      true,
    )
    assert.equal(
      isSessionPermissionCached(sessionId, {
        name: 'Bash',
        input: { command: 'npm install left-pad' },
      }),
      false,
    )
    assert.equal(
      isSessionPermissionCached(sessionId, {
        name: 'Write',
        input: { path: 'package.json' },
      }),
      false,
    )
  } finally {
    sessionPermissionApprovals.delete(sessionId)
  }
})
