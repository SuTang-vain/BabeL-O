import { test } from 'node:test'
import assert from 'node:assert'
import { visibleTerminalWidth } from '../src/cli/terminalWidth.js'
import {
  describeCompletionChoice,
  formatCompletionChoice,
  encodeSessionPermissionRule,
  formatPermissionDialog,
  formatSlashPalette,
  getSlashCompletionChoices,
  getSlashPaletteChoices,
  getToolCompletionChoices,
  isSessionPermissionCached,
  mapDropdownSelection,
  sessionPermissionApprovals,
} from '../src/cli/program.js'
import { formatToolAudit } from '../src/cli/toolAuditFormatter.js'

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
  assert.strictEqual(mapDropdownSelection('/agentloop-smoke'), '/agentloop-smoke')
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
  assert.ok(getSlashCompletionChoices().includes('/agentloop-smoke'))
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

  const agentLoopSmoke = describeCompletionChoice('/agentloop-smoke')
  assert.strictEqual(agentLoopSmoke.tag, 'agent')
  assert.match(agentLoopSmoke.description, /AgentLoop sub-agent hierarchy/)

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

  const output = formatSlashPalette(['/help', '/tool'], 1, 2, 'MiniMax M3')
  const overlayOutput = formatSlashPalette(['/help'], 0, 1, 'MiniMax M3', { showSeparator: false })
  const longOutput = formatSlashPalette(['/agentloop-smoke'], 0, 1, 'MiniMax M3')
  assert.ok(output.startsWith('─'))
  assert.ok(!overlayOutput.startsWith('─'))
  assert.ok(output.includes('/help'))
  assert.ok(output.includes('/tool'))
  assert.ok(output.includes('Show command help'))
  assert.ok(output.includes('Open the tool picker'))
  assert.match(longOutput, /\/agentloop-smoke\s{8,}Render mock AgentLoop sub-agent hierarchy/)
  const longLines = longOutput.split('\n')
  assert.ok(!longLines.find(line => line.includes('/agentloop-smoke'))?.includes('MiniMax M3'))
  assert.ok(longLines.some(line => line.includes('Navigate')))
  assert.ok(longLines.some(line => line.includes('MiniMax M3')))
  assert.ok(output.includes('Navigate'))
  assert.ok(output.includes('Complete'))
  assert.ok(output.includes('Run'))
})

test('slash palette adapts to narrow terminals', () => {
  const output = formatSlashPalette(
    ['/agentloop-smoke', '/bash', '/context'],
    0,
    3,
    'Gemini 3.5 Flash (High)',
    { columns: 42 },
  )
  const lines = output.split('\n').filter(line => line.length > 0)

  assert.ok(lines.every(line => visibleTerminalWidth(line) < 42), output)
  assert.match(output, /Render mock AgentL…/)
  assert.ok(lines.some(line => line.includes('↑/↓')))
  assert.ok(lines.some(line => line.includes('esc to cancel')))
  assert.ok(lines.some(line => line.includes('Gemini')))
})

test('slash palette renders upward scroll indicator above commands', () => {
  const output = formatSlashPalette(
    ['/agentloop-smoke', '/bash', '/clear', '/compact', '/context', '/e', '/edit', '/editor', '/exit', '/fallback', '/glob', '/grep', '/write'],
    11,
    25,
    'MiniMax M3',
    { columns: 84, showSeparator: false },
  )
  const lines = output.split('\n').filter(line => line.length > 0)

  assert.match(lines[0]!, /↑ \d+ more/)
  assert.ok(lines.findIndex(line => line.includes('↑') && line.includes('more')) < lines.findIndex(line => line.includes('/context')))
})

test('slash palette avoids terminal edge auto-wrap', () => {
  const output = formatSlashPalette(['/context', '/grep'], 1, 20, 'MiniMax M3', { columns: 84 })
  const lines = output.split('\n').filter(line => line.length > 0)

  assert.ok(lines.every(line => visibleTerminalWidth(line) < 84), output)
  assert.ok(lines.some(line => line.includes('Navigate')))
  assert.ok(lines.some(line => line.includes('MiniMax M3')))
})

