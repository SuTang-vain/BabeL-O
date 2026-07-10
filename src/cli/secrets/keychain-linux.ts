/**
 * Linux Secret Service implementation using `secret-tool` CLI.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { SecretProvider } from './types.js';
import { KEYCHAIN_SERVICE_PREFIX } from './types.js';

const execFileAsync = promisify(execFile);

/**
 * Secret provider for Linux using the Secret Service API (GNOME Keyring, KDE Wallet, etc.).
 * Uses the `secret-tool` command-line utility from libsecret.
 */
export class LinuxKeychainProvider implements SecretProvider {
  private getLabel(providerId: string): string {
    return `${KEYCHAIN_SERVICE_PREFIX}-${providerId}`;
  }

  async isAvailable(): Promise<boolean> {
    try {
      if (process.platform !== 'linux') {
        return false;
      }

      // Check if secret-tool exists and can connect to the secret service
      await execFileAsync('secret-tool', ['search', '--all']);
      return true;
    } catch (error) {
      // secret-tool not found or secret service not available
      return false;
    }
  }

  async get(providerId: string): Promise<string | undefined> {
    const label = this.getLabel(providerId);

    try {
      const { stdout } = await execFileAsync('secret-tool', [
        'lookup',
        'service', KEYCHAIN_SERVICE_PREFIX,
        'provider', providerId,
      ]);

      return stdout.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  async set(providerId: string, apiKey: string): Promise<void> {
    const label = this.getLabel(providerId);

    // Store the secret with attributes for lookup
    // Use exec with stdin pipe for the secret input
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync2 = promisify(execFile) as unknown as (
      file: string,
      args: readonly string[],
      options: { encoding?: string; input?: string }
    ) => Promise<{ stdout: string; stderr: string }>;

    await execFileAsync2('secret-tool', [
      'store',
      '--label', label,
      'service', KEYCHAIN_SERVICE_PREFIX,
      'provider', providerId,
    ], {
      input: apiKey,
      encoding: 'utf-8',
    });
  }

  async delete(providerId: string): Promise<boolean> {
    try {
      await execFileAsync('secret-tool', [
        'clear',
        'service', KEYCHAIN_SERVICE_PREFIX,
        'provider', providerId,
      ]);
      return true;
    } catch {
      return false;
    }
  }

  async list(): Promise<string[]> {
    try {
      // Search for all babel-o secrets
      const { stdout } = await execFileAsync('secret-tool', [
        'search',
        '--all',
        'service', KEYCHAIN_SERVICE_PREFIX,
      ]);

      const providers: string[] = [];
      const lines = stdout.split('\n');

      for (const line of lines) {
        // Look for provider attribute in the output
        const match = line.match(/provider\s*=\s*(.+)/);
        if (match) {
          providers.push(match[1].trim());
        }
      }

      // Deduplicate
      return [...new Set(providers)];
    } catch {
      return [];
    }
  }
}
