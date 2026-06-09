import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import { Command } from 'commander'

type ExistsFn = (path: string) => boolean
type SpawnFn = typeof spawn
type FetchFn = typeof fetch

export interface GoTuiCommandOptions {
  url: string
  cwd: string
  session?: string
  alt: boolean
  binary?: string
  sourceDir?: string
  startNexus?: boolean
  nexusStartupTimeoutMs?: string
  allowedTools?: string
  pollIntervalMs?: string
}

export interface GoTuiLaunchSpec {
  command: string
  args: string[]
  cwd: string
  mode: 'binary' | 'go-run'
}

export interface ManagedNexusLaunchSpec {
  command: string
  args: string[]
  env: Record<string, string>
  url: string
  managed: boolean
}

export function registerGoCommand(program: Command): void {
  program
    .command('go')
    .description('Launch the experimental Go TUI client')
    .option('--url <url>', 'Nexus base URL', 'http://127.0.0.1:3000')
    .option('--cwd <path>', 'Workspace directory', process.env.BABEL_O_LAUNCH_CWD ?? process.cwd())
    .option('--session <id>', 'Reuse an existing Nexus session id')
    .option('--no-alt', 'Disable terminal alternate screen')
    .option('--binary <path>', 'Use a prebuilt go-tui binary')
    .option('--source-dir <path>', 'Go TUI source directory', defaultGoTuiSourceDir())
    .option('--start-nexus', 'Start a local Nexus service automatically when --url is not healthy', true)
    .option('--no-start-nexus', 'Do not auto-start Nexus; connect to --url only')
    .option('--nexus-startup-timeout-ms <ms>', 'Milliseconds to wait for auto-started Nexus health', '8000')
    .option('--allowed-tools <tools>', 'Allowed tools for auto-started Nexus (default: env NEXUS_ALLOWED_TOOLS or *)')
    .option('--poll-interval-ms <ms>', 'Forward Go TUI config polling interval; 0 disables polling')
    .action(async (options: GoTuiCommandOptions) => {
      let launch: GoTuiLaunchSpec
      let managedNexus: Awaited<ReturnType<typeof ensureNexusForGoTui>> | undefined
      try {
        launch = createGoTuiLaunchSpec(options)
        managedNexus = await ensureNexusForGoTui(options)
      } catch (error: any) {
        console.error(`Error: ${error.message || error}`)
        process.exit(1)
      }
      let managedNexusCleaned = false
      const cleanupManagedNexus = () => {
        if (managedNexusCleaned) return
        managedNexusCleaned = true
        if (managedNexus?.status === 'started') {
          managedNexus.child?.kill?.()
        }
      }
      process.once('exit', cleanupManagedNexus)

      const child = spawn(launch.command, launch.args, {
        cwd: launch.cwd,
        stdio: 'inherit',
        env: process.env,
      })

      child.on('error', (error: NodeJS.ErrnoException) => {
        if (launch.mode === 'go-run' && error.code === 'ENOENT') {
          console.error(
            'Error: Go TUI binary was not found and the Go toolchain is unavailable. ' +
              'Install Go or build clients/go-tui/go-tui first.',
          )
        } else {
          console.error(`Error: failed to launch Go TUI: ${error.message}`)
        }
        cleanupManagedNexus()
        process.exit(1)
      })

      child.on('exit', code => {
        cleanupManagedNexus()
        process.exit(code ?? 0)
      })
    })
}

export function createGoTuiLaunchSpec(
  options: GoTuiCommandOptions,
  deps: { exists?: ExistsFn; packageRoot?: string; platform?: NodeJS.Platform } = {},
): GoTuiLaunchSpec {
  const exists = deps.exists ?? existsSync
  const packageRoot = deps.packageRoot ?? defaultPackageRoot()
  const sourceDir = resolve(options.sourceDir ?? defaultGoTuiSourceDir(packageRoot))
  const args = buildGoTuiArgs(options)
  const binary = resolve(options.binary ?? defaultGoTuiBinary(sourceDir, deps.platform ?? process.platform))

  if (exists(binary)) {
    return {
      command: binary,
      args,
      cwd: sourceDir,
      mode: 'binary',
    }
  }

  if (options.binary) {
    throw new Error(`Go TUI binary not found: ${binary}`)
  }

  if (!exists(sourceDir)) {
    throw new Error(`Go TUI source directory not found: ${sourceDir}`)
  }

  return {
    command: 'go',
    args: ['run', '.', ...args],
    cwd: sourceDir,
    mode: 'go-run',
  }
}

export function buildGoTuiArgs(options: Pick<GoTuiCommandOptions, 'url' | 'cwd' | 'session' | 'alt' | 'pollIntervalMs'>): string[] {
  const args = ['--url', options.url, '--cwd', options.cwd]
  if (options.session) {
    args.push('--session', options.session)
  }
  if (options.alt === false) {
    args.push('--alt=false')
  }
  if (options.pollIntervalMs !== undefined) {
    args.push('--poll-interval-ms', String(options.pollIntervalMs))
  }
  return args
}

