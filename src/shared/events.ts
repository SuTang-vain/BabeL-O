import { z } from 'zod'

export const NEXUS_EVENT_SCHEMA_VERSION = '2026-05-21.babel-o.v1'

const baseEventFields = {
  schemaVersion: z.literal(NEXUS_EVENT_SCHEMA_VERSION),
  sessionId: z.string(),
  timestamp: z.string(),
}

const contextPolicyFields = {
  modelContextWindow: z.number().optional(),
  reservedOutputTokens: z.number().optional(),
  providerSafetyBufferTokens: z.number().optional(),
  effectiveContextCeiling: z.number().optional(),
  legacyContextCeiling: z.number().optional(),
  envMaxContextTokens: z.number().optional(),
  contextPolicySource: z.enum(['legacy', 'large_context', 'env_cap']).optional(),
}

export const SessionStartedEventSchema = z.object({
  type: z.literal('session_started'),
  ...baseEventFields,
  cwd: z.string(),
  requestId: z.string().optional(),
  model: z.string().optional(),
  budget: z.number().optional(),
})

export const AssistantDeltaEventSchema = z.object({
  type: z.literal('assistant_delta'),
  ...baseEventFields,
  text: z.string(),
})

export const ThinkingDeltaEventSchema = z.object({
  type: z.literal('thinking_delta'),
  ...baseEventFields,
  text: z.string(),
})

export const UserMessageEventSchema = z.object({
  type: z.literal('user_message'),
  ...baseEventFields,
  text: z.string(),
})

export const UserIntakeGuidanceEventSchema = z.object({
  type: z.literal('user_intake_guidance'),
  ...baseEventFields,
  userText: z.string(),
  intent: z.enum(['continue', 'new_focus', 'correction', 'pause', 'greeting', 'status']),
  confidence: z.number(),
  continuity: z.number(),
  contextScope: z.enum(['full', 'recent', 'new_focus']),
  actionHint: z.enum(['normal', 'prioritize_latest', 'respond_only']),
  requiresTools: z.boolean(),
  reason: z.string(),
  guidance: z.string(),
  explicitPaths: z.array(z.string()).default([]),
  source: z.enum(['model', 'fallback']),
})

export const UsageEventSchema = z.object({
  type: z.literal('usage'),
  ...baseEventFields,
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheCreationInputTokens: z.number().optional(),
  cacheReadInputTokens: z.number().optional(),
})

export const ToolStartedEventSchema = z.object({
  type: z.literal('tool_started'),
  ...baseEventFields,
  toolUseId: z.string(),
  name: z.string(),
  input: z.unknown(),
})

export const RemoteToolRunnerDiagnosticsSchema = z.object({
  runnerId: z.string(),
  protocolVersion: z.string(),
  durationMs: z.number().optional(),
  roundtripMs: z.number().optional(),
  truncated: z.boolean().optional(),
  originalBytes: z.number().optional(),
  exitCode: z.number().optional(),
  signal: z.string().optional(),
  cancelled: z.boolean().optional(),
  timedOut: z.boolean().optional(),
  errorCode: z.string().optional(),
})

export const ToolCompletedEventSchema = z.object({
  type: z.literal('tool_completed'),
  ...baseEventFields,
  toolUseId: z.string(),
  name: z.string(),
  success: z.boolean(),
  output: z.unknown(),
  truncated: z.boolean().optional(),
  originalBytes: z.number().optional(),
  remoteRunner: RemoteToolRunnerDiagnosticsSchema.optional(),
})

export const ToolDeniedEventSchema = z.object({
  type: z.literal('tool_denied'),
  ...baseEventFields,
  name: z.string(),
  risk: z.enum(['read', 'write', 'execute', 'task']),
  message: z.string(),
})

export const TaskCreatedEventSchema = z.object({
  type: z.literal('task_created'),
  ...baseEventFields,
  taskId: z.string(),
  title: z.string(),
})

export const ResultEventSchema = z.object({
  type: z.literal('result'),
  ...baseEventFields,
  success: z.boolean(),
  message: z.string(),
})

export const ErrorEventSchema = z.object({
  type: z.literal('error'),
  ...baseEventFields,
  code: z.string(),
  message: z.string(),
  details: z.unknown().optional(),
})

