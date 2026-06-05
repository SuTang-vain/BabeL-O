import { readFile, stat } from 'node:fs/promises'
import { z } from 'zod'
import type { ToolDefinition } from '../Tool.js'
import { resolveInsideWorkspace } from './pathSafety.js'

const DEFAULT_MAX_BYTES = 200_000
const LARGE_FILE_PREVIEW_BYTES = 50_000
const REPEAT_READ_DIAGNOSTIC_BYTES = 50_000
const MAX_READ_LEDGER_ENTRIES = 1_000

const readLedger = new Map<string, ReadLedgerEntry>()
const sessionReadCounts = new Map<string, number>()

type ReadLedgerEntry = {
  sessionId: string
  fileBytes: number
  ranges: ReadLedgerRange[]
}

type ReadLedgerRange = {
  start: number
  end: number
  lineStart: number
  lineEnd: number
  readIndex: number
  mode: 'auto' | 'full' | 'preview'
}

const inputSchema = z.object({
  path: z.string().min(1),
  maxBytes: z.number().int().positive().max(1_000_000).default(DEFAULT_MAX_BYTES),
  offset: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().max(1_000_000).optional(),
  mode: z.enum(['auto', 'full', 'preview']).default('auto'),
})

export const readTool: ToolDefinition<typeof inputSchema> = {
  name: 'Read',
  description: 'Read a text file inside the workspace.',
  prompt: () => 'Reads a text file inside the workspace. Use offset/limit for targeted ranges and mode="preview" for large files; default auto mode returns a preview with a follow-up range hint for large files instead of flooding context. Use full mode only when the user explicitly needs the whole file.',
  risk: 'read',
  inputSchema,
  async execute(input, context) {
    const path = resolveInsideWorkspace(context.cwd, input.path, context.allowedPaths)
    let fileStat
    try {
      fileStat = await stat(path)
    } catch (err) {
      const code = typeof err === 'object' && err !== null && 'code' in err
        ? String((err as { code?: unknown }).code)
        : ''
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return {
          success: false,
          output: `Read could not find "${input.path}". Check the path or use Glob to discover available files.`,
        }
      }
      throw err
    }
    if (fileStat.isDirectory()) {
      return {
        success: false,
        output: `Read expected a file but "${input.path}" is a directory. Use Glob to list files or Read a specific file path inside it.`,
      }
    }
    if (!fileStat.isFile()) {
      return {
        success: false,
        output: `Read expected a regular file but "${input.path}" is not a file.`,
      }
    }
    const file = await readFile(path)
    const start = input.offset ?? 0
    const requestedBytes = input.limit ?? input.maxBytes
    const shouldPreview = input.mode === 'preview' || (input.mode === 'auto' && input.offset === undefined && input.limit === undefined && file.length > input.maxBytes)
    const readBytes = shouldPreview
      ? Math.min(LARGE_FILE_PREVIEW_BYTES, input.maxBytes, file.length)
      : input.mode === 'full' && input.offset === undefined && input.limit === undefined
        ? Math.min(file.length, input.maxBytes)
        : Math.min(requestedBytes, input.maxBytes, Math.max(0, file.length - start))
    const end = Math.min(file.length, start + readBytes)
    const lineRange = byteLineRange(file, start, end)
    const repeated = repeatedLargeReadDiagnostic({
      sessionId: context.sessionId,
      path: input.path,
      resolvedPath: path,
      fileBytes: file.length,
      start,
      end,
      lineStart: lineRange.start,
      lineEnd: lineRange.end,
      input,
      shouldPreview,
    })
    if (repeated) return repeated
    const output = file.subarray(start, end).toString('utf8')
    recordReadLedgerRange({
      sessionId: context.sessionId,
      resolvedPath: path,
      fileBytes: file.length,
      start,
      end,
      lineStart: lineRange.start,
      lineEnd: lineRange.end,
      mode: input.mode,
    })

    if (shouldPreview) {
      const remainingBytes = Math.max(0, file.length - end)
      return {
        success: true,
        output: [
          `<read-preview path="${input.path}" bytes="${file.length}" shown="${end - start}" remaining="${remainingBytes}">`,
          output,
          '</read-preview>',
          `Use Read with offset=${end} and limit=${Math.min(input.maxBytes, LARGE_FILE_PREVIEW_BYTES)} for the next range, or use Grep/Glob to target symbols before reading more.`,
        ].join('\n'),
      }
    }

    if (end < file.length) {
      return {
        success: true,
        output: [
          output,
          `\n<read-truncated path="${input.path}" bytes="${file.length}" shownRange="${start}-${end}">Use Read with offset=${end} and limit=${Math.min(input.maxBytes, requestedBytes)} to continue.</read-truncated>`,
        ].join(''),
      }
    }

    return {
      success: true,
      output,
    }
  },
}

