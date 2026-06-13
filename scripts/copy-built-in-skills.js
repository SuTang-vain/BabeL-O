#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(repoRoot, 'src', 'skills', 'built-in')
const target = join(repoRoot, 'dist', 'skills', 'built-in')

if (!existsSync(source)) {
  throw new Error(`Built-in skills source directory is missing: ${source}`)
}

mkdirSync(dirname(target), { recursive: true })
rmSync(target, { recursive: true, force: true })
cpSync(source, target, { recursive: true })
