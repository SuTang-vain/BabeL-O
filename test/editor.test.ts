import { test } from 'node:test'
import assert from 'node:assert'
import * as childProcess from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { openExternalEditor, _spawner } from '../src/cli/editor.js'
import { EventEmitter } from 'node:events'

test('openExternalEditor successfully edits content', async (t) => {
  const cwd = path.resolve('./')
  const tempDir = path.join(cwd, '.babel-o')
  
  // Clean up any old test files
  if (fs.existsSync(tempDir)) {
    const files = fs.readdirSync(tempDir)
    for (const f of files) {
      if (f.startsWith('babel-o-prompt-')) {
        try { fs.unlinkSync(path.join(tempDir, f)) } catch {}
      }
    }
  }

  // Setup mock for spawn
  t.mock.method(_spawner, 'spawn', (cmd: string, args: string[], opts: any) => {
    const filePath = args[0]!
    assert.ok(fs.existsSync(filePath), 'Temp file should be created before editor spawns')
    const currentText = fs.readFileSync(filePath, 'utf8')
    assert.strictEqual(currentText, 'hello world', 'Initial content should be written to temp file')
    
    // Simulate user editing the file
    fs.writeFileSync(filePath, 'hello world edited', 'utf8')
    
    // Return a mock child process
    const mockChild = new EventEmitter() as any
    // Simulate exit with code 0 after a short delay
    process.nextTick(() => {
      mockChild.emit('close', 0)
    })
    return mockChild
  })

  const prevVisual = process.env.VISUAL
  process.env.VISUAL = 'mock-editor'

  try {
    const result = await openExternalEditor('hello world', cwd)
    assert.strictEqual(result, 'hello world edited', 'Should read back edited content')
  } finally {
    process.env.VISUAL = prevVisual
  }
})

test('openExternalEditor falls back to nano and vi on failure', async (t) => {
  const cwd = path.resolve('./')
  let spawnCalls: string[] = []

  t.mock.method(_spawner, 'spawn', (cmd: string, args: string[], opts: any) => {
    spawnCalls.push(cmd)
    const mockChild = new EventEmitter() as any
    
    if (cmd === 'broken-editor') {
      // Simulate error event (editor not found/failed to run)
      process.nextTick(() => {
        mockChild.emit('error', new Error('spawn ENOENT'))
      })
    } else {
      // nano or vi works
      const filePath = args[0]!
      fs.writeFileSync(filePath, `${cmd} output`, 'utf8')
      process.nextTick(() => {
        mockChild.emit('close', 0)
      })
    }
    return mockChild
  })

  const prevVisual = process.env.VISUAL
  const prevEditor = process.env.EDITOR
  process.env.VISUAL = 'broken-editor'
  delete process.env.EDITOR

  try {
    const result = await openExternalEditor('original prompt', cwd)
    assert.strictEqual(result, 'nano output', 'Should fallback to nano and get its output')
    assert.deepStrictEqual(spawnCalls, ['broken-editor', 'nano'], 'Should call broken-editor first, then fallback to nano')
  } finally {
    process.env.VISUAL = prevVisual
    process.env.EDITOR = prevEditor
  }
})

test('bracketed paste logic isolates pasted content correctly', () => {
  let pastedResult = ''
  const handlePastedText = (text: string) => {
    pastedResult = text
  }

  let isPasting = false
  let pasteBuffer = ''

  const simulateEmit = (chunk: string) => {
    if (isPasting) {
      pasteBuffer += chunk
      const endIdx = pasteBuffer.indexOf('\x1b[201~')
      if (endIdx !== -1) {
        const pastedText = pasteBuffer.slice(0, endIdx)
        isPasting = false
        pasteBuffer = pasteBuffer.slice(endIdx + 6)
        handlePastedText(pastedText)
      }
      return true
    }

    if (chunk.includes('\x1b[200~')) {
      isPasting = true
      const startIdx = chunk.indexOf('\x1b[200~')
      pasteBuffer = chunk.slice(startIdx + 6)

      const endIdx = pasteBuffer.indexOf('\x1b[201~')
      if (endIdx !== -1) {
        const pastedText = pasteBuffer.slice(0, endIdx)
        isPasting = false
        pasteBuffer = pasteBuffer.slice(endIdx + 6)
        handlePastedText(pastedText)
      }
      return true
    }
    return false
  }

  // Case 1: Simple single-chunk paste
  simulateEmit('\x1b[200~hello multiline\nworld\x1b[201~')
  assert.strictEqual(pastedResult, 'hello multiline\nworld')

  // Case 2: Multi-chunk paste
  pastedResult = ''
  simulateEmit('\x1b[200~part1 ')
  assert.strictEqual(isPasting, true)
  assert.strictEqual(pastedResult, '')

  simulateEmit('part2\npart3')
  assert.strictEqual(isPasting, true)
  assert.strictEqual(pastedResult, '')

  simulateEmit(' finished\x1b[201~')
  assert.strictEqual(isPasting, false)
  assert.strictEqual(pastedResult, 'part1 part2\npart3 finished')
})

