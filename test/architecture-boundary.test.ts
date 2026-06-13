import { test } from 'node:test'
import assert from 'node:assert/strict'
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

test('chat command does not import Nexus storage or runtime internals directly', () => {
  const source = readFileSync(new URL('../src/cli/commands/chat.ts', import.meta.url), 'utf8')
  const forbidden = [
    '../../storage/SqliteStorage.js',
    '../../nexus/sessionLifecycle.js',
    '../../runtime/compact.js',
    '../../runtime/contextAnalysis.js',
    '../../runtime/LLMCodingRuntime.js',
  ]

  for (const specifier of forbidden) {
    assert.equal(source.includes(specifier), false, `${specifier} should stay behind Nexus API boundaries`)
  }
})
