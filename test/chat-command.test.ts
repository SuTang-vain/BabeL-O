import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { test } from 'node:test'

const repoRoot = new URL('..', import.meta.url).pathname

test('chat command fails clearly when stdin/stdout are not interactive', () => {
  const result = spawnSync(
    join(repoRoot, 'node_modules', '.bin', 'tsx'),
    [join(repoRoot, 'src/cli/program.ts'), 'chat'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        BABEL_O_CONFIG_FILE: '/tmp/babel-o-chat-command-test-config.json',
        BABEL_O_TEST_CONFIG_WRITE_GUARD: '1',
        NO_COLOR: '1',
      },
    },
  )

  assert.equal(result.status, 1, result.stderr + result.stdout)
  assert.match(result.stderr + result.stdout, /requires an interactive terminal/)
  assert.doesNotMatch(result.stderr + result.stdout, /BABEL-O/)
})
