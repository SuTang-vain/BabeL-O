import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { Command } from 'commander'
import {
  allocateGoTuiSession,
  buildGoTuiArgs,
  collectGoTuiBinaryCandidates,
  createManagedNexusLaunchSpec,
  createGoTuiProcessSpec,
  createGoTuiLaunchSpec,
  defaultGoTuiBinary,
  defaultGoTuiBinaryName,
  ensureGoTuiSession,
  ensureNexusForGoTui,
  execGoTuiVersionProbe,
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
      arch: 'arm64',
      exists: path => path === binary || path === sourceDir,
    },
  )

  assert.deepEqual(launch, {
    command: binary,
    args: ['--url', 'http://nexus.local', '--cwd', '/workspace'],
    cwd: dirname(binary),
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
      arch: 'arm64',
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

test('allocateGoTuiSession posts to Nexus and returns the allocated session id', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const sessionId = await allocateGoTuiSession(
    {
      url: 'http://127.0.0.1:3000',
      cwd: '/workspace',
    },
    {
      env: { NEXUS_API_KEY: 'secret' },
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(input), init })
        return new Response(
          JSON.stringify({
            type: 'session_created',
            sessionId: 'session_launcher',
          }),
          {
            status: 201,
            headers: { 'content-type': 'application/json' },
          },
        )
      }) as typeof fetch,
    },
  )

  assert.equal(sessionId, 'session_launcher')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'http://127.0.0.1:3000/v1/sessions')
  assert.equal(calls[0].init?.method, 'POST')
  assert.equal(
    (calls[0].init?.headers as Record<string, string>)['X-Nexus-API-Key'],
    'secret',
  )
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
    cwd: '/workspace',
    metadata: {
      client: 'go-tui',
      phase: 'launcher_session_allocate',
      entrypoint: 'bbl go',
    },
  })
})

test('ensureGoTuiSession reuses an explicit session without POSTing', async () => {
  let fetchCalled = false
  const ready = await ensureGoTuiSession(
    {
      url: 'http://127.0.0.1:3000',
      cwd: '/workspace',
      session: ' session_existing ',
    },
    {
      fetch: (async () => {
        fetchCalled = true
        throw new Error('unexpected fetch')
      }) as typeof fetch,
    },
  )

  assert.deepEqual(ready, {
    status: 'existing',
    sessionId: 'session_existing',
  })
  assert.equal(fetchCalled, false)
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
	    arch: 'arm64',
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
	    arch: 'x64',
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
	    arch: 'x64',
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
	    arch: 'arm64',
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

test('collectGoTuiBinaryCandidates deduplicates env and XDG paths while preserving order', () => {
  const xdgPath = '/home/user/.local/share/babel-o/bin/go-tui-darwin-arm64'
  const candidates = collectGoTuiBinaryCandidates({
    options: { binary: undefined, sourceDir: '/src' },
    platform: 'darwin',
    arch: 'arm64',
    packageRoot: '/repo',
    sourceDir: '/src',
    env: { BABEL_O_GO_TUI_BINARY: xdgPath },
    homeDir: '/home/user',
    includePackageCandidates: false,
  })

  assert.deepEqual(candidates, [xdgPath])
})

test('collectGoTuiBinaryCandidates can suppress invalid package-root candidates', () => {
  const candidates = collectGoTuiBinaryCandidates({
    options: { binary: undefined, sourceDir: '/Users/clients/go-tui' },
    platform: 'darwin',
    arch: 'arm64',
    packageRoot: '/Users',
    sourceDir: '/Users/clients/go-tui',
    env: {},
    homeDir: '/Users/sutang',
    includePackageCandidates: false,
  })

  assert.deepEqual(candidates, [
    '/Users/sutang/.local/share/babel-o/bin/go-tui-darwin-arm64',
  ])
  assert.doesNotMatch(candidates.join('\n'), /\/Users\/bin\/go-tui/)
  assert.doesNotMatch(candidates.join('\n'), /\/Users\/clients\/go-tui/)
})

test('platformSuffix returns the canonical platform-arch segment', () => {
  assert.equal(platformSuffix('darwin', 'arm64'), 'darwin-arm64')
  assert.equal(platformSuffix('darwin', 'x64'), 'darwin-x64')
  assert.equal(platformSuffix('linux', 'x64'), 'linux-x64')
  assert.equal(platformSuffix('linux', 'arm64'), 'linux-arm64')
  assert.equal(platformSuffix('win32', 'x64'), 'windows-x64.exe')
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
      arch: 'arm64',
      env: { BABEL_O_GO_TUI_BINARY: envPath },
    },
  )
  assert.equal(launch.command, envPath)
  assert.equal(launch.mode, 'binary')
  assert.equal(launch.cwd, dirname(envPath))
})

