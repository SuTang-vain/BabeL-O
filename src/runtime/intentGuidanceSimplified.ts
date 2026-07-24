/**
 * Simplified Intent Guidance - Phase 1 of Architecture Optimization
 *
 * Design: Complete trust in Model (Plan A)
 *
 * Principles:
 * 1. Inheritance first - continuation phrases inherit previous auth
 * 2. Hard boundaries only - destructive/remote operations must be explicit
 * 3. Trust model - Model Intake has full context
 * 4. Permission gate - final safety net (already exists)
 *
 * Token savings: 60-70% per turn
 */

import { relative, resolve } from 'node:path'
import { eventBase, type NexusEvent } from '../shared/events.js'
import type { SessionAuthorizationState } from '../shared/session.js'
import { extractAbsolutePaths } from './systemPromptBuilder.js'

// === Types (unchanged) ===

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

export type AuthorizationLevel =
  | 'none'
  | 'inspect'
  | 'local_change'
  | 'shared_change'
  | 'destructive'

export type ConsentScope =
  | 'current_step'
  | 'stated_plan'
  | 'session_workflow'

export type ConsentSource =
  | 'explicit_user'
  | 'stated_plan_confirmation'
  | 'trusted_session_rule'
  | 'inferred_none'

export type SelectionKind =
  | 'none'
  | 'preference'
  | 'option'
  | 'path'
  | 'workflow_step'

type IntentCategory =
  | 'pure_capability_question'
  | 'self_diagnosis_request'
  | 'action_request'
  | 'general'

export type TurnAuthorization = {
  level: AuthorizationLevel
  consentScope: ConsentScope
  source: ConsentSource
  selectionKind: SelectionKind
  reason: string
  allowedActionSummary: string
  blockedActionSummary: string
}

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
  authorization?: TurnAuthorization
}

export type UserIntakeGuidanceEvent = Extract<NexusEvent, { type: 'user_intake_guidance' }>

// === Core Functions ===

/**
 * Simplified authorization derivation - single layer decision.
 *
 * Only hard boundaries are enforced. Everything else trusts the model.
 */
function deriveAuthorization(
  text: string,
  modelAuth: AuthorizationLevel | undefined,
  previousAuth?: SessionAuthorizationState
): AuthorizationLevel {
  // 1. Inheritance check (highest priority)
  if (isContinuationPhrase(text) && previousAuth) {
    return parseAuthorizationLevel(previousAuth.level, modelAuth ?? 'inspect')
  }

  // 2. Destructive boundary (must be explicit)
  if (isDestructiveRequest(text)) {
    return 'destructive'
  }

  // 3. Remote operation boundary
  if (isRemoteOperation(text)) {
    return 'shared_change'
  }

  // 4. Trust model's judgment
  return modelAuth ?? 'inspect'
}

/**
 * Check if text is a continuation phrase.
 * (Kept from original - essential for inheritance)
 */
export function isContinuationPhrase(text: string): boolean {
  const normalized = text.trim().toLowerCase()

  // Chinese continuation phrases
  if (/^(继续|继续任务|继续推进|继续工作|继续执行|继续做|继续改|继续写|继续修改|继续完成)$/u.test(normalized)) {
    return true
  }

  // "继续..." with additional context
  if (/^继续.{0,10}$/.test(normalized) && !/(开始新|新任务|查看|分析)/u.test(text)) {
    return true
  }

  // English continuation phrases
  if (/^(continue|keep going|proceed|carry on|go ahead)$/iu.test(normalized)) {
    return true
  }

  // "continue with the plan" etc.
  if (/^continue\s+(with|the|working|on)/iu.test(normalized)) {
    return true
  }

  return false
}

/**
 * Check if text requests destructive operation.
 * (Hard boundary - must keep)
 */
