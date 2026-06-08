import { test } from 'node:test'
import assert from 'node:assert'
import { EventEmitter } from 'node:events'
import { chooseInteractive, runInteractiveDropdown } from '../src/cli/ui.js'

/**
 * Replace process.stdin with a non-TTY EventEmitter that has the
 * minimum surface area needed by chooseInteractive / runInteractiveDropdown
 * (setRawMode, listeners, removeAllListeners, resume).
 */
function installMockStdin(): {
  stdin: EventEmitter & { isTTY: boolean; isRaw: boolean; setRawMode: () => void; resume: () => void }
  originalStdin: typeof process.stdin
  restore: () => void
} {
  const original = process.stdin
  const stdin: any = new EventEmitter()
  stdin.isTTY = false
  stdin.isRaw = false
  stdin.setRawMode = () => true
  stdin.resume = () => {}
  Object.defineProperty(process, 'stdin', { value: stdin, configurable: true })
  return {
    stdin: stdin as any,
    originalStdin: original,
    restore: () => {
      Object.defineProperty(process, 'stdin', { value: original, configurable: true })
    },
  }
}

/**
 * Install a capturing process.stdout.write that records every chunk
 * written by the dropdown redraw.
 */
function installMockStdout(): {
  writes: string[]
  restore: () => void
} {
  const writes: string[] = []
  const original = process.stdout.write
  process.stdout.write = ((chunk: any) => {
    writes.push(typeof chunk === 'string' ? chunk : String(chunk))
    return true
  }) as typeof process.stdout.write
  return {
    writes,
    restore: () => {
      process.stdout.write = original
    },
  }
}

test('chooseInteractive redraws in place when navigating (no duplicate dropdown)', () => {
  const stdout = installMockStdout()
  const stdinHandle = installMockStdin()

  let selected = ''
  try {
    chooseInteractive('Select provider:', ['local', 'anthropic', 'openai'], (value) => {
      selected = value
    })

    // First redraw: should write question + 3 choices (4 lines total).
    const firstOutput = stdout.writes.join('')
    assert.ok(firstOutput.includes('Select provider:'), 'first redraw must include the question')
    assert.ok(firstOutput.includes('local'), 'first redraw must include the first choice')
    assert.ok(firstOutput.includes('anthropic'), 'first redraw must include the second choice')
    assert.ok(firstOutput.includes('openai'), 'first redraw must include the third choice')

    // Snapshot the number of bytes written so far; everything after
    // this is the second redraw.
    const writesBeforeNav = stdout.writes.length
    const bytesBeforeNav = stdout.writes.slice().join('').length

    // Simulate pressing the down arrow.
    stdinHandle.stdin.emit('keypress', null, { name: 'down' })

    // The second redraw must:
    // 1. Move the cursor up to the start of the dropdown (not the bottom).
    // 2. Clear from that position to the end of the screen.
    // 3. Rewrite the dropdown at the same starting row.
    //
    // In the buggy version, the second redraw wrote the dropdown at
    // the current cursor position (which was below the old dropdown),
    // so the user saw a duplicate.
    const navBytes = stdout.writes.slice(writesBeforeNav).join('')
    assert.ok(
      navBytes.includes('\x1b[4A'),
      `expected the second redraw to move up 4 lines (1 question + 3 choices) to the widget start, got: ${JSON.stringify(navBytes)}`,
    )
    assert.ok(
      navBytes.includes('\x1b[J'),
      `expected the second redraw to clear from the widget start to end of screen, got: ${JSON.stringify(navBytes)}`,
    )

    // The redraw must NOT just append a fresh dropdown below the old one.
    // If it does, we would see TWO copies of the question in the bytes
    // emitted after the navigation. (The first copy was cleared above
    // by the cursor-up + clear pair, so the bytes emitted after the
    // navigation should only contain one copy of the question.)
    const questionCount = (navBytes.match(/Select provider:/g) ?? []).length
    assert.equal(
      questionCount,
      1,
      `expected exactly one 'Select provider:' in the navigation redraw, got ${questionCount}: ${JSON.stringify(navBytes)}`,
    )

    // Press enter to confirm the new selection (activeIndex moved from
    // 0 to 1, so 'anthropic' should be selected).
    stdinHandle.stdin.emit('keypress', null, { name: 'enter' })
    assert.equal(selected, 'anthropic', 'enter should select the highlighted option')
  } finally {
    stdinHandle.restore()
    stdout.restore()
  }
})

test('chooseInteractive cleanup removes the dropdown widget', () => {
  const stdout = installMockStdout()
  const stdinHandle = installMockStdin()

  let selected = ''
  try {
    chooseInteractive('Select provider:', ['a', 'b'], (value) => {
      selected = value
    })

    const writesBeforeCleanup = stdout.writes.length

    // Simulate pressing escape to cancel.
    stdinHandle.stdin.emit('keypress', null, { name: 'escape' })
    assert.equal(selected, '', 'escape should resolve with empty selection')

    // Cleanup must move up to the widget start and clear it, so the
    // post-cleanup writes should clear the visible dropdown area.
    const cleanupBytes = stdout.writes.slice(writesBeforeCleanup).join('')
    assert.ok(
      cleanupBytes.includes('\x1b[3A'),
      `expected cleanup to move up 3 lines (1 question + 2 choices) before clearing, got: ${JSON.stringify(cleanupBytes)}`,
    )
    assert.ok(
      cleanupBytes.includes('\x1b[J'),
      `expected cleanup to clear from widget start to end of screen, got: ${JSON.stringify(cleanupBytes)}`,
    )
  } finally {
    stdinHandle.restore()
    stdout.restore()
  }
})

test('runInteractiveDropdown redraws in place when navigating', () => {
  const stdout = installMockStdout()
  const stdinHandle = installMockStdin()

  let selected = ''
  try {
    runInteractiveDropdown(['alpha', 'beta', 'gamma'], '', (value) => {
      selected = value
    })

    const writesBeforeNav = stdout.writes.length
    stdinHandle.stdin.emit('keypress', null, { name: 'down' })

    const navBytes = stdout.writes.slice(writesBeforeNav).join('')
    assert.ok(
      navBytes.includes('\x1b[3A'),
      `expected runInteractiveDropdown to move up 3 lines (3 choices) on redraw, got: ${JSON.stringify(navBytes)}`,
    )
    assert.ok(
      navBytes.includes('\x1b[J'),
      `expected runInteractiveDropdown to clear from widget start to end of screen, got: ${JSON.stringify(navBytes)}`,
    )

    stdinHandle.stdin.emit('keypress', null, { name: 'enter' })
    assert.equal(selected, 'beta')
  } finally {
    stdinHandle.restore()
    stdout.restore()
  }
})
