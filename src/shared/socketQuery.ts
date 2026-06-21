/**
 * Shared WebSocket query-string parser.
 *
 * PR-27: parse the query string on a WebSocket upgrade. Robust to
 * either shape produced by `@fastify/websocket`:
 *
 * 1. **Object form** — when the server has parsed the URL, the request
 *    exposes a `handshake.query` object keyed by query parameter name.
 *    String values are taken as-is; array values (when the same param
 *    appears multiple times, e.g. `?foo=1&foo=2`) take the first string
 *    element. Non-string / non-array values are silently dropped.
 *
 * 2. **Raw URL form** — when `handshake.query` is missing, fall back to
 *    parsing the raw `socket.url` query string. Standard URL decoding is
 *    applied; values without `=` get an empty string; missing query
 *    (no `?`) returns an empty object.
 *
 * Both shapes return a `Record<string, string | undefined>` so callers
 * can use `q.foo` directly without extra null guards (an undefined
 * value indicates the param was absent).
 *
 * This helper is pure (no Fastify imports, no I/O, no module state),
 * so it can be reused by the CLI TUI, by integration tests that build
 * a fake socket, and by any future WebSocket route that needs query
 * parameters from the upgrade request.
 */

/**
 * Minimal socket shape accepted by `parseSocketQuery`. The function
 * reads exactly two optional fields:
 *
 * - `handshake.query`: an already-parsed query object (preferred).
 * - `url`: the raw WebSocket URL (fallback).
 *
 * Defining a structural type here means this module can be imported
 * from `nexus/`, `cli/`, and tests without dragging in the full
 * `@fastify/websocket` Surface or any other runtime type.
 */
export type SocketLike = {
  url?: string
  handshake?: { query?: Record<string, unknown> }
}

/**
 * Parse a WebSocket upgrade's query string into a flat
 * `Record<string, string | undefined>`. Returns `{}` when neither
 * `handshake.query` nor `url` is present.
 */
export function parseSocketQuery(socket: SocketLike): Record<string, string | undefined> {
  const handshakeQuery = socket.handshake?.query
  if (handshakeQuery && typeof handshakeQuery === 'object') {
    const out: Record<string, string | undefined> = {}
    for (const [k, v] of Object.entries(handshakeQuery)) {
      if (typeof v === 'string') out[k] = v
      else if (Array.isArray(v) && typeof v[0] === 'string') out[k] = v[0]
    }
    return out
  }
  const url = socket.url
  if (typeof url !== 'string') return {}
  const qIdx = url.indexOf('?')
  if (qIdx < 0) return {}
  const out: Record<string, string | undefined> = {}
  const search = url.slice(qIdx + 1)
  for (const pair of search.split('&')) {
    if (!pair) continue
    const eq = pair.indexOf('=')
    if (eq < 0) {
      out[decodeURIComponent(pair)] = ''
    } else {
      const key = decodeURIComponent(pair.slice(0, eq))
      const val = decodeURIComponent(pair.slice(eq + 1))
      out[key] = val
    }
  }
  return out
}
