import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

export type McpToolDefinition = {
  name: string
  description?: string
  inputSchema?: unknown
}

export type McpToolCallResult = {
  content?: unknown
  isError?: boolean
  [key: string]: unknown
}

type JsonRpcResponse = {
  id?: number
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

type PendingRequest = {
  resolve(value: unknown): void
  reject(error: Error): void
}

export type McpClientOptions = {
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  framing?: 'content-length' | 'jsonl'
}

export class McpClient {
  private child?: ChildProcessWithoutNullStreams
  private nextId = 1
  private buffer = Buffer.alloc(0)
  private readonly pending = new Map<number, PendingRequest>()
  private shutdownPromise?: Promise<void>

  constructor(private readonly options: McpClientOptions) {}

  async connect(): Promise<void> {
    if (this.child) return
    this.child = spawn(this.options.command, this.options.args ?? [], {
      cwd: this.options.cwd,
      env: { ...process.env, ...(this.options.env ?? {}) },
      stdio: 'pipe',
    })
    this.child.stdout.on('data', chunk => this.onData(chunk))
    this.child.stderr.on('data', chunk => {
      // Drain stderr so chatty MCP servers cannot block on a full pipe.
      if (process.env.BABEL_O_MCP_DEBUG === '1') {
        process.stderr.write(chunk)
      }
    })
    this.child.on('error', err => this.rejectAll(err))
    this.child.on('exit', code => {
      if (code !== 0) {
        this.rejectAll(new Error(`MCP server exited with code ${code}`))
      }
    })
  }

  async initialize(): Promise<unknown> {
    await this.connect()
    const result = await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: {
        name: 'BabeL-O',
        version: '0.2.4',
      },
    })
    this.notify('notifications/initialized', {})
    return result
  }

  async listTools(): Promise<McpToolDefinition[]> {
    const result = await this.request('tools/list', {})
    const tools = (result as { tools?: McpToolDefinition[] })?.tools
    return Array.isArray(tools) ? tools : []
  }

  async callTool(name: string, args: unknown): Promise<McpToolCallResult> {
    return await this.request('tools/call', {
      name,
      arguments: args,
    }) as McpToolCallResult
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise
    this.shutdownPromise = this.shutdownOnce()
    return this.shutdownPromise
  }

  private async shutdownOnce(): Promise<void> {
    const child = this.child
    if (!child) return
    try {
      await Promise.race([
        this.request('shutdown', {}),
        new Promise((_, reject) => setTimeout(() => reject(new Error('MCP shutdown timed out')), 1_000)),
      ])
    } catch {
      // Some MCP servers exit without replying to shutdown.
    } finally {
      this.rejectAll(new Error('MCP client is shutting down'))
      if (!child.killed) child.kill()
      this.child = undefined
    }
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const child = this.child
    if (!child) return Promise.reject(new Error('MCP client is not connected'))
    const id = this.nextId++
    const payload = JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      params,
    })
    const frame = this.serializePayload(payload)

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      child.stdin.write(frame, err => {
        if (!err) return
        this.pending.delete(id)
        reject(err)
      })
    })
  }

  private notify(method: string, params: unknown): void {
    const child = this.child
    if (!child) return
    const payload = JSON.stringify({
      jsonrpc: '2.0',
      method,
      params,
    })
    const frame = this.serializePayload(payload)
    child.stdin.write(frame)
  }

  private onData(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk])
    while (true) {
      const parsedJsonLine = this.tryReadJsonLine()
      if (parsedJsonLine) {
        this.handleMessage(parsedJsonLine)
        continue
      }
      const crlfHeaderEnd = this.buffer.indexOf('\r\n\r\n')
      const lfHeaderEnd = this.buffer.indexOf('\n\n')
      const useCrlf = crlfHeaderEnd !== -1 && (lfHeaderEnd === -1 || crlfHeaderEnd <= lfHeaderEnd)
      const headerEnd = useCrlf ? crlfHeaderEnd : lfHeaderEnd
      if (headerEnd === -1) return
      const header = this.buffer.subarray(0, headerEnd).toString('utf8')
      const match = header.match(/content-length:\s*(\d+)/i)
      if (!match) {
        this.buffer = this.buffer.subarray(headerEnd + (useCrlf ? 4 : 2))
        continue
      }
      const length = Number(match[1])
      const bodyStart = headerEnd + (useCrlf ? 4 : 2)
      const bodyEnd = bodyStart + length
      if (this.buffer.length < bodyEnd) return
      const body = this.buffer.subarray(bodyStart, bodyEnd).toString('utf8')
      this.buffer = this.buffer.subarray(bodyEnd)
      this.handleMessage(JSON.parse(body) as JsonRpcResponse)
    }
  }

  private handleMessage(message: JsonRpcResponse) {
    if (typeof message.id !== 'number') return
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    if (message.error) {
      pending.reject(new Error(message.error.message))
    } else {
      pending.resolve(message.result)
    }
  }

  private rejectAll(error: Error) {
    for (const pending of this.pending.values()) {
      pending.reject(error)
    }
    this.pending.clear()
  }

  private serializePayload(payload: string): string {
    if (this.options.framing === 'jsonl') {
      return `${payload}\n`
    }
    return `Content-Length: ${Buffer.byteLength(payload, 'utf8')}\r\n\r\n${payload}`
  }

  private tryReadJsonLine(): JsonRpcResponse | null {
    const newline = this.buffer.indexOf('\n')
    const headerEnd = this.buffer.indexOf('\r\n\r\n')
    if (newline === -1 || (headerEnd !== -1 && headerEnd < newline)) return null
    const line = this.buffer.subarray(0, newline).toString('utf8').replace(/\r$/, '')
    if (!line.trim().startsWith('{')) return null
    this.buffer = this.buffer.subarray(newline + 1)
    return JSON.parse(line) as JsonRpcResponse
  }
}
