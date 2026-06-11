import type { ToolPolicy } from './LocalCodingRuntime.js'
import { allowAllTools, allowlistedTools } from './LocalCodingRuntime.js'

/**
 * Build the per-turn tool policy from a request-body `allowedTools`
 * field (Phase D of
 * docs/nexus/reference/go-tui-permission-policy-governance-plan.md).
 * Mirrors the server-startup policy resolution in
 * `createDefaultNexusRuntime` so the same wildcard semantics apply
 * (`*` or `all` → allowAllTools; anything else → allowlistedTools).
 *
 * The returned policy is meant to be passed to `runtime.withToolPolicy`
 * so the override is scoped to a single `executeStream` call; the
 * runtime's static policy is restored on iteration end.
 *
 * Lives in its own module (not in `LLMCodingRuntime.ts`) so that
 * `LocalCodingRuntime.ts` can import it without creating a circular
 * import (LLMCodingRuntime → LocalCodingRuntime for the policy
 * builders).
 */
export function buildPerRequestAllowedToolsPolicy(allowedTools: readonly string[]): ToolPolicy {
  const hasWildcard = allowedTools.some(t => {
    const norm = t.trim().toLowerCase()
    return norm === '*' || norm === 'all'
  })
  if (hasWildcard) {
    return allowAllTools()
  }
  return allowlistedTools(allowedTools)
}
