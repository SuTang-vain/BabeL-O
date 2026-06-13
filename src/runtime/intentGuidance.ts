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
export type ProblemTarget =
  | 'agent_failure'
  | 'runtime_replay'
  | 'tool_evidence'
  | 'project_feature'
  | 'user_artifact'
  | 'unknown'

export type UserIntentGuidance = {
  intent: UserIntentKind
  confidence: number
  continuity: number
  contextScope: ContextScope
  actionHint: ActionHint
  requiresTools: boolean
  problemTarget: ProblemTarget
  reason: string
  latestUserText: string
  explicitPaths: string[]
  source: 'model' | 'fallback'
}

export type UserIntakeGuidanceEvent = Extract<NexusEvent, { type: 'user_intake_guidance' }>

type TurnPolicy = {
  responseMode: 'execute_task' | 'direct_answer'
  toolMode: 'enabled' | 'disabled' | 'available_for_verification'
  evidenceMode: 'standard' | 'verify_before_claim' | 'none'
  staleTaskMode: 'continue' | 'background_only' | 'reset'
}

type TargetScore = {
  agentFailure: number
  runtimeReplay: number
  toolEvidence: number
  projectFeature: number
  problemAnalysis: number
}

const PROBLEM_MARKERS = {
  agentSubject: [
    /\b(?:you|your|assistant|agent|model|runtime|system\s*prompt|prompt)\b/iu,
    /(?:你|你的|助手|模型|运行时|提示词|系统提示)/u,
  ],
  failure: [
    /\b(?:problem|issue|failure|mistake|wrong|hallucinat\w*|unsupported|unverified|verify|fact|evidence)\b/iu,
    /(?:问题|错误|失败|错|幻觉|编|事实|核对|证据|验证|未验证|不支撑)/u,
  ],
  runtimeReplay: [
    /\b(?:provider|replay|orphan|tool[_ -]?(?:result|use|call|started|completed)|event\s*ordering|transcript|protocol)\b/iu,
    /(?:回放|孤儿|工具.*(?:结果|调用|配对)|事件.*排序|转录|协议)/u,
  ],
  toolEvidence: [
    /\b(?:read|grep|listdir|glob|coverage|offset|lineoffset|shownbytes|shownlines|claim|evidence)\b/iu,
    /(?:工具|读取|覆盖|偏移|行号|结论|判断|证据|事实源)/u,
  ],
  projectFeature: [
    /\b(?:project|product|feature|code|implementation|architecture|source|document)\b/iu,
    /(?:项目|产品|功能|源码|代码|实现|架构|文档)/u,
  ],
  problemAnalysis: [
    /\b(?:problem|issue|bug|root\s*cause|cause|analy[sz]e|inspect|debug)\b/iu,
    /(?:问题|原因|缺陷|分析|查看|检查|排查|诊断)/u,
  ],
} as const

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
    problemTarget: event.problemTarget ?? deriveProblemTarget({
      latestUserText: event.userText,
      events: [],
      explicitPaths: event.explicitPaths,
    }),
    reason: event.reason,
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
    problemTarget: guidance.problemTarget,
    reason: guidance.reason,
    explicitPaths: guidance.explicitPaths,
    source: guidance.source,
  }
}

export function formatUserIntentGuidance(guidance: UserIntentGuidance): string {
  const policy = deriveTurnPolicy(guidance)
  const lines = [
    '## Turn Policy',
    `Source: ${guidance.source}`,
    `Intent: ${guidance.intent}`,
    `Confidence: ${guidance.confidence.toFixed(2)}`,
    `Continuity with prior context: ${guidance.continuity.toFixed(2)}`,
    `Context scope: ${guidance.contextScope}`,
    `Action hint: ${guidance.actionHint}`,
    `Requires tools: ${guidance.requiresTools ? 'yes' : 'no'}`,
    `Problem target: ${guidance.problemTarget}`,
    `Response mode: ${policy.responseMode}`,
    `Tool mode: ${policy.toolMode}`,
    `Evidence mode: ${policy.evidenceMode}`,
    `Stale task mode: ${policy.staleTaskMode}`,
  ]
  if (guidance.explicitPaths.length > 0) {
    lines.push(`Explicit paths: ${guidance.explicitPaths.join(', ')}`)
  }
  return lines.join('\n')
}

