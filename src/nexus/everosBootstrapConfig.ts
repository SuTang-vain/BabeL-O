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
      ...resolveEmbeddingDefaultsFromState(read.state),
    },
  }
}

/**
 * Project the persisted `embeddingPassthrough` into the EverCoreConfigInput
 * fields the sidecar spawn reads. ollama's apiKey is the fixed non-secret
 * literal `'ollama'` (re-derived here, never stored); custom endpoints
 * leave apiKey unset so BABEL_O_EVERCORE_EMBEDDING_API_KEY env supplies it
 * at runtime. Returns an empty object when embedding was never configured
 * (the sidecar then surfaces EVERCORE_MANAGED_EMBEDDING_NOT_CONFIGURED).
 */
function resolveEmbeddingDefaultsFromState(state: EverOSBootstrapState): Partial<EverCoreConfigInput> {
  const embedding = state.embeddingPassthrough
  if (!embedding) return {}
  const model = embedding.model?.trim()
  const baseUrl = embedding.baseUrl?.trim()
  // ollama ignores the key but EverOS' factory requires a non-null api_key.
  const apiKey = embedding.source === 'ollama' ? 'ollama' : undefined
  return {
    managedEmbeddingModel: model,
    managedEmbeddingBaseUrl: baseUrl,
    managedEmbeddingApiKey: apiKey,
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
    // resolveEverCoreConfigInputFromEnv sets these to `undefined` when the
    // env vars are unset; the spread above would clobber the state-derived
    // defaults, so fall back explicitly (same pattern as mcpToolsEnabled).
    managedEmbeddingModel: input.managedEmbeddingModel ?? defaults.input.managedEmbeddingModel,
    managedEmbeddingApiKey: input.managedEmbeddingApiKey ?? defaults.input.managedEmbeddingApiKey,
    managedEmbeddingBaseUrl: input.managedEmbeddingBaseUrl ?? defaults.input.managedEmbeddingBaseUrl,
  }
}
