import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeKeyEvent, isMouseSequence, terminalMouseDisableSequence } from '../src/cli/keyEvent.js'
import { consumePasteChunk, createPasteBufferState, expandPastedTextPlaceholders, flushPasteBuffer, formatPastedTextPlaceholder } from '../src/cli/pasteBuffer.js'
import { createPermissionPanelState, reducePermissionPanelKey } from '../src/cli/permissionPanel.js'
import { helpCategories } from '../src/cli/helpPanel.js'
import readline from 'node:readline'
import chalk from 'chalk'
import { visibleTerminalWidth, truncateToTerminalWidth } from '../src/cli/terminalWidth.js'
import { formatSessionBanner, formatWelcomeCardLines, formatWelcomeHintLine } from '../src/cli/welcome.js'
import { INPUT_NEWLINE_MARKER, formatInputFooter, renderBoxedInput, renderFixedInputBox, restoreInputNewlines, shouldClearInputGhostBeforeWrite, shouldConsumeBlankInputEnter } from '../src/cli/inputBox.js'
import { inputState, type InputMode } from '../src/cli/inputState.js'
import { defaultPermissionChoices, permissionDecisionFromChoice, renderSubmittedPrompt, setupAutosuggestions } from '../src/cli/ui.js'
import { getPromptSuggestion } from '../src/cli/promptSuggestions.js'
import { getTheme, resetThemeForTest } from '../src/cli/theme.js'
import { getLiveAgentTree, resetLiveAgentTreeForTest, updateLiveAgentActivity, renderEvent } from '../src/cli/renderEvents.js'
import { createVimInputState, reduceVimInputKey } from '../src/cli/vimMode.js'
import { createInboxOverlayState, formatInboxFooterStatus, quoteInboxMessage, reduceInboxOverlayKey, renderInboxEventCard, renderInboxOverlay, shouldRenderInboxEventCard } from '../src/cli/inboxOverlay.js'
import type { SessionChannel, SessionMessage } from '../src/shared/sessionChannel.js'

