import { createNexusApp, validateSecurityConfig } from './app.js'
import { createDefaultNexusRuntime, resolveDefaultStoragePath } from './createRuntime.js'
import { ConfigManager } from '../shared/config.js'
import { logger } from '../shared/logger.js'
import { configureEverCoreFromEnv } from './everCoreConfig.js'
import {
  assertAgentRemoteExecutionReady,
  assertRemoteRunnerReady,
  configureRemoteRunnerFromEnv,
  parseAgentExecutionEnvironment,
} from './remoteRunnerConfig.js'

const host = process.env.NEXUS_HOST ?? '127.0.0.1'
const port = Number(process.env.NEXUS_PORT ?? 3000)

try {
  validateSecurityConfig(host, process.env.NEXUS_API_KEY)
} catch (err: any) {
  logger.error('Nexus server failed security validation', err)
  process.exit(1)
}
const cwd = process.env.BABEL_O_WORKSPACE ?? process.cwd()
const storagePath = process.env.NEXUS_STORAGE_PATH
const allowedTools = parseAllowedTools(process.env.NEXUS_ALLOWED_TOOLS)
const executeTimeoutMs = parsePositiveInt(process.env.NEXUS_EXECUTE_TIMEOUT_MS)
const maxConcurrentExecutions =
  parsePositiveInt(process.env.NEXUS_MAX_CONCURRENT_EXECUTIONS) ?? 8
const maxToolOutputBytes =
  parsePositiveInt(process.env.NEXUS_MAX_TOOL_OUTPUT_BYTES) ?? 200_000
const bashMaxBufferBytes =
  parsePositiveInt(process.env.NEXUS_BASH_MAX_BUFFER_BYTES) ?? 1_000_000
const storageWalBatchSize = parsePositiveInt(process.env.NEXUS_STORAGE_WAL_BATCH_SIZE)
const storageWalFlushIntervalMs = parseNonNegativeInt(process.env.NEXUS_STORAGE_WAL_FLUSH_INTERVAL_MS)
const storageWalFsync = parseBoolean(process.env.NEXUS_STORAGE_WAL_FSYNC)
// Phase B 推进: server-side default for the per-request `policy`
// field. When a request body omits `policy`, this value is used
// (Go TUI already overrides per-request to `'soft-deny'`). Default
// is `'strict'` to preserve the existing behavior of `bbl chat` /
// HTTP API consumers. Set `NEXUS_DEFAULT_POLICY_MODE=soft-deny`
// to make ALL clients (CLI / HTTP / WS) reach the
// `permission_request` flow for write/execute tools instead of
// being hard-denied by `denyByDefaultTools()`.
let executePolicyMode: 'strict' | 'soft-deny' = 'strict'
try {
  const parsed = parsePolicyMode(process.env.NEXUS_DEFAULT_POLICY_MODE)
  if (parsed) executePolicyMode = parsed
} catch (err: any) {
  logger.error('Nexus server failed default policy mode validation', err)
  process.exit(1)
}

const enableMcp = process.env.BABEL_O_ENABLE_MCP === '1'
const enableAgentTools = process.env.BABEL_O_ENABLE_AGENT_TOOLS === '1'
let agentExecutionEnvironment: 'local' | 'remote' | undefined
try {
  agentExecutionEnvironment = parseAgentExecutionEnvironment(process.env.NEXUS_AGENT_EXECUTION_ENVIRONMENT)
} catch (err: any) {
  logger.error('Nexus server failed agent execution environment validation', err)
  process.exit(1)
}
const remoteRunner = await configureRemoteRunnerFromEnv()
try {
  assertRemoteRunnerReady(remoteRunner.status)
  assertAgentRemoteExecutionReady(agentExecutionEnvironment, remoteRunner.status)
} catch (err: any) {
  logger.error('Nexus server failed remote runner validation', err)
  process.exit(1)
}
const providerSettings = ConfigManager.getInstance().resolveSettings()
const everCore = await configureEverCoreFromEnv(process.env, { cwd, providerSettings })
const { runtime, storage, agentScheduler } = await createDefaultNexusRuntime({
  storagePath,
  allowedTools,
  cwd,
  enableMcp,
  enableAgentTools,
  remoteRunner: remoteRunner.runner,
  agentExecutionEnvironment,
  memoryProvider: everCore.memoryProvider,
  everCore: {
    client: everCore.client,
    config: everCore.config,
    dispose: everCore.dispose,
  },
  storageWal: {
    batchSize: storageWalBatchSize,
    flushIntervalMs: storageWalFlushIntervalMs,
    fsync: storageWalFsync,
  },
})
const app = await createNexusApp({
  runtime,
  storage,
  agentScheduler,
  defaultCwd: cwd,
  executeTimeoutMs,
  executePolicyMode,
  maxConcurrentExecutions,
  maxToolOutputBytes,
  bashMaxBufferBytes,
  remoteRunner: remoteRunner.runner,
  remoteRunnerStatus: remoteRunner.status,
  everCoreClient: everCore.client,
  everCoreConfig: everCore.config,
  everCoreStatus: everCore.status,
  memoryProvider: everCore.memoryProvider,
  agentExecutionEnvironment,
})

