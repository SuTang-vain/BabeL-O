import { createNexusApp } from './app.js'
import { createDefaultNexusRuntime } from './createRuntime.js'

const host = process.env.NEXUS_HOST ?? '127.0.0.1'
const port = Number(process.env.NEXUS_PORT ?? 3000)
const cwd = process.env.BABEL_O_WORKSPACE ?? process.cwd()
const storagePath = process.env.NEXUS_STORAGE_PATH
const allowedTools = parseAllowedTools(process.env.NEXUS_ALLOWED_TOOLS)
const executeTimeoutMs = parsePositiveInt(process.env.NEXUS_EXECUTE_TIMEOUT_MS)
const maxConcurrentExecutions =
  parsePositiveInt(process.env.NEXUS_MAX_CONCURRENT_EXECUTIONS) ?? 8
const maxToolOutputBytes =
  parsePositiveInt(process.env.NEXUS_MAX_TOOL_OUTPUT_BYTES) ?? 200_000
const bashMaxBufferBytes =
  parsePositiveInt(process.env.NEXUS_BASH_MAX_BUFFER_BYTES) ?? 1_000_000

const { runtime, storage } = createDefaultNexusRuntime({ storagePath, allowedTools })
const app = await createNexusApp({
  runtime,
  storage,
  defaultCwd: cwd,
  executeTimeoutMs,
  maxConcurrentExecutions,
  maxToolOutputBytes,
  bashMaxBufferBytes,
})

await app.listen({ host, port })
console.log(
  `BabeL-O Nexus listening on http://${host}:${port}` +
    (storagePath ? ` storage=${storagePath}` : ' storage=memory') +
    (allowedTools ? ` allowedTools=${allowedTools.join(',')}` : ' allowedTools=all') +
    ` maxConcurrentExecutions=${maxConcurrentExecutions}` +
    ` maxToolOutputBytes=${maxToolOutputBytes}` +
    ` bashMaxBufferBytes=${bashMaxBufferBytes}`,
)

function parseAllowedTools(value: string | undefined): string[] | undefined {
  if (!value) return undefined
  return value
    .split(',')
    .map(tool => tool.trim())
    .filter(Boolean)
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) return undefined
  return parsed
}
