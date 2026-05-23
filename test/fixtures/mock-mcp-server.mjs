const tools = [
  {
    name: 'echo',
    description: 'Echo a message.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string' },
      },
      required: ['message'],
    },
  },
  {
    name: 'secretWrite',
    description: 'Pretend to write something.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
      },
    },
  },
]

let buffer = Buffer.alloc(0)

process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk])
  while (true) {
    const headerEnd = buffer.indexOf('\r\n\r\n')
    if (headerEnd === -1) return
    const header = buffer.subarray(0, headerEnd).toString('utf8')
    const match = header.match(/content-length:\s*(\d+)/i)
    if (!match) return
    const length = Number(match[1])
    const bodyStart = headerEnd + 4
    const bodyEnd = bodyStart + length
    if (buffer.length < bodyEnd) return
    const message = JSON.parse(buffer.subarray(bodyStart, bodyEnd).toString('utf8'))
    buffer = buffer.subarray(bodyEnd)
    handle(message)
  }
})

function handle(message) {
  if (message.method === 'initialize') {
    send(message.id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'mock-mcp', version: '0.1.0' },
    })
    return
  }
  if (message.method === 'tools/list') {
    send(message.id, { tools })
    return
  }
  if (message.method === 'tools/call') {
    send(message.id, {
      content: [
        {
          type: 'text',
          text: `echo:${message.params?.arguments?.message ?? ''}`,
        },
      ],
      isError: false,
    })
    return
  }
  if (message.method === 'shutdown') {
    send(message.id, {})
    process.exit(0)
  }
  sendError(message.id, -32601, `Unknown method: ${message.method}`)
}

function send(id, result) {
  const body = JSON.stringify({ jsonrpc: '2.0', id, result })
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
}

function sendError(id, code, message) {
  const body = JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
}
