import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeKeyEvent, isMouseSequence, terminalMouseDisableSequence } from '../src/cli/keyEvent.js'
import { consumePasteChunk, createPasteBufferState, flushPasteBuffer } from '../src/cli/pasteBuffer.js'
import { createPermissionPanelState, reducePermissionPanelKey } from '../src/cli/permissionPanel.js'
import { helpCategories } from '../src/cli/helpPanel.js'
import { visibleTerminalWidth, truncateToTerminalWidth } from '../src/cli/terminalWidth.js'
import { formatWelcomeCardLines } from '../src/cli/welcome.js'
import { renderFixedInputBox } from '../src/cli/inputBox.js'
import { inputState, type InputMode } from '../src/cli/inputState.js'
import { defaultPermissionChoices, permissionDecisionFromChoice, setupAutosuggestions } from '../src/cli/ui.js'

test('normalizeKeyEvent classifies terminal keys consistently', () => {
  assert.equal(normalizeKeyEvent('\x03', undefined).kind, 'ctrl_c')
  assert.equal(normalizeKeyEvent(Buffer.from('\x05'), undefined).kind, 'ctrl_e')
  assert.equal(normalizeKeyEvent('\x0f', undefined).kind, 'ctrl_o')
  assert.equal(normalizeKeyEvent('\r', undefined).kind, 'enter')
  assert.equal(normalizeKeyEvent('\x1b', undefined).kind, 'escape')
  assert.equal(normalizeKeyEvent('\x7f', undefined).kind, 'backspace')
  assert.equal(normalizeKeyEvent('\t', undefined).kind, 'tab')
  assert.equal(normalizeKeyEvent('\x1b[A', undefined).kind, 'up')
  assert.equal(normalizeKeyEvent('\x1b[B', undefined).kind, 'down')
  assert.equal(normalizeKeyEvent('', { name: 'right' }).kind, 'right')
  assert.deepEqual(
    { kind: normalizeKeyEvent('4', undefined).kind, digit: normalizeKeyEvent('4', undefined).digit },
    { kind: 'digit', digit: 4 },
  )
})

test('normalizeKeyEvent identifies mouse reports before readline sees arrows', () => {
  assert.equal(isMouseSequence('\x1b[<64;10;5M'), true)
  assert.equal(isMouseSequence('\x1b[M```'), true)
  assert.equal(isMouseSequence('\x1b[64;10;5M'), true)
  assert.equal(normalizeKeyEvent('\x1b[<65;10;5M', undefined).kind, 'mouse')
})

test('terminal mouse mode stays disabled so native scrollback works', () => {
  assert.equal(terminalMouseDisableSequence(), '\x1b[?1006l\x1b[?1000l')
  assert.equal(terminalMouseDisableSequence().includes('?1000h'), false)
  assert.equal(terminalMouseDisableSequence().includes('?1006h'), false)
})

test('consumePasteChunk parses complete and split bracketed paste sequences', () => {
  let state = createPasteBufferState()
  let result = consumePasteChunk(state, '\x1b[200~hello\nworld\x1b[201~')
  assert.equal(result.consumed, true)
  assert.equal(result.pastedText, 'hello\nworld')
  assert.equal(result.state.isPasting, false)

  state = createPasteBufferState()
  result = consumePasteChunk(state, '\x1b[200~part1 ')
  assert.equal(result.consumed, true)
  assert.equal(result.pastedText, undefined)
  assert.equal(result.state.isPasting, true)

  result = consumePasteChunk(result.state, 'part2\npart3')
  assert.equal(result.pastedText, undefined)
  assert.equal(result.state.isPasting, true)

  result = consumePasteChunk(result.state, ' done\x1b[201~')
  assert.equal(result.pastedText, 'part1 part2\npart3 done')
  assert.equal(result.state.isPasting, false)
})

