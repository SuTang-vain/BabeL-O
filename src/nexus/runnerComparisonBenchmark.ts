import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createDefaultToolRegistry } from '../tools/registry.js'
import type { AnyTool } from '../tools/Tool.js'
import { executeToolSafely, type ToolExecutionResult } from '../runtime/toolExecutor.js'
import { HttpRemoteToolRunner, REMOTE_RUNNER_PROTOCOL_VERSION, type RemoteToolRunner, type RemoteToolRunnerCapability } from '../runtime/remoteRunner.js'

type RunnerBackend = 'ts_local' | 'go_remote'
type RunnerBackendStatus = 'completed' | 'skipped'

type RunnerScenarioName =
  | 'read_small_file'
  | 'grep_large_directory'
  | 'glob_large_directory'
  | 'bash_stdout'
  | 'output_truncation'
  | 'timeout_correctness'
  | 'cancel_latency'
  | 'workspace_escape'

export type RunnerComparisonScenarioResult = {
  name: string
  scenario: RunnerScenarioName
  toolName: string
  iterations: number
  totalMs: number
  avgMs: number
  minMs: number
  maxMs: number
  p50Ms: number
  p95Ms: number
  successCount: number
  errorCount: number
  truncatedCount: number
  timeoutCount: number
  cancelledCount: number
  workspaceDeniedCount: number
  stdoutBytes: number
  stderrBytes: number
  outputBytes: number
  originalBytes: number
  errorCodes: Record<string, number>
  lastKind: ToolExecutionResult['kind']
  lastSuccess?: boolean
  lastErrorCode?: string
}

export type RunnerComparisonBackendResult = {
  backend: RunnerBackend
  runnerId: string
  status: RunnerBackendStatus
  skippedReason?: string
  capabilities?: RemoteToolRunnerCapability
  scenarios: RunnerComparisonScenarioResult[]
  totals: {
    scenarioCount: number
    iterations: number
    successCount: number
    errorCount: number
    truncatedCount: number
    timeoutCount: number
    cancelledCount: number
    workspaceDeniedCount: number
    stdoutBytes: number
    stderrBytes: number
    outputBytes: number
    originalBytes: number
    durationP50Ms: number
    durationP95Ms: number
    heapUsedBeforeBytes: number
    heapUsedAfterBytes: number
    heapUsedDeltaBytes: number
    rssBytesAfter: number
    errorCodes: Record<string, number>
  }
}

export type RunnerComparisonBenchmarkResult = {
  name: string
  protocolVersion: typeof REMOTE_RUNNER_PROTOCOL_VERSION
  workspaceFileCount: number
  goRunnerEnabled: boolean
  goRunnerSkippedReason?: string
  backends: RunnerComparisonBackendResult[]
}

export type RunnerComparisonBenchmarkOptions = {
  workspaceRoot: string
  projectRoot: string
  runGoRunner?: boolean
}

type RunnerScenario = {
  scenario: RunnerScenarioName
  toolName: string
  input: Record<string, unknown>
  iterations: number
  maxOutputBytes: number
  bashMaxBufferBytes?: number
  timeoutMs?: number
  abortAfterMs?: number
  expectedSuccess?: boolean
  expectedTruncated?: boolean
  expectedErrorCodes?: string[]
}

const GO_RUNNER_SKIPPED_REASON = 'Set BABEL_O_RUN_GO_RUNNER_SMOKE=1 to include the optional Go RemoteToolRunner benchmark.'

