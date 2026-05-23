import { z } from 'zod'
import { createDefaultNexusRuntime } from './createRuntime.js'
import type { AgentRoleDefinition } from './agentRoles.js'
import type { AgentStepRunner } from './agentLoop.js'
import type { NexusEvent } from '../shared/events.js'
import { recordTaskSessionNexusEvent } from './taskSession.js'

type NexusRuntimeLike = Awaited<ReturnType<typeof createDefaultNexusRuntime>>['runtime']

export type RuntimeAgentStepOptions = {
  cwd?: string
  model?: string
  maxTurns?: number
  useStructuredOutputTool?: boolean
  runtimeFactory?: () => Promise<NexusRuntimeLike>
  onUsageSummary?: (usage: RuntimeAgentStepUsageSummary) => void
}

type StructuredOutputCandidate = {
  source: string
  value: unknown
}

export type RuntimeAgentStepUsageSummary = {
  role: string
  eventCount: number
  toolCallCount: number
  toolResultCount: number
  resultUsage?: unknown
  modelUsage?: unknown
  permissionDenials?: unknown
}

export function createRuntimeAgentStepRunner(
  options: RuntimeAgentStepOptions = {},
): AgentStepRunner {
  let runtimePromise: Promise<NexusRuntimeLike> | null = null

  async function getRuntime(): Promise<NexusRuntimeLike> {
    if (!runtimePromise) {
      const factory = options.runtimeFactory ?? (async () => (await createDefaultNexusRuntime()).runtime)
      runtimePromise = factory()
    }
    return runtimePromise
  }

  return async function runRuntimeAgentStep<TInput, TOutput>({
    roleDefinition,
    input,
  }: {
    roleDefinition: AgentRoleDefinition
    input: TInput
  }): Promise<TOutput> {
    const runtime = await getRuntime()
    const prompt = buildAgentStepPrompt(roleDefinition, input)
    const textParts: string[] = []
    let resultPayload: unknown
    let structuredOutputPayload: unknown
    let resultUsage: unknown
    let modelUsage: unknown
    let permissionDenials: unknown
    let errorEvent: NexusEvent | null = null
    let eventCount = 0
    let toolCallCount = 0
    let toolResultCount = 0

    const sessionId = (input as { sessionId: string }).sessionId

    for await (const event of runtime.executeStream({
      sessionId,
      prompt,
      cwd: options.cwd ?? process.cwd(),
      role: roleDefinition.role,
    })) {
      const nexusEvent = event as NexusEvent
      eventCount += 1

      // Log/persist event to session in real-time
      recordTaskSessionNexusEvent(sessionId, nexusEvent)

      if (nexusEvent.type === 'assistant_delta') {
        textParts.push(nexusEvent.text)
      }
      if (nexusEvent.type === 'tool_started') toolCallCount += 1
      if (nexusEvent.type === 'tool_completed') toolResultCount += 1
      if (nexusEvent.type === 'result') {
        resultPayload = (nexusEvent as { result?: unknown }).result
        structuredOutputPayload = (nexusEvent as { structuredOutput?: unknown }).structuredOutput
        resultUsage = (nexusEvent as { usage?: unknown }).usage
        modelUsage = (nexusEvent as { modelUsage?: unknown }).modelUsage
        permissionDenials = (nexusEvent as { permissionDenials?: unknown }).permissionDenials
      }
      if (nexusEvent.type === 'error') {
        errorEvent = nexusEvent
      }
    }

    if (errorEvent) {
      throw new Error(errorEvent.message)
    }

    const parsed = parseStructuredAgentOutput(
      resultPayload,
      textParts.join(''),
      roleDefinition.outputSchema,
      structuredOutputPayload,
    )
    options.onUsageSummary?.({
      role: roleDefinition.role,
      eventCount,
      toolCallCount,
      toolResultCount,
      resultUsage,
      modelUsage,
      permissionDenials,
    })
    return parsed as TOutput
  }
}

export function buildAgentStepPrompt(
  roleDefinition: AgentRoleDefinition,
  input: unknown,
): string {
  const outputSchema = zodRoleOutputSchemaToJsonSchema(roleDefinition.outputSchema)
  return [
    roleDefinition.systemPrompt,
    '',
    'Return only one JSON object. Do not wrap it in markdown.',
    'The JSON object must match this output schema exactly. Do not add substitute fields.',
    '',
    'Output JSON Schema:',
    JSON.stringify(outputSchema, null, 2),
    '',
    'Role:',
    roleDefinition.role,
    '',
    'Input:',
    JSON.stringify(input, null, 2),
  ].join('\n')
}

