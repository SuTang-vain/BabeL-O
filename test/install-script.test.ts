import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn, execFileSync } from 'node:child_process'
import { test } from 'node:test'

const repoRoot = new URL('..', import.meta.url).pathname
const installScript = join(repoRoot, 'scripts/install.sh')

test('install.sh does not install HTTP error bodies', async () => {
  const fixture = await createFixture('404')

  const result = await runInstaller(fixture)

  assert.notEqual(result.code, 0)
  assert.match(result.stderr + result.stdout, /Release asset not found|Downloaded file is not a recognized executable binary|not a recognized executable/i)
  await assert.rejects(stat(join(fixture.installDir, 'bbl')))
})

test('install.sh validates and atomically installs a downloaded binary', async () => {
  const fixture = await createFixture('success')

  const result = await runInstaller(fixture)

  assert.equal(result.code, 0, result.stderr + result.stdout)
  const installed = await readFile(join(fixture.installDir, 'bbl'))
  const installedText = installed.toString('utf8')
  assert.match(installedText, /SCRIPT_DIR=/)
  assert.match(installedText, /SEA_PAYLOAD="\$SCRIPT_DIR\/bbl\.sea"/)
  assert.match(installedText, /\$\{go_args\[@\]\+"\$\{go_args\[@\]\}"\}/)
  const goTui = await readFile(join(fixture.homeDir, '.local/share/babel-o/bin/go-tui-darwin-arm64'))
  assert.match(goTui.toString('utf8'), /bbl-go-tui 0\.3\.0/)
  assert.match(result.stdout, /Running install self-check/)
  assert.match(result.stdout, /Go TUI executable starts: bbl-go-tui 0\.3\.0/)
  assert.match(result.stdout, /Result: OK/)
})

test('install.sh prefers lightweight portable package when release tarball exists', async () => {
  const fixture = await createFixture('portable')

  const result = await runInstaller(fixture)

  assert.equal(result.code, 0, result.stderr + result.stdout)
  const installed = await readFile(join(fixture.installDir, 'bbl'), 'utf8')
  assert.match(installed, /APP_DIR=/)
  assert.doesNotMatch(installed, /bbl\.sea/)
  assert.match(result.stdout, /lightweight package installed/i)
  assert.match(result.stdout, /Go TUI executable starts: bbl-go-tui 0\.3\.0/)
  assert.match(result.stdout, /Result: OK/)

  const launch = await runInstalledBbl(fixture, [
    'go',
    '--no-start-nexus',
    '--url',
    'http://127.0.0.1:3000',
    '--cwd',
    '/workspace',
    '--session',
    'session_portable',
  ])

  assert.equal(launch.code, 0, launch.stderr + launch.stdout)
  assert.match(launch.stdout, /GO_TUI_LAUNCHED --url http:\/\/127\.0\.0\.1:3000 --cwd \/workspace --session session_portable/)
})

test('install.sh wrapper launches Go TUI directly for bbl go', async () => {
  const fixture = await createFixture('success')
  const result = await runInstaller(fixture)
  assert.equal(result.code, 0, result.stderr + result.stdout)

  const launch = await runInstalledBbl(fixture, [
    'go',
    '--no-start-nexus',
    '--url',
    'http://127.0.0.1:3000',
    '--cwd',
    '/workspace',
    '--session',
    'session_test',
  ])

  assert.equal(launch.code, 0, launch.stderr + launch.stdout)
  assert.match(launch.stdout, /GO_TUI_LAUNCHED --url http:\/\/127\.0\.0\.1:3000 --cwd \/workspace --session session_test/)
  assert.doesNotMatch(launch.stderr, /SEA go path should not run/)
})

test('install.sh wrapper handles bbl go with no forwarded args under set -u', async () => {
  const fixture = await createFixture('success')
  const result = await runInstaller(fixture)
  assert.equal(result.code, 0, result.stderr + result.stdout)

  const launch = await runInstalledBbl(fixture, [
    'go',
    '--no-start-nexus',
    '--url',
    'http://127.0.0.1:3000',
    '--cwd',
    '/workspace',
  ])

  assert.equal(launch.code, 0, launch.stderr + launch.stdout)
  assert.match(launch.stdout, /GO_TUI_LAUNCHED --url http:\/\/127\.0\.0\.1:3000 --cwd \/workspace$/m)
  assert.doesNotMatch(launch.stderr + launch.stdout, /unbound variable/)
})

