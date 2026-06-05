import { createHash } from 'node:crypto'
import type { ModelToolDefinition, SystemPromptBlock } from '../providers/adapters/ModelAdapter.js'

export type PrefixCacheDiagnostics = {
  immutablePrefixChars: number
  totalSystemPromptChars: number
  immutablePrefixRatio: number
  fingerprint: string
  volatileContentLast: boolean
}

export function computePrefixCacheDiagnostics(options: {
  systemPromptBlocks?: SystemPromptBlock[]
  tools?: ModelToolDefinition[]
}): PrefixCacheDiagnostics {
  const blocks = options.systemPromptBlocks ?? []
  const totalSystemPromptChars = blocks.reduce((sum, block) => sum + block.text.length, 0)
  const immutablePrefixChars = computeImmutablePrefixChars(blocks)
  return {
    immutablePrefixChars,
    totalSystemPromptChars,
    immutablePrefixRatio: totalSystemPromptChars > 0
      ? clampRatio(immutablePrefixChars / totalSystemPromptChars)
      : 0,
    fingerprint: fingerprintImmutablePrefix(blocks, options.tools ?? []),
    volatileContentLast: hasVolatileContentLast(blocks),
  }
}

export function fingerprintImmutablePrefix(
  blocks: SystemPromptBlock[] | undefined,
  tools: ModelToolDefinition[],
): string {
  const systemText = (blocks ?? [])
    .filter(block => block.cacheable)
    .map(block => block.text)
    .join('\n\n')
  const toolNames = tools.map(tool => tool.name).sort((left, right) => left.localeCompare(right))
  return createHash('sha256')
    .update(systemText)
    .update('\n---tools---\n')
    .update(toolNames.join('\n'))
    .digest('hex')
}

export function hasVolatileContentLast(blocks: SystemPromptBlock[] | undefined): boolean {
  let seenVolatile = false
  for (const block of blocks ?? []) {
    if (!block.cacheable) {
      seenVolatile = true
    } else if (seenVolatile) {
      return false
    }
  }
  return true
}

function computeImmutablePrefixChars(blocks: SystemPromptBlock[]): number {
  let chars = 0
  for (const block of blocks) {
    if (!block.cacheable) break
    chars += block.text.length
  }
  return chars
}

function clampRatio(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}
