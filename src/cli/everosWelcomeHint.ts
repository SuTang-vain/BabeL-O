import chalk from 'chalk'
import {
  readEverOSBootstrapStateSync,
  type EverOSBootstrapErrorCode,
  type EverOSBootstrapState,
} from '../shared/everosBootstrapStore.js'

export type EverCoreWelcomeHint = {
  text: string
  severity: 'info' | 'warning'
}

export type EverCoreWelcomeHintInput = {
  /**
   * Pre-computed bootstrap state. When omitted, the helper
   * reads the file synchronously. Pass an explicit value in
   * tests to avoid filesystem access.
   */
  bootstrap?: ReturnType<typeof readEverOSBootstrapStateSync>
  /**
   * Whether the model-visible MCP tools are enabled. When
   * omitted, the hint assumes `false` (the safe default).
   */
  mcpToolsEnabled?: boolean
}

/**
 * Render a one-line hint about MemoryOS state, suitable for
 * placing directly under the welcome card. Returns `null` when
 * there is nothing actionable to say (memory is disabled or fully
 * ready and the user has already opted into model-visible tools).
 */
export function formatEverCoreWelcomeHint(input: EverCoreWelcomeHintInput = {}): EverCoreWelcomeHint | null {
  const bootstrap = input.bootstrap ?? readEverOSBootstrapStateSync()
  if (!bootstrap) return null

  if (!bootstrap.ok) {
    return {
      severity: 'warning',
      text: chalk.yellow(
        `⚠ Memory: bootstrap state invalid (${bootstrap.errorCode}). Run: bbl memory status`,
      ),
    }
  }
  if (!bootstrap.exists || !bootstrap.state) {
    return {
      severity: 'info',
      text: chalk.dim(`Memory: not configured. Tip: bbl memory setup`),
    }
  }
  const state = bootstrap.state
  if (state.buildStatus === 'failed') {
    return {
      severity: 'warning',
      text: chalk.yellow(`⚠ Memory: setup failed (${state.errorCode ?? 'unknown'}). ${suggestFixAction(state)}`),
    }
  }
  if (
    state.buildStatus === 'cloning' ||
    state.buildStatus === 'building' ||
    state.buildStatus === 'checking_prereqs'
  ) {
    return {
      severity: 'info',
      text: chalk.dim(`Memory: ${state.buildStatus} in background…`),
    }
  }
  if (state.buildStatus === 'opted_out') {
    return {
      severity: 'info',
      text: chalk.dim(`Memory: opted out. Run: bbl memory setup to enable`),
    }
  }
  if (state.buildStatus === 'external') {
    return {
      severity: 'info',
      text: chalk.dim(`Memory: external MemoryOS. Set BABEL_O_EVERCORE_MODE=external + BABEL_O_EVERCORE_BASE_URL.`),
    }
  }
  if (state.buildStatus === 'ready' && input.mcpToolsEnabled === false) {
    return {
      severity: 'info',
      text: chalk.dim(`Memory: ready (read-only). bbl memory enable-tools to let the model write.`),
    }
  }
  return null
}

export function suggestEverCoreFixAction(state: EverOSBootstrapState): string {
  const code = state.errorCode as EverOSBootstrapErrorCode | null | undefined
  if (code === 'EVEROS_BOOTSTRAP_UV_MISSING') {
    return 'Install uv (https://docs.astral.sh/uv/) and run `bbl memory setup --retry`.'
  }
  if (code === 'EVEROS_BOOTSTRAP_PYTHON_MISSING') {
    return 'Install Python 3.12+ and run `bbl memory setup --retry`.'
  }
  if (code === 'EVEROS_BOOTSTRAP_GIT_MISSING') {
    return 'Install git and run `bbl memory setup --retry`.'
  }
  if (code === 'EVEROS_BOOTSTRAP_PACKAGE_MANAGER_UNSUPPORTED') {
    return 'Run `bbl memory setup --auto-install-prerequisites`, or install uv manually.'
  }
  if (code === 'EVEROS_BOOTSTRAP_CLONE_FAILED' || code === 'EVEROS_BOOTSTRAP_BUILD_FAILED') {
    return 'Run `bbl memory setup --retry` once the network / build issue is resolved.'
  }
  if (code === 'EVEROS_BOOTSTRAP_CONCURRENT_INSTALL_IN_PROGRESS') {
    return 'Another bbl is bootstrapping; wait a moment and re-run `bbl memory setup --retry`.'
  }
  return 'Run `bbl memory setup --retry` after fixing the underlying issue.'
}

// Internal alias kept for backwards compatibility with the
// earlier draft; suggestFixAction is now exported as
// suggestEverCoreFixAction.
function suggestFixAction(state: EverOSBootstrapState): string {
  return suggestEverCoreFixAction(state)
}
