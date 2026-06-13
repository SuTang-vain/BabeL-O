import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, dirname, resolve } from 'node:path'
import { getProvider } from '../providers/registry.js'
import type { ResolvedSettings } from '../shared/config.js'
import { errorMessage } from '../shared/errors.js'
import {
  HttpEverCoreClient,
  type EverCoreClient,
  type EverCoreSearchMethod,
  type EverCoreSessionSyncConfig,
} from '../runtime/everCoreClient.js'
import { EverCoreMemoryProvider, type MemoryProvider } from '../runtime/memoryProvider.js'
import {
  startManagedEverCoreSidecar,
  type EverCoreSidecarMode,
  type EverCoreSidecarOptions,
  type EverCoreManagedLlmProtocol,
  type EverCoreSidecarStatus,
} from './everCoreSidecar.js'

export type EverCoreConfigInput = {
  mode?: EverCoreSidecarMode
  enabled?: boolean
  baseUrl?: string
  apiKey?: string
  timeoutMs?: number
  appId?: string
  projectId?: string
  projectIdMode?: string
  cwd?: string
  userId?: string
  agentId?: string
  retrieveMethod?: string
  topK?: number
  uploadOnSessionEnd?: boolean
  maxMessages?: number
  maxContentChars?: number
  mcpToolsEnabled?: boolean
  managedCommand?: string
  managedArgs?: string[]
  managedHost?: string
  managedPort?: number
  managedDataDir?: string
  managedStartupTimeoutMs?: number
  managedHealthIntervalMs?: number
  managedLlmProtocol?: EverCoreManagedLlmProtocol
  managedLlmApiKey?: string
  managedLlmBaseUrl?: string
  managedLlmModel?: string
  providerSettings?: ResolvedSettings
  managedSpawn?: EverCoreSidecarOptions['spawn']
  managedPortAllocator?: EverCoreSidecarOptions['portAllocator']
  fetch?: typeof fetch
}

export type EverCoreRuntimeConfig = EverCoreSessionSyncConfig & {
  retrieveMethod: EverCoreSearchMethod
  topK: number
  uploadOnSessionEnd: boolean
  mcpToolsEnabled: boolean
  projectIdSource?: EverCoreProjectIdSource
}

export type EverCoreProjectIdSource = 'explicit' | 'workspace' | 'default'

export type EverCoreNamespaceStatus = {
  layer: 'project_memory'
  isolationKey: 'projectId'
  sessionScoped: false
  projectIdSource: EverCoreProjectIdSource
  warningCode?: 'EVERCORE_PROJECT_ID_DEFAULT'
  warningMessage?: string
  guidance?: string
}

export type EverCoreStatus = {
  configured: boolean
  enabled: boolean
  healthy: boolean
  mode: EverCoreSidecarMode
  url?: string
  uploadOnSessionEnd: boolean
  appId?: string
  projectId?: string
  userId?: string
  agentId?: string
  retrieveMethod?: EverCoreSearchMethod
  topK?: number
  mcpToolsEnabled: boolean
  namespace?: EverCoreNamespaceStatus
  sidecar?: EverCoreSidecarStatus
  errorCode?: string
  errorMessage?: string
}

export type ConfiguredEverCore = {
  client?: EverCoreClient
  memoryProvider?: MemoryProvider
  config: EverCoreRuntimeConfig
  status: EverCoreStatus
  dispose?(): Promise<void>
}

