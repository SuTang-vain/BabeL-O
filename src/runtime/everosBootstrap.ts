import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import {
  createEverOSBootstrapState,
  defaultEverOSDataDir,
  defaultEverOSSourceDir,
  readEverOSBootstrapState,
  resetEverOSBootstrapState,
  updateEverOSBootstrapState,
  type EverOSBootstrapErrorCode,
  type EverOSBootstrapState,
} from '../shared/everosBootstrapStore.js'
import {
  defaultCommandRunner,
  inspectEverOSPrerequisites,
  installMissingEverOSPrerequisites,
  type CommandRunner,
} from './everosPrerequisites.js'
import {
  buildEverOSSourceWithPip,
  detectPipFallbackAvailability,
} from './everosFallbackBuild.js'
import {
  probeEverCoreSidecarHealth,
  formatEverCoreSidecarHealthLine,
} from './everCoreSidecarHealth.js'

export type EverOSSetupOptions = {
  env?: NodeJS.ProcessEnv
  runner?: CommandRunner
  assumeYes?: boolean
  retry?: boolean
  autoInstallPrerequisites?: boolean
  nonInteractive?: boolean
  sourceRepo?: string
  sourceRef?: string
  sourceDir?: string
  dataDir?: string
  stdout?: NodeJS.WriteStream
  stdin?: NodeJS.ReadStream
}

export type EverOSSetupResult = {
  ok: boolean
  skipped?: boolean
  state?: EverOSBootstrapState
  errorCode?: EverOSBootstrapErrorCode
  errorMessage?: string
}

export const DEFAULT_EVEROS_SOURCE_REPO = 'https://github.com/EverMind-AI/EverOS.git'
export const DEFAULT_EVEROS_SOURCE_REF = 'main'

