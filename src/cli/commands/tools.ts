import { Command } from 'commander'
import { NexusClient } from '../NexusClient.js'


export function registerToolsCommand(program: Command): void {
  const tools = program.command('tools').description('Inspect Nexus tools')

  tools
    .command('audit')
    .description('Show registered tools and current allow policy')
    .option('--url <url>', 'Nexus URL')
    .action(async (options: { url?: string }) => {
      const audit = await new NexusClient({ baseUrl: options.url }).auditTools()
      console.log(JSON.stringify(audit, null, 2))
    })
}
