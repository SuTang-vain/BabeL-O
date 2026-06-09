import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import {
  buildGoTuiArgs,
  createManagedNexusLaunchSpec,
  createGoTuiLaunchSpec,
  defaultGoTuiBinary,
  ensureNexusForGoTui,
  isLocalNexusUrl,
  isNexusHealthy,
  waitForNexusHealth,
} from '../src/cli/commands/go.js'

test('buildGoTuiArgs forwards Nexus and session options', () => {
  assert.deepEqual(
    buildGoTuiArgs({
      url: 'http://127.0.0.1:3000',
      cwd: '/workspace',
      session: 'session_123',
      alt: false,
      pollIntervalMs: '0',
    }),
    [
      '--url',
      'http://127.0.0.1:3000',
      '--cwd',
      '/workspace',
      '--session',
      'session_123',
      '--alt=false',
      '--poll-interval-ms',
      '0',
    ],
  )
})

test('createGoTuiLaunchSpec prefers a prebuilt binary', () => {
  const packageRoot = '/repo'
  const sourceDir = join(packageRoot, 'clients', 'go-tui')
  const binary = defaultGoTuiBinary(sourceDir, 'darwin')
  const launch = createGoTuiLaunchSpec(
    {
      url: 'http://nexus.local',
      cwd: '/workspace',
      alt: true,
    },
    {
      packageRoot,
      platform: 'darwin',
      exists: path => path === binary || path === sourceDir,
    },
  )

  assert.deepEqual(launch, {
    command: binary,
    args: ['--url', 'http://nexus.local', '--cwd', '/workspace'],
    cwd: sourceDir,
    mode: 'binary',
  })
})

test('createGoTuiLaunchSpec falls back to go run when no binary is built', () => {
  const packageRoot = '/repo'
  const sourceDir = join(packageRoot, 'clients', 'go-tui')
  const launch = createGoTuiLaunchSpec(
    {
      url: 'http://nexus.local',
      cwd: '/workspace',
      alt: true,
    },
    {
      packageRoot,
      platform: 'darwin',
      exists: path => path === sourceDir,
    },
  )

  assert.deepEqual(launch, {
    command: 'go',
    args: ['run', '.', '--url', 'http://nexus.local', '--cwd', '/workspace'],
    cwd: sourceDir,
    mode: 'go-run',
  })
})

test('createGoTuiLaunchSpec reports an explicit missing binary', () => {
  assert.throws(
    () =>
      createGoTuiLaunchSpec(
        {
          url: 'http://nexus.local',
          cwd: '/workspace',
          alt: true,
          binary: '/missing/go-tui',
        },
        { exists: () => false },
      ),
    /Go TUI binary not found/,
  )
})

test('isLocalNexusUrl only accepts localhost HTTP/WS URLs', () => {
  assert.equal(isLocalNexusUrl('http://127.0.0.1:3000'), true)
  assert.equal(isLocalNexusUrl('http://localhost:3000'), true)
  assert.equal(isLocalNexusUrl('ws://127.0.0.1:3000'), true)
  assert.equal(isLocalNexusUrl('https://127.0.0.1:3000'), false)
  assert.equal(isLocalNexusUrl('http://example.com:3000'), false)
})

test('isNexusHealthy probes /health and maps ws URLs to HTTP', async () => {
  const seen: string[] = []
  const ok = await isNexusHealthy('ws://127.0.0.1:3000', async input => {
    seen.push(String(input))
    return { ok: true } as Response
  })
  assert.equal(ok, true)
  assert.deepEqual(seen, ['http://127.0.0.1:3000/health'])
})

test('createManagedNexusLaunchSpec maps URL, cwd, and tool policy to __server env', () => {
  const spec = createManagedNexusLaunchSpec(
    {
      url: 'http://127.0.0.1:3456',
      cwd: '/workspace',
      allowedTools: 'Read,Bash',
    },
    {
      argv: ['node', '/repo/src/cli/program.ts', 'go'],
      execArgv: ['--import', 'tsx'],
      env: { EXISTING: '1' },
    },
  )

  assert.equal(spec.command, process.execPath)
  assert.deepEqual(spec.args, ['--import', 'tsx', '/repo/src/cli/program.ts', '__server'])
  assert.equal(spec.env.NEXUS_HOST, '127.0.0.1')
  assert.equal(spec.env.NEXUS_PORT, '3456')
  assert.equal(spec.env.BABEL_O_WORKSPACE, '/workspace')
  assert.equal(spec.env.NEXUS_ALLOWED_TOOLS, 'Read,Bash')
  assert.equal(spec.env.EXISTING, '1')
})

test('createManagedNexusLaunchSpec defaults auto-started Nexus tools to wildcard', () => {
  const spec = createManagedNexusLaunchSpec(
    {
      url: 'http://localhost:3000',
      cwd: '/workspace',
    },
    {
      argv: ['bbl', 'go'],
      env: {},
    },
  )

  assert.deepEqual(spec.args, ['__server'])
  assert.equal(spec.env.NEXUS_HOST, 'localhost')
  assert.equal(spec.env.NEXUS_PORT, '3000')
  assert.equal(spec.env.NEXUS_ALLOWED_TOOLS, '*')
})

