import {
  allowAllTools,
  allowlistedTools,
  LocalCodingRuntime,
} from '../runtime/LocalCodingRuntime.js'
import { LLMCodingRuntime } from '../runtime/LLMCodingRuntime.js'
import { MemoryStorage } from '../storage/MemoryStorage.js'
import { SqliteStorage } from '../storage/SqliteStorage.js'
import { createDefaultToolRegistry } from '../tools/registry.js'
import { ConfigManager } from '../shared/config.js'

export type CreateDefaultNexusRuntimeOptions = {
  storagePath?: string
  allowedTools?: string[]
}

export function createDefaultNexusRuntime(
  options: CreateDefaultNexusRuntimeOptions = {},
) {
  const tools = createDefaultToolRegistry()
  const storage = options.storagePath
    ? new SqliteStorage(options.storagePath)
    : new MemoryStorage()

  const configManager = ConfigManager.getInstance()
  const settings = configManager.resolveSettings()

  const policy = options.allowedTools
    ? allowlistedTools(options.allowedTools)
    : allowAllTools()

  const runtime =
    settings.providerId === 'local'
      ? new LocalCodingRuntime(tools, policy)
      : new LLMCodingRuntime(tools, policy, storage, configManager)

  return { runtime, storage, tools }
}