export function parseStructuredAgentOutput(
  resultPayload: unknown,
  assistantText: string,
  outputSchema?: z.ZodTypeAny,
  structuredOutputPayload?: unknown,
): unknown {
  const candidates = collectStructuredOutputCandidates(
    resultPayload,
    assistantText,
    structuredOutputPayload,
  )

  if (!outputSchema) {
    const first = candidates[0]
    if (first !== undefined) return first.value
  } else {
    const failures: string[] = []
    for (const candidate of candidates) {
      const providerError = getProviderError(candidate.value)
      if (providerError) {
        throw new Error(
          `Provider returned an error instead of role JSON: ${providerError}`,
        )
      }

      const parsed = outputSchema.safeParse(candidate.value)
      if (parsed.success) return parsed.data
      const normalized = normalizeRoleOutputCandidate(
        candidate.value,
        outputSchema,
      )
      if (normalized !== candidate.value) {
        const normalizedParsed = outputSchema.safeParse(normalized)
        if (normalizedParsed.success) return normalizedParsed.data
      }
      failures.push(parsed.error.message)
    }

    if (failures.length > 0) {
      throw new Error(
        [
          'Agent step returned JSON, but it did not match the role schema.',
          formatCandidateDiagnostics(candidates, failures),
        ].join('\n'),
      )
    }
  }

  throw new Error('Agent step did not return structured JSON output')
}

function normalizeRoleOutputCandidate(
  value: unknown,
  outputSchema: z.ZodTypeAny,
): unknown {
  if (!isRecord(value)) return value
  if (outputSchema !== undefined && outputSchema !== null) {
    const schemaKeys = getZodObjectKeys(outputSchema)
    const isExecutorShape =
      schemaKeys.has('taskId') &&
      schemaKeys.has('success') &&
      schemaKeys.has('result')
    if (isExecutorShape) {
      return normalizeExecutorOutputCandidate(value)
    }
    const isPlannerShape =
      schemaKeys.has('summary') &&
      schemaKeys.has('tasks')
    if (isPlannerShape) {
      return normalizePlannerOutputCandidate(value)
    }
  }
  return value
}

function normalizePlannerOutputCandidate(
  value: Record<string, unknown>,
): unknown {
  if (!Array.isArray(value.tasks)) return value

  return {
    ...value,
    ...(value.userPrompt === null ? { userPrompt: undefined } : {}),
    tasks: value.tasks.map(task => {
      if (!isRecord(task) || typeof task.title === 'string') return task
      const title =
        typeof task.taskId === 'string'
          ? task.taskId
          : typeof task.name === 'string'
            ? task.name
            : typeof task.description === 'string'
              ? task.description.slice(0, 80)
              : undefined
      if (!title) return task

      const metadata: Record<string, unknown> = {}
      for (const [key, itemValue] of Object.entries(task)) {
        if (!['title', 'description', 'dependsOn', 'metadata'].includes(key)) {
          metadata[key] = itemValue
        }
      }

      return {
        title,
        ...(typeof task.description === 'string'
          ? { description: task.description }
          : {}),
        ...(Array.isArray(task.dependsOn) ? { dependsOn: task.dependsOn } : {}),
        ...(Object.keys(metadata).length > 0
          ? { metadata: { ...(isRecord(task.metadata) ? task.metadata : {}), ...metadata } }
          : isRecord(task.metadata)
            ? { metadata: task.metadata }
            : {}),
      }
    }),
  }
}

function normalizeExecutorOutputCandidate(
  value: Record<string, unknown>,
): unknown {
  const taskId = typeof value.taskId === 'string' ? value.taskId : undefined
  const result =
    typeof value.result === 'string'
      ? value.result
      : isRecord(value.output) && typeof value.output.message === 'string'
        ? value.output.message
        : typeof value.summary === 'string'
          ? value.summary
          : undefined
  if (!taskId || !result) return value

  let success = typeof value.success === 'boolean' ? value.success : undefined
  if (success === undefined && typeof value.status === 'string') {
    const status = value.status.toLowerCase()
    if (['completed', 'complete', 'success', 'succeeded', 'passed'].includes(status)) {
      success = true
    } else if (['failed', 'error', 'rejected'].includes(status)) {
      success = false
    }
  }
  if (success === undefined) return value

  const metadata: Record<string, unknown> = {}
  for (const key of ['sessionId', 'queueId', 'status', 'timestamp', 'executor', 'summary', 'role', 'output']) {
    if (key in value) metadata[key] = value[key]
  }

  return {
    taskId,
    success,
    result,
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  }
}

function getZodObjectKeys(schema: z.ZodTypeAny): Set<string> {
  const definition = schema._def as {
    typeName?: string
    shape?: (() => Record<string, z.ZodTypeAny>) | Record<string, z.ZodTypeAny>
  }
  if (definition.typeName !== 'ZodObject') return new Set()
  const shape =
    typeof definition.shape === 'function'
      ? definition.shape()
      : definition.shape ?? {}
  return new Set(Object.keys(shape))
}

