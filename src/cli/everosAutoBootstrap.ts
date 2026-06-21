import {
  parseAutoBootstrapPolicy,
  readEverOSBootstrapState,
  type EverOSBootstrapState,
} from '../shared/everosBootstrapStore.js'
import {
  inspectEverOSPrerequisites,
  type EverOSPrerequisiteReport,
} from '../runtime/everosPrerequisites.js'
import {
  startEverOSBackgroundBootstrap,
  type EverOSBackgroundBootstrapHandle,
} from '../runtime/everosBackgroundBootstrap.js'

/**
 * Reasons the runtime might (or might not) start a background
 * bootstrap. Used by the chat loop and `bbl run` to surface a
 * single-line stderr explanation when bootstrap is skipped.
 */
export type AutoBootstrapSkipReason =
  | 'policy_off'
  | 'state_ready'
  | 'state_opted_out'
  | 'state_external'
  | 'prereqs_missing'
  | 'in_flight'

export type AutoBootstrapDecision =
  | { attempt: true; reason: 'not_configured'; handle: EverOSBackgroundBootstrapHandle }
  | { attempt: true; reason: 'auto_retry_after_failure'; handle: EverOSBackgroundBootstrapHandle }
  | { attempt: false; reason: AutoBootstrapSkipReason; report?: EverOSPrerequisiteReport; state?: EverOSBootstrapState }

/**
 * Decide whether to start a background bootstrap on a cold start.
 *
 * Triggers:
 * - `BABEL_O_EVERCORE_AUTO_BOOTSTRAP=1` (or `=on`) in env
 * - `state.autoBootstrapPolicy === 'on'`
 *
 * Conditions that suppress:
 * - Explicit opt-out (`BABEL_O_EVERCORE_AUTO_BOOTSTRAP=0` or
 *   `state.autoBootstrapPolicy === 'off'`, or `optedOut: true`)
 * - `state.buildStatus` is `ready` / `opted_out` / `external`
 * - `state.buildStatus` is currently in-flight
 * - `state.buildStatus` is `failed` but prerequisites are still
 *   missing (no point retrying)
 *
 * The decision never throws; callers receive a structured
 * `AutoBootstrapDecision` they can log or ignore.
 */
export async function decideAutoBootstrap(input: {
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
}): Promise<AutoBootstrapDecision> {
  const env = input.env ?? process.env
  const read = await readEverOSBootstrapState({ env })
  if (!read.ok) {
    return { attempt: false, reason: 'prereqs_missing' }
  }

  const state = read.state
  const policy = parseAutoBootstrapPolicy({ env, state })

  if (state?.optedOut) {
    return { attempt: false, reason: 'state_opted_out', state }
  }
  if (state?.buildStatus === 'opted_out') {
    return { attempt: false, reason: 'state_opted_out', state }
  }
  if (state?.buildStatus === 'external') {
    return { attempt: false, reason: 'state_external', state }
  }
  if (state?.buildStatus === 'ready') {
    return { attempt: false, reason: 'state_ready', state }
  }
  if (
    state?.buildStatus === 'checking_prereqs' ||
    state?.buildStatus === 'cloning' ||
    state?.buildStatus === 'building'
  ) {
    return { attempt: false, reason: 'in_flight', state }
  }

  if (policy !== 'on') {
    return { attempt: false, reason: 'policy_off', state }
  }

  // Policy is `on`. Determine if we have a reason to attempt.
  const isFailed = state?.buildStatus === 'failed'
  const isUnconfigured = !state
  if (!isFailed && !isUnconfigured) {
    return { attempt: false, reason: 'policy_off', state }
  }

  const report = await inspectEverOSPrerequisites()
  if (!report.ok) {
    return { attempt: false, reason: 'prereqs_missing', report, state }
  }

  const handle = startEverOSBackgroundBootstrap({
    env,
    signal: input.signal,
    assumeYes: true,
    nonInteractive: true,
    autoInstallPrerequisites: false,
  })
  return {
    attempt: true,
    reason: isFailed ? 'auto_retry_after_failure' : 'not_configured',
    handle,
  }
}

/**
 * Convenience for CLI / chat loop: kick off a background bootstrap
 * if the policy says so, and return the handle (or undefined if
 * skipped). The caller is responsible for not awaiting the
 * background promise on the main path.
 */
export function maybeStartAutoBootstrap(input: {
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
} = {}): Promise<AutoBootstrapDecision> {
  return decideAutoBootstrap(input)
}