function isDestructiveRequest(text: string): boolean {
  const normalized = text.trim().toLowerCase()
  return /\b(delete|remove|destroy|drop|truncate|wipe|nuke|force.*push|force.*merge)\b/iu.test(normalized) ||
    /(删除|销毁|清空|强制推送|强制合并|彻底删除|全部删除)/u.test(text)
}

/**
 * Check if text requests remote operation.
 * (Hard boundary - must keep)
 */
function isRemoteOperation(text: string): boolean {
  const normalized = text.trim().toLowerCase()
  return /\b(push|publish|release|merge\s+(?:to|into)?\s*(?:main|master|develop)|close\s*pr|pull\s*request|remote)\b/iu.test(normalized) ||
    /(推送|远端|发布|release|合并到\s*(?:main|master|develop)|关闭\s*pr|关闭\s*pull\s*request|创建\s*pr)/u.test(text)
}

/**
 * Check if text is a pause request.
 * (Essential intent classification)
 */
export function isPausePrompt(text: string): boolean {
  const normalized = text.trim().toLowerCase()
  return /^(等一下|等等|暂停|停|停下|停一下|pause|stop|wait|hold on)[？?!.。！`'"\s]*$/iu.test(normalized) ||
    /\b(?:just|please|pls)?\s*(?:stop|pause|hold)\b/iu.test(normalized) ||
    /\b(?:wait|waite|hold on|hang on)\b.*\b(?:for me|other require|next|a sec|a second|a minute)\b/iu.test(normalized) ||
    /^(先别|先不要|不要继续|先停)/u.test(normalized) ||
    /(等一下|暂停|停|停下|停一下|先停)/u.test(normalized) ||
    /先不需要.*继续|先不用.*继续|暂时不需要.*继续/u.test(normalized)
}

/**
 * Check if text is a greeting.
 * (Essential intent classification)
 */
function isGreetingPrompt(text: string): boolean {
  const normalized = text.trim().toLowerCase().replace(/[？?!.。！`'"\s]+/gu, '')
  if (/^(hi|hello|hey|你好|您好)$/.test(normalized)) return true
  if (/^(?:hi|hello|hey)?(?:你是谁|你是哪个|你是什么|你能做什么|你会做什么|你可以做什么|你叫什么|你叫啥)$/.test(normalized)) return true
  return false
}

function hasActionVerbCue(text: string): boolean {
  const normalized = text.trim().toLowerCase()
  return /\b(run|execute|test|verify|inspect|check|diagnose|status|analyze|review|edit|change|fix)\b/iu.test(normalized) ||
    /(执行|运行|跑一下|测试|验证|检查|查看|确认|诊断|解释|说明|分析|审查|修改|修复|推进|合并|推送)/u.test(text)
}

function isPureMemoryCapabilityQuestion(text: string): boolean {
  if (hasActionVerbCue(text)) return false
  const normalized = text.trim().toLowerCase()
  return /\b(can you|could you|are you able to|do you have)\b.*\b(memory|remember|long[- ]term memory)\b/iu.test(normalized) ||
    /\b(memory|remember|long[- ]term memory)\b.*\b(available|enabled|write|save)\b/iu.test(normalized) ||
    /(能否|能不能|可以|可否|是否|有没有|有|具备|支持).*(写入|保存|记忆|长期记忆)/u.test(text) ||
    /(记忆|长期记忆).*(能否|能不能|可以|可否|是否|有没有|具备|支持|可用|启用)/u.test(text)
}

function isMetaBehaviorQuestion(text: string): boolean {
  const normalized = text.trim().toLowerCase()
  const asksWhy = /\bwhy\b/iu.test(normalized) || /(为什么|为啥|什么情况|怎么回事|咋回事)/u.test(text)
  const agentBehavior = /\b(hesitat\w*|tool|tools|modify|modified|edit|changed|directly|permission|policy|unauthorized|without asking)\b/iu.test(normalized) ||
    /(工具|犹豫|直接|修改|改了|编辑|权限|策略|擅自|未授权|没问我)/u.test(text)
  if (asksWhy && agentBehavior) return true
  return /(你.*(为什么|为啥).*(犹豫|直接|修改|改了|编辑|执行|调用工具|用工具)|为什么你会这么犹豫|你怎么直接修改|怎么直接改)/u.test(text)
}

/**
 * Check if text is a correction.
 * (Essential intent classification)
 */
function isCorrectionPrompt(text: string): boolean {
  const normalized = text.trim().toLowerCase()
  return /(?:让你|要你|我说的|说的是|分析的就是|看的就是|不是.*(?:而是|是)|actually|i\s*mean)/iu.test(normalized)
}

/**
 * Check if path is inside cwd.
 */
function isInsideCwd(path: string, cwd: string): boolean {
  try {
    const resolved = resolve(path)
    const relativePath = relative(cwd, resolved)
    return !relativePath.startsWith('..') && !relativePath.startsWith('/')
  } catch {
    return false
  }
}

// === Helper Functions ===

function buildAuthorization(options: {
  level: AuthorizationLevel
  consentScope?: ConsentScope
  source?: ConsentSource
  selectionKind?: SelectionKind
  reason: string
}): TurnAuthorization {
  const level = options.level
  const consentScope = options.consentScope ??
    (level === 'none' || level === 'inspect' ? 'current_step' : 'stated_plan')
  const source = options.source ??
    (level === 'none' || level === 'inspect' ? 'inferred_none' : 'explicit_user')

  const allowedSummary: Record<AuthorizationLevel, string> = {
    none: 'No tool execution',
    inspect: 'Read-only inspection',
    local_change: 'Local edits and commits',
    shared_change: 'Remote operations with confirmation',
    destructive: 'Destructive operations with explicit confirmation',
  }

  const blockedSummary: Record<AuthorizationLevel, string> = {
    none: 'All tools blocked',
    inspect: 'Write operations blocked',
    local_change: 'Remote operations blocked',
    shared_change: 'Destructive operations blocked',
    destructive: 'Nothing blocked (confirmed)',
  }

  return {
    level,
    consentScope,
    source,
    selectionKind: options.selectionKind ?? 'none',
    reason: options.reason,
    allowedActionSummary: allowedSummary[level],
    blockedActionSummary: blockedSummary[level],
  }
}

function getGuidanceAuthorization(guidance: UserIntentGuidance): TurnAuthorization {
  return guidance.authorization ?? buildAuthorization({
    level: guidance.requiresTools ? 'inspect' : 'none',
    reason: 'Derived from simplified intent guidance.',
  })
}

function parseAuthorizationLevel(value: unknown, fallback: AuthorizationLevel): AuthorizationLevel {
  return parseEnum(value, ['none', 'inspect', 'local_change', 'shared_change', 'destructive'], fallback)
}

function parseConsentScope(value: unknown, fallback: ConsentScope): ConsentScope {
  return parseEnum(value, ['current_step', 'stated_plan', 'session_workflow'], fallback)
}

function parseConsentSource(value: unknown, fallback: ConsentSource): ConsentSource {
  return parseEnum(value, ['explicit_user', 'stated_plan_confirmation', 'trusted_session_rule', 'inferred_none'], fallback)
}

function parseSelectionKind(value: unknown, fallback: SelectionKind): SelectionKind {
  return parseEnum(value, ['none', 'preference', 'option', 'path', 'workflow_step'], fallback)
}

function parseProblemTarget(value: unknown, fallback: ProblemTarget): ProblemTarget {
  return parseEnum(value, ['agent_failure', 'runtime_replay', 'tool_evidence', 'project_feature', 'user_artifact', 'unknown'], fallback)
}

function parseEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && allowed.includes(value as T) ? (value as T) : fallback
}

