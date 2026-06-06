import { relative, resolve } from 'node:path'
import type { ModelAdapter, ModelMessage } from '../providers/adapters/ModelAdapter.js'
import { eventBase, type NexusEvent } from '../shared/events.js'
import { extractAbsolutePaths } from './systemPromptBuilder.js'

export type UserIntentKind =
  | 'continue'
  | 'new_focus'
  | 'correction'
  | 'pause'
  | 'greeting'
  | 'status'

export type ContextScope = 'full' | 'recent' | 'new_focus'
export type ActionHint = 'normal' | 'prioritize_latest' | 'respond_only'

export type UserIntentGuidance = {
  intent: UserIntentKind
  confidence: number
  continuity: number
  contextScope: ContextScope
  actionHint: ActionHint
  requiresTools: boolean
  reason: string
  guidance: string
  latestUserText: string
  explicitPaths: string[]
  source: 'model' | 'fallback'
}

export type UserIntakeGuidanceEvent = Extract<NexusEvent, { type: 'user_intake_guidance' }>

export async function buildUserIntakeGuidanceEvent(options: {
  adapter: ModelAdapter
  modelId: string
  apiKey?: string
  baseUrl?: string
  sessionId: string
  events: NexusEvent[]
  latestPrompt: string
  cwd: string
  signal?: AbortSignal
}): Promise<UserIntakeGuidanceEvent> {
  const fallback = deriveFallbackUserIntentGuidance({
    events: options.events,
    latestPrompt: options.latestPrompt,
    cwd: options.cwd,
  })

  try {
    const text = await queryIntakeModel({
      adapter: options.adapter,
      modelId: options.modelId,
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
      latestPrompt: options.latestPrompt,
      cwd: options.cwd,
      history: summarizeRecentUserHistory(options.events),
      signal: options.signal,
    })
    const parsed = parseIntakeModelOutput(text, fallback)
    return toUserIntakeGuidanceEvent({
      sessionId: options.sessionId,
      guidance: parsed,
    })
  } catch {
    return toUserIntakeGuidanceEvent({
      sessionId: options.sessionId,
      guidance: fallback,
    })
  }
}

export function deriveUserIntentGuidance(options: {
  events: NexusEvent[]
  latestPrompt: string
  cwd: string
}): UserIntentGuidance {
  const intake = findLatestUserIntakeGuidance(options.events)
  if (intake && intake.userText === options.latestPrompt) {
    return guidanceFromIntakeEvent(intake)
  }
  return deriveFallbackUserIntentGuidance(options)
}

export function findLatestUserIntakeGuidance(events: NexusEvent[]): UserIntakeGuidanceEvent | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'user_intake_guidance') return event
  }
  return undefined
}

export function guidanceFromIntakeEvent(event: UserIntakeGuidanceEvent): UserIntentGuidance {
  return normalizeGuidancePolicy({
    intent: event.intent,
    confidence: clamp01(event.confidence),
    continuity: clamp01(event.continuity),
    contextScope: event.contextScope,
    actionHint: event.actionHint,
    requiresTools: event.requiresTools,
    reason: event.reason,
    guidance: event.guidance,
    latestUserText: event.userText,
    explicitPaths: event.explicitPaths,
    source: event.source,
  })
}

export function toUserIntakeGuidanceEvent(options: {
  sessionId: string
  guidance: UserIntentGuidance
}): UserIntakeGuidanceEvent {
  const guidance = normalizeGuidancePolicy(options.guidance)
  return {
    type: 'user_intake_guidance',
    ...eventBase(options.sessionId),
    userText: guidance.latestUserText,
    intent: guidance.intent,
    confidence: clamp01(guidance.confidence),
    continuity: clamp01(guidance.continuity),
    contextScope: guidance.contextScope,
    actionHint: guidance.actionHint,
    requiresTools: guidance.requiresTools,
    reason: guidance.reason,
    guidance: guidance.guidance,
    explicitPaths: guidance.explicitPaths,
    source: guidance.source,
  }
}

