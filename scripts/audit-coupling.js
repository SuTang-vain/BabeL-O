#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourceRoot = join(root, 'src')
const sourceFiles = await listTypeScriptFiles(sourceRoot)
const sourceFileSet = new Set(sourceFiles.map(filePath => normalizePath(relative(root, filePath))))
const sourceImports = await collectSourceImports(sourceFiles)
const sourceTexts = await readSourceTexts(sourceFiles)

const report = {
  type: 'coupling_audit',
  sourceRoot: 'src',
  reverseImports: {
    runtimeToNexus: reverseImports('runtime', 'nexus'),
    nexusToCli: reverseImports('nexus', 'cli'),
    sharedToOutside: sourceImports.filter(
      entry => entry.fromLayer === 'shared' && entry.toLayer && entry.toLayer !== 'shared',
    ),
  },
  importDirections: buildImportDirections(sourceImports),
  singletonState: auditSingletonState(sourceTexts),
  largeFiles: auditLargeFiles(sourceTexts),
  processEnvConcentration: auditProcessConcentration(sourceTexts),
}

console.log(JSON.stringify(report, null, 2))

async function collectSourceImports(files) {
  const imports = []
  for (const filePath of files) {
    const text = await readFile(filePath, 'utf8')
    const file = normalizePath(relative(root, filePath))
    const fromLayer = layerFromFile(file)
    for (const specifier of extractImportSpecifiers(text)) {
      const targetFile = resolveSourceImport(filePath, specifier)
      imports.push({
        file,
        fromLayer,
        specifier,
        target: targetFile,
        toLayer: targetFile ? layerFromFile(targetFile) : undefined,
      })
    }
  }
  return imports
}

async function readSourceTexts(files) {
  const texts = new Map()
  for (const filePath of files) {
    texts.set(normalizePath(relative(root, filePath)), await readFile(filePath, 'utf8'))
  }
  return texts
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

function reverseImports(fromLayer, toLayer) {
  return sourceImports.filter(entry => entry.fromLayer === fromLayer && entry.toLayer === toLayer)
}

function buildImportDirections(imports) {
  const directions = new Map()
  for (const entry of imports) {
    if (!entry.toLayer || entry.fromLayer === entry.toLayer) continue
    const key = `${entry.fromLayer}->${entry.toLayer}`
    const direction = directions.get(key) ?? {
      from: entry.fromLayer,
      to: entry.toLayer,
      count: 0,
      files: new Set(),
    }
    direction.count += 1
    direction.files.add(entry.file)
    directions.set(key, direction)
  }

  return [...directions.values()]
    .sort((left, right) => right.count - left.count || `${left.from}->${left.to}`.localeCompare(`${right.from}->${right.to}`))
    .map(entry => ({
      from: entry.from,
      to: entry.to,
      count: entry.count,
      files: [...entry.files].sort(),
    }))
}

function auditSingletonState(texts) {
  const knownPatterns = [
    { id: 'ConfigManager.getInstance', pattern: /\bConfigManager\.getInstance\s*\(/g },
    { id: 'defaultContextBroadcaster', pattern: /\bdefaultContextBroadcaster\b/g },
    { id: 'defaultEverCoreRuntimeManager', pattern: /\bdefaultEverCoreRuntimeManager\b/g },
  ]

  return {
    known: knownPatterns.map(({ id, pattern }) => countPatternByFile(texts, id, pattern)),
    providerSessionRules: {
      status: 'injectable_service',
      moduleLevelMap: countPatternByFile(
        texts,
        'providerSessionRules module-level Map',
        /\b(?:const|let|var)\s+providerSessionRules\s*=\s*new\s+Map\b/g,
      ),
      references: countPatternByFile(texts, 'providerSessionRules references', /\bproviderSessionRules\b/g),
    },
  }
}

function countPatternByFile(texts, id, pattern) {
  const files = []
  let count = 0
  for (const [file, text] of texts.entries()) {
    const matches = [...text.matchAll(pattern)]
    if (matches.length === 0) continue
    count += matches.length
    files.push({ file, count: matches.length })
  }
  return { id, count, files: files.sort((left, right) => left.file.localeCompare(right.file)) }
}

function auditLargeFiles(texts) {
  const trackedHotspots = [
    'src/nexus/app.ts',
    'src/runtime/LLMCodingRuntime.ts',
    'src/runtime/runtimePipeline.ts',
    'src/runtime/runtimeToolLoop.ts',
    'src/shared/events.ts',
  ].map(file => ({
    file,
    lines: countLines(texts.get(file) ?? ''),
  }))

  const topSourceFiles = [...texts.entries()]
    .map(([file, text]) => ({ file, lines: countLines(text) }))
    .sort((left, right) => right.lines - left.lines || left.file.localeCompare(right.file))
    .slice(0, 15)

  return {
    trackedHotspots,
    topSourceFiles,
  }
}

function auditProcessConcentration(texts) {
  return [...texts.entries()]
    .map(([file, text]) => ({
      file,
      processEnvReads: countMatches(text, /\bprocess\.env\b/g),
      processCwdReads: countMatches(text, /\bprocess\.cwd\s*\(/g),
    }))
    .filter(entry => entry.processEnvReads > 0 || entry.processCwdReads > 0)
    .sort(
      (left, right) =>
        right.processEnvReads - left.processEnvReads ||
        right.processCwdReads - left.processCwdReads ||
        left.file.localeCompare(right.file),
    )
}

function layerFromFile(file) {
  const parts = file.split('/')
  return parts[0] === 'src' && parts[1] ? parts[1] : 'other'
}

function countLines(text) {
  if (text.length === 0) return 0
  return text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length
}

function countMatches(text, pattern) {
  return [...text.matchAll(pattern)].length
}

function normalizePath(filePath) {
  return filePath.split('\\').join('/')
}
