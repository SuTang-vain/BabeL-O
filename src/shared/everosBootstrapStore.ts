import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'

export const EVEROS_BOOTSTRAP_VERSION = 2

/**
 * Legacy v1 files (no policy / fallback fields) are still readable.
 * v1 bootstrap files are migrated in place: `autoBootstrapPolicy` defaults
 * to `'prompt'` (current behavior), `fallbackBuildTool` defaults to `'uv'`,
 * `llmPassthrough` stays undefined. Migration happens during `normalize`.
 */
export const EVEROS_BOOTSTRAP_LEGACY_VERSION = 1
export const EVEROS_BOOTSTRAP_FILE_ENV = 'BABEL_O_EVEROS_BOOTSTRAP_FILE'

export const everOSBootstrapBuildStatuses = [
  'not_started',
  'checking_prereqs',
  'cloning',
  'building',
  'ready',
  'failed',
  'opted_out',
  'external',
] as const

export type EverOSBootstrapBuildStatus = typeof everOSBootstrapBuildStatuses[number]

export const everOSBootstrapErrorCodes = [
  'EVEROS_BOOTSTRAP_GIT_MISSING',
  'EVEROS_BOOTSTRAP_PYTHON_MISSING',
  'EVEROS_BOOTSTRAP_UV_MISSING',
  'EVEROS_BOOTSTRAP_PACKAGE_MANAGER_UNSUPPORTED',
  'EVEROS_BOOTSTRAP_PACKAGE_INSTALL_FAILED',
  'EVEROS_BOOTSTRAP_CLONE_FAILED',
  'EVEROS_BOOTSTRAP_BUILD_FAILED',
  'EVEROS_BOOTSTRAP_COMMAND_NOT_FOUND',
  'EVEROS_BOOTSTRAP_CONCURRENT_INSTALL_IN_PROGRESS',
  'EVEROS_BOOTSTRAP_STATE_INVALID',
] as const

export type EverOSBootstrapErrorCode = typeof everOSBootstrapErrorCodes[number]

/**
 * Auto-bootstrap policy controls whether the runtime may attempt
 * to set up local long-term memory in the background without an
 * explicit interactive prompt.
 *
 * - `prompt` (default): TTY users see the first-run prompt, non-TTY stays off.
 * - `on`: every cold start attempts background bootstrap when pre-reqs are met.
 * - `off`: never auto-bootstrap; user must run `bbl memory setup` explicitly.
 */
export const everOSAutoBootstrapPolicies = ['off', 'on', 'prompt'] as const
export type EverOSAutoBootstrapPolicy = typeof everOSAutoBootstrapPolicies[number]

export const everOSFallbackBuildTools = ['uv', 'pip', 'none'] as const
export type EverOSFallbackBuildTool = typeof everOSFallbackBuildTools[number]

export type EverOSBootstrapLLMPassthrough = {
  protocol?: string
  model?: string
  source?: string
}

/**
 * Persisted embedding source chosen during `bbl memory setup`. Unlike
 * llmPassthrough (display-only — the live LLM config is derived from
 * providerSettings at runtime), embeddingPassthrough is the PRIMARY
 * source of embedding config: minimax exposes no embedding endpoint, so
 * the sidecar spawn reads this back via applyEverOSBootstrapDefaults.
 *
 * `source` is `'ollama'` (local, non-secret apiKey literal) or
 * `'custom'` (OpenAI-compatible endpoint supplied by the operator).
 * The apiKey is deliberately NOT persisted: ollama's is the fixed
 * non-secret string `'ollama'` (re-derived from source at inject time),
 * and custom endpoints must supply their key via
 * BABEL_O_EVERCORE_EMBEDDING_API_KEY env at runtime to avoid storing a
 * cloud secret in plaintext bootstrap state.
 */
export const everOSBootstrapEmbeddingSources = ['ollama', 'custom'] as const
export type EverOSBootstrapEmbeddingSource = typeof everOSBootstrapEmbeddingSources[number]

