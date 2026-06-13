import type { ResolvedSettings } from '../shared/config.js'
import {
  configureEverCore,
  resolveEverCoreConfigInputFromEnv,
  type ConfiguredEverCore,
  type EverCoreConfigInput,
} from './everCoreConfig.js'

export type EverCoreRuntimeLease = ConfiguredEverCore & {
  release(): Promise<void>
}

type CacheEntry = {
  key: string
  value: ConfiguredEverCore
  refCount: number
  idleTimer?: ReturnType<typeof setTimeout>
}

export type EverCoreRuntimeManagerOptions = {
  idleTtlMs?: number
}

const DEFAULT_IDLE_TTL_MS = 5 * 60 * 1000

export class EverCoreRuntimeManager {
  private entry?: CacheEntry
  private readonly idleTtlMs: number

  constructor(
    private readonly configure: (input: EverCoreConfigInput) => Promise<ConfiguredEverCore> = configureEverCore,
    options: EverCoreRuntimeManagerOptions = {},
  ) {
    this.idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS
  }

  async acquire(input: EverCoreConfigInput = {}): Promise<EverCoreRuntimeLease> {
    const key = stableFingerprint(input)
    if (this.entry?.key === key && isReusableEverCore(this.entry.value)) {
      this.cancelIdleTimer(this.entry)
      this.entry.refCount += 1
      return this.createLease(this.entry)
    }

    if (this.entry && this.entry.refCount === 0) {
      await this.disposeEntry(this.entry)
      this.entry = undefined
    }

    if (this.entry?.refCount) {
      const uncached = await this.configure(input)
      const entry: CacheEntry = { key, value: uncached, refCount: 1 }
      return this.createLease(entry, { disposeOnRelease: true })
    }

    const value = await this.configure(input)
    this.entry = { key, value, refCount: 1 }
    return this.createLease(this.entry)
  }

  async acquireFromEnv(
    env: NodeJS.ProcessEnv = process.env,
    options: { cwd?: string; providerSettings?: ResolvedSettings } = {},
  ): Promise<EverCoreRuntimeLease> {
    return this.acquire(resolveEverCoreConfigInputFromEnv(env, options))
  }

  async shutdown(): Promise<void> {
    if (!this.entry) return
    const entry = this.entry
    this.entry = undefined
    await this.disposeEntry(entry)
  }

  private createLease(
    entry: CacheEntry,
    options: { disposeOnRelease?: boolean } = {},
  ): EverCoreRuntimeLease {
    let released = false
    const release = async () => {
      if (released) return
      released = true
      entry.refCount = Math.max(0, entry.refCount - 1)
      if (entry.refCount !== 0) return
      if (options.disposeOnRelease) {
        await this.disposeEntry(entry)
        return
      }
      this.scheduleIdleDispose(entry)
    }
    return {
      ...entry.value,
      dispose: release,
      release,
    }
  }

  private scheduleIdleDispose(entry: CacheEntry): void {
    this.cancelIdleTimer(entry)
    if (this.idleTtlMs <= 0) {
      void this.disposeIdleEntry(entry)
      return
    }
    entry.idleTimer = setTimeout(() => {
      void this.disposeIdleEntry(entry)
    }, this.idleTtlMs)
    entry.idleTimer.unref?.()
  }

  private async disposeIdleEntry(entry: CacheEntry): Promise<void> {
    if (entry.refCount !== 0) return
    if (this.entry === entry) this.entry = undefined
    await this.disposeEntry(entry)
  }

  private cancelIdleTimer(entry: CacheEntry): void {
    if (!entry.idleTimer) return
    clearTimeout(entry.idleTimer)
    entry.idleTimer = undefined
  }

  private async disposeEntry(entry: CacheEntry): Promise<void> {
    this.cancelIdleTimer(entry)
    entry.refCount = 0
    await entry.value.dispose?.()
  }
}

export const defaultEverCoreRuntimeManager = new EverCoreRuntimeManager()

function isReusableEverCore(value: ConfiguredEverCore): boolean {
  return !value.status.enabled || value.status.healthy
}

function stableFingerprint(value: unknown): string {
  return JSON.stringify(normalizeFingerprintValue(value))
}

function normalizeFingerprintValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeFingerprintValue)
  if (!value || typeof value !== 'object') {
    if (typeof value === 'function') return '[function]'
    return value
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => typeof item !== 'function')
    .sort(([left], [right]) => left.localeCompare(right))
  return Object.fromEntries(entries.map(([key, item]) => [key, normalizeFingerprintValue(item)]))
}