export const TaskSessionEventSchema = z.object({
  type: z.literal('task_session_event'),
  schemaVersion: z.literal(NEXUS_EVENT_SCHEMA_VERSION),
  sessionId: z.string(),
  eventId: z.string(),
  eventType: z.string(),
  phase: z.string(),
  timestamp: z.string(),
  payload: z.unknown().optional(),
})

export const AgentJobGovernanceEventSchema = z.object({
  maxConcurrentAgents: z.number(),
  activeAgents: z.number(),
  maxDepth: z.number(),
  depth: z.number(),
  maxRuntimeMs: z.number(),
  timeoutAt: z.string().optional(),
})

export const AgentJobEventSchema = z.object({
  type: z.literal('agent_job_event'),
  ...baseEventFields,
  eventId: z.string(),
  eventType: z.enum([
    'agent_job_queued',
    'agent_job_started',
    'agent_job_completed',
    'agent_job_failed',
    'agent_job_cancelled',
  ]),
  jobId: z.string(),
  childSessionId: z.string(),
  agentType: z.enum(['explore', 'review', 'test', 'implement', 'debug', 'general']),
  contextForkMode: z.enum(['minimal', 'working-set', 'task-focused', 'full-summary', 'debug-replay']),
  status: z.enum(['queued', 'running', 'waiting_permission', 'completed', 'failed', 'cancelled']),
  governance: AgentJobGovernanceEventSchema.optional(),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
})

export const PermissionRequestEventSchema = z.object({
  type: z.literal('permission_request'),
  ...baseEventFields,
  toolUseId: z.string(),
  name: z.string(),
  input: z.unknown(),
  risk: z.enum(['read', 'write', 'execute', 'task']),
  message: z.string().optional(),
  source: z.object({
    type: z.enum(['builtin', 'mcp']),
    serverName: z.string().optional(),
    originalName: z.string().optional(),
  }).optional(),
})

export const PermissionResponseEventSchema = z.object({
  type: z.literal('permission_response'),
  ...baseEventFields,
  toolUseId: z.string(),
  approved: z.boolean(),
  reason: z.string().optional(),
})

export const HookStartedEventSchema = z.object({
  type: z.literal('hook_started'),
  ...baseEventFields,
  hookName: z.string(),
  hookEvent: z.string(),
  toolUseId: z.string().optional(),
  toolName: z.string().optional(),
})

export const HookCompletedEventSchema = z.object({
  type: z.literal('hook_completed'),
  ...baseEventFields,
  hookName: z.string(),
  hookEvent: z.string(),
  toolUseId: z.string().optional(),
  toolName: z.string().optional(),
  output: z.unknown().optional(),
})

export const HookFailedEventSchema = z.object({
  type: z.literal('hook_failed'),
  ...baseEventFields,
  hookName: z.string(),
  hookEvent: z.string(),
  toolUseId: z.string().optional(),
  toolName: z.string().optional(),
  message: z.string(),
})

export const CompactBoundaryEventSchema = z.object({
  type: z.literal('compact_boundary'),
  ...baseEventFields,
  trigger: z.enum(['manual', 'auto', 'reactive']),
  summary: z.string(),
  beforeEventCount: z.number(),
  afterEventCount: z.number(),
  summaryChars: z.number(),
  snippedToolResults: z.number(),
  retainedEvents: z.array(z.unknown()).optional(),
  retainedSegment: z.object({
    retainedCount: z.number(),
    boundaryId: z.string().optional(),
    firstEventId: z.string().optional(),
    lastEventId: z.string().optional(),
    hash: z.string(),
  }).optional(),
  modelId: z.string().optional(),
  budget: z.unknown().optional(),
})

export const CompactFailureEventSchema = z.object({
  type: z.literal('compact_failure'),
  ...baseEventFields,
  trigger: z.enum(['manual', 'auto', 'reactive']),
  modelId: z.string().optional(),
  failureCount: z.number(),
  maxFailures: z.number(),
  message: z.string(),
})

export const ContextWarningEventSchema = z.object({
  type: z.literal('context_warning'),
  ...baseEventFields,
  modelId: z.string().optional(),
  tokenEstimate: z.number(),
  maxTokens: z.number(),
  percentUsed: z.number(),
  thresholdPercent: z.number(),
  ...contextPolicyFields,
  message: z.string(),
})

