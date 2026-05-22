import {
  allowAllTools,
  allowlistedTools,
  LocalCodingRuntime,
} from '../runtime/LocalCodingRuntime.js'
import { MemoryStorage } from '../storage/MemoryStorage.js'
import { SqliteStorage } from '../storage/SqliteStorage.js'
import { createDefaultToolRegistry } from '../tools/registry.js'

export type CreateDefaultNexusRuntimeOptions = {
  storagePath?: string
  allowedTools?: string[]
}

export function createDefaultNexusRuntime(
  options: CreateDefaultNexusRuntimeOptions = {},
) {
  const tools = createDefaultToolRegistry()
  const runtime = new LocalCodingRuntime(
    tools,
    options.allowedTools ? allowlistedTools(options.allowedTools) : allowAllTools(),
  )
  const storage = options.storagePath
    ? new SqliteStorage(options.storagePath)
    : new MemoryStorage()
  return { runtime, storage, tools }
}