export async function configureEverCoreFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: { cwd?: string; providerSettings?: ResolvedSettings } = {},
): Promise<ConfiguredEverCore> {
  return configureEverCore({
    mode: parseEverCoreMode(env.BABEL_O_EVERCORE_MODE),
    enabled: parseBoolean(env.BABEL_O_EVERCORE_ENABLED) ?? false,
    baseUrl: env.BABEL_O_EVERCORE_BASE_URL,
    apiKey: env.BABEL_O_EVERCORE_API_KEY,
    timeoutMs: parsePositiveInt(env.BABEL_O_EVERCORE_TIMEOUT_MS),
    appId: env.BABEL_O_EVERCORE_APP_ID,
    projectId: env.BABEL_O_EVERCORE_PROJECT_ID,
    projectIdMode: env.BABEL_O_EVERCORE_PROJECT_ID_MODE,
    cwd: options.cwd,
    userId: env.BABEL_O_EVERCORE_USER_ID,
    agentId: env.BABEL_O_EVERCORE_AGENT_ID,
    retrieveMethod: env.BABEL_O_EVERCORE_RETRIEVE_METHOD,
    topK: parsePositiveInt(env.BABEL_O_EVERCORE_TOP_K),
    uploadOnSessionEnd: parseBoolean(env.BABEL_O_EVERCORE_UPLOAD_ON_SESSION_END) ?? false,
    maxMessages: parsePositiveInt(env.BABEL_O_EVERCORE_MAX_MESSAGES),
    maxContentChars: parsePositiveInt(env.BABEL_O_EVERCORE_MAX_CONTENT_CHARS),
    mcpToolsEnabled: parseBoolean(env.BABEL_O_ENABLE_EVERCORE_MCP_TOOLS) ?? false,
    managedCommand: env.BABEL_O_EVERCORE_MANAGED_COMMAND,
    managedArgs: parseJsonStringArray(env.BABEL_O_EVERCORE_MANAGED_ARGS),
    managedHost: env.BABEL_O_EVERCORE_MANAGED_HOST,
    managedPort: parsePositiveInt(env.BABEL_O_EVERCORE_MANAGED_PORT),
    managedDataDir: env.BABEL_O_EVERCORE_DATA_DIR,
    managedStartupTimeoutMs: parsePositiveInt(env.BABEL_O_EVERCORE_MANAGED_STARTUP_TIMEOUT_MS),
    managedLlmProtocol: parseManagedLlmProtocol(env.BABEL_O_EVERCORE_LLM_PROTOCOL),
    managedLlmApiKey: env.BABEL_O_EVERCORE_LLM_API_KEY,
    managedLlmBaseUrl: env.BABEL_O_EVERCORE_LLM_BASE_URL,
    managedLlmModel: env.BABEL_O_EVERCORE_LLM_MODEL,
    providerSettings: options.providerSettings,
  })
}

export async function configureEverCore(
  input: EverCoreConfigInput = {},
): Promise<ConfiguredEverCore> {
  const mode = resolveEverCoreMode(input)
  const config = createEverCoreRuntimeConfig(input)
  if (mode === 'disabled') {
    const statusBase = createEverCoreStatusBase({
      configured: false,
      enabled: false,
      mode,
      config,
    })
    return {
      config,
      status: {
        ...statusBase,
        healthy: true,
      },
    }
  }

  let baseUrl = input.baseUrl?.trim()
  let sidecarStatus: EverCoreSidecarStatus | undefined
  let dispose: (() => Promise<void>) | undefined

  if (mode === 'managed') {
    const sidecar = await startManagedEverCoreSidecar({
      mode: 'managed',
      command: input.managedCommand,
      args: input.managedArgs,
      host: input.managedHost,
      port: input.managedPort,
      dataDir: input.managedDataDir,
      startupTimeoutMs: input.managedStartupTimeoutMs,
      healthIntervalMs: input.managedHealthIntervalMs,
      llm: resolveManagedEverCoreLlmConfig(input),
      fetch: input.fetch,
      spawn: input.managedSpawn,
      portAllocator: input.managedPortAllocator,
    })
    baseUrl = sidecar.baseUrl
    sidecarStatus = sidecar.status
    dispose = sidecar.dispose
    if (!sidecar.status.healthy) {
      const statusBase = createEverCoreStatusBase({
        configured: true,
        enabled: true,
        mode,
        url: baseUrl ? redactEverCoreUrl(baseUrl) : undefined,
        config,
        sidecar: sidecarStatus,
      })
      return {
        config,
        status: {
          ...statusBase,
          healthy: false,
          errorCode: sidecar.status.errorCode,
          errorMessage: sidecar.status.errorMessage,
        },
        dispose,
      }
    }
  }

  const statusBase = createEverCoreStatusBase({
    configured: baseUrl !== undefined && baseUrl.length > 0,
    enabled: true,
    mode,
    url: baseUrl ? redactEverCoreUrl(baseUrl) : undefined,
    config,
    sidecar: sidecarStatus,
  })

  if (!baseUrl) {
    return {
      config,
      status: {
        ...statusBase,
        configured: false,
        healthy: false,
        errorCode: 'EVERCORE_BASE_URL_REQUIRED',
        errorMessage: mode === 'external'
          ? 'BABEL_O_EVERCORE_MODE=external requires BABEL_O_EVERCORE_BASE_URL.'
          : 'EverCore managed sidecar did not provide a base URL.',
      },
      dispose,
    }
  }

  const client = new HttpEverCoreClient({
    baseUrl,
    apiKey: input.apiKey,
    timeoutMs: input.timeoutMs,
    fetch: input.fetch,
  })

  try {
    await client.health()
    return {
      client,
      memoryProvider: createEverCoreMemoryProvider(client, config),
      config,
      status: {
        ...statusBase,
        healthy: true,
      },
      dispose,
    }
  } catch (error) {
    return {
      client,
      config,
      status: {
        ...statusBase,
        healthy: false,
        errorCode: 'EVERCORE_HEALTH_CHECK_FAILED',
        errorMessage: errorMessage(error),
      },
      dispose,
    }
  }
}

