import {
  createEverOSBootstrapState,
  readEverOSBootstrapState,
  updateEverOSBootstrapState,
  type EverOSBootstrapState,
} from '../shared/everosBootstrapStore.js'
import {
  runEverOSMemorySetup,
  type EverOSSetupResult,
  type EverOSSetupOptions,
} from './everosBootstrap.js'

export const EVEROS_BACKGROUND_BOOTSTRAP_TIMEOUT_ENV = 'BABEL_O_EVERCORE_BOOTSTRAP_TIMEOUT_MS'
export const DEFAULT_EVEROS_BACKGROUND_TIMEOUT_MS = 120_000

export type EverOSBackgroundBootstrapOptions = EverOSSetupOptions & {
  /**
   * Maximum wall-clock time the background worker is allowed to
   * spend on clone + build. When exceeded the worker writes a
   * `failed` bootstrap state and resolves. Defaults to
   * `BABEL_O_EVERCORE_BOOTSTRAP_TIMEOUT_MS` or 120000ms.
   */
  timeoutMs?: number
  /**
   * Optional AbortSignal so callers (chat loop, memory command,
   * runtime manager) can cancel the worker on SIGINT / shutdown.
   */
  signal?: AbortSignal
}

export type EverOSBackgroundBootstrapHandle = {
  /**
   * Resolves with the final setup result. The promise never
   * rejects — failure is reported via `result.ok === false`.
   * Cancellation is also non-throwing; the result will have
   * `ok: false` and an `errorCode: 'EVEROS_BOOTSTRAP_BUILD_FAILED'`
   * (the existing `runEverOSMemorySetup` failure path) plus the
   * cancellation reason in `errorMessage`.
   */
  promise: Promise<EverOSSetupResult>
  /**
   * Programmatically cancel the worker. Safe to call multiple
   * times. After cancel, the bootstrap state is left as
   * `failed` with `errorMessage` describing the cancel.
   */
  cancel(reason?: string): void
  /**
   * `true` once the worker has settled (success, failure, or
   * cancel). Useful for tests and for "is it safe to dispose?"
   * checks during shutdown.
   */
  settled(): boolean
}

const CANCEL_ERROR_CODE = 'EVEROS_BOOTSTRAP_BUILD_FAILED'

/**
 * Fire-and-forget wrapper around `runEverOSMemorySetup`. The
 * worker respects the existing bootstrap file lock (so two
 * simultaneous `bbl` launches serialize correctly), honors an
 * optional timeout, and supports cancellation via AbortSignal
 * or the returned `cancel()` function.
 *
 * The returned promise is **non-throwing**: callers should branch
 * on `result.ok` rather than try/catch. This matches the existing
 * `runEverOSMemorySetup` contract and keeps the chat loop free of
 * background-error handling.
 */
export function startEverOSBackgroundBootstrap(
  options: EverOSBackgroundBootstrapOptions = {},
): EverOSBackgroundBootstrapHandle {
  const timeoutMs = readTimeoutMs(options.env) ?? options.timeoutMs ?? DEFAULT_EVEROS_BACKGROUND_TIMEOUT_MS
  const env = options.env ?? process.env
  const externalSignal = options.signal
  let cancelReason: string | undefined
  let isSettled = false
  const controller = new AbortController()

  const onExternalAbort = () => controller.abort(externalSignal?.reason)
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort(externalSignal.reason)
    } else {
      externalSignal.addEventListener('abort', onExternalAbort, { once: true })
    }
  }

  const cleanup = () => {
    if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort)
  }

  const promise = (async (): Promise<EverOSSetupResult> => {
    const timeoutHandle = setTimeout(() => {
      cancelReason = `Background bootstrap exceeded ${timeoutMs}ms timeout.`
      controller.abort(new Error(cancelReason))
    }, timeoutMs)
    timeoutHandle.unref?.()

    try {
      if (controller.signal.aborted) {
        return await markCancelledAndReturn(env, cancelReason ?? controller.signal.reason?.message ?? 'cancelled before start')
      }

      // Promise.race lets the timeout / cancel win even if the
      // inner `runEverOSMemorySetup` is hung on a never-resolving
      // runner. The inner promise is intentionally left dangling
      // in that case — the bootstrap file lock still serializes
      // any subsequent attempt, and the next `bbl` launch will
      // see the failure state. A future iteration can wire the
      // AbortSignal into the CommandRunner for true child-process
      // cancellation.
      const inner = runEverOSMemorySetup({ ...options, env })
      const setupResult = await Promise.race<EverOSSetupResult>([
        inner,
        new Promise<EverOSSetupResult>((_, reject) => {
          if (controller.signal.aborted) {
            reject(new Error(cancelReason ?? 'cancelled'))
            return
          }
          controller.signal.addEventListener('abort', () => {
            reject(new Error(cancelReason ?? 'cancelled'))
          }, { once: true })
        }),
      ])
      if (controller.signal.aborted) {
        return await markCancelledAndReturn(env, cancelReason ?? 'cancelled during run')
      }
      return setupResult
    } catch (error) {
      // Either the inner runEverOSMemorySetup threw (unexpected —
      // it is non-throwing by contract), or the AbortSignal rejected
      // the race. Both paths are reported as bootstrap failures
      // with a structured result so callers can branch on `ok`.
      const message = error instanceof Error ? error.message : String(error)
      return await markCancelledAndReturn(env, message || 'background bootstrap cancelled')
    } finally {
      clearTimeout(timeoutHandle)
      isSettled = true
      cleanup()
    }
  })()

  return {
    promise,
    cancel(reason?: string) {
      if (isSettled) return
      cancelReason = reason ?? 'cancelled by caller'
      controller.abort(new Error(cancelReason))
    },
    settled() {
      return isSettled
    },
  }
}

function readTimeoutMs(env: NodeJS.ProcessEnv | undefined): number | undefined {
  const raw = env?.[EVEROS_BACKGROUND_BOOTSTRAP_TIMEOUT_ENV]?.trim()
  if (!raw) return undefined
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined
  return Math.floor(parsed)
}

async function markCancelledAndReturn(env: NodeJS.ProcessEnv, reason: string): Promise<EverOSSetupResult> {
  let state: EverOSBootstrapState | undefined
  try {
    state = await updateEverOSBootstrapState(current => createEverOSBootstrapState({
      ...current,
      buildStatus: 'failed',
      lastCheckedAt: new Date().toISOString(),
      errorCode: CANCEL_ERROR_CODE,
      errorMessage: reason,
    }), { env })
  } catch {
    // best-effort; if the lock is busy or the state is invalid we
    // still need to resolve the caller.
  }
  return { ok: false, state, errorCode: CANCEL_ERROR_CODE, errorMessage: reason }
}

/**
 * Returns the latest bootstrap state if a background bootstrap
 * appears to still be in flight, otherwise `undefined`. Used by
 * the chat loop / TUI footer to show "bootstrapping…" instead of
 * the final result.
 */
export async function isEverOSBackgroundBootstrapInFlight(
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const read = await readEverOSBootstrapState({ env })
  if (!read.ok || !read.state) return false
  const status = read.state.buildStatus
  return status === 'checking_prereqs' || status === 'cloning' || status === 'building'
}
