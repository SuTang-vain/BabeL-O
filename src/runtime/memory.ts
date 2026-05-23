import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const MAX_MEMORY_CHARS = 8_000

export async function loadProjectMemory(cwd: string): Promise<string> {
  const memoryPath = join(cwd, '.babel-o', 'memory.md')
  try {
    const content = await readFile(memoryPath, 'utf8')
    return content.length > MAX_MEMORY_CHARS
      ? content.slice(0, MAX_MEMORY_CHARS)
      : content
  } catch (err: any) {
    if (err?.code === 'ENOENT') return ''
    return ''
  }
}