export async function runRunnerComparisonBenchmark(
  options: RunnerComparisonBenchmarkOptions,
): Promise<RunnerComparisonBenchmarkResult> {
  const workspace = join(options.workspaceRoot, 'runner-comparison-workspace')
  const fixture = await prepareRunnerBenchmarkWorkspace(workspace)
  const scenarios = runnerScenarios()
  const previousAllowedWorkspaces = process.env.NEXUS_ALLOWED_WORKSPACES
  process.env.NEXUS_ALLOWED_WORKSPACES = workspace

  try {
    const tsLocal = await benchmarkRunnerBackend({
      backend: 'ts_local',
      runnerId: 'ts-local-tool-runner',
      workspace,
      scenarios,
    })
    const backends: RunnerComparisonBackendResult[] = [tsLocal]

    if (!options.runGoRunner) {
      backends.push(skippedGoRunnerBackend())
    } else {
      const goRunner = await startGoRunner(options.projectRoot)
      try {
        const capabilities = await fetchGoRunnerCapabilities(goRunner.baseUrl)
        const runner = new HttpRemoteToolRunner({
          id: capabilities.id,
          baseUrl: goRunner.baseUrl,
          capabilities: capabilities.capabilities,
        })
        backends.push(await benchmarkRunnerBackend({
          backend: 'go_remote',
          runnerId: capabilities.id,
          workspace,
          scenarios,
          remoteRunner: runner,
          capabilities: capabilities.capabilities,
        }))
      } finally {
        await terminateChildProcessGroup(goRunner.child)
      }
    }

    return {
      name: 'TS local runner vs optional Go RemoteToolRunner',
      protocolVersion: REMOTE_RUNNER_PROTOCOL_VERSION,
      workspaceFileCount: fixture.fileCount,
      goRunnerEnabled: options.runGoRunner === true,
      goRunnerSkippedReason: options.runGoRunner ? undefined : GO_RUNNER_SKIPPED_REASON,
      backends,
    }
  } finally {
    if (previousAllowedWorkspaces === undefined) {
      delete process.env.NEXUS_ALLOWED_WORKSPACES
    } else {
      process.env.NEXUS_ALLOWED_WORKSPACES = previousAllowedWorkspaces
    }
  }
}

async function prepareRunnerBenchmarkWorkspace(workspace: string): Promise<{ fileCount: number }> {
  const src = join(workspace, 'src')
  const nested = join(src, 'nested')
  await mkdir(nested, { recursive: true })
  await writeFile(join(workspace, 'README.md'), 'runner benchmark\nneedle-runner-benchmark root\n', 'utf8')
  let fileCount = 1

  for (let index = 0; index < 240; index += 1) {
    const directory = index % 5 === 0 ? nested : src
    const name = `file-${String(index).padStart(3, '0')}.ts`
    await writeFile(
      join(directory, name),
      [
        `export const value${index} = ${index}`,
        `// needle-runner-benchmark ${index}`,
        `export function fn${index}() { return value${index} }`,
      ].join('\n'),
      'utf8',
    )
    fileCount += 1
  }

  await writeFile(join(workspace, '..', 'runner-secret.txt'), 'outside workspace\n', 'utf8')
  return { fileCount }
}

