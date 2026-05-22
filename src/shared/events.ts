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

export const NexusEventSchema = z.discriminatedUnion('type', [
  SessionStartedEventSchema,
  AssistantDeltaEventSchema,
  ThinkingDeltaEventSchema,
  UserMessageEventSchema,
  ToolStartedEventSchema,
  ToolCompletedEventSchema,
  ToolDeniedEventSchema,
  TaskCreatedEventSchema,
  ResultEventSchema,
  ErrorEventSchema,
  TaskSessionEventSchema,
  PermissionRequestEventSchema,
  PermissionResponseEventSchema,
])

export type NexusEvent = z.infer<typeof NexusEventSchema>

export function eventBase(sessionId: string) {
  return {
    schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
    sessionId,
    timestamp: new Date().toISOString(),
  } as const
}

