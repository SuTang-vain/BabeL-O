import type { NormalizedKeyEvent } from './keyEvent.js'

export type VimInputMode = 'insert' | 'normal'

export interface VimInputState {
  enabled: boolean
  mode: VimInputMode
}

export type VimInputResult =
  | { handled: false; state: VimInputState }
  | {
      handled: true
      state: VimInputState
      line: string
      cursor: number
    }

export function createVimInputState(enabled = process.env.BABEL_O_VIM_MODE === '1'): VimInputState {
  return { enabled, mode: 'insert' }
}

export function reduceVimInputKey(
  state: VimInputState,
  line: string,
  cursor: number,
  key: NormalizedKeyEvent,
): VimInputResult {
  if (!state.enabled) return { handled: false, state }

  const safeCursor = clamp(cursor, 0, line.length)
  if (state.mode === 'insert') {
    if (key.kind !== 'escape') return { handled: false, state }
    return {
      handled: true,
      state: { ...state, mode: 'normal' },
      line,
      cursor: clamp(safeCursor - 1, 0, Math.max(0, line.length - 1)),
    }
  }

  if (key.kind === 'enter') return { handled: false, state }
  if (key.kind === 'escape') {
    return { handled: true, state, line, cursor: safeCursor }
  }
  if (key.kind === 'right') {
    return { handled: true, state, line, cursor: moveRight(line, safeCursor) }
  }
  if (key.kind === 'backspace') {
    return deleteBeforeCursor(state, line, safeCursor)
  }
  if (key.kind !== 'text') return { handled: false, state }

  const command = key.raw
  if (command === 'i') {
    return { handled: true, state: { ...state, mode: 'insert' }, line, cursor: safeCursor }
  }
  if (command === 'a') {
    return { handled: true, state: { ...state, mode: 'insert' }, line, cursor: moveRightForAppend(line, safeCursor) }
  }
  if (command === 'h') {
    return { handled: true, state, line, cursor: Math.max(0, safeCursor - 1) }
  }
  if (command === 'l') {
    return { handled: true, state, line, cursor: moveRight(line, safeCursor) }
  }
  if (command === '0') {
    return { handled: true, state, line, cursor: 0 }
  }
  if (command === '$') {
    return { handled: true, state, line, cursor: Math.max(0, line.length - 1) }
  }
  if (command === 'x') {
    return deleteAtCursor(state, line, safeCursor)
  }

  return { handled: true, state, line, cursor: safeCursor }
}

function deleteAtCursor(state: VimInputState, line: string, cursor: number): VimInputResult {
  if (!line) return { handled: true, state, line, cursor: 0 }
  const nextLine = `${line.slice(0, cursor)}${line.slice(cursor + 1)}`
  return { handled: true, state, line: nextLine, cursor: clamp(cursor, 0, Math.max(0, nextLine.length - 1)) }
}

function deleteBeforeCursor(state: VimInputState, line: string, cursor: number): VimInputResult {
  if (!line || cursor <= 0) return { handled: true, state, line, cursor: 0 }
  const nextLine = `${line.slice(0, cursor - 1)}${line.slice(cursor)}`
  return { handled: true, state, line: nextLine, cursor: clamp(cursor - 1, 0, Math.max(0, nextLine.length - 1)) }
}

function moveRight(line: string, cursor: number): number {
  return clamp(cursor + 1, 0, Math.max(0, line.length - 1))
}

function moveRightForAppend(line: string, cursor: number): number {
  return clamp(cursor + 1, 0, line.length)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}