export function shouldSuppressToolsForIntent(guidance: UserIntentGuidance): boolean {
  const normalized = normalizeGuidancePolicy(guidance)
  if (isMemoryCapabilityQuestion(normalized.latestUserText)) return true
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
  const problemTarget = deriveProblemTarget({
    latestUserText,
    events: options.events,
    explicitPaths,
  })

  if (isPausePrompt(latestUserText)) {
    return buildGuidance({
      intent: 'pause',
      confidence: 0.92,
      continuity: 0.3,
      contextScope: 'recent',
      actionHint: 'respond_only',
      requiresTools: false,
      problemTarget,
      reason: 'The user asked to stop, pause, or wait before continuing.',
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
      problemTarget,
      reason: 'The user is correcting the previous target or interpretation; prioritize the latest wording without discarding prior context.',
      latestUserText,
      explicitPaths,
      source: 'fallback',
    })
  }

  if (isMemoryCapabilityQuestion(latestUserText)) {
    return buildGuidance({
      intent: 'status',
      confidence: 0.88,
      continuity: hasPriorUserTurns ? 0.75 : 0.5,
      contextScope: 'full',
      actionHint: 'respond_only',
      requiresTools: false,
      problemTarget,
      reason: 'The user is asking whether memory capability is available, not asking to write memory now.',
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
      problemTarget,
      reason: 'The latest request names path(s) outside the current workspace; treat them as the active focus while retaining prior context as background.',
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
      problemTarget,
      reason: 'The user is asking about the current state; answer from existing context instead of starting new tool work.',
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
      problemTarget,
      reason: 'The latest message is a greeting; acknowledge briefly and keep the prior conversation available.',
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
      problemTarget,
      reason: 'No strong topic switch, correction, pause, or greeting marker was detected.',
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
        'Return only compact JSON with keys: intent, confidence, continuity, contextScope, actionHint, requiresTools, problemTarget, reason, explicitPaths.',
        'intent must be one of: continue, new_focus, correction, pause, greeting, status.',
        'contextScope must be one of: full, recent, new_focus.',
        'actionHint must be one of: normal, prioritize_latest, respond_only.',
        'problemTarget must be one of: agent_failure, runtime_replay, tool_evidence, project_feature, user_artifact, unknown.',
        'requiresTools must be false for greeting/pause.',
        'Classify the target semantically, not by matching literal phrases. Use agent_failure when the user is asking about the assistant or runtime behavior; runtime_replay when the target is transcript/tool-call replay; tool_evidence when the target is evidence coverage or source support; project_feature when the target is the product or repository feature itself.',
        'Use status/respond_only only when the user is asking for conversational state or capability information. If the latest message asks to verify, run, check, test, lint, build, inspect, modify, save memory, or call a named tool, keep requiresTools=true.',
        'Do not include natural-language behavioral instructions in the JSON. The runtime will derive execution policy from the structured fields.',
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
    const problemTarget = parseEnum(raw.problemTarget, ['agent_failure', 'runtime_replay', 'tool_evidence', 'project_feature', 'user_artifact', 'unknown'], fallback.problemTarget)
    const explicitPaths = fallback.explicitPaths
    return buildGuidance({
      intent,
      confidence: clamp01(typeof raw.confidence === 'number' ? raw.confidence : fallback.confidence),
      continuity: clamp01(typeof raw.continuity === 'number' ? raw.continuity : fallback.continuity),
      contextScope,
      actionHint,
      requiresTools,
      problemTarget: reconcileProblemTarget(problemTarget, fallback.problemTarget),
      reason: typeof raw.reason === 'string' && raw.reason.trim() ? raw.reason.trim() : fallback.reason,
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

function deriveProblemTarget(options: {
  latestUserText: string
  events: NexusEvent[]
  explicitPaths: string[]
}): ProblemTarget {
  const latestScore = scoreProblemTarget(options.latestUserText)
  const recentUserText = summarizeRecentUserHistory(options.events)
  const recentTarget = selectProblemTarget(scoreProblemTarget(recentUserText))
  if (latestScore.problemAnalysis > 0 && recentTarget !== 'unknown' && recentTarget !== 'project_feature') {
    const directTarget = selectProblemTarget(latestScore)
    if (directTarget === 'unknown' || directTarget === 'project_feature') return recentTarget
  }

  const directTarget = selectProblemTarget(latestScore)
  if (directTarget !== 'unknown') return directTarget

  if (options.explicitPaths.length > 0) return 'user_artifact'
  return 'unknown'
}

function reconcileProblemTarget(modelTarget: ProblemTarget, fallbackTarget: ProblemTarget): ProblemTarget {
  if (fallbackTarget === 'unknown') return modelTarget
  if (modelTarget === 'unknown') return fallbackTarget
  if (fallbackTarget === 'agent_failure' && modelTarget === 'project_feature') return fallbackTarget
  return modelTarget
}

function deriveTurnPolicy(guidance: UserIntentGuidance): TurnPolicy {
  const respondOnly = !guidance.requiresTools || guidance.actionHint === 'respond_only'
  const evidenceTarget = guidance.problemTarget === 'agent_failure' ||
    guidance.problemTarget === 'runtime_replay' ||
    guidance.problemTarget === 'tool_evidence'

  let toolMode: TurnPolicy['toolMode'] = 'enabled'
  if (guidance.intent === 'status' && !guidance.requiresTools && !isMemoryCapabilityQuestion(guidance.latestUserText)) {
    toolMode = 'available_for_verification'
  } else if (respondOnly) {
    toolMode = 'disabled'
  }

  return {
    responseMode: respondOnly ? 'direct_answer' : 'execute_task',
    toolMode,
    evidenceMode: respondOnly ? 'none' : evidenceTarget ? 'verify_before_claim' : 'standard',
    staleTaskMode: guidance.contextScope === 'new_focus'
      ? 'reset'
      : guidance.actionHint === 'prioritize_latest' || evidenceTarget
        ? 'background_only'
        : 'continue',
  }
}

function scoreProblemTarget(text: string): TargetScore {
  const agentSubject = countMarkerMatches(text, PROBLEM_MARKERS.agentSubject)
  const failure = countMarkerMatches(text, PROBLEM_MARKERS.failure)
  const runtimeReplay = countMarkerMatches(text, PROBLEM_MARKERS.runtimeReplay)
  const toolEvidence = countMarkerMatches(text, PROBLEM_MARKERS.toolEvidence)
  const projectFeature = countMarkerMatches(text, PROBLEM_MARKERS.projectFeature)
  const problemAnalysis = countMarkerMatches(text, PROBLEM_MARKERS.problemAnalysis)

  return {
    agentFailure: agentSubject + failure + (agentSubject > 0 && failure > 0 ? 3 : 0),
    runtimeReplay: runtimeReplay * 2 + (failure > 0 || problemAnalysis > 0 ? 1 : 0),
    toolEvidence: toolEvidence * 2 + (failure > 0 || problemAnalysis > 0 ? 1 : 0),
    projectFeature: projectFeature * 2 + (problemAnalysis > 0 ? 1 : 0),
    problemAnalysis,
  }
}

function selectProblemTarget(score: TargetScore): ProblemTarget {
  const candidates: Array<[ProblemTarget, number]> = [
    ['runtime_replay', score.runtimeReplay],
    ['tool_evidence', score.toolEvidence],
    ['agent_failure', score.agentFailure],
    ['project_feature', score.projectFeature],
  ]
  const [target, value] = candidates.reduce((best, candidate) => candidate[1] > best[1] ? candidate : best)
  return value >= 3 ? target : 'unknown'
}

function countMarkerMatches(text: string, markers: readonly RegExp[]): number {
  return markers.reduce((count, marker) => count + (marker.test(text) ? 1 : 0), 0)
}

function normalizeGuidancePolicy(guidance: UserIntentGuidance): UserIntentGuidance {
  if (isMemoryCapabilityQuestion(guidance.latestUserText)) {
    return {
      ...guidance,
      intent: 'status',
      actionHint: 'respond_only',
      requiresTools: false,
    }
  }
  if (isExplicitMemorySavePrompt(guidance.latestUserText)) {
    return {
      ...guidance,
      intent: 'continue',
      actionHint: 'normal',
      requiresTools: true,
    }
  }
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

export function isMemoryCapabilityQuestion(text: string): boolean {
  const normalized = text.trim().toLowerCase()
  const asksCapability = /\b(can you|could you|are you able to|do you have|is .*available)\b.*\b(memory|remember|long[- ]term memory)\b/iu.test(normalized) ||
    /\b(memory|remember|long[- ]term memory)\b.*\b(available|enabled|write|save)\b/iu.test(normalized) ||
    /(能否|能不能|可以|可否|是否|有没有|具备).*(写入|保存|记忆|长期记忆)/u.test(text) ||
    /(记忆|长期记忆).*(能否|能不能|可以|可否|是否|有没有|具备|可用|启用)/u.test(text)
  if (!asksCapability) return false
  return !/\b(memory_save_note|remember this|save this to memory|save to memory|remember:|remember that)\b/iu.test(normalized) &&
    !/(请|帮我|立即|现在|把|将).*(记住|保存.*记忆|写入.*记忆|长期记忆.*写入|记忆保存)/u.test(text)
}

function isExplicitMemorySavePrompt(text: string): boolean {
  if (isMemoryCapabilityQuestion(text)) return false
  const normalized = text.trim().toLowerCase()
  return /\b(memory_save_note|remember this|save (?:this )?(?:to )?(?:long[- ]term )?memory|remember:|remember that)\b/iu.test(normalized) ||
    /(记住|保存.*记忆|写入.*记忆|长期记忆.*写入|记忆保存)/u.test(text)
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
