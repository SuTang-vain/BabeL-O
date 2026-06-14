import {
  isEverOSBootstrapReady,
  readEverOSBootstrapStateSync,
  type EverOSBootstrapState,
} from '../shared/everosBootstrapStore.js'
import type { EverCoreConfigInput } from './everCoreConfig.js'

export type EverOSBootstrapDefaults = {
  input: Partial<EverCoreConfigInput>
  state: EverOSBootstrapState
}

const EXPLICIT_EVERCORE_ENV_KEYS = [
  'BABEL_O_EVERCORE_MODE',
  'BABEL_O_EVERCORE_ENABLED',
  'BABEL_O_EVERCORE_BASE_URL',
  'BABEL_O_EVERCORE_MANAGED_COMMAND',
  'BABEL_O_EVERCORE_DATA_DIR',
] as const

export function hasExplicitEverCoreEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return EXPLICIT_EVERCORE_ENV_KEYS.some(key => typeof env[key] === 'string' && env[key]!.trim().length > 0)
}

export function loadEverOSBootstrapDefaults(
  env: NodeJS.ProcessEnv = process.env,
): EverOSBootstrapDefaults | undefined {
  if (hasExplicitEverCoreEnv(env)) return undefined
  const read = readEverOSBootstrapStateSync({ env })
  if (!read.ok || !isEverOSBootstrapReady(read.state)) return undefined

  return {
    state: read.state,
    input: {
      mode: 'managed',
      managedCommand: read.state.managedCommand,
      managedDataDir: read.state.dataDir,
      // Persisted MCP tools toggle from `bbl memory enable-tools`.
      // The env var still wins because `applyEverOSBootstrapDefaults`
      // spreads defaults first and input second; the env-resolved
      // mcpToolsEnabled is set in `resolveEverCoreConfigInputFromEnv`
      // before defaults are applied.
      mcpToolsEnabled: read.state.mcpToolsEnabled,
    },
  }
}

export function applyEverOSBootstrapDefaults(
  input: EverCoreConfigInput,
  env: NodeJS.ProcessEnv = process.env,
): EverCoreConfigInput {
  const defaults = loadEverOSBootstrapDefaults(env)
  if (!defaults) return input
  return {
    ...defaults.input,
    ...input,
    mode: input.mode ?? defaults.input.mode,
    managedCommand: input.managedCommand ?? defaults.input.managedCommand,
    managedDataDir: input.managedDataDir ?? defaults.input.managedDataDir,
    mcpToolsEnabled: input.mcpToolsEnabled ?? defaults.input.mcpToolsEnabled,
  }
}