export function formatUserIntentGuidance(guidance: UserIntentGuidance): string {
  const lines = [
    '## User Intake Guidance / User Intent Guidance',
    `Source: ${guidance.source}`,
    `Intent: ${guidance.intent}`,
    `Confidence: ${guidance.confidence.toFixed(2)}`,
    `Continuity with prior context: ${guidance.continuity.toFixed(2)}`,
    `Context scope: ${guidance.contextScope}`,
    `Action hint: ${guidance.actionHint}`,
    `Requires tools: ${guidance.requiresTools ? 'yes' : 'no'}`,
    `Reason: ${guidance.reason}`,
    `Guidance: ${guidance.guidance}`,
  ]
  if (guidance.explicitPaths.length > 0) {
    lines.push(`Explicit paths: ${guidance.explicitPaths.join(', ')}`)
  }
  if (guidance.intent === 'status' && (!guidance.requiresTools || guidance.actionHint === 'respond_only')) {
    lines.push('Instruction: the user appears to be asking a status or context question. Answer from existing context unless you genuinely need to run a command to verify. Do not start multi-step tool chains for this message.')
  } else if (!guidance.requiresTools || guidance.actionHint === 'respond_only') {
    lines.push('Instruction: respond directly to the latest user message. Do not start tool calls unless the user explicitly asks for new work in this message.')
  } else if (guidance.actionHint === 'prioritize_latest') {
    lines.push('Instruction: prioritize the latest user message as the active task. Use prior context only as background and do not continue stale tool chains.')
  }
  return lines.join('\n')
}

export function shouldSuppressToolsForIntent(guidance: UserIntentGuidance): boolean {
  const normalized = normalizeGuidancePolicy(guidance)
  if (normalized.intent === 'status') return false
  return !normalized.requiresTools || normalized.actionHint === 'respond_only'
}

export function deriveFallbackUserIntentGuidance(options: {
  events: NexusEvent[]
  latestPrompt: string
  cwd: string
}): UserIntentGuidance {
  const latestUserText = options.latestPrompt || findLatestUserText(options.events)
  const explicitPaths = extractAbsolutePaths(latestUserText)
  const hasPriorUserTurns = countUserMessages(options.events) > 1

  if (isPausePrompt(latestUserText)) {
    return buildGuidance({
      intent: 'pause',
      confidence: 0.92,
      continuity: 0.3,
      contextScope: 'recent',
      actionHint: 'respond_only',
      requiresTools: false,
      reason: 'The user asked to stop, pause, or wait before continuing.',
      guidance: 'Acknowledge the pause and wait for the next requirement without starting tool work.',
      latestUserText,
      explicitPaths,
      source: 'fallback',
    })
  }

  if (isCorrectionPrompt(latestUserText)) {
    return buildGuidance({
      intent: 'correction',
      confidence: 0.86,
      continuity: 0.45,
      contextScope: 'recent',
      actionHint: 'prioritize_latest',
      requiresTools: true,
      reason: 'The user is correcting the previous target or interpretation; prioritize the latest wording without discarding prior context.',
      guidance: 'Use the correction as the active instruction and treat previous work as background, not as an active tool chain.',
      latestUserText,
      explicitPaths,
      source: 'fallback',
    })
  }

  const externalPaths = explicitPaths.filter(path => !isInsideCwd(path, options.cwd))
  if (externalPaths.length > 0) {
    return buildGuidance({
      intent: 'new_focus',
      confidence: 0.78,
      continuity: hasPriorUserTurns ? 0.35 : 0.2,
      contextScope: 'new_focus',
      actionHint: 'prioritize_latest',
      requiresTools: true,
      reason: 'The latest request names path(s) outside the current workspace; treat them as the active focus while retaining prior context as background.',
      guidance: 'Inspect the explicit path as the active focus if tools are needed; do not continue stale project work.',
      latestUserText,
      explicitPaths,
      source: 'fallback',
    })
  }

  if (isStatusPrompt(latestUserText)) {
    return buildGuidance({
      intent: 'status',
      confidence: 0.82,
      continuity: 0.75,
      contextScope: 'full',
      actionHint: 'respond_only',
      requiresTools: false,
      reason: 'The user is asking about the current state; answer from existing context instead of starting new tool work.',
      guidance: 'Answer from the visible session state and do not initiate fresh inspection.',
      latestUserText,
      explicitPaths,
      source: 'fallback',
    })
  }

  if (isGreetingPrompt(latestUserText)) {
    return buildGuidance({
      intent: 'greeting',
      confidence: 0.8,
      continuity: hasPriorUserTurns ? 0.7 : 0.4,
      contextScope: 'full',
      actionHint: 'respond_only',
      requiresTools: false,
      reason: 'The latest message is a greeting; acknowledge briefly and keep the prior conversation available.',
      guidance: 'Reply briefly and do not start tools.',
      latestUserText,
      explicitPaths,
      source: 'fallback',
    })
  }

  return buildGuidance({
    intent: 'continue',
    confidence: 0.66,
    continuity: hasPriorUserTurns ? 0.8 : 0.5,
    contextScope: 'full',
    actionHint: 'normal',
    requiresTools: true,
    reason: 'No strong topic switch, correction, pause, or greeting marker was detected.',
    guidance: 'Proceed with the latest request, using prior context normally.',
    latestUserText,
    explicitPaths,
    source: 'fallback',
  })
}

