import chalk from 'chalk'
import readline from 'node:readline'
import { Command } from 'commander'
import {
  ConfigManager,
  DEFAULT_BABEL_X_CONFIG_FILE,
  loadBabeLXConfigImportPlan,
  validateModelSelectionAuth,
} from '../../shared/config.js'
import { modelRegistry, providerRegistry } from '../../providers/registry.js'
import { ProviderAdapter } from '../../providers/registry.js'
import {
  isKeychainAvailable,
  getSecret,
  setSecret,
  deleteSecret,
  listSecrets,
  getSecretStorageLocation,
} from '../secrets/index.js'

export function registerConfigCommand(program: Command): void {
  const configCmd = program.command('config').description('Manage configuration')

  // === init: Interactive configuration wizard ===
  configCmd
    .command('init')
    .description('Interactive configuration wizard for first-time setup')
    .option('--non-interactive', 'Run without interactive prompts (requires --provider and --model)')
    .option('--provider <provider>', 'Provider ID (for non-interactive mode)')
    .option('--model <model>', 'Model ID (for non-interactive mode)')
    .action(async (options: { nonInteractive?: boolean; provider?: string; model?: string }) => {
      await runConfigInit(options)
    })

  // === migrate: Migrate API keys to keychain ===
  configCmd
    .command('migrate')
    .description('Migrate plaintext API keys to system keychain')
    .option('--provider <provider>', 'Migrate only the specified provider')
    .action(async (options: { provider?: string }) => {
      await runConfigMigrate(options)
    })

  // === audit: Show credential storage status ===
  configCmd
    .command('audit')
    .description('Audit credential storage locations')
    .action(async () => {
      await runConfigAudit()
    })

  configCmd

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
    .description('Configure credentials for a provider (stores in keychain by default)')
    .argument('<provider>', 'Provider ID (e.g., anthropic, openai)')
    .argument('<key>', 'API Key')
    .argument('[baseUrl]', 'Custom Base URL')
    .option('--plain', 'Store API key in plaintext config file instead of keychain')
    .action(async (provider: string, key: string, baseUrl: string | undefined, options: { plain?: boolean }) => {
      const configManager = ConfigManager.getInstance()

      // Store API key using keychain by default
      const result = await configManager.setApiKeyWithKeychain(provider, key, { plain: options.plain })

      // Store base URL separately (always in config file)
      if (baseUrl) {
        const existing = configManager.getProviderConfig(provider)
        configManager.setProviderConfig(provider, { ...existing, baseUrl })
      }

      if (result.stored === 'keychain') {
        console.log(chalk.green(`✓ API key for ${provider} stored in system keychain`))
      } else {
        console.log(chalk.yellow(`⚠ API key for ${provider} stored in config file (keychain not available)`))
        console.log(chalk.dim('  For better security, consider setting API key via environment variable.'))
      }

      if (baseUrl) {
        console.log(chalk.dim(`  Base URL: ${baseUrl}`))
      }
    })

  // === config provider add: Interactive custom provider setup ===
  configCmd
    .command('provider')
    .description('Manage custom providers')
    .argument('<subcommand>', 'Subcommand: add, list, show, remove')
    .argument('[providerId]', 'Provider ID')
    .action(async (subcommand: string, providerId?: string) => {
      if (subcommand === 'add') {
        await runProviderAddWizard()
      } else if (subcommand === 'show') {
        await runProviderShow(providerId)
      } else if (subcommand === 'remove') {
        await runProviderRemove(providerId)
      } else {
        await runProviderList()
      }
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
      const authIssue = validateModelSelectionAuth(configManager, modelId)
      if (authIssue) {
        console.error(chalk.red(`Error: ${authIssue.message}`))
        process.exitCode = 1
        return
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

// === Helper functions for init/migrate/audit ===

async function runConfigInit(options: {
  nonInteractive?: boolean
  provider?: string
  model?: string
}): Promise<void> {
  const configManager = ConfigManager.getInstance()
  const existing = configManager.load()
  const hasExistingConfig = existing.providers && Object.keys(existing.providers).length > 0

  if (options.nonInteractive) {
    // Non-interactive mode
    if (!options.provider || !options.model) {
      console.error(chalk.red('Error: --provider and --model are required in non-interactive mode'))
      process.exitCode = 1
      return
    }

    const provider = options.provider
    const model = options.model

    // Validate provider
    const providerDef = providerRegistry.find(p => p.id === provider)
    if (!providerDef) {
      console.error(chalk.red(`Error: Unknown provider "${provider}"`))
      process.exitCode = 1
      return
    }

    // API key should be provided via environment variable in non-interactive mode
    const apiKey = process.env.BABEL_O_API_KEY || process.env[`${provider.toUpperCase()}_API_KEY`]
    if (!apiKey && provider !== 'local') {
      console.error(chalk.red(`Error: No API key found. Set ${provider.toUpperCase()}_API_KEY environment variable.`))
      process.exitCode = 1
      return
    }

    // Set default model
    configManager.setDefaultModel(model)
    console.log(chalk.green(`✓ Configuration complete: provider=${provider}, model=${model}`))
    console.log(chalk.dim('\nRun `bbl go` to start the terminal UI.\n'))
    return
  }

  // Interactive mode
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error(chalk.red('Error: Interactive mode requires a TTY. Use --non-interactive or set environment variables.'))
    process.exitCode = 1
    return
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  try {
    console.log(chalk.cyan.bold('\n--- BabeL-O Configuration Setup ---\n'))

    if (hasExistingConfig) {
      const proceed = await askQuestion(rl, 'Found existing configuration. Continue? [y/N]: ')
      if (proceed.toLowerCase() !== 'y' && proceed.toLowerCase() !== 'yes') {
        console.log(chalk.yellow('Cancelled.'))
        return
      }
    }

    // List available providers
    const availableProviders = providerRegistry.filter(p => p.id !== 'local')
    console.log('Select a provider:')
    availableProviders.forEach((p, i) => {
      console.log(`  ${i + 1}. ${p.displayName} (${p.id})`)
    })

    const providerChoice = await askQuestion(rl, '\nProvider [1-' + availableProviders.length + ']: ')
    const providerIndex = parseInt(providerChoice, 10) - 1
    if (providerIndex < 0 || providerIndex >= availableProviders.length) {
      console.log(chalk.red('Invalid selection.'))
      process.exitCode = 1
      return
    }

    const provider = availableProviders[providerIndex]
    console.log(chalk.dim(`\nSelected: ${provider.displayName}\n`))

    // Get API key (hidden input)
    const apiKey = await askHiddenInput(rl, `API key for ${provider.id}: `)
    if (!apiKey || apiKey.trim() === '') {
      console.log(chalk.red('Error: API key is required.'))
      process.exitCode = 1
      return
    }

    // Store in keychain if available
    const keychainAvailable = await isKeychainAvailable()
    if (keychainAvailable) {
      try {
        await setSecret(provider.id, apiKey.trim())
        console.log(chalk.green('✓ API key stored in system keychain'))
      } catch (error) {
        console.log(chalk.yellow('⚠ Failed to store in keychain, falling back to config file'))
        configManager.setProviderConfig(provider.id, { apiKey: apiKey.trim() })
      }
    } else {
      // No keychain, store in config file
      configManager.setProviderConfig(provider.id, { apiKey: apiKey.trim() })
      console.log(chalk.yellow('⚠ Keychain not available. API key stored in config file.'))
      console.log(chalk.dim('  For better security, consider setting API key via environment variable.'))
    }

    // Select default model
    const models = modelRegistry.filter(m => m.id.startsWith(`${provider.id}/`))
    console.log('\nSelect default model:')
    const displayModels = models.slice(0, 10) // Show first 10
    displayModels.forEach((m, i) => {
      const recommended = i === 0 ? ' (recommended)' : ''
      console.log(`  ${i + 1}. ${m.name}${recommended}`)
    })

    const modelChoice = await askQuestion(rl, '\nModel [1]: ')
    const modelIndex = modelChoice.trim() === '' ? 0 : parseInt(modelChoice, 10) - 1
    if (modelIndex < 0 || modelIndex >= displayModels.length) {
      console.log(chalk.red('Invalid selection.'))
      process.exitCode = 1
      return
    }

    const model = displayModels[modelIndex]
    configManager.setDefaultModel(model.id)

    console.log(chalk.green.bold('\n✓ Configuration complete!'))
    console.log(chalk.dim(`  Provider: ${provider.displayName}`))
    console.log(chalk.dim(`  Model: ${model.name}`))
    console.log(chalk.dim('\nRun `bbl go` to start the terminal UI.\n'))
  } finally {
    rl.close()
  }
}

async function runConfigMigrate(options: { provider?: string }): Promise<void> {
  const configManager = ConfigManager.getInstance()
  const config = configManager.load()

  const keychainAvailable = await isKeychainAvailable()
  if (!keychainAvailable) {
    console.log(chalk.red('Error: System keychain is not available.'))
    console.log(chalk.dim('  Make sure you are running in a TTY environment.'))
    process.exitCode = 1
    return
  }

  const providers = options.provider
    ? [options.provider]
    : Object.keys(config.providers || {}).filter(p => p !== 'local')

  if (providers.length === 0) {
    console.log(chalk.yellow('No API keys to migrate.'))
    return
  }

  console.log(chalk.cyan.bold('\n--- Migrating API Keys to Keychain ---\n'))

  let migrated = 0
  let failed = 0

  for (const providerId of providers) {
    const provConfig = config.providers?.[providerId]
    if (!provConfig?.apiKey) {
      continue
    }

    try {
      await setSecret(providerId, provConfig.apiKey)

      // Remove from config file
      const newConfig = { ...config }
      if (newConfig.providers?.[providerId]) {
        delete newConfig.providers[providerId].apiKey
      }
      configManager.save(newConfig)

      console.log(chalk.green(`✓ Migrated: ${providerId}`))
      migrated++
    } catch (error) {
      console.log(chalk.red(`✗ Failed: ${providerId} - ${error}`))
      failed++
    }
  }

  console.log(chalk.dim(`\nMigrated: ${migrated}, Failed: ${failed}\n`))
}

async function runConfigAudit(): Promise<void> {
  const configManager = ConfigManager.getInstance()
  const config = configManager.load()

  console.log(chalk.cyan.bold('\n--- Credential Storage Audit ---\n'))

  const keychainKeys = await listSecrets()
  const configProviders = Object.keys(config.providers || {}).filter(p => p !== 'local')
  const envProviders: string[] = []

  // Check environment variables
  for (const provider of providerRegistry) {
    if (provider.id === 'local') continue
    const envVar = `${provider.id.toUpperCase()}_API_KEY`
    if (process.env[envVar] || process.env.BABEL_O_API_KEY) {
      envProviders.push(provider.id)
    }
  }

  console.log(chalk.bold('Keychain:'))
  if (keychainKeys.length > 0) {
    for (const key of keychainKeys) {
      console.log(chalk.green(`  ✓ ${key}`))
    }
  } else {
    console.log(chalk.dim('  (none)'))
  }

  console.log(chalk.bold('\nConfig File:'))
  if (configProviders.length > 0) {
    for (const provider of configProviders) {
      const hasKey = config.providers?.[provider]?.apiKey
      if (hasKey) {
        console.log(chalk.yellow(`  ⚠ ${provider} (plaintext)`))
      } else {
        console.log(chalk.dim(`  ${provider} (baseUrl only)`))
      }
    }
  } else {
    console.log(chalk.dim('  (none)'))
  }

  console.log(chalk.bold('\nEnvironment Variables:'))
  if (envProviders.length > 0) {
    for (const provider of envProviders) {
      console.log(chalk.blue(`  ${provider}`))
    }
  } else {
    console.log(chalk.dim('  (none)'))
  }

  const plaintextCount = configProviders.filter(p => config.providers?.[p]?.apiKey).length
  if (plaintextCount > 0) {
    console.log(chalk.yellow(`\n⚠ ${plaintextCount} API key(s) stored in plaintext. Run \`bbl config migrate\` to move to keychain.`))
  } else {
    console.log(chalk.green('\n✓ All API keys are stored securely.'))
  }

  console.log()
}

function askQuestion(rl: readline.Interface, question: string): Promise<string> {
  return new Promise(resolve => {
    rl.question(question, answer => {
      resolve(answer)
    })
  })
}

function askHiddenInput(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise(resolve => {
    process.stdout.write(prompt)
    process.stdin.setRawMode(true)
    process.stdin.resume()

    let input = ''
    process.stdin.on('data', (char: Buffer) => {
      const c = char.toString('utf8')

      switch (c) {
        case '\n':
        case '\r':
        case '\u0004': // Ctrl+D
          process.stdin.setRawMode(false)
          process.stdin.pause()
          process.stdout.write('\n')
          resolve(input)
          break
        case '\u0003': // Ctrl+C
          process.stdout.write('\n')
          process.exit(1)
          break
        default:
          input += c
          break
      }
    })
  })
}


// ========================================================================
// Custom provider subcommands
// ========================================================================

async function runProviderAddWizard(): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  try {
    console.log(chalk.cyan.bold('\n=== Add Custom Provider ==='))
    console.log(chalk.dim('This will register a new provider not in the built-in list.\n'))

    const providerId = await askQuestion(rl, 'Provider ID (e.g., my-custom): ')
    const displayName = await askQuestion(rl, `Display name (${providerId}): `) || providerId

    console.log(chalk.dim('\nChoose the API format (wire protocol):'))
    console.log(chalk.dim('  [1] OpenAI-compatible (default) — /chat/completions, Bearer token'))
    console.log(chalk.dim('  [2] Anthropic-compatible — /v1/messages, x-api-key header'))
    const fmtChoice = (await askQuestion(rl, 'Protocol [1/2] (1): ')).trim() || '1'
    const adapter = fmtChoice === '2' ? 'anthropic-compatible' : 'openai-compatible'

    const baseUrl = await askQuestion(rl, 'Base URL (e.g., https://api.my-provider.com): ')
    const apiKey = await askHiddenInput(rl, 'API Key: ')

    const defaultModel = await askQuestion(rl, 'Default model ID (e.g., my-custom-model): ')

    const configManager = ConfigManager.getInstance()

    if (apiKey) {
      const result = await configManager.setApiKeyWithKeychain(providerId, apiKey, { plain: false })
      if (result.stored === 'keychain') {
        console.log(chalk.green(`✓ API key for "${providerId}" stored in system keychain`))
      } else {
        console.log(chalk.yellow(`⚠ API key stored in config file (keychain not available)`))
      }
    }

    const existing = configManager.getProviderConfig(providerId)
    configManager.setProviderConfig(providerId, {
      ...existing,
      baseUrl: baseUrl || undefined,
      adapter,
    })

    const config = configManager.load()
    const profileId = config.activeProfile || 'default'
    if (!config.profiles) config.profiles = {}
    config.profiles[profileId] = {
      ...config.profiles[profileId],
      provider: providerId,
      model: defaultModel ? `${providerId}/${defaultModel}` : `${providerId}/custom`,
      baseUrl: baseUrl || undefined,
    }
    configManager.save(config)

    console.log(chalk.green(`
✓ Custom provider "${displayName}" (${providerId}) configured.`))
    console.log(chalk.dim(`  Profile: ${profileId}`))
    console.log(chalk.dim(`  Protocol: ${adapter}`))
    console.log(chalk.dim(`  Base URL: ${baseUrl || '(default)'}`))
    console.log(chalk.dim(`  Default model: ${defaultModel}`))
    console.log(chalk.bold('\n  You can now use this provider by running: bbl'))
    console.log(chalk.dim('  Or switch in the TUI with: /model'))
  } finally {
    rl.close()
  }
}

async function runProviderList(): Promise<void> {
  const configManager = ConfigManager.getInstance()
  const config = configManager.load()
  const customProviders = config.providers ? Object.keys(config.providers).filter(id => {
    try {
      false
      return false
    } catch {
      return true
    }
  }) : []
  const builtinProviders = providerRegistry.map(p => p.id)

  console.log(chalk.cyan.bold('\n--- Built-in Providers ---'))
  for (const id of builtinProviders) {
    const hasConfig = config.providers?.[id]?.apiKey || config.providers?.[id]?.baseUrl
    console.log(chalk.blue(`  ${id}`) + (hasConfig ? chalk.dim(' (configured)') : chalk.dim('')))
  }

  if (customProviders.length > 0) {
    console.log(chalk.cyan.bold('\n--- Custom Providers ---'))
    for (const id of customProviders) {
      const cfg = config.providers?.[id]
      console.log(chalk.blue(`  ${id}`) + chalk.dim(` (${cfg?.adapter || 'openai-compatible'})`))
    }
  }

  console.log()
}

async function runProviderShow(providerId?: string): Promise<void> {
  if (!providerId) {
    console.log(chalk.red('Error: provider ID is required for "show". Usage: bbl config provider show <providerId>'))
    return
  }
  const configManager = ConfigManager.getInstance()
  const config = configManager.load()
  const cfg = config.providers?.[providerId]
  if (!cfg) {
    console.log(chalk.red(`No configuration found for provider: ${providerId}`))
    return
  }
  console.log(chalk.cyan.bold(`
--- Provider: ${providerId} ---`))
  console.log(chalk.dim(`  Adapter: ${cfg.adapter || '(registry default)'}`))
  console.log(chalk.dim(`  Base URL: ${cfg.baseUrl || '(registry default)'}`))
  console.log(chalk.dim(`  API Key: ${cfg.apiKey ? '********' : '(not set)'}`))
  console.log()
}

async function runProviderRemove(providerId?: string): Promise<void> {
  if (!providerId) {
    console.log(chalk.red('Error: provider ID is required for "remove". Usage: bbl config provider remove <providerId>'))
    return
  }
  const configManager = ConfigManager.getInstance()
  const config = configManager.load()
  if (config.providers?.[providerId]) {
    delete config.providers[providerId]
    configManager.save(config)
    console.log(chalk.green(`✓ Provider "${providerId}" removed from config.`))
  } else {
    console.log(chalk.yellow(`No configuration found for provider: ${providerId}`))
  }
}