function buildGuidance(guidance: UserIntentGuidance): UserIntentGuidance {
  return guidance
}

function findLatestUserText(events: NexusEvent[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event.type === 'user_message') {
      return event.text
    }
  }
  return ''
}

function countUserMessages(events: NexusEvent[]): number {
  return events.filter(e => e.type === 'user_message').length
}

// === Main Entry Points ===

/**
 * Derive fallback user intent guidance (when model is unavailable).
 *
 * Simplified: only essential intent classification + hard boundaries.
 */
export function deriveFallbackUserIntentGuidance(options: {
  events: NexusEvent[]
  latestPrompt: string
  cwd: string
  previousAuthorizationState?: SessionAuthorizationState
}): UserIntentGuidance {
  const latestUserText = options.latestPrompt || findLatestUserText(options.events)
  const explicitPaths = extractAbsolutePaths(latestUserText)
  const hasPriorUserTurns = countUserMessages(options.events) > 1
  const problemTarget: ProblemTarget = 'unknown'

  // Essential intent classification
  if (isPausePrompt(latestUserText)) {
    return buildGuidance({
      intent: 'pause',
      confidence: 0.92,
      continuity: 0.3,
      contextScope: 'recent',
      actionHint: 'respond_only',
      requiresTools: false,
      problemTarget,
      reason: 'The user asked to pause.',
      latestUserText,
      explicitPaths,
      source: 'fallback',
      authorization: buildAuthorization({
        level: 'none',
        reason: 'Pause request',
      }),
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
      reason: 'Greeting detected.',
      latestUserText,
      explicitPaths,
      source: 'fallback',
      authorization: buildAuthorization({
        level: 'none',
        reason: 'Greeting',
      }),
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
      reason: 'Correction detected.',
      latestUserText,
      explicitPaths,
      source: 'fallback',
    })
  }

  // Hard boundaries
  if (isDestructiveRequest(latestUserText)) {
    return buildGuidance({
      intent: 'continue',
      confidence: 0.95,
      continuity: 0.5,
      contextScope: 'full',
      actionHint: 'normal',
      requiresTools: true,
      problemTarget,
      reason: 'Destructive operation requested.',
      latestUserText,
      explicitPaths,
      source: 'fallback',
      authorization: buildAuthorization({
        level: 'destructive',
        source: 'explicit_user',
        reason: 'Destructive operation requires explicit confirmation.',
      }),
    })
  }

  if (isRemoteOperation(latestUserText)) {
    return buildGuidance({
      intent: 'continue',
      confidence: 0.95,
      continuity: 0.5,
      contextScope: 'full',
      actionHint: 'normal',
      requiresTools: true,
      problemTarget,
      reason: 'Remote operation requested.',
      latestUserText,
      explicitPaths,
      source: 'fallback',
      authorization: buildAuthorization({
        level: 'shared_change',
        source: 'explicit_user',
        reason: 'Remote operation requires authorization.',
      }),
    })
  }

  // Authorization inheritance
  if (isContinuationPhrase(latestUserText) && options.previousAuthorizationState) {
    const prev = options.previousAuthorizationState
    return buildGuidance({
      intent: 'continue',
      confidence: 0.88,
      continuity: 0.85,
      contextScope: 'full',
      actionHint: 'normal',
      requiresTools: true,
      problemTarget,
      reason: `Continuation phrase; inheriting ${prev.level}.`,
      latestUserText,
      explicitPaths,
      source: 'fallback',
      authorization: buildAuthorization({
        level: parseAuthorizationLevel(prev.level, 'inspect'),
        consentScope: parseConsentScope(prev.scope, 'current_step'),
        source: 'stated_plan_confirmation',
        reason: `Inherited from previous turn.`,
      }),
    })
  }

  // External paths
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
      reason: 'External paths detected.',
      latestUserText,
      explicitPaths,
      source: 'fallback',
    })
  }

  // Default: continue
  return buildGuidance({
    intent: 'continue',
    confidence: 0.66,
    continuity: hasPriorUserTurns ? 0.8 : 0.5,
    contextScope: 'full',
    actionHint: 'normal',
    requiresTools: true,
    problemTarget,
    reason: 'Default continue.',
    latestUserText,
    explicitPaths,
    source: 'fallback',
  })
}

