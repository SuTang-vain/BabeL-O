import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

const repoRoot = new URL('..', import.meta.url).pathname
const buildBinaryScript = join(repoRoot, 'scripts/build-binary.js')

test('build-binary esbuild banner aliases createRequire to avoid ESM duplicate declarations', async () => {
  const script = await readFile(buildBinaryScript, 'utf8')

  assert.match(script, /createRequire as babelOCreateRequire/)
  assert.match(script, /const require = babelOCreateRequire\(import\.meta\.url\)/)
  assert.doesNotMatch(script, /import \{ createRequire \} from ['"]node:module['"]/)
  assert.doesNotMatch(script, /const require = createRequire\(import\.meta\.url\)/)
})
