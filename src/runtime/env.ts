/**
 * Phase 2D + 7 — `src/runtime/env.ts`
 *
 * `parseRuntimeEnv` is the single boot-time entry point for every
 * `BABEL_O_*` / `NEXUS_*` / `EVERCORE_*` / `EVEROS_*` / `ANTHROPIC_*` /
 * `OPENAI_*` env-var read on the Nexus / runtime hot path. The
 * resulting `RuntimeEnv` snapshot is constructed once at the
 * composition root and accessed through `RuntimeServices.env`
 * (see `src/runtime/services.ts`).
 *
 * Before this slice, `src/nexus/server.ts` had 21 direct
 * `process.env` reads, and the project-wide grep
 * `process\.env` in `src/nexus/` returned 47 hits across 10 files
 * (verified 2026-06-21). The new verification gate is
 * `grep -rn 'process\.env' src/nexus/` returning 0 hits.
 *
 * Why extracted:
 *
 * - `LLMCodingRuntime` and the Nexus composition root read env at
 *   boot time from many call sites. Each new env var adds another
 *   `process.env.X` reference and another place to keep defaults
 *   in sync. Centralizing into one `parseRuntimeEnv` snapshot makes
 *   the boot contract testable as a unit, and any future change
 *   to env-var precedence / default values / type coercion lives
 *   in one file.
 *
 * - The runtime hot path receives `RuntimeEnv` by reference (a
 *   frozen snapshot), not a live `process.env` reference, so tests
 *   can construct an in-memory `RuntimeEnv` and exercise the
 *   runtime without touching real env state.
 *
 * - The same shape (`RuntimeEnv`) is the field on `RuntimeServices`
 *   (Phase 2D). Constructing the container and the env snapshot
 *   together means runtime / Nexus / CLI composition paths all
 *   read the same values, eliminating the duplicate
 *   `resolveConfigDirForStorageEnv` logic that previously lived
 *   in both `nexus/createRuntime.ts` and `nexus/server.ts`.
 *
 * Goals:
 *
 * - Preserve exact behavior parity: every `process.env.X` read
 *   in `server.ts` becomes a typed field on `RuntimeEnv` with the
 *   same default fallback and the same parse / validate error
 *   semantics. Env vars that surface error paths
 *   (e.g. `NEXUS_API_KEY` invalid, `NEXUS_DEFAULT_POLICY_MODE`
 *   invalid) still call `process.exit(1)` from the same boot
 *   code path.
 * - Eliminate ~21 `process.env` reads from `src/nexus/server.ts`
 *   and the related `process.env` reads in `cli/embedded.ts` /
 *   `cli/runSessionFlow.ts` (deferred to follow-up PRs).
 *
 * Non-goals:
 *
 * - Do not change env-var names, default values, or precedence
 *   rules. Backward-compatible snapshot only.
 * - Do not move the `parseRuntimeEnv` definition into `src/nexus/`.
 *   This file lives under `src/runtime/` because the env snapshot
 *   is a runtime-composition concern, not a Nexus-server concern.
 */

// `RuntimeEnv` lives in `src/runtime/` and must not import from
// `src/nexus/`. The `storageWal` shape mirrors `StorageBridgeWalOptions`
// in `src/nexus/storageBridge.ts:48`; we redeclare a structurally
// equivalent type here to keep the runtime / nexus layer direction
// clean. Any new field on the Nexus-side options type should be
// mirrored here as part of the env contract review.
export type RuntimeEnvStorageWal = {
  batchSize?: number
  flushIntervalMs?: number
  fsync?: boolean
}

export type PolicyMode = 'strict' | 'soft-deny'
export type AgentExecutionEnvironment = 'local' | 'remote'

export type NexusEnv = {
  host: string
  port: number
  apiKey?: string
  executeTimeoutMs?: number
  maxConcurrentExecutions: number
  maxToolOutputBytes: number
  bashMaxBufferBytes: number
  storagePath?: string
  allowedTools?: string[]
  storageWal: RuntimeEnvStorageWal
  defaultPolicyMode: PolicyMode
  enableMcp: boolean
  enableAgentTools: boolean
  agentExecutionEnvironment?: AgentExecutionEnvironment
}

export type WorkspaceEnv = {
  cwd: string
  configDir: string
}

export type RuntimeEnv = {
  nexus: NexusEnv
  workspace: WorkspaceEnv
}