/**
 * Normalize guidance policy - simplified.
 *
 * Only enforces hard boundaries. Trusts model for everything else.
 */
export function normalizeGuidancePolicy(guidance: UserIntentGuidance): UserIntentGuidance {
  // Hard boundary: destructive
  if (isDestructiveRequest(guidance.latestUserText)) {
    return {
      ...guidance,
      intent: 'continue',
      actionHint: 'normal',
      requiresTools: true,
      authorization: buildAuthorization({
        level: 'destructive',
        source: 'explicit_user',
        reason: 'Destructive operation requires explicit confirmation.',
      }),
    }
  }

  // Hard boundary: remote
  if (isRemoteOperation(guidance.latestUserText)) {
    return {
      ...guidance,
      intent: 'continue',
      actionHint: 'normal',
      requiresTools: true,
      authorization: buildAuthorization({
        level: 'shared_change',
        source: 'explicit_user',
        reason: 'Remote operation requires authorization.',
      }),
    }
  }

  // Respect pause/greeting intent
  if (guidance.intent === 'pause' || guidance.intent === 'greeting') {
    return {
      ...guidance,
      actionHint: 'respond_only',
      requiresTools: false,
      authorization: guidance.authorization ?? buildAuthorization({
        level: 'none',
        reason: `${guidance.intent} intent`,
      }),
    }
  }

  // Status without tools
  if (guidance.intent === 'status' && !guidance.requiresTools) {
    return {
      ...guidance,
      actionHint: 'respond_only',
    }
  }

  // Ensure tools visible for continue + normal
  if (guidance.intent === 'continue' && guidance.actionHint === 'normal') {
    return {
      ...guidance,
      requiresTools: true,
    }
  }

  // Default: trust model
  return guidance
}