test('robust keypress detection works for pasteBuffer controls', (t) => {
  const checkCtrlE = (chunk: any, key: any) => {
    return (key?.ctrl && key?.name === 'e') || chunk === '\x05' || chunk?.toString() === '\x05' || (typeof chunk === 'string' && chunk.charCodeAt(0) === 5)
  }
  const checkEnter = (chunk: any, key: any) => {
    return key?.name === 'enter' || key?.name === 'return' || chunk === '\r' || chunk === '\n' || chunk === '\r\n' || chunk?.toString() === '\r' || chunk?.toString() === '\n' || chunk?.toString() === '\r\n'
  }
  const checkCancel = (chunk: any, key: any) => {
    return key?.name === 'escape' || key?.name === 'backspace' || chunk === '\x1b' || chunk === '\x7f' || chunk === '\b' || chunk?.toString() === '\x1b' || chunk?.toString() === '\x7f' || chunk?.toString() === '\b'
  }

  // Ctrl+E scenarios
  assert.ok(checkCtrlE('\x05', undefined))
  assert.ok(checkCtrlE(Buffer.from('\x05'), undefined))
  assert.ok(checkCtrlE(undefined, { ctrl: true, name: 'e' }))

  // Enter scenarios
  assert.ok(checkEnter('\r', undefined))
  assert.ok(checkEnter(undefined, { name: 'enter' }))
  assert.ok(checkEnter(undefined, { name: 'return' }))

  // Cancel scenarios
  assert.ok(checkCancel('\x1b', undefined))
  assert.ok(checkCancel(undefined, { name: 'escape' }))
  assert.ok(checkCancel('\x7f', undefined))
})

test('pasting timeout recovery works as expected', async (t) => {
  let isPasting = false
  let pasteBuffer = ''
  let pastedResult = ''
  let pasteTimeout: any = null
  
  const handlePastedText = (text: string) => {
    pastedResult = text
  }

  const simulateEmitWithTimeout = (chunk: string) => {
    const str = chunk
    if (isPasting) {
      pasteBuffer += str
      const endIdx = pasteBuffer.indexOf('\x1b[201~')
      if (endIdx !== -1) {
        const pastedText = pasteBuffer.slice(0, endIdx)
        isPasting = false
        pasteBuffer = pasteBuffer.slice(endIdx + 6)
        if (pasteTimeout) clearTimeout(pasteTimeout)
        handlePastedText(pastedText)
      }
      return true
    }

    if (str.includes('\x1b[200~')) {
      isPasting = true
      const startIdx = str.indexOf('\x1b[200~')
      pasteBuffer = str.slice(startIdx + 6)

      const endIdx = pasteBuffer.indexOf('\x1b[201~')
      if (endIdx !== -1) {
        const pastedText = pasteBuffer.slice(0, endIdx)
        isPasting = false
        pasteBuffer = pasteBuffer.slice(endIdx + 6)
        handlePastedText(pastedText)
      } else {
        pasteTimeout = setTimeout(() => {
          if (isPasting) {
            const flushed = pasteBuffer
            isPasting = false
            pasteBuffer = ''
            handlePastedText(flushed)
          }
        }, 10)
      }
      return true
    }
    return false
  }

  // Simulate an incomplete paste (no end marker \x1b[201~)
  simulateEmitWithTimeout('\x1b[200~hello world partial')
  assert.strictEqual(isPasting, true)
  assert.strictEqual(pastedResult, '')

  // Wait for the timeout to fire
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.strictEqual(isPasting, false)
  assert.strictEqual(pastedResult, 'hello world partial')
})

test('event forwarding hook correctly preserves event name and arguments without shifting', (t) => {
  const originalEmit = EventEmitter.prototype.emit
  let receivedEvent: string | null = null
  let receivedArgs: any[] = []

  const mockEmitter = new EventEmitter()
  mockEmitter.emit = function (event: string, ...args: any[]) {
    return originalEmit.apply(this, [event, ...args] as any)
  }

  mockEmitter.on('test-event', (arg1: any, arg2: any) => {
    receivedEvent = 'test-event'
    receivedArgs = [arg1, arg2]
  })

  mockEmitter.emit('test-event', 'hello', 'world')

  assert.strictEqual(receivedEvent, 'test-event')
  assert.deepStrictEqual(receivedArgs, ['hello', 'world'])
})