function runnerScenarios(): RunnerScenario[] {
  return [
    {
      scenario: 'read_small_file',
      toolName: 'Read',
      input: { path: 'README.md', maxBytes: 2_000, mode: 'full' },
      iterations: 5,
      maxOutputBytes: 20_000,
      expectedSuccess: true,
    },
    {
      scenario: 'grep_large_directory',
      toolName: 'Grep',
      input: { pattern: 'needle-runner-benchmark', path: 'src', maxMatches: 200 },
      iterations: 5,
      maxOutputBytes: 200_000,
      expectedSuccess: true,
    },
    {
      scenario: 'glob_large_directory',
      toolName: 'Glob',
      input: { pattern: '**/*.ts', path: 'src', maxResults: 200 },
      iterations: 5,
      maxOutputBytes: 200_000,
      expectedSuccess: true,
    },
    {
      scenario: 'bash_stdout',
      toolName: 'Bash',
      input: { command: 'printf runner-bash-ok', timeoutMs: 5_000 },
      iterations: 5,
      maxOutputBytes: 20_000,
      bashMaxBufferBytes: 20_000,
      expectedSuccess: true,
    },
    {
      scenario: 'output_truncation',
      toolName: 'Bash',
      input: { command: "node -e \"process.stdout.write('x'.repeat(4096))\"", timeoutMs: 5_000 },
      iterations: 2,
      maxOutputBytes: 256,
      bashMaxBufferBytes: 20_000,
      expectedSuccess: true,
      expectedTruncated: true,
    },
    {
      scenario: 'timeout_correctness',
      toolName: 'Bash',
      input: { command: 'sleep 2', timeoutMs: 5_000 },
      iterations: 1,
      maxOutputBytes: 20_000,
      bashMaxBufferBytes: 20_000,
      timeoutMs: 50,
      expectedErrorCodes: ['REQUEST_TIMEOUT'],
    },
    {
      scenario: 'cancel_latency',
      toolName: 'Bash',
      input: { command: 'sleep 2', timeoutMs: 5_000 },
      iterations: 1,
      maxOutputBytes: 20_000,
      bashMaxBufferBytes: 20_000,
      abortAfterMs: 50,
      expectedErrorCodes: ['REQUEST_CANCELLED'],
    },
    {
      scenario: 'workspace_escape',
      toolName: 'Read',
      input: { path: '../runner-secret.txt', maxBytes: 2_000, mode: 'full' },
      iterations: 1,
      maxOutputBytes: 20_000,
      expectedErrorCodes: ['WORKSPACE_PATH_ESCAPE', 'WORKSPACE_PATH_DENIED'],
    },
  ]
}

async function benchmarkRunnerBackend(options: {
  backend: RunnerBackend
  runnerId: string
  workspace: string
  scenarios: RunnerScenario[]
  remoteRunner?: RemoteToolRunner
  capabilities?: RemoteToolRunnerCapability
}): Promise<RunnerComparisonBackendResult> {
  const heapUsedBeforeBytes = process.memoryUsage().heapUsed
  const scenarioResults: RunnerComparisonScenarioResult[] = []
  const tools = createDefaultToolRegistry()

  for (const scenario of options.scenarios) {
    scenarioResults.push(await benchmarkRunnerScenario({
      ...options,
      tools,
      scenario,
    }))
  }

  const heapUsedAfterBytes = process.memoryUsage().heapUsed
  return {
    backend: options.backend,
    runnerId: options.runnerId,
    status: 'completed',
    capabilities: options.capabilities,
    scenarios: scenarioResults,
    totals: summarizeBackendScenarios(scenarioResults, heapUsedBeforeBytes, heapUsedAfterBytes),
  }
}

