import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { existsSync } from 'node:fs'

const MAX_AGENT_MD_CHARS = 8_000

/**
 * Discover and load AGENTS.md files from the workspace and its ancestor
 * directories, plus `.babel-o/AGENTS.md` in the project root.
 *
 * The file closest to cwd appears first; ancestor files follow.
 * This mirrors the BabeL-X / Claude Code convention where deeper
 * (more specific) project instructions take precedence over
 * shallower (more general) ones, but all are injected so the model
 * sees the full chain.
 */
export async function loadAgentMdFiles(cwd: string): Promise<string> {
  const seen = new Set<string>()
  const parts: string[] = []

  // Walk upward from cwd to root, collecting AGENTS.md at each level.
  let current = cwd
  while (current && current !== dirname(current)) {
    const candidate = join(current, 'AGENTS.md')
    if (!seen.has(candidate) && existsSync(candidate)) {
      seen.add(candidate)
      try {
        const content = await readFile(candidate, 'utf8')
        parts.push(content.trim())
      } catch {
        // Skip unreadable files
      }
    }
    current = dirname(current)
  }

  // Also check .babel-o/AGENTS.md (project-level override).
  const babelAgentMd = join(cwd, '.babel-o', 'AGENTS.md')
  if (!seen.has(babelAgentMd) && existsSync(babelAgentMd)) {
    try {
      const content = await readFile(babelAgentMd, 'utf8')
      parts.push(content.trim())
    } catch {
      // Skip
    }
  }

  if (parts.length === 0) return ''

  const combined = parts.join('\n\n')
  return combined.length > MAX_AGENT_MD_CHARS
    ? combined.slice(0, MAX_AGENT_MD_CHARS)
    : combined
}
