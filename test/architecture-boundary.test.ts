import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createEmbeddedNexusClient } from '../src/cli/embedded.js'
import { ConfigManager } from '../src/shared/config.js'

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

  const status = await client.status() as { type: string }
  assert.equal(status.type, 'runtime_status')

  const list = await client.listSessions({ limit: 3 }) as { type: string; sessions: unknown[] }
  assert.equal(list.type, 'sessions_list')
  assert.ok(Array.isArray(list.sessions))
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
