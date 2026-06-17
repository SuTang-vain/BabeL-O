import { execFile } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { minimatch } from 'minimatch'
import { z } from 'zod'
import type { ToolDefinition } from '../Tool.js'

const execFileAsync = promisify(execFile)
const SYSTEM_RIPGREP_BINARY = 'rg'
const FORCE_RIPGREP_FALLBACK_ENV = 'BABEL_O_GREP_FORCE_FALLBACK'

const inputSchema = z.object({
  pattern: z.string().min(1),
  path: z.string().default('.'),
  pathMatches: z.union([z.string(), z.array(z.string()).max(20)]).optional(),
  maxMatches: z.number().int().positive().max(200).default(50),
})

export const grepTool: ToolDefinition<typeof inputSchema> = {
  name: 'Grep',
  description: 'Search file contents using ripgrep.',
  prompt: () => 'Grep is a content locator built on bundled ripgrep when available, then system rg, then JavaScript RegExp fallback. Supports full regex syntax through ripgrep and basic JavaScript regex fallback; use pathMatches for file glob filters such as "**/*.ts", or an array such as ["src/**/*.ts", "test/**/*.ts", "docs/**/*.md"] for multiple include globs. Do not repeat JSON keys. Use Grep to find candidate lines containing symbols, errors, or text inside files; prefer it over Bash grep, rg, or grep | head for ordinary source code search. Grep results are locator evidence only; use Read with lineOffset/lineLimit around relevant matches before making source-level claims. Use ListDir for directory inventory and Glob for path pattern discovery.',
  risk: 'read',
  inputSchema,
  async execute(input, context) {
    const pathMatchesDiagnostic = validatePathMatches(input.pathMatches)
    if (pathMatchesDiagnostic) return { success: false, output: pathMatchesDiagnostic }
    const pathMatches = normalizePathMatches(input.pathMatches)

    const probeLimit = input.maxMatches + 1
    const args = [
      '-n',
      '--max-count',
      String(probeLimit),
      ...pathMatches.flatMap(glob => ['--glob', glob]),
      '--',
      input.pattern,
      input.path,
    ]
    const ripgrepCandidates = await getRipgrepCandidates()

    for (const candidate of ripgrepCandidates) {
      try {
        const { stdout } = await execFileAsync(
          candidate,
          args,
          {
            cwd: context.cwd,
            maxBuffer: 1_000_000,
            signal: context.signal,
          },
        )
        return { success: true, output: formatRipgrepOutput(stdout, input.maxMatches) }
      } catch (error) {
        if (isRipgrepNoMatch(error)) return { success: true, output: '' }
        if (isCommandNotFound(error)) continue
        throw error
      }
    }

    const output = await grepFallback(context.cwd, input.path, input.pattern, input.maxMatches, pathMatches)
    return { success: true, output }
  },
}