export const ContextBlockingEventSchema = z.object({
  type: z.literal('context_blocking'),
  ...baseEventFields,
  modelId: z.string().optional(),
  tokenEstimate: z.number(),
  maxTokens: z.number(),
  percentUsed: z.number(),
  warningThresholdTokens: z.number(),
  compactThresholdTokens: z.number(),
  blockingLimitTokens: z.number(),
  ...contextPolicyFields,
  httpStatus: z.literal(413),
  recoveryActions: z.array(z.enum(['compact', 'context', 'switch_model', 'reduce_tool_output'])),
  message: z.string(),
})

export const SessionMemoryUpdatedEventSchema = z.object({
  type: z.literal('session_memory_updated'),
  ...baseEventFields,
  path: z.string(),
  trigger: z.enum(['manual', 'auto', 'reactive']),
  summaryChars: z.number(),
  eventCount: z.number(),
  reason: z.enum(['compact', 'pause']).optional(),
  decisionReason: z.enum(['disabled', 'duplicate_turn', 'natural_pause', 'growth_threshold', 'forced', 'insufficient_signal']).optional(),
  estimatedTokensSinceLastUpdate: z.number().optional(),
  toolCallCount: z.number().optional(),
  summaryMaxChars: z.number().optional(),
  summaryMode: z.enum(['extractive']).optional(),
})

export const ExecutionMetricsEventSchema = z.object({
  type: z.literal('execution_metrics'),
  ...baseEventFields,
  requestId: z.string().optional(),
  executeDurationMs: z.number().optional(),
  providerFirstTokenMs: z.number().optional(),
  providerRequestDurationMs: z.number().optional(),
  streamDeltaCount: z.number().optional(),
  toolCallCount: z.number().optional(),
  toolRoundtripDurationMs: z.number().optional(),
  contextCharsIn: z.number().optional(),
  contextCharsOut: z.number().optional(),
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  cacheCreationInputTokens: z.number().optional(),
  cacheReadInputTokens: z.number().optional(),
  ...contextPolicyFields,
  contextWarningThresholdPercent: z.number().optional(),
  contextCompactThresholdPercent: z.number().optional(),
  contextWarningThresholdTokens: z.number().optional(),
  contextCompactThresholdTokens: z.number().optional(),
  contextBlockingLimitTokens: z.number().optional(),
  cacheReadRatio: z.number().optional(),
  cachePreservationMode: z.boolean().optional(),
  longContextUtilizationMode: z.boolean().optional(),
  prefixCacheImmutableRatio: z.number().optional(),
  prefixCacheVolatileContentLast: z.boolean().optional(),
  prefixCacheFingerprint: z.string().optional(),
  compactSummaryLatencyMs: z.number().optional(),
  toolCallTextLeakSuppressedCount: z.number().optional(),
  finalAnswerRetryCount: z.number().optional(),
  toolShapedTextPattern: z.string().optional(),
  remoteToolCallCount: z.number().optional(),
  remoteToolRunnerDurationMs: z.number().optional(),
})

export const NexusEventSchema = z.discriminatedUnion('type', [
  SessionStartedEventSchema,
  AssistantDeltaEventSchema,
  ThinkingDeltaEventSchema,
  UserMessageEventSchema,
  UserIntakeGuidanceEventSchema,
  UsageEventSchema,
  ToolStartedEventSchema,
  ToolCompletedEventSchema,
  ToolDeniedEventSchema,
  TaskCreatedEventSchema,
  ResultEventSchema,
  ErrorEventSchema,
  TaskSessionEventSchema,
  AgentJobEventSchema,
  PermissionRequestEventSchema,
  PermissionResponseEventSchema,
  HookStartedEventSchema,
  HookCompletedEventSchema,
  HookFailedEventSchema,
  CompactBoundaryEventSchema,
  CompactFailureEventSchema,
  ContextWarningEventSchema,
  ContextBlockingEventSchema,
  SessionMemoryUpdatedEventSchema,
  ExecutionMetricsEventSchema,
])

export type NexusEvent = z.infer<typeof NexusEventSchema>

export function eventBase(sessionId: string) {
  return {
    schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
    sessionId,
    timestamp: new Date().toISOString(),
  } as const
}
