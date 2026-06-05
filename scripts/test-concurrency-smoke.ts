import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

const concurrencySafeTests = [
  'test/adapters.test.ts',
  'test/agent-api.test.ts',
  'test/agent-profiles.test.ts',
  'test/agent-job-registry.test.ts',
  'test/agent-scheduler.test.ts',
  'test/agent-tools.test.ts',
  'test/agent-tools-runtime.test.ts',
  'test/agents-command.test.ts',
  'test/agent-loop.test.ts',
  'test/agent-loop-benchmark.test.ts',
  'test/retry-policy-benchmark.test.ts',
  'test/benchmark-history.test.ts',
  'test/runner-comparison-benchmark.test.ts',
  'test/architecture-boundary.test.ts',
  'test/classifier.test.ts',
  'test/compact-summary.test.ts',
  'test/completer.test.ts',
  'test/context-assembler.test.ts',
  'test/context-forker.test.ts',
  'test/context-regression.test.ts',
  'test/diff.test.ts',
  'test/hooks.test.ts',
  'test/logger.test.ts',
  'test/mcp.test.ts',
  'test/message-normalizer.test.ts',
  'test/optimizer-safety.test.ts',
  'test/optimize-command.test.ts',
  'test/path-mention.test.ts',
  'test/permission-flow.test.ts',
  'test/prefix-cache.test.ts',
  'test/provider-recovery.test.ts',
  'test/providers.test.ts',
  'test/retry.test.ts',
  'test/run-session-flow.test.ts',
  'test/read-tool.test.ts',
  'test/runtime-llm.test.ts',
  'test/runtime.test.ts',
  'test/security.test.ts',
  'test/tool-result-budget.test.ts',
  'test/skills.test.ts',
  'test/snip-compactor.test.ts',
  'test/system-prompt-builder.test.ts',
  'test/tool-trace.test.ts',
  'test/working-set.test.ts',
  'test/token-estimator.test.ts',
  'test/tool-prompt.test.ts',
  'test/tui-renderer.test.ts',
  'test/tui-input.test.ts',
  'test/worktree.test.ts',
  'test/editor.test.ts',
]

type TestResult = {
  file: string
  success: boolean
  durationMs: number
  output: string
  error?: string
}

async function main(): Promise<void> {
  const projectRoot = new URL('..', import.meta.url).pathname
  const rootWorkdir = await mkdtemp(join(tmpdir(), 'babel-o-test-concurrency-'))
  const maxParallel = readMaxParallel()

  try {
    console.log(`Running ${concurrencySafeTests.length} test files with concurrency ${maxParallel}`)
    const results = await runPool(concurrencySafeTests, maxParallel, file => runTestFile(projectRoot, rootWorkdir, file))
    const failed = results.filter(result => !result.success)
    const totalMs = results.reduce((sum, result) => sum + result.durationMs, 0)

    for (const result of results) {
      const marker = result.success ? '✔' : '✖'
      console.log(`${marker} ${result.file} (${Math.round(result.durationMs)}ms)`)
    }

    if (failed.length > 0) {
      for (const result of failed) {
        console.error(`\n--- ${result.file} failed ---`)
        if (result.error) console.error(result.error)
        if (result.output.trim().length > 0) console.error(result.output.trim())
      }
      throw new Error(`${failed.length}/${results.length} concurrency smoke files failed`)
    }

    console.log(`Concurrency smoke passed: ${results.length}/${results.length} files, cumulative ${Math.round(totalMs)}ms`)
  } finally {
    await rm(rootWorkdir, { recursive: true, force: true })
  }
}

async function runPool<T, R>(items: T[], maxParallel: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = []
  let nextIndex = 0
  const workers = Array.from({ length: Math.min(maxParallel, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex
      nextIndex += 1
      results[index] = await run(items[index]!)
    }
  })
  await Promise.all(workers)
  return results
}

async function runTestFile(projectRoot: string, rootWorkdir: string, file: string): Promise<TestResult> {
  const startedAt = process.hrtime.bigint()
  const workdir = join(rootWorkdir, sanitizeFileName(file))
  const configPath = join(workdir, 'config.json')
  await mkdir(workdir, { recursive: true })
  await writeFile(
    configPath,
    JSON.stringify({ defaultModel: 'local/coding-runtime', providers: {} }, null, 2),
    'utf8',
  )

  const env = { ...process.env }
  delete env.BABEL_O_MODEL
  delete env.BABEL_O_PROVIDER

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      '--import',
      'tsx',
      '--test',
      '--test-concurrency=1',
      file,
    ], {
      cwd: projectRoot,
      env: {
        ...env,
        BABEL_O_CONFIG_FILE: configPath,
        BABEL_O_CONFIG_DIR: workdir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', chunk => {
      output += chunk.toString()
    })
    child.stderr.on('data', chunk => {
      output += chunk.toString()
    })
    child.on('error', error => {
      resolve({
        file,
        success: false,
        durationMs: elapsedMs(startedAt),
        output,
        error: error.message,
      })
    })
    child.on('exit', code => {
      resolve({
        file,
        success: code === 0,
        durationMs: elapsedMs(startedAt),
        output,
        error: code === 0 ? undefined : `test process exited with ${code ?? 'null'}`,
      })
    })
  })
}

function readMaxParallel(): number {
  const raw = process.env.BABEL_O_TEST_CONCURRENCY
  if (!raw) return 4
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 1) return 4
  return Math.min(parsed, 8)
}

function sanitizeFileName(file: string): string {
  return basename(file).replace(/[^A-Za-z0-9._-]/g, '-')
}

function elapsedMs(start: bigint): number {
  return Number(process.hrtime.bigint() - start) / 1_000_000
}

await main()