test('createGoTuiLaunchSpec uses package binary dir as cwd for portable installs', () => {
  const packageRoot = '/Users/sutang/.local/share/babel-o/app/v0.3.5-darwin-arm64'
  const sourceDir = join(packageRoot, 'clients', 'go-tui')
  const packageBundled = join(packageRoot, 'bin', 'go-tui-darwin-arm64')
  const launch = createGoTuiLaunchSpec(
    {
      url: 'http://nexus.local',
      cwd: '/workspace',
      alt: true,
    },
    {
      exists: (p: string) => p === packageBundled || p === join(packageRoot, 'package.json'),
      packageRoot,
      platform: 'darwin',
      arch: 'arm64',
      env: {},
    },
  )

  assert.equal(launch.command, packageBundled)
  assert.equal(launch.mode, 'binary')
  assert.equal(launch.cwd, dirname(packageBundled))
  assert.notEqual(launch.cwd, sourceDir)
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
      arch: 'arm64',
      env: {},
    },
  )
  assert.equal(launch.command, inTreeBinary)
  assert.equal(launch.mode, 'binary')
  assert.equal(launch.cwd, dirname(inTreeBinary))
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
      arch: 'arm64',
      env: {},
    },
  )
  // Package-bundled wins because it comes earlier in the
  // candidate list (priority 4) than the source-relative
  // in-tree dev build (priority 5).
  assert.equal(launch.command, packageBundled)
  assert.equal(launch.mode, 'binary')
  assert.equal(launch.cwd, dirname(packageBundled))
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
      arch: 'arm64',
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
          arch: 'arm64',
          env: {},
        },
      ),
    /Go TUI binary not found.*Install a prebuilt via 'npm install -g/,
  )
})

test('createGoTuiProcessSpec bridges macOS binary launch through /bin/sh', () => {
  const spec = createGoTuiProcessSpec(
    {
      command: '/Users/me/.local/share/babel-o/bin/go-tui-darwin-arm64',
      args: ['--url', 'http://127.0.0.1:3000'],
      mode: 'binary',
    },
    'darwin',
  )

  assert.deepEqual(spec, {
    command: '/bin/sh',
    args: [
      '-c',
      'exec "$0" "$@"',
      '/Users/me/.local/share/babel-o/bin/go-tui-darwin-arm64',
      '--url',
      'http://127.0.0.1:3000',
    ],
    shellBridge: true,
  })
})

test('createGoTuiProcessSpec keeps source fallback as direct go run', () => {
  const spec = createGoTuiProcessSpec(
    {
      command: 'go',
      args: ['run', './cmd/go-tui'],
      mode: 'go-run',
    },
    'darwin',
  )

  assert.deepEqual(spec, {
    command: 'go',
    args: ['run', './cmd/go-tui'],
    shellBridge: false,
  })
})

test('execGoTuiVersionProbe uses the same macOS shell bridge and cwd as launch', () => {
  const calls: Array<{ command: string; args: string[]; cwd?: string }> = []
  const output = execGoTuiVersionProbe('/go-tui', {
    platform: 'darwin',
    execFileSync: ((command: string, args: string[], options: { cwd?: string }) => {
      calls.push({ command, args, cwd: options.cwd })
      return 'bbl-go-tui 0.3.3'
    }) as any,
  })

  assert.equal(output, 'bbl-go-tui 0.3.3')
  assert.deepEqual(calls, [
    {
      command: '/bin/sh',
      args: ['-c', 'exec "$0" "$@"', '/go-tui', '--version'],
      cwd: '/',
    },
  ])
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
    {
      exists,
      fetch: fetchImpl,
      packageRoot,
      platform: 'darwin',
      arch: 'arm64',
      env: {},
      homeDir: '',
      execFileSync: (() => 'bbl-go-tui 0.3.2') as any,
    },
  )
  assert.equal(report.exitCode, 0)
  const combined = report.lines.join('\n')
  assert.match(combined, /Go TUI binary search order:/)
  assert.match(combined, /selected .*go-tui-darwin-arm64/)
  assert.match(combined, /missing .*clients\/go-tui\/bin\/go-tui/)
  assert.match(combined, /Go TUI binary found: .*go-tui-darwin-arm64/)
  assert.match(combined, /Go TUI executable starts: bbl-go-tui 0\.3\.2/)
  assert.match(combined, /Nexus is healthy at http:\/\/nexus\.local/)
  assert.match(combined, /Server version: 0\.3\.2, supported Go TUI majors: \[0\]/)
  assert.match(combined, /Go TUI major 0 is compatible with this Nexus server\./)
  assert.match(combined, /Embedded Nexus storage \(would-be default\): sqlite .*\.babel-o[\\/]db\.sqlite/)
  assert.match(combined, /bbl go auto-starts a local Nexus without NEXUS_STORAGE_PATH/)
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
    { exists, fetch: fetchImpl, packageRoot, platform: 'darwin', arch: 'arm64', env: {}, homeDir: '' },
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
  assert.match(combined, /Install a prebuilt via 'npm install -g babel-o'/)
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
    { exists, fetch: fetchImpl, execFileSync: (() => 'bbl-go-tui 0.3.2') as any },
  )
  assert.equal(report.exitCode, 0)
  const combined = report.lines.join('\n')
  assert.match(combined, /Nexus is not healthy at http:\/\/127\.0\.0\.1:3000/)
  assert.match(combined, /This check does not start Nexus/)
  assert.match(combined, /A normal 'bbl go' launch may try to start a local Nexus/)
  assert.match(combined, /Result: OK/)
})

