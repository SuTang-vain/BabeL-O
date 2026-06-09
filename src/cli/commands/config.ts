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

  // === 路径 C 阶段 2: profile 切换命令（CLI-only, 不暴露 model/role 切换） ===
  const profileCmd = configCmd.command('profile').description('Manage config profiles (path C phase 2)')

  profileCmd
    .command('list')
    .description('List active profiles and tombstones')
    .action(() => {
      const configManager = ConfigManager.getInstance()
      const profiles = configManager.getProfiles()
      const tombstones = configManager.getTombstones()
      const active = configManager.getActiveProfile()
      const version = configManager.getConfigVersion()

      const lines: string[] = []
      lines.push(chalk.cyan.bold('\n--- Config Profiles ---'))
      lines.push(`active: ${active ?? '(none)'}`)
      lines.push(`version: ${version}`)
      for (const [name, profile] of Object.entries(profiles)) {
        const marker = name === active ? chalk.green('*') : ' '
        const masked = { ...profile }
        if (masked.apiKey) masked.apiKey = '********'
        if (masked.baseUrl) masked.baseUrl = '<set>'
        lines.push(`${marker} ${name}: ${JSON.stringify(masked)}`)
      }
      const tombstoneNames = Object.keys(tombstones)
      if (tombstoneNames.length > 0) {
        lines.push('')
        lines.push(chalk.dim('Tombstones:'))
        for (const [name, t] of Object.entries(tombstones)) {
          lines.push(`  ${name}: deletedAt=${t.deletedAt}`)
        }
      }
      console.log(lines.join('\n'))
    })

  profileCmd
    .command('use')
    .description('Switch the active profile')
    .argument('<name>', 'Profile name')
    .action((name: string) => {
      const configManager = ConfigManager.getInstance()
      if (configManager.isProfileTombstoned(name)) {
        console.error(chalk.red(`Error: profile "${name}" is tombstoned; restore it first with \`bbl config profile restore ${name}\`.`))
        process.exitCode = 1
        return
      }
      if (!configManager.hasProfile(name)) {
        console.error(chalk.red(`Error: unknown profile "${name}".`))
        process.exitCode = 1
        return
      }
      configManager.setActiveProfile(name)
      console.log(chalk.green(`✓ Active profile set to: ${name}`))
    })

  profileCmd
    .command('delete')
    .description('Soft-delete a profile (moves to tombstones; restorable via `bbl config profile restore`)')
    .argument('<name>', 'Profile name')
    .action((name: string) => {
      const configManager = ConfigManager.getInstance()
      if (!configManager.hasProfile(name) && !configManager.isProfileTombstoned(name)) {
        console.error(chalk.red(`Error: unknown profile "${name}".`))
        process.exitCode = 1
        return
      }
      if (configManager.isProfileTombstoned(name)) {
        console.error(chalk.red(`Error: profile "${name}" is already tombstoned.`))
        process.exitCode = 1
        return
      }
      configManager.deleteProfile(name)
      console.log(chalk.green(`✓ Profile "${name}" moved to tombstones.`))
    })

  profileCmd
    .command('restore')
    .description('Remove a profile from tombstones (does not recreate the profile config)')
    .argument('<name>', 'Profile name')
    .action((name: string) => {
      const configManager = ConfigManager.getInstance()
      if (!configManager.isProfileTombstoned(name)) {
        console.error(chalk.red(`Error: profile "${name}" is not tombstoned.`))
        process.exitCode = 1
        return
      }
      const ok = configManager.restoreProfile(name)
      if (!ok) {
        console.error(chalk.red(`Error: failed to restore profile "${name}".`))
        process.exitCode = 1
        return
      }
      console.log(chalk.green(`✓ Profile "${name}" tombstone cleared. Recreate the profile before selecting it again.`))
    })
}
