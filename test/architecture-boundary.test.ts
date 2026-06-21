import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createEmbeddedNexusClient } from '../src/cli/embedded.js'
import { program } from '../src/cli/program.js'
import { ConfigManager } from '../src/shared/config.js'
import { BABEL_O_VERSION } from '../src/shared/version.js'

const boundaryTestConfigPath = join(tmpdir(), `babel-o-boundary-test-config-${process.pid}.json`)
process.env.BABEL_O_CONFIG_FILE = boundaryTestConfigPath
ConfigManager.getInstance().save({})

test('embedded Nexus client routes session operations through app injection', async () => {
  const cwd = join(tmpdir(), `babel-o-boundary-${Date.now()}`)
  await mkdir(cwd, { recursive: true })
  const storagePath = join(cwd, 'db.sqlite')
  const client = createEmbeddedNexusClient({
    cwd,
    storagePath,
    allowedTools: ['*'],
  })

  try {
    const status = await client.status() as { type: string }
    assert.equal(status.type, 'runtime_status')

    const list = await client.listSessions({ limit: 3 }) as { type: string; sessions: unknown[] }
    assert.equal(list.type, 'sessions_list')
    assert.ok(Array.isArray(list.sessions))
  } finally {
    await client.close()
  }
})

test('embedded Nexus client reuses EverCore configuration across app injections', async () => {
  const cwd = join(tmpdir(), `babel-o-evercore-embedded-cache-${Date.now()}`)
  await mkdir(cwd, { recursive: true })
  const storagePath = join(cwd, 'db.sqlite')
  const previousEnabled = process.env.BABEL_O_EVERCORE_ENABLED
  const previousBaseUrl = process.env.BABEL_O_EVERCORE_BASE_URL
  const originalFetch = globalThis.fetch
  let healthCalls = 0
  process.env.BABEL_O_EVERCORE_ENABLED = '1'
  process.env.BABEL_O_EVERCORE_BASE_URL = 'http://127.0.0.1:45678'
  globalThis.fetch = async url => {
    assert.equal(String(url), 'http://127.0.0.1:45678/health')
    healthCalls += 1
    return new Response(JSON.stringify({ status: 'ok' }), { status: 200 })
  }

  const client = createEmbeddedNexusClient({
    cwd,
    storagePath,
    allowedTools: ['*'],
  })
  try {
    const memoryStatus = await client.memoryStatus() as { type: string; capability: { available: boolean } }
    assert.equal(memoryStatus.type, 'memory_status')
    assert.equal(memoryStatus.capability.available, true)
    await client.status()
    await client.listSessions({ limit: 1 })
    assert.equal(healthCalls, 1)
  } finally {
    await client.close()
    globalThis.fetch = originalFetch
    if (previousEnabled === undefined) delete process.env.BABEL_O_EVERCORE_ENABLED
    else process.env.BABEL_O_EVERCORE_ENABLED = previousEnabled
    if (previousBaseUrl === undefined) delete process.env.BABEL_O_EVERCORE_BASE_URL
    else process.env.BABEL_O_EVERCORE_BASE_URL = previousBaseUrl
  }
})

test('CLI and Nexus API expose the shared package version', async () => {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
  assert.equal(BABEL_O_VERSION, packageJson.version)
  assert.equal(program.version(), BABEL_O_VERSION)

  const cwd = join(tmpdir(), `babel-o-version-boundary-${Date.now()}`)
  await mkdir(cwd, { recursive: true })
  const client = createEmbeddedNexusClient({
    cwd,
    storagePath: join(cwd, 'db.sqlite'),
    allowedTools: ['*'],
  })

  try {
    const status = await client.status() as {
      health: { version: string }
    }
    assert.equal(status.health.version, BABEL_O_VERSION)
  } finally {
    await client.close()
  }
})

test('CLI no longer registers the removed TypeScript chat TUI command', () => {
  assert.equal(program.commands.some(command => command.name() === 'chat'), false)
})

test('layer direction audit passes successfully with zero violations', () => {
  const output = execSync('node scripts/audit-layer-direction.js', { encoding: 'utf8' })
  assert.match(output, /SUCCESS: No layer direction violations found/)
})

test('coupling audit reports no reverse runtime-to-nexus or nexus-to-cli imports', () => {
  const output = execSync('node scripts/audit-coupling.js', { encoding: 'utf8' })
  const report = JSON.parse(output)
  assert.deepEqual(report.reverseImports.runtimeToNexus, [])
  assert.deepEqual(report.reverseImports.nexusToCli, [])
})

test('coupling audit --fail-on exits 0 on a clean tree', () => {
  execSync('node scripts/audit-coupling.js --fail-on', { encoding: 'utf8', stdio: 'pipe' })
  assert.ok(true, '--fail-on must not throw on a tree with no reverse imports')
})

