import chalk from 'chalk'

export type ThemeName = 'default' | 'minimal' | 'everforest-light-soft'

export interface Theme {
  name: ThemeName
  brand: (text: string) => string
  accent: (text: string) => string
  secondary: (text: string) => string
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
  secondary: chalk.hex('#ff7a18'),
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
  secondary: chalk.bold,
  dim: chalk.dim,
  success: chalk.green,
  warning: chalk.yellow,
  error: chalk.red,
  info: chalk.white,
  separator: (width: number) => chalk.dim('─'.repeat(width)),
  promptSymbol: '$',
}

// Everforest light soft palette (https://github.com/sainnhe/everforest)
// Hex values follow the official `everforest` palette.
const everforestLightSoftTheme: Theme = {
  name: 'everforest-light-soft',
  brand: chalk.hex('#8DA101'),      // green / accent — primary brand mark
  accent: chalk.hex('#35A77C'),     // teal / blue — secondary accent
  secondary: chalk.hex('#DFA000'),  // yellow / orange — highlight
  dim: chalk.hex('#A8B5A0'),        // grey1 — muted labels
  success: chalk.hex('#8DA101'),    // green
  warning: chalk.hex('#DFA000'),    // yellow
  error: chalk.hex('#F85552'),      // red
  info: chalk.hex('#3A94B5'),       // blue
  separator: (width: number) => chalk.hex('#A8B5A0')('─'.repeat(width)),
  promptSymbol: '❯',
}

const themes: Record<ThemeName, Theme> = {
  default: defaultTheme,
  minimal: minimalTheme,
  'everforest-light-soft': everforestLightSoftTheme,
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