export async function runEverOSMemorySetup(options: EverOSSetupOptions = {}): Promise<EverOSSetupResult> {
  const env = options.env ?? process.env
  const runner = options.runner ?? defaultCommandRunner
  const stdout = options.stdout ?? process.stdout
  const sourceRepo = options.sourceRepo ?? env.BABEL_O_EVERCORE_SOURCE_REPO ?? DEFAULT_EVEROS_SOURCE_REPO
  const sourceRef = options.sourceRef ?? env.BABEL_O_EVERCORE_SOURCE_REF ?? DEFAULT_EVEROS_SOURCE_REF
  const sourceDir = path.resolve(options.sourceDir ?? env.BABEL_O_EVERCORE_SOURCE_DIR ?? defaultEverOSSourceDir(env))
  const dataDir = path.resolve(options.dataDir ?? env.BABEL_O_EVERCORE_DATA_DIR ?? defaultEverOSDataDir(env))

  const existing = await readEverOSBootstrapState({ env })
  if (existing.ok && existing.state?.buildStatus === 'ready' && !options.retry) {
    stdout.write(`MemoryOS bootstrap is already ready at ${existing.path}\n`)
    return { ok: true, skipped: true, state: existing.state }
  }

  await updateEverOSBootstrapState(current => createEverOSBootstrapState({
    ...current,
    optedIn: true,
    optedOut: false,
    externalHintShown: false,
    sourceRepo,
    sourceRef,
    sourceDir,
    dataDir,
    buildStatus: 'checking_prereqs',
    lastCheckedAt: new Date().toISOString(),
    errorCode: null,
    errorMessage: null,
  }), { env })

  const prereqs = await inspectEverOSPrerequisites(runner)
  if (!prereqs.ok) {
    if (options.autoInstallPrerequisites && !options.nonInteractive) {
      const proceed = options.assumeYes || await confirm(
        `Install missing prerequisites automatically? ${prereqs.installHint ?? ''} `,
        options,
      )
      if (proceed) {
        const install = await installMissingEverOSPrerequisites(prereqs, runner)
        if (!install.ok) {
          return await failBootstrap(env, 'EVEROS_BOOTSTRAP_PACKAGE_INSTALL_FAILED', install.errorMessage ?? 'Failed to install prerequisites.')
        }
      } else {
        return await failBootstrap(env, firstMissingErrorCode(prereqs.missing), prereqs.installHint ?? `Missing prerequisites: ${prereqs.missing.join(', ')}`)
      }
    } else {
      return await failBootstrap(env, firstMissingErrorCode(prereqs.missing), prereqs.installHint ?? `Missing prerequisites: ${prereqs.missing.join(', ')}`)
    }
  }

  await updateEverOSBootstrapState(current => createEverOSBootstrapState({
    ...current,
    buildStatus: 'cloning',
    lastCheckedAt: new Date().toISOString(),
  }), { env })

  const clone = await ensureEverOSCheckout({ runner, sourceRepo, sourceRef, sourceDir })
  if (!clone.ok) {
    return await failBootstrap(env, 'EVEROS_BOOTSTRAP_CLONE_FAILED', clone.errorMessage ?? 'Failed to clone MemoryOS source.')
  }

  await updateEverOSBootstrapState(current => createEverOSBootstrapState({
    ...current,
    buildStatus: 'building',
    sourceCommit: clone.sourceCommit,
    lastCheckedAt: new Date().toISOString(),
  }), { env })

  const build = await buildEverOSSource({ runner, sourceDir, fallbackBuildTool: readFallbackBuildTool(existing.ok ? existing.state : undefined) })
  if (!build.ok) {
    return await failBootstrap(env, 'EVEROS_BOOTSTRAP_BUILD_FAILED', build.errorMessage ?? 'Failed to build MemoryOS source.')
  }

  const managedCommand = resolveManagedCommand(sourceDir)
  if (!managedCommand) {
    return await failBootstrap(env, 'EVEROS_BOOTSTRAP_COMMAND_NOT_FOUND', 'MemoryOS build completed but no local everos executable was found in the virtual environment.')
  }

  const ready = await updateEverOSBootstrapState(current => createEverOSBootstrapState({
    ...current,
    optedIn: true,
    optedOut: false,
    sourceRepo,
    sourceRef,
    sourceCommit: clone.sourceCommit,
    sourceDir,
    dataDir,
    managedCommand,
    buildStatus: 'ready',
    fallbackBuildTool: build.tool,
    lastCheckedAt: new Date().toISOString(),
    lastBuildAt: new Date().toISOString(),
    errorCode: null,
    errorMessage: null,
  }), { env })

  stdout.write(`MemoryOS local memory bootstrap is ready.\n`)
  stdout.write(`  command: ${managedCommand}\n  dataDir: ${dataDir}\n`)
  return { ok: true, state: ready }
}

export async function markEverOSMemoryOptOut(options: EverOSSetupOptions = {}): Promise<EverOSBootstrapState> {
  return updateEverOSBootstrapState(current => createEverOSBootstrapState({
    ...current,
    optedIn: false,
    optedOut: true,
    externalHintShown: false,
    buildStatus: 'opted_out',
    lastCheckedAt: new Date().toISOString(),
    errorCode: null,
    errorMessage: null,
  }), { env: options.env })
}

export async function markEverOSMemoryExternalHint(options: EverOSSetupOptions = {}): Promise<EverOSBootstrapState> {
  return updateEverOSBootstrapState(current => createEverOSBootstrapState({
    ...current,
    optedIn: false,
    optedOut: false,
    externalHintShown: true,
    buildStatus: 'external',
    lastCheckedAt: new Date().toISOString(),
    errorCode: null,
    errorMessage: null,
  }), { env: options.env })
}

export async function resetEverOSMemorySetup(options: EverOSSetupOptions = {}): Promise<boolean> {
  return resetEverOSBootstrapState({ env: options.env })
}

