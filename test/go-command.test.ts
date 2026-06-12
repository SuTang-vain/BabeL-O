import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { Command } from 'commander'
import {
  buildGoTuiArgs,
  collectGoTuiBinaryCandidates,
  createManagedNexusLaunchSpec,
  createGoTuiLaunchSpec,
  defaultGoTuiBinary,
  defaultGoTuiBinaryName,
  ensureNexusForGoTui,
  isLocalNexusUrl,
  isNexusHealthy,
  platformSuffix,
  registerGoCommand,
  runGoTuiCheckReport,
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
    args: ['run', './cmd/go-tui', '--url', 'http://nexus.local', '--cwd', '/workspace'],
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

/**
 * Phase 8 PR2: collectGoTuiBinaryCandidates returns the
 * ordered prebuilt-asset search list the `bbl go` launcher
 * probes at startup. The order is the spec from the PR2
 * plan (highest-priority first):
 *   1. explicit `--binary`
 *   2. $BABEL_O_GO_TUI_BINARY
 *   3. $BABEL_O_GO_TUI_PACKAGE_BINARY
 *   4. package-bundled default
 *   5. source-relative in-tree dev build
 *   6. XDG user-local
 */
test('collectGoTuiBinaryCandidates returns candidates in the spec order', () => {
  const packageRoot = '/repo'
  const sourceDir = join(packageRoot, 'clients', 'go-tui')
  const candidates = collectGoTuiBinaryCandidates({
    options: { binary: undefined, sourceDir },
    platform: 'darwin',
    packageRoot,
    sourceDir,
    env: {
      BABEL_O_GO_TUI_BINARY: '/env/bin/go-tui',
      BABEL_O_GO_TUI_PACKAGE_BINARY: '/env/bin/go-tui-package',
    },
    homeDir: '/home/user',
  })
  // Expected ordered list:
  //   1. BABEL_O_GO_TUI_BINARY
  //   2. BABEL_O_GO_TUI_PACKAGE_BINARY
  //   3. /repo/bin/go-tui-darwin-arm64 (platformSuffix darwin)
  //   4. /repo/clients/go-tui/bin/go-tui (source-relative)
  //   5. /home/user/.local/share/babel-o/bin/go-tui-darwin-arm64
  const expected = [
    '/env/bin/go-tui',
    '/env/bin/go-tui-package',
    '/repo/bin/go-tui-darwin-arm64',
    join(sourceDir, 'bin', 'go-tui'),
    '/home/user/.local/share/babel-o/bin/go-tui-darwin-arm64',
  ]
  assert.deepEqual(candidates, expected)
})

test('collectGoTuiBinaryCandidates pushes explicit --binary ahead of env', () => {
  const candidates = collectGoTuiBinaryCandidates({
    options: { binary: '/explicit/go-tui', sourceDir: '/src' },
    platform: 'linux',
    packageRoot: '/repo',
    sourceDir: '/src',
    env: { BABEL_O_GO_TUI_BINARY: '/env/go-tui' },
  })
  assert.equal(candidates[0], '/explicit/go-tui', 'explicit --binary wins')
  assert.equal(candidates[1], '/env/go-tui', 'env var comes second')
})

test('collectGoTuiBinaryCandidates omits missing env vars', () => {
  const candidates = collectGoTuiBinaryCandidates({
    options: { binary: undefined, sourceDir: '/src' },
    platform: 'linux',
    packageRoot: '/repo',
    sourceDir: '/src',
    env: {},
  })
  // Without env, the order is: package-bundled default,
  // source-relative. No XDG entry (no homeDir).
  assert.deepEqual(candidates, [
    '/repo/bin/go-tui-linux-x64',
    join('/src', 'bin', 'go-tui'),
  ])
})

test('collectGoTuiBinaryCandidates omits XDG entry when homeDir is missing', () => {
  const candidates = collectGoTuiBinaryCandidates({
    options: { binary: undefined, sourceDir: '/src' },
    platform: 'darwin',
    packageRoot: '/repo',
    sourceDir: '/src',
    env: {},
  })
  // No XDG (no homeDir), so the list is just package-bundled
  // + source-relative.
  assert.deepEqual(candidates, [
    '/repo/bin/go-tui-darwin-arm64',
    join('/src', 'bin', 'go-tui'),
  ])
})

test('platformSuffix returns the canonical platform-arch segment', () => {
  assert.equal(platformSuffix('darwin'), 'darwin-arm64')
  assert.equal(platformSuffix('linux'), 'linux-x64')
  assert.equal(platformSuffix('win32'), 'windows-x64.exe')
  assert.equal(platformSuffix('freebsd'), 'freebsd-x64')
  // Unknown platform falls through to `${platform}-x64`
  // so a future port still gets a reasonable default
  // (the launcher will just fail to find the file and
  // fall back to source / go run ./cmd/go-tui).
  assert.equal(platformSuffix('aix' as NodeJS.Platform), 'aix-x64')
})

test('defaultGoTuiBinaryName returns the platform go-tui/go-tui.exe name', () => {
  assert.equal(defaultGoTuiBinaryName('darwin'), 'go-tui')
  assert.equal(defaultGoTuiBinaryName('linux'), 'go-tui')
  assert.equal(defaultGoTuiBinaryName('win32'), 'go-tui.exe')
})

/**
 * Phase 8 PR2: createGoTuiLaunchSpec honors the new search
 * order. A binary at the second-priority env var path wins
 * even when the in-tree dev build is also present.
 */
test('createGoTuiLaunchSpec prefers BABEL_O_GO_TUI_BINARY over the in-tree dev build', () => {
  const packageRoot = '/repo'
  const sourceDir = join(packageRoot, 'clients', 'go-tui')
  const envPath = '/usr/local/bin/bbl-go-tui'
  // exists() reports ONLY the env path as a real file —
  // the source-relative in-tree dev build is missing.
  const exists = (p: string) => p === envPath
  const launch = createGoTuiLaunchSpec(
    {
      url: 'http://nexus.local',
      cwd: '/workspace',
      alt: true,
    },
    {
      exists,
      packageRoot,
      platform: 'darwin',
      env: { BABEL_O_GO_TUI_BINARY: envPath },
    },
  )
  assert.equal(launch.command, envPath)
  assert.equal(launch.mode, 'binary')
  assert.equal(launch.cwd, sourceDir)
})

test('createGoTuiLaunchSpec falls back to the in-tree dev build when no env var is set', () => {
  const packageRoot = '/repo'
  const sourceDir = join(packageRoot, 'clients', 'go-tui')
  const inTreeBinary = join(sourceDir, 'bin', 'go-tui')
  const exists = (p: string) => p === inTreeBinary
  const launch = createGoTuiLaunchSpec(
    {
      url: 'http://nexus.local',
      cwd: '/workspace',
      alt: true,
    },
    {
      exists,
      packageRoot,
      platform: 'darwin',
      env: {},
    },
  )
  assert.equal(launch.command, inTreeBinary)
  assert.equal(launch.mode, 'binary')
})

test('createGoTuiLaunchSpec picks the package-bundled prebuilt before the in-tree dev build', () => {
  const packageRoot = '/repo'
  const sourceDir = join(packageRoot, 'clients', 'go-tui')
  const packageBundled = join(packageRoot, 'bin', 'go-tui-darwin-arm64')
  const inTreeBinary = join(sourceDir, 'bin', 'go-tui')
  const exists = (p: string) => p === packageBundled || p === inTreeBinary
  const launch = createGoTuiLaunchSpec(
    {
      url: 'http://nexus.local',
      cwd: '/workspace',
      alt: true,
    },
    {
      exists,
      packageRoot,
      platform: 'darwin',
      env: {},
    },
  )
  // Package-bundled wins because it comes earlier in the
  // candidate list (priority 4) than the source-relative
  // in-tree dev build (priority 5).
  assert.equal(launch.command, packageBundled)
  assert.equal(launch.mode, 'binary')
})

test('createGoTuiLaunchSpec falls back to go run ./cmd/go-tui when no binary exists', () => {
  const packageRoot = '/repo'
  const sourceDir = join(packageRoot, 'clients', 'go-tui')
  // exists() returns true ONLY for the sourceDir itself
  // (the directory is present, the candidates aren't).
  const exists = (p: string) => p === sourceDir
  const launch = createGoTuiLaunchSpec(
    {
      url: 'http://nexus.local',
      cwd: '/workspace',
      alt: true,
    },
    {
      exists,
      packageRoot,
      platform: 'darwin',
      env: {},
    },
  )
  assert.equal(launch.command, 'go')
  assert.equal(launch.args[0], 'run')
  assert.equal(launch.args[1], './cmd/go-tui')
  // The remaining args are the standard Go TUI flags
  // (--url, --cwd, ...).
  assert.equal(launch.mode, 'go-run')
})

test('createGoTuiLaunchSpec errors with an actionable hint when explicit --binary is missing', () => {
  // exists() returns false for every candidate.
  const exists = () => false
  // existsSync will still return true for the sourceDir
  // itself — the launcher only checks sourceDir presence
  // for the source-fallback path, not for the explicit
  // --binary path. So we need a real temp sourceDir.
  assert.throws(
    () =>
      createGoTuiLaunchSpec(
        {
          url: 'http://nexus.local',
          cwd: '/workspace',
          alt: true,
          binary: '/nonexistent/go-tui',
        },
        {
          exists,
          packageRoot: '/repo',
          platform: 'darwin',
          env: {},
        },
      ),
    /Go TUI binary not found.*Install a prebuilt via 'npm install -g/,
  )
})

/**
 * Phase 8 PR3: `bbl go --check` reports install readiness.
 * The check covers three concerns:
 *   - Go TUI launchability (binary found via the
 *     multi-path discovery, OR source fallback OK,
 *     OR explicit --binary honored)
 *   - Nexus health at the target URL
 *   - version compat (best-effort, server is healthy)
 *
 * The exit code is 0 when no FAIL row was emitted, 1
 * otherwise. WARN rows do NOT bump the exit code so the
 * check can be used in CI even when the user is running
 * against a remote Nexus.
 */
test('bbl go --check: passes when a prebuilt binary is present and Nexus is healthy', async () => {
  const packageRoot = '/repo'
  const sourceDir = join(packageRoot, 'clients', 'go-tui')
  const packageBundled = join(packageRoot, 'bin', 'go-tui-darwin-arm64')
  const exists = (p: string) => p === packageBundled || p === sourceDir
  const fetchImpl = (async () => new Response(
    JSON.stringify({
      type: 'runtime_version',
      serverVersion: '0.3.2',
      schemaVersion: '2026-05-21.babel-o.v1',
      goTuiCompatibility: { supportedMajors: [0], latestSupported: '0.3.2' },
      nodeCliCompatibility: { supportedMajors: [0], latestSupported: '0.3.2' },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )) as unknown as typeof fetch
  const report = await runGoTuiCheckReport(
    {
      url: 'http://nexus.local',
      cwd: '/workspace',
      alt: true,
    },
    { exists, fetch: fetchImpl, packageRoot },
  )
  assert.equal(report.exitCode, 0)
  const combined = report.lines.join('\n')
  assert.match(combined, /Go TUI binary search order:/)
  assert.match(combined, /selected .*go-tui-darwin-arm64/)
  assert.match(combined, /missing .*clients\/go-tui\/bin\/go-tui/)
  assert.match(combined, /Go TUI binary found: .*go-tui-darwin-arm64/)
  assert.match(combined, /Nexus is healthy at http:\/\/nexus\.local/)
  assert.match(combined, /Server version: 0\.3\.2, supported Go TUI majors: \[0\]/)
  assert.match(combined, /Result: OK/)
})

test('bbl go --check: warns (does not fail) when no prebuilt but source is present', async () => {
  // exists() returns true ONLY for the sourceDir (so the
  // source-fallback branch fires), and false for all
  // binary candidates.
  const packageRoot = '/repo'
  const sourceDir = join(packageRoot, 'clients', 'go-tui')
  const exists = (p: string) => p === sourceDir
  const fetchImpl = (async () => new Response('ok', { status: 200 })) as unknown as typeof fetch
  const report = await runGoTuiCheckReport(
    {
      url: 'http://nexus.local',
      cwd: '/workspace',
      alt: true,
    },
    { exists, fetch: fetchImpl, packageRoot },
  )
  assert.equal(report.exitCode, 0)
  const combined = report.lines.join('\n')
  assert.match(combined, /Go TUI binary search order:/)
  assert.match(combined, /missing .*go-tui-darwin-arm64/)
  assert.match(combined, /missing .*clients\/go-tui\/bin\/go-tui/)
  assert.match(combined, /No prebuilt Go TUI binary found in the multi-path search\./)
  assert.match(combined, /Will fall back to source 'go run \.\/cmd\/go-tui'/)
  assert.match(combined, /Result: WARN/)
})

test('bbl go --check: fails when no prebuilt AND no source directory', async () => {
  // Both prebuilt candidates AND the sourceDir are missing.
  // The mock exists() returns false for everything, so
  // the launcher hits the FAIL branch.
  const packageRoot = '/repo/that/does/not/exist'
  const exists = () => false
  const report = await runGoTuiCheckReport(
    {
      url: 'http://nexus.local',
      cwd: '/workspace',
      alt: true,
    },
    { exists, fetch: async () => new Response('ok', { status: 200 }), packageRoot },
  )
  assert.equal(report.exitCode, 1)
  const combined = report.lines.join('\n')
  assert.match(combined, /No prebuilt Go TUI binary AND no source directory/)
  assert.match(combined, /Install a prebuilt via 'npm install -g @bablel\/babel-o'/)
  assert.match(combined, /Result: FAIL/)
})

test('bbl go --check: warns (does not fail) when Nexus is not healthy', async () => {
  // The launcher auto-starts a local Nexus when --url is
  // a localhost URL, so an unhealthy Nexus is a WARN
  // rather than a FAIL.
  const exists = (p: string) => p === '/some/binary'
  const fetchImpl = (async () => {
    throw new Error('connection refused')
  }) as unknown as typeof fetch
  const report = await runGoTuiCheckReport(
    {
      url: 'http://127.0.0.1:3000',
      cwd: '/workspace',
      alt: true,
      binary: '/some/binary',
    },
    { exists, fetch: fetchImpl },
  )
  assert.equal(report.exitCode, 0)
  const combined = report.lines.join('\n')
  assert.match(combined, /Nexus is not healthy at http:\/\/127\.0\.0\.1:3000/)
  assert.match(combined, /The launcher will start a local Nexus automatically/)
  assert.match(combined, /Result: OK/)
})

test('bbl go --check: skips the compat INFO row when /v1/runtime/version returns 500', async () => {
  const exists = (p: string) => p === '/some/binary'
  const fetchImpl = (url: string | URL | Request) => {
    if (String(url).endsWith('/health')) {
      return Promise.resolve(new Response('ok', { status: 200 }))
    }
    if (String(url).endsWith('/v1/runtime/version')) {
      return Promise.resolve(new Response('server error', { status: 500 }))
    }
    return Promise.resolve(new Response('not found', { status: 404 }))
  }
  const report = await runGoTuiCheckReport(
    {
      url: 'http://nexus.local',
      cwd: '/workspace',
      alt: true,
      binary: '/some/binary',
    },
    { exists, fetch: fetchImpl as unknown as typeof fetch },
  )
  const combined = report.lines.join('\n')
  assert.match(combined, /\/v1\/runtime\/version returned 500; compat check skipped\./)
  // The exit code stays 0 because no FAIL row was emitted.
  assert.equal(report.exitCode, 0)
})

/**
 * Phase 9 promotion gate regression guard. The `bbl go`
 * command's user-facing --help description must keep its
 * "stable alternative to bbl chat" wording (set in 2026-06-10
 * per docs/nexus/PHASE_9_DECISION.md). If a future change
 * accidentally reverts the wording back to "experimental"
 * (or similar) without first closing Phase 9 again, this
 * test trips the smoke step so the decision is surfaced.
 *
 * The test inspects the registered commander Command
 * object directly (rather than spawning the CLI), so it
 * doesn't depend on the tsx loader being available in
 * the test cwd.
 */
test('bbl go --help describes the Go TUI as a stable alternative (Phase 9 promotion guard)', () => {
  const program = new Command()
  registerGoCommand(program)
  const goCommand = program.commands.find(c => c.name() === 'go')
  assert.ok(goCommand, 'expected a `go` subcommand to be registered')
  const description = goCommand!.description()
  assert.match(description ?? '', /Launch the Go TUI client/)
  assert.match(description ?? '', /stable alternative to bbl chat/)
  // Defensive: the OLD "experimental" wording must not
  // creep back in unless Phase 9 is explicitly re-opened.
  assert.doesNotMatch(description ?? '', /experimental/)
})
