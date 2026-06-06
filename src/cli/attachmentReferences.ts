import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ATTACHMENT_REFERENCE_FILE_BYTES_LIMIT = 64 * 1024
export const ATTACHMENT_REFERENCE_TOTAL_BYTES_LIMIT = 128 * 1024
export const ATTACHMENT_REFERENCE_LIMIT = 8

export type AttachmentReference = {
  token: string
  path: string
  kind: 'file' | 'directory' | 'missing' | 'outside-workspace' | 'binary' | 'image' | 'too-large'
  bytes?: number
  content?: string
  mimeType?: string
}

export type AttachmentReferenceExpansion = {
  prompt: string
  references: AttachmentReference[]
  appended: boolean
}

export type AttachmentReferenceExpansionOptions = {
  fileBytesLimit?: number
  totalBytesLimit?: number
  maxReferences?: number
}

export function expandAttachmentReferences(
  prompt: string,
  cwd: string,
  options: AttachmentReferenceExpansionOptions = {},
): AttachmentReferenceExpansion {
  const references = resolveAttachmentReferences(prompt, cwd, options)
  const block = formatAttachmentReferenceBlock(references)
  if (!block) return { prompt, references, appended: false }
  return {
    prompt: `${prompt.trimEnd()}\n\n${block}`,
    references,
    appended: true,
  }
}

export function resolveAttachmentReferences(
  prompt: string,
  cwd: string,
  options: AttachmentReferenceExpansionOptions = {},
): AttachmentReference[] {
  const fileBytesLimit = options.fileBytesLimit ?? ATTACHMENT_REFERENCE_FILE_BYTES_LIMIT
  const totalBytesLimit = options.totalBytesLimit ?? ATTACHMENT_REFERENCE_TOTAL_BYTES_LIMIT
  const maxReferences = options.maxReferences ?? ATTACHMENT_REFERENCE_LIMIT
  const tokens = extractAttachmentTokens(prompt).slice(0, maxReferences)
  const references: AttachmentReference[] = []
  let usedBytes = 0

  for (const token of tokens) {
    const parsed = parseAttachmentToken(token)
    if (!parsed) continue
    const resolved = resolveWorkspacePath(cwd, parsed.path)
    if (!resolved.insideWorkspace) {
      references.push({ token, path: resolved.path, kind: 'outside-workspace' })
      continue
    }

    let stat: fs.Stats
    try {
      stat = fs.statSync(resolved.path)
    } catch {
      references.push({ token, path: resolved.path, kind: 'missing' })
      continue
    }

    if (stat.isDirectory()) {
      references.push({ token, path: resolved.path, kind: 'directory' })
      continue
    }
    if (!stat.isFile()) continue
    const imageMimeType = imageMimeTypeForPath(resolved.path)
    if (imageMimeType) {
      references.push({ token, path: resolved.path, kind: 'image', bytes: stat.size, mimeType: imageMimeType })
      continue
    }
    if (isLikelyBinaryPath(resolved.path)) {
      references.push({ token, path: resolved.path, kind: 'binary', bytes: stat.size })
      continue
    }
    if (stat.size > fileBytesLimit || usedBytes + stat.size > totalBytesLimit) {
      references.push({ token, path: resolved.path, kind: 'too-large', bytes: stat.size })
      continue
    }

    let buffer: Buffer
    try {
      buffer = fs.readFileSync(resolved.path)
    } catch {
      references.push({ token, path: resolved.path, kind: 'missing' })
      continue
    }
    if (isLikelyBinaryBuffer(buffer)) {
      references.push({ token, path: resolved.path, kind: 'binary', bytes: buffer.byteLength })
      continue
    }

    usedBytes += buffer.byteLength
    references.push({
      token,
      path: resolved.path,
      kind: 'file',
      bytes: buffer.byteLength,
      content: buffer.toString('utf8'),
    })
  }

  return references
}