async function getRipgrepCandidates(): Promise<string[]> {
  if (process.env[FORCE_RIPGREP_FALLBACK_ENV] === '1') return []

  const bundledRipgrepPath = await resolveBundledRipgrepPath()
  const candidates = [bundledRipgrepPath, SYSTEM_RIPGREP_BINARY]
    .filter((candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0)
  return Array.from(new Set(candidates))
}

async function resolveBundledRipgrepPath(): Promise<string | undefined> {
  try {
    const mod = await import('@vscode/ripgrep')
    return typeof mod.rgPath === 'string' && mod.rgPath.length > 0 ? mod.rgPath : undefined
  } catch {
    return undefined
  }
}

function formatRipgrepOutput(stdout: string, maxMatches: number): string {
  const lines = stdout.split('\n').filter(line => line.length > 0)
  if (lines.length > maxMatches) {
    return lines.slice(0, maxMatches).join('\n') + targetedGrepTruncationHint(maxMatches)
  }
  return stdout
}

function isRipgrepNoMatch(error: unknown): boolean {
  return isErrorWithCode(error, 1)
}

function isCommandNotFound(error: unknown): boolean {
  return isErrorWithCode(error, 'ENOENT')
}

function isErrorWithCode(error: unknown, code: string | number): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

function targetedGrepTruncationHint(maxMatches: number): string {
  return `\n... (${maxMatches} matches shown; more matches truncated for context budget. Narrow the pattern/path, then use Read with lineOffset/lineLimit around the relevant file lines.)`
}

function normalizePathMatches(pathMatches: string | string[] | undefined): string[] {
  if (pathMatches === undefined) return []
  return Array.isArray(pathMatches) ? pathMatches : [pathMatches]
}

function validatePathMatches(pathMatches: string | string[] | undefined): string | undefined {
  if (pathMatches === undefined) return undefined
  const invalid = normalizePathMatches(pathMatches).find(glob => {
    const normalized = glob.trim().toLowerCase()
    return normalized === 'true' || normalized === 'false'
  })
  if (invalid === undefined) return undefined
  return JSON.stringify({
    code: 'INVALID_GREP_PATH_MATCHES_GLOB',
    message: 'Grep pathMatches is a file glob filter, not a boolean. Omit pathMatches to search all files, use a glob such as "**/*.ts", or use an array such as ["src/**/*.ts", "test/**/*.ts"].',
    pathMatches,
  })
}

async function grepFallback(
  cwd: string,
  searchPath: string,
  pattern: string,
  maxMatches: number,
  pathMatches: string[],
): Promise<string> {
  const root = isAbsolute(searchPath) ? resolve(searchPath) : resolve(cwd, searchPath)
  const results: string[] = []
  const probeLimit = maxMatches + 1
  let matcher: RegExp
  try {
    matcher = new RegExp(pattern)
  } catch (error) {
    return grepFallbackInvalidRegexHint(pattern, error)
  }

  async function visit(path: string): Promise<void> {
    if (results.length >= probeLimit) return
    let entries
    try {
      entries = await readdir(path, { withFileTypes: true })
    } catch {
      await scanFile(path)
      return
    }

    for (const entry of entries) {
      if (results.length >= probeLimit) return
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      const fullPath = resolve(path, entry.name)
      if (entry.isDirectory()) {
        await visit(fullPath)
      } else if (entry.isFile()) {
        await scanFile(fullPath)
      }
    }
  }

  async function scanFile(filePath: string): Promise<void> {
    if (results.length >= probeLimit) return
    const displayPath = formatGrepPath(cwd, filePath)
    if (pathMatches.length > 0 && !pathMatches.some(glob => minimatch(displayPath, glob, { dot: true }))) return
    let text = ''
    try {
      text = await readFile(filePath, 'utf8')
    } catch {
      return
    }
    const lines = text.split('\n')
    for (let index = 0; index < lines.length && results.length < probeLimit; index++) {
      matcher.lastIndex = 0
      if (matcher.test(lines[index]!)) {
        results.push(`${displayPath}:${index + 1}:${lines[index]}`)
      }
    }
  }

  await visit(root)
  if (results.length > maxMatches) {
    return results.slice(0, maxMatches).join('\n') + targetedGrepTruncationHint(maxMatches) + grepFallbackModeHint()
  }
  if (results.length === 0) {
    return grepFallbackNoResultHint(searchPath)
  }
  return results.join('\n') + grepFallbackModeHint()
}

function formatGrepPath(cwd: string, filePath: string): string {
  const rel = relative(cwd, filePath)
  return rel && !rel.startsWith('..') ? rel : filePath
}

function grepFallbackModeHint(): string {
  return '\n[Grep fallback] ripgrep unavailable; used JavaScript RegExp scan with basic regex support. Grep results are locator-only evidence; use Read around relevant matches before source-level claims.'
}

function grepFallbackNoResultHint(searchPath: string): string {
  return `[Grep fallback] No matches found under ${formatGrepDiagnosticValue(searchPath)} using JavaScript RegExp fallback because ripgrep is unavailable. Treat this as fallback locator evidence, not a full-source proof; narrow the path/pattern or retry Grep when ripgrep is available before using broad shell search.`
}

function grepFallbackInvalidRegexHint(pattern: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return `[Grep fallback] ripgrep unavailable and fallback could not compile pattern ${formatGrepDiagnosticValue(pattern)} as JavaScript RegExp: ${message}. No search was performed; simplify the regex or retry Grep when ripgrep is available.`
}

function formatGrepDiagnosticValue(value: string): string {
  const normalized = value.replace(/\s+/g, ' ')
  const preview = normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized
  return JSON.stringify(preview)
}