test('install.sh fails self-check when downloaded Go TUI cannot execute', async () => {
  const fixture = await createFixture('bad-go-tui')

  const result = await runInstaller(fixture)

  assert.notEqual(result.code, 0)
  assert.match(result.stderr + result.stdout, /installed Go TUI binary cannot start/)
})

async function createFixture(mode: '404' | 'success' | 'bad-go-tui' | 'portable') {
  const root = await mkdtemp(join(tmpdir(), 'babel-o-install-'))
  const binDir = join(root, 'bin')
  const installDir = join(root, 'install')
  const homeDir = join(root, 'home')
  await import('node:fs/promises').then(fs => fs.mkdir(binDir, { recursive: true }))
  await import('node:fs/promises').then(fs => fs.mkdir(installDir, { recursive: true }))
  await import('node:fs/promises').then(fs => fs.mkdir(homeDir, { recursive: true }))

  await writeExecutable(join(binDir, 'uname'), `#!/bin/sh
if [ "$1" = "-s" ]; then
  echo Darwin
else
  echo arm64
fi
`)

  const payload = mode !== '404'
    ? Buffer.from(`#!/bin/sh
if [ "$1" = "go" ] && [ "$2" = "--check" ] && [ "$3" = "--no-start-nexus" ]; then
  if [ "\${NODE_NO_WARNINGS:-}" != "1" ]; then
    echo "NODE_NO_WARNINGS was not set for installer self-check" >&2
    exit 1
  fi
  if [ -n "$BABEL_O_GO_TUI_BINARY" ] && [ -x "$BABEL_O_GO_TUI_BINARY" ]; then
    echo "[OK] Go TUI binary found: $BABEL_O_GO_TUI_BINARY"
    echo "Result: OK"
    exit 0
  fi
  echo "[FAIL] Go TUI binary missing" >&2
  exit 1
fi
if [ "$1" = "go" ]; then
  echo "SEA go path should not run" >&2
  exit 77
fi
if [ "$1" = "__server" ]; then
  echo "fixture server started" >&2
  while true; do sleep 1; done
fi
if [ "$1" = "--version" ]; then
  echo "0.3.0"
  exit 0
fi
echo "unexpected bbl args: $*" >&2
exit 1
`)
    : Buffer.from('Not Found')
  const payloadPath = join(root, 'payload.bin')
  await writeFile(payloadPath, payload)
  const goTuiPayload = mode === 'bad-go-tui'
    ? Buffer.from(`#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "dyld: incompatible architecture" >&2
  exit 126
fi
exit 1
`)
    : Buffer.from(`#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "bbl-go-tui 0.3.0"
  exit 0
fi
echo "GO_TUI_LAUNCHED $*"
exit 0
`)
  const goTuiPayloadPath = join(root, 'go-tui-payload.bin')
  await writeFile(goTuiPayloadPath, goTuiPayload)
  const portablePayloadPath = await createPortablePayload(root, mode)

  await writeExecutable(join(binDir, 'curl'), `#!/bin/sh
args="$*"
if printf '%s' "$args" | grep -Eq -- '(^| )-[A-Za-z]*I[A-Za-z]*( |$)'; then
  if printf '%s' "$args" | grep -q -- 'bbl-darwin-arm64.tar.gz'; then
    ${mode === 'portable' ? "printf 'HTTP/2 200\\r\\ncontent-length: PLACEHOLDER_PORTABLE_SIZE\\r\\n\\r\\n'" : "printf 'HTTP/2 404\\r\\ncontent-length: 0\\r\\n\\r\\n'; exit 22"}
  elif printf '%s' "$args" | grep -q -- 'go-tui-darwin-arm64'; then
    printf 'HTTP/2 200\\r\\ncontent-length: ${goTuiPayload.length}\\r\\n\\r\\n'
  else
    printf 'HTTP/2 200\\r\\ncontent-length: ${payload.length}\\r\\n\\r\\n'
  fi
  exit 0
fi
if [ "$1" = "-fsSL" ]; then
  printf '{"tag_name":"v0.3.0"}'
  exit 0
fi
if printf '%s' "$args" | grep -q -- '/health'; then
  printf 'ok'
  exit 0
fi
out=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--output" ]; then
    out="$arg"
  fi
  prev="$arg"
done
if [ -z "$out" ]; then
  exit 2
fi
if printf '%s' "$args" | grep -q -- 'go-tui-darwin-arm64'; then
  cat ${shellQuote(goTuiPayloadPath)} > "$out"
elif printf '%s' "$args" | grep -q -- 'bbl-darwin-arm64.tar.gz'; then
  cat ${shellQuote(portablePayloadPath)} > "$out"
else
  cat ${shellQuote(payloadPath)} > "$out"
fi
exit 0
`.replace('PLACEHOLDER_PORTABLE_SIZE', String((await stat(portablePayloadPath)).size)))

  return { root, binDir, installDir, homeDir }
}