function formatAttachmentReferenceBlock(references: AttachmentReference[]): string {
  if (references.length === 0) return ''
  const lines = [
    '<attached_file_references>',
    'The user explicitly attached or referenced these workspace paths in the current prompt. Treat successful file attachments as user-provided context; inspect with Read before making source-level claims if exact line numbers or surrounding code matter.',
  ]

  for (const reference of references) {
    const rel = path.isAbsolute(reference.path) ? reference.path : reference.path
    if (reference.kind === 'file') {
      lines.push(`<file token="${escapeAttribute(reference.token)}" path="${escapeAttribute(rel)}" bytes="${reference.bytes ?? 0}">`)
      lines.push(reference.content ?? '')
      lines.push('</file>')
    } else {
      const bytes = reference.bytes === undefined ? '' : ` bytes="${reference.bytes}"`
      const mimeType = reference.mimeType === undefined ? '' : ` mimeType="${escapeAttribute(reference.mimeType)}"`
      lines.push(`<attachment token="${escapeAttribute(reference.token)}" path="${escapeAttribute(rel)}" status="${reference.kind}"${bytes}${mimeType} />`)
    }
  }

  lines.push('</attached_file_references>')
  return lines.join('\n')
}

function extractAttachmentTokens(prompt: string): string[] {
  const tokens: string[] = []
  const seen = new Set<string>()
  const pattern = /(?:^|\s)(?:(@(?:(?:file|image):)?(?:"[^"]+"|'[^']+'|[^\s`'"<>(){}\[\]，。！？；：、]+))|(file:\/\/[^\s`'"<>(){}\[\]，。！？；：、]+))/gu
  for (const match of prompt.matchAll(pattern)) {
    const token = match[1] ?? match[2]
    if (!token || seen.has(token)) continue
    if (isNonFileMention(token)) continue
    seen.add(token)
    tokens.push(token)
  }
  return tokens
}

function parseAttachmentToken(token: string): { path: string } | undefined {
  if (token.startsWith('file://')) {
    try {
      return { path: fileURLToPath(token) }
    } catch {
      return undefined
    }
  }
  if (!token.startsWith('@')) return undefined
  let raw = token.slice(1)
  const normalized = raw.toLowerCase()
  if (normalized.startsWith('file:')) raw = raw.slice('file:'.length)
  else if (normalized.startsWith('image:')) raw = raw.slice('image:'.length)
  raw = stripQuotes(raw)
  if (!raw || raw.startsWith('#')) return undefined
  if (raw.startsWith('file://')) {
    try {
      return { path: fileURLToPath(raw) }
    } catch {
      return undefined
    }
  }
  if (/^[a-z][a-z\d+.-]*:\/\//iu.test(raw)) return undefined
  return { path: raw }
}

function isNonFileMention(token: string): boolean {
  const normalized = token.toLowerCase()
  return normalized.startsWith('@symbol:') || normalized.startsWith('@sym:') ||
    normalized.startsWith('@diagnostic:') || normalized.startsWith('@diag:') ||
    normalized.slice(1).includes('@')
}

function stripQuotes(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1)
  }
  return value
}

function resolveWorkspacePath(cwd: string, candidate: string): { path: string; insideWorkspace: boolean } {
  const resolved = path.isAbsolute(candidate)
    ? path.resolve(candidate)
    : path.resolve(cwd, candidate)
  const relative = path.relative(cwd, resolved)
  return {
    path: resolved,
    insideWorkspace: relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)),
  }
}

function isLikelyBinaryPath(filePath: string): boolean {
  return /\.(?:mov|mp3|mp4|pdf|zip)$/iu.test(filePath)
}

function imageMimeTypeForPath(filePath: string): string | undefined {
  const ext = path.extname(filePath).toLowerCase()
  const mimeTypes: Record<string, string> = {
    '.avif': 'image/avif',
    '.bmp': 'image/bmp',
    '.gif': 'image/gif',
    '.heic': 'image/heic',
    '.ico': 'image/x-icon',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
  }
  return mimeTypes[ext]
}

function isLikelyBinaryBuffer(buffer: Buffer): boolean {
  if (buffer.length === 0) return false
  const sample = buffer.subarray(0, Math.min(buffer.length, 1024))
  if (sample.includes(0)) return true
  const decoded = sample.toString('utf8')
  return decoded.includes('�')
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}