/**
 * Should suppress tools for intent.
 */
export function shouldSuppressToolsForIntent(guidance: UserIntentGuidance): boolean {
  const normalized = normalizeGuidancePolicy(guidance)
  const authorization = getGuidanceAuthorization(normalized)
  if (normalized.intent === 'pause' || normalized.intent === 'greeting') return true
  if (isPureMemoryCapabilityQuestion(normalized.latestUserText)) return true
  if (authorization.level === 'none' && (authorization.selectionKind !== 'none' || isMetaBehaviorQuestion(normalized.latestUserText))) return true
  return false
}

export function getIntentCategory(guidance: UserIntentGuidance): IntentCategory {
  const normalized = normalizeGuidancePolicy(guidance)
  if (isPureMemoryCapabilityQuestion(normalized.latestUserText)) return 'pure_capability_question'
  if (normalized.problemTarget === 'agent_failure' || normalized.problemTarget === 'runtime_replay' || normalized.problemTarget === 'tool_evidence') return 'self_diagnosis_request'
  if (normalized.requiresTools || normalized.actionHint !== 'respond_only') return 'action_request'
  return 'general'
}

export function getToolSuppressionReason(guidance: UserIntentGuidance): string | undefined {
  const normalized = normalizeGuidancePolicy(guidance)
  if (!shouldSuppressToolsForIntent(normalized)) return undefined
  if (isPureMemoryCapabilityQuestion(normalized.latestUserText)) return 'respond_only_capability_question'
  const authorization = getGuidanceAuthorization(normalized)
  if (authorization.level === 'none' && authorization.selectionKind !== 'none') return `authorization:none:${authorization.selectionKind}_selection`
  if (authorization.level === 'none' && isMetaBehaviorQuestion(normalized.latestUserText)) return 'authorization:none'
  if (normalized.intent === 'pause') return 'pause'
  if (normalized.intent === 'greeting') return 'greeting'
  return 'respond_only'
}

