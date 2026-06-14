#!/usr/bin/env node
import { rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

rmSync(join(repoRoot, 'dist'), { recursive: true, force: true })
