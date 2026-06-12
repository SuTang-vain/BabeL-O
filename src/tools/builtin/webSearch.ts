import { z } from 'zod'
import type { ToolDefinition } from '../Tool.js'

const DUCKDUCKGO_LITE_URL = 'https://lite.duckduckgo.com/lite/'
const DEFAULT_MAX_RESULTS = 10
const MAX_RESULTS = 20
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_RESPONSE_CHARS = 2_000_000

type WebSearchFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

const inputSchema = z.object({
  query: z.string().min(1),
  maxResults: z.number().int().positive().max(MAX_RESULTS).default(DEFAULT_MAX_RESULTS),
})

export type WebSearchResult = {
  title: string
  url: string
  snippet: string
  position: number
}

let fetchImpl: WebSearchFetch = globalThis.fetch.bind(globalThis)

export const webSearchTool: ToolDefinition<typeof inputSchema> = {
  name: 'WebSearch',
  description: 'Search the public web through DuckDuckGo Lite.',
  prompt: () => [
    'WebSearch is a read-only public web search tool backed by DuckDuckGo Lite.',
    'Use it when the task requires current external information, documentation discovery, release notes, or locating public web pages.',
    'Do not use WebSearch for local source-code inspection; use ListDir, Glob, Grep, and Read for workspace files.',
    'Results contain titles, URLs, and snippets only; treat them as locator evidence and cite/verify important claims from the linked source before relying on them.',
    'Keep queries specific and avoid sending secrets, private code, credentials, tokens, or confidential user data to the search provider.',
  ].join(' '),
  risk: 'read',
  inputSchema,
  async execute(input, context) {
    try {
      const results = await searchDuckDuckGoLite(input.query, input.maxResults, context.signal)
      return { success: true, output: formatWebSearchResults(input.query, results) }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        success: false,
        output: `WebSearch failed for ${formatDiagnosticValue(input.query)}: ${message}`,
      }
    }
  },
}

export function setWebSearchFetchForTest(nextFetch: WebSearchFetch): () => void {
  const previous = fetchImpl
  fetchImpl = nextFetch
  return () => {
    fetchImpl = previous
  }
}

export async function searchDuckDuckGoLite(
  query: string,
  maxResults = DEFAULT_MAX_RESULTS,
  signal?: AbortSignal,
): Promise<WebSearchResult[]> {
  const trimmedQuery = query.trim()
  if (!trimmedQuery) throw new Error('query is required')
  const limit = clampMaxResults(maxResults)
  const url = new URL(DUCKDUCKGO_LITE_URL)
  url.searchParams.set('q', trimmedQuery)

  const timeout = new AbortController()
  const timeoutId = setTimeout(() => timeout.abort(), DEFAULT_TIMEOUT_MS)
  const abortFromParent = () => timeout.abort()
  if (signal) {
    if (signal.aborted) timeout.abort()
    else signal.addEventListener('abort', abortFromParent, { once: true })
  }

  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      signal: timeout.signal,
      headers: {
        'User-Agent': 'BabeL-O WebSearch/0.3.3',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    })
    if (response.status !== 200 && response.status !== 202) {
      throw new Error(`search provider returned HTTP ${response.status}`)
    }
    const html = await response.text()
    if (html.length > MAX_RESPONSE_CHARS) {
      throw new Error(`search provider response exceeded ${MAX_RESPONSE_CHARS} characters`)
    }
    return parseDuckDuckGoLiteResults(html, limit)
  } finally {
    clearTimeout(timeoutId)
    signal?.removeEventListener('abort', abortFromParent)
  }
}

export function parseDuckDuckGoLiteResults(html: string, maxResults = DEFAULT_MAX_RESULTS): WebSearchResult[] {
  const limit = clampMaxResults(maxResults)
  const anchors = [...html.matchAll(/<a\b([^>]*class=["'][^"']*\bresult-link\b[^"']*["'][^>]*)>([\s\S]*?)<\/a>/gi)]
  const results: WebSearchResult[] = []

  for (let index = 0; index < anchors.length && results.length < limit; index += 1) {
    const anchor = anchors[index]!
    const attrs = anchor[1] ?? ''
    const href = attrs.match(/href=["']([^"']+)["']/i)?.[1]
    if (!href) continue

    const url = cleanDuckDuckGoResultUrl(decodeHtmlEntities(href))
    if (!isHttpUrl(url)) continue

    const title = normalizeText(stripTags(anchor[2] ?? ''))
    if (!title) continue

    const nextAnchor = anchors[index + 1]
    const searchEnd = nextAnchor?.index ?? html.length
    const between = html.slice((anchor.index ?? 0) + anchor[0].length, searchEnd)
    const snippetMatch = between.match(/<[^>]*class=["'][^"']*\bresult-snippet\b[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i)
    const snippet = snippetMatch ? normalizeText(stripTags(snippetMatch[1] ?? '')) : ''

    results.push({
      title,
      url,
      snippet,
      position: results.length + 1,
    })
  }

  return results
}

export function formatWebSearchResults(query: string, results: WebSearchResult[]): string {
  if (results.length === 0) {
    return `No web search results found for ${formatDiagnosticValue(query)}. Try a more specific query or different keywords.`
  }

  const lines = [`Found ${results.length} web search results for ${formatDiagnosticValue(query)}:`]
  for (const result of results) {
    lines.push('', `${result.position}. ${result.title}`, `   URL: ${result.url}`)
    if (result.snippet) lines.push(`   Summary: ${result.snippet}`)
  }
  lines.push('', 'Use these results as locator evidence; verify important claims from the linked pages before relying on them.')
  return lines.join('\n')
}

export function cleanDuckDuckGoResultUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl, 'https://duckduckgo.com')
    if (url.hostname.endsWith('duckduckgo.com') && url.pathname === '/l/' && url.searchParams.has('uddg')) {
      return url.searchParams.get('uddg') ?? rawUrl
    }
    return url.toString()
  } catch {
    return rawUrl
  }
}

function clampMaxResults(maxResults: number): number {
  if (!Number.isFinite(maxResults) || maxResults <= 0) return DEFAULT_MAX_RESULTS
  return Math.min(Math.trunc(maxResults), MAX_RESULTS)
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, '')
}

function normalizeText(value: string): string {
  return decodeHtmlEntities(value).replace(/\s+/g, ' ').trim()
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: '&',
    gt: '>',
    lt: '<',
    quot: '"',
    apos: "'",
    nbsp: ' ',
  }
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (_, entity: string) => {
    const lower = entity.toLowerCase()
    if (lower.startsWith('#x')) {
      const codePoint = Number.parseInt(lower.slice(2), 16)
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : `&${entity};`
    }
    if (lower.startsWith('#')) {
      const codePoint = Number.parseInt(lower.slice(1), 10)
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : `&${entity};`
    }
    return named[lower] ?? `&${entity};`
  })
}

function formatDiagnosticValue(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  const preview = normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized
  return JSON.stringify(preview)
}
