import { spawn } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNexusApp } from '../src/nexus/app.js'
import { createDefaultNexusRuntime } from '../src/nexus/createRuntime.js'
import { SqliteStorage } from '../src/storage/SqliteStorage.js'

type BenchmarkResult = {
  name: string
  iterations: number
  totalMs: number
  avgMs: number
  minMs: number
  maxMs: number
}

type CommandBenchmarkResult = BenchmarkResult & {
  exitCode: number | null
}

function elapsedMs(start: bigint): number {
  return Number(process.hrtime.bigint() - start) / 1_000_000
}

async function measure(
  name: string,
  iterations: number,
  fn: () => Promise<void>,
): Promise<BenchmarkResult> {
  const samples: number[] = []
  for (let index = 0; index < iterations; index += 1) {
    const start = process.hrtime.bigint()
    await fn()
    samples.push(elapsedMs(start))
  }
  const totalMs = samples.reduce((sum, value) => sum + value, 0)
  return {
    name,
    iterations,
    totalMs: round(totalMs),
    avgMs: round(totalMs / iterations),
    minMs: round(Math.min(...samples)),
    maxMs: round(Math.max(...samples)),
  }
}

async function measureCommand(
  name: string,
  iterations: number,
  command: string,
  args: string[],
  options: { cwd: string; env?: Record<string, string> },
): Promise<CommandBenchmarkResult> {
  const samples: number[] = []
  let exitCode: number | null = 0
  for (let index = 0; index < iterations; index += 1) {
    const start = process.hrtime.bigint()
    exitCode = await runCommand(command, args, options)
    samples.push(elapsedMs(start))
    if (exitCode !== 0) {
      throw new Error(`${name} exited with ${exitCode}`)
    }
  }
  const totalMs = samples.reduce((sum, value) => sum + value, 0)
  return {
    name,
    iterations,
    exitCode,
    totalMs: round(totalMs),
    avgMs: round(totalMs / iterations),
    minMs: round(Math.min(...samples)),
    maxMs: round(Math.max(...samples)),
  }
}

function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; env?: Record<string, string> },
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: 'ignore',
    })
    child.on('error', reject)
    child.on('exit', code => resolve(code))
  })
}

async function main(): Promise<void> {
  const cwd = join(tmpdir(), `babel-o-benchmark-${Date.now()}`)
  const projectRoot = new URL('..', import.meta.url).pathname
  await mkdir(cwd, { recursive: true })
  await writeFile(join(cwd, 'sample.txt'), 'hello benchmark\n', 'utf8')

  const { runtime, storage } = createDefaultNexusRuntime()
  const app = await createNexusApp({
    runtime,
    storage,
    defaultCwd: cwd,
    executeTimeoutMs: 5_000,
    maxConcurrentExecutions: 16,
  })

  try {
    const results = [
      await measure('GET /health', 100, async () => {
        const response = await app.inject({ method: 'GET', url: '/health' })
        if (response.statusCode !== 200) throw new Error(response.body)
      }),
      await measure('GET /v1/runtime/status', 100, async () => {
        const response = await app.inject({
          method: 'GET',
          url: '/v1/runtime/status',
        })
        if (response.statusCode !== 200) throw new Error(response.body)
      }),
      await measure('POST /v1/execute hello', 50, async () => {
        const response = await app.inject({
          method: 'POST',
          url: '/v1/execute',
          payload: { prompt: 'hello', cwd },
        })
        if (response.statusCode !== 200) throw new Error(response.body)
      }),
      await measure('POST /v1/execute Read', 50, async () => {
        const response = await app.inject({
          method: 'POST',
          url: '/v1/execute',
          payload: { prompt: 'read sample.txt', cwd },
        })
        if (response.statusCode !== 200) throw new Error(response.body)
      }),
      await measure('POST /v1/execute Grep', 25, async () => {
        const response = await app.inject({
          method: 'POST',
          url: '/v1/execute',
          payload: { prompt: 'grep benchmark', cwd },
        })
        if (response.statusCode !== 200) throw new Error(response.body)
      }),
      await measure('POST /v1/execute Bash', 25, async () => {
        const response = await app.inject({
          method: 'POST',
          url: '/v1/execute',
          payload: { prompt: 'bash pwd', cwd },
        })
        if (response.statusCode !== 200) throw new Error(response.body)
      }),
      await measure('SQLite storage restart', 10, async () => {
        const dbPath = join(cwd, `bench-${Date.now()}-${Math.random()}.sqlite`)
        const storage = new SqliteStorage(dbPath)
        await storage.saveSession({
          sessionId: `session-${Date.now()}-${Math.random()}`,
          cwd,
          prompt: 'benchmark',
          phase: 'completed',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          events: [],
        })
        await storage.close()
        const restored = new SqliteStorage(dbPath)
        await restored.listSessions({ limit: 5 })
        await restored.close()
      }),
      await measureCommand(
        'CLI --help startup',
        5,
        'npm',
        ['run', 'cli', '--', '--help'],
        { cwd: projectRoot },
      ),
      await measureCommand(
        'CLI embedded run hello',
        5,
        'npm',
        ['run', 'cli', '--', 'run', 'hello'],
        { cwd: projectRoot },
      ),
    ]

    console.log(
      JSON.stringify(
        {
          type: 'performance_benchmark',
          timestamp: new Date().toISOString(),
          schemaVersion: 1,
          results,
          metrics: (await app.inject({
            method: 'GET',
            url: '/v1/runtime/metrics',
          })).json(),
        },
        null,
        2,
      ),
    )
  } finally {
    await app.close()
    await storage.close?.()
    await rm(cwd, { recursive: true, force: true })
  }
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

await main()
