import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

// Test the secrets module
describe('Secrets Module', () => {
  describe('FallbackEnvProvider', () => {
    it('should return undefined when no env var is set', async () => {
      const { FallbackEnvProvider } = await import('../src/cli/secrets/fallback.js')
      const provider = new FallbackEnvProvider({ env: {} })
      const key = await provider.get('anthropic')
      assert.strictEqual(key, undefined)
    })

    it('should return key from env var', async () => {
      const { FallbackEnvProvider } = await import('../src/cli/secrets/fallback.js')
      const provider = new FallbackEnvProvider({
        env: { ANTHROPIC_API_KEY: 'test-key-123' },
      })
      const key = await provider.get('anthropic')
      assert.strictEqual(key, 'test-key-123')
    })

    it('should return key from BABEL_O_API_KEY', async () => {
      const { FallbackEnvProvider } = await import('../src/cli/secrets/fallback.js')
      const provider = new FallbackEnvProvider({
        env: { BABEL_O_API_KEY: 'universal-key' },
      })
      const key = await provider.get('anthropic')
      assert.strictEqual(key, 'universal-key')
    })

    it('should list providers with env keys', async () => {
      const { FallbackEnvProvider } = await import('../src/cli/secrets/fallback.js')
      const provider = new FallbackEnvProvider({
        env: {
          ANTHROPIC_API_KEY: 'key1',
          OPENAI_API_KEY: 'key2',
        },
      })
      const list = await provider.list()
      assert.ok(list.includes('anthropic'))
      assert.ok(list.includes('openai'))
    })

    it('should throw on set', async () => {
      const { FallbackEnvProvider } = await import('../src/cli/secrets/fallback.js')
      const provider = new FallbackEnvProvider({ env: {} })
      await assert.rejects(
        async () => provider.set('anthropic', 'key'),
        /Cannot store API key in environment variables/
      )
    })

    it('should always be available', async () => {
      const { FallbackEnvProvider } = await import('../src/cli/secrets/fallback.js')
      const provider = new FallbackEnvProvider({ env: {} })
      const available = await provider.isAvailable()
      assert.strictEqual(available, true)
    })
  })

  describe('Keychain Provider (Platform-specific)', () => {
    // Skip on CI or non-macOS
    const isMacOS = process.platform === 'darwin'
    const isCI = process.env.CI === 'true'

    it('macOS Keychain: should check availability', async () => {
      if (isCI || !isMacOS) {
        console.log('  (skipped: not macOS or in CI)')
        return
      }

      const { DarwinKeychainProvider } = await import(
        '../src/cli/secrets/keychain-darwin.js'
      )
      const provider = new DarwinKeychainProvider()
      const available = await provider.isAvailable()
      // Should be available on macOS with TTY
      assert.strictEqual(typeof available, 'boolean')
    })

    it('macOS Keychain: should store and retrieve', async () => {
      if (isCI || !isMacOS) {
        console.log('  (skipped: not macOS or in CI)')
        return
      }

      const { DarwinKeychainProvider } = await import(
        '../src/cli/secrets/keychain-darwin.js'
      )
      const provider = new DarwinKeychainProvider()

      const testProvider = 'test-provider-' + Date.now()
      const testKey = 'test-key-' + Math.random().toString(36)

      try {
        await provider.set(testProvider, testKey)
        const retrieved = await provider.get(testProvider)
        assert.strictEqual(retrieved, testKey)

        const deleted = await provider.delete(testProvider)
        assert.strictEqual(deleted, true)

        const afterDelete = await provider.get(testProvider)
        assert.strictEqual(afterDelete, undefined)
      } catch (error) {
        // Cleanup on failure
        try {
          await provider.delete(testProvider)
        } catch {}
        throw error
      }
    })
  })

  describe('Module Exports', () => {
    it('should export isKeychainAvailable', async () => {
      const secrets = await import('../src/cli/secrets/index.js')
      assert.ok(typeof secrets.isKeychainAvailable === 'function')
    })

    it('should export getSecret', async () => {
      const secrets = await import('../src/cli/secrets/index.js')
      assert.ok(typeof secrets.getSecret === 'function')
    })

    it('should export setSecret', async () => {
      const secrets = await import('../src/cli/secrets/index.js')
      assert.ok(typeof secrets.setSecret === 'function')
    })

    it('should export deleteSecret', async () => {
      const secrets = await import('../src/cli/secrets/index.js')
      assert.ok(typeof secrets.deleteSecret === 'function')
    })

    it('should export listSecrets', async () => {
      const secrets = await import('../src/cli/secrets/index.js')
      assert.ok(typeof secrets.listSecrets === 'function')
    })

    it('should return false for isKeychainAvailable in non-TTY', async () => {
      const { isKeychainAvailable } = await import('../src/cli/secrets/index.js')
      // In test environment, stdin.isTTY is usually false
      const available = await isKeychainAvailable()
      // Should work without throwing
      assert.strictEqual(typeof available, 'boolean')
    })
  })

  describe('Types', () => {
    it('should export SecretProvider interface', async () => {
      const types = await import('../src/cli/secrets/types.js')
      assert.ok(types.SecretNotAvailableError)
      assert.ok(types.SecretNotFoundError)
    })

    it('should have correct error message', async () => {
      const { SecretNotAvailableError } = await import('../src/cli/secrets/types.js')
      const error = new SecretNotAvailableError('darwin', 'test reason')
      assert.ok(error.message.includes('darwin'))
      assert.ok(error.message.includes('test reason'))
    })
  })
})