test('normalizeKeyEvent classifies terminal keys consistently', () => {
  assert.equal(normalizeKeyEvent('\x03', undefined).kind, 'ctrl_c')
  assert.equal(normalizeKeyEvent(Buffer.from('\x05'), undefined).kind, 'ctrl_e')
  assert.equal(normalizeKeyEvent('\x0f', undefined).kind, 'ctrl_o')
  assert.equal(normalizeKeyEvent('\r', undefined).kind, 'enter')
  assert.equal(normalizeKeyEvent('\x1b[13;2u', undefined).kind, 'shift_enter')
  assert.equal(normalizeKeyEvent('', { name: 'return', shift: true }).kind, 'shift_enter')
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

test('pasted text placeholders compress display and expand before submission', () => {
  const pasted = 'line one\nline two\nline three'
  const placeholder = formatPastedTextPlaceholder(9, pasted)
  const replacements = new Map([[placeholder, pasted]])

  assert.equal(placeholder, '[Pasted text #9 +3 lines]')
  assert.equal(
    expandPastedTextPlaceholders(`analyze ${placeholder} now`, replacements),
    `analyze ${pasted} now`,
  )
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

test('terminal width helpers keep long path CJK and ANSI rows within resize bounds', () => {
  const ansiPath = '\x1b[36m/Users/tangyaoyue/DEV/BABEL/BabeL-O/src/cli/renderEvents.ts\x1b[0m 继续分析中文路径状态'
  const truncated = truncateToTerminalWidth(ansiPath, 48)

  assert.ok(visibleTerminalWidth(truncated) <= 48)
  assert.ok(truncated.includes('/Users/tangyaoyue/DEV/BABEL'))
  assert.equal(visibleTerminalWidth('\x1b[35m历史搜索\x1b[0m'), 8)
})

test('welcome header keeps required identity info without outer box', () => {
  const lines = formatWelcomeCardLines({
    cwd: '/Users/tangyaoyue/DEV/BABEL/BabeL-O',
    modelId: 'minimax/MiniMax-M2.7-highspeed',
    columns: 80,
  })
  const joined = lines.join('\n')

  assert.ok(lines.length > 2)
  assert.match(joined, /❖ BABEL-O/)
  assert.match(joined, /v\d+\.\d+\.\d+/)
  assert.match(joined, /MiniMax-M2\.7-highspeed/)
  assert.match(joined, /BabeL-O/)
  assert.match(joined, /Embedded \(Local\)/)
  assert.equal(lines.some(line => line.includes('┌')), false)
  assert.equal(lines.some(line => line.includes('└')), false)
  assert.equal(lines.some(line => line.includes('│')), false)
  assert.ok(lines.every(line => visibleTerminalWidth(line) <= 80))
})

test('welcome header supports dev title override', () => {
  const lines = formatWelcomeCardLines({
    cwd: '/Users/tangyaoyue/DEV/BABEL/BabeL-O',
    modelId: 'local/coding-runtime',
    title: 'dev',
    columns: 80,
  })
  const joined = lines.join('\n')

  assert.match(joined, /❖ BABEL-O/)
  assert.match(joined, /dev/)
  assert.doesNotMatch(joined, /v\d+\.\d+\.\d+/)
})

test('welcome hint and session banners stay compact', () => {
  const hint = formatWelcomeHintLine(80)
  assert.match(hint, /\?/)
  assert.match(hint, /\/ commands/)
  assert.match(hint, /Ctrl\+O/)
  assert.doesNotMatch(hint, /│/)
  assert.ok(visibleTerminalWidth(hint) <= 80)

  assert.match(formatSessionBanner('started', 'session_abc123'), /session session_abc123/)
  assert.match(formatSessionBanner('resuming', 'session_abc123'), /resume session_abc123/)
  assert.doesNotMatch(formatSessionBanner('started', 'session_abc123'), /Started new session/)
})

test('boxed input renders separator prompt and footer model line', () => {
  const rendered = renderBoxedInput({
    prompt: '> ',
    line: '',
    cursor: 0,
    placeholder: '',
    modelId: 'gemini/gemini-3.5-flash-medium',
    columns: 84,
  })
  const lines = rendered.text.split(/\r?\n/)

  assert.match(rendered.text, /\r\n/)
  assert.equal(lines.length, 4)
  assert.equal(lines[0], '─'.repeat(83))
  assert.equal(lines[1], '> ')
  assert.equal(lines[2], '─'.repeat(83))
  assert.match(lines[3]!, /\? for shortcuts/)
  assert.match(lines[3]!, /Gemini 3\.5 Flash \(Medium\)/)
  assert.equal(rendered.cursorRow, 1)
  assert.equal(rendered.cursorRowsFromBottom, 2)
  assert.equal(rendered.cursorColumn, 2)
})

test('boxed input footer renders inbox unread indicator without dropping model label', () => {
  const rendered = renderBoxedInput({
    prompt: '> ',
    line: '',
    cursor: 0,
    placeholder: '',
    modelId: 'local/coding-runtime',
    footerStatus: 'linked sessions: 2 · inbox: 3 unread · channels: parent_child 1/workspace_pair 1 · high: handoff',
    columns: 84,
  })
  const lines = rendered.text.split(/\r?\n/)

  assert.match(lines[3]!, /\? for shortcuts/)
  assert.match(lines[3]!, /linked sessions: 2/)
  assert.match(lines[3]!, /Embedded Local/)
  assert.ok(visibleTerminalWidth(lines[3]!) <= 83)
})

test('inbox footer status summarizes linked sessions unread count channel kind and key message', () => {
  const status = formatInboxFooterStatus({
    sessionId: 'session-b',
    channels: [createInboxChannel()],
    messages: [createInboxMessage()],
  })

  assert.match(status, /linked sessions: 1/)
  assert.match(status, /inbox: 1 unread/)
  assert.match(status, /channels: workspace_pair 1/)
  assert.match(status, /high: handoff/)
})

test('inbox overlay renders collaboration boundary evidence and governance summary', () => {
  const state = createInboxOverlayState({
    sessionId: 'session-b',
    channels: [createInboxChannel()],
    messages: [createInboxMessage({
      type: 'memory_candidate',
      metadata: {
        memoryCandidateGovernance: {
          decision: 'requires_approval',
          scope: 'project',
          autoWrite: false,
          approval: { status: 'required', requiredBy: 'user' },
          blockedReasons: [],
        },
      },
    })],
  })
  const rendered = renderInboxOverlay(state, { rows: 18, columns: 96 })

  assert.match(rendered, /BABEL Inbox/)
  assert.match(rendered, /Collaboration context only/)
  assert.match(rendered, /not direct user instructions/)
  assert.match(rendered, /memory_candidate/)
  assert.match(rendered, /kind=workspace_pair/)
  assert.match(rendered, /file:src\/runtime\/contextAssembler\.ts/)
  assert.match(rendered, /decision=requires_approval scope=project approval=required:user auto_write=false/)
  assert.ok(rendered.split('\n').every(line => visibleTerminalWidth(line) <= 95))
})

test('inbox overlay reducer supports navigation ack quote and close without editing readline text', () => {
  const state = createInboxOverlayState({
    sessionId: 'session-b',
    messages: [createInboxMessage({ messageId: 'msg-1' }), createInboxMessage({ messageId: 'msg-2', type: 'blocked' })],
  })

  let reduced = reduceInboxOverlayKey(state, normalizeKeyEvent('\x1b[B', undefined))
  assert.equal(reduced.state.selectedIndex, 1)
  assert.deepEqual(reduced.action, { type: 'redraw' })

  reduced = reduceInboxOverlayKey(reduced.state, normalizeKeyEvent('a', undefined))
  assert.deepEqual(reduced.action, { type: 'ack', messageId: 'msg-2' })

  reduced = reduceInboxOverlayKey(reduced.state, normalizeKeyEvent('q', undefined))
  assert.equal(reduced.action.type, 'quote')
  if (reduced.action.type !== 'quote') throw new Error('unreachable')
  assert.equal(reduced.action.messageId, 'msg-2')
  assert.match(reduced.action.text, /Use this SessionChannel inbox context only after verifying evidence/)
  assert.match(reduced.action.text, /content:/)

  reduced = reduceInboxOverlayKey(reduced.state, normalizeKeyEvent('\x1b', undefined))
  assert.deepEqual(reduced.action, { type: 'close' })
})

test('inbox event cards only render key unread side-channel messages', () => {
  assert.equal(shouldRenderInboxEventCard(createInboxMessage({ type: 'handoff', priority: 'normal' })), true)
  assert.equal(shouldRenderInboxEventCard(createInboxMessage({ type: 'blocked', priority: 'low' })), true)
  assert.equal(shouldRenderInboxEventCard(createInboxMessage({ type: 'request_review', priority: 'normal' })), true)
  assert.equal(shouldRenderInboxEventCard(createInboxMessage({ type: 'request_validation', priority: 'normal' })), true)
  assert.equal(shouldRenderInboxEventCard(createInboxMessage({ type: 'finding', priority: 'high' })), true)
  assert.equal(shouldRenderInboxEventCard(createInboxMessage({ type: 'finding', priority: 'normal' })), false)
  assert.equal(shouldRenderInboxEventCard(createInboxMessage({ type: 'question', priority: 'high' })), false)
  assert.equal(shouldRenderInboxEventCard(createInboxMessage({ status: 'acknowledged', acknowledgedAt: '2026-06-08T00:00:02.000Z' })), false)

  assert.equal(shouldRenderInboxEventCard(createInboxMessage({
    type: 'memory_candidate',
    priority: 'normal',
    metadata: {
      memoryCandidateGovernance: {
        decision: 'requires_approval',
        approval: { status: 'required', requiredBy: 'user' },
      },
    },
  })), true)
})

test('inbox event card renders compact action hints without transcript injection', () => {
  const card = renderInboxEventCard(createInboxMessage({
    type: 'memory_candidate',
    content: 'User prefers concise Chinese summaries.',
    metadata: {
      memoryCandidateGovernance: {
        decision: 'rejected',
        scope: 'user',
        autoWrite: false,
        approval: { status: 'rejected', requiredBy: 'user' },
        blockedReasons: ['missing_evidence_refs'],
      },
    },
  }), {
    channel: createInboxChannel(),
    columns: 96,
  })

  assert.match(card, /SessionChannel memory_candidate · high · from=session-a · to=session-b/)
  assert.match(card, /channel=channel-1 kind=workspace_pair message=msg-1/)
  assert.match(card, /collaboration context only; verify evidence before acting/)
  assert.match(card, /file:src\/runtime\/contextAssembler\.ts/)
  assert.match(card, /governance: decision=rejected scope=user approval=rejected:user auto_write=false/)
  assert.match(card, /blocked: missing_evidence_refs/)
  assert.match(card, /\[open inbox: \/inbox\]/)
  assert.match(card, /\[ack: \/inbox ack msg-1\]/)
  assert.match(card, /\[quote: \/inbox then q\]/)
  assert.doesNotMatch(card, /^> /m)
  assert.ok(card.split('\n').every(line => visibleTerminalWidth(line) <= 95))
})

test('quoteInboxMessage preserves side-channel wording and evidence references', () => {
  const quoted = quoteInboxMessage(createInboxMessage())

  assert.match(quoted, /SessionChannel inbox context only after verifying evidence/)
  assert.match(quoted, /message=msg-1 type=handoff priority=high from=session-a channel=channel-1/)
  assert.match(quoted, /file:src\/runtime\/contextAssembler\.ts/)
})

test('boxed input wraps long mixed-width text across indented input rows', () => {
  const line = '/Users/tangyaoyue/DEV/BABEL/BabeL-O /Users/tangyaoyue/DEV/BABEL/BabeL-X深度对比分析这两个项目'
  const rendered = renderBoxedInput({
    prompt: '> ',
    line,
    cursor: line.length,
    columns: 84,
  })
  const lines = rendered.text.split(/\r?\n/)

  assert.match(rendered.text, /\r\n/)
  assert.equal(rendered.truncated, false)
  assert.equal(lines.length, 5)
  assert.equal(lines[0], '─'.repeat(83))
  assert.match(lines[1]!, /^> \/Users\/tangyaoyue\/DEV\/BABEL\/BabeL-O/)
  assert.match(lines[2]!, /^  /)
  assert.equal(`${lines[1]!.slice(2)}${lines[2]!.slice(2)}`, line)
  assert.equal(lines[3], '─'.repeat(83))
  assert.ok(visibleTerminalWidth(lines[1]!) <= 83)
  assert.ok(visibleTerminalWidth(lines[2]!) <= 83)
  assert.equal(rendered.cursorRow, 2)
  assert.equal(rendered.cursorRowsFromBottom, 2)
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

test('boxed input renders explicit newlines as separate indented rows', () => {
  const line = `第一行业务场景${INPUT_NEWLINE_MARKER}第二行风险分层${INPUT_NEWLINE_MARKER}第三行回收修改`
  const rendered = renderBoxedInput({
    prompt: '> ',
    line,
    cursor: line.length,
    columns: 84,
  })
  const lines = rendered.text.split(/\r?\n/)

  assert.equal(lines.length, 6)
  assert.equal(lines[1], '> 第一行业务场景')
  assert.equal(lines[2], '  第二行风险分层')
  assert.equal(lines[3], '  第三行回收修改')
  assert.equal(rendered.cursorRow, 3)
  assert.equal(rendered.cursorRowsFromBottom, 2)
  assert.equal(rendered.cursorColumn, 2 + visibleTerminalWidth('第三行回收修改'))
  assert.equal(restoreInputNewlines(line), '第一行业务场景\n第二行风险分层\n第三行回收修改')
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

test('fixed input box renders an empty-state placeholder without moving the cursor', () => {
  const rendered = renderFixedInputBox({
    prompt: '> ',
    line: '',
    cursor: 0,
    placeholder: 'Ask BabeL-O · / commands · Ctrl+E editor',
    columns: 28,
  })

  assert.equal(rendered.renderedPlaceholder, true)
  assert.equal(rendered.cursorColumn, 2)
  assert.ok(rendered.text.includes('Ask BabeL-O'))
  assert.ok(visibleTerminalWidth(rendered.text) <= 28)
})

test('fixed input box hides the placeholder as soon as input has content', () => {
  const rendered = renderFixedInputBox({
    prompt: '> ',
    line: 'r',
    cursor: 1,
    placeholder: 'Ask BabeL-O · / commands · Ctrl+E editor',
    columns: 40,
  })

  assert.equal(rendered.renderedPlaceholder, false)
  assert.equal(rendered.text.includes('Ask BabeL-O'), false)
  assert.equal(rendered.text.includes('> r'), true)
})

test('fixed input box treats whitespace as content for placeholder rendering', () => {
  const rendered = renderFixedInputBox({
    prompt: '> ',
    line: ' ',
    cursor: 1,
    placeholder: 'Ask BabeL-O · / commands · Ctrl+E editor',
    columns: 40,
  })

  assert.equal(rendered.renderedPlaceholder, false)
  assert.equal(rendered.cursorColumn, 3)
  assert.equal(rendered.text.includes('Ask BabeL-O'), false)
})

test('input ghost helpers clear placeholder before printable input and consume blank enter', () => {
  assert.equal(shouldClearInputGhostBeforeWrite('', '你'), true)
  assert.equal(shouldClearInputGhostBeforeWrite('', 'r'), true)
  assert.equal(shouldClearInputGhostBeforeWrite('r', 'e'), false)
  assert.equal(shouldClearInputGhostBeforeWrite('', '\x1b[A'), false)
  assert.equal(shouldClearInputGhostBeforeWrite('', '\r'), false)

  assert.equal(shouldConsumeBlankInputEnter('', 'enter'), true)
  assert.equal(shouldConsumeBlankInputEnter('   ', 'enter'), true)
  assert.equal(shouldConsumeBlankInputEnter('read', 'enter'), false)
  assert.equal(shouldConsumeBlankInputEnter('', 'tab'), false)
})

test('vim input mode stays disabled by default', () => {
  const state = createVimInputState(false)
  const reduced = reduceVimInputKey(state, 'hello', 5, normalizeKeyEvent('h', undefined))

  assert.equal(reduced.handled, false)
  assert.deepEqual(reduced.state, { enabled: false, mode: 'insert' })
})

test('vim input mode switches between insert and normal mode', () => {
  let state = createVimInputState(true)
  let reduced = reduceVimInputKey(state, 'hello', 5, normalizeKeyEvent('\x1b', undefined))

  assert.equal(reduced.handled, true)
  if (!reduced.handled) throw new Error('unreachable')
  assert.equal(reduced.state.mode, 'normal')
  assert.equal(reduced.cursor, 4)

  state = reduced.state
  reduced = reduceVimInputKey(state, 'hello', 4, normalizeKeyEvent('i', undefined))
  assert.equal(reduced.handled, true)
  if (!reduced.handled) throw new Error('unreachable')
  assert.equal(reduced.state.mode, 'insert')
  assert.equal(reduced.cursor, 4)
})

test('vim normal mode moves and edits input without inserting command text', () => {
  let state = createVimInputState(true)
  let reduced = reduceVimInputKey(state, 'hello', 5, normalizeKeyEvent('\x1b', undefined))
  assert.equal(reduced.handled, true)
  if (!reduced.handled) throw new Error('unreachable')

  state = reduced.state
  reduced = reduceVimInputKey(state, reduced.line, reduced.cursor, normalizeKeyEvent('h', undefined))
  assert.equal(reduced.handled, true)
  if (!reduced.handled) throw new Error('unreachable')
  assert.equal(reduced.line, 'hello')
  assert.equal(reduced.cursor, 3)

  reduced = reduceVimInputKey(state, reduced.line, reduced.cursor, normalizeKeyEvent('x', undefined))
  assert.equal(reduced.handled, true)
  if (!reduced.handled) throw new Error('unreachable')
  assert.equal(reduced.line, 'helo')
  assert.equal(reduced.cursor, 3)

  reduced = reduceVimInputKey(state, reduced.line, reduced.cursor, normalizeKeyEvent('a', undefined))
  assert.equal(reduced.handled, true)
  if (!reduced.handled) throw new Error('unreachable')
  assert.equal(reduced.state.mode, 'insert')
  assert.equal(reduced.cursor, 4)
})

test('vim normal mode leaves enter to readline submission', () => {
  const state = { enabled: true, mode: 'normal' as const }
  const reduced = reduceVimInputKey(state, 'submit this', 3, normalizeKeyEvent('\r', undefined))

  assert.equal(reduced.handled, false)
  assert.equal(reduced.state, state)
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

    inputState.set('historySearch', { query: 'compact' })
    assert.equal(inputState.getData<string>('query'), 'compact')
    assert.equal(inputState.isOverlayOpen(), true, 'history search should keep keyboard routing in overlay mode')

    inputState.set('agentRunning')
    assert.equal(inputState.isOverlayOpen(), false, 'agentRunning is a status indicator, not a second input owner')
  } finally {
    inputState.set('idle')
  }
})

test('autosuggestion refresh renders main chat input as a boxed prompt', () => {
  const writes: string[] = []
  const moves: Array<[number, number]> = []
  const originalWrite = process.stdout.write
  const originalCursorTo = process.stdout.cursorTo
  const originalMoveCursor = readline.moveCursor
  const originalClearScreenDown = readline.clearScreenDown
  const originalColumns = process.stdout.columns
  process.stdout.write = ((chunk: any, ...args: any[]) => {
    writes.push(String(chunk))
    return true
  }) as typeof process.stdout.write
  ;(process.stdout as any).cursorTo = () => true
  ;(readline as any).moveCursor = (_stream: NodeJS.WritableStream, dx: number, dy: number) => {
    moves.push([dx, dy])
    return true
  }
  ;(readline as any).clearScreenDown = () => true
  Object.defineProperty(process.stdout, 'columns', { value: 40, configurable: true })

  const rl: any = {
    _prompt: '> ',
    line: '',
    cursor: 0,
  }
  try {
    setupAutosuggestions(rl as any, [], { current: false })
    rl._refreshLine()
  } finally {
    process.stdout.write = originalWrite
    ;(process.stdout as any).cursorTo = originalCursorTo
    ;(readline as any).moveCursor = originalMoveCursor
    ;(readline as any).clearScreenDown = originalClearScreenDown
    Object.defineProperty(process.stdout, 'columns', { value: originalColumns, configurable: true })
  }

  const output = writes.join('')
  assert.ok(output.includes('─'.repeat(39)))
  assert.ok(output.includes('? for shortcuts'))
  assert.ok(output.split('\n').some(line => line.includes('? for shortcuts')))
  assert.ok(moves.some(([, dy]) => dy === -2))
})

 test('submitted prompt renders as purple text without input chrome', () => {
  const originalLevel = chalk.level
  chalk.level = 1
  try {
    const submitted = renderSubmittedPrompt('你好～你是谁？')

    assert.match(submitted, /\x1b\[[0-9;]*m>/)
    assert.match(submitted, /你好～你是谁？/)
    assert.doesNotMatch(submitted, /─/)
    assert.doesNotMatch(submitted, /Ask BabeL-O/)
    assert.ok(submitted.endsWith('\n'))
  } finally {
    chalk.level = originalLevel
  }
})

 test('autosuggestion clearCurrentInputBlock removes boxed input before submission', () => {
  const writes: string[] = []
  const moves: Array<[number, number]> = []
  let clearCount = 0
  const originalWrite = process.stdout.write
  const originalCursorTo = process.stdout.cursorTo
  const originalMoveCursor = readline.moveCursor
  const originalClearScreenDown = readline.clearScreenDown
  const originalColumns = process.stdout.columns
  process.stdout.write = ((chunk: any, ...args: any[]) => {
    writes.push(String(chunk))
    return true
  }) as typeof process.stdout.write
  ;(process.stdout as any).cursorTo = () => true
  ;(readline as any).moveCursor = (_stream: NodeJS.WritableStream, dx: number, dy: number) => {
    moves.push([dx, dy])
    return true
  }
  ;(readline as any).clearScreenDown = () => {
    clearCount++
    return true
  }
  Object.defineProperty(process.stdout, 'columns', { value: 60, configurable: true })

  const rl: any = {
    _prompt: '> ',
    line: '你好～你是谁？',
    cursor: '你好～你是谁？'.length,
  }
  try {
    const controls = setupAutosuggestions(rl as any, [], { current: false })
    rl._refreshLine()
    controls.clearCurrentInputBlock({ afterSubmit: true })
    process.stdout.write(renderSubmittedPrompt(rl.line))
  } finally {
    process.stdout.write = originalWrite
    ;(process.stdout as any).cursorTo = originalCursorTo
    ;(readline as any).moveCursor = originalMoveCursor
    ;(readline as any).clearScreenDown = originalClearScreenDown
    Object.defineProperty(process.stdout, 'columns', { value: originalColumns, configurable: true })
  }

  const output = writes.join('')
  assert.ok(output.includes('─'.repeat(59)))
  assert.ok(output.includes('你好～你是谁？'))
  assert.equal(clearCount >= 2, true)
  assert.equal(moves.filter(([, dy]) => dy === -2).length >= 2, true)
  assert.ok(writes.at(-1)?.includes('你好～你是谁？'))
  assert.equal(writes.at(-1)?.includes('─'), false)
})

 test('autosuggestion refresh clears old boxed rows after terminal resize', () => {
  const writes: string[] = []
  const moves: Array<[number, number]> = []
  const originalWrite = process.stdout.write
  const originalCursorTo = process.stdout.cursorTo
  const originalMoveCursor = readline.moveCursor
  const originalClearScreenDown = readline.clearScreenDown
  const originalColumns = process.stdout.columns
  process.stdout.write = ((chunk: any, ...args: any[]) => {
    writes.push(String(chunk))
    return true
  }) as typeof process.stdout.write
  ;(process.stdout as any).cursorTo = () => true
  ;(readline as any).moveCursor = (_stream: NodeJS.WritableStream, dx: number, dy: number) => {
    moves.push([dx, dy])
    return true
  }
  ;(readline as any).clearScreenDown = () => true
  Object.defineProperty(process.stdout, 'columns', { value: 100, configurable: true })

  const rl: any = {
    _prompt: '> ',
    line: '',
    cursor: 0,
  }
  try {
    setupAutosuggestions(rl as any, [], { current: false })
    rl._refreshLine()
    Object.defineProperty(process.stdout, 'columns', { value: 40, configurable: true })
    rl._refreshLine()
  } finally {
    process.stdout.write = originalWrite
    ;(process.stdout as any).cursorTo = originalCursorTo
    ;(readline as any).moveCursor = originalMoveCursor
    ;(readline as any).clearScreenDown = originalClearScreenDown
    Object.defineProperty(process.stdout, 'columns', { value: originalColumns, configurable: true })
  }

  assert.ok(writes.some(write => write.includes('─'.repeat(99))))
  assert.ok(writes.some(write => write.includes('─'.repeat(39))))
  assert.ok(moves.some(([, dy]) => dy <= -3))
})

 test('autosuggestion refresh preserves secondary readline prompts', () => {
  const writes: string[] = []
  const originalWrite = process.stdout.write
  const originalCursorTo = process.stdout.cursorTo
  const originalClearScreenDown = process.stdout.clearScreenDown
  process.stdout.write = ((chunk: any, ...args: any[]) => {
    writes.push(String(chunk))
    return true
  }) as typeof process.stdout.write
  ;(process.stdout as any).cursorTo = () => true
  ;(process.stdout as any).clearScreenDown = () => true

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
    ;(process.stdout as any).clearScreenDown = originalClearScreenDown
  }

  const output = writes.join('')
  assert.ok(output.includes('Enter allow rule prefix (default: node:*): node:*'))
  assert.ok(!output.includes('BabeL-O'))
  assert.ok(!output.includes('Ask BabeL-O'))
})

test('autosuggestion refresh clears three-line boxed input before redrawing shorter input', () => {
  const writes: string[] = []
  const moves: Array<[number, number]> = []
  let clearCount = 0
  const originalWrite = process.stdout.write
  const originalCursorTo = process.stdout.cursorTo
  const originalMoveCursor = readline.moveCursor
  const originalClearScreenDown = readline.clearScreenDown
  const originalColumns = process.stdout.columns
  process.stdout.write = ((chunk: any, ...args: any[]) => {
    writes.push(String(chunk))
    return true
  }) as typeof process.stdout.write
  ;(process.stdout as any).cursorTo = () => true
  ;(readline as any).moveCursor = (_stream: NodeJS.WritableStream, dx: number, dy: number) => {
    moves.push([dx, dy])
    return true
  }
  ;(readline as any).clearScreenDown = () => {
    clearCount++
    return true
  }
  Object.defineProperty(process.stdout, 'columns', { value: 42, configurable: true })

  const multiline = `第一行业务场景${INPUT_NEWLINE_MARKER}第二行风险分层${INPUT_NEWLINE_MARKER}第三行回收修改`
  const rl: any = {
    _prompt: '> ',
    line: multiline,
    cursor: multiline.length,
  }
  try {
    setupAutosuggestions(rl as any, [], { current: false })
    rl._refreshLine()
    rl.line = '短输入'
    rl.cursor = rl.line.length
    rl._refreshLine()
  } finally {
    process.stdout.write = originalWrite
    ;(process.stdout as any).cursorTo = originalCursorTo
    ;(readline as any).moveCursor = originalMoveCursor
    ;(readline as any).clearScreenDown = originalClearScreenDown
    Object.defineProperty(process.stdout, 'columns', { value: originalColumns, configurable: true })
  }

  assert.equal(clearCount, 2)
  assert.ok(moves.some(([, dy]) => dy === -3))
  assert.ok(writes.some(write => write.includes('第三行回收修改')))
  assert.ok(writes.some(write => write.includes('短输入')))
})

test('autosuggestion refresh clears stale wrapped input rows', () => {
  const writes: string[] = []
  const moves: Array<[number, number]> = []
  let clearCount = 0
  const originalWrite = process.stdout.write
  const originalCursorTo = process.stdout.cursorTo
  const originalMoveCursor = readline.moveCursor
  const originalClearScreenDown = readline.clearScreenDown
  const originalColumns = process.stdout.columns
  process.stdout.write = ((chunk: any, ...args: any[]) => {
    writes.push(String(chunk))
    return true
  }) as typeof process.stdout.write
  ;(process.stdout as any).cursorTo = () => true
  ;(readline as any).moveCursor = (_stream: NodeJS.WritableStream, dx: number, dy: number) => {
    moves.push([dx, dy])
    return true
  }
  ;(readline as any).clearScreenDown = () => {
    clearCount++
    return true
  }
  Object.defineProperty(process.stdout, 'columns', { value: 30, configurable: true })

  const initialPrompt = '> '
  const wrappedPrompt = 'wrapped prompt '.repeat(3)
  const rl: any = {
    _prompt: initialPrompt,
    line: 'x'.repeat(80),
    cursor: 80,
  }
  try {
    setupAutosuggestions(rl as any, [], { current: false })
    rl._prompt = wrappedPrompt
    rl._refreshLine()
    rl.line = 'short'
    rl.cursor = rl.line.length
    rl._refreshLine()
  } finally {
    process.stdout.write = originalWrite
    ;(process.stdout as any).cursorTo = originalCursorTo
    ;(readline as any).moveCursor = originalMoveCursor
    ;(readline as any).clearScreenDown = originalClearScreenDown
    Object.defineProperty(process.stdout, 'columns', { value: originalColumns, configurable: true })
  }

  assert.ok(clearCount >= 2)
  assert.ok(moves.some(([, dy]) => dy < 0))
  assert.ok(writes.filter(write => write.includes(wrappedPrompt)).length >= 2)
})

test('prompt suggestions return context-aware hints based on session state', () => {
  assert.equal(getPromptSuggestion({ hasSession: false }), 'Ask a question about your code...')
  assert.equal(getPromptSuggestion({ hasSession: true, turnCount: 0 }), 'Ask a question about your code...')
  assert.equal(getPromptSuggestion({ hasSession: true, turnCount: 3, lastEventType: 'result' }), 'Follow up, start a new task, or type /compact')
  assert.equal(getPromptSuggestion({ hasSession: true, turnCount: 2, lastEventType: 'tool_completed', lastToolName: 'Read' }), 'File loaded — ask a question or request changes')
  assert.equal(getPromptSuggestion({ hasSession: true, turnCount: 2, lastEventType: 'tool_completed', lastToolName: 'Bash' }), 'Command finished — ask about the output or next step')
  assert.equal(getPromptSuggestion({ hasSession: true, turnCount: 1, failedTaskCount: 2, pendingTaskCount: 0 }), 'A task failed — ask to retry or investigate')
  assert.equal(getPromptSuggestion({ hasSession: true, turnCount: 1, pendingTaskCount: 3 }), '3 pending task(s) — continue or ask for status')
  assert.equal(getPromptSuggestion({ hasSession: true, turnCount: 1, agentRunning: true }), undefined)
})

test('theme returns default and minimal variants controlled by BABEL_O_THEME', () => {
  resetThemeForTest()
  const oldTheme = process.env.BABEL_O_THEME
  try {
    delete process.env.BABEL_O_THEME
    resetThemeForTest()
    const defaultTheme = getTheme()
    assert.equal(defaultTheme.name, 'default')
    assert.equal(defaultTheme.promptSymbol, '>')

    process.env.BABEL_O_THEME = 'minimal'
    resetThemeForTest()
    const minimalTheme = getTheme()
    assert.equal(minimalTheme.name, 'minimal')
    assert.equal(minimalTheme.promptSymbol, '$')

    process.env.BABEL_O_THEME = 'unknown_value'
    resetThemeForTest()
    const fallbackTheme = getTheme()
    assert.equal(fallbackTheme.name, 'default')
  } finally {
    if (oldTheme === undefined) delete process.env.BABEL_O_THEME
    else process.env.BABEL_O_THEME = oldTheme
    resetThemeForTest()
  }
})

test('live agent tree tracks entries and updates activity', () => {
  resetLiveAgentTreeForTest()
  assert.deepEqual(getLiveAgentTree(), [])

  const originalWrite = process.stdout.write
  process.stdout.write = (() => true) as any
  try {
    renderEvent({
      type: 'agent_job_event',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId: 'test-session',
      eventId: 'ev-1',
      eventType: 'agent_job_started',
      jobId: 'job-1',
      childSessionId: 'child-1',
      agentType: 'explore',
      contextForkMode: 'minimal',
      status: 'running',
      timestamp: new Date().toISOString(),
    } as any)

    assert.equal(getLiveAgentTree().length, 1)
    assert.equal(getLiveAgentTree()[0]!.agentType, 'explore')
    assert.equal(getLiveAgentTree()[0]!.status, 'running')

    updateLiveAgentActivity('job-1', 5, 120, 'Reading files…')
    assert.equal(getLiveAgentTree()[0]!.toolUses, 5)
    assert.equal(getLiveAgentTree()[0]!.tokens, 120)
    assert.equal(getLiveAgentTree()[0]!.lastActivity, 'Reading files…')

    renderEvent({
      type: 'agent_job_event',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId: 'test-session',
      eventId: 'ev-2',
      eventType: 'agent_job_completed',
      jobId: 'job-1',
      childSessionId: 'child-1',
      agentType: 'explore',
      contextForkMode: 'minimal',
      status: 'completed',
      timestamp: new Date().toISOString(),
    } as any)

    assert.deepEqual(getLiveAgentTree(), [])
  } finally {
    process.stdout.write = originalWrite
    resetLiveAgentTreeForTest()
  }
})

function createInboxChannel(overrides: Partial<SessionChannel> = {}): SessionChannel {
  return {
    channelId: 'channel-1',
    kind: 'workspace_pair',
    participantSessionIds: ['session-a', 'session-b'],
    createdBySessionId: 'session-a',
    createdAt: '2026-06-08T00:00:00.000Z',
    status: 'open',
    policy: {
      allowedMessageTypes: ['question', 'answer', 'finding', 'request_review', 'request_validation', 'hypothesis', 'decision', 'blocked', 'memory_candidate', 'handoff'],
      maxMessageChars: 4000,
      maxEvidenceRefs: 8,
      allowBroadcast: true,
      allowMemoryWriteRequests: false,
      requireUserApprovalForExternalProject: true,
      contextInjectionMode: 'recent_messages',
    },
    ...overrides,
  }
}

function createInboxMessage(overrides: Partial<SessionMessage> = {}): SessionMessage {
  return {
    messageId: 'msg-1',
    channelId: 'channel-1',
    fromSessionId: 'session-a',
    toSessionId: 'session-b',
    broadcast: false,
    type: 'handoff',
    content: 'Read src/runtime/contextAssembler.ts before editing context injection.',
    evidence: [{ type: 'file', ref: 'src/runtime/contextAssembler.ts' }],
    priority: 'high',
    createdAt: '2026-06-08T00:00:00.000Z',
    deliveredAt: '2026-06-08T00:00:01.000Z',
    status: 'delivered',
    ...overrides,
  }
}