test('bbl go --check: omits invalid SEA package-root candidates from the report', async () => {
  const xdgPath = '/Users/sutang/.local/share/babel-o/bin/go-tui-darwin-arm64'
  const report = await runGoTuiCheckReport(
    {
      url: 'http://127.0.0.1:3000',
      cwd: '/workspace',
      alt: true,
    },
    {
      packageRoot: '/Users',
      platform: 'darwin',
      arch: 'arm64',
      env: { BABEL_O_GO_TUI_BINARY: xdgPath },
      homeDir: '/Users/sutang',
      exists: (p: string) => p === xdgPath,
      fetch: async () => {
        throw new Error('connection refused')
      },
      execFileSync: (() => 'bbl-go-tui 0.3.2') as any,
    },
  )
  const combined = report.lines.join('\n')
  assert.equal(report.exitCode, 0)
  assert.match(combined, new RegExp(`selected ${xdgPath}`))
  assert.doesNotMatch(combined, /\/Users\/bin\/go-tui-darwin-arm64/)
  assert.doesNotMatch(combined, /\/Users\/clients\/go-tui\/bin\/go-tui/)
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
    { exists, fetch: fetchImpl as unknown as typeof fetch, execFileSync: (() => 'bbl-go-tui 0.3.2') as any },
  )
  const combined = report.lines.join('\n')
  assert.match(combined, /\/v1\/runtime\/version returned 500; compat check skipped\./)
  // The exit code stays 0 because no FAIL row was emitted.
  assert.equal(report.exitCode, 0)
})

test('bbl go --check: fails when selected Go TUI binary cannot execute', async () => {
  const report = await runGoTuiCheckReport(
    {
      url: 'http://nexus.local',
      cwd: '/workspace',
      alt: true,
      binary: '/some/binary',
    },
    {
      exists: (p: string) => p === '/some/binary',
      fetch: async () => new Response('ok', { status: 200 }),
      execFileSync: (() => {
        throw new Error('spawn EACCES')
      }) as any,
    },
  )
  const combined = report.lines.join('\n')
  assert.equal(report.exitCode, 1)
  assert.match(combined, /Go TUI executable did not start with --version: spawn EACCES/)
  assert.match(combined, /Result: FAIL/)
})