test('flushPasteBuffer emits partial paste when terminal omits end marker', () => {
  const active = consumePasteChunk(createPasteBufferState(), '\x1b[200~partial paste')
  assert.equal(active.state.isPasting, true)
  const flushed = flushPasteBuffer(active.state)
  assert.equal(flushed.consumed, true)
  assert.equal(flushed.pastedText, 'partial paste')
  assert.equal(flushed.state.isPasting, false)
})

test('permission panel reducer rejects on escape and backspace without approving', () => {
  let state = createPermissionPanelState()
  let reduced = reducePermissionPanelKey(state, normalizeKeyEvent('\x1b', undefined))
  assert.deepEqual(reduced.action, { type: 'finish', choiceIndex: 3 })

  state = createPermissionPanelState()
  reduced = reducePermissionPanelKey(state, normalizeKeyEvent('\x7f', undefined))
  assert.deepEqual(reduced.action, { type: 'finish', choiceIndex: 3 })
})

test('permission panel reducer supports navigation, numeric choices, enter, and abort', () => {
  let state = createPermissionPanelState()
  let reduced = reducePermissionPanelKey(state, normalizeKeyEvent('\x1b[B', undefined))
  assert.equal(reduced.state.activeIndex, 1)
  assert.deepEqual(reduced.action, { type: 'redraw' })

  state = reduced.state
  reduced = reducePermissionPanelKey(state, normalizeKeyEvent('\r', undefined))
  assert.deepEqual(reduced.action, { type: 'finish', choiceIndex: 1 })

  reduced = reducePermissionPanelKey(createPermissionPanelState(), normalizeKeyEvent('5', undefined))
  assert.deepEqual(reduced.action, { type: 'finish', choiceIndex: 4 })

  reduced = reducePermissionPanelKey(createPermissionPanelState(), normalizeKeyEvent('\x03', undefined))
  assert.deepEqual(reduced.action, { type: 'abort' })
})

test('permission panel keyboard paths map to safe approval decisions', () => {
  const select = (raw: string) => {
    const reduced = reducePermissionPanelKey(createPermissionPanelState(), normalizeKeyEvent(raw, undefined))
    assert.equal(reduced.action.type, 'finish')
    if (reduced.action.type !== 'finish') throw new Error('unreachable')
    return defaultPermissionChoices[reduced.action.choiceIndex]!.id
  }

  assert.deepEqual(permissionDecisionFromChoice(select('1')), { approved: true, scope: 'once' })
  assert.deepEqual(permissionDecisionFromChoice(select('2')), { approved: true, scope: 'session' })
  assert.equal(permissionDecisionFromChoice(select('3')), 'needs_rule_input')
  assert.deepEqual(permissionDecisionFromChoice('approve_rule', { rule: 'npm test:*' }), {
    approved: true,
    scope: 'session',
    reason: 'Approved with rule: npm test:*',
    rule: 'npm test:*',
  })
  assert.deepEqual(permissionDecisionFromChoice(select('4')), { approved: false, scope: 'once', reason: 'Denied by user' })
  assert.equal(permissionDecisionFromChoice(select('5')), 'needs_reject_instruction')
  assert.deepEqual(permissionDecisionFromChoice('reject_instruct', { reason: 'Use Read instead' }), {
    approved: false,
    scope: 'once',
    reason: 'Use Read instead',
  })
})

test('help panel command list only includes chat-supported slash entries', () => {
  const unsupported = new Set(['/new', '/resume <id>', '/tasks', '/delegate', '/config', '/models', '/provider', '/optimize', '/review', '/nexus', '/quit'])
  const commands = helpCategories.flatMap(category => category.items.map(item => item.command))
  for (const command of commands) {
    assert.equal(unsupported.has(command), false, `${command} should not be advertised in chat help`)
  }
  assert.ok(commands.includes('/sessions'))
  assert.ok(commands.includes('/history [query]'))
  assert.ok(commands.includes('/smoke live'))
  assert.ok(commands.includes('/editor'))
})

