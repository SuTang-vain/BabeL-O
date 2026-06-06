import chalk from 'chalk'

export type ThemeName = 'default' | 'minimal'

export interface Theme {
  name: ThemeName
  brand: (text: string) => string
  accent: (text: string) => string
  dim: (text: string) => string
  success: (text: string) => string
  warning: (text: string) => string
  error: (text: string) => string
  info: (text: string) => string
  separator: (width: number) => string
  promptSymbol: string
}

const defaultTheme: Theme = {
  name: 'default',
  brand: chalk.bold.hex('#ff006e'),
  accent: chalk.hex('#8b5cf6'),
  dim: chalk.dim,
  success: chalk.green,
  warning: chalk.yellow,
  error: chalk.red,
  info: chalk.cyan,
  separator: (width: number) => chalk.dim('─'.repeat(width)),
  promptSymbol: '>',
}

const minimalTheme: Theme = {
  name: 'minimal',
  brand: chalk.bold,
  accent: chalk.bold,
  dim: chalk.dim,
  success: chalk.green,
  warning: chalk.yellow,
  error: chalk.red,
  info: chalk.white,
  separator: (width: number) => chalk.dim('─'.repeat(width)),
  promptSymbol: '$',
}

const themes: Record<ThemeName, Theme> = {
  default: defaultTheme,
  minimal: minimalTheme,
}

let activeTheme: Theme | undefined

export function getTheme(): Theme {
  if (activeTheme) return activeTheme
  const envTheme = process.env.BABEL_O_THEME?.toLowerCase()
  activeTheme = (envTheme && envTheme in themes)
    ? themes[envTheme as ThemeName]
    : defaultTheme
  return activeTheme
}

export function resetThemeForTest(): void {
  activeTheme = undefined
}
