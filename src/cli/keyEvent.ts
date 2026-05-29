export type NormalizedKeyKind =
  | 'ctrl_c'
  | 'ctrl_e'
  | 'ctrl_o'
  | 'enter'
  | 'escape'
  | 'backspace'
  | 'tab'
  | 'up'
  | 'down'
  | 'right'
  | 'page_up'
  | 'page_down'
  | 'digit'
  | 'text'
  | 'mouse'
  | 'unknown'

export interface NormalizedKeyEvent {
  kind: NormalizedKeyKind
  raw: string
  name?: string
  ctrl: boolean
  digit?: number
}

export function normalizeKeyEvent(chunk: unknown, key: unknown): NormalizedKeyEvent {
  const raw = chunkToString(chunk)
  const keyRecord = key && typeof key === 'object' ? key as Record<string, unknown> : {}
  const name = typeof keyRecord.name === 'string' ? keyRecord.name : undefined
  const ctrl = keyRecord.ctrl === true

  if (isMouseSequence(raw)) return { kind: 'mouse', raw, name, ctrl }
  if ((ctrl && name === 'c') || raw.includes('')) return { kind: 'ctrl_c', raw, name, ctrl }
  if ((ctrl && name === 'e') || raw === '\x05') return { kind: 'ctrl_e', raw, name, ctrl }
  if ((ctrl && name === 'o') || raw === '\x0f') return { kind: 'ctrl_o', raw, name, ctrl }
  if (name === 'return' || name === 'enter' || raw === '\r' || raw === '\n' || raw === '\r\n') {
    return { kind: 'enter', raw, name, ctrl }
  }
  if (name === 'escape' || raw === '\x1b' || raw === '') return { kind: 'escape', raw, name, ctrl }
  if (name === 'backspace' || raw === '\x7f' || raw === '\b') return { kind: 'backspace', raw, name, ctrl }
  if (name === 'tab' || raw === '\t') return { kind: 'tab', raw, name, ctrl }
  if (name === 'up' || raw.includes('\x1b[A')) return { kind: 'up', raw, name, ctrl }
  if (name === 'down' || raw.includes('\x1b[B')) return { kind: 'down', raw, name, ctrl }
  if (name === 'right' || raw.includes('\x1b[C')) return { kind: 'right', raw, name, ctrl }
  if (name === 'pageup' || raw === '\x1b[5~') return { kind: 'page_up', raw, name, ctrl }
  if (name === 'pagedown' || raw === '\x1b[6~') return { kind: 'page_down', raw, name, ctrl }

  const digitSource = name && /^[1-9]$/.test(name) ? name : raw
  if (/^[1-9]$/.test(digitSource)) {
    return { kind: 'digit', raw, name, ctrl, digit: Number(digitSource) }
  }

  if (raw && !raw.startsWith('\x1b')) return { kind: 'text', raw, name, ctrl }
  return { kind: 'unknown', raw, name, ctrl }
}

export function chunkToString(chunk: unknown): string {
  if (typeof chunk === 'string') return chunk
  if (Buffer.isBuffer(chunk)) return chunk.toString('utf8')
  if (chunk && typeof chunk === 'object' && 'toString' in chunk) {
    const value = (chunk as { toString(): string }).toString()
    return value === '[object Object]' ? '' : value
  }
  return ''
}

export function isMouseSequence(raw: string): boolean {
  return /^\x1b\[<[\d;]+[Mm]/.test(raw) ||
    (raw.startsWith('\x1b[M') && raw.length >= 6) ||
    /^\x1b\[[\d;]+[Mm]/.test(raw)
}

export function terminalMouseDisableSequence(): string {
  return '\x1b[?1006l\x1b[?1000l'
}