async function benchmarkRunnerScenario(options: {
  backend: RunnerBackend
  runnerId: string
  workspace: string
  scenarios: RunnerScenario[]
  tools: Map<string, AnyTool>
  scenario: RunnerScenario
  remoteRunner?: RemoteToolRunner
}): Promise<RunnerComparisonScenarioResult> {
  const tool = options.tools.get(options.scenario.toolName)
  if (!tool) throw new Error(`Tool not found for runner benchmark: ${options.scenario.toolName}`)
  const samples: number[] = []
  const errorCodes: Record<string, number> = {}
  let successCount = 0
  let errorCount = 0
  let truncatedCount = 0
  let timeoutCount = 0
  let cancelledCount = 0
  let workspaceDeniedCount = 0
  let stdoutBytes = 0
  let stderrBytes = 0
  let outputBytes = 0
  let originalBytes = 0
  let lastResult: ToolExecutionResult | undefined

  for (let index = 0; index < options.scenario.iterations; index += 1) {
    const controller = options.scenario.abortAfterMs === undefined ? undefined : new AbortController()
    const abortTimer = controller
      ? setTimeout(() => controller.abort(), options.scenario.abortAfterMs)
      : undefined
    const start = process.hrtime.bigint()
    try {
      const result = await executeToolSafely(
        tool,
        tool.inputSchema.parse(options.scenario.input),
        {
          sessionId: `session-runner-${options.backend}-${options.scenario.scenario}-${index}`,
          prompt: options.scenario.scenario,
          cwd: options.workspace,
          requestId: `request-runner-${options.backend}-${options.scenario.scenario}-${index}`,
          executionEnvironment: options.remoteRunner ? 'remote' : 'local',
          remoteRunner: options.remoteRunner,
          allowedPaths: [options.workspace],
          maxToolOutputBytes: options.scenario.maxOutputBytes,
          bashMaxBufferBytes: options.scenario.bashMaxBufferBytes ?? 1_000_000,
          signal: controller?.signal,
        },
        {
          timeout: options.scenario.timeoutMs,
          toolUseId: `tool-runner-${options.backend}-${options.scenario.scenario}-${index}`,
        },
      )
      samples.push(elapsedMs(start))
      validateScenarioResult(options.backend, options.scenario, result)
      lastResult = result

      const resultCode = resultErrorCode(result)
      if (resultCode) {
        errorCount += 1
        errorCodes[resultCode] = (errorCodes[resultCode] ?? 0) + 1
      } else {
        successCount += result.kind === 'result' && result.success ? 1 : 0
      }
      if (result.kind === 'result' && result.truncated) truncatedCount += 1
      if (resultCode === 'REQUEST_TIMEOUT') timeoutCount += 1
      if (resultCode === 'REQUEST_CANCELLED') cancelledCount += 1
      if (resultCode === 'WORKSPACE_PATH_ESCAPE' || resultCode === 'WORKSPACE_PATH_DENIED') workspaceDeniedCount += 1

      const sizes = resultOutputSizes(result)
      stdoutBytes += sizes.stdoutBytes
      stderrBytes += sizes.stderrBytes
      outputBytes += sizes.outputBytes
      originalBytes += sizes.originalBytes
    } finally {
      if (abortTimer) clearTimeout(abortTimer)
    }
  }

  return {
    name: `${options.backend} ${options.scenario.scenario}`,
    scenario: options.scenario.scenario,
    toolName: options.scenario.toolName,
    iterations: options.scenario.iterations,
    totalMs: round(samples.reduce((sum, value) => sum + value, 0)),
    avgMs: round(samples.reduce((sum, value) => sum + value, 0) / samples.length),
    minMs: round(Math.min(...samples)),
    maxMs: round(Math.max(...samples)),
    p50Ms: percentile(samples, 50),
    p95Ms: percentile(samples, 95),
    successCount,
    errorCount,
    truncatedCount,
    timeoutCount,
    cancelledCount,
    workspaceDeniedCount,
    stdoutBytes,
    stderrBytes,
    outputBytes,
    originalBytes,
    errorCodes,
    lastKind: lastResult?.kind ?? 'error',
    lastSuccess: lastResult?.kind === 'result' ? lastResult.success : undefined,
    lastErrorCode: lastResult ? resultErrorCode(lastResult) : undefined,
  }
}

function validateScenarioResult(backend: RunnerBackend, scenario: RunnerScenario, result: ToolExecutionResult): void {
  const errorCode = resultErrorCode(result)
  if (scenario.expectedErrorCodes) {
    if (!errorCode || !scenario.expectedErrorCodes.includes(errorCode)) {
      throw new Error(`${backend} ${scenario.scenario} expected error ${scenario.expectedErrorCodes.join('|')} but received ${errorCode ?? 'none'}.`)
    }
    return
  }
  if (scenario.expectedSuccess !== undefined) {
    const success = result.kind === 'result' && result.success === scenario.expectedSuccess
    if (!success) {
      throw new Error(`${backend} ${scenario.scenario} expected success=${scenario.expectedSuccess} but received ${JSON.stringify(result)}.`)
    }
  }
  if (scenario.expectedTruncated && !(result.kind === 'result' && result.truncated)) {
    throw new Error(`${backend} ${scenario.scenario} expected truncated output.`)
  }
}