export async function formatEverOSMemorySetupStatus(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const read = await readEverOSBootstrapState({ env })
  if (!read.ok) {
    return [
      'MemoryOS bootstrap state is invalid.',
      `path: ${read.path}`,
      `error: ${read.errorCode} ${read.errorMessage}`,
    ].join('\n')
  }
  if (!read.exists || !read.state) {
    return [
      'MemoryOS bootstrap has not been configured.',
      `path: ${read.path}`,
      'Run: bbl memory setup',
    ].join('\n')
  }
  const state = read.state
  // Probe the sidecar's actual health (not just bootstrap buildStatus) so
  // `bbl memory status` stops reporting "ready" while the sidecar is dead.
  // See proposals/evercore-managed-sidecar-live-validation-and-config-
  // passthrough-plan.md Phase 4.
  let sidecarLine: string | undefined
  if (state.buildStatus === 'ready' && state.dataDir) {
    const probe = await probeEverCoreSidecarHealth(state.dataDir)
    sidecarLine = formatEverCoreSidecarHealthLine(probe)
  }
  return [
    'MemoryOS Bootstrap',
    `path: ${read.path}`,
    `status: ${state.buildStatus ?? 'not_started'}`,
    `optedIn: ${state.optedIn === true ? 'yes' : 'no'}`,
    `optedOut: ${state.optedOut === true ? 'yes' : 'no'}`,
    state.autoBootstrapPolicy ? `autoBootstrapPolicy: ${state.autoBootstrapPolicy}` : undefined,
    state.fallbackBuildTool ? `fallbackBuildTool: ${state.fallbackBuildTool}` : undefined,
    state.mcpToolsEnabled !== undefined ? `mcpToolsEnabled: ${state.mcpToolsEnabled ? 'yes' : 'no'}` : undefined,
    state.llmPassthrough ? formatLLMPassthroughLine(state.llmPassthrough) : undefined,
    state.externalHintShown ? 'externalHintShown: yes' : undefined,
    state.sourceRepo ? `sourceRepo: ${state.sourceRepo}` : undefined,
    state.sourceRef ? `sourceRef: ${state.sourceRef}` : undefined,
    state.sourceCommit ? `sourceCommit: ${state.sourceCommit}` : undefined,
    state.sourceDir ? `sourceDir: ${state.sourceDir}` : undefined,
    state.dataDir ? `dataDir: ${state.dataDir}` : undefined,
    state.managedCommand ? `managedCommand: ${state.managedCommand}` : undefined,
    state.lastCheckedAt ? `lastCheckedAt: ${state.lastCheckedAt}` : undefined,
    state.lastBuildAt ? `lastBuildAt: ${state.lastBuildAt}` : undefined,
    state.errorCode ? `errorCode: ${state.errorCode}` : undefined,
    state.errorMessage ? `errorMessage: ${state.errorMessage}` : undefined,
    sidecarLine,
  ].filter(Boolean).join('\n')
}

async function ensureEverOSCheckout(options: {
  runner: CommandRunner
  sourceRepo: string
  sourceRef: string
  sourceDir: string
}): Promise<{ ok: true; sourceCommit?: string } | { ok: false; errorMessage: string }> {
  if (!fs.existsSync(path.join(options.sourceDir, '.git'))) {
    await fs.promises.mkdir(path.dirname(options.sourceDir), { recursive: true })
    const clone = await options.runner('git', ['clone', '--depth', '1', '--branch', options.sourceRef, options.sourceRepo, options.sourceDir])
    if (clone.code !== 0) return { ok: false, errorMessage: clone.stderr || clone.stdout }
  } else {
    const fetch = await options.runner('git', ['fetch', '--depth', '1', 'origin', options.sourceRef], { cwd: options.sourceDir })
    if (fetch.code !== 0) return { ok: false, errorMessage: fetch.stderr || fetch.stdout }
    const checkout = await options.runner('git', ['checkout', 'FETCH_HEAD'], { cwd: options.sourceDir })
    if (checkout.code !== 0) return { ok: false, errorMessage: checkout.stderr || checkout.stdout }
  }
  const rev = await options.runner('git', ['rev-parse', 'HEAD'], { cwd: options.sourceDir })
  return { ok: true, sourceCommit: rev.code === 0 ? rev.stdout.trim() : undefined }
}

