import { execFile } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import type { ToolDefinition } from '../Tool.js'

const execFileAsync = promisify(execFile)

const inputSchema = z.object({
  pattern: z.string().min(1),
  path: z.string().default('.'),
  maxMatches: z.number().int().positive().max(200).default(50),
})

export const grepTool: ToolDefinition<typeof inputSchema> = {
  name: 'Grep',
  description: 'Search file contents using ripgrep.',
  prompt: () => 'Grep is a content locator built on ripgrep. Supports full regex syntax. Use Grep to find candidate lines containing symbols, errors, or text inside files. Grep results are locator evidence only; use Read with offset/limit around relevant matches before making source-level claims. Use ListDir for directory inventory and Glob for path pattern discovery.',
  risk: 'read',
  inputSchema,
  async execute(input, context) {
    try {
      const probeLimit = input.maxMatches + 1
      const { stdout } = await execFileAsync(
        'rg',
        ['-n', '--max-count', String(probeLimit), input.pattern, input.path],
        {
          cwd: context.cwd,
          maxBuffer: 1_000_000,
          signal: context.signal,
        },
      )
      const lines = stdout.split('\n').filter(line => line.length > 0)
      if (lines.length > input.maxMatches) {
        const truncated = lines.slice(0, input.maxMatches).join('\n') + targetedGrepTruncationHint(input.maxMatches)
        return { success: true, output: truncated }
      }
      return { success: true, output: stdout }
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 1
      ) {
        return { success: true, output: '' }
      }
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        const output = await grepFallback(context.cwd, input.path, input.pattern, input.maxMatches)
        return { success: true, output }
      }
      throw error
    }
  },
}

function targetedGrepTruncationHint(maxMatches: number): string {
  return `\n... (${maxMatches} matches shown; more matches truncated for context budget. Narrow the pattern/path, then use Read with offset/limit around the relevant file lines.)`
}

async function grepFallback(
  cwd: string,
  searchPath: string,
  pattern: string,
  maxMatches: number,
): Promise<string> {
  const root = join(cwd, searchPath)
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
      const fullPath = join(path, entry.name)
      if (entry.isDirectory()) {
        await visit(fullPath)
      } else if (entry.isFile()) {
        await scanFile(fullPath)
      }
    }
  }

  async function scanFile(filePath: string): Promise<void> {
    if (results.length >= probeLimit) return
    let text = ''
    try {
      text = await readFile(filePath, 'utf8')
    } catch {
      return
    }
    const lines = text.split('\n')
    for (let index = 0; index < lines.length && results.length < probeLimit; index++) {
      if (matcher.test(lines[index]!)) {
        results.push(`${filePath}:${index + 1}:${lines[index]}`)
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