function summarizeBackendScenarios(
  scenarios: RunnerComparisonScenarioResult[],
  heapUsedBeforeBytes: number,
  heapUsedAfterBytes: number,
): RunnerComparisonBackendResult['totals'] {
  const durations = scenarios.flatMap(scenario => [scenario.p50Ms, scenario.p95Ms])
  const errorCodes: Record<string, number> = {}
  for (const scenario of scenarios) {
    for (const [code, count] of Object.entries(scenario.errorCodes)) {
      errorCodes[code] = (errorCodes[code] ?? 0) + count
    }
  }
  return {
    scenarioCount: scenarios.length,
    iterations: sum(scenarios, scenario => scenario.iterations),
    successCount: sum(scenarios, scenario => scenario.successCount),
    errorCount: sum(scenarios, scenario => scenario.errorCount),
    truncatedCount: sum(scenarios, scenario => scenario.truncatedCount),
    timeoutCount: sum(scenarios, scenario => scenario.timeoutCount),
    cancelledCount: sum(scenarios, scenario => scenario.cancelledCount),
    workspaceDeniedCount: sum(scenarios, scenario => scenario.workspaceDeniedCount),
    stdoutBytes: sum(scenarios, scenario => scenario.stdoutBytes),
    stderrBytes: sum(scenarios, scenario => scenario.stderrBytes),
    outputBytes: sum(scenarios, scenario => scenario.outputBytes),
    originalBytes: sum(scenarios, scenario => scenario.originalBytes),
    durationP50Ms: percentile(durations, 50),
    durationP95Ms: percentile(durations, 95),
    heapUsedBeforeBytes,
    heapUsedAfterBytes,
    heapUsedDeltaBytes: heapUsedAfterBytes - heapUsedBeforeBytes,
    rssBytesAfter: process.memoryUsage().rss,
    errorCodes,
  }
}

function skippedGoRunnerBackend(): RunnerComparisonBackendResult {
  return {
    backend: 'go_remote',
    runnerId: 'go-remote-runner',
    status: 'skipped',
    skippedReason: GO_RUNNER_SKIPPED_REASON,
    scenarios: [],
    totals: {
      scenarioCount: 0,
      iterations: 0,
      successCount: 0,
      errorCount: 0,
      truncatedCount: 0,
      timeoutCount: 0,
      cancelledCount: 0,
      workspaceDeniedCount: 0,
      stdoutBytes: 0,
      stderrBytes: 0,
      outputBytes: 0,
      originalBytes: 0,
      durationP50Ms: 0,
      durationP95Ms: 0,
      heapUsedBeforeBytes: 0,
      heapUsedAfterBytes: 0,
      heapUsedDeltaBytes: 0,
      rssBytesAfter: 0,
      errorCodes: {},
    },
  }
}

async function startGoRunner(projectRoot: string): Promise<{ child: ChildProcess; baseUrl: string }> {
  const port = String(44000 + Math.floor(Math.random() * 1000))
  const baseUrl = `http://127.0.0.1:${port}`
  const child = spawn('go', ['run', './cmd/go-runner'], {
    cwd: resolve(projectRoot, 'runners/go-runner'),
    env: goRunnerEnv(port),
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  try {
    await waitForCapabilities(baseUrl, child)
    return { child, baseUrl }
  } catch (error) {
    await terminateChildProcessGroup(child)
    throw error
  }
}

function goRunnerEnv(port: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'GOCACHE', 'GOMODCACHE', 'GOPATH', 'GOROOT', 'GOENV', 'GOFLAGS', 'CGO_ENABLED']) {
    if (process.env[key]) env[key] = process.env[key]
  }
  env.GO_RUNNER_HOST = '127.0.0.1'
  env.GO_RUNNER_PORT = port
  env.GO_RUNNER_ID = 'go-remote-runner-benchmark'
  env.GO_RUNNER_ENABLE_BASH = '1'
  return env
}

