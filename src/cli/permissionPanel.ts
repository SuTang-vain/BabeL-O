import type { PermissionChoice } from './ui.js'
import type { NormalizedKeyEvent } from './keyEvent.js'

export const REJECT_PERMISSION_CHOICE_INDEX = 3
export const PERMISSION_CHOICE_COUNT = 5

export interface PermissionPanelState {
  activeIndex: number
  choiceCount: number
}

export type PermissionPanelAction =
  | { type: 'redraw' }
  | { type: 'finish'; choiceIndex: number }
  | { type: 'abort' }
  | { type: 'ignore' }

export function createPermissionPanelState(choiceCount = PERMISSION_CHOICE_COUNT): PermissionPanelState {
  return { activeIndex: 0, choiceCount }
}

export function reducePermissionPanelKey(
  state: PermissionPanelState,
  key: NormalizedKeyEvent,
): { state: PermissionPanelState; action: PermissionPanelAction } {
  if (key.kind === 'ctrl_c') return { state, action: { type: 'abort' } }

  if (key.kind === 'up') {
    return {
      state: movePermissionSelection(state, -1),
      action: { type: 'redraw' },
    }
  }

  if (key.kind === 'down') {
    return {
      state: movePermissionSelection(state, 1),
      action: { type: 'redraw' },
    }
  }

  if (key.kind === 'enter') {
    return { state, action: { type: 'finish', choiceIndex: state.activeIndex } }
  }

  if (key.kind === 'escape' || key.kind === 'backspace') {
    return { state, action: { type: 'finish', choiceIndex: REJECT_PERMISSION_CHOICE_INDEX } }
  }

  if (key.kind === 'digit' && key.digit !== undefined) {
    const index = key.digit - 1
    if (index >= 0 && index < state.choiceCount) {
      return {
        state: { ...state, activeIndex: index },
        action: { type: 'finish', choiceIndex: index },
      }
    }
  }

  return { state, action: { type: 'ignore' } }
}

export function selectedPermissionChoice(
  choices: { id: PermissionChoice }[],
  index: number,
): PermissionChoice {
  return choices[Math.max(0, Math.min(index, choices.length - 1))]!.id
}

function movePermissionSelection(state: PermissionPanelState, delta: number): PermissionPanelState {
  return {
    ...state,
    activeIndex: (state.activeIndex + delta + state.choiceCount) % state.choiceCount,
  }
}
