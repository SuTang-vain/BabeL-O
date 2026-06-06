import * as fs from 'node:fs'
import * as path from 'node:path'
import { performance } from 'node:perf_hooks'

export const LSP_CONTEXT_INDEX_LIMIT = 10_000
export const LSP_CONTEXT_RESULT_LIMIT = 50
const DEFAULT_SCAN_BUDGET_MS = 120
const MAX_FILE_BYTES = 512 * 1024

type LspContextMentionKind = 'symbol' | 'diagnostic'

type WorkspaceLspContextIndexOptions = {
  maxEntries?: number
  scanBudgetMs?: number
  maxDepth?: number
}

export type LspSymbolEntry = {
  kind: 'class' | 'const' | 'enum' | 'function' | 'interface' | 'method' | 'type'
  name: string
  path: string
  line: number
}

export type LspDiagnosticEntry = {
  severity: 'hint' | 'warning' | 'error'
  code: string
  message: string
  path: string
  line: number
}

type LspContextEntries = {
  symbols: LspSymbolEntry[]
  diagnostics: LspDiagnosticEntry[]
}

type LspContextMentionCompletion = {
  hits: string[]
  substring: string
}

export class WorkspaceLspContextIndex {
  private entries?: LspContextEntries
  private readonly maxEntries: number
  private readonly scanBudgetMs: number
  private readonly maxDepth: number

  constructor(private readonly cwd: string, options: WorkspaceLspContextIndexOptions = {}) {
    this.maxEntries = options.maxEntries ?? LSP_CONTEXT_INDEX_LIMIT
    this.scanBudgetMs = options.scanBudgetMs ?? DEFAULT_SCAN_BUDGET_MS
    this.maxDepth = options.maxDepth ?? 8
  }

  get built(): boolean {
    return this.entries !== undefined
  }

  get symbolCount(): number {
    return this.entries?.symbols.length ?? 0
  }

  get diagnosticCount(): number {
    return this.entries?.diagnostics.length ?? 0
  }

  completeSymbols(query: string, maxResults = LSP_CONTEXT_RESULT_LIMIT): string[] {
    const normalizedQuery = normalizeQuery(query)
    return this.getEntries().symbols
      .filter(entry => matchesSymbol(entry, normalizedQuery))
      .sort((left, right) => compareSymbols(left, right, normalizedQuery))
      .slice(0, maxResults)
      .map(entry => `@symbol:${entry.path}#${entry.name}`)
  }

  completeDiagnostics(query: string, maxResults = LSP_CONTEXT_RESULT_LIMIT): string[] {
    const normalizedQuery = normalizeQuery(query)
    return this.getEntries().diagnostics
      .filter(entry => matchesDiagnostic(entry, normalizedQuery))
      .sort((left, right) => compareDiagnostics(left, right, normalizedQuery))
      .slice(0, maxResults)
      .map(entry => `@diagnostic:${entry.path}:${entry.line}`)
  }

  private getEntries(): LspContextEntries {
    if (!this.entries) this.entries = buildLspContextEntries(this.cwd, {
      maxEntries: this.maxEntries,
      scanBudgetMs: this.scanBudgetMs,
      maxDepth: this.maxDepth,
    })
    return this.entries
  }
}

export function completeLspContextMention(
  line: string,
  cwd: string,
  index = new WorkspaceLspContextIndex(cwd),
): LspContextMentionCompletion | undefined {
  const token = currentToken(line)
  if (!token || looksLikeUrl(token)) return undefined

  const mention = parseLspContextMention(token)
  if (!mention) return undefined

  const hits = mention.kind === 'symbol'
    ? index.completeSymbols(mention.query)
    : index.completeDiagnostics(mention.query)
  return { hits, substring: token }
}

