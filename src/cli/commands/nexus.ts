import { spawn } from 'node:child_process'
import { Command } from 'commander'
import { NexusClient } from '../NexusClient.js'

export function registerNexusCommand(program: Command): void {
  const nexus = program.command('nexus').description('Manage Nexus service')

  nexus
    .command('start')
    .description('Start a local Nexus service')
    .option('--host <host>', 'Host to bind', '127.0.0.1')
    .option('--port <port>', 'Port to bind', '3000')
    .option('--cwd <path>', 'Workspace directory', process.env.BABEL_O_LAUNCH_CWD ?? process.cwd())
    .option('--storage-path <path>', 'SQLite storage path')
    .option('--allowed-tools <tools>', 'Comma-separated allowed tool names')
    .option('--execute-timeout-ms <ms>', 'Default execute timeout in milliseconds')
    .option('--max-concurrent-executions <count>', 'Maximum concurrent executions')
    .option('--max-tool-output-bytes <bytes>', 'Maximum stored/rendered tool output bytes')
    .option('--bash-max-buffer-bytes <bytes>', 'Maximum Bash process output buffer bytes')
    .action((options: {
      host: string
      port: string
      cwd: string
      storagePath?: string
      allowedTools?: string
      executeTimeoutMs?: string
      maxConcurrentExecutions?: string
      maxToolOutputBytes?: string
      bashMaxBufferBytes?: string
    }) => {
      const args = process.argv[1] && (process.argv[1].endsWith('.js') || process.argv[1].endsWith('.ts'))
        ? [process.argv[1], '__server']
        : ['__server']

      const child = spawn(
        process.execPath,
        args,
        {
          stdio: 'inherit',
          env: {
            ...process.env,
            NEXUS_HOST: options.host,
            NEXUS_PORT: options.port,
            BABEL_O_WORKSPACE: options.cwd,
            ...(options.storagePath ? { NEXUS_STORAGE_PATH: options.storagePath } : {}),
            ...(options.allowedTools ? { NEXUS_ALLOWED_TOOLS: options.allowedTools } : {}),
            ...(options.executeTimeoutMs
              ? { NEXUS_EXECUTE_TIMEOUT_MS: options.executeTimeoutMs }
              : {}),
            ...(options.maxConcurrentExecutions
              ? { NEXUS_MAX_CONCURRENT_EXECUTIONS: options.maxConcurrentExecutions }
              : {}),
            ...(options.maxToolOutputBytes
              ? { NEXUS_MAX_TOOL_OUTPUT_BYTES: options.maxToolOutputBytes }
              : {}),
            ...(options.bashMaxBufferBytes
              ? { NEXUS_BASH_MAX_BUFFER_BYTES: options.bashMaxBufferBytes }
              : {}),
          },
        },
      )
      child.on('exit', code => process.exit(code ?? 0))
    })

  nexus
    .command('status')
    .description('Read Nexus runtime status')
    .option('--url <url>', 'Nexus URL')
    .action(async (options: { url?: string }) => {
      console.log(JSON.stringify(await new NexusClient({ baseUrl: options.url }).status(), null, 2))
    })
}