function collectStructuredOutputCandidates(
  resultPayload: unknown,
  assistantText: string,
  structuredOutputPayload?: unknown,
): StructuredOutputCandidate[] {
  const candidates: StructuredOutputCandidate[] = []
  addStructuredOutputCandidate(
    candidates,
    'result.structuredOutput',
    structuredOutputPayload,
  )
  addStructuredOutputCandidate(candidates, 'resultPayload', resultPayload)

  if (isRecord(resultPayload)) {
    addStructuredOutputCandidate(candidates, 'resultPayload.result', resultPayload.result)
    addStructuredOutputCandidate(candidates, 'resultPayload.output', resultPayload.output)
    addStructuredOutputCandidate(candidates, 'resultPayload.data', resultPayload.data)
    addStructuredOutputCandidate(
      candidates,
      'resultPayload.structured_output',
      resultPayload.structured_output,
    )
  }

  addStructuredOutputCandidate(candidates, 'assistantText', assistantText)
  return candidates
}

function addStructuredOutputCandidate(
  candidates: StructuredOutputCandidate[],
  source: string,
  value: unknown,
): void {
  if (isRecord(value)) {
    candidates.push({ source, value })
    return
  }

  if (typeof value !== 'string') return
  const parsed = tryParseJsonLike(value)
  if (parsed !== undefined) {
    candidates.push({ source, value: parsed })
  }
}

function formatCandidateDiagnostics(
  candidates: StructuredOutputCandidate[],
  failures: string[],
): string {
  return candidates
    .map((candidate, index) => {
      const value = candidate.value
      const keys = isRecord(value) ? Object.keys(value).slice(0, 12) : []
      return [
        `Candidate ${index + 1} (${candidate.source})`,
        `keys: ${keys.length ? keys.join(', ') : '(none)'}`,
        `preview: ${previewValue(value)}`,
        `schemaError: ${failures[index] ?? 'unknown'}`,
      ].join('\n')
    })
    .join('\n\n')
}

function getProviderError(value: unknown): string | null {
  if (!isRecord(value) || !isRecord(value.error)) return null

  const code =
    typeof value.error.code === 'string' || typeof value.error.code === 'number'
      ? String(value.error.code)
      : 'unknown'
  const message =
    typeof value.error.message === 'string'
      ? value.error.message
      : previewValue(value.error)
  const requestId =
    typeof value.request_id === 'string' ? ` request_id=${value.request_id}` : ''

  return `code=${code} message=${message}${requestId}`
}

function previewValue(value: unknown): string {
  try {
    return JSON.stringify(value).slice(0, 700)
  } catch {
    return String(value).slice(0, 700)
  }
}

function zodRoleOutputSchemaToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const converted = zodToJsonSchemaShape(schema)
  return isRecord(converted) ? converted : {}
}

function zodToJsonSchemaShape(schema: z.ZodTypeAny): unknown {
  const definition = (schema._def as any) as {
    typeName?: string
    shape?: (() => Record<string, z.ZodTypeAny>) | Record<string, z.ZodTypeAny>
    innerType?: z.ZodTypeAny
    type?: z.ZodTypeAny
    valueType?: z.ZodTypeAny
  }

  if (definition.typeName === 'ZodOptional') {
    return zodToJsonSchemaShape(definition.innerType!)
  }

  if (definition.typeName === 'ZodString') return { type: 'string' }
  if (definition.typeName === 'ZodBoolean') return { type: 'boolean' }
  if (definition.typeName === 'ZodNumber') return { type: 'number' }
  if (definition.typeName === 'ZodArray') {
    return {
      type: 'array',
      items: zodToJsonSchemaShape(definition.type!),
    }
  }
  if (definition.typeName === 'ZodUnknown' || definition.typeName === 'ZodAny') {
    return {}
  }
  if (definition.typeName === 'ZodRecord') {
    return {
      type: 'object',
      additionalProperties: zodToJsonSchemaShape(definition.valueType!),
    }
  }
  if (definition.typeName === 'ZodObject') {
    const shape =
      typeof definition.shape === 'function'
        ? definition.shape()
        : definition.shape ?? {}
    const properties: Record<string, unknown> = {}
    const required: string[] = []

    for (const [key, value] of Object.entries(shape)) {
      properties[key] = zodToJsonSchemaShape(value)
      if (!value.isOptional()) required.push(key)
    }

    return {
      type: 'object',
      properties,
      required,
      additionalProperties: false,
    }
  }

  return {}
}

function tryParseJsonLike(text: string): unknown | undefined {
  const trimmed = stripMarkdownFence(text.trim())
  if (!trimmed) return undefined

  try {
    return JSON.parse(trimmed)
  } catch {
    const firstBrace = trimmed.indexOf('{')
    const lastBrace = trimmed.lastIndexOf('}')
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      try {
        return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1))
      } catch {
        return undefined
      }
    }
    return undefined
  }
}

function stripMarkdownFence(text: string): string {
  if (!text.startsWith('```')) return text

  const lines = text.split('\n')
  if (lines.length < 3) return text
  if (lines.at(-1)?.trim() !== '```') return text

  const body = lines.slice(1, -1)
  if (body[0]?.trim().toLowerCase() === 'json') {
    body.shift()
  }
  return body.join('\n').trim()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
