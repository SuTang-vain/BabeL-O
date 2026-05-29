import { chunkToString } from './keyEvent.js'

export const BRACKETED_PASTE_START = '\x1b[200~'
export const BRACKETED_PASTE_END = '\x1b[201~'

export interface PasteBufferState {
  isPasting: boolean
  buffer: string
}

export interface PasteBufferResult {
  state: PasteBufferState
  consumed: boolean
  pastedText?: string
  trailingText?: string
}

export function createPasteBufferState(): PasteBufferState {
  return { isPasting: false, buffer: '' }
}

export function consumePasteChunk(state: PasteBufferState, chunk: unknown): PasteBufferResult {
  const raw = chunkToString(chunk)
  if (!raw) return { state, consumed: false }

  if (state.isPasting) {
    return consumeActivePaste({ ...state, buffer: state.buffer + raw })
  }

  const startIndex = raw.indexOf(BRACKETED_PASTE_START)
  if (startIndex === -1) return { state, consumed: false }

  const beforeStart = raw.slice(0, startIndex)
  const afterStart = raw.slice(startIndex + BRACKETED_PASTE_START.length)
  const result = consumeActivePaste({ isPasting: true, buffer: afterStart })
  return {
    ...result,
    consumed: true,
    trailingText: [beforeStart, result.trailingText].filter(Boolean).join(''),
  }
}

export function flushPasteBuffer(state: PasteBufferState): PasteBufferResult {
  if (!state.isPasting) return { state, consumed: false }
  return {
    state: createPasteBufferState(),
    consumed: true,
    pastedText: state.buffer,
  }
}

function consumeActivePaste(state: PasteBufferState): PasteBufferResult {
  const endIndex = state.buffer.indexOf(BRACKETED_PASTE_END)
  if (endIndex === -1) {
    return { state, consumed: true }
  }

  return {
    state: createPasteBufferState(),
    consumed: true,
    pastedText: state.buffer.slice(0, endIndex),
    trailingText: state.buffer.slice(endIndex + BRACKETED_PASTE_END.length),
  }
}