function createEverCoreMemoryProvider(client: EverCoreClient, config: EverCoreRuntimeConfig): MemoryProvider {
  return new EverCoreMemoryProvider(client, {
    appId: config.appId,
    projectId: config.projectId,
    projectIdSource: config.projectIdSource,
    userId: config.userId,
    agentId: config.agentId,
    retrieveMethod: config.retrieveMethod,
    topK: config.topK,
    maxContentChars: config.maxContentChars,
  })
}

function resolveManagedEverCoreLlmConfig(input: EverCoreConfigInput): EverCoreSidecarOptions['llm'] | undefined {
  const explicit = {
    protocol: input.managedLlmProtocol,
    apiKey: input.managedLlmApiKey?.trim(),
    baseUrl: input.managedLlmBaseUrl?.trim(),
    model: input.managedLlmModel?.trim(),
  }
  if (explicit.protocol || explicit.apiKey || explicit.baseUrl || explicit.model) return explicit

  const settings = input.providerSettings
  if (!settings) return undefined
  try {
    const provider = getProvider(settings.providerId)
    const protocol = resolveEverCoreLlmProtocol(provider.adapter)
    if (!protocol) return undefined
    return {
      protocol,
      apiKey: settings.apiKey,
      baseUrl: settings.baseUrl,
      model: stripProviderPrefix(settings.modelId),
    }
  } catch {
    return undefined
  }
}

function resolveEverCoreLlmProtocol(adapter: string): EverCoreManagedLlmProtocol | undefined {
  if (adapter === 'openai-compatible' || adapter === 'openai-responses') return 'openai-compatible'
  if (adapter === 'anthropic-compatible') return 'anthropic-compatible'
  return undefined
}

function stripProviderPrefix(modelId: string): string {
  const slashIndex = modelId.indexOf('/')
  return slashIndex === -1 ? modelId : modelId.slice(slashIndex + 1)
}

function createEverCoreRuntimeConfig(input: EverCoreConfigInput): EverCoreRuntimeConfig {
  const explicitProjectId = input.projectId?.trim()
  const derivedProjectId = explicitProjectId ? undefined : deriveWorkspaceProjectId(input)
  return {
    appId: input.appId?.trim() || 'babel-o',
    projectId: explicitProjectId || derivedProjectId || 'default',
    projectIdSource: explicitProjectId ? 'explicit' : derivedProjectId ? 'workspace' : 'default',
    userId: input.userId?.trim() || undefined,
    agentId: input.agentId?.trim() || 'babel-o',
    retrieveMethod: parseRetrieveMethod(input.retrieveMethod) ?? 'hybrid',
    topK: input.topK ?? 5,
    uploadOnSessionEnd: input.uploadOnSessionEnd ?? false,
    maxMessages: input.maxMessages ?? 24,
    maxContentChars: input.maxContentChars ?? 4_000,
    mcpToolsEnabled: input.mcpToolsEnabled ?? false,
  }
}

function deriveWorkspaceProjectId(input: EverCoreConfigInput): string | undefined {
  if (input.projectIdMode?.trim().toLowerCase() !== 'workspace') return undefined
  if (!input.cwd) return undefined
  const workspaceRoot = findGitRoot(input.cwd) ?? resolve(input.cwd)
  const name = sanitizeProjectIdSegment(basename(workspaceRoot)) || 'workspace'
  const hash = createHash('sha256').update(workspaceRoot).digest('hex').slice(0, 12)
  return `${name}-${hash}`
}