async function queryIntakeModel(options: {
  adapter: ModelAdapter
  modelId: string
  apiKey?: string
  baseUrl?: string
  latestPrompt: string
  cwd: string
  history: string
  signal?: AbortSignal
}): Promise<string> {
  const messages: ModelMessage[] = [
    {
      role: 'user',
      content: [
        'Analyze the latest user message for a coding agent intake step.',
        'Return only compact JSON with keys: intent, confidence, continuity, contextScope, actionHint, requiresTools, reason, guidance, explicitPaths.',
        'intent must be one of: continue, new_focus, correction, pause, greeting, status.',
        'contextScope must be one of: full, recent, new_focus.',
        'actionHint must be one of: normal, prioritize_latest, respond_only.',
        'requiresTools must be false for greeting/pause.',
        'For status, use requiresTools=false only for pure status questions; if the latest message asks to verify, run, check, test, lint, build, inspect, or modify code, classify as continue with requiresTools=true.',
        'Examples:',
        '- "你在干什么" -> {"intent":"status","requiresTools":false,"actionHint":"respond_only"}',
        '- "当前什么状态" -> {"intent":"status","requiresTools":false,"actionHint":"respond_only"}',
        '- "验证当前改动是否健康" -> {"intent":"continue","requiresTools":true,"actionHint":"normal"}',
        '- "检查一下测试能不能过" -> {"intent":"continue","requiresTools":true,"actionHint":"normal"}',
        '- "跑一下 lint" -> {"intent":"continue","requiresTools":true,"actionHint":"normal"}',
        '- "run the tests" -> {"intent":"continue","requiresTools":true,"actionHint":"normal"}',
        '- "what are you doing" -> {"intent":"status","requiresTools":false,"actionHint":"respond_only"}',
        '- "check if tests pass" -> {"intent":"continue","requiresTools":true,"actionHint":"normal"}',
        `cwd: ${options.cwd}`,
        `recent user history:\n${options.history || '(none)'}`,
        `latest user message:\n${options.latestPrompt}`,
      ].join('\n'),
    },
  ]
  let output = ''
  for await (const delta of options.adapter.queryStream({
    model: options.modelId,
    systemPrompt: 'You are a fast intake classifier for a coding agent. Produce only valid JSON and never call tools.',
    messages,
    tools: [],
    temperature: 0,
    maxTokens: 700,
  }, {
    signal: options.signal,
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
  })) {
    if (delta.type === 'text') output += delta.text
  }
  return output
}

function parseIntakeModelOutput(text: string, fallback: UserIntentGuidance): UserIntentGuidance {
  const json = extractJsonObject(text)
  if (!json) return fallback
  try {
    const raw = JSON.parse(json) as Record<string, unknown>
    const intent = parseEnum(raw.intent, ['continue', 'new_focus', 'correction', 'pause', 'greeting', 'status'], fallback.intent)
    const contextScope = parseEnum(raw.contextScope, ['full', 'recent', 'new_focus'], fallback.contextScope)
    const actionHint = parseEnum(raw.actionHint, ['normal', 'prioritize_latest', 'respond_only'], fallback.actionHint)
    const requiresTools = typeof raw.requiresTools === 'boolean'
      ? raw.requiresTools
      : actionHint !== 'respond_only'
    const explicitPaths = fallback.explicitPaths
    return buildGuidance({
      intent,
      confidence: clamp01(typeof raw.confidence === 'number' ? raw.confidence : fallback.confidence),
      continuity: clamp01(typeof raw.continuity === 'number' ? raw.continuity : fallback.continuity),
      contextScope,
      actionHint,
      requiresTools,
      reason: typeof raw.reason === 'string' && raw.reason.trim() ? raw.reason.trim() : fallback.reason,
      guidance: typeof raw.guidance === 'string' && raw.guidance.trim() ? raw.guidance.trim() : fallback.guidance,
      latestUserText: fallback.latestUserText,
      explicitPaths,
      source: 'model',
    })
  } catch {
    return fallback
  }
}

