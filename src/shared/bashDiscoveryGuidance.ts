export type BashFileDiscoveryGuidance = {
  code: 'BASH_AS_FILE_DISCOVERY'
  commandKind: 'ls' | 'recursive-ls' | 'find' | 'tree' | 'recursive-grep' | 'rg'
  preferredTools: Array<'ListDir' | 'Glob' | 'Grep' | 'Read'>
  message: string
}

export function getBashFileDiscoveryGuidance(command: string): BashFileDiscoveryGuidance | null {
  const commandKind = detectBashFileDiscoveryKind(command)
  if (!commandKind) return null
  return {
    code: 'BASH_AS_FILE_DISCOVERY',
    commandKind,
    preferredTools: ['ListDir', 'Glob', 'Grep', 'Read'],
    message: `Bash command looks like read-only file discovery (${commandKind}). Prefer ListDir for directory inventory, Glob for path-pattern file discovery, Grep for content locating, and Read for source understanding. If Bash is still necessary, narrow it to a small path.`,
  }
}

function detectBashFileDiscoveryKind(command: string): BashFileDiscoveryGuidance['commandKind'] | null {
  const text = command.trim()
  if (!text) return null

  if (/(?:^|[;&|]\s*)find(?:\s|$)/iu.test(text)) return 'find'
  if (/(?:^|[;&|]\s*)tree(?:\s|$)/iu.test(text)) return 'tree'
  if (/(?:^|[;&|]\s*)ls\s+[^;&|]*(?:-[A-Za-z0-9]*R[A-Za-z0-9]*|--recursive\b)/iu.test(text)) return 'recursive-ls'
  if (/(?:^|[;&|]\s*)ls(?:\s|$)/iu.test(text)) return 'ls'
  if (/(?:^|[;&|]\s*)(?:grep|egrep|fgrep)\s+[^;&|]*(?:-[A-Za-z0-9]*[rR][A-Za-z0-9]*|--recursive\b)/iu.test(text)) return 'recursive-grep'
  if (/(?:^|[;&|]\s*)rg(?:\s|$)/iu.test(text)) return 'rg'

  return null
}
