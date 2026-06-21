#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourceRoot = join(root, 'src')

// 1. Load allowlist
const allowlistPath = join(root, 'scripts', 'layer-direction-allowlist.json')
if (!existsSync(allowlistPath)) {
  console.error(`Error: Allowlist file not found at ${allowlistPath}`)
  process.exit(1)
}

const { allowlist } = JSON.parse(await readFile(allowlistPath, 'utf8'))

// 2. Collect all TypeScript source files
const sourceFiles = await listTypeScriptFiles(sourceRoot)
const sourceFileSet = new Set(sourceFiles.map(filePath => normalizePath(relative(root, filePath))))

// 3. Scan all imports
const violations = []
let scannedImportsCount = 0

for (const filePath of sourceFiles) {
  const file = normalizePath(relative(root, filePath))
  const fromLayer = layerFromFile(file)
  const text = await readFile(filePath, 'utf8')

  for (const specifier of extractImportSpecifiers(text)) {
    const targetFile = resolveSourceImport(filePath, specifier)
    if (!targetFile) continue

    scannedImportsCount++
    const toLayer = layerFromFile(targetFile)

    if (fromLayer !== toLayer) {
      const allowed = checkImport(file, fromLayer, targetFile, toLayer)
      if (!allowed) {
        violations.push({
          file,
          fromLayer,
          specifier,
          target: targetFile,
          toLayer,
        })
      }
    }
  }
}

// 4. Report results
console.log(`\n=== Layer-Direction Dependency Audit ===`)
console.log(`Scanned ${sourceFiles.length} files, checked ${scannedImportsCount} cross-module imports.`)

if (violations.length > 0) {
  console.error(`\n❌ ERROR: Found ${violations.length} layer direction violations:`)
  for (const v of violations) {
    console.error(`  - In file: ${v.file}`)
    console.error(`    Imported: "${v.specifier}" (resolved to: ${v.target})`)
    console.error(`    Direction: ${v.fromLayer} ➔ ${v.toLayer} is forbidden.`)
    console.error(`    To permit this, add it to scripts/layer-direction-allowlist.json with justification.\n`)
  }
  process.exitCode = 1
} else {
  console.log(`\n✅ SUCCESS: No layer direction violations found!`)
}

// Helpers
async function listTypeScriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const fullPath = join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...await listTypeScriptFiles(fullPath))
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(fullPath)
    }
  }
  return files.sort()
}

function extractImportSpecifiers(text) {
  const specifiers = []
  const patterns = [
    /\bimport\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /\bimport\(['"]([^'"]+)['"]\)/g,
    /\bexport\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g,
  ]
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      specifiers.push(match[1])
    }
  }
  return specifiers
}

function resolveSourceImport(filePath, specifier) {
  if (!specifier.startsWith('.')) return undefined

  const basePath = resolve(dirname(filePath), specifier)
  const sourceBasePath = extname(basePath) === '.js' ? basePath.slice(0, -3) : basePath
  const candidates = [
    basePath,
    `${sourceBasePath}.ts`,
    `${sourceBasePath}.tsx`,
    `${basePath}.ts`,
    `${basePath}.tsx`,
    join(basePath, 'index.ts'),
    join(sourceBasePath, 'index.ts'),
  ]

  for (const candidate of candidates) {
    const candidateRelative = normalizePath(relative(root, candidate))
    if (existsSync(candidate) && sourceFileSet.has(candidateRelative)) {
      return candidateRelative
    }
  }

  return undefined
}

function layerFromFile(file) {
  const parts = file.split('/')
  return parts[0] === 'src' && parts[1] ? parts[1] : 'other'
}

function normalizePath(filePath) {
  return filePath.split('\\').join('/')
}

function isAllowed(file, targetFile) {
  const allowedTargets = allowlist[file]
  return Array.isArray(allowedTargets) && allowedTargets.includes(targetFile)
}

function checkImport(file, fromLayer, targetFile, toLayer) {
  // 1. cli -> [nexus, runtime, providers, tools, storage] must be in allowlist
  if (fromLayer === 'cli' && ['nexus', 'runtime', 'providers', 'tools', 'storage'].includes(toLayer)) {
    return isAllowed(file, targetFile)
  }
  // 2. runtime -> nexus must be in allowlist
  if (fromLayer === 'runtime' && toLayer === 'nexus') {
    return isAllowed(file, targetFile)
  }
  // 3. nexus -> cli must be in allowlist
  if (fromLayer === 'nexus' && toLayer === 'cli') {
    return isAllowed(file, targetFile)
  }
  // 4. shared -> outside shared must be in allowlist
  if (fromLayer === 'shared' && toLayer !== 'shared') {
    return isAllowed(file, targetFile)
  }
  // 5. Bottom layers (storage, providers, tools, skills, mcp) -> [cli, nexus] must be in allowlist
  if (['storage', 'providers', 'tools', 'skills', 'mcp'].includes(fromLayer) && ['cli', 'nexus'].includes(toLayer)) {
    return isAllowed(file, targetFile)
  }
  // 6. Bottom layers (storage, providers) -> runtime must be in allowlist
  if (['storage', 'providers'].includes(fromLayer) && toLayer === 'runtime') {
    return isAllowed(file, targetFile)
  }
  return true
}