function findGitRoot(cwd: string): string | undefined {
  let current = resolve(cwd)
  while (true) {
    if (existsSync(resolve(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

function sanitizeProjectIdSegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}

function createEverCoreStatusBase(input: {
  configured: boolean
  enabled: boolean
  mode: EverCoreSidecarMode
  url?: string
  config: EverCoreRuntimeConfig
  sidecar?: EverCoreSidecarStatus
}): Omit<EverCoreStatus, 'healthy'> {
  return {
    configured: input.configured,
    enabled: input.enabled,
    mode: input.mode,
    url: input.url,
    uploadOnSessionEnd: input.config.uploadOnSessionEnd,
    appId: input.config.appId,
    projectId: input.config.projectId,
    userId: input.config.userId,
    agentId: input.config.agentId,
    retrieveMethod: input.config.retrieveMethod,
    topK: input.config.topK,
    mcpToolsEnabled: input.config.mcpToolsEnabled,
    namespace: createEverCoreNamespaceStatus(input.config, input.enabled),
    sidecar: input.sidecar,
  }
}

function createEverCoreNamespaceStatus(config: EverCoreRuntimeConfig, enabled: boolean): EverCoreNamespaceStatus {
  const projectIdSource = config.projectIdSource ?? 'explicit'
  const base: EverCoreNamespaceStatus = {
    layer: 'project_memory',
    isolationKey: 'projectId',
    sessionScoped: false,
    projectIdSource,
  }
  if (enabled && projectIdSource === 'default') {
    return {
      ...base,
      warningCode: 'EVERCORE_PROJECT_ID_DEFAULT',
      warningMessage: 'EverCore project memory is using the default projectId; multiple workspaces can share long-term memory if they use the same default namespace.',
      guidance: 'Set BABEL_O_EVERCORE_PROJECT_ID per project, or set BABEL_O_EVERCORE_PROJECT_ID_MODE=workspace to derive a stable projectId from the git root or cwd before relying on project memory isolation.',
    }
  }
  return base
}

function resolveEverCoreMode(input: EverCoreConfigInput): EverCoreSidecarMode {
  if (input.mode) return input.mode
  if (input.enabled) return 'external'
  return 'disabled'
}

function parseEverCoreMode(value: string | undefined): EverCoreSidecarMode | undefined {
  if (!value) return undefined
  const normalized = value.trim().toLowerCase()
  if (normalized === 'disabled' || normalized === 'external' || normalized === 'managed') {
    return normalized
  }
  return undefined
}

function parseRetrieveMethod(value: string | undefined): EverCoreSearchMethod | undefined {
  if (!value) return undefined
  const normalized = value.trim().toLowerCase()
  if (
    normalized === 'keyword' ||
    normalized === 'vector' ||
    normalized === 'hybrid' ||
    normalized === 'agentic'
  ) {
    return normalized
  }
  return undefined
}

function parseJsonStringArray(value: string | undefined): string[] | undefined {
  if (!value) return undefined
  try {
    const parsed = JSON.parse(value)
    if (Array.isArray(parsed) && parsed.every(item => typeof item === 'string')) return parsed
  } catch {}
  return undefined
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (!value) return undefined
  const normalized = value.trim().toLowerCase()
  if (normalized === '1' || normalized === 'true' || normalized === 'yes') return true
  if (normalized === '0' || normalized === 'false' || normalized === 'no') return false
  return undefined
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) return undefined
  return parsed
}

function parseManagedLlmProtocol(value: string | undefined): EverCoreManagedLlmProtocol | undefined {
  if (value === 'openai-compatible' || value === 'anthropic-compatible') return value
  return undefined
}

function redactEverCoreUrl(raw: string): string {
  try {
    const url = new URL(raw)
    url.username = ''
    url.password = ''
    for (const key of [...url.searchParams.keys()]) {
      url.searchParams.set(key, '<redacted>')
    }
    return url.toString()
  } catch {
    return raw.replace(/\/\/[^/@]+@/, '//<redacted>@')
  }
}
