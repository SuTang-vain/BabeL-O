import chalk from 'chalk'
import { Command } from 'commander'
import { ConfigManager } from '../../shared/config.js'
import { modelRegistry } from '../../providers/registry.js'

export function registerConfigCommand(program: Command): void {
  const configCmd = program.command('config').description('Manage configuration')

  configCmd
    .command('add')
    .description('Configure credentials for a provider')
    .argument('<provider>', 'Provider ID (e.g., anthropic, openai)')
    .argument('<key>', 'API Key')
    .argument('[baseUrl]', 'Custom Base URL')
    .action((provider: string, key: string, baseUrl?: string) => {
      const configManager = ConfigManager.getInstance()
      configManager.setProviderConfig(provider, { apiKey: key, baseUrl })
      console.log(chalk.green(`✓ Configured credentials for provider: ${provider}`))
    })

  configCmd
    .command('list')
    .description('List active configuration and resolved settings')
    .action(() => {
      const configManager = ConfigManager.getInstance()
      const rawConfig = configManager.load()
      const resolved = configManager.resolveSettings()

      const maskedConfig = JSON.parse(JSON.stringify(rawConfig))
      if (maskedConfig.providers) {
        for (const p of Object.keys(maskedConfig.providers)) {
          if (maskedConfig.providers[p].apiKey) {
            maskedConfig.providers[p].apiKey = '********'
          }
        }
      }

      const maskedResolved = {
        ...resolved,
        apiKey: resolved.apiKey ? '********' : undefined,
      }

      console.log(chalk.cyan.bold('\n--- Active Config file ---'))
      console.log(JSON.stringify(maskedConfig, null, 2))

      console.log(chalk.cyan.bold('\n--- Resolved Settings ---'))
      console.log(JSON.stringify(maskedResolved, null, 2))
      console.log()
    })

  configCmd
    .command('use')
    .description('Set the default model')
    .argument('<modelId>', 'Canonical Model ID (e.g. anthropic/claude-3-5-sonnet)')
    .action((modelId: string) => {
      const configManager = ConfigManager.getInstance()
      const exists = modelRegistry.some(m => m.id === modelId)
      if (!exists) {
        console.warn(chalk.yellow(`Warning: Model "${modelId}" is not in the registered list, but setting it anyway.`))
      }
      configManager.setDefaultModel(modelId)
      console.log(chalk.green(`✓ Default model set to: ${modelId}`))
    })
}