async function createPortablePayload(root: string, mode: string) {
  const portableRoot = join(root, 'portable-src', 'babel-o-v0.3.0-darwin-arm64')
  await mkdir(join(portableRoot, 'bin'), { recursive: true })
  await writeExecutable(join(portableRoot, 'bin', 'bbl'), `#!/bin/sh
set -eu
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
exec "$SCRIPT_DIR/bbl.js" "$@"
`)
  await writeExecutable(join(portableRoot, 'bin', 'bbl.js'), `#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const goTui = resolve(root, 'bin/go-tui-darwin-arm64')
const args = process.argv.slice(2)
if (args[0] === '--version') {
  console.log('0.3.0')
  process.exit(0)
}
if (args[0] === 'go' && args.includes('--check')) {
  const result = spawnSync(goTui, ['--version'], { encoding: 'utf8' })
  if (result.status !== 0) {
    process.stderr.write(result.stderr || 'go-tui failed')
    process.exit(result.status ?? 1)
  }
  console.log('BabeL-O Go TUI install check')
  console.log('[OK]      Go TUI binary found: ' + goTui)
  console.log('[OK]      Go TUI executable starts: ' + result.stdout.trim())
  console.log('Result: OK')
  process.exit(0)
}
if (args[0] === 'go') {
  const goArgs = args.slice(1).filter(arg => arg !== '--no-start-nexus')
  const result = spawnSync(goTui, goArgs, { stdio: 'inherit' })
  process.exit(result.status ?? 1)
}
console.error('unexpected portable bbl args: ' + args.join(' '))
process.exit(1)
`)
  await writeExecutable(join(portableRoot, 'bin', 'go-tui-darwin-arm64'), mode === 'bad-go-tui'
    ? `#!/bin/sh
exit 126
`
    : `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "bbl-go-tui 0.3.0"
  exit 0
fi
echo "GO_TUI_LAUNCHED $*"
exit 0
`)
  const output = join(root, 'portable.tar.gz')
  execFileSync('tar', ['-czf', output, '-C', join(root, 'portable-src'), 'babel-o-v0.3.0-darwin-arm64'])
  return output
}

async function runInstaller(fixture: { binDir: string; installDir: string; homeDir: string }) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn('bash', [installScript], {
      env: {
        ...process.env,
        HOME: fixture.homeDir,
        PATH: `${fixture.binDir}:${process.env.PATH ?? ''}`,
        BBL_INSTALL_DIR: fixture.installDir,
        BBL_VERSION: 'v0.3.0',
      },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.on('close', code => resolve({ code, stdout, stderr }))
  })
}

async function runInstalledBbl(fixture: { binDir: string; installDir: string; homeDir: string }, args: string[]) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(join(fixture.installDir, 'bbl'), args, {
      env: {
        ...process.env,
        HOME: fixture.homeDir,
        PATH: `${fixture.binDir}:${process.env.PATH ?? ''}`,
      },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.on('close', code => resolve({ code, stdout, stderr }))
  })
}

async function writeExecutable(path: string, content: string) {
  await writeFile(path, content)
  await chmod(path, 0o755)
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}
