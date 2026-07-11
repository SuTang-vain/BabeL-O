export const THINKING_LEVELS = ['quick', 'balanced', 'deep'] as const

export type ThinkingLevel = typeof THINKING_LEVELS[number]

export type ThinkingProfile = {
  level: ThinkingLevel
  maxLoops: number
  defaultThinkingBudget?: number
  defaultMaxOutputTokens?: number
  guidance: string
}

const PROFILES: Record<ThinkingLevel, ThinkingProfile> = {
  quick: {
    level: 'quick',
    maxLoops: 12,
    defaultThinkingBudget: 1024,
    defaultMaxOutputTokens: 2048,
    guidance: 'Work quickly. Prefer the smallest sufficient inspection, avoid broad exploration, and give a concise evidence-backed answer.',
  },
  balanced: {
    level: 'balanced',
    maxLoops: 25,
    guidance: 'Use normal engineering judgment. Inspect enough evidence to answer correctly, then synthesize without unnecessary exploration.',
  },
  deep: {
    level: 'deep',
    maxLoops: 40,
    defaultThinkingBudget: 8192,
    defaultMaxOutputTokens: 8192,
    guidance: 'Investigate deliberately. Compare relevant evidence, verify important claims with focused checks, and explain conclusions with concise supporting rationale.',
  },
}

export function parseThinkingLevel(value: unknown): ThinkingLevel | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().toLowerCase()
  return THINKING_LEVELS.includes(normalized as ThinkingLevel)
    ? normalized as ThinkingLevel
    : undefined
}

export function resolveThinkingProfile(level?: ThinkingLevel): ThinkingProfile {
  return PROFILES[level ?? 'balanced']
}

export function formatThinkingLevelGuidance(level: ThinkingLevel): string {
  const profile = resolveThinkingProfile(level)
  return [
    `Thinking level: ${profile.level}.`,
    profile.guidance,
    'This is internal execution guidance. Do not mention the selected level or describe private reasoning unless the user asks.',
    'Safety, permissions, task scope, and evidence requirements remain unchanged at every level.',
  ].join('\n')
}