function buildLspContextEntries(cwd: string, options: Required<WorkspaceLspContextIndexOptions>): LspContextEntries {
  const symbols: LspSymbolEntry[] = []
  const diagnostics: LspDiagnosticEntry[] = []
  const startedAt = performance.now()
  const stack: Array<{ absPath: string; relPath: string; depth: number }> = [{ absPath: cwd, relPath: '', depth: 0 }]

  while (stack.length > 0 && symbols.length + diagnostics.length < options.maxEntries) {
    if (performance.now() - startedAt > options.scanBudgetMs) break
    const current = stack.pop()!
    let dirEntries: fs.Dirent[]
    try {
      dirEntries = fs.readdirSync(current.absPath, { withFileTypes: true })
    } catch {
      continue
    }

    dirEntries.sort((left, right) => right.name.localeCompare(left.name))
    for (const entry of dirEntries) {
      if (symbols.length + diagnostics.length >= options.maxEntries) break
      if (performance.now() - startedAt > options.scanBudgetMs) break
      if (entry.isSymbolicLink()) continue

      const relPath = joinRelativePath(current.relPath, entry.name)
      const absPath = path.join(current.absPath, entry.name)
      if (entry.isDirectory()) {
        if (current.depth < options.maxDepth && shouldDescendDirectory(entry.name)) {
          stack.push({ absPath, relPath, depth: current.depth + 1 })
        }
      } else if (entry.isFile() && isCodeFile(entry.name)) {
        collectFileEntries(absPath, relPath, symbols, diagnostics, options.maxEntries)
      }
    }
  }

  return {
    symbols: symbols.sort((left, right) => left.path.localeCompare(right.path) || left.line - right.line),
    diagnostics: diagnostics.sort((left, right) => left.path.localeCompare(right.path) || left.line - right.line),
  }
}

function collectFileEntries(
  absPath: string,
  relPath: string,
  symbols: LspSymbolEntry[],
  diagnostics: LspDiagnosticEntry[],
  maxEntries: number,
): void {
  let stat: fs.Stats
  try {
    stat = fs.statSync(absPath)
  } catch {
    return
  }
  if (stat.size > MAX_FILE_BYTES) return

  let text = ''
  try {
    text = fs.readFileSync(absPath, 'utf8')
  } catch {
    return
  }

  const lines = text.split('\n')
  for (let index = 0; index < lines.length && symbols.length + diagnostics.length < maxEntries; index++) {
    const line = lines[index]!
    const lineNumber = index + 1
    const symbol = parseSymbol(line, relPath, lineNumber)
    if (symbol) symbols.push(symbol)
    const diagnostic = parseDiagnostic(line, relPath, lineNumber)
    if (diagnostic) diagnostics.push(diagnostic)
  }
}

function parseSymbol(line: string, filePath: string, lineNumber: number): LspSymbolEntry | undefined {
  const patterns: Array<{ kind: LspSymbolEntry['kind']; regex: RegExp }> = [
    { kind: 'class', regex: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)\b/u },
    { kind: 'interface', regex: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)\b/u },
    { kind: 'type', regex: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\b/u },
    { kind: 'enum', regex: /^\s*(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)\b/u },
    { kind: 'function', regex: /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\b/u },
    { kind: 'const', regex: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::|=)/u },
    { kind: 'function', regex: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)\s*\(/u },
    { kind: 'type', regex: /^\s*type\s+([A-Za-z_][\w]*)\s+(?:struct|interface)\b/u },
    { kind: 'const', regex: /^\s*(?:const|var)\s+([A-Za-z_][\w]*)\b/u },
    { kind: 'method', regex: /^\s*(?:public\s+|private\s+|protected\s+|static\s+|async\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::|\{)/u },
  ]

  for (const pattern of patterns) {
    const match = pattern.regex.exec(line)
    const name = match?.[1]
    if (name && !isControlKeyword(name)) {
      return { kind: pattern.kind, name, path: filePath, line: lineNumber }
    }
  }
  return undefined
}

function parseDiagnostic(line: string, filePath: string, lineNumber: number): LspDiagnosticEntry | undefined {
  const marker = /(TODO|FIXME|XXX|@ts-expect-error|@ts-ignore|eslint-disable(?:-next-line)?|<<<<<<<|=======|>>>>>>>)\b\s*:?(.*)$/iu.exec(line)
  const code = marker?.[1]
  if (!code) return undefined
  return {
    severity: diagnosticSeverity(code),
    code,
    message: (marker[2] ?? '').trim(),
    path: filePath,
    line: lineNumber,
  }
}

function parseLspContextMention(token: string): { kind: LspContextMentionKind; query: string } | undefined {
  const normalized = token.toLowerCase()
  if (normalized.startsWith('@symbol:')) return { kind: 'symbol', query: token.slice('@symbol:'.length) }
  if (normalized.startsWith('@sym:')) return { kind: 'symbol', query: token.slice('@sym:'.length) }
  if (normalized.startsWith('@diagnostic:')) return { kind: 'diagnostic', query: token.slice('@diagnostic:'.length) }
  if (normalized.startsWith('@diag:')) return { kind: 'diagnostic', query: token.slice('@diag:'.length) }
  return undefined
}