const DEFAULTS = {
  host: '127.0.0.1',
  port: 3000,
  maxConcurrentExecutions: 8,
  maxToolOutputBytes: 200_000,
  bashMaxBufferBytes: 1_000_000,
  defaultPolicyMode: 'strict' as PolicyMode,
  enableMcp: false,
  enableAgentTools: false,
} as const

function parsePositiveInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
    throw new Error(`expected positive integer, got ${JSON.stringify(value)}`)
  }
  return parsed
}

function parseNonNegativeInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed)) {
    throw new Error(`expected non-negative integer, got ${JSON.stringify(value)}`)
  }
  return parsed
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined
  const normalized = value.trim().toLowerCase()
  if (normalized === '1' || normalized === 'true' || normalized === 'yes') return true
  if (normalized === '0' || normalized === 'false' || normalized === 'no') return false
  return undefined
}

function parsePolicyMode(value: string | undefined): PolicyMode | undefined {
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

function parseAgentExecutionEnvironmentValue(
  value: string | undefined,
): AgentExecutionEnvironment | undefined {
  if (value === undefined) return undefined
  const normalized = value.trim().toLowerCase()
  if (normalized === 'local' || normalized === 'remote') return normalized
  throw new Error(`expected 'local' or 'remote', got ${JSON.stringify(value)}`)
}

function parseAllowedTools(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined
  const tools = value.split(',').map(s => s.trim()).filter(Boolean)
  return tools.length > 0 ? tools : undefined
}

function resolveConfigDir(env: NodeJS.ProcessEnv, homeDir: string): string {
  const explicit = env.BABEL_O_CONFIG_DIR
  if (explicit) return explicit
  if (env.BABEL_O_CONFIG_FILE) {
    const sep = env.BABEL_O_CONFIG_FILE.lastIndexOf('/')
    if (sep > 0) return env.BABEL_O_CONFIG_FILE.substring(0, sep)
    return homeDir
  }
  return `${homeDir}/.babel-o`
}

export function parseRuntimeEnv(
  env: NodeJS.ProcessEnv,
  homeDir: string = require('node:os').homedir(),
): RuntimeEnv {
  return {
    nexus: {
      host: env.NEXUS_HOST ?? DEFAULTS.host,
      port: Number(env.NEXUS_PORT ?? DEFAULTS.port),
      apiKey: env.NEXUS_API_KEY,
      executeTimeoutMs: parsePositiveInt(env.NEXUS_EXECUTE_TIMEOUT_MS),
      maxConcurrentExecutions:
        parsePositiveInt(env.NEXUS_MAX_CONCURRENT_EXECUTIONS) ?? DEFAULTS.maxConcurrentExecutions,
      maxToolOutputBytes:
        parsePositiveInt(env.NEXUS_MAX_TOOL_OUTPUT_BYTES) ?? DEFAULTS.maxToolOutputBytes,
      bashMaxBufferBytes:
        parsePositiveInt(env.NEXUS_BASH_MAX_BUFFER_BYTES) ?? DEFAULTS.bashMaxBufferBytes,
      storagePath: env.NEXUS_STORAGE_PATH,
      allowedTools: parseAllowedTools(env.NEXUS_ALLOWED_TOOLS),
      storageWal: {
        batchSize: parsePositiveInt(env.NEXUS_STORAGE_WAL_BATCH_SIZE),
        flushIntervalMs: parseNonNegativeInt(env.NEXUS_STORAGE_WAL_FLUSH_INTERVAL_MS),
        fsync: parseBoolean(env.NEXUS_STORAGE_WAL_FSYNC),
      },
      defaultPolicyMode: parsePolicyMode(env.NEXUS_DEFAULT_POLICY_MODE) ?? DEFAULTS.defaultPolicyMode,
      enableMcp: env.BABEL_O_ENABLE_MCP === '1' || DEFAULTS.enableMcp,
      enableAgentTools: env.BABEL_O_ENABLE_AGENT_TOOLS === '1' || DEFAULTS.enableAgentTools,
      agentExecutionEnvironment: parseAgentExecutionEnvironmentValue(
        env.NEXUS_AGENT_EXECUTION_ENVIRONMENT,
      ),
    },
    workspace: {
      cwd: env.BABEL_O_WORKSPACE ?? process.cwd(),
      configDir: resolveConfigDir(env, homeDir),
    },
  }
}
