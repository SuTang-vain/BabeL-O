import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import {
  buildGoTuiArgs,
  createGoTuiLaunchSpec,
  defaultGoTuiBinary,
} from '../src/cli/commands/go.js'

test('buildGoTuiArgs forwards Nexus and session options', () => {
  assert.deepEqual(
    buildGoTuiArgs({
      url: 'http://127.0.0.1:3000',
      cwd: '/workspace',
      session: 'session_123',
      alt: false,
    }),
    [
      '--url',
      'http://127.0.0.1:3000',
      '--cwd',
      '/workspace',
      '--session',
      'session_123',
      '--alt=false',
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