test('terminal width helpers count CJK and truncate by terminal cells', () => {
  assert.equal(visibleTerminalWidth('颜色要求'), 8)
  assert.equal(visibleTerminalWidth('\x1b[31m颜色\x1b[0m'), 4)
  assert.equal(truncateToTerminalWidth('颜色要求-abc', 5), '颜色')
})

test('welcome card aligns borders when content contains ANSI and long model names', () => {
  const lines = formatWelcomeCardLines({
    cwd: '/Users/tangyaoyue/DEV/BABEL/BabeL-O',
    modelId: 'minimax/MiniMax-M2.7-highspeed',
  })
  const widths = lines.map(line => visibleTerminalWidth(line))
  assert.ok(widths.length > 2)
  assert.equal(new Set(widths).size, 1)
})

test('fixed input box keeps long path input on one terminal row', () => {
  const line = '/Users/tangyaoyue/DEV/Baidu/app-bvh8xpid> /Users/tangyaoyue/DEV/BABEL/BabeL-O查看并'
  const rendered = renderFixedInputBox({
    prompt: '> ',
    line,
    cursor: line.length,
    columns: 50,
  })
  assert.equal(rendered.truncated, true)
  assert.ok(visibleTerminalWidth(rendered.text) <= 50)
  assert.ok(rendered.cursorColumn < 50)
})

test('fixed input box only renders autosuggestion when it fits', () => {
  const short = renderFixedInputBox({
    prompt: '> ',
    line: '/he',
    cursor: 3,
    suggestion: '/help',
    columns: 20,
  })
  assert.equal(short.renderedSuggestion, true)
  assert.ok(short.text.includes('lp'))

  const long = renderFixedInputBox({
    prompt: '> ',
    line: '/Users/tangyaoyue/DEV/Baidu/app-bvh8xpid',
    cursor: '/Users/tangyaoyue/DEV/Baidu/app-bvh8xpid'.length,
    suggestion: '/Users/tangyaoyue/DEV/Baidu/app-bvh8xpid/very-long-child-path',
    columns: 30,
  })
  assert.equal(long.renderedSuggestion, false)
  assert.ok(visibleTerminalWidth(long.text) <= 30)
})

test('input state keeps readline as the only text owner while overlays are open', () => {
  const overlayModes: InputMode[] = [
    'slashPalette',
    'toolPalette',
    'permissionPanel',
    'historySearch',
    'modelWizard',
    'pasteBuffer',
  ]

  try {
    for (const mode of overlayModes) {
      inputState.set(mode, { source: 'smoke' })
      assert.equal(inputState.isOverlayOpen(), true, `${mode} should block secondary input handling`)
    }

    inputState.set('agentRunning')
    assert.equal(inputState.isOverlayOpen(), false, 'agentRunning is a status indicator, not a second input owner')
  } finally {
    inputState.set('idle')
  }
})

test('autosuggestion refresh preserves secondary readline prompts', () => {
  const writes: string[] = []
  const originalWrite = process.stdout.write
  const originalCursorTo = process.stdout.cursorTo
  process.stdout.write = ((chunk: any, ...args: any[]) => {
    writes.push(String(chunk))
    return true
  }) as typeof process.stdout.write
  ;(process.stdout as any).cursorTo = () => true

  const rl: any = {
    _prompt: '> ',
    line: '',
    cursor: 0,
  }
  try {
    setupAutosuggestions(rl as any, [], { current: false })
    rl._prompt = 'Enter allow rule prefix (default: node:*): '
    rl.line = 'node:*'
    rl.cursor = rl.line.length
    rl._refreshLine()
  } finally {
    process.stdout.write = originalWrite
    ;(process.stdout as any).cursorTo = originalCursorTo
  }

  const output = writes.join('')
  assert.ok(output.includes('Enter allow rule prefix (default: node:*): node:*'))
  assert.ok(!output.includes('BabeL-O'))
})