function repeatedLargeReadDiagnostic(options: {
  sessionId: string
  path: string
  resolvedPath: string
  fileBytes: number
  start: number
  end: number
  lineStart: number
  lineEnd: number
  input: z.infer<typeof inputSchema>
  shouldPreview: boolean
}): { success: true; output: string } | undefined {
  if (options.fileBytes < REPEAT_READ_DIAGNOSTIC_BYTES) return undefined
  if (options.input.offset !== undefined || options.input.limit !== undefined) return undefined
  const entry = readLedger.get(readLedgerKey(options.sessionId, options.resolvedPath))
  if (!entry) return undefined
  const overlapping = entry.ranges.find(range => rangesOverlap(range, options.start, options.end))
  if (!overlapping) return undefined

  const nextOffset = Math.min(overlapping.end, options.fileBytes)
  const nextLimit = Math.min(options.input.maxBytes, LARGE_FILE_PREVIEW_BYTES, Math.max(0, options.fileBytes - nextOffset))
  const rangeHint = nextLimit > 0
    ? `Use Read with offset=${nextOffset} and limit=${nextLimit} for the next unread range.`
    : 'The previously read range reached the end of this file.'
  const modeHint = options.shouldPreview
    ? 'This large file was already previewed in this session.'
    : 'This large file was already read in this session.'

  return {
    success: true,
    output: [
      `<read-repeat path="${options.path}" bytes="${options.fileBytes}" previousRange="${overlapping.start}-${overlapping.end}" previousLines="${overlapping.lineStart}-${overlapping.lineEnd}" currentLines="${options.lineStart}-${options.lineEnd}" lastReadIndex="${overlapping.readIndex}">`,
      modeHint,
      `Previously read byte range ${overlapping.start}-${overlapping.end}, lines ${overlapping.lineStart}-${overlapping.lineEnd}, at session read #${overlapping.readIndex}.`,
      rangeHint,
      'Use Grep to search for symbols/errors before reading more, or Glob to confirm related file paths.',
      'Use mode="full" with an explicit offset/limit only if the user needs this exact range again.',
      '</read-repeat>',
    ].join('\n'),
  }
}

function recordReadLedgerRange(options: {
  sessionId: string
  resolvedPath: string
  fileBytes: number
  start: number
  end: number
  lineStart: number
  lineEnd: number
  mode: 'auto' | 'full' | 'preview'
}): void {
  const key = readLedgerKey(options.sessionId, options.resolvedPath)
  const entry = readLedger.get(key) ?? { sessionId: options.sessionId, fileBytes: options.fileBytes, ranges: [] }
  entry.fileBytes = options.fileBytes
  entry.ranges.push({
    start: options.start,
    end: options.end,
    lineStart: options.lineStart,
    lineEnd: options.lineEnd,
    readIndex: nextSessionReadIndex(options.sessionId),
    mode: options.mode,
  })
  readLedger.set(key, entry)
  trimReadLedger()
}

function rangesOverlap(range: ReadLedgerRange, start: number, end: number): boolean {
  return start < range.end && end > range.start
}

function byteLineRange(file: Buffer, start: number, end: number): { start: number; end: number } {
  let line = 1
  let lineStart = 1
  let lineEnd = 1
  const clampedStart = Math.max(0, Math.min(start, file.length))
  const clampedEnd = Math.max(clampedStart, Math.min(end, file.length))
  for (let index = 0; index < clampedEnd; index += 1) {
    if (index === clampedStart) lineStart = line
    if (file[index] === 10) line += 1
  }
  lineEnd = line
  return { start: lineStart, end: lineEnd }
}

function nextSessionReadIndex(sessionId: string): number {
  const next = (sessionReadCounts.get(sessionId) ?? 0) + 1
  sessionReadCounts.set(sessionId, next)
  return next
}

function readLedgerKey(sessionId: string, resolvedPath: string): string {
  return `${sessionId}:${resolvedPath}`
}

function trimReadLedger(): void {
  while (readLedger.size > MAX_READ_LEDGER_ENTRIES) {
    const first = readLedger.keys().next().value
    if (!first) return
    readLedger.delete(first)
  }
}
