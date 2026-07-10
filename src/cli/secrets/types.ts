/**
 * Types and interfaces for the secrets/keychain module.
 */

/**
 * Error thrown when keychain is not available on the current platform
 * or in the current environment (e.g., non-interactive shell).
 */
export class SecretNotAvailableError extends Error {
  constructor(
    public readonly platform: string,
    public readonly reason: string = 'Keychain not available'
  ) {
    super(`Keychain not available on ${platform}: ${reason}`);
    this.name = 'SecretNotAvailableError';
  }
}

/**
 * Error thrown when a secret is not found.
 */
export class SecretNotFoundError extends Error {
  constructor(public readonly providerId: string) {
    super(`API key not found for provider: ${providerId}`);
    this.name = 'SecretNotFoundError';
  }
}

/**
 * Provider for storing and retrieving secrets from the system keychain.
 */
export interface SecretProvider {
  /**
   * Check if the keychain is available on this platform/environment.
   */
  isAvailable(): Promise<boolean>;

  /**
   * Get an API key from the keychain.
   * @returns The API key, or undefined if not found
   */
  get(providerId: string): Promise<string | undefined>;

  /**
   * Store an API key in the keychain.
   */
  set(providerId: string, apiKey: string): Promise<void>;

  /**
   * Delete an API key from the keychain.
   * @returns true if the key was deleted, false if it didn't exist
   */
  delete(providerId: string): Promise<boolean>;

  /**
   * List all provider IDs that have stored API keys.
   */
  list(): Promise<string[]>;
}

/**
 * Options for secret operations.
 */
export interface SecretOptions {
  /**
   * Environment variables to use instead of process.env
   */
  env?: NodeJS.ProcessEnv;

  /**
   * Use plaintext fallback (config file) instead of keychain
   */
  plain?: boolean;
}

/**
 * The service name used for keychain entries.
 * Format: babel-o-{provider}
 */
export const KEYCHAIN_SERVICE_PREFIX = 'babel-o';

/**
 * Account name for keychain entries.
 */
export const KEYCHAIN_ACCOUNT = 'apiKey';
