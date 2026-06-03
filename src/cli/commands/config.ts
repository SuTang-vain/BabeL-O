import chalk from 'chalk'
import { Command } from 'commander'
import { ConfigManager, DEFAULT_BABEL_X_CONFIG_FILE, loadBabeLXConfigImportPlan } from '../../shared/config.js'
import { modelRegistry } from '../../providers/registry.js'

export function registerConfigCommand(program: Command): void {
  const configCmd = program.command('config').description('Manage configuration')

  configCmd
    .command('import-babel-x')
    .description('Preview or apply a one-time BabeL-X config import')
    .option('--source <path>', 'BabeL-X config path', DEFAULT_BABEL_X_CONFIG_FILE)
    .option('--apply', 'Write imported profiles into the BabeL-O config file')
    .action((options: { source: string; apply?: boolean }) => {
      const plan = loadBabeLXConfigImportPlan(options.source)
      const output = {
        sourceSchema: plan.sourceSchema,
        transcriptImportSupported: plan.transcriptImportSupported,
        mode: options.apply ? 'apply' : 'dry-run',
        importedProfiles: plan.importedProfiles,
        skippedProfiles: plan.skippedProfiles,
        warnings: plan.warnings,
      }

      console.log(chalk.cyan.bold('\n--- BabeL-X Import Plan ---'))
      console.log(JSON.stringify(output, null, 2))

      if (options.apply) {
        const configManager = ConfigManager.getInstance()
        const existing = configManager.load()
        configManager.save({
          ...existing,
          providers: { ...existing.providers, ...plan.config.providers },
          profiles: { ...existing.profiles, ...plan.config.profiles },
          activeProfile: plan.config.activeProfile ?? existing.activeProfile,
          defaultModel: plan.config.defaultModel ?? existing.defaultModel,
        })
        console.log(chalk.green(`\n✓ Imported ${plan.importedProfiles.length} BabeL-X profile(s) into BabeL-O config.`))
      } else {
        console.log(chalk.yellow('\nDry run only. Re-run with --apply to write BabeL-O config.'))
      }
      console.log()
    })

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
