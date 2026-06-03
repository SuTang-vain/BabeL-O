#!/usr/bin/env node
import { builtinModules } from 'node:module'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))

const dependencyOwnership = {
  '@fastify/websocket': 'runtime',
  fastify: 'runtime',
  minimatch: 'runtime',
  zod: 'runtime',
  chalk: 'cli',
  commander: 'cli',
  ws: 'cli',
}
const nodeBuiltinModules = new Set([
  ...builtinModules,
  ...builtinModules.map(name => `node:${name}`),
])
const cliOnlyDependencies = new Set(
  Object.entries(dependencyOwnership)
    .filter(([, owner]) => owner === 'cli')
    .map(([name]) => name),
)
const directDependencies = Object.keys(packageJson.dependencies ?? {})
const directDependencySet = new Set(directDependencies)
const devDependencies = new Set(Object.keys(packageJson.devDependencies ?? {}))
const missingOwnership = directDependencies.filter(name => dependencyOwnership[name] === undefined)
const sourceImports = await collectSourceImports(join(root, 'src'))
const runtimeCliLeaks = sourceImports.filter(entry =>
  entry.area === 'runtime' && cliOnlyDependencies.has(entry.packageName),
)
const devDependencyLeaks = sourceImports.filter(entry => devDependencies.has(entry.packageName))
const undeclaredImports = sourceImports.filter(entry => !directDependencySet.has(entry.packageName))

const report = {
  type: 'dependency_boundary_audit',
  directDependencies: directDependencies.map(name => ({
    name,
    owner: dependencyOwnership[name] ?? 'unclassified',
  })),
  runtimeReachableImports: groupImports(sourceImports.filter(entry => entry.area === 'runtime')),
  cliImports: groupImports(sourceImports.filter(entry => entry.area === 'cli')),
  failures: {
    missingOwnership,
    runtimeCliLeaks,
    devDependencyLeaks,
    undeclaredImports,
  },
}

console.log(JSON.stringify(report, null, 2))

if (
  missingOwnership.length > 0 ||
  runtimeCliLeaks.length > 0 ||
  devDependencyLeaks.length > 0 ||
  undeclaredImports.length > 0
) {
  process.exitCode = 1
}

async function collectSourceImports(directory) {
  const imports = []
  for (const filePath of await listTypeScriptFiles(directory)) {
    const text = await readFile(filePath, 'utf8')
    for (const specifier of extractImportSpecifiers(text)) {
      const packageName = packageNameFromSpecifier(specifier)
      if (!packageName) continue
      imports.push({
        file: relative(root, filePath),
        area: filePath.includes(`${join('src', 'cli')}${separatorFragment()}`) ? 'cli' : 'runtime',
        packageName,
        specifier,
      })
    }
  }
  return imports
}

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
  return files
}

function extractImportSpecifiers(text) {
  const specifiers = []
  const staticImportPattern = /\bimport\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g
  const dynamicImportPattern = /\bimport\(['"]([^'"]+)['"]\)/g
  for (const match of text.matchAll(staticImportPattern)) {
    specifiers.push(match[1])
  }
  for (const match of text.matchAll(dynamicImportPattern)) {
    specifiers.push(match[1])
  }
  return specifiers
}

function packageNameFromSpecifier(specifier) {
  if (specifier.startsWith('.') || specifier.startsWith('/')) return undefined
  if (nodeBuiltinModules.has(specifier)) return undefined
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]
}

function groupImports(imports) {
  const byPackage = new Map()
  for (const entry of imports) {
    const files = byPackage.get(entry.packageName) ?? new Set()
    files.add(entry.file)
    byPackage.set(entry.packageName, files)
  }
  return [...byPackage.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([packageName, files]) => ({
      packageName,
      files: [...files].sort(),
    }))
}

function separatorFragment() {
  return process.platform === 'win32' ? '\\' : '/'
}
