import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseSocketQuery, type SocketLike } from '../src/shared/socketQuery.js'

/**
 * @fastify/websocket-style upgrade object with a parsed query map.
 * This is the canonical shape when the server has parsed the URL.
 */
function socketWithHandshakeQuery(query: Record<string, unknown>): SocketLike {
  return { handshake: { query } }
}

/**
 * Raw-URL fallback shape used when the server has not parsed the
 * query (older `ws` clients, manual handshakes, fake sockets in tests).
 */
function socketWithUrl(url: string): SocketLike {
  return { url }
}

test('parseSocketQuery returns parsed handshake.query when present', () => {
  const q = parseSocketQuery(socketWithHandshakeQuery({
    sessionId: 'abc-123',
    policy: 'strict',
  }))
  assert.equal(q.sessionId, 'abc-123')
  assert.equal(q.policy, 'strict')
})

test('parseSocketQuery takes the first element of array values from handshake.query', () => {
  // `?foo=1&foo=2` parsed by @fastify/websocket may produce ["1","2"].
  const q = parseSocketQuery(socketWithHandshakeQuery({
    foo: ['1', '2'],
  }))
  assert.equal(q.foo, '1')
})

test('parseSocketQuery drops non-string non-array values from handshake.query', () => {
  const q = parseSocketQuery(socketWithHandshakeQuery({
    good: 'kept',
    bad: 42,
    alsoBad: { nested: 'object' },
    nullVal: null,
    undefVal: undefined,
  }))
  assert.equal(q.good, 'kept')
  assert.equal(q.bad, undefined)
  assert.equal(q.alsoBad, undefined)
  assert.equal(q.nullVal, undefined)
  assert.equal(q.undefVal, undefined)
})

test('parseSocketQuery falls back to raw URL when handshake.query is missing', () => {
  const socket: SocketLike = { url: 'wss://example.com/v1/stream?sessionId=xyz&policy=strict' }
  const q = parseSocketQuery(socket)
  assert.equal(q.sessionId, 'xyz')
  assert.equal(q.policy, 'strict')
})

test('parseSocketQuery parses URL-encoded keys and values from raw URL', () => {
  // %20 (space), %2F (slash), %3A (colon) — all common in paths and
  // sessionId-style opaque tokens.
  const q = parseSocketQuery(socketWithUrl('wss://example.com/v1/stream?path=%2Ftmp%2Ffoo&token=abc%20def'))
  assert.equal(q.path, '/tmp/foo')
  assert.equal(q.token, 'abc def')
})

test('parseSocketQuery handles raw URL params without `=` (boolean-style flags)', () => {
  // `?dry-run` with no `=` should produce { 'dry-run': '' } per URL convention.
  const q = parseSocketQuery(socketWithUrl('wss://example.com/v1/stream?dry-run'))
  assert.equal(q['dry-run'], '')
})

test('parseSocketQuery handles raw URL with multiple `=` in a single value', () => {
  // Some tokens embed base64 with `=` padding — only the first `=` is
  // the key/value separator; the rest belong to the value.
  const q = parseSocketQuery(socketWithUrl('wss://example.com/v1/stream?t=YWJjPT0='))
  assert.equal(q.t, 'YWJjPT0=')
})

test('parseSocketQuery returns {} when raw URL has no `?`', () => {
  const q = parseSocketQuery(socketWithUrl('wss://example.com/v1/stream'))
  assert.deepEqual(q, {})
})

test('parseSocketQuery returns {} when socket has neither handshake nor url', () => {
  const q = parseSocketQuery({})
  assert.deepEqual(q, {})
})

test('parseSocketQuery returns {} when handshake.query is undefined and url is not a string', () => {
  // Defensive: a socket object with `handshake: {}` and no `url` must
  // not throw or return the wrong shape.
  const q = parseSocketQuery({ handshake: {} })
  assert.deepEqual(q, {})
})

test('parseSocketQuery prefers handshake.query over raw url (priority)', () => {
  // When both shapes are present, the parsed query wins. This protects
  // against the rare case where a caller accidentally passes both.
  const socket: SocketLike = {
    url: 'wss://example.com/v1/stream?source=url',
    handshake: { query: { source: 'handshake' } },
  }
  const q = parseSocketQuery(socket)
  assert.equal(q.source, 'handshake')
})

test('parseSocketQuery handles handshake.query with empty string value', () => {
  const q = parseSocketQuery(socketWithHandshakeQuery({ foo: '' }))
  assert.equal(q.foo, '')
})

test('parseSocketQuery handles raw URL with trailing empty pair', () => {
  // `?foo=bar&` produces a trailing empty pair which should be skipped
  // (not produce a key with empty name).
  const q = parseSocketQuery(socketWithUrl('wss://example.com/v1/stream?foo=bar&'))
  assert.equal(q.foo, 'bar')
  assert.deepEqual(Object.keys(q), ['foo'])
})

test('parseSocketQuery handles raw URL with consecutive `&`', () => {
  // `?foo=bar&&baz=qux` — the empty pair between the two `&` should
  // be silently skipped.
  const q = parseSocketQuery(socketWithUrl('wss://example.com/v1/stream?foo=bar&&baz=qux'))
  assert.equal(q.foo, 'bar')
  assert.equal(q.baz, 'qux')
})