test('layer direction audit exits 0 on a clean tree (shared -> outside already gated by rule 4)', () => {
  // `audit-layer-direction.js` rule 4 already enforces `shared -> outside`
  // against `scripts/layer-direction-allowlist.json`. The one legitimate edge
  // (`shared/config.ts -> providers/registry.ts`) is the only entry. New
  // `shared -> outside` edges fail this test, which in turn fails `deps:audit`
  // (chained via `&&` in package.json) and the `deps:audit` CI step.
  execSync('node scripts/audit-layer-direction.js', { encoding: 'utf8', stdio: 'pipe' })
  assert.ok(true, 'layer-direction audit must not throw on a tree with no unallowlisted reverse edges')
})

test('canonical-shape invariant: runtime -> providers only via type imports or registry value calls', async () => {
  // 30 edges / 27 files in this direction today; the canonical shape is:
  //   * `import type { ... } from '../providers/adapters/...'` (type-level, erased at runtime)
  //   * `import { getAdapter, getModel } from '../providers/registry.js'` (registry resolution)
  // No runtime file should import a concrete adapter value (e.g.
  // `import { AnthropicAdapter } from '../providers/adapters/AnthropicAdapter.js'`)
  // because that would couple runtime to a specific provider implementation.
  const { readFile } = await import('node:fs/promises')
  const { join: pathJoin } = await import('node:path')
  const repoRoot = pathJoin(import.meta.dirname, '..')
  const runtimeDir = pathJoin(repoRoot, 'src', 'runtime')
  const allFiles = await listTsFiles(runtimeDir)
  // Single-line import statement: `import ... from 'specifier'`. Excludes `import type ...` and
  // inline `import { type X, Y }` forms (any `type` token inside the import braces).
  const valueImportRe = /^\s*import\s+(?!\s*type\b)(?:\{(?![^}]*\btype\s+[A-Za-z_])[^}]*\}|[A-Za-z_]\w*)\s+from\s+['"]([^'"]*providers\/[^'"]*)['"]/;
  const violations = []
  for (const file of allFiles) {
    const text = await readFile(file, 'utf8')
    for (const line of text.split('\n')) {
      const m = line.match(valueImportRe)
      if (!m) continue
      const specifier = m[1]
      if (specifier.includes('providers/registry')) continue
      const rel = file.slice(repoRoot.length + 1)
      violations.push(`${rel}: non-type import from "${specifier}" (runtime -> providers/adapters must be \`import type\`)`)
    }
  }
  assert.deepEqual(violations, [], [
    'runtime -> providers must stay type-only or registry-only. Concrete adapter imports are forbidden.',
    'violations:',
    ...violations,
  ].join('\n'))
})

test('canonical-shape invariant: nexus -> storage only via NexusStorage type or composition-root concretions', async () => {
  // 20 edges / 19 files today. Canonical shape:
  //   * `import type { NexusStorage } from '../storage/Storage.js'` — abstraction (17/19 files)
  //   * `import { MemoryStorage } from '../storage/MemoryStorage.js'` / `SqliteStorage` — ONLY in
  //     `createRuntime.ts` (composition root) or `agentLoopBenchmark.ts` (test infrastructure)
  // No other nexus file should import a concrete storage class; otherwise the layer direction
  // becomes a hidden composition root.
  const { readFile } = await import('node:fs/promises')
  const { join: pathJoin } = await import('node:path')
  const repoRoot = pathJoin(import.meta.dirname, '..')
  const nexusDir = pathJoin(repoRoot, 'src', 'nexus')
  const allFiles = await listTsFiles(nexusDir)

  const allowedConcreteImporters = new Set([
    'src/nexus/createRuntime.ts',
    'src/nexus/agentLoopBenchmark.ts',
  ])

  // Single-line value import of a concrete storage backend.
  const concreteRe = /^\s*import\s+(?!\s*type\b)(?:\{(?![^}]*\btype\s+[A-Za-z_])[^}]*\}|[A-Za-z_]\w*)\s+from\s+['"]([^'"]*storage\/(MemoryStorage|SqliteStorage)[^'"]*)['"]/;
  const violations = []
  for (const file of allFiles) {
    const text = await readFile(file, 'utf8')
    for (const line of text.split('\n')) {
      const m = line.match(concreteRe)
      if (!m) continue
      const rel = file.slice(repoRoot.length + 1)
      if (allowedConcreteImporters.has(rel)) continue
      violations.push(`${rel}: concrete storage import "${m[1]}" — only createRuntime.ts and agentLoopBenchmark.ts may import concrete storage backends`)
    }
  }
  assert.deepEqual(violations, [], [
    'nexus -> storage must stay NexusStorage-type-only outside the composition root.',
    'Concretions belong to createRuntime.ts and agentLoopBenchmark.ts.',
    'violations:',
    ...violations,
  ].join('\n'))
})

async function listTsFiles(dir: string): Promise<string[]> {
  const { readdir } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const out: string[] = []
  const walk = async (current: string) => {
    const entries = await readdir(current, { withFileTypes: true })
    for (const e of entries) {
      const full = join(current, e.name)
      if (e.isDirectory()) await walk(full)
      else if (e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) out.push(full)
    }
  }
  await walk(dir)
  return out
}