// === Re-exports for compatibility ===

export function findLatestUserIntakeGuidance(events: NexusEvent[]): UserIntakeGuidanceEvent | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === 'user_intake_guidance') {
      return events[i] as UserIntakeGuidanceEvent
    }
  }
  return undefined
}

export function guidanceFromIntakeEvent(event: UserIntakeGuidanceEvent): UserIntentGuidance {
  const authorizationLevel = parseAuthorizationLevel(event.authorizationLevel, 'inspect')
  return normalizeGuidancePolicy({
    intent: event.intent,
    confidence: event.confidence,
    continuity: event.continuity,
    contextScope: event.contextScope,
    actionHint: event.actionHint,
    requiresTools: event.requiresTools,
    problemTarget: parseProblemTarget(event.problemTarget, 'unknown'),
    reason: event.reason,
    latestUserText: event.userText,
    explicitPaths: event.explicitPaths,
    source: event.source,
    authorization: buildAuthorization({
      level: authorizationLevel,
      consentScope: parseConsentScope(event.consentScope, 'current_step'),
      source: parseConsentSource(event.consentSource, 'inferred_none'),
      selectionKind: parseSelectionKind(event.selectionKind, 'none'),
      reason: event.authorizationReason ?? 'Legacy intake event without explicit authorization metadata.',
    }),
  })
}

export function toUserIntakeGuidanceEvent(options: {
  guidance: UserIntentGuidance
  sessionId: string
  turn?: number
}): UserIntakeGuidanceEvent {
  const guidance = normalizeGuidancePolicy(options.guidance)
  const authorization = getGuidanceAuthorization(guidance)
  return {
    type: 'user_intake_guidance',
    ...eventBase(options.sessionId),
    userText: guidance.latestUserText,
    intent: guidance.intent,
    confidence: guidance.confidence,
    continuity: guidance.continuity,
    contextScope: guidance.contextScope,
    actionHint: guidance.actionHint,
    requiresTools: guidance.requiresTools,
    problemTarget: guidance.problemTarget,
    authorizationLevel: authorization.level,
    consentScope: authorization.consentScope,
    consentSource: authorization.source,
    selectionKind: authorization.selectionKind,
    authorizationReason: authorization.reason,
    allowedActionSummary: authorization.allowedActionSummary,
    blockedActionSummary: authorization.blockedActionSummary,
    reason: guidance.reason,
    explicitPaths: guidance.explicitPaths,
    source: guidance.source,
  } as UserIntakeGuidanceEvent
}

export function formatUserIntentGuidance(guidance: UserIntentGuidance): string {
  const normalized = normalizeGuidancePolicy(guidance)
  const authorization = getGuidanceAuthorization(normalized)
  const lines = [
    `I: ${normalized.intent}`,
    `A: ${normalized.actionHint}`,
    `T: ${normalized.requiresTools ? 'yes' : 'no'}`,
    `Auth: ${authorization.level}`,
    `Why: ${normalized.reason}`,
  ]
  if (normalized.intent === 'greeting') {
    lines.push('Reply: brief greeting only; do not list capabilities, internal architecture, tool-call style, or work mode unless the user asks.')
  }
  return lines.join('\n')
}

export async function deriveUserIntentGuidance(options: {
  latestPrompt: string
  cwd: string
  events: NexusEvent[]
  previousAuthorizationState?: SessionAuthorizationState
}): Promise<UserIntentGuidance> {
  return deriveFallbackUserIntentGuidance({
    events: options.events,
    latestPrompt: options.latestPrompt,
    cwd: options.cwd,
    previousAuthorizationState: options.previousAuthorizationState,
  })
}

export function deriveUserIntentGuidanceSync(options: {
  events: NexusEvent[]
  latestPrompt: string
  cwd: string
  previousAuthorizationState?: SessionAuthorizationState
}): UserIntentGuidance {
  return deriveFallbackUserIntentGuidance(options)
}
