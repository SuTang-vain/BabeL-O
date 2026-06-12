import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
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
  assert.match(installed.toString('utf8'), /--check/)
  const goTui = await readFile(join(fixture.homeDir, '.local/share/babel-o/bin/go-tui-darwin-arm64'))
  assert.match(goTui.toString('utf8'), /bbl-go-tui 0\.3\.0/)
  assert.match(result.stdout, /Running install self-check/)
  assert.match(result.stdout, /Result: OK/)
})

async function createFixture(mode: '404' | 'success') {
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

  const payload = mode === 'success'
    ? Buffer.from(`#!/bin/sh
if [ "$1" = "go" ] && [ "$2" = "--check" ] && [ "$3" = "--no-start-nexus" ]; then
  if [ -n "$BABEL_O_GO_TUI_BINARY" ] && [ -x "$BABEL_O_GO_TUI_BINARY" ]; then
    echo "[OK] Go TUI binary found: $BABEL_O_GO_TUI_BINARY"
    echo "Result: OK"
    exit 0
  fi
  echo "[FAIL] Go TUI binary missing" >&2
  exit 1
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
  const goTuiPayload = Buffer.from(`#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "bbl-go-tui 0.3.0"
  exit 0
fi
echo "unexpected go-tui args: $*" >&2
exit 1
`)
  const goTuiPayloadPath = join(root, 'go-tui-payload.bin')
  await writeFile(goTuiPayloadPath, goTuiPayload)

  await writeExecutable(join(binDir, 'curl'), `#!/bin/sh
args="$*"
if printf '%s' "$args" | grep -Eq -- '(^| )-[A-Za-z]*I[A-Za-z]*( |$)'; then
  if printf '%s' "$args" | grep -q -- 'go-tui-darwin-arm64'; then
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
else
  cat ${shellQuote(payloadPath)} > "$out"
fi
exit 0
`)

  return { root, binDir, installDir, homeDir }
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

async function writeExecutable(path: string, content: string) {
  await writeFile(path, content)
  await chmod(path, 0o755)
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}