async function waitForCapabilities(baseUrl: string, child: ChildProcess): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < 10_000) {
    if (child.exitCode !== null) {
      throw new Error(`Go runner exited before readiness with code ${child.exitCode}.`)
    }
    try {
      await fetchGoRunnerCapabilities(baseUrl)
      return
    } catch {
      await delay(100)
    }
  }
  throw new Error('Timed out waiting for Go runner capabilities endpoint.')
}

async function fetchGoRunnerCapabilities(baseUrl: string): Promise<{
  protocolVersion: typeof REMOTE_RUNNER_PROTOCOL_VERSION
  id: string
  capabilities: RemoteToolRunnerCapability
}> {
  const response = await fetch(`${baseUrl}/v1/remote-runner/capabilities`)
  if (!response.ok) throw new Error(`Go runner capabilities returned HTTP ${response.status}.`)
  const body = await response.json()
  if (!isGoRunnerCapabilities(body)) {
    throw new Error('Go runner capabilities response was malformed.')
  }
  if (body.protocolVersion !== REMOTE_RUNNER_PROTOCOL_VERSION) {
    throw new Error(`Go runner protocol mismatch: ${body.protocolVersion}.`)
  }
  return body
}

function isGoRunnerCapabilities(value: unknown): value is {
  protocolVersion: typeof REMOTE_RUNNER_PROTOCOL_VERSION
  id: string
  capabilities: RemoteToolRunnerCapability
} {
  return Boolean(
    value &&
    typeof value === 'object' &&
    typeof (value as Record<string, unknown>).protocolVersion === 'string' &&
    typeof (value as Record<string, unknown>).id === 'string' &&
    typeof (value as Record<string, unknown>).capabilities === 'object' &&
    (value as Record<string, unknown>).capabilities !== null,
  )
}

async function terminateChildProcessGroup(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null) return
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    return
  }
  const exited = once(child, 'exit').then(() => true)
  const timedOut = delay(2_000).then(() => false)
  if (await Promise.race([exited, timedOut])) return
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    return
  }
}

function resultErrorCode(result: ToolExecutionResult): string | undefined {
  if (result.kind === 'error') return result.code
  if (result.success) return undefined
  if (isRecord(result.output) && typeof result.output.code === 'string') return result.output.code
  return 'TOOL_RESULT_FAILED'
}

function resultOutputSizes(result: ToolExecutionResult): {
  stdoutBytes: number
  stderrBytes: number
  outputBytes: number
  originalBytes: number
} {
  if (result.kind === 'error') {
    const detailsBytes = byteLength(result.details)
    return {
      stdoutBytes: 0,
      stderrBytes: 0,
      outputBytes: detailsBytes,
      originalBytes: detailsBytes,
    }
  }
  const stdout = isRecord(result.output) && typeof result.output.stdout === 'string' ? result.output.stdout : ''
  const stderr = isRecord(result.output) && typeof result.output.stderr === 'string' ? result.output.stderr : ''
  const outputBytes = byteLength(result.output)
  return {
    stdoutBytes: Buffer.byteLength(stdout, 'utf8'),
    stderrBytes: Buffer.byteLength(stderr, 'utf8'),
    outputBytes,
    originalBytes: result.originalBytes ?? outputBytes,
  }
}

function byteLength(value: unknown): number {
  if (value === undefined) return 0
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf8')
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

function sum<T>(items: T[], read: (item: T) => number): number {
  return items.reduce((total, item) => total + read(item), 0)
}

function elapsedMs(start: bigint): number {
  return Number(process.hrtime.bigint() - start) / 1_000_000
}

function percentile(samples: number[], percent: number): number {
  if (samples.length === 0) return 0
  const sorted = [...samples].sort((a, b) => a - b)
  const index = Math.ceil((percent / 100) * sorted.length) - 1
  return round(sorted[Math.max(0, Math.min(sorted.length - 1, index))] ?? 0)
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