await app.listen({ host, port })

// Phase 3 of docs/nexus/reference/go-tui-session-observability-governance-plan.md:
// Write a startup line to `~/.babel-o/log/embedded-nexus.log` so the
// `bbl inspect-session` CLI (Phase 0, tier (c) fallback) can give the
// operator context about which Nexus instance was responsible when a
// session can't be found. The line format is deliberately
// machine-greppable (PID, storage, listen address, startedAt are all
// extracted by `grepRecentEmbeddedNexusStarts` in
// `src/cli/commands/inspectSession.ts`).
//
// Best-effort: failure to write is non-fatal (the log directory may
// not exist on a fresh install, or the user may have set the
// `BABEL_O_CONFIG_DIR` to a read-only path). We never throw from
// here because it would prevent Nexus from starting.
try {
  const { resolveDefaultStoragePath } = await import('./createRuntime.js')
  const resolved = resolveDefaultStoragePath(storagePath)
  const storageKindLabel = resolved.kind === 'sqlite' ? resolved.path : resolved.kind
  const policyMode = process.env.BABEL_O_NEXUS_DEFAULT_POLICY_MODE ?? 'strict'
  // ISO 8601 with timezone offset, RFC3339.
  const startedAt = new Date().toISOString()
  const configDir = process.env.BABEL_O_CONFIG_DIR
    ?? (process.env.BABEL_O_CONFIG_FILE
      ? require('node:path').dirname(process.env.BABEL_O_CONFIG_FILE)
      : require('node:path').join(require('node:os').homedir(), '.babel-o'))
  const logPath = require('node:path').join(configDir, 'log', 'embedded-nexus.log')
  const line = `[${startedAt}] nexus[pid=${process.pid}] listen=http://${host}:${port} storage=${storageKindLabel} executePolicyMode=${policyMode} cwd=${cwd}\n`
  require('node:fs').mkdirSync(require('node:path').dirname(logPath), { recursive: true })
  require('node:fs').appendFileSync(logPath, line, 'utf-8')
} catch {
  // Best-effort: never block Nexus startup on log-write failure.
}
console.log(
  `BabeL-O Nexus listening on http://${host}:${port}` +
    (storagePath ? ` storage=${storagePath}` : ' storage=memory') +
    (allowedTools
      ? ` allowedTools=${allowedTools.join(',')}`
      : ' allowedTools=default(read,grep,glob,task)') +
    ` mcp=${enableMcp ? 'enabled' : 'disabled'}` +
    ` agentTools=${enableAgentTools ? 'enabled' : 'disabled'}` +
    ` agentExecution=${agentExecutionEnvironment ?? 'local'}` +
    ` remoteRunner=${remoteRunner.status.healthy ? 'healthy' : remoteRunner.status.configured ? 'unhealthy' : 'disabled'}` +
    ` everCore=${everCore.status.enabled ? `${everCore.status.mode}:${everCore.status.healthy ? 'healthy' : 'unhealthy'}` : 'disabled'}` +
    ` maxConcurrentExecutions=${maxConcurrentExecutions}` +
    ` maxToolOutputBytes=${maxToolOutputBytes}` +
    ` bashMaxBufferBytes=${bashMaxBufferBytes}`,
)

function parseAllowedTools(value: string | undefined): string[] | undefined {
  if (!value) return undefined
  return value
    .split(',')
    .map(tool => tool.trim())
    .filter(Boolean)
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) return undefined
  return parsed
}

function parseNonNegativeInt(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) return undefined
  return parsed
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (!value) return undefined
  const normalized = value.trim().toLowerCase()
  if (normalized === '1' || normalized === 'true' || normalized === 'yes') return true
  if (normalized === '0' || normalized === 'false' || normalized === 'no') return false
  return undefined
}

function parsePolicyMode(value: string | undefined): 'strict' | 'soft-deny' | undefined {
  // Phase B 推进: validate the server-side default policy mode.
  // Unset → undefined (caller keeps the `strict` default for
  // back-compat with `bbl chat` / HTTP API consumers).
  // Empty string → undefined (same as unset).
  // Any other value → throw with a clear hint listing accepted
  // values, so a typo in the env var doesn't silently fall back
  // to `strict` and surprise the operator.
  if (value === undefined || value === '') return undefined
  const normalized = value.trim().toLowerCase()
  if (normalized === 'strict') return 'strict'
  if (normalized === 'soft-deny' || normalized === 'softdeny' || normalized === 'soft_deny') {
    return 'soft-deny'
  }
  throw new Error(
    `NEXUS_DEFAULT_POLICY_MODE must be one of "strict" or "soft-deny" (got: ${JSON.stringify(value)})`,
  )
}
