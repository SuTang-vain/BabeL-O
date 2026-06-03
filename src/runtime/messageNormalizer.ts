import type { ModelMessage, ContentBlock } from '../providers/adapters/ModelAdapter.js'

function stripInternalToolResultMetadata(block: ContentBlock): ContentBlock {
  if (block.type !== 'tool_result') return block
  const { toolName: _toolName, ...providerBlock } = block
  return providerBlock
}

export function normalizeMessages(messages: ModelMessage[]): ModelMessage[] {
  const toolUseIds = new Set<string>()
  const toolResultIds = new Set<string>()

  for (const msg of messages) {
    if (typeof msg.content === 'string') continue
    for (const block of msg.content) {
      if (block.type === 'tool_use') toolUseIds.add(block.id)
      if (block.type === 'tool_result') toolResultIds.add(block.toolUseId)
    }
  }

  const result: ModelMessage[] = []
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      result.push(msg)
      continue
    }
    const filtered = msg.content.filter(block => {
      if (block.type === 'tool_result' && !toolUseIds.has(block.toolUseId)) {
        return false
      }
      return true
    })
    if (filtered.length > 0) {
      result.push({ ...msg, content: filtered.map(stripInternalToolResultMetadata) })
    }
  }

  const orphanedUseIds = [...toolUseIds].filter(id => !toolResultIds.has(id))
  if (orphanedUseIds.length > 0) {
    const syntheticResults: ContentBlock[] = orphanedUseIds.map(id => ({
      type: 'tool_result' as const,
      toolUseId: id,
      content: 'Tool execution was interrupted or denied. Please retry if needed.',
      isError: true,
    }))
    result.push({ role: 'user', content: syntheticResults })
  }

  if (result.length > 0 && result[0].role === 'assistant') {
    result.unshift({ role: 'user', content: '(conversation start)' })
  }

  return result
}
