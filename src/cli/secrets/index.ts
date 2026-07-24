/**
 * Secrets/Keychain module for BabeL-O.
 *
 * Provides a unified interface for storing and retrieving API keys
 * using the system keychain (macOS Keychain, Windows Credential Manager,
 * Linux Secret Service) with environment variable fallback.
 */

import type { SecretProvider, SecretOptions } from './types.js';
import { SecretNotAvailableError } from './types.js';
import { DarwinKeychainProvider } from './keychain-darwin.js';
import { WindowsKeychainProvider } from './keychain-win32.js';
import { LinuxKeychainProvider } from './keychain-linux.js';
import { FallbackEnvProvider } from './fallback.js';

// Singleton provider instance
let _provider: SecretProvider | null = null;

/**
 * Get the appropriate secret provider for the current platform.
 */
function createProvider(options?: SecretOptions): SecretProvider {
  const platform = process.platform;

  // Try platform-specific keychain first
  let provider: SecretProvider;

  switch (platform) {
    case 'darwin':
      provider = new DarwinKeychainProvider();
      break;
    case 'win32':
      provider = new WindowsKeychainProvider();
      break;
    case 'linux':
      provider = new LinuxKeychainProvider();
      break;
    default:
      // Unknown platform, use fallback
      return new FallbackEnvProvider(options);
  }

  return provider;
}

/**
 * Get the secret provider instance.
 * Caches the provider for subsequent calls.
 */
async function getProvider(options?: SecretOptions): Promise<SecretProvider> {
  if (_provider) {
    return _provider;
  }

  const provider = createProvider(options);
  _provider = provider;

  return provider;
}

/**
 * Check if the system keychain is available.
 * Returns false if we're in a non-interactive environment (CI, containers)
 * or if the platform-specific keychain is not accessible.
 */
export async function isKeychainAvailable(): Promise<boolean> {
  // Check if we're in a TTY environment
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return false;
  }

  const provider = await getProvider();
  return provider.isAvailable();
}

/**
 * Get an API key from the keychain or environment variables.
 *
 * @param providerId - The provider ID (e.g., 'anthropic', 'openai')
 * @param options - Options for the operation
 * @returns The API key, or undefined if not found
 */
export async function getSecret(
  providerId: string,
  options?: SecretOptions
): Promise<string | undefined> {
  // If plain mode, don't use keychain
  if (options?.plain) {
    return undefined;
  }

  const provider = await getProvider(options);

  // Try keychain first
  if (await provider.isAvailable()) {
    const key = await provider.get(providerId);
    if (key) {
      return key;
    }
  }

  // Fall back to environment variables
  const fallback = new FallbackEnvProvider(options);
  return fallback.get(providerId);
}

/**
 * Store an API key in the keychain.
 *
 * @param providerId - The provider ID
 * @param apiKey - The API key to store
 * @param options - Options for the operation
 * @throws SecretNotAvailableError if keychain is not available
 */
export async function setSecret(
  providerId: string,
  apiKey: string,
  options?: SecretOptions
): Promise<void> {
  // If plain mode, don't use keychain (caller should handle plaintext)
  if (options?.plain) {
    return;
  }

  const provider = await getProvider(options);

  if (!(await provider.isAvailable())) {
    throw new SecretNotAvailableError(
      process.platform,
      'Keychain not available. Set API key via environment variable or use --plain flag.'
    );
  }

  await provider.set(providerId, apiKey);
}

/**
 * Delete an API key from the keychain.
 *
 * @param providerId - The provider ID
 * @param options - Options for the operation
 * @returns true if the key was deleted, false if it didn't exist
 */
export async function deleteSecret(
  providerId: string,
  options?: SecretOptions
): Promise<boolean> {
  const provider = await getProvider(options);

  if (!(await provider.isAvailable())) {
    return false;
  }

  return provider.delete(providerId);
}

/**
 * List all provider IDs that have stored API keys.
 *
 * @param options - Options for the operation
 * @returns Array of provider IDs with stored keys
 */
export async function listSecrets(options?: SecretOptions): Promise<string[]> {
  const provider = await getProvider(options);
  const keychainKeys: string[] = [];

  // Get keys from keychain
  if (await provider.isAvailable()) {
    keychainKeys.push(...(await provider.list()));
  }

  // Get keys from environment
  const fallback = new FallbackEnvProvider(options);
  const envKeys = await fallback.list();

  // Merge and deduplicate
  return [...new Set([...keychainKeys, ...envKeys])];
}

/**
 * Get the storage location for a provider's API key.
 *
 * @param providerId - The provider ID
 * @param options - Options for the operation
 * @returns 'keychain' | 'env' | 'config' | 'none'
 */
export async function getSecretStorageLocation(
  providerId: string,
  options?: SecretOptions
): Promise<'keychain' | 'env' | 'config' | 'none'> {
  // Check keychain first
  const provider = await getProvider(options);
  if (await provider.isAvailable()) {
    const key = await provider.get(providerId);
    if (key) {
      return 'keychain';
    }
  }

  // Check environment
  const fallback = new FallbackEnvProvider(options);
  const envKey = await fallback.get(providerId);
  if (envKey) {
    return 'env';
  }

  return 'none';
}

// Re-export types
export * from './types.js';
