import { z } from 'zod'

export const NEXUS_EVENT_SCHEMA_VERSION = '2026-05-21.babel-o.v1'

const baseEventFields = {
  schemaVersion: z.literal(NEXUS_EVENT_SCHEMA_VERSION),
  sessionId: z.string(),
  timestamp: z.string(),
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

export const ToolCompletedEventSchema = z.object({
  type: z.literal('tool_completed'),
  ...baseEventFields,
  toolUseId: z.string(),
  name: z.string(),
  success: z.boolean(),
  output: z.unknown(),
  truncated: z.boolean().optional(),
  originalBytes: z.number().optional(),
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

export const PermissionRequestEventSchema = z.object({
  type: z.literal('permission_request'),
  ...baseEventFields,
  toolUseId: z.string(),
  name: z.string(),
  input: z.unknown(),
  risk: z.enum(['read', 'write', 'execute', 'task']),
  message: z.string().optional(),
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
  message: z.string(),
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
})

export const NexusEventSchema = z.discriminatedUnion('type', [
  SessionStartedEventSchema,
  AssistantDeltaEventSchema,
  ThinkingDeltaEventSchema,
  UserMessageEventSchema,
  UsageEventSchema,
  ToolStartedEventSchema,
  ToolCompletedEventSchema,
  ToolDeniedEventSchema,
  TaskCreatedEventSchema,
  ResultEventSchema,
  ErrorEventSchema,
  TaskSessionEventSchema,
  PermissionRequestEventSchema,
  PermissionResponseEventSchema,
  HookStartedEventSchema,
  HookCompletedEventSchema,
  HookFailedEventSchema,
  CompactBoundaryEventSchema,
  CompactFailureEventSchema,
  ContextWarningEventSchema,
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