test('bbl go --check: fails when Go TUI major is unsupported by healthy Nexus', async () => {
  const fetchImpl = (url: string | URL | Request) => {
    if (String(url).endsWith('/health')) {
      return Promise.resolve(new Response('ok', { status: 200 }))
    }
    return Promise.resolve(
      new Response(
        JSON.stringify({
          serverVersion: '1.0.0',
          goTuiCompatibility: { supportedMajors: [1] },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )
  }
  const report = await runGoTuiCheckReport(
    {
      url: 'http://nexus.local',
      cwd: '/workspace',
      alt: true,
      binary: '/some/binary',
    },
    {
      exists: (p: string) => p === '/some/binary',
      fetch: fetchImpl as unknown as typeof fetch,
      execFileSync: (() => 'bbl-go-tui 0.3.2') as any,
    },
  )
  const combined = report.lines.join('\n')
  assert.equal(report.exitCode, 1)
  assert.match(combined, /Go TUI major 0 is not supported by this Nexus server/)
  assert.match(combined, /Result: FAIL/)
})

test('bbl go --check: skips compat comparison when Go TUI version cannot be parsed', async () => {
  const fetchImpl = (url: string | URL | Request) => {
    if (String(url).endsWith('/health')) {
      return Promise.resolve(new Response('ok', { status: 200 }))
    }
    return Promise.resolve(
      new Response(
        JSON.stringify({
          serverVersion: '1.0.0',
          goTuiCompatibility: { supportedMajors: [1] },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )
  }
  const report = await runGoTuiCheckReport(
    {
      url: 'http://nexus.local',
      cwd: '/workspace',
      alt: true,
      binary: '/some/binary',
    },
    {
      exists: (p: string) => p === '/some/binary',
      fetch: fetchImpl as unknown as typeof fetch,
      execFileSync: (() => 'development build') as any,
    },
  )
  const combined = report.lines.join('\n')
  assert.equal(report.exitCode, 0)
  assert.match(combined, /Could not parse Go TUI major from --version output; compat check skipped\./)
})

test('bbl go --check: embedded-nexus-storage line honours BABEL_O_CONFIG_DIR (Phase 4)', async () => {
  // Phase 4 of go-tui-session-observability-governance-plan.md: the
  // check report must surface the *would-be* embedded Nexus storage
  // path so the operator can see whether sessions persist across
  // `bbl go` exits. The path must honour BABEL_O_CONFIG_DIR (the
  // same override the runtime uses), not the real ~/.babel-o.
  const packageRoot = '/repo'
  const sourceDir = join(packageRoot, 'clients', 'go-tui')
  const packageBundled = join(packageRoot, 'bin', 'go-tui-darwin-arm64')
  const exists = (p: string) => p === packageBundled || p === sourceDir
  const fetchImpl = (async () => new Response('ok', { status: 200 })) as unknown as typeof fetch
  const report = await runGoTuiCheckReport(
    {
      url: 'http://nexus.local',
      cwd: '/workspace',
      alt: true,
    },
    {
      exists,
      fetch: fetchImpl,
      packageRoot,
      platform: 'darwin',
      arch: 'arm64',
      env: { BABEL_O_CONFIG_DIR: '/custom/config/dir' },
      homeDir: '/should/not/be/used',
      execFileSync: (() => 'bbl-go-tui 0.3.2') as any,
    },
  )
  assert.equal(report.exitCode, 0)
  const combined = report.lines.join('\n')
  assert.match(
    combined,
    /Embedded Nexus storage \(would-be default\): sqlite \/custom\/config\/dir[\\/]db\.sqlite/,
  )
})

test('bbl go --check: embedded-nexus-storage warns memory when NODE_ENV=test (test isolation)', async () => {
  // When NODE_ENV=test, the runtime's resolveDefaultStoragePath
  // falls back to MemoryStorage to protect the real ~/.babel-o.
  // The check report must surface this as a WARN so an operator
  // running `bbl go --check` from inside a test shell understands
  // sessions would NOT persist.
  const packageRoot = '/repo'
  const sourceDir = join(packageRoot, 'clients', 'go-tui')
  const packageBundled = join(packageRoot, 'bin', 'go-tui-darwin-arm64')
  const exists = (p: string) => p === packageBundled || p === sourceDir
  const fetchImpl = (async () => new Response('ok', { status: 200 })) as unknown as typeof fetch
  const report = await runGoTuiCheckReport(
    {
      url: 'http://nexus.local',
      cwd: '/workspace',
      alt: true,
    },
    {
      exists,
      fetch: fetchImpl,
      packageRoot,
      platform: 'darwin',
      arch: 'arm64',
      env: { NODE_ENV: 'test' },
      homeDir: '/home',
      execFileSync: (() => 'bbl-go-tui 0.3.2') as any,
    },
  )
  assert.equal(report.exitCode, 0)
  const combined = report.lines.join('\n')
  assert.match(combined, /Embedded Nexus storage \(would-be default\): memory \(memory-opt-in\)/)
  assert.match(combined, /would NOT persist sessions to disk in this environment/)
})

test('bbl go --help describes the Go TUI as the production client', () => {
  const program = new Command()
  registerGoCommand(program)
  const goCommand = program.commands.find((c) => c.name() === 'go')
  assert.ok(goCommand, 'expected a `go` subcommand to be registered')
  const description = goCommand!.description()
  assert.match(description ?? '', /Launch the production Go TUI client/)
  assert.doesNotMatch(description ?? '', /bbl chat/)
  assert.doesNotMatch(description ?? '', /experimental/)
})
