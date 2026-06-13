import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { DEFAULT_CONFIG_DIR } from '../shared/config.js'
import { errorMessage } from '../shared/errors.js'

export type EverCoreSidecarMode = 'disabled' | 'external' | 'managed'

export type EverCoreManagedLlmProtocol = 'openai-compatible' | 'anthropic-compatible'

export type EverCoreManagedLlmConfig = {
  protocol?: EverCoreManagedLlmProtocol
  apiKey?: string
  baseUrl?: string
  model?: string
}

export type EverCoreSidecarOptions = {
  mode?: EverCoreSidecarMode
  command?: string
  args?: string[]
  host?: string
  port?: number
  dataDir?: string
  startupTimeoutMs?: number
  healthIntervalMs?: number
  llm?: EverCoreManagedLlmConfig
  fetch?: typeof fetch
  spawn?: EverCoreSpawn
  portAllocator?: EverCorePortAllocator
}

export type EverCoreSidecarRuntime = {
  mode: EverCoreSidecarMode
  baseUrl?: string
  dataDir?: string
  status: EverCoreSidecarStatus
  dispose?(): Promise<void>
}

export type EverCoreSidecarStatus = {
  mode: EverCoreSidecarMode
  managed: boolean
  running: boolean
  healthy: boolean
  url?: string
  dataDir?: string
  pid?: number
  errorCode?: string
  errorMessage?: string
}

export type EverCoreSpawn = (
  command: string,
  args: string[],
  options: {
    env: NodeJS.ProcessEnv
    stdio: 'ignore'
    detached: false
  },
) => EverCoreProcess

export type EverCoreProcess = Pick<ChildProcessWithoutNullStreams, 'pid' | 'kill' | 'killed'> & {
  once(event: 'exit' | 'error', listener: (...args: any[]) => void): unknown
}

export type EverCorePortAllocator = (host: string) => Promise<number>

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_STARTUP_TIMEOUT_MS = 5_000
const DEFAULT_HEALTH_INTERVAL_MS = 100

export async function startManagedEverCoreSidecar(
  options: EverCoreSidecarOptions = {},
): Promise<EverCoreSidecarRuntime> {
  const mode = options.mode ?? 'disabled'
  if (mode !== 'managed') {
    return {
      mode,
      status: {
        mode,
        managed: false,
        running: false,
        healthy: true,
      },
    }
  }

  const host = options.host?.trim() || DEFAULT_HOST
  if (!isLocalHost(host)) {
    return failedManagedRuntime('EVERCORE_MANAGED_HOST_NOT_LOCAL', 'Managed EverCore sidecar must bind to 127.0.0.1, localhost, or ::1.')
  }

  let port = options.port
  if (port === undefined) {
    try {
      port = await (options.portAllocator ?? allocateLocalPort)(host)
    } catch (error) {
      return failedManagedRuntime('EVERCORE_MANAGED_PORT_ALLOC_FAILED', errorMessage(error))
    }
  }
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    return failedManagedRuntime('EVERCORE_MANAGED_PORT_INVALID', 'Managed EverCore sidecar port must be between 1 and 65535.')
  }

  const dataDir = options.dataDir?.trim() || join(DEFAULT_CONFIG_DIR, 'evercore')
  const baseUrl = `http://${host}:${port}`
  const command = options.command?.trim() || 'everos'
  const args = options.args ?? ['server', 'start', '--host', host, '--port', String(port)]
  const spawnImpl = options.spawn ?? spawnEverCore
  const fetchImpl = options.fetch ?? fetch

  try {
    await mkdir(dataDir, { recursive: true })
  } catch (error) {
    return failedManagedRuntime('EVERCORE_MANAGED_DATA_DIR_FAILED', errorMessage(error), baseUrl, dataDir)
  }

  let child: EverCoreProcess
  try {
    child = spawnImpl(command, args, {
      env: {
        ...process.env,
        ...buildEverCoreLlmEnv(options.llm),
        EVEROS_MEMORY__ROOT: dataDir,
        EVEROS_API__HOST: host,
        EVEROS_API__PORT: String(port),
      },
      stdio: 'ignore',
      detached: false,
    })
  } catch (error) {
    return failedManagedRuntime('EVERCORE_MANAGED_START_FAILED', errorMessage(error), baseUrl, dataDir)
  }

  const exitPromise = new Promise<Error>(resolve => {
    child.once('exit', (code: number | null, signal: string | null) => {
      resolve(new Error(`EverCore sidecar exited before healthy: code=${code ?? 'null'} signal=${signal ?? 'null'}.`))
    })
    child.once('error', (error: Error) => resolve(error))
  })

  try {
    await waitForEverCoreHealth(baseUrl, {
      fetch: fetchImpl,
      timeoutMs: options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
      intervalMs: options.healthIntervalMs ?? DEFAULT_HEALTH_INTERVAL_MS,
      exitPromise,
    })
  } catch (error) {
    stopEverCoreProcess(child)
    return failedManagedRuntime('EVERCORE_MANAGED_HEALTH_CHECK_FAILED', errorMessage(error), baseUrl, dataDir, child.pid)
  }

  return {
    mode: 'managed',
    baseUrl,
    dataDir,
    status: {
      mode: 'managed',
      managed: true,
      running: true,
      healthy: true,
      url: redactEverCoreUrl(baseUrl),
      dataDir,
      pid: child.pid,
    },
    async dispose() {
      stopEverCoreProcess(child)
    },
  }
}