async function buildEverOSSource(options: {
  runner: CommandRunner
  sourceDir: string
  fallbackBuildTool: 'uv' | 'pip' | 'none'
}): Promise<{ ok: true; tool: 'uv' | 'pip' } | { ok: false; errorMessage: string }> {
  if (options.fallbackBuildTool === 'pip') {
    const pipResult = await buildEverOSSourceWithPip({ runner: options.runner, sourceDir: options.sourceDir })
    return pipResult.ok ? { ok: true, tool: 'pip' } : { ok: false, errorMessage: pipResult.errorMessage }
  }
  const uvCheck = await options.runner('uv', ['--version'])
  if (uvCheck.code !== 0) {
    const pipAvail = await detectPipFallbackAvailability(options.runner)
    if (pipAvail.available) {
      const pipResult = await buildEverOSSourceWithPip({ runner: options.runner, sourceDir: options.sourceDir })
      return pipResult.ok ? { ok: true, tool: 'pip' } : { ok: false, errorMessage: pipResult.errorMessage }
    }
    return { ok: false, errorMessage: 'uv is not available and pip fallback is not supported on this machine' }
  }
  const sync = await options.runner('uv', ['sync', '--frozen'], { cwd: options.sourceDir })
  if (sync.code !== 0) {
    // uv sync --frozen fails when the upstream repo does not
    // commit a uv.lock. Try a non-frozen sync as a last resort
    // before giving up.
    const nonFrozen = await options.runner('uv', ['sync'], { cwd: options.sourceDir })
    if (nonFrozen.code !== 0) {
      return { ok: false, errorMessage: sync.stderr || sync.stdout }
    }
  }
  return { ok: true, tool: 'uv' }
}

function readFallbackBuildTool(state: EverOSBootstrapState | undefined): 'uv' | 'pip' | 'none' {
  if (state?.fallbackBuildTool === 'pip') return 'pip'
  return 'uv'
}

function formatLLMPassthroughLine(passthrough: NonNullable<EverOSBootstrapState['llmPassthrough']>): string {
  const parts: string[] = ['llmPassthrough:']
  if (passthrough.protocol) parts.push(`protocol=${passthrough.protocol}`)
  if (passthrough.model) parts.push(`model=${passthrough.model}`)
  if (passthrough.source) parts.push(`source=${passthrough.source}`)
  if (parts.length === 1) return 'llmPassthrough: (none)'
  return parts.join(' ')
}

function resolveManagedCommand(sourceDir: string): string | undefined {
  const candidates = process.platform === 'win32'
    ? [path.join(sourceDir, '.venv', 'Scripts', 'everos.exe'), path.join(sourceDir, '.venv', 'Scripts', 'everos')]
    : [path.join(sourceDir, '.venv', 'bin', 'everos')]
  return candidates.find(candidate => fs.existsSync(candidate))
}

async function failBootstrap(
  env: NodeJS.ProcessEnv,
  errorCode: EverOSBootstrapErrorCode,
  errorMessage: string,
): Promise<EverOSSetupResult> {
  const state = await updateEverOSBootstrapState(current => createEverOSBootstrapState({
    ...current,
    buildStatus: 'failed',
    lastCheckedAt: new Date().toISOString(),
    errorCode,
    errorMessage,
  }), { env })
  return { ok: false, state, errorCode, errorMessage }
}

function firstMissingErrorCode(missing: string[]): EverOSBootstrapErrorCode {
  if (missing.includes('git')) return 'EVEROS_BOOTSTRAP_GIT_MISSING'
  if (missing.includes('python')) return 'EVEROS_BOOTSTRAP_PYTHON_MISSING'
  if (missing.includes('uv')) return 'EVEROS_BOOTSTRAP_UV_MISSING'
  return 'EVEROS_BOOTSTRAP_PACKAGE_MANAGER_UNSUPPORTED'
}

async function confirm(question: string, options: EverOSSetupOptions): Promise<boolean> {
  const stdin = options.stdin ?? process.stdin
  const stdout = options.stdout ?? process.stdout
  if (!stdin.isTTY || !stdout.isTTY) return false
  const rl = readline.createInterface({ input: stdin, output: stdout })
  try {
    const answer = await new Promise<string>(resolve => rl.question(`${question}[y/N] `, resolve))
    return ['y', 'yes'].includes(answer.trim().toLowerCase())
  } finally {
    rl.close()
  }
}
