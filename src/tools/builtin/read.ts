import { readFile, stat } from 'node:fs/promises'
import { z } from 'zod'
import type { ToolDefinition } from '../Tool.js'
import { appendPathDriftGuidance, buildPathDriftDiagnostic } from './pathDrift.js'
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
  lineOffset: z.number().int().positive().optional(),
  lineLimit: z.number().int().positive().max(10_000).optional(),
  byteOffset: z.number().int().nonnegative().optional(),
  byteLimit: z.number().int().positive().max(1_000_000).optional(),
  offset: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().max(1_000_000).optional(),
  mode: z.enum(['auto', 'full', 'preview']).default('auto'),
})

export const readTool: ToolDefinition<typeof inputSchema> = {
  name: 'Read',
  description: 'Read a text file inside the workspace.',
  prompt: () => 'Read is the source-understanding tool for file contents. Use Read only after you know the file path. Use lineOffset/lineLimit for source or markdown line ranges. Use byteOffset/byteLimit only for binary-safe byte windows or continuation from a Read tag. mode="preview" is for large files. Deprecated offset/limit are byte aliases and must not be used for line numbers. Prefer Read over Bash cat, sed -n, head, or tail for ordinary source code reading. Use ListDir for directory inventory, Glob for pattern-based file discovery, and Grep for locating text before reading relevant ranges.',
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
          output: appendPathDriftGuidance(
            `Read could not find "${input.path}". Check the path or use Glob to discover available files.`,
            buildPathDriftDiagnostic({ cwd: context.cwd, requestedPath: input.path }),
          ),
        }
      }
      throw err
    }
    if (fileStat.isDirectory()) {
      return {
        success: false,
        output: `Read expected a file but "${input.path}" is a directory. Use ListDir for directory inventory or Read a specific file path inside it.`,
      }
    }
    if (!fileStat.isFile()) {
      return {
        success: false,
        output: `Read expected a regular file but "${input.path}" is not a file.`,
      }
    }
    const file = await readFile(path)
    const request = resolveReadRequest(file, input)
    if ('error' in request) {
      return request.error
    }
    const { start, requestedBytes, shouldPreview, diagnostics, sourceKind } = request
    const readBytes = shouldPreview
      ? Math.min(LARGE_FILE_PREVIEW_BYTES, input.maxBytes, file.length)
      : input.mode === 'full' && sourceKind === 'full-file'
        ? Math.min(file.length, input.maxBytes)
        : Math.min(requestedBytes, input.maxBytes, Math.max(0, file.length - start))
    const end = Math.min(file.length, start + readBytes)
    const lineRange = byteLineRange(file, start, end)
    const coverage = formatCoverageAttrs(input.path, file.length, start, end, lineRange)
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
          ...diagnostics,
          `<read-preview ${coverage} remaining="${remainingBytes}">`,
          output,
          '</read-preview>',
          `Use Read with byteOffset=${end} and byteLimit=${Math.min(input.maxBytes, LARGE_FILE_PREVIEW_BYTES)} for the next byte range, or use Grep/Glob to target symbols before reading relevant line ranges.`,
        ].join('\n'),
      }
    }

    if (end < file.length) {
      return {
        success: true,
        output: [
          ...diagnostics,
          output,
          `\n<read-truncated ${coverage}>Use Read with byteOffset=${end} and byteLimit=${Math.min(input.maxBytes, requestedBytes)} to continue by bytes, or lineOffset=${lineRange.end + 1} for the next source line range.</read-truncated>`,
        ].join('\n'),
      }
    }

    return {
      success: true,
      output: [...diagnostics, output].filter(Boolean).join('\n'),
    }
  },
}

type ReadInput = z.infer<typeof inputSchema>

type ResolvedReadRequest = {
  start: number
  requestedBytes: number
  shouldPreview: boolean
  diagnostics: string[]
  sourceKind: 'full-file' | 'line-range' | 'byte-range'
}