test('slash palette does not open after command arguments', () => {
  assert.deepStrictEqual(getSlashPaletteChoices('/model '), [])
  assert.deepStrictEqual(getSlashPaletteChoices('hello /'), [])
  assert.deepStrictEqual(getSlashPaletteChoices('/Users/tangyaoyue/DEV/BABEL/BabeL-O'), [])
  assert.deepStrictEqual(getSlashPaletteChoices('/tmp/foo'), [])
  assert.deepStrictEqual(getSlashPaletteChoices('/tool/read'), [])
})

test('formatToolAudit renders compact MCP metadata without raw schema', () => {
  const output = formatToolAudit({
    type: 'tools_audit',
    tools: [
      {
        name: 'Read',
        description: 'Read a file',
        risk: 'read',
        allowed: true,
        inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
        source: { type: 'builtin' },
      },
      {
        name: 'mcp:mock:secretWrite',
        description: 'Pretend to write something.',
        risk: 'write',
        allowed: true,
        inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
        source: { type: 'mcp', serverName: 'mock', originalName: 'secretWrite' },
        requiresApproval: true,
        suggestedAllowRule: 'mcp:mock:secretWrite',
        mcpServerAllowed: false,
      },
    ],
  })

  assert.ok(output.includes('builtin: 1 · mcp: 1'))
  assert.ok(output.includes('mock.secretWrite'))
  assert.ok(output.includes('registered=mcp:mock:secretWrite'))
  assert.ok(output.includes('write risk'))
  assert.ok(output.includes('policy enabled'))
  assert.ok(output.includes('server disabled'))
  assert.ok(output.includes('approval required'))
  assert.ok(output.includes('allow mcp:mock:secretWrite'))
  assert.ok(output.includes('MCP resources:'))
  assert.ok(!output.includes('inputSchema'))
  assert.ok(!output.includes('properties'))
  assert.ok(!output.includes('path:'))
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

test('formatPermissionDialog renders MCP source identity and allow rule', () => {
  const output = formatPermissionDialog(
    {
      name: 'mcp:mock:secretWrite',
      risk: 'write',
      input: { path: 'secrets.txt' },
      source: {
        type: 'mcp',
        serverName: 'mock',
        originalName: 'secretWrite',
      },
    },
    [
      { id: 'approve_once', label: 'Approve once' },
      { id: 'approve_session', label: 'Approve for this session' },
      { id: 'approve_rule', label: 'Approve with editable rule' },
      { id: 'reject', label: 'Reject' },
      { id: 'reject_instruct', label: 'Reject, tell the model what to do instead' },
    ],
    2,
  )

  assert.ok(output.includes('mcp:mock:secretWrite is requesting approval'))
  assert.ok(output.includes('Source:'))
  assert.ok(output.includes('mcp/mock'))
  assert.ok(output.includes('secretWrite'))
  assert.ok(output.includes('Suggested rule:'))
  assert.ok(output.includes('mcp:mock:secretWrite'))
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

test('session permission rules support MCP tool names with colons', () => {
  const sessionId = 'session-mcp-permission-rule'
  sessionPermissionApprovals.set(sessionId, new Set([
    encodeSessionPermissionRule('mcp:mock:secretWrite', 'mcp:mock:secretWrite'),
  ]))
  try {
    assert.equal(
      isSessionPermissionCached(sessionId, {
        name: 'mcp:mock:secretWrite',
        input: { path: 'secrets.txt' },
      }),
      true,
    )
    assert.equal(
      isSessionPermissionCached(sessionId, {
        name: 'mcp:mock:echo',
        input: { message: 'hello' },
      }),
      false,
    )
  } finally {
    sessionPermissionApprovals.delete(sessionId)
  }
})