test('ensureNexusForGoTui reuses healthy Nexus without spawning', async () => {
  let spawnCalled = false
  const result = await ensureNexusForGoTui(
    {
      url: 'http://127.0.0.1:3000',
      cwd: '/workspace',
      alt: true,
    },
    {
      fetch: async () => ({ ok: true }) as Response,
      spawn: (() => {
        spawnCalled = true
        throw new Error('unexpected spawn')
      }) as any,
    },
  )

  assert.equal(result.status, 'existing')
  assert.equal(spawnCalled, false)
})

test('ensureNexusForGoTui starts local Nexus and waits for health', async () => {
  const fetchStatuses = [false, false, true]
  const spawnCalls: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv }> = []
  const child = {
    unrefCalled: false,
    killed: false,
    unref() {
      this.unrefCalled = true
    },
    kill() {
      this.killed = true
      return true
    },
  }

  const result = await ensureNexusForGoTui(
    {
      url: 'http://127.0.0.1:3333',
      cwd: '/workspace',
      alt: true,
      nexusStartupTimeoutMs: '1000',
    },
    {
      argv: ['node', '/repo/src/cli/program.ts', 'go'],
      execArgv: ['--import', 'tsx'],
      env: {},
      fetch: async () => ({ ok: fetchStatuses.shift() ?? true }) as Response,
      spawn: ((command: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
        spawnCalls.push({ command, args, env: options.env })
        return child
      }) as any,
      sleep: async () => undefined,
      now: (() => {
        let t = 0
        return () => (t += 100)
      })(),
    },
  )

  assert.equal(result.status, 'started')
  assert.equal(result.child, child as any)
  assert.equal(child.unrefCalled, true)
  assert.equal(child.killed, false)
  assert.equal(spawnCalls.length, 1)
  assert.deepEqual(spawnCalls[0].args, ['--import', 'tsx', '/repo/src/cli/program.ts', '__server'])
  assert.equal(spawnCalls[0].env?.NEXUS_PORT, '3333')
  assert.equal(spawnCalls[0].env?.NEXUS_ALLOWED_TOOLS, '*')
})

test('ensureNexusForGoTui skips startup when --no-start-nexus is used', async () => {
  const result = await ensureNexusForGoTui(
    {
      url: 'http://127.0.0.1:3000',
      cwd: '/workspace',
      alt: true,
      startNexus: false,
    },
    {
      fetch: async () => ({ ok: false }) as Response,
      spawn: (() => {
        throw new Error('unexpected spawn')
      }) as any,
    },
  )

  assert.equal(result.status, 'skipped')
})

test('ensureNexusForGoTui refuses to auto-start remote Nexus URLs', async () => {
  await assert.rejects(
    () =>
      ensureNexusForGoTui(
        {
          url: 'http://example.com:3000',
          cwd: '/workspace',
          alt: true,
        },
        {
          fetch: async () => ({ ok: false }) as Response,
        },
      ),
    /automatic startup is only supported for localhost/,
  )
})

test('ensureNexusForGoTui kills auto-started Nexus when health never becomes ready', async () => {
  const child = {
    killed: false,
    unref() {},
    kill() {
      this.killed = true
      return true
    },
  }
  let nowValue = 0

  await assert.rejects(
    () =>
      ensureNexusForGoTui(
        {
          url: 'http://127.0.0.1:3999',
          cwd: '/workspace',
          alt: true,
          nexusStartupTimeoutMs: '1',
        },
        {
          fetch: async () => ({ ok: false }) as Response,
          spawn: (() => child) as any,
          sleep: async () => {
            nowValue += 200
          },
          now: () => nowValue,
        },
      ),
    /Timed out waiting for Nexus health/,
  )
  assert.equal(child.killed, true)
})

test('waitForNexusHealth resolves after a later healthy probe', async () => {
  const states = [false, true]
  await waitForNexusHealth('http://127.0.0.1:3000', {
    fetch: async () => ({ ok: states.shift() ?? true }) as Response,
    sleep: async () => undefined,
    timeoutMs: 500,
    now: (() => {
      let t = 0
      return () => (t += 100)
    })(),
  })
})

test('go_tui_pty_driver.py exposes the Phase 1 permission-approve sequence', { skip: !existsSync(join(import.meta.dirname, 'go_tui_pty_driver.py')) }, () => {
  const driver = join(import.meta.dirname, 'go_tui_pty_driver.py')
  const python = process.env.PYTHON ?? 'python3'
  const probe = spawnSync(python, [driver, '--help'], {
    cwd: join(import.meta.dirname, '..'),
    encoding: 'utf8',
    timeout: 5_000,
  })
  const output = `${probe.stdout ?? ''}${probe.stderr ?? ''}`
  assert.equal(probe.status, 0, output)
  assert.match(output, /permission-approve/)
  assert.match(output, /--timeout/)
})
