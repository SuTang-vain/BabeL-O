import {
  allowAllTools,
  denyByDefaultTools,
  allowlistedTools,
  LocalCodingRuntime,
} from '../runtime/LocalCodingRuntime.js'
import { LLMCodingRuntime } from '../runtime/LLMCodingRuntime.js'
import { MemoryStorage } from '../storage/MemoryStorage.js'
import { SqliteStorage } from '../storage/SqliteStorage.js'
import { createDefaultToolRegistry } from '../tools/registry.js'
import { ConfigManager } from '../shared/config.js'
import { createMcpToolRegistry } from '../mcp/McpToolAdapter.js'

export type CreateDefaultNexusRuntimeOptions = {
  storagePath?: string
  allowedTools?: string[]
  cwd?: string
  enableMcp?: boolean
}

export async function createDefaultNexusRuntime(
  options: CreateDefaultNexusRuntimeOptions = {},
) {
  const tools = createDefaultToolRegistry()
  if (options.enableMcp) {
    const mcpTools = await createMcpToolRegistry(options.cwd ?? process.cwd())
    for (const [name, tool] of mcpTools) {
      tools.set(name, tool)
    }
  }
  const storage = options.storagePath
    ? new SqliteStorage(options.storagePath)
    : new MemoryStorage()
  const originalClose = storage.close?.bind(storage)
  storage.close = async () => {
    const disposableTools = [...tools.values()].filter(tool => tool.dispose)
    await Promise.allSettled(disposableTools.map(tool => tool.dispose?.()))
    await originalClose?.()
  }

  const configManager = ConfigManager.getInstance()
  const settings = configManager.resolveSettings()

  let policy = denyByDefaultTools()
  if (options.allowedTools) {
    const hasWildcard = options.allowedTools.some(t => {
      const norm = t.trim().toLowerCase()
      return norm === '*' || norm === 'all'
    })
    if (hasWildcard) {
      policy = allowAllTools()
    } else {
      policy = allowlistedTools(options.allowedTools)
    }
  }

  const runtime =
    settings.providerId === 'local'
      ? new LocalCodingRuntime(tools, policy, storage)
      : new LLMCodingRuntime(tools, policy, storage, configManager)

  return { runtime, storage, tools }
}