export async function ensureNexusForGoTui(
  options: GoTuiCommandOptions,
  deps: {
    fetch?: FetchFn
    spawn?: SpawnFn
    sleep?: (ms: number) => Promise<void>
    now?: () => number
    argv?: string[]
    execArgv?: string[]
    env?: NodeJS.ProcessEnv
  } = {},
): Promise<{ status: 'existing' | 'started' | 'skipped'; child?: ChildProcess }> {
  const fetchImpl = deps.fetch ?? fetch
  if (await isNexusHealthy(options.url, fetchImpl)) {
    return { status: 'existing' }
  }

  if (options.startNexus === false) {
    return { status: 'skipped' }
  }

  if (!isLocalNexusUrl(options.url)) {
    throw new Error(`Nexus is not healthy at ${options.url}; automatic startup is only supported for localhost URLs.`)
  }

  const spec = createManagedNexusLaunchSpec(options, {
    argv: deps.argv,
    execArgv: deps.execArgv,
    env: deps.env,
  })
  const child = (deps.spawn ?? spawn)(spec.command, spec.args, {
    stdio: 'ignore',
    env: spec.env,
  })
  child.unref?.()

  try {
    await waitForNexusHealth(options.url, {
      fetch: fetchImpl,
      timeoutMs: parsePositiveIntOption(options.nexusStartupTimeoutMs, 8000),
      sleep: deps.sleep,
      now: deps.now,
    })
  } catch (error) {
    child.kill?.()
    throw error
  }

  return { status: 'started', child }
}

export function createManagedNexusLaunchSpec(
  options: Pick<GoTuiCommandOptions, 'url' | 'cwd' | 'allowedTools'>,
  deps: { argv?: string[]; execArgv?: string[]; env?: NodeJS.ProcessEnv } = {},
): ManagedNexusLaunchSpec {
  const parsed = parseLocalNexusUrl(options.url)
  if (!parsed) {
    throw new Error(`Cannot auto-start Nexus for non-local URL: ${options.url}`)
  }
  const argv = deps.argv ?? process.argv
  const execArgv = deps.execArgv ?? process.execArgv
  const programPath = argv[1]
  const args = programPath && (programPath.endsWith('.js') || programPath.endsWith('.ts'))
    ? [...execArgv, programPath, '__server']
    : ['__server']
  const env = deps.env ?? process.env
  return {
    command: process.execPath,
    args,
    url: options.url,
    managed: true,
    env: {
      ...env,
      NEXUS_HOST: parsed.hostname,
      NEXUS_PORT: String(parsed.port),
      BABEL_O_WORKSPACE: options.cwd,
      NEXUS_ALLOWED_TOOLS: options.allowedTools ?? env.NEXUS_ALLOWED_TOOLS ?? '*',
    },
  }
}

export async function isNexusHealthy(url: string, fetchImpl: FetchFn = fetch): Promise<boolean> {
  try {
    const response = await fetchImpl(new URL('/health', healthProbeBaseUrl(url)), { method: 'GET' })
    return response.ok
  } catch {
    return false
  }
}

export async function waitForNexusHealth(
  url: string,
  options: {
    fetch?: FetchFn
    timeoutMs?: number
    intervalMs?: number
    sleep?: (ms: number) => Promise<void>
    now?: () => number
  } = {},
): Promise<void> {
  const fetchImpl = options.fetch ?? fetch
  const sleep = options.sleep ?? ((ms: number) => new Promise(resolve => setTimeout(resolve, ms)))
  const now = options.now ?? (() => Date.now())
  const timeoutMs = options.timeoutMs ?? 8000
  const intervalMs = options.intervalMs ?? 150
  const startedAt = now()
  while (now() - startedAt <= timeoutMs) {
    if (await isNexusHealthy(url, fetchImpl)) {
      return
    }
    await sleep(intervalMs)
  }
  throw new Error(`Timed out waiting for Nexus health at ${url}`)
}

export function isLocalNexusUrl(value: string): boolean {
  return parseLocalNexusUrl(value) !== undefined
}

function parseLocalNexusUrl(value: string): { hostname: string; port: number } | undefined {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'ws:') return undefined
  const hostname = parsed.hostname.toLowerCase()
  if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '::1' && hostname !== '[::1]') {
    return undefined
  }
  const port = parsed.port ? Number(parsed.port) : (parsed.protocol === 'ws:' ? 80 : 80)
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) return undefined
  return {
    hostname: hostname === '[::1]' ? '::1' : hostname,
    port,
  }
}

function healthProbeBaseUrl(value: string): string {
  const parsed = new URL(value)
  if (parsed.protocol === 'ws:') parsed.protocol = 'http:'
  if (parsed.protocol === 'wss:') parsed.protocol = 'https:'
  return parsed.toString()
}

function parsePositiveIntOption(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

export function defaultPackageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
}

export function defaultGoTuiSourceDir(packageRoot = defaultPackageRoot()): string {
  return join(packageRoot, 'clients', 'go-tui')
}

export function defaultGoTuiBinary(sourceDir = defaultGoTuiSourceDir(), platform: NodeJS.Platform = process.platform): string {
  return join(sourceDir, platform === 'win32' ? 'go-tui.exe' : 'go-tui')
}
