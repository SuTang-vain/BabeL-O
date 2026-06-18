import { existsSync, lstatSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

import { extractAbsolutePaths } from './systemPromptBuilder.js'

// Phase B of docs/nexus/reference/context-cwd-drift-and-recall-governance-plan.md.
// Pure decision helper: given the request cwd, optional session metadata,
// and a prompt, decide what the effective cwd should be and *why*. The
// runtime is still the source of truth for what is eventually executed;
// this helper only projects a human-readable decision so the CLI can
// surface "why did cwd change?" without inventing any new persistence.
//
// The four decision values mirror plan §2 (SessionRootContinuity):
//   keep_request_cwd      — baseCwd wins; no real path candidates in prompt
//   use_prompt_path       — a real prompt path wins; it lives inside the
//                           project root, so the switch is safe
//   keep_session_root     — session metadata already pinned a primary root
//                           (or the request cwd is suspicious); prefer it
//   require_confirmation  — a real prompt path lives OUTSIDE the project
//                           root; runtime should NOT silently switch cwd.
//                           The runtime keeps baseCwd and records the
//                           external path as a candidate for the user to
//                           confirm later (task_scope_declared still runs).
//
// `reason` is a stable snake_case string; treat it as a contract for the
// CLI inspector and the eval harness.

export type SessionRootDecision =
  | 'keep_request_cwd'
  | 'use_prompt_path'
  | 'keep_session_root'
  | 'require_confirmation'

export type SessionRootReason =
  | 'no_paths_in_prompt'
  | 'cjk_prose_excluded'
  | 'url_excluded'
  | 'all_candidates_non_existent'
  | 'prompt_internal_path_inferred'
  | 'prompt_external_path_inferred'
  | 'session_primary_root_inherited'
  | 'stored_session_cwd_inherited'
  | 'base_cwd_fallback'

export interface SessionRootContinuity {
  requestCwd: string
  storedSessionCwd?: string
  latestTaskPrimaryRoot?: string
  promptPathCandidates: string[]
  resolvedCwd: string
  decision: SessionRootDecision
  reason: SessionRootReason
  // True iff the decision surfaced a path that lives OUTSIDE requestCwd
  // (e.g. iCloud article directory). Runtime callers should pass this to
  // task_scope_declared as an explicit candidate for user confirmation.
  isExternalRoot: boolean
  // True iff the resolved cwd equals requestCwd. Used by tests + CLI
  // rendering to phrase "project root kept" / "switched to X".
  wasProjectRootKept: boolean
  // Optional warning strings for the CLI (e.g. "prompt path X was
  // dropped by Phase A prose guard; relying on project root").
  warnings: string[]
}

export interface DeriveSessionRootContinuityOptions {
  requestCwd: string
  prompt: string
  storedSessionCwd?: string
  latestTaskPrimaryRoot?: string
  // When true, an external prompt path is accepted (cwd switches to it).
  // Default false: the runtime keeps requestCwd and emits
  // require_confirmation so the user / scope flow can decide.
  acceptExternalPromptPath?: boolean
}

function isWithinRoot(child: string, root: string): boolean {
  if (root === '/' || root === '.' || root === '') return true
  if (child === root) return true
  const rel = relative(root, child)
  return !rel.startsWith('..') && !isAbsolute(rel)
}

function pathExistsAsDirectory(p: string): boolean {
  try {
    return lstatSync(p).isDirectory()
  } catch {
    return false
  }
}

function pathExists(p: string): boolean {
  try {
    return lstatSync(p) !== undefined
  } catch {
    return false
  }
}

// Resolve a candidate to a directory (or its parent if it's a file), to
// match the existing `resolveCwdFromPrompt` behavior. We do NOT call
// `resolvePromptPath` here to keep the helper independent of the
// system-prompt-builder's longest-prefix-fallback heuristic — the
// helper is a *decision* projector, not a re-implementation.
function candidateToCwd(candidate: string): string | undefined {
  if (!isAbsolute(candidate)) return undefined
  if (pathExistsAsDirectory(candidate)) return candidate
  if (pathExists(candidate)) {
    const parent = dirname(candidate)
    if (parent !== candidate && pathExistsAsDirectory(parent)) return parent
  }
  return undefined
}

export function deriveSessionRootContinuity(
  options: DeriveSessionRootContinuityOptions,
): SessionRootContinuity {
  const requestCwd = resolve(options.requestCwd)
  const storedSessionCwd = options.storedSessionCwd
    ? resolve(options.storedSessionCwd)
    : undefined
  const latestTaskPrimaryRoot = options.latestTaskPrimaryRoot
    ? resolve(options.latestTaskPrimaryRoot)
    : undefined
  const acceptExternal = options.acceptExternalPromptPath ?? false

  const candidates = extractAbsolutePaths(options.prompt)
  const warnings: string[] = []
  // The "inherited" cwd is the session cwd we'd use if the prompt
  // doesn't override it. Order: latestTaskPrimaryRoot > storedSessionCwd
  // > requestCwd. We dedupe against requestCwd so a same-value session
  // cwd doesn't generate a noisy "kept session root" log.
  const inheritedCwd = latestTaskPrimaryRoot
    ?? storedSessionCwd
    ?? requestCwd
  const hasSessionOverride = inheritedCwd !== requestCwd
  // `sessionContextPresent` means the caller passed at least one of
  // storedSessionCwd / latestTaskPrimaryRoot. Used to label the
  // decision as keep_session_root when the inherited cwd happens to
  // match requestCwd (e.g. session was just created in this cwd).
  const sessionContextPresent = options.storedSessionCwd !== undefined
    || options.latestTaskPrimaryRoot !== undefined

  // Try each candidate in order. First *resolvable* candidate wins; the
  // decision is "use_prompt_path" or "require_confirmation" depending
  // on whether the resolved path lives inside the project root.
  let resolvedCwd: string | undefined
  let resolvedCandidate: string | undefined
  let isExternal = false
  let externalReason: SessionRootReason | undefined

  for (const rawCandidate of candidates) {
    const resolved = candidateToCwd(rawCandidate)
    if (!resolved) continue
    if (isWithinRoot(resolved, requestCwd)) {
      resolvedCwd = resolved
      resolvedCandidate = rawCandidate
      isExternal = false
      break
    }
    // external: keep the first external candidate as the surfaced one,
    // but do NOT switch cwd unless acceptExternal.
    if (!resolvedCandidate) {
      resolvedCandidate = rawCandidate
      isExternal = true
      externalReason = 'prompt_external_path_inferred'
    }
  }

  if (resolvedCwd && !isExternal) {
    return {
      requestCwd,
      storedSessionCwd,
      latestTaskPrimaryRoot,
      promptPathCandidates: candidates,
      resolvedCwd,
      decision: 'use_prompt_path',
      reason: 'prompt_internal_path_inferred',
      isExternalRoot: false,
      wasProjectRootKept: resolvedCwd === requestCwd,
      warnings,
    }
  }

  if (isExternal && resolvedCandidate) {
    if (acceptExternal) {
      // Caller has opted in (e.g. `bbl go` with --external-ok). Surface
      // the decision and switch.
      return {
        requestCwd,
        storedSessionCwd,
        latestTaskPrimaryRoot,
        promptPathCandidates: candidates,
        resolvedCwd: candidateToCwd(resolvedCandidate) ?? requestCwd,
        decision: 'use_prompt_path',
        reason: 'prompt_external_path_inferred',
        isExternalRoot: true,
        wasProjectRootKept: false,
        warnings: [
          `prompt surfaced an external path (${resolvedCandidate}); cwd switched because acceptExternalPromptPath=true`,
        ],
      }
    }
    // The safe default: keep requestCwd and require the user / scope
    // flow to confirm. The external candidate is recorded so the
    // task_scope_declared event can still list it as a candidate root.
    if (hasSessionOverride || sessionContextPresent) {
      // The session has a more authoritative cwd than the request —
      // prefer the session root, with the external candidate recorded
      // as a warning. (E.g. cf361f04: prompt pastes an iCloud article
      // path, but the session was created in BabeL-O project root.)
      warnings.push(
        `prompt surfaced an external path (${resolvedCandidate}); keeping session root ${inheritedCwd}`,
      )
      return {
        requestCwd,
        storedSessionCwd,
        latestTaskPrimaryRoot,
        promptPathCandidates: candidates,
        resolvedCwd: inheritedCwd,
        decision: 'keep_session_root',
        reason: inheritedCwd === latestTaskPrimaryRoot
          ? 'session_primary_root_inherited'
          : 'stored_session_cwd_inherited',
        isExternalRoot: true,
        wasProjectRootKept: inheritedCwd === requestCwd,
        warnings,
      }
    }
    warnings.push(
      `prompt surfaced an external path (${resolvedCandidate}); keeping request cwd ${requestCwd}`,
    )
    return {
      requestCwd,
      storedSessionCwd,
      latestTaskPrimaryRoot,
      promptPathCandidates: candidates,
      resolvedCwd: requestCwd,
      decision: 'require_confirmation',
      reason: externalReason ?? 'prompt_external_path_inferred',
      isExternalRoot: true,
      wasProjectRootKept: true,
      warnings,
    }
  }

  // No resolvable candidate path. Decide what reason to report.
  if (hasSessionOverride) {
    return {
      requestCwd,
      storedSessionCwd,
      latestTaskPrimaryRoot,
      promptPathCandidates: candidates,
      resolvedCwd: inheritedCwd,
      decision: 'keep_session_root',
      reason: inheritedCwd === latestTaskPrimaryRoot
        ? 'session_primary_root_inherited'
        : 'stored_session_cwd_inherited',
      isExternalRoot: false,
      wasProjectRootKept: inheritedCwd === requestCwd,
      warnings: candidates.length > 0
        ? [`prompt produced ${candidates.length} path candidate(s) but none were resolvable to a real path; keeping session root ${inheritedCwd}`]
        : [],
    }
  }

  if (candidates.length === 0) {
    // The Phase A / A Follow-up prose guard has eaten the prompt. We
    // can distinguish three sub-cases for the CLI:
    //   - prompt was pure CJK prose → cjk_prose_excluded
    //   - prompt contained a URL → url_excluded
    //   - prompt contained neither → no_paths_in_prompt
    const reason: SessionRootReason = hasLikelyUrl(options.prompt)
      ? 'url_excluded'
      : hasLikelyCjkProseSlash(options.prompt)
        ? 'cjk_prose_excluded'
        : 'no_paths_in_prompt'
    return {
      requestCwd,
      storedSessionCwd,
      latestTaskPrimaryRoot,
      promptPathCandidates: candidates,
      resolvedCwd: requestCwd,
      decision: 'keep_request_cwd',
      reason,
      isExternalRoot: false,
      wasProjectRootKept: true,
      warnings: [],
    }
  }

  return {
    requestCwd,
    storedSessionCwd,
    latestTaskPrimaryRoot,
    promptPathCandidates: candidates,
    resolvedCwd: requestCwd,
    decision: 'keep_request_cwd',
    reason: 'all_candidates_non_existent',
    isExternalRoot: false,
    wasProjectRootKept: true,
    warnings: candidates.length > 0
      ? [`prompt produced ${candidates.length} path candidate(s) but none were resolvable; keeping request cwd ${requestCwd}`]
      : [],
  }
}

function hasLikelyUrl(text: string): boolean {
  return /https?:\/\//i.test(text) || /(?:^|\s)\/\/[A-Za-z0-9.-]+/i.test(text)
}

function hasLikelyCjkProseSlash(text: string): boolean {
  return /[\p{Script=Han}]/u.test(text) && /\//.test(text)
}

// Re-export for tests / CLI inspection. Keep these as the single source
// of truth for the decision + reason vocabulary.
export const SESSION_ROOT_DECISIONS: readonly SessionRootDecision[] = [
  'keep_request_cwd',
  'use_prompt_path',
  'keep_session_root',
  'require_confirmation',
] as const

export const SESSION_ROOT_REASONS: readonly SessionRootReason[] = [
  'no_paths_in_prompt',
  'cjk_prose_excluded',
  'url_excluded',
  'all_candidates_non_existent',
  'prompt_internal_path_inferred',
  'prompt_external_path_inferred',
  'session_primary_root_inherited',
  'stored_session_cwd_inherited',
  'base_cwd_fallback',
] as const

// `sep` is intentionally re-exported so the test file doesn't need to
// re-import from `node:path` separately.
export { sep }

// Human-readable summary used by the runtime when emitting the
// `session_root_continuity` event. Stays short — the full structured
// fields are in the event; the message is for CLI / log greppability.
export function buildSessionRootContinuityMessage(c: SessionRootContinuity): string {
  if (c.decision === 'use_prompt_path' && c.isExternalRoot) {
    return `Session cwd switched to external prompt path ${c.resolvedCwd} (reason: ${c.reason}).`
  }
  if (c.decision === 'use_prompt_path') {
    return `Session cwd switched to prompt path ${c.resolvedCwd} (reason: ${c.reason}).`
  }
  if (c.decision === 'keep_session_root') {
    return `Session cwd kept at ${c.resolvedCwd} from session metadata (reason: ${c.reason}); prompt path ${c.promptPathCandidates[0] ?? '<none>'} was not promoted.`
  }
  if (c.decision === 'require_confirmation') {
    return `Session cwd kept at ${c.resolvedCwd} (request cwd); external prompt path ${c.promptPathCandidates[0] ?? '<none>'} requires confirmation.`
  }
  return `Session cwd kept at request cwd ${c.resolvedCwd} (reason: ${c.reason}).`
}
