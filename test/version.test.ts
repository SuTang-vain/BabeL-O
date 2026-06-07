import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { BABEL_O_VERSION } from '../src/shared/version.js'

const repoRoot = new URL('..', import.meta.url).pathname

test('shared CLI version matches package version', async () => {
  const packageJson = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8')) as { version: string }
  assert.equal(BABEL_O_VERSION, packageJson.version)
})
