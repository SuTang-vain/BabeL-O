#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const result = spawnSync(
  process.execPath,
  ['--import', 'tsx', resolve(root, 'src/cli/program.ts'), ...process.argv.slice(2)],
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
