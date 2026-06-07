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
  assert.match(result.stderr + result.stdout, /Downloaded file is not a recognized executable binary|not a recognized executable/i)
  await assert.rejects(stat(join(fixture.installDir, 'bbl')))
})

test('install.sh validates and atomically installs a downloaded binary', async () => {
  const fixture = await createFixture('success')

  const result = await runInstaller(fixture)

  assert.equal(result.code, 0, result.stderr + result.stdout)
  const installed = await readFile(join(fixture.installDir, 'bbl'))
  assert.equal(installed.subarray(0, 4).toString('hex'), '7f454c46')
})

async function createFixture(mode: '404' | 'success') {
  const root = await mkdtemp(join(tmpdir(), 'babel-o-install-'))
  const binDir = join(root, 'bin')
  const installDir = join(root, 'install')
  await import('node:fs/promises').then(fs => fs.mkdir(binDir, { recursive: true }))
  await import('node:fs/promises').then(fs => fs.mkdir(installDir, { recursive: true }))

  await writeExecutable(join(binDir, 'uname'), `#!/bin/sh
if [ "$1" = "-s" ]; then
  echo Darwin
else
  echo arm64
fi
`)

  const payload = mode === 'success'
    ? Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(64, 0)])
    : Buffer.from('Not Found')
  const payloadPath = join(root, 'payload.bin')
  await writeFile(payloadPath, payload)

  await writeExecutable(join(binDir, 'curl'), `#!/bin/sh
args="$*"
if printf '%s' "$args" | grep -q -- '-I'; then
  printf 'HTTP/2 200\\r\\ncontent-length: ${payload.length}\\r\\n\\r\\n'
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
cat ${shellQuote(payloadPath)} > "$out"
exit 0
`)

  return { root, binDir, installDir }
}

async function runInstaller(fixture: { binDir: string; installDir: string }) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn('bash', [installScript], {
      env: {
        ...process.env,
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
