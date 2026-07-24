import os from 'node:os'
import path from 'node:path'

export const USER_DEFAULT_CONFIG_DIR = path.join(os.homedir(), '.babel-o')
export const USER_DEFAULT_CONFIG_FILE = path.join(USER_DEFAULT_CONFIG_DIR, 'config.json')
export const USER_DEFAULT_BABEL_X_CONFIG_FILE = path.join(os.homedir(), '.babel', 'config.json')

export function resolveBabelOConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.BABEL_O_CONFIG_DIR
    || (env.BABEL_O_CONFIG_FILE ? path.dirname(env.BABEL_O_CONFIG_FILE) : USER_DEFAULT_CONFIG_DIR)
}

export function resolveBabelOConfigFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.BABEL_O_CONFIG_FILE || path.join(resolveBabelOConfigDir(env), 'config.json')
}
