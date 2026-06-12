import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDefaultToolRegistry } from '../src/tools/registry.js'
import { LocalCodingRuntime } from '../src/runtime/LocalCodingRuntime.js'
import {
  NEXUS_EVENT_SCHEMA_VERSION,
  type NexusEvent,
} from '../src/shared/events.js'
import {
  cleanDuckDuckGoResultUrl,
  formatWebSearchResults,
  parseDuckDuckGoLiteResults,
  setWebSearchFetchForTest,
  webSearchTool,
} from '../src/tools/builtin/webSearch.js'

const liteHtml = `
<html>
  <body>
    <a rel="nofollow" class="result-link" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs%3Fa%3D1&amp;rut=abc">Example &amp; Docs</a>
    <td class="result-snippet">Official docs &amp; examples for the project.</td>
    <a class="result-link" href="https://example.org/release">Release Notes</a>
    <td class="result-snippet">Latest release information.</td>
    <a class="result-link" href="ftp://example.invalid/file">Non HTTP</a>
    <td class="result-snippet">Should be skipped.</td>
  </body>
</html>
`

test('parseDuckDuckGoLiteResults extracts titles, URLs, snippets, and positions', () => {
  const results = parseDuckDuckGoLiteResults(liteHtml, 10)

  assert.deepEqual(results, [
    {
      title: 'Example & Docs',
      url: 'https://example.com/docs?a=1',
      snippet: 'Official docs & examples for the project.',
      position: 1,
    },
    {
      title: 'Release Notes',
      url: 'https://example.org/release',
      snippet: 'Latest release information.',
      position: 2,
    },
  ])
})

test('parseDuckDuckGoLiteResults respects maxResults', () => {
  const results = parseDuckDuckGoLiteResults(liteHtml, 1)
  assert.equal(results.length, 1)
  assert.equal(results[0]?.title, 'Example & Docs')
})

test('cleanDuckDuckGoResultUrl unwraps uddg redirect links', () => {
  assert.equal(
    cleanDuckDuckGoResultUrl('//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%3Fx%3D1&rut=abc'),
    'https://example.com/a?x=1',
  )
})

test('formatWebSearchResults gives locator guidance', () => {
  const formatted = formatWebSearchResults('babel-o release', parseDuckDuckGoLiteResults(liteHtml, 1))
  assert.match(formatted, /Found 1 web search results/)
  assert.match(formatted, /URL: https:\/\/example.com\/docs\?a=1/)
  assert.match(formatted, /locator evidence/)
})

test('WebSearch is registered as a read-only builtin tool', () => {
  const registry = createDefaultToolRegistry()
  const tool = registry.get('WebSearch')

  assert.ok(tool)
  assert.equal(tool.risk, 'read')
  assert.equal(tool.source?.type ?? 'builtin', 'builtin')
  assert.match(tool.prompt?.() ?? '', /DuckDuckGo Lite/)
})

test('webSearchTool executes through injectable fetch without real network', async () => {
  let requestedUrl = ''
  const restore = setWebSearchFetchForTest(async input => {
    requestedUrl = String(input)
    return new Response(liteHtml, { status: 200, headers: { 'Content-Type': 'text/html' } })
  })

  try {
    const result = await webSearchTool.execute(
      { query: 'BabeL-O docs', maxResults: 2 },
      {
        cwd: '/workspace',
        sessionId: 'session-web-search-test',
        maxOutputBytes: 200_000,
        bashMaxBufferBytes: 1_000_000,
      },
    )

    assert.equal(result.success, true)
    assert.match(String(result.output), /Example & Docs/)
    assert.match(String(result.output), /Release Notes/)
    assert.match(requestedUrl, /lite\.duckduckgo\.com\/lite\/\?q=BabeL-O\+docs/)
  } finally {
    restore()
  }
})

test('webSearchTool returns a tool error when provider request fails', async () => {
  const restore = setWebSearchFetchForTest(async () => new Response('rate limited', { status: 429 }))

  try {
    const result = await webSearchTool.execute(
      { query: 'BabeL-O docs', maxResults: 2 },
      {
        cwd: '/workspace',
        sessionId: 'session-web-search-error-test',
        maxOutputBytes: 200_000,
        bashMaxBufferBytes: 1_000_000,
      },
    )

    assert.equal(result.success, false)
    assert.match(String(result.output), /HTTP 429/)
  } finally {
    restore()
  }
})

test('LocalCodingRuntime can execute WebSearch as a read-only tool without permission', async () => {
  const restore = setWebSearchFetchForTest(async () => new Response(liteHtml, { status: 200 }))
  const runtime = new LocalCodingRuntime(createDefaultToolRegistry())
  const events: NexusEvent[] = []

  try {
    for await (const event of runtime.executeStream({
      sessionId: 'session-web-search-runtime-test',
      requestId: 'req-web-search-runtime-test',
      cwd: '/workspace',
      prompt: 'WebSearch: {"query":"BabeL-O docs","maxResults":1}',
      model: 'local/test',
      budget: 1,
    })) {
      events.push(event)
    }
  } finally {
    restore()
  }

  assert.equal(events.some(event => event.type === 'permission_request'), false)
  assert.equal(events.some(event => event.type === 'tool_denied'), false)
  assert.ok(events.find(event => event.type === 'tool_started' && event.name === 'WebSearch'))
  const completed = events.find((event): event is Extract<NexusEvent, { type: 'tool_completed' }> => event.type === 'tool_completed' && event.name === 'WebSearch')
  assert.ok(completed)
  assert.equal(completed.schemaVersion, NEXUS_EVENT_SCHEMA_VERSION)
  assert.match(String(completed.output), /Example & Docs/)
})