export type EverOSBootstrapEmbeddingPassthrough = {
  source: EverOSBootstrapEmbeddingSource
  model?: string
  baseUrl?: string
}

const EverOSBootstrapStateSchema = z.object({
  version: z.number().int().positive().default(EVEROS_BOOTSTRAP_VERSION),
  optedIn: z.boolean().optional(),
  optedOut: z.boolean().optional(),
  externalHintShown: z.boolean().optional(),
  sourceRepo: z.string().min(1).optional(),
  sourceRef: z.string().min(1).optional(),
  sourceCommit: z.string().min(1).optional(),
  sourceDir: z.string().min(1).optional(),
  dataDir: z.string().min(1).optional(),
  managedCommand: z.string().min(1).optional(),
  buildStatus: z.enum(everOSBootstrapBuildStatuses).optional(),
  lastCheckedAt: z.string().min(1).optional(),
  lastBuildAt: z.string().min(1).optional(),
  errorCode: z.enum(everOSBootstrapErrorCodes).nullable().optional(),
  errorMessage: z.string().nullable().optional(),
  autoBootstrapPolicy: z.enum(everOSAutoBootstrapPolicies).optional(),
  fallbackBuildTool: z.enum(everOSFallbackBuildTools).optional(),
  /**
   * Persisted override for `BABEL_O_ENABLE_EVERCORE_MCP_TOOLS`.
   * Written by `bbl memory enable-tools` / `disable-tools`.
   * Env still wins; this is the default when the env is unset.
   */
  mcpToolsEnabled: z.boolean().optional(),
  llmPassthrough: z
    .object({
      protocol: z.string().optional(),
      model: z.string().optional(),
      source: z.string().optional(),
    })
    .optional(),
  embeddingPassthrough: z
    .object({
      source: z.enum(everOSBootstrapEmbeddingSources),
      model: z.string().min(1).optional(),
      baseUrl: z.string().min(1).optional(),
    })
    .optional(),
})

export type EverOSBootstrapState = z.infer<typeof EverOSBootstrapStateSchema>

export type EverOSBootstrapReadResult =
  | { ok: true; path: string; exists: boolean; state?: EverOSBootstrapState }
  | { ok: false; path: string; exists: boolean; errorCode: 'EVEROS_BOOTSTRAP_STATE_INVALID'; errorMessage: string }

export type EverOSBootstrapStoreOptions = {
  env?: NodeJS.ProcessEnv
  lockTimeoutMs?: number
  retryIntervalMs?: number
}

export type EverOSBootstrapUpdateOptions = EverOSBootstrapStoreOptions & {
  now?: () => string
}

const DEFAULT_LOCK_TIMEOUT_MS = 5_000
const DEFAULT_RETRY_INTERVAL_MS = 25

export function resolveEverOSBootstrapFile(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env[EVEROS_BOOTSTRAP_FILE_ENV]?.trim()
  if (explicit) return path.resolve(expandHome(explicit))

  const configDir = env.BABEL_O_CONFIG_DIR?.trim()
    || (env.BABEL_O_CONFIG_FILE?.trim() ? path.dirname(path.resolve(expandHome(env.BABEL_O_CONFIG_FILE.trim()))) : undefined)
    || path.join(os.homedir(), '.babel-o')
  return path.join(path.resolve(expandHome(configDir)), 'everos-bootstrap.json')
}

export function defaultEverOSSourceDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(path.dirname(resolveEverOSBootstrapFile(env)), 'everos', 'source')
}

export function defaultEverOSDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(path.dirname(resolveEverOSBootstrapFile(env)), 'everos', 'data')
}

