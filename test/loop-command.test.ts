import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

import {
  buildLoopArgs,
  createLoopLaunchSpec,
  type LoopCommandOptions,
} from '../src/cli/commands/loop.js'

function baseOptions(overrides: Partial<LoopCommandOptions> = {}): LoopCommandOptions {
  return {
    url: 'http://127.0.0.1:3000',
    cwd: '/workspace',
    workspace: 'ws-main',
    state: '',
    pollIntervalMs: '5000',
    healthIntervalMs: '3000',
    waitTimeoutMs: '5000',
    alt: true,
    mouse: true,
    noCheck: false,
    check: false,
    ...overrides,
  }
}

test('buildLoopArgs forwards display and polling options', () => {
  assert.deepEqual(
    buildLoopArgs(baseOptions({
      state: '/tmp/bbl-loop-state.json',
      pollIntervalMs: '7000',
      healthIntervalMs: '1500',
      waitTimeoutMs: '9000',
      alt: false,
      mouse: false,
    })),
    [
      '--url',
      'http://127.0.0.1:3000',
      '--cwd',
      '/workspace',
      '--workspace',
      'ws-main',
      '--state',
      '/tmp/bbl-loop-state.json',
      '--poll-interval-ms',
      '7000',
      '--health-interval-ms',
      '1500',
      '--wait-timeout-ms',
      '9000',
      '--alt=false',
      '--mouse=false',
    ],
  )
})

test('createLoopLaunchSpec prefers a prebuilt loop binary', () => {
  const packageRoot = '/repo'
  const sourceDir = join(packageRoot, 'clients', 'go-tui')
  const binary = join(sourceDir, 'bin', 'bbl-loop')
  const launch = createLoopLaunchSpec(
    baseOptions(),
    {
      packageRoot,
      exists: path => path === binary || path === sourceDir,
    },
  )

  assert.deepEqual(launch, {
    command: binary,
    args: buildLoopArgs(baseOptions()),
    cwd: dirname(binary),
    mode: 'binary',
  })
})

test('createLoopLaunchSpec falls back to go run when no loop binary exists', () => {
  const packageRoot = '/repo'
  const sourceDir = join(packageRoot, 'clients', 'go-tui')
  const launch = createLoopLaunchSpec(
    baseOptions(),
    {
      packageRoot,
      exists: path => path === sourceDir,
    },
  )

  assert.deepEqual(launch, {
    command: 'go',
    args: ['run', './cmd/bbl-loop', ...buildLoopArgs(baseOptions())],
    cwd: sourceDir,
    mode: 'go-run',
  })
})
