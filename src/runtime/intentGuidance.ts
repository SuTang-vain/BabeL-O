import { relative, resolve } from 'node:path'
import type { ModelAdapter, ModelMessage } from '../providers/adapters/ModelAdapter.js'
import { eventBase, type NexusEvent } from '../shared/events.js'
import type { SessionAuthorizationState } from '../shared/session.js'
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

type IntentCategory =
  | 'pure_capability_question'
  | 'availability_check'
  | 'memory_save_request'
  | 'memory_retrieval_request'
  | 'self_diagnosis_request'
  | 'action_request'
  | 'general'

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
  /** Phase 2.3 of authorization-continuity: previous authorization state to inherit */
  previousAuthorizationState?: SessionAuthorizationState
}): Promise<UserIntakeGuidanceEvent> {
  const fallback = deriveFallbackUserIntentGuidance({
    events: options.events,
    latestPrompt: options.latestPrompt,
    cwd: options.cwd,
    previousAuthorizationState: options.previousAuthorizationState,
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
      previousAuthorizationState: options.previousAuthorizationState,
    })
    const parsed = parseIntakeModelOutput(text, fallback, options.previousAuthorizationState)
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
    authorization: {
      level: event.authorizationLevel ?? deriveDefaultAuthorizationLevel({
        intent: event.intent,
        actionHint: event.actionHint,
        requiresTools: event.requiresTools,
        latestUserText: event.userText,
      }),
      consentScope: event.consentScope ?? 'current_step',
      source: event.consentSource ?? 'inferred_none',
      selectionKind: event.selectionKind ?? 'none',
      reason: event.authorizationReason ?? 'Legacy intake event without explicit authorization metadata.',
      allowedActionSummary: event.allowedActionSummary ?? 'Follow the existing turn policy.',
      blockedActionSummary: event.blockedActionSummary ?? 'Do not perform actions beyond the user request.',
    },
  })
}

export function toUserIntakeGuidanceEvent(options: {
  sessionId: string
  guidance: UserIntentGuidance
}): UserIntakeGuidanceEvent {
  const guidance = normalizeGuidancePolicy(options.guidance)
  const authorization = getTurnAuthorization(guidance)
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
  }
}