export async function readEverOSBootstrapState(
  options: EverOSBootstrapStoreOptions = {},
): Promise<EverOSBootstrapReadResult> {
  const file = resolveEverOSBootstrapFile(options.env)
  try {
    const raw = await fs.promises.readFile(file, 'utf8')
    return parseEverOSBootstrapState(raw, file, true)
  } catch (error: any) {
    if (error?.code === 'ENOENT') return { ok: true, path: file, exists: false }
    return {
      ok: false,
      path: file,
      exists: false,
      errorCode: 'EVEROS_BOOTSTRAP_STATE_INVALID',
      errorMessage: error?.message || String(error),
    }
  }
}

export function readEverOSBootstrapStateSync(
  options: EverOSBootstrapStoreOptions = {},
): EverOSBootstrapReadResult {
  const file = resolveEverOSBootstrapFile(options.env)
  try {
    const raw = fs.readFileSync(file, 'utf8')
    return parseEverOSBootstrapState(raw, file, true)
  } catch (error: any) {
    if (error?.code === 'ENOENT') return { ok: true, path: file, exists: false }
    return {
      ok: false,
      path: file,
      exists: false,
      errorCode: 'EVEROS_BOOTSTRAP_STATE_INVALID',
      errorMessage: error?.message || String(error),
    }
  }
}

export async function updateEverOSBootstrapState(
  transform: (current: EverOSBootstrapState | undefined) => EverOSBootstrapState,
  options: EverOSBootstrapUpdateOptions = {},
): Promise<EverOSBootstrapState> {
  const file = resolveEverOSBootstrapFile(options.env)
  return withEverOSBootstrapLock(file, async () => {
    const current = await readEverOSBootstrapState({ ...options, env: { ...options.env, [EVEROS_BOOTSTRAP_FILE_ENV]: file } })
    if (!current.ok) {
      throw Object.assign(new Error(current.errorMessage), { code: current.errorCode })
    }
    const next = normalizeEverOSBootstrapState(transform(current.state))
    await atomicWriteJson(file, next)
    return next
  }, options)
}

export async function writeEverOSBootstrapState(
  state: EverOSBootstrapState,
  options: EverOSBootstrapUpdateOptions = {},
): Promise<EverOSBootstrapState> {
  return updateEverOSBootstrapState(() => state, options)
}

export async function resetEverOSBootstrapState(options: EverOSBootstrapStoreOptions = {}): Promise<boolean> {
  const file = resolveEverOSBootstrapFile(options.env)
  return withEverOSBootstrapLock(file, async () => {
    try {
      await fs.promises.rm(file, { force: true })
      return true
    } catch (error: any) {
      if (error?.code === 'ENOENT') return false
      throw error
    }
  }, options)
}

export function createEverOSBootstrapState(input: Partial<EverOSBootstrapState> = {}): EverOSBootstrapState {
  return normalizeEverOSBootstrapState({
    version: EVEROS_BOOTSTRAP_VERSION,
    ...input,
  })
}

export function isEverOSBootstrapReady(state: EverOSBootstrapState | undefined): state is EverOSBootstrapState & {
  buildStatus: 'ready'
  managedCommand: string
  dataDir: string
} {
  return state?.buildStatus === 'ready'
    && typeof state.managedCommand === 'string'
    && state.managedCommand.trim().length > 0
    && typeof state.dataDir === 'string'
    && state.dataDir.trim().length > 0
}

function parseEverOSBootstrapState(raw: string, file: string, exists: boolean): EverOSBootstrapReadResult {
  try {
    const parsed = JSON.parse(raw)
    const validated = EverOSBootstrapStateSchema.safeParse(parsed)
    if (!validated.success) {
      return {
        ok: false,
        path: file,
        exists,
        errorCode: 'EVEROS_BOOTSTRAP_STATE_INVALID',
        errorMessage: validated.error.issues.map(issue => `${issue.path.join('.') || '<root>'}: ${issue.message}`).join('; '),
      }
    }
    return { ok: true, path: file, exists, state: normalizeEverOSBootstrapState(validated.data) }
  } catch (error: any) {
    return {
      ok: false,
      path: file,
      exists,
      errorCode: 'EVEROS_BOOTSTRAP_STATE_INVALID',
      errorMessage: error?.message || String(error),
    }
  }
}

