/**
 * Unified CLI input state machine.
 *
 * Design principle:
 * - Only one overlay/input mode is active at any time.
 * - The readline input box is the single owner of user text; overlays render
 *   above it without replacing it.
 * - Keyboard routing is deterministic: each state consumes only its own keys
 *   and passes through everything else.
 */

export type InputMode =
  | 'idle'
  | 'slashPalette'
  | 'toolPalette'
  | 'permissionPanel'
  | 'historySearch'
  | 'modelWizard'
  | 'agentRunning'

type ModeChangeListener = (oldMode: InputMode, newMode: InputMode) => void

class InputStateMachine {
  private mode: InputMode = 'idle'
  private listeners: ModeChangeListener[] = []
  private _overlayData: Record<string, unknown> = {}

  get current(): InputMode {
    return this.mode
  }

  isIdle(): boolean {
    return this.mode === 'idle'
  }

  isOverlayOpen(): boolean {
    return this.mode !== 'idle' && this.mode !== 'agentRunning'
  }

  set(mode: InputMode, data?: Record<string, unknown>) {
    const old = this.mode
    if (old === mode) return
    this.mode = mode
    if (data) {
      this._overlayData = { ...this._overlayData, ...data }
    } else if (mode === 'idle') {
      this._overlayData = {}
    }
    for (const listener of this.listeners) {
      listener(old, mode)
    }
  }

  getData<T>(key: string): T | undefined {
    return this._overlayData[key] as T | undefined
  }

  onChange(listener: ModeChangeListener): () => void {
    this.listeners.push(listener)
    return () => {
      const idx = this.listeners.indexOf(listener)
      if (idx >= 0) this.listeners.splice(idx, 1)
    }
  }
}

export const inputState = new InputStateMachine()

/**
 * Keyboard event classification helpers.
 */
export function isNavigationKey(chunk: any, key: any): boolean {
  const name = key?.name || (chunk ? chunk.toString() : '')
  const raw = typeof chunk === 'string' ? chunk : ''
  return (
    name === 'up' ||
    name === 'down' ||
    raw.includes('\x1b[A') ||
    raw.includes('\x1b[B')
  )
}

export function isConfirmKey(chunk: any, key: any): boolean {
  const name = key?.name || (chunk ? chunk.toString() : '')
  const raw = typeof chunk === 'string' ? chunk : ''
  return (
    name === 'return' ||
    name === 'enter' ||
    raw === '\r' ||
    raw === '\n'
  )
}

export function isCancelKey(chunk: any, key: any): boolean {
  const name = key?.name || (chunk ? chunk.toString() : '')
  const raw = typeof chunk === 'string' ? chunk : ''
  return (
    name === 'escape' ||
    raw === '\x1b' ||
    raw === '\u001b' ||
    name === 'backspace' ||
    raw === '\x7f' ||
    raw === '\b'
  )
}

export function isTabKey(chunk: any, key: any): boolean {
  const name = key?.name || (chunk ? chunk.toString() : '')
  const raw = typeof chunk === 'string' ? chunk : ''
  return name === 'tab' || raw === '\t'
}

export function isCtrlC(chunk: any, key: any): boolean {
  return (key?.ctrl && key?.name === 'c') || (typeof chunk === 'string' && chunk.includes('\u0003'))
}