export function formatUserIntentGuidance(guidance: UserIntentGuidance): string {
  const policy = deriveTurnPolicy(guidance)
  const intentCategory = deriveIntentCategory(guidance)
  const authorization = getTurnAuthorization(guidance)
  const lines = [
    '## Turn Policy',
    `Source: ${guidance.source}`,
    `Intent: ${guidance.intent}`,
    `Intent category: ${intentCategory}`,
    `Confidence: ${guidance.confidence.toFixed(2)}`,
    `Continuity with prior context: ${guidance.continuity.toFixed(2)}`,
    `Context scope: ${guidance.contextScope}`,
    `Action hint: ${guidance.actionHint}`,
    `Requires tools: ${guidance.requiresTools ? 'yes' : 'no'}`,
    `Authorization level: ${authorization.level}`,
    `Consent scope: ${authorization.consentScope}`,
    `Consent source: ${authorization.source}`,
    `Selection kind: ${authorization.selectionKind}`,
    `Authorized actions: ${authorization.allowedActionSummary}`,
    `Blocked actions: ${authorization.blockedActionSummary}`,
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
  if (isCurrentStateVerificationRequest(normalized.latestUserText)) return false
  // Tier 1 — hard suppress (unchanged): pure capability question, pause,
  // greeting. These are semantically respond-only; tooling would be
  // unnecessary. Suppress-then-nudge (MAX_SUPPRESSED_TOOL_RETRIES=1) stays.
  if (isPureMemoryCapabilityQuestion(normalized.latestUserText)) return true
  if (normalized.intent === 'pause' || normalized.intent === 'greeting') return true
  // Tier 2 — first-call passthrough (direction 2): task-continuation intents
  // (continue / new_focus / correction) where the model's requiresTools=false
  // is suspect (Mode B under-classification). Tools stay visible and emitted
  // tool calls pass through — the model's tool call is the ground-truth signal
  // that tools are needed. Over-tooling is handled by finalResponseOnlyMode
  // (TOOL_LOOP_FINAL_RESPONSE_ONLY), not intent suppression. The
  // option-confirmation gate (single-letter input) is handled independently in
  // providerTurn.ts and is not affected by this branch.
  const authorization = getTurnAuthorization(normalized)
  if (authorization.level === 'none' && (authorization.selectionKind !== 'none' || isMetaBehaviorQuestion(normalized.latestUserText))) return true
  if (normalized.intent === 'status') return false
  return false
}

export function getIntentCategory(guidance: UserIntentGuidance): IntentCategory {
  return deriveIntentCategory(normalizeGuidancePolicy(guidance))
}

export function getToolSuppressionReason(guidance: UserIntentGuidance): string | undefined {
  const normalized = normalizeGuidancePolicy(guidance)
  if (!shouldSuppressToolsForIntent(normalized)) return undefined
  if (isPureMemoryCapabilityQuestion(normalized.latestUserText)) return 'respond_only_capability_question'
  const authorization = getTurnAuthorization(normalized)
  if (authorization.level === 'none' && (authorization.selectionKind !== 'none' || isMetaBehaviorQuestion(normalized.latestUserText))) {
    if (authorization.selectionKind !== 'none') return `authorization:none:${authorization.selectionKind}_selection`
    return 'authorization:none'
  }
  if (normalized.intent === 'pause') return 'pause'
  if (normalized.intent === 'greeting') return 'greeting'
  if (normalized.actionHint === 'respond_only') return `intent:${normalized.intent}:respond_only`
  if (!normalized.requiresTools) return `intent:${normalized.intent}:tools_not_required`
  return 'respond_only'
}

export function deriveFallbackUserIntentGuidance(options: {
  events: NexusEvent[]
  latestPrompt: string
  cwd: string
  /** Phase 2.3: previous authorization state to inherit for continuation phrases */
  previousAuthorizationState?: SessionAuthorizationState
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

  if (isMemoryAvailabilityCheckRequest(latestUserText)) {
    return buildGuidance({
      intent: 'status',
      confidence: 0.86,
      continuity: hasPriorUserTurns ? 0.75 : 0.5,
      contextScope: 'full',
      actionHint: 'normal',
      requiresTools: true,
      problemTarget,
      reason: 'The user is asking to verify current memory availability with runtime or workspace evidence.',
      latestUserText,
      explicitPaths,
      source: 'fallback',
    })
  }

  if (isCurrentStateVerificationRequest(latestUserText)) {
    return buildGuidance({
      intent: 'continue',
      confidence: 0.86,
      continuity: hasPriorUserTurns ? 0.75 : 0.5,
      contextScope: 'full',
      actionHint: 'normal',
      requiresTools: true,
      problemTarget,
      reason: 'The user is asking to verify current runtime, tool, config, session, workspace, or capability state with evidence.',
      latestUserText,
      explicitPaths,
      source: 'fallback',
    })
  }

  if (isPureMemoryCapabilityQuestion(latestUserText)) {
    return buildGuidance({
      intent: 'status',
      confidence: 0.88,
      continuity: hasPriorUserTurns ? 0.75 : 0.5,
      contextScope: 'full',
      actionHint: 'respond_only',
      requiresTools: false,
      problemTarget,
      reason: 'The user is asking whether memory capability is available, not asking to verify or write memory now.',
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

  // Phase 2.3 of authorization-continuity: if the latest message is a
  // continuation phrase AND we have a previous authorization state to
  // inherit, use it instead of defaulting to inspect/inferred_none.
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
      reason: `Continuation phrase detected; inheriting previous authorization (${prev.level}/${prev.scope}).`,
      latestUserText,
      explicitPaths,
      source: 'fallback',
      authorization: buildAuthorization({
        level: prev.level as AuthorizationLevel,
        consentScope: prev.scope as ConsentScope,
        source: 'stated_plan_confirmation', // Inherited from previous turn
        selectionKind: 'none',
        reason: `Inherited from previous turn established at ${prev.establishedAt}`,
      }),
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
  /** Phase 2.3: previous authorization state to inherit */
  previousAuthorizationState?: SessionAuthorizationState
}): Promise<string> {
  // Build continuation context if we have previous authorization
  const continuationContext = options.previousAuthorizationState
    ? `\n\nPREVIOUS AUTHORIZATION CONTEXT:\n` +
      `- authorizationLevel: ${options.previousAuthorizationState.level}\n` +
      `- consentScope: ${options.previousAuthorizationState.scope}\n` +
      `- source: ${options.previousAuthorizationState.source}\n` +
      `- establishedAt: ${options.previousAuthorizationState.establishedAt}\n` +
      `If the latest message is a continuation phrase (继续任务, continue, etc.), inherit this authorization.`
    : ''

  const messages: ModelMessage[] = [
    {
      role: 'user',
      content: [
        'Analyze the latest user message for a coding agent intake step.',
        'Return only compact JSON with keys: intent, confidence, continuity, contextScope, actionHint, requiresTools, problemTarget, authorizationLevel, consentScope, consentSource, selectionKind, authorizationReason, reason, explicitPaths.',
        'intent must be one of: continue, new_focus, correction, pause, greeting, status.',
        'contextScope must be one of: full, recent, new_focus.',
        'actionHint must be one of: normal, prioritize_latest, respond_only.',
        'problemTarget must be one of: agent_failure, runtime_replay, tool_evidence, project_feature, user_artifact, unknown.',
        'authorizationLevel must be one of: none, inspect, local_change, shared_change, destructive.',
        'consentScope must be one of: current_step, stated_plan, session_workflow.',
        'consentSource must be one of: explicit_user, stated_plan_confirmation, trusted_session_rule, inferred_none.',
        'selectionKind must be one of: none, preference, option, path, workflow_step.',
        'requiresTools must be false for greeting/pause.',
        'Separate tool need from execution authorization. A preference or option selection without an execution verb has authorizationLevel=none even if prior context involved tools.',
        'Meta-behavior questions about why the agent acted, hesitated, modified files, or used tools must be status/respond_only/requiresTools=false/authorizationLevel=none.',
        'Use authorizationLevel=inspect for read-only verification. Use local_change for local edits/commits. Use shared_change for push/release/merge/PR remote effects. Use destructive for delete/overwrite/force operations.',
        'Classify the target semantically, not by matching literal phrases. Use agent_failure when the user is asking about the assistant or runtime behavior; runtime_replay when the target is transcript/tool-call replay; tool_evidence when the target is evidence coverage or source support; project_feature when the target is the product or repository feature itself.',
        'Use status/respond_only only when the user is asking for conversational state or pure capability information. If the latest message asks to verify, run, check, test, lint, build, inspect, modify, save memory, or call a named tool, keep requiresTools=true.',
        'Current-state verification requires tools: checking whether the current runtime, provider, model, tool, memory, config, session, workspace, git state, tests/build, MCP, remote runner, or service is available, enabled, supported, working, healthy, recorded, passing, or up to date is not a pure capability question.',
        'Chinese action cues such as 执行, 运行, 跑一下, 测试, 检查, 查看当前, 确认当前, 验证 normally indicate tool-backed verification when paired with current state or availability.',
        // === Phase 1: Continuation phrase handling ===
        'CONTINUATION PHRASES: Phrases like "继续任务", "继续", "continue", "keep going", "proceed" indicate the user wants to continue previous authorized work.',
        'When the latest message is a continuation phrase:',
        '- If recent user history shows explicit authorization (local_change, shared_change), inherit that authorizationLevel and consentScope.',
        '- If the user previously authorized a stated_plan, keep consentScope=stated_plan and consentSource=stated_plan_confirmation.',
        '- Do NOT downgrade authorization to inspect or none without explicit narrowing from the user.',
        '- requiresTools should remain true if the previous turn had requiresTools=true.',
        'Examples: "继续任务" after user said "写一篇文档" => authorizationLevel=local_change, consentScope=stated_plan; "continue" after user said "push to develop" => authorizationLevel=shared_change.',
        '=== End continuation phrase handling ===',
        'Category examples: pure capability question => status/respond_only/requiresTools=false; current memory status check => status/normal/requiresTools=true; execute a current availability check => continue/normal/requiresTools=true; save an explicit preference to long-term memory => continue/normal/requiresTools=true.',
        'Do not include natural-language behavioral instructions in the JSON. The runtime will derive execution policy from the structured fields.',
        `cwd: ${options.cwd}`,
        `recent user history:\n${options.history || '(none)'}`,
        continuationContext,
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

function parseIntakeModelOutput(text: string, fallback: UserIntentGuidance, previousAuthorizationState?: SessionAuthorizationState): UserIntentGuidance {
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

    // Phase 2.3: If model output has inferred_none but we have previous authorization
    // and the intent is continue (continuation), use previous authorization instead.
    let authorizationLevel = parseEnum(raw.authorizationLevel, ['none', 'inspect', 'local_change', 'shared_change', 'destructive'], fallback.authorization?.level ?? 'inspect')
    let consentScope = parseEnum(raw.consentScope, ['current_step', 'stated_plan', 'session_workflow'], fallback.authorization?.consentScope ?? 'current_step')
    let consentSource = parseEnum(raw.consentSource, ['explicit_user', 'stated_plan_confirmation', 'trusted_session_rule', 'inferred_none'], fallback.authorization?.source ?? 'inferred_none')

    // Inherit previous authorization if model produced inferred_none but we have explicit prior auth
    if (previousAuthorizationState && intent === 'continue' && consentSource === 'inferred_none' && authorizationLevel === 'inspect') {
      authorizationLevel = previousAuthorizationState.level as AuthorizationLevel
      consentScope = previousAuthorizationState.scope as ConsentScope
      consentSource = 'stated_plan_confirmation'
    }

    const selectionKind = parseEnum(raw.selectionKind, ['none', 'preference', 'option', 'path', 'workflow_step'], fallback.authorization?.selectionKind ?? 'none')
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
      authorization: buildAuthorization({
        level: authorizationLevel,
        consentScope,
        source: consentSource,
        selectionKind,
        reason: typeof raw.authorizationReason === 'string' && raw.authorizationReason.trim()
          ? raw.authorizationReason.trim()
          : fallback.authorization?.reason ?? 'Model-derived authorization.',
      }),
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

function getTurnAuthorization(guidance: UserIntentGuidance): TurnAuthorization {
  return guidance.authorization ?? deriveTurnAuthorization(guidance)
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
  if (guidance.intent === 'status' && !guidance.requiresTools && !isPureMemoryCapabilityQuestion(guidance.latestUserText)) {
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

function deriveIntentCategory(guidance: UserIntentGuidance): IntentCategory {
  const text = guidance.latestUserText
  if (isExplicitMemorySavePrompt(text)) return 'memory_save_request'
  if (isCurrentStateVerificationRequest(text)) return 'availability_check'
  if (isPureMemoryCapabilityQuestion(text)) return 'pure_capability_question'
  if (isMemoryRetrievalRequest(text)) return 'memory_retrieval_request'
  if (guidance.problemTarget === 'agent_failure' || guidance.problemTarget === 'runtime_replay' || guidance.problemTarget === 'tool_evidence') return 'self_diagnosis_request'
  if (isActionRequest(text)) return 'action_request'
  return 'general'
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

export function normalizeGuidancePolicy(guidance: UserIntentGuidance): UserIntentGuidance {
  const withAuthorization = (next: UserIntentGuidance): UserIntentGuidance => ({
    ...next,
    authorization: next.authorization ?? deriveTurnAuthorization(next),
  })
  if (isMetaBehaviorQuestion(guidance.latestUserText)) {
    return withAuthorization({
      ...guidance,
      intent: 'status',
      actionHint: 'respond_only',
      requiresTools: false,
      problemTarget: guidance.problemTarget === 'unknown' ? 'agent_failure' : guidance.problemTarget,
      authorization: buildAuthorization({
        level: 'none',
        selectionKind: 'none',
        reason: 'The user is asking about agent behavior or policy, not authorizing execution.',
      }),
    })
  }
  if (isPureMemoryCapabilityQuestion(guidance.latestUserText)) {
    return withAuthorization({
      ...guidance,
      intent: 'status',
      actionHint: 'respond_only',
      requiresTools: false,
      authorization: buildAuthorization({
        level: 'none',
        reason: 'The user asked a pure capability question, not an execution request.',
      }),
    })
  }
  if (isPreferenceOrOptionSelection(guidance.latestUserText) && !hasExecutionAuthorizationCue(guidance.latestUserText)) {
    return withAuthorization({
      ...guidance,
      intent: 'status',
      actionHint: 'respond_only',
      requiresTools: false,
      authorization: buildAuthorization({
        level: 'none',
        selectionKind: inferSelectionKind(guidance.latestUserText),
        reason: 'The user selected or named a preference without explicitly authorizing execution.',
      }),
    })
  }
  if (isDestructiveAuthorizationRequest(guidance.latestUserText)) {
    return withAuthorization({
      ...guidance,
      intent: 'continue',
      actionHint: 'normal',
      requiresTools: true,
      authorization: buildAuthorization({
        level: 'destructive',
        source: 'explicit_user',
        reason: 'The user named a destructive operation; exact-target confirmation remains required.',
      }),
    })
  }
  if (isSharedChangeAuthorizationRequest(guidance.latestUserText)) {
    return withAuthorization({
      ...guidance,
      intent: 'continue',
      actionHint: 'normal',
      requiresTools: true,
      authorization: buildAuthorization({
        level: 'shared_change',
        source: 'explicit_user',
        reason: 'The user explicitly requested a shared or remote side effect.',
      }),
    })
  }
  if (isLocalChangeAuthorizationRequest(guidance.latestUserText)) {
    return withAuthorization({
      ...guidance,
      intent: 'continue',
      actionHint: 'normal',
      requiresTools: true,
      authorization: buildAuthorization({
        level: 'local_change',
        source: 'explicit_user',
        consentScope: inferConsentScope(guidance.latestUserText, 'local_change'),
        reason: 'The user explicitly authorized local project work.',
      }),
    })
  }
  if (isExplicitMemorySavePrompt(guidance.latestUserText)) {
    return withAuthorization({
      ...guidance,
      intent: 'continue',
      actionHint: 'normal',
      requiresTools: true,
      authorization: buildAuthorization({
        level: 'local_change',
        source: 'explicit_user',
        selectionKind: 'none',
        reason: 'The user explicitly asked to save information to long-term memory.',
      }),
    })
  }
  if (isMemoryAvailabilityCheckRequest(guidance.latestUserText)) {
    return withAuthorization({
      ...guidance,
      intent: guidance.intent === 'status' ? 'status' : 'continue',
      actionHint: 'normal',
      requiresTools: true,
      authorization: buildAuthorization({
        level: 'inspect',
        reason: 'The user asked to verify current memory availability with evidence.',
      }),
    })
  }
  if (isCurrentStateVerificationRequest(guidance.latestUserText)) {
    return withAuthorization({
      ...guidance,
      intent: 'continue',
      actionHint: 'normal',
      requiresTools: true,
      authorization: buildAuthorization({
        level: 'inspect',
        reason: 'The user asked to inspect or verify current state with evidence.',
      }),
    })
  }
  if (guidance.intent === 'pause') {
    return withAuthorization({
      ...guidance,
      contextScope: 'recent',
      actionHint: 'respond_only',
      requiresTools: false,
      authorization: guidance.authorization ?? buildAuthorization({
        level: 'none',
        reason: 'The user asked the agent to pause or wait.',
      }),
    })
  }
  if (guidance.intent === 'greeting') {
    return withAuthorization({
      ...guidance,
      actionHint: 'respond_only',
      requiresTools: false,
      authorization: guidance.authorization ?? buildAuthorization({
        level: 'none',
        reason: 'The user sent a greeting or identity question.',
      }),
    })
  }
  if (guidance.intent === 'status' && !guidance.requiresTools) {
    return withAuthorization({
      ...guidance,
      actionHint: 'respond_only',
    })
  }
  // Stopgap Fix B (Mode B): continue + normal is self-contradictory with
  // requiresTools=false. The fallback default for continue is requiresTools=true
  // (deriveFallbackUserIntentGuidance), and the intake prompt itself instructs
  // that verify/run/check/test/inspect/modify keep requiresTools=true — so the
  // only path to this combo is model under-classification. Force tools visible.
  // requiresTools=true does NOT force a tool call; it only removes suppression
  // (see providerTurn.ts:163). Scoped to actionHint=normal so prioritize_latest,
  // pause, greeting, and status-without-tools paths (which set respond_only
  // above) are unaffected.
  if (guidance.intent === 'continue' && guidance.actionHint === 'normal') {
    return withAuthorization({ ...guidance, requiresTools: true })
  }
  return withAuthorization(guidance)
}

function deriveTurnAuthorization(guidance: UserIntentGuidance): TurnAuthorization {
  const level = deriveDefaultAuthorizationLevel(guidance)
  const selectionKind = inferSelectionKind(guidance.latestUserText)
  const source: ConsentSource = level === 'none' || level === 'inspect'
    ? 'inferred_none'
    : hasExecutionAuthorizationCue(guidance.latestUserText)
      ? 'explicit_user'
      : 'stated_plan_confirmation'
  return buildAuthorization({
    level,
    selectionKind,
    source,
    consentScope: inferConsentScope(guidance.latestUserText, level),
    reason: inferAuthorizationReason(guidance, level, selectionKind),
  })
}

function buildAuthorization(options: {
  level: AuthorizationLevel
  consentScope?: ConsentScope
  source?: ConsentSource
  selectionKind?: SelectionKind
  reason: string
}): TurnAuthorization {
  return {
    level: options.level,
    consentScope: options.consentScope ?? inferConsentScope('', options.level),
    source: options.source ?? (options.level === 'none' || options.level === 'inspect' ? 'inferred_none' : 'explicit_user'),
    selectionKind: options.selectionKind ?? 'none',
    reason: options.reason,
    allowedActionSummary: allowedActionSummaryForLevel(options.level),
    blockedActionSummary: blockedActionSummaryForLevel(options.level),
  }
}

export function deriveDefaultAuthorizationLevel(options: {
  intent: UserIntentKind
  actionHint: ActionHint
  requiresTools: boolean
  latestUserText: string
}): AuthorizationLevel {
  const text = options.latestUserText
  if (isDestructiveAuthorizationRequest(text)) return 'destructive'
  if (isSharedChangeAuthorizationRequest(text)) return 'shared_change'
  if (isMetaBehaviorQuestion(text)) return 'none'
  if (isPreferenceOrOptionSelection(text) && !hasExecutionAuthorizationCue(text)) return 'none'
  if (isLocalChangeAuthorizationRequest(text)) return 'local_change'
  if (isCurrentStateVerificationRequest(text) || isMemoryAvailabilityCheckRequest(text)) return 'inspect'
  if (options.intent === 'pause' || options.intent === 'greeting') return 'none'
  if (options.intent === 'status' && !options.requiresTools) return 'none'
  return options.requiresTools ? 'inspect' : 'none'
}

function inferAuthorizationReason(guidance: UserIntentGuidance, level: AuthorizationLevel, selectionKind: SelectionKind): string {
  if (level === 'none' && selectionKind !== 'none') return 'The latest message is a selection or preference without an execution verb.'
  if (level === 'none') return 'The latest message does not authorize tool-backed execution.'
  if (level === 'inspect') return 'The latest message authorizes read-only inspection or verification.'
  if (level === 'local_change') return 'The latest message authorizes local project changes within the stated task.'
  if (level === 'shared_change') return 'The latest message explicitly authorizes shared or remote side effects.'
  return 'The latest message explicitly authorizes a destructive operation, which still requires exact-target confirmation.'
}

function inferConsentScope(text: string, level: AuthorizationLevel): ConsentScope {
  if (level === 'destructive' || level === 'shared_change') return 'current_step'
  if (/(根据|按照|按).*(规划|计划|方案|建议|文档)|继续推进|开始推进|start implementing|proceed with (?:the )?(?:plan|proposal)/iu.test(text)) {
    return 'stated_plan'
  }
  if (/(统一|全部|都要|workflow|流程|全流程|直到完成)/iu.test(text)) return 'session_workflow'
  return 'current_step'
}

function allowedActionSummaryForLevel(level: AuthorizationLevel): string {
  switch (level) {
    case 'none':
      return 'Answer directly from existing context; do not start new task execution.'
    case 'inspect':
      return 'Use read-only inspection and verification tools when needed.'
    case 'local_change':
      return 'Perform local reversible edits, validation, and local git steps within the stated task.'
    case 'shared_change':
      return 'Perform the explicitly requested shared or remote operation after verifying current state.'
    case 'destructive':
      return 'Proceed only after exact-target confirmation for the destructive operation.'
  }
}

function blockedActionSummaryForLevel(level: AuthorizationLevel): string {
  switch (level) {
    case 'none':
      return 'Do not edit files, run mutating commands, commit, push, release, or delete resources.'
    case 'inspect':
      return 'Do not edit files, run mutating commands, commit, push, release, or delete resources.'
    case 'local_change':
      return 'Do not push, release, merge shared branches, close PRs, or perform destructive operations unless explicitly requested.'
    case 'shared_change':
      return 'Do not perform unrelated shared side effects or destructive operations.'
    case 'destructive':
      return 'Do not broaden the destructive target beyond the exact user-confirmed scope.'
  }
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

/**
 * Action-verb cue shared by isPureMemoryCapabilityQuestion (negation) and
 * isCurrentStateVerificationRequest (affirmative). Single source of truth for
 * the action-verb family so the two predicates cannot drift. Keep in sync with
 * the intake classifier prompt guidance (analyze/test/verify/run/check/inspect
 * -> requiresTools=true) in queryIntakeModel().
 */
function hasActionVerbCue(normalized: string, text: string): boolean {
  return /\b(run|execute|test|verify|inspect|check|diagnose|status)\b/iu.test(normalized) ||
    /(执行|运行|跑一下|跑|测试|测一下|实测|验证|检查|查看|查一下|确认|诊断|解释|说明|分析|核对)/u.test(text)
}

export function isPureMemoryCapabilityQuestion(text: string): boolean {
  if (isMemoryAvailabilityCheckRequest(text) || isExplicitMemorySavePrompt(text)) return false
  const normalized = text.trim().toLowerCase()
  // Stopgap Fix A (Mode A): an action verb indicates tool-backed work, not a
  // pure yes/no capability question. Without this, "能否分析记忆功能" matches the
  // capability-question regex and is forced respond-only, suppressing the
  // model's own tool calls. Pure capability questions carry no action verb and
  // are unaffected (e.g. "你有长期记忆吗").
  if (hasActionVerbCue(normalized, text)) return false
  return /\b(can you|could you|are you able to|do you have)\b.*\b(memory|remember|long[- ]term memory)\b/iu.test(normalized) ||
    /\b(memory|remember|long[- ]term memory)\b.*\b(available|enabled|write|save)\b/iu.test(normalized) ||
    /\b(is .*memory.*available|is .*long[- ]term memory.*available)\b/iu.test(normalized) ||
    /(能否|能不能|可以|可否|是否|有没有|有|具备|支持).*(写入|保存|记忆|长期记忆)/u.test(text) ||
    /(记忆|长期记忆).*(能否|能不能|可以|可否|是否|有没有|具备|支持|可用|启用)/u.test(text)
}

export function isCurrentStateVerificationRequest(text: string): boolean {
  if (isExplicitMemorySavePrompt(text)) return false
  if (isMemoryAvailabilityCheckRequest(text)) return true

  const normalized = text.trim().toLowerCase()
  const hasExplicitPath = extractAbsolutePaths(text).length > 0
  const hasDomainCue = hasExplicitPath ||
    /\b(runtime|provider|model|tool|config|configuration|session|workspace|git|test|tests|build|mcp|remote runner|service|source|code|implementation|architecture|document|docs?)\b/iu.test(normalized) ||
    /\b[a-z][\w-]*(?:_[\w-]+)+\b/iu.test(normalized) ||
    /(运行时|provider|模型|工具|配置|会话|session|工作区|workspace|git|未提交|改动|测试|构建|mcp|远程 runner|服务|源码|源文件|代码|实现|架构|文档|内核)/u.test(text)
  if (!hasDomainCue) return false

  const hasActionCue = hasActionVerbCue(normalized, text)
  const hasCurrentStateCue = /\b(current|now|this|latest|active|available|enabled|supported|working|healthy|status|recorded|passing|up to date)\b/iu.test(normalized) ||
    /(当前|目前|现在|这个|这部分|本次|本轮|最新|可用|启用|支持|生效|状态|记录|是否正常|通过|健康|最新)/u.test(text)
  const hasVerificationQuestionCue = /(?:\?|？|吗|是不是|是否|不就是|就是.*吗|对吗|问题.*在于|核心问题)/u.test(text)

  return (hasActionCue && hasCurrentStateCue) || (hasCurrentStateCue && hasVerificationQuestionCue)
}

export function isMemoryAvailabilityCheckRequest(text: string): boolean {
  const normalized = text.trim().toLowerCase()
  const hasMemory = /\b(memory|long[- ]term memory|memoryos)\b/iu.test(normalized) || /(记忆|长期记忆|memoryos)/u.test(text)
  if (!hasMemory) return false

  const hasActionCue = /\b(run|execute|test|verify|inspect|check|diagnose|status)\b/iu.test(normalized) ||
    /(执行|运行|跑一下|跑|测试|测一下|实测|验证|检查|查看当前|查一下|确认当前|诊断)/u.test(text)
  const hasCurrentStateCue = /\b(current|now|available|enabled|active|working|healthy|status|read\/?write)\b/iu.test(normalized) ||
    /(当前|现在|可用|启用|生效|状态|是否正常|能不能读写|读写)/u.test(text)

  return hasActionCue && hasCurrentStateCue
}

function isExplicitMemorySavePrompt(text: string): boolean {
  const normalized = text.trim().toLowerCase()
  const explicitEnglish = /\b(memory_save_note|remember this|save (?:this )?(?:to )?(?:long[- ]term )?memory|save to memory|remember:|remember that)\b/iu.test(normalized)
  if (explicitEnglish) return true

  const asksCapability = /\b(can you|could you|are you able to|do you have)\b.*\b(memory|remember|long[- ]term memory)\b/iu.test(normalized) ||
    /(能否|能不能|可以|可否|是否|有没有|具备).*(写入|保存|记忆|长期记忆|记住)/u.test(text) ||
    /(记忆|长期记忆).*(能否|能不能|可以|可否|是否|有没有|具备|可用|启用)/u.test(text)
  const explicitChineseCommand = /(请|帮我|立即|现在|把|将).*(记住|保存.*记忆|写入.*记忆|长期记忆.*写入|记忆保存)/u.test(text)
  if (asksCapability && !explicitChineseCommand) return false

  return explicitChineseCommand || /(记住|保存.*记忆|写入.*记忆|长期记忆.*写入|记忆保存)/u.test(text)
}

function isMemoryRetrievalRequest(text: string): boolean {
  const normalized = text.trim().toLowerCase()
  return /\b(do you remember|remember.*(?:before|last time|previous)|prior preferences|previous decisions|last time)\b/iu.test(normalized) ||
    /(你.*记得|还记得|之前|上次|我的偏好|历史.*(?:决策|上下文))/u.test(text)
}

function isActionRequest(text: string): boolean {
  const normalized = text.trim().toLowerCase()
  return /\b(start|run|build|test|execute|launch|verify|inspect|check|diagnose)\b/iu.test(normalized) ||
    /(开始|启动|运行|执行|构建|测试|验证|检查|诊断|跑一下|测一下)/u.test(text)
}

function isMetaBehaviorQuestion(text: string): boolean {
  const normalized = text.trim().toLowerCase()
  const asksWhy = /\bwhy\b/iu.test(normalized) || /(为什么|为啥|什么情况|怎么回事|咋回事)/u.test(text)
  const agentBehavior = /\b(hesitat\w*|tool|tools|modify|modified|edit|changed|directly|permission|policy|unauthorized|without asking)\b/iu.test(normalized) ||
    /(工具|犹豫|直接|修改|改了|编辑|权限|策略|擅自|未授权|没问我)/u.test(text)
  if (asksWhy && agentBehavior) return true
  return /(你.*(为什么|为啥).*(犹豫|直接|修改|改了|编辑|执行|调用工具|用工具)|为什么你会这么犹豫|你怎么直接修改|怎么直接改)/u.test(text)
}

function isPreferenceOrOptionSelection(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return false
  if (trimmed.length > 48) return false
  if (hasActionVerbCue(trimmed.toLowerCase(), trimmed)) return false
  if (/[。.!?？]/u.test(trimmed) && trimmed.length > 12) return false
  const token = trimmed.replace(/(?:吧|就行|即可|可以)$/u, '').trim()
  if (/^(?:[a-z]|[A-Z]|[0-9]+)$/u.test(token)) return true
  if (/^(?:选|选择|就|用|要|保留|采用)?\s*(?:第)?[一二三四五六七八九十0-9]+(?:个|项|种|版|号)?$/u.test(token)) return true
  if (/^(?:选|选择|就|用|要|保留|采用)\s*[\w.-]+$/iu.test(token)) return true
  if (/^[\w.-]+$/iu.test(token) && /(?:theme|forest|soft|dark|light|everforest|gruvbox|nord|dracula)/iu.test(token)) return true
  return false
}

function inferSelectionKind(text: string): SelectionKind {
  if (!isPreferenceOrOptionSelection(text)) return 'none'
  const token = text.trim().replace(/(?:吧|就行|即可|可以)$/u, '').trim()
  if (/^(?:[a-z]|[A-Z]|[0-9]+)$/u.test(token) || /(?:第)?[一二三四五六七八九十0-9]+(?:个|项|种|版|号)?/u.test(token)) return 'option'
  return 'preference'
}

function hasExecutionAuthorizationCue(text: string): boolean {
  const normalized = text.trim().toLowerCase()
  return /\b(do it|apply|implement|change|modify|edit|write|commit|push|merge|release|publish|delete|remove|overwrite|proceed|execute)\b/iu.test(normalized) ||
    /(直接|开始|推进|执行|实现|修改|改成|应用|写入|提交|推送|合并|发布|删除|移除|覆盖|按.*做|照.*做)/u.test(text)
}

/**
 * Checks if the text is a continuation phrase that indicates
 * the user wants to continue previous authorized work.
 *
 * These phrases should NOT be treated as new authorization requests,
 * but rather should inherit the authorization level from the previous turn.
 *
 * Phase 1 of authorization-continuity-execution-plan.md
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

export function isLocalChangeAuthorizationRequest(text: string): boolean {
  const normalized = text.trim().toLowerCase()
  if (isSharedChangeAuthorizationRequest(text) || isDestructiveAuthorizationRequest(text)) return false

  // Existing patterns
  if (/\b(apply|implement|change|modify|edit|write|commit|proceed|start implementing)\b/iu.test(normalized)) {
    return true
  }
  if (/(根据|按照|按).*(规划|计划|方案|建议|文档).*(推进|开始|实现|修改|处理)?/u.test(text)) {
    return true
  }
  if (/(开始推进|继续推进|实现|修改|改成|应用|写入|提交当前|创建分支|新建分支)/u.test(text)) {
    return true
  }

  // === Phase 1: Extended verbs and patterns ===

  // Extended action verbs (修复, 改, 补, etc.)
  if (/(修复|改|补|重构|优化|更新|调整|更改|改动|fix|patch|update|refactor)/iu.test(text)) {
    // Must be paired with a target, not just mentioning the verb
    if (/(这个|那个|当前|问题|文件|代码|bug|issue|版本|配置|内容|功能)/u.test(text) || /\b(this|that|the|current|version|config|content)\b/iu.test(normalized)) {
      return true
    }
  }

  // "改一下..." / "更改..." - simple change requests
  if (/(改一下|更改|改动)/u.test(text)) {
    return true
  }

  // "进入可写模式" / "进入编辑模式" - explicit request for write permission
  if (/进入.*(可写|编辑|修改).*模式/iu.test(text)) {
    return true
  }

  // "执行...方案" / "落实...方案" - executing a previously discussed plan
  if (/(执行|落实|实施|推进).*(方案|计划|建议|规划)/u.test(text)) {
    return true
  }

  // "就这样..." / "按这个..." - approval to proceed
  if (/(就|直接|按).*(这样|这个|那个).*(改|提交|执行|做|办)/u.test(text)) {
    return true
  }

  // "就用...方案" / "采用...方案" - approval to execute a plan
  if (/(就|直接|采用|选用).*(第.*方案|这个方案|那个方案|方案)/u.test(text)) {
    return true
  }

  // "继续...并(修改|执行)" - continuation with explicit action
  if (/继续.*并.*(修改|执行|推进|实现|改)/u.test(text)) {
    return true
  }

  return false
}

function isSharedChangeAuthorizationRequest(text: string): boolean {
  const normalized = text.trim().toLowerCase()
  return /\b(push|publish|release|merge (?:to|into)?\s*(?:main|master|develop)|close pr|pull request|remote)\b/iu.test(normalized) ||
    /(推送|远端|发布|release|合并到\s*(?:main|master|develop)|关闭\s*pr|关闭 pull request|创建\s*pr)/iu.test(text)
}

function isDestructiveAuthorizationRequest(text: string): boolean {
  const normalized = text.trim().toLowerCase()
  return /\b(rm -rf|delete|remove|overwrite|force delete|drop|wipe|reset --hard)\b/iu.test(normalized) ||
    /(删除|移除|覆盖|强制删除|清空|重置|reset --hard|rm -rf)/u.test(text)
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