function normalizeEverOSBootstrapState(state: EverOSBootstrapState): EverOSBootstrapState {
  // Migration: v1 files have no policy / fallback fields. We must
  // bump them to v2 with explicit defaults so consumers can rely on
  // the schema being present. The migration is non-destructive —
  // existing v1-only fields are preserved.
  const migrated: Record<string, unknown> = { ...state }
  if (typeof migrated.version !== 'number' || migrated.version < EVEROS_BOOTSTRAP_VERSION) {
    if (migrated.autoBootstrapPolicy === undefined) {
      migrated.autoBootstrapPolicy = 'prompt'
    }
    if (migrated.fallbackBuildTool === undefined) {
      migrated.fallbackBuildTool = 'uv'
    }
  }
  return EverOSBootstrapStateSchema.parse({
    ...migrated,
    version: EVEROS_BOOTSTRAP_VERSION,
  })
}

/**
 * Resolve the effective auto-bootstrap policy from a state file plus
 * the live environment. Precedence:
 *   1. explicit `BABEL_O_EVERCORE_AUTO_BOOTSTRAP` env (always wins)
 *   2. `state.autoBootstrapPolicy` (persisted by `bbl memory auto`)
 *   3. default `prompt`
 */
export function parseAutoBootstrapPolicy(input: {
  env?: NodeJS.ProcessEnv
  state?: EverOSBootstrapState
}): EverOSAutoBootstrapPolicy {
  const raw = input.env?.BABEL_O_EVERCORE_AUTO_BOOTSTRAP?.trim().toLowerCase()
  if (raw === '0' || raw === 'off' || raw === 'false' || raw === 'no') return 'off'
  if (raw === '1' || raw === 'on' || raw === 'true' || raw === 'yes') return 'on'
  if (raw === 'prompt' || raw === 'ask') return 'prompt'
  if (input.state?.autoBootstrapPolicy) return input.state.autoBootstrapPolicy
  return 'prompt'
}

async function withEverOSBootstrapLock<T>(
  file: string,
  fn: () => Promise<T>,
  options: EverOSBootstrapStoreOptions = {},
): Promise<T> {
  const lockFile = `${file}.lock`
  const timeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS
  const retryIntervalMs = options.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS
  const start = Date.now()
  await fs.promises.mkdir(path.dirname(file), { recursive: true })

  let handle: fs.promises.FileHandle | undefined
  while (!handle) {
    try {
      handle = await fs.promises.open(lockFile, 'wx', 0o600)
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }))
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error
      if (Date.now() - start >= timeoutMs) {
        throw Object.assign(
          new Error(`Timed out waiting for EverOS bootstrap lock: ${lockFile}`),
          { code: 'EVEROS_BOOTSTRAP_CONCURRENT_INSTALL_IN_PROGRESS' as EverOSBootstrapErrorCode },
        )
      }
      await delay(retryIntervalMs)
    }
  }

  try {
    return await fn()
  } finally {
    await handle.close().catch(() => undefined)
    await fs.promises.rm(lockFile, { force: true }).catch(() => undefined)
  }
}

async function atomicWriteJson(file: string, state: EverOSBootstrapState): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true })
  const tmp = path.join(path.dirname(file), `${path.basename(file)}.${process.pid}.${Date.now()}.tmp`)
  const data = `${JSON.stringify(state, null, 2)}\n`
  try {
    await fs.promises.writeFile(tmp, data, { encoding: 'utf8', mode: 0o600 })
    await fs.promises.rename(tmp, file)
  } catch (error) {
    await fs.promises.rm(tmp, { force: true }).catch(() => undefined)
    throw error
  }
}

function expandHome(value: string): string {
  if (value === '~') return os.homedir()
  if (value.startsWith(`~${path.sep}`)) return path.join(os.homedir(), value.slice(2))
  return value
}