function resolveReadRequest(file: Buffer, input: ReadInput): ResolvedReadRequest | { error: { success: false; output: string } } {
  const hasLineRange = input.lineOffset !== undefined || input.lineLimit !== undefined
  const hasByteRange = input.byteOffset !== undefined || input.byteLimit !== undefined
  const hasDeprecatedRange = input.offset !== undefined || input.limit !== undefined
  if ([hasLineRange, hasByteRange, hasDeprecatedRange].filter(Boolean).length > 1) {
    return {
      error: {
        success: false,
        output: [
          'INVALID_READ_RANGE: choose exactly one range style.',
          'Use lineOffset/lineLimit for source or markdown line ranges.',
          'Use byteOffset/byteLimit for byte windows.',
          'Deprecated offset/limit are byte aliases and cannot be mixed with the explicit fields.',
        ].join('\n'),
      },
    }
  }
  const diagnostics = deprecatedOffsetLimitDiagnostics(input)
  if (hasLineRange) {
    const lineRange = lineByteRange(file, input.lineOffset ?? 1, input.lineLimit)
    return {
      start: lineRange.startByte,
      requestedBytes: Math.max(0, lineRange.endByte - lineRange.startByte),
      shouldPreview: false,
      diagnostics,
      sourceKind: 'line-range',
    }
  }
  const start = input.byteOffset ?? input.offset ?? 0
  const requestedBytes = input.byteLimit ?? input.limit ?? input.maxBytes
  const shouldPreview = input.mode === 'preview' ||
    (input.mode === 'auto' && !hasByteRange && !hasDeprecatedRange && file.length > input.maxBytes)
  return {
    start,
    requestedBytes,
    shouldPreview,
    diagnostics,
    sourceKind: hasByteRange || hasDeprecatedRange ? 'byte-range' : 'full-file',
  }
}

function deprecatedOffsetLimitDiagnostics(input: ReadInput): string[] {
  if (input.offset === undefined && input.limit === undefined) return []
  return [
    '<read-diagnostic code="DEPRECATED_OFFSET_LIMIT">offset/limit are deprecated byte aliases. Use lineOffset/lineLimit for source line ranges, or byteOffset/byteLimit for byte windows.</read-diagnostic>',
  ]
}

function lineByteRange(file: Buffer, lineOffset: number, lineLimit?: number): { startByte: number; endByte: number } {
  const startLine = Math.max(1, lineOffset)
  const endLineExclusive = lineLimit === undefined ? Number.POSITIVE_INFINITY : startLine + lineLimit
  let currentLine = 1
  let startByte = file.length
  let endByte = file.length
  for (let index = 0; index < file.length; index += 1) {
    if (currentLine === startLine && startByte === file.length) {
      startByte = index
    }
    if (currentLine >= endLineExclusive) {
      endByte = index
      return { startByte, endByte }
    }
    if (file[index] === 10) {
      currentLine += 1
      if (currentLine === startLine && startByte === file.length) {
        startByte = index + 1
      }
      if (currentLine >= endLineExclusive) {
        endByte = index + 1
        return { startByte, endByte }
      }
    }
  }
  if (startLine === 1 && startByte === file.length && file.length > 0) startByte = 0
  return { startByte, endByte }
}

function formatCoverageAttrs(path: string, fileBytes: number, start: number, end: number, lineRange: { start: number; end: number }): string {
  return `path="${escapeAttr(path)}" bytes="${fileBytes}" shownBytes="${start}-${end}" shownLines="${lineRange.start}-${lineRange.end}"`
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
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
    ? `Use Read with byteOffset=${nextOffset} and byteLimit=${nextLimit} for the next unread byte range, or lineOffset=${overlapping.lineEnd + 1} for the next source line range.`
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
      'Use mode="full" with explicit byteOffset/byteLimit only if the user needs this exact byte range again.',
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
  const clampedStart = Math.max(0, Math.min(start, file.length))
  const clampedEnd = Math.max(clampedStart, Math.min(end, file.length))
  const lineStart = lineNumberAtByte(file, clampedStart)
  const lastShownByte = clampedEnd > clampedStart ? clampedEnd - 1 : clampedStart
  const lineEnd = lineNumberAtByte(file, lastShownByte)
  return { start: lineStart, end: lineEnd }
}

function lineNumberAtByte(file: Buffer, byteIndex: number): number {
  const clamped = Math.max(0, Math.min(byteIndex, Math.max(0, file.length - 1)))
  let line = 1
  for (let index = 0; index < clamped; index += 1) {
    if (file[index] === 10) line += 1
  }
  return line
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
