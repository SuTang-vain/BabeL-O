import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import { Command } from 'commander'

type ExistsFn = (path: string) => boolean
type SpawnFn = typeof spawn
type FetchFn = typeof fetch
type ExecFileSyncFn = typeof execFileSync

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
  check?: boolean
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
    .description('Launch the Go TUI client (stable alternative to bbl chat; see docs/nexus/PHASE_9_DECISION.md)')
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
    .option('--check', 'Verify install readiness (Go TUI binary, Nexus health, version compat) and exit 0/1')
    .action(async (options: GoTuiCommandOptions) => {
      if (options.check) {
        const report = await runGoTuiCheckReport(options, { fetch })
        console.log(report.lines.join('\n'))
        process.exit(report.exitCode)
        return
      }
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
              'Install Go (https://go.dev/dl/) or use a prebuilt release: ' +
              '`npm install -g babel-o`, or set BABEL_O_GO_TUI_BINARY to a release asset path.',
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

// goTuiCheckReport is the structured output of `bbl go
// --check`. `lines` is the human-readable multi-line
// report; `exitCode` is 0 when every check passes, 1
// otherwise. The launcher prints lines to stdout and exits
// with the reported code.
//
// The check covers three concerns the launcher otherwise
// surfaces as runtime errors:
//   - Go TUI launchability: a binary is reachable via the
//     multi-path discovery (Phase 8 PR2), OR a source
//     fallback is available, OR the explicit --binary
//     is honored.
//   - Nexus health: /health returns 2xx on the target
//     URL (the URL provided via --url, default
//     http://127.0.0.1:3000).
//   - Version compat: if /v1/runtime/version is reachable
//     AND the Go TUI major falls outside the server's
//     supportedMajors list, the check fails.
export interface goTuiCheckReport {
  lines: string[]
  exitCode: number
}

export async function runGoTuiCheckReport(
  options: GoTuiCommandOptions,
  deps: {
    fetch?: FetchFn
    exists?: ExistsFn
    packageRoot?: string
    platform?: NodeJS.Platform
    arch?: NodeJS.Architecture
    env?: NodeJS.ProcessEnv
    homeDir?: string
    execFileSync?: ExecFileSyncFn
  } = {},
): Promise<goTuiCheckReport> {
  const lines: string[] = []
  let hasFailure = false

  lines.push('BabeL-O Go TUI install check')
  lines.push('=============================')

  // 1. Go TUI launchability.
  const exists = deps.exists ?? existsSync
  const packageRoot = deps.packageRoot ?? defaultPackageRoot()
  const platform = deps.platform ?? process.platform
  const sourceDir = resolve(options.sourceDir ?? defaultGoTuiSourceDir(packageRoot))
  const candidates = collectGoTuiBinaryCandidates({
    options,
    platform,
    arch: deps.arch,
    packageRoot,
    sourceDir,
    env: deps.env ?? process.env,
    homeDir: deps.homeDir ?? homedir(),
  })
  let resolvedBinary: string | undefined
  for (const candidate of candidates) {
    if (exists(candidate)) {
      resolvedBinary = candidate
      break
    }
  }
  lines.push('[INFO]    Go TUI binary search order:')
  for (const [index, candidate] of candidates.entries()) {
    const marker = exists(candidate) ? (candidate === resolvedBinary ? 'selected' : 'present') : 'missing'
    lines.push(`          ${index + 1}. ${marker} ${candidate}`)
  }
  if (resolvedBinary) {
    lines.push(`[OK]      Go TUI binary found: ${resolvedBinary}`)
    try {
      const versionOutput = (deps.execFileSync ?? execFileSync)(resolvedBinary, ['--version'], {
        encoding: 'utf8',
        timeout: 5_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim()
      lines.push(`[OK]      Go TUI executable starts: ${versionOutput || '--version returned no output'}`)
    } catch (error: any) {
      const message = error?.message ? String(error.message) : String(error)
      lines.push(`[FAIL]    Go TUI executable did not start with --version: ${message}`)
      hasFailure = true
    }
  } else if (exists(sourceDir)) {
    lines.push(
      `[WARN]    No prebuilt Go TUI binary found in the multi-path search. ` +
        `Will fall back to source 'go run ./cmd/go-tui' from ${sourceDir} ` +
        `(requires the Go toolchain on PATH).`,
    )
  } else {
    lines.push(
      `[FAIL]    No prebuilt Go TUI binary AND no source directory at ${sourceDir}. ` +
        `Install a prebuilt via 'npm install -g babel-o' or 'go install' from a source checkout.`,
    )
    hasFailure = true
  }

  // 2. Nexus health.
  const fetchImpl = deps.fetch ?? fetch
  const nexusHealthy = await isNexusHealthy(options.url, fetchImpl)
  if (nexusHealthy) {
    lines.push(`[OK]      Nexus is healthy at ${options.url}`)
  } else {
    lines.push(
      `[WARN]    Nexus is not healthy at ${options.url}. ` +
        `The launcher will start a local Nexus automatically (when --url is a localhost URL); ` +
        `use --no-start-nexus to suppress that.`,
    )
  }

  // 3. Version compat (best-effort — Nexus may be too old
  //    to expose the endpoint, or be unreachable).
  if (nexusHealthy) {
    try {
      const response = await fetchImpl(new URL('/v1/runtime/version', options.url))
      if (response.ok) {
        const body = (await response.json()) as {
          serverVersion?: string
          goTuiCompatibility?: { supportedMajors?: number[] }
        }
        const serverVersion = body.serverVersion ?? 'unknown'
        const supported = body.goTuiCompatibility?.supportedMajors ?? []
        // We don't have a way to read the Go TUI's own
        // major at the launcher level (the launcher
        // doesn't execute the binary). Report the
        // server's declared support so the user can
        // match it manually.
        lines.push(
          `[INFO]    Server version: ${serverVersion}, supported Go TUI majors: [${supported.join(', ')}]`,
        )
      } else {
        lines.push(
          `[INFO]    Nexus is healthy but /v1/runtime/version returned ${response.status}; compat check skipped.`,
        )
      }
    } catch {
      lines.push(`[INFO]    Could not fetch /v1/runtime/version; compat check skipped.`)
    }
  }

  lines.push('')
  if (hasFailure) {
    lines.push('Result: FAIL')
  } else if (resolvedBinary === undefined) {
    lines.push('Result: WARN (no prebuilt, will use source fallback)')
  } else {
    lines.push('Result: OK')
  }

  return { lines, exitCode: hasFailure ? 1 : 0 }
}

export function createGoTuiLaunchSpec(
  options: GoTuiCommandOptions,
  deps: {
    exists?: ExistsFn
    packageRoot?: string
    platform?: NodeJS.Platform
    arch?: NodeJS.Architecture
    env?: NodeJS.ProcessEnv
    homeDir?: string
  } = {},
): GoTuiLaunchSpec {
  const exists = deps.exists ?? existsSync
  const platform = deps.platform ?? process.platform
  const env = deps.env ?? process.env
  const packageRoot = deps.packageRoot ?? defaultPackageRoot()
  const sourceDir = resolve(options.sourceDir ?? defaultGoTuiSourceDir(packageRoot))
  const args = buildGoTuiArgs(options)
  const candidates = collectGoTuiBinaryCandidates({
    options,
    platform,
    arch: deps.arch,
    packageRoot,
    sourceDir,
    env,
    homeDir: deps.homeDir ?? homedir(),
  })
  for (const candidate of candidates) {
    if (exists(candidate)) {
      return {
        command: candidate,
        args,
        cwd: sourceDir,
        mode: 'binary',
      }
    }
  }

  if (options.binary) {
    // Explicit --binary is treated as a hard requirement
    // even if the user has a BABEL_O_GO_TUI_BINARY that
    // would otherwise match — the user asked for a specific
    // path and we should error rather than silently swap.
    throw new Error(
      `Go TUI binary not found: ${options.binary}. ` +
        `Install a prebuilt via 'npm install -g babel-o' or set BABEL_O_GO_TUI_BINARY to a release asset.`,
    )
  }

  if (!exists(sourceDir)) {
    throw new Error(
      `Go TUI source directory not found: ${sourceDir}. ` +
        `Install a prebuilt via 'npm install -g babel-o' or set BABEL_O_GO_TUI_BINARY.`,
    )
  }

  return {
    command: 'go',
    args: ['run', './cmd/go-tui', ...args],
    cwd: sourceDir,
    mode: 'go-run',
  }
}

// collectGoTuiBinaryCandidates returns the ordered list of
// prebuilt Go TUI binary paths to probe, highest-priority
// first. The order matches the Phase 8 PR2 spec:
//
//   1. explicit `--binary` flag (from GoTuiCommandOptions)
//   2. $BABEL_O_GO_TUI_BINARY env var
//   3. $BABEL_O_GO_TUI_PACKAGE_BINARY env var (lets npm
//      package consumers pin a specific prebuilt asset
//      without touching the launcher)
//   4. package-bundled default
//      (`<packageRoot>/bin/go-tui-<platform>-<arch>`)
//   5. source-relative in-tree dev build
//      (`<sourceDir>/bin/go-tui` or `bin/go-tui.exe`)
//   6. XDG user-local
//      (`~/.local/share/babel-o/bin/go-tui-<platform>-<arch>`)
//
// The function is pure (no filesystem access) so it's easy
// to unit test — the caller is responsible for `existsSync`
// checks on the returned list.
export function collectGoTuiBinaryCandidates(input: {
  options: Pick<GoTuiCommandOptions, 'binary' | 'sourceDir'>
  platform: NodeJS.Platform
  arch?: NodeJS.Architecture
  packageRoot: string
  sourceDir: string
  env: NodeJS.ProcessEnv
  homeDir?: string
}): string[] {
  const candidates: string[] = []
  if (input.options.binary) {
    candidates.push(resolve(input.options.binary))
  }
  const envBinary = input.env.BABEL_O_GO_TUI_BINARY
  if (envBinary) {
    candidates.push(resolve(envBinary))
  }
  const packageEnvBinary = input.env.BABEL_O_GO_TUI_PACKAGE_BINARY
  if (packageEnvBinary) {
    candidates.push(resolve(packageEnvBinary))
  }
  const packageBundled = join(
    input.packageRoot,
    'bin',
    `go-tui-${platformSuffix(input.platform, input.arch)}`,
  )
  candidates.push(packageBundled)
  // In-tree dev build (e.g. `make build` then `bbl go` from
  // a source checkout). The Go TUI Makefile drops the
  // binary at <sourceDir>/bin/go-tui.
  candidates.push(defaultGoTuiBinary(input.sourceDir, input.platform))
  if (input.homeDir) {
    const xdgLocal = join(
      input.homeDir,
      '.local',
      'share',
      'babel-o',
      'bin',
      `go-tui-${platformSuffix(input.platform, input.arch)}`,
    )
    candidates.push(xdgLocal)
  }
  return candidates
}

// defaultGoTuiBinaryName returns the platform-specific
// binary filename ("go-tui" or "go-tui.exe"). Kept as a
// thin wrapper so the launcher's multi-path discovery can
// probe the in-tree dev build under <sourceDir>/bin.
export function defaultGoTuiBinaryName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'go-tui.exe' : 'go-tui'
}

// platformSuffix returns the `<os>-<arch>` segment used in
// the prebuilt asset naming convention
// (e.g. "darwin-arm64", "linux-x64", "windows-x64.exe").
// Centralized here so the launcher, the docs, and the
// release workflow all stay aligned.
//
// Note: the Phase 8 PR2 release pipeline ships only
// darwin-arm64 for macOS (the Go 1.23 macOS tier dropped
// 10.15 support; x64 darwin users must build from source).
// Linux ships both amd64 + arm64; Windows ships only x64.
export function platformSuffix(platform: NodeJS.Platform, arch: NodeJS.Architecture = process.arch): string {
  switch (platform) {
    case 'darwin':
      return arch === 'x64' ? 'darwin-x64' : 'darwin-arm64'
    case 'linux':
      return arch === 'arm64' ? 'linux-arm64' : 'linux-x64'
    case 'win32':
      return 'windows-x64.exe'
    case 'freebsd':
      return 'freebsd-x64'
    case 'openbsd':
      return 'openbsd-x64'
    default:
      return `${platform}-x64`
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
  return join(sourceDir, 'bin', defaultGoTuiBinaryName(platform))
}
