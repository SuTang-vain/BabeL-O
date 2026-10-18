/**
 * Local evaluation switch for the dynamic-context-compression study
 * (branch `eval/context-compression-toggle`, not intended for upstream).
 *
 * `BABEL_O_CONTEXT_COMPRESSION=off` disables the *lossy* compression
 * layers so the same runtime can be measured with them turned off:
 *
 *   1. auto compaction (summary-based history rewrite) — `compact.ts`
 *   2. microcompaction (dedupe + head/tail trim of large tool results)
 *   3. snip compaction (truncate old tool output slices)
 *   4. omitted-event summarization in `assembleContext`
 *
 * It deliberately does NOT disable the hard budget guard
 * (`selectRecentEvents` turn/event caps), which stays on in both arms so
 * the "off" arm is a realistic no-compression agent rather than a
 * guaranteed provider-context overflow.
 *
 * Default (unset / anything else) preserves stock behaviour.
 */
export function isContextCompressionEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = (env.BABEL_O_CONTEXT_COMPRESSION ?? '').trim().toLowerCase()
  if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') return false
  return true
}
