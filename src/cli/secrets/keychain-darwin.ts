/**
 * macOS Keychain implementation using the `security` CLI.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { SecretProvider } from './types.js';
import { KEYCHAIN_SERVICE_PREFIX, KEYCHAIN_ACCOUNT } from './types.js';

const execFileAsync = promisify(execFile);

/**
 * Secret provider for macOS using the Keychain.
 * Uses the `security` command-line tool to store and retrieve passwords.
 */
export class DarwinKeychainProvider implements SecretProvider {
  private getServiceName(providerId: string): string {
    return `${KEYCHAIN_SERVICE_PREFIX}-${providerId}`;
  }

  async isAvailable(): Promise<boolean> {
    try {
      // Check if we're on macOS and security command exists
      if (process.platform !== 'darwin') {
        return false;
      }

      // Try to list keychains to verify access
      await execFileAsync('security', ['list-keychains']);
      return true;
    } catch {
      return false;
    }
  }

  async get(providerId: string): Promise<string | undefined> {
    const serviceName = this.getServiceName(providerId);

    try {
      const { stdout } = await execFileAsync('security', [
        'find-generic-password',
        '-a', KEYCHAIN_ACCOUNT,
        '-s', serviceName,
        '-w', // Output password only
      ]);

      return stdout.trim() || undefined;
    } catch (error) {
      // If the item doesn't exist, return undefined
      if (error instanceof Error && error.message.includes('The specified item could not be found')) {
        return undefined;
      }
      throw error;
    }
  }

  async set(providerId: string, apiKey: string): Promise<void> {
    const serviceName = this.getServiceName(providerId);

    // Delete existing entry first (security add-generic-password fails if exists)
    try {
      await execFileAsync('security', [
        'delete-generic-password',
        '-a', KEYCHAIN_ACCOUNT,
        '-s', serviceName,
      ]);
    } catch {
      // Ignore if it doesn't exist
    }

    // Add new entry
    await execFileAsync('security', [
      'add-generic-password',
      '-a', KEYCHAIN_ACCOUNT,
      '-s', serviceName,
      '-w', apiKey,
    ]);
  }

  async delete(providerId: string): Promise<boolean> {
    const serviceName = this.getServiceName(providerId);

    try {
      await execFileAsync('security', [
        'delete-generic-password',
        '-a', KEYCHAIN_ACCOUNT,
        '-s', serviceName,
      ]);
      return true;
    } catch (error) {
      // If the item doesn't exist, return false
      if (error instanceof Error && error.message.includes('The specified item could not be found')) {
        return false;
      }
      throw error;
    }
  }

  async list(): Promise<string[]> {
    try {
      // Dump keychain and grep for babel-o entries
      const { stdout } = await execFileAsync('security', [
        'dump-keychain',
      ]);

      const providers: string[] = [];
      const lines = stdout.split('\n');
      const prefix = `${KEYCHAIN_SERVICE_PREFIX}-`;

      for (const line of lines) {
        // Look for "svce" attribute which contains the service name
        const match = line.match(/"svce"<blob>="([^"]+)"/);
        if (match && match[1].startsWith(prefix)) {
          const providerId = match[1].slice(prefix.length);
          providers.push(providerId);
        }
      }

      return providers;
    } catch {
      // If we can't dump keychain, return empty list
      return [];
    }
  }
}
