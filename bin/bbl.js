#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const prodEntry = resolve(root, 'dist/cli/program.js')
const isProd = existsSync(prodEntry)

const args = isProd
  ? [prodEntry, ...process.argv.slice(2)]
  : ['--import', 'tsx', resolve(root, 'src/cli/program.ts'), ...process.argv.slice(2)]

const result = spawnSync(
  process.execPath,
  args,
  {
    cwd: root,
    env: {
      ...process.env,
      BABEL_O_LAUNCH_CWD: process.cwd(),
    },
    stdio: 'inherit',
  },
)

if (result.error) throw result.error
process.exit(result.status ?? 1)
