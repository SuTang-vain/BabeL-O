import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

// Test the config init/migrate/audit commands
describe('Config Commands', () => {
  describe('config init (non-interactive)', () => {
    it('should fail without --provider and --model in non-interactive mode', async () => {
      // This is tested via CLI, just verify the function exists
      const config = await import('../src/cli/commands/config.js')
      assert.ok(typeof config.registerConfigCommand === 'function')
    })
  })

  describe('ConfigManager integration', () => {
    const tempDir = path.join(os.tmpdir(), 'babel-o-config-test-' + Date.now())
    const configFile = path.join(tempDir, 'config.json')

    beforeEach(() => {
      fs.mkdirSync(tempDir, { recursive: true })
    })

    afterEach(() => {
      fs.rmSync(tempDir, { recursive: true, force: true })
    })

    it('should create and load config', async () => {
      const { ConfigManager } = await import('../src/shared/config.js')

      // Use temp config file
      process.env.BABEL_O_CONFIG_FILE = configFile

      const manager = ConfigManager.getInstance()
      const config = manager.load()

      assert.ok(typeof config === 'object')
    })

    it('should set provider config', async () => {
      const { ConfigManager } = await import('../src/shared/config.js')

      process.env.BABEL_O_CONFIG_FILE = configFile

      const manager = ConfigManager.getInstance()
      manager.setProviderConfig('anthropic', { apiKey: 'test-key' })

      const provConfig = manager.getProviderConfig('anthropic')
      assert.strictEqual(provConfig.apiKey, 'test-key')
    })

    it('should set default model', async () => {
      const { ConfigManager } = await import('../src/shared/config.js')

      process.env.BABEL_O_CONFIG_FILE = configFile

      const manager = ConfigManager.getInstance()
      manager.setDefaultModel('anthropic/claude-sonnet-4-6')

      const settings = manager.resolveSettings()
      assert.strictEqual(settings.modelId, 'anthropic/claude-sonnet-4-6')
    })
  })

  describe('Secrets integration', () => {
    it('should be able to import secrets module from config', async () => {
      // Just verify the import works
      const secrets = await import('../src/cli/secrets/index.js')
      assert.ok(secrets.isKeychainAvailable)
      assert.ok(secrets.getSecret)
      assert.ok(secrets.setSecret)
    })

    it('should use environment variable fallback', async () => {
      const { getSecret } = await import('../src/cli/secrets/index.js')

      // Set env var for test
      const originalEnv = process.env.ANTHROPIC_API_KEY
      process.env.ANTHROPIC_API_KEY = 'test-env-key'

      try {
        const key = await getSecret('anthropic', { plain: true })
        // Should get from env
        const keyFromEnv = await getSecret('anthropic')
        assert.strictEqual(keyFromEnv, 'test-env-key')
      } finally {
        process.env.ANTHROPIC_API_KEY = originalEnv
      }
    })
  })

  describe('resolveSettingsAsync with Keychain', () => {
    const tempDir = path.join(os.tmpdir(), 'babel-o-config-async-test-' + Date.now())
    const configFile = path.join(tempDir, 'config.json')

    beforeEach(() => {
      fs.mkdirSync(tempDir, { recursive: true })
      process.env.BABEL_O_CONFIG_FILE = configFile
    })

    afterEach(() => {
      fs.rmSync(tempDir, { recursive: true, force: true })
      delete process.env.BABEL_O_CONFIG_FILE
      delete process.env.ANTHROPIC_API_KEY
      delete process.env.OPENAI_API_KEY
      delete process.env.BABEL_O_API_KEY
    })

    it('should have resolveSettingsAsync method', async () => {
      const { ConfigManager } = await import('../src/shared/config.js')
      const manager = ConfigManager.getInstance()
      assert.ok(typeof manager.resolveSettingsAsync === 'function')
    })

    it('should return apiKeySource from env', async () => {
      const { ConfigManager } = await import('../src/shared/config.js')

      process.env.ANTHROPIC_API_KEY = 'env-key-123'

      const manager = ConfigManager.getInstance()
      const settings = await manager.resolveSettingsAsync()

      assert.strictEqual(settings.apiKey, 'env-key-123')
      assert.strictEqual(settings.apiKeySource, 'env')
    })

    it('should fallback to provider_config when no env or keychain', async () => {
      const { ConfigManager } = await import('../src/shared/config.js')

      const manager = ConfigManager.getInstance()

      // Set provider config with API key
      manager.setProviderConfig('anthropic', { apiKey: 'provider-config-key' })

      const settings = await manager.resolveSettingsAsync()

      assert.strictEqual(settings.apiKey, 'provider-config-key')
      assert.strictEqual(settings.apiKeySource, 'provider_config')
    })

    it('should prefer env over keychain and config', async () => {
      const { ConfigManager } = await import('../src/shared/config.js')

      process.env.ANTHROPIC_API_KEY = 'env-key-priority'

      const manager = ConfigManager.getInstance()
      manager.setProviderConfig('anthropic', { apiKey: 'config-key' })

      const settings = await manager.resolveSettingsAsync()

      // Env should win
      assert.strictEqual(settings.apiKey, 'env-key-priority')
      assert.strictEqual(settings.apiKeySource, 'env')
    })
  })

  describe('setApiKeyWithKeychain', () => {
    const tempDir = path.join(os.tmpdir(), 'babel-o-keychain-test-' + Date.now())
    const configFile = path.join(tempDir, 'config.json')

    beforeEach(() => {
      fs.mkdirSync(tempDir, { recursive: true })
      process.env.BABEL_O_CONFIG_FILE = configFile
    })

    afterEach(() => {
      fs.rmSync(tempDir, { recursive: true, force: true })
      delete process.env.BABEL_O_CONFIG_FILE
    })

    it('should have setApiKeyWithKeychain method', async () => {
      const { ConfigManager } = await import('../src/shared/config.js')
      const manager = ConfigManager.getInstance()
      assert.ok(typeof manager.setApiKeyWithKeychain === 'function')
    })

    it('should store in config file with --plain flag', async () => {
      const { ConfigManager } = await import('../src/shared/config.js')

      const manager = ConfigManager.getInstance()
      const result = await manager.setApiKeyWithKeychain('anthropic', 'test-key', { plain: true })

      assert.strictEqual(result.stored, 'config')

      const provConfig = manager.getProviderConfig('anthropic')
      assert.strictEqual(provConfig.apiKey, 'test-key')
    })

    it('should have migrateToKeychain method', async () => {
      const { ConfigManager } = await import('../src/shared/config.js')
      const manager = ConfigManager.getInstance()
      assert.ok(typeof manager.migrateToKeychain === 'function')
    })

    it('should have deleteApiKey method', async () => {
      const { ConfigManager } = await import('../src/shared/config.js')
      const manager = ConfigManager.getInstance()
      assert.ok(typeof manager.deleteApiKey === 'function')
    })

    it('should have getApiKeyLocation method', async () => {
      const { ConfigManager } = await import('../src/shared/config.js')
      const manager = ConfigManager.getInstance()
      assert.ok(typeof manager.getApiKeyLocation === 'function')
    })

    it('should return none for missing key location', async () => {
      const { ConfigManager } = await import('../src/shared/config.js')

      const manager = ConfigManager.getInstance()
      const location = await manager.getApiKeyLocation('nonexistent-provider')

      assert.strictEqual(location, 'none')
    })
  })
})

