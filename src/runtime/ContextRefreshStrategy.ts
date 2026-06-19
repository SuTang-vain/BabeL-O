import { logger } from '../shared/logger.js'
import type { SessionMessage } from '../shared/sessionChannel.js'
import type { NexusStorage } from '../storage/Storage.js'
import type { MemoryProvider } from './memoryProvider.js'
import type { RuntimeContextBroadcaster } from './contextBroadcaster.js'
import {
  refreshRuntimeContextState,
  type RuntimeContextRefreshState,
} from './pipeline/contextRefresh.js'

type RuntimeContextRefreshOptions = Parameters<typeof refreshRuntimeContextState>[0]

export type ContextRefreshSessionInbox =
  | 'omit'
  | 'load'
  | 'empty'
  | readonly SessionMessage[]

export type ContextRefreshStrategyOptions =
  Omit<RuntimeContextRefreshOptions, 'memoryProvider' | 'contextBroadcaster' | 'sessionInbox'> & {
    sessionInbox?: ContextRefreshSessionInbox
  }

export class ContextRefreshStrategy {
  constructor(
    private readonly deps: {
      storage?: NexusStorage
      memoryProvider?: MemoryProvider
      contextBroadcaster?: RuntimeContextBroadcaster
      sessionInboxLimit?: number
    },
  ) {}

  async refresh(options: ContextRefreshStrategyOptions): Promise<RuntimeContextRefreshState> {
    const sessionInbox = await this.resolveSessionInbox(options)
    const { sessionInbox: _sessionInbox, ...refreshOptions } = options
    return refreshRuntimeContextState({
      ...refreshOptions,
      memoryProvider: this.deps.memoryProvider,
      contextBroadcaster: this.deps.contextBroadcaster,
      ...(sessionInbox !== undefined && { sessionInbox }),
    })
  }

  private async resolveSessionInbox(
    options: Pick<ContextRefreshStrategyOptions, 'runtimeOptions' | 'sessionInbox'>,
  ): Promise<SessionMessage[] | undefined> {
    if (Array.isArray(options.sessionInbox)) return [...options.sessionInbox]
    if (options.sessionInbox === 'empty') return []
    if (options.sessionInbox !== 'load') return undefined

    const sessionId = options.runtimeOptions.sessionId
    if (!sessionId || !this.deps.storage) return []
    try {
      return await this.deps.storage.listSessionInbox(sessionId, {
        limit: this.deps.sessionInboxLimit ?? 20,
      })
    } catch (error) {
      logger.debug('Failed to load session inbox from storage', error)
      return []
    }
  }
}
