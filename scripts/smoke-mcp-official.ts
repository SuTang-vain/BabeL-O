import { mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { McpClient } from '../src/mcp/McpClient.js'

type SmokeCase = {
  name: string
  command: string
  args: string[]
  env?: Record<string, string>
  call?: {
    toolName: string
    input: unknown
    expect: RegExp
  }
}

type SmokeResult = {
  name: string
  toolCount: number
  tools: string[]
  callOk?: boolean
}

const timeoutMs = Number(process.env.BABEL_O_MCP_SMOKE_TIMEOUT_MS ?? 45_000)

async function main() {
  const cwd = join(tmpdir(), `babel-o-official-mcp-${Date.now()}`)
  const memoryPath = join(cwd, 'memory.json')
  await mkdir(cwd, { recursive: true })
  await writeFile(join(cwd, 'sample.txt'), 'hello official mcp smoke\n', 'utf8')
  const realCwd = await realpath(cwd)
  const samplePath = join(realCwd, 'sample.txt')

  const cases: SmokeCase[] = [
    {
      name: 'official filesystem',
      command: 'npx',
      args: ['-y', '-p', '@modelcontextprotocol/server-filesystem', 'mcp-server-filesystem', realCwd],
      call: {
        toolName: 'read_file',
        input: { path: samplePath },
        expect: /hello official mcp smoke/,
      },
    },
    {
      name: 'official memory',
      command: 'npx',
      args: ['-y', '-p', '@modelcontextprotocol/server-memory', 'mcp-server-memory'],
      env: { MEMORY_FILE_PATH: memoryPath },
    },
    {
      name: 'official everything',
      command: 'npx',
      args: ['-y', '-p', '@modelcontextprotocol/server-everything', 'mcp-server-everything', 'stdio'],
    },
  ]

  try {
    const results: SmokeResult[] = []
    for (const smokeCase of cases) {
      results.push(await withTimeout(runSmokeCase(smokeCase), timeoutMs, smokeCase.name))
    }

    console.log(JSON.stringify({
      type: 'mcp_official_smoke',
      timestamp: new Date().toISOString(),
      packageManager: 'npx',
      results,
    }, null, 2))
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
}

async function runSmokeCase(smokeCase: SmokeCase): Promise<SmokeResult> {
  const client = new McpClient({
    command: smokeCase.command,
    args: smokeCase.args,
    env: smokeCase.env,
    framing: 'jsonl',
  })

  try {
    await client.initialize()
    const tools = await client.listTools()
    if (tools.length === 0) {
      throw new Error(`${smokeCase.name} listed no tools`)
    }

    let callOk: boolean | undefined
    if (smokeCase.call) {
      const result = await client.callTool(smokeCase.call.toolName, smokeCase.call.input)
      const output = JSON.stringify(result)
      if (!smokeCase.call.expect.test(output)) {
        throw new Error(`${smokeCase.name} call output did not match ${smokeCase.call.expect}: ${output}`)
      }
      callOk = true
    }

    return {
      name: smokeCase.name,
      toolCount: tools.length,
      tools: tools.map(tool => tool.name).slice(0, 12),
      callOk,
    }
  } finally {
    await client.shutdown()
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, name: string): Promise<T> {
  let timer: NodeJS.Timeout
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${name} timed out after ${ms}ms`)), ms)
    }),
  ]).finally(() => clearTimeout(timer!))
}

await main()
