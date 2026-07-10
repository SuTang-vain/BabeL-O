/**
 * Windows Credential Manager implementation using `cmdkey` CLI.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { SecretProvider } from './types.js';
import { KEYCHAIN_SERVICE_PREFIX, KEYCHAIN_ACCOUNT } from './types.js';

const execFileAsync = promisify(execFile);

/**
 * Secret provider for Windows using the Credential Manager.
 * Uses the `cmdkey` command-line tool to store and retrieve credentials.
 */
export class WindowsKeychainProvider implements SecretProvider {
  private getTargetName(providerId: string): string {
    return `${KEYCHAIN_SERVICE_PREFIX}-${providerId}`;
  }

  async isAvailable(): Promise<boolean> {
    try {
      if (process.platform !== 'win32') {
        return false;
      }

      // Check if cmdkey exists
      await execFileAsync('cmdkey', ['/list']);
      return true;
    } catch {
      return false;
    }
  }

  async get(providerId: string): Promise<string | undefined> {
    const targetName = this.getTargetName(providerId);

    try {
      // List credentials and find the target
      const { stdout } = await execFileAsync('cmdkey', ['/list', targetName]);

      // cmdkey doesn't directly return the password for security reasons
      // We need to use a different approach - read from the credential manager
      // For now, return undefined as cmdkey can't retrieve stored passwords directly
      // A proper implementation would need to use PowerShell or a native module

      // Alternative: use PowerShell to retrieve the credential
      const { stdout: psStdout } = await execFileAsync('powershell', [
        '-Command',
        `
        $cred = Get-StoredCredential -Target '${targetName}'
        if ($cred) {
          $cred.GetNetworkCredential().Password
        }
        `
      ]);

      return psStdout.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  async set(providerId: string, apiKey: string): Promise<void> {
    const targetName = this.getTargetName(providerId);

    // Use cmdkey to store the credential
    // Note: cmdkey stores as a generic credential
    await execFileAsync('cmdkey', [
      `/add:${targetName}`,
      `/user:${KEYCHAIN_ACCOUNT}`,
      `/pass:${apiKey}`,
    ]);
  }

  async delete(providerId: string): Promise<boolean> {
    const targetName = this.getTargetName(providerId);

    try {
      await execFileAsync('cmdkey', [`/delete:${targetName}`]);
      return true;
    } catch {
      return false;
    }
  }

  async list(): Promise<string[]> {
    try {
      const { stdout } = await execFileAsync('cmdkey', ['/list']);
      const providers: string[] = [];
      const prefix = `${KEYCHAIN_SERVICE_PREFIX}-`;

      const lines = stdout.split('\n');
      for (const line of lines) {
        // Look for target names that start with babel-o-
        const match = line.match(/Target: (.+)/);
        if (match) {
          const target = match[1].trim();
          if (target.startsWith(prefix)) {
            const providerId = target.slice(prefix.length);
            providers.push(providerId);
          }
        }
      }

      return providers;
    } catch {
      return [];
    }
  }
}