async function waitForEverCoreHealth(
  baseUrl: string,
  options: {
    fetch: typeof fetch
    timeoutMs: number
    intervalMs: number
    exitPromise: Promise<Error>
  },
): Promise<void> {
  const deadline = Date.now() + options.timeoutMs
  let lastError: unknown
  while (Date.now() <= deadline) {
    const healthAttempt = fetchHealth(baseUrl, options.fetch)
    const result = await Promise.race([
      healthAttempt.then(() => undefined, error => error as Error),
      options.exitPromise,
    ])
    if (result === undefined) return
    lastError = result
    await delay(options.intervalMs)
  }
  throw lastError instanceof Error ? lastError : new Error('EverCore sidecar health check timed out.')
}

async function fetchHealth(baseUrl: string, fetchImpl: typeof fetch): Promise<void> {
  const response = await fetchImpl(`${baseUrl}/health`, { method: 'GET' })
  if (!response.ok) throw new Error(`EverCore health returned HTTP ${response.status}.`)
}

function failedManagedRuntime(
  errorCode: string,
  message: string,
  baseUrl?: string,
  dataDir?: string,
  pid?: number,
): EverCoreSidecarRuntime {
  return {
    mode: 'managed',
    baseUrl,
    dataDir,
    status: {
      mode: 'managed',
      managed: true,
      running: false,
      healthy: false,
      url: baseUrl ? redactEverCoreUrl(baseUrl) : undefined,
      dataDir,
      pid,
      errorCode,
      errorMessage: message,
    },
  }
}

function spawnEverCore(
  command: string,
  args: string[],
  options: {
    env: NodeJS.ProcessEnv
    stdio: 'ignore'
    detached: false
  },
): EverCoreProcess {
  return spawn(command, args, options)
}

async function allocateLocalPort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, host, () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : undefined
      server.close(error => {
        if (error) {
          reject(error)
        } else if (port) {
          resolve(port)
        } else {
          reject(new Error('No local port was allocated.'))
        }
      })
    })
  })
}

function stopEverCoreProcess(child: EverCoreProcess): void {
  if (!child.killed) child.kill('SIGTERM')
}

function buildEverCoreLlmEnv(llm: EverCoreManagedLlmConfig | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  const protocol = llm?.protocol?.trim()
  const apiKey = llm?.apiKey?.trim()
  const baseUrl = llm?.baseUrl?.trim()
  const model = llm?.model?.trim()
  if (protocol) env.EVEROS_LLM__PROTOCOL = protocol
  if (apiKey) env.EVEROS_LLM__API_KEY = apiKey
  if (baseUrl) env.EVEROS_LLM__BASE_URL = baseUrl
  if (model) env.EVEROS_LLM__MODEL = model
  return env
}

function isLocalHost(host: string): boolean {
  const normalized = host.toLowerCase()
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1'
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