function extractJsonObject(text: string): string | undefined {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return undefined
  return text.slice(start, end + 1)
}

function parseEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && allowed.includes(value as T) ? value as T : fallback
}

function summarizeRecentUserHistory(events: NexusEvent[]): string {
  return events
    .filter((event): event is Extract<NexusEvent, { type: 'user_message' }> => event.type === 'user_message')
    .slice(-5)
    .map((event, index) => `${index + 1}. ${event.text}`)
    .join('\n')
}

function buildGuidance(guidance: UserIntentGuidance): UserIntentGuidance {
  return normalizeGuidancePolicy(guidance)
}

function normalizeGuidancePolicy(guidance: UserIntentGuidance): UserIntentGuidance {
  if (guidance.intent === 'pause') {
    return {
      ...guidance,
      contextScope: 'recent',
      actionHint: 'respond_only',
      requiresTools: false,
    }
  }
  if (guidance.intent === 'greeting') {
    return {
      ...guidance,
      actionHint: 'respond_only',
      requiresTools: false,
    }
  }
  if (guidance.intent === 'status' && !guidance.requiresTools) {
    return {
      ...guidance,
      actionHint: 'respond_only',
    }
  }
  return guidance
}

function findLatestUserText(events: NexusEvent[]): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'user_message') return event.text
  }
  return ''
}

function countUserMessages(events: NexusEvent[]): number {
  let count = 0
  for (const event of events) {
    if (event.type === 'user_message') count += 1
  }
  return count
}

function isInsideCwd(path: string, cwd: string): boolean {
  const resolvedPath = resolve(path)
  const resolvedCwd = resolve(cwd)
  const rel = relative(resolvedCwd, resolvedPath)
  return rel === '' || (!rel.startsWith('..') && !resolve(rel).startsWith('/'))
}

function isGreetingPrompt(text: string): boolean {
  const normalized = normalizeLoose(text)
  if (/^(hi|hello|hey|你好|您好)$/.test(normalized)) return true
  if (/^(?:hi|hello|hey)?(?:你是谁|你是哪个|你是什么|你能做什么|你会做什么|你可以做什么|你叫什么|你叫啥)$/.test(normalized)) return true
  if (/^(?:hi|hello|hey)?(?:whoareyou|whatareyou|whatcanyoudo|whatdoyoudo|introduceyourself)$/.test(normalized)) return true
  return false
}

function isStatusPrompt(text: string): boolean {
  const normalized = text.trim().toLowerCase()
  if (/^(你)?还在吗[？?!.。！`'"\s]*$/u.test(normalized)) return true
  if (/^(还记得|记得我.*问|知道我.*问).*[？?!.。！`'"\s]*$/u.test(normalized)) return true
  if (/你.*(在干什么|正在干什么|还记得|知道我.*问|感知我.*问|听得懂).*[？?!.。！`'"\s]*$/u.test(normalized)) return true
  if (/\b(what are you doing|where are we|what were you doing|do you remember)\b/iu.test(normalized)) return true
  return false
}

function isPausePrompt(text: string): boolean {
  const normalized = text.trim().toLowerCase()
  if (/(?:\b(?:just|please|pls)\s+)?(?:stop|pause|hold)\b/u.test(normalized)) return true
  if (/(?:\b(?:wait|waite|hold on|hang on)\b)/u.test(normalized) && /(?:\b(?:for me|a sec|a second|a minute|other require|next)\b)/u.test(normalized)) {
    return true
  }
  if (/(?:等一下|稍等|先停|先别|暂停|停一下)/u.test(text)) return true
  return false
}

function isCorrectionPrompt(text: string): boolean {
  const normalized = text.trim().toLowerCase()
  return /(?:让你|要你|我说的|说的是|分析的就是|看的就是|不是.*(?:而是|是)|actually|i mean)/iu.test(normalized)
}

function normalizeLoose(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[？?!.。！`'"\s]+/gu, '')
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}
