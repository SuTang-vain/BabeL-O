#!/usr/bin/env node
import { readFile, readdir } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

const root = resolve(new URL('..', import.meta.url).pathname)
const checkedExtensions = new Set(['.js', '.json', '.md', '.ts', '.tsx', '.yml', '.yaml'])
const skippedDirectories = new Set(['.git', '.cache', 'coverage', 'dist', 'node_modules'])
const failures = []

for (const filePath of await listFiles(root)) {
  const relativePath = relative(root, filePath)
  if (!checkedExtensions.has(extensionOf(filePath))) continue
  const text = await readFile(filePath, 'utf8')
  if (text.includes('\r\n')) {
    failures.push({ file: relativePath, reason: 'crlf_line_endings' })
  }
  if (text.length > 0 && !text.endsWith('\n')) {
    failures.push({ file: relativePath, reason: 'missing_final_newline' })
  }
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    if (/[\t ]+$/.test(lines[index])) {
      failures.push({ file: relativePath, line: index + 1, reason: 'trailing_whitespace' })
      break
    }
  }
  if (filePath.endsWith('.json')) {
    try {
      JSON.parse(text)
    } catch (error) {
      failures.push({ file: relativePath, reason: 'invalid_json', message: error.message })
    }
  }
}

console.log(JSON.stringify({
  type: 'format_check',
  checkedExtensions: [...checkedExtensions].sort(),
  failureCount: failures.length,
  failures,
}, null, 2))

if (failures.length > 0) {
  process.exitCode = 1
}

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (skippedDirectories.has(entry.name)) continue
      files.push(...await listFiles(join(directory, entry.name)))
    } else if (entry.isFile()) {
      files.push(join(directory, entry.name))
    }
  }
  return files
}

function extensionOf(filePath) {
  const match = /\.[^.]+$/.exec(filePath)
  return match?.[0] ?? ''
}