function currentToken(line: string): string {
  const match = /(?:^|\s)(\S*)$/u.exec(line)
  return match?.[1] ?? ''
}

function looksLikeUrl(token: string): boolean {
  return /^[a-z][a-z\d+.-]*:\/\//iu.test(token)
}

function isCodeFile(name: string): boolean {
  return /\.(?:cjs|cts|go|js|jsx|mjs|mts|ts|tsx)$/u.test(name)
}

function shouldDescendDirectory(name: string): boolean {
  return !new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.next', '.turbo', '.cache']).has(name)
}

function joinRelativePath(base: string, name: string): string {
  return base ? `${base}/${name}` : name
}

function normalizeQuery(query: string): string {
  return query.trim().toLowerCase()
}

function matchesSymbol(entry: LspSymbolEntry, query: string): boolean {
  if (query.length === 0) return true
  const name = entry.name.toLowerCase()
  const fullPath = entry.path.toLowerCase()
  return name.includes(query) || fullPath.includes(query) || entry.kind.includes(query) || isSubsequence(query, name)
}

function compareSymbols(left: LspSymbolEntry, right: LspSymbolEntry, query: string): number {
  const rankCmp = symbolRank(left, query) - symbolRank(right, query)
  if (rankCmp !== 0) return rankCmp
  const nameCmp = left.name.localeCompare(right.name)
  if (nameCmp !== 0) return nameCmp
  const pathCmp = left.path.localeCompare(right.path)
  if (pathCmp !== 0) return pathCmp
  return left.line - right.line
}

function symbolRank(entry: LspSymbolEntry, query: string): number {
  if (query.length === 0) return 4
  const name = entry.name.toLowerCase()
  const fullPath = entry.path.toLowerCase()
  if (name === query) return 0
  if (name.startsWith(query)) return 1
  if (fullPath.startsWith(query)) return 2
  if (name.includes(query)) return 3
  if (fullPath.includes(query)) return 4
  return 5
}

function matchesDiagnostic(entry: LspDiagnosticEntry, query: string): boolean {
  if (query.length === 0) return true
  const haystack = `${entry.severity} ${entry.code} ${entry.message} ${entry.path}`.toLowerCase()
  return haystack.includes(query) || isSubsequence(query, entry.code.toLowerCase())
}

function compareDiagnostics(left: LspDiagnosticEntry, right: LspDiagnosticEntry, query: string): number {
  const rankCmp = diagnosticRank(left, query) - diagnosticRank(right, query)
  if (rankCmp !== 0) return rankCmp
  const severityCmp = diagnosticSeverityRank(left.severity) - diagnosticSeverityRank(right.severity)
  if (severityCmp !== 0) return severityCmp
  const pathCmp = left.path.localeCompare(right.path)
  if (pathCmp !== 0) return pathCmp
  return left.line - right.line
}

function diagnosticRank(entry: LspDiagnosticEntry, query: string): number {
  if (query.length === 0) return 4
  const code = entry.code.toLowerCase()
  const fullPath = entry.path.toLowerCase()
  if (code === query) return 0
  if (code.startsWith(query)) return 1
  if (fullPath.startsWith(query)) return 2
  if (entry.message.toLowerCase().includes(query)) return 3
  if (fullPath.includes(query)) return 4
  return 5
}

function diagnosticSeverity(code: string): LspDiagnosticEntry['severity'] {
  const normalized = code.toLowerCase()
  if (normalized.includes('ts-ignore') || normalized.includes('<<<<<<<') || normalized.includes('=======') || normalized.includes('>>>>>>>')) return 'error'
  if (normalized === 'fixme' || normalized.includes('eslint-disable')) return 'warning'
  return 'hint'
}

function diagnosticSeverityRank(severity: LspDiagnosticEntry['severity']): number {
  if (severity === 'error') return 0
  if (severity === 'warning') return 1
  return 2
}

function isSubsequence(query: string, text: string): boolean {
  let queryIndex = 0
  for (const char of text) {
    if (char === query[queryIndex]) queryIndex += 1
    if (queryIndex === query.length) return true
  }
  return query.length === 0
}

function isControlKeyword(name: string): boolean {
  return new Set(['if', 'for', 'while', 'switch', 'catch', 'function']).has(name)
}
