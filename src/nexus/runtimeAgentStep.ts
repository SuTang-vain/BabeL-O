import { z } from 'zod'
import { createDefaultNexusRuntime } from './createRuntime.js'
import type { AgentRoleDefinition } from './agentRoles.js'
import type { AgentStepRunner } from './agentLoop.js'
import type { NexusEvent } from '../shared/events.js'
import { recordTaskSessionNexusEvent } from './taskSession.js'
import { ConfigManager } from '../shared/config.js'
import { logger } from '../shared/logger.js'
import { getModel, UnknownModelError } from '../providers/registry.js'
import { allowlistedTools, type ToolPolicy } from '../runtime/LocalCodingRuntime.js'
import type { RemoteToolRunner } from '../runtime/remoteRunner.js'

type NexusRuntimeLike = Awaited<ReturnType<typeof createDefaultNexusRuntime>>['runtime']
type RuntimeErrorEvent = Extract<NexusEvent, { type: 'error' }>
type RolePolicyRuntime = NexusRuntimeLike & {
  withToolPolicy<T>(toolPolicy: ToolPolicy, fn: () => T): T
}

const ROLE_STEP_MAX_OUTPUT_TOKENS = 2048

export type RuntimeAgentStepOptions = {
  cwd?: string
  model?: string
  maxTurns?: number
  useStructuredOutputTool?: boolean
  maxRepairAttempts?: number
  allowedToolsOverride?: string[]
  signal?: AbortSignal
  executionEnvironment?: 'local' | 'docker' | 'remote'
  remoteRunner?: RemoteToolRunner
  allowedPaths?: string[]
  runtimeFactory?: () => Promise<NexusRuntimeLike>
  onUsageSummary?: (usage: RuntimeAgentStepUsageSummary) => void
}

type StructuredOutputCandidate = {
  source: string
  value: unknown
}

export type ProviderNeutralAgentFailureKind = 'provider_protocol' | 'json_parse_error' | 'schema_mismatch' | 'capability_gate' | 'runtime_error'

export type RuntimeAgentStepUsageSummary = {
  role: string
  eventCount: number
  toolCallCount: number
  toolResultCount: number
  toolFailedCount?: number
  toolDeniedCount?: number
  resultSuccess?: boolean
  resultMessage?: string
  errorCode?: string
  errorMessage?: string
  assistantTextPreview?: string
  thinkingTextPreview?: string
  lastToolName?: string
  lastToolSuccess?: boolean
  lastToolOutputPreview?: string
  resultUsage?: unknown
  modelUsage?: unknown
  permissionDenials?: unknown
  structuredOutput?: StructuredOutputDiagnostics
  repairAttempts?: number
}

export type StructuredOutputDiagnostics = {
  failureType: 'no_structured_json' | 'schema_mismatch' | 'provider_error'
  providerNeutralFailureKind: ProviderNeutralAgentFailureKind
  candidateCount: number
  candidateSources: string[]
  missingRequiredKeys?: string[]
  schemaErrors?: string[]
  assistantTextPreview?: string
  resultPayloadPreview?: string
  structuredOutputPreview?: string
}

export class RuntimeAgentStepError extends Error {
  constructor(
    message: string,
    readonly summary: RuntimeAgentStepUsageSummary,
    readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'RuntimeAgentStepError'
  }
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
    const allowedTools = options.allowedToolsOverride
      ? intersectAllowedTools(roleDefinition.toolPolicy.allowedTools, options.allowedToolsOverride)
      : roleDefinition.toolPolicy.allowedTools
    const runtimeForRole = withRoleToolPolicy(runtime, allowedTools)
    const prompt = buildAgentStepPrompt(roleDefinition, input)
    const textParts: string[] = []
    let resultPayload: unknown
    let structuredOutputPayload: unknown
    let resultUsage: unknown
    let modelUsage: unknown
    let permissionDenials: unknown
    let errorEvent: RuntimeErrorEvent | null = null
    let eventCount = 0
    let toolCallCount = 0
    let toolResultCount = 0
    let toolFailedCount = 0
    let toolDeniedCount = 0
    let resultSuccess: boolean | undefined
    let resultMessage: string | undefined
    let lastAssistantTextPreview: string | undefined
    let lastThinkingTextPreview: string | undefined
    let lastToolName: string | undefined
    let lastToolSuccess: boolean | undefined
    let lastToolOutputPreview: string | undefined

    const sessionId = (input as { sessionId: string }).sessionId
    const stepCwd = (input as { cwd?: string }).cwd ?? options.cwd ?? process.cwd()
    const stepAllowedPaths = (input as { allowedPaths?: string[] }).allowedPaths ?? options.allowedPaths

    const configManager = ConfigManager.getInstance()
    const settings = configManager.resolveSettings({
      role: roleDefinition.role,
      model: options.model,
    })
    const targetModelId = options.model || settings.modelId || 'local/coding-runtime'

    try {
      const modelDef = getModel(targetModelId)
      if (
        roleDefinition.toolPolicy.allowedTools.length > 0 &&
        !modelDef.capabilities.toolCalling
      ) {
        throw new Error(`Model "${targetModelId}" does not support tool calling`)
      }
      if (
        roleDefinition.modelPreference.capability === 'structured-output' &&
        !modelDef.capabilities.jsonOutput
      ) {
        throw new Error(`Model "${targetModelId}" does not support structured output`)
      }
    } catch (err) {
      if (err instanceof UnknownModelError) {
        // Allow unknown models to support custom models.
      } else {
        throw err
      }
    }

    try {
      for await (const event of runtimeForRole.executeStream({
        sessionId,
        prompt,
        cwd: stepCwd,
        role: roleDefinition.role,
        model: targetModelId,
        signal: options.signal,
        timeoutSignal: options.signal,
        replaySessionHistory: false,
        maxOutputTokens: ROLE_STEP_MAX_OUTPUT_TOKENS,
        skipPermissionCheck: !roleDefinition.toolPolicy.requiresApproval,
        executionEnvironment: options.executionEnvironment,
        remoteRunner: options.remoteRunner,
        allowedPaths: stepAllowedPaths,
      })) {
        const nexusEvent = event as NexusEvent
        eventCount += 1

        // Log/persist event to session in real-time
        recordTaskSessionNexusEvent(sessionId, nexusEvent)

        if (nexusEvent.type === 'assistant_delta') {
          textParts.push(nexusEvent.text)
          lastAssistantTextPreview = summarizeForDiagnostics(textParts.join(''))
        }
        if (nexusEvent.type === 'thinking_delta') {
          lastThinkingTextPreview = summarizeForDiagnostics(
            `${lastThinkingTextPreview ?? ''}${nexusEvent.text}`,
          )
        }
        if (nexusEvent.type === 'tool_started') toolCallCount += 1
        if (nexusEvent.type === 'tool_denied') {
          toolDeniedCount += 1
          resultMessage = nexusEvent.message
        }
        if (nexusEvent.type === 'tool_completed') {
          toolResultCount += 1
          lastToolName = nexusEvent.name
          lastToolSuccess = nexusEvent.success
          lastToolOutputPreview = summarizeForDiagnostics(nexusEvent.output)
          if (!nexusEvent.success) toolFailedCount += 1
        }
        if (nexusEvent.type === 'result') {
          resultPayload = (nexusEvent as { result?: unknown }).result
          structuredOutputPayload = (nexusEvent as { structuredOutput?: unknown }).structuredOutput
          resultUsage = (nexusEvent as { usage?: unknown }).usage
          modelUsage = (nexusEvent as { modelUsage?: unknown }).modelUsage
          permissionDenials = (nexusEvent as { permissionDenials?: unknown }).permissionDenials
          resultSuccess = nexusEvent.success
          resultMessage = nexusEvent.message
        }
        if (nexusEvent.type === 'error') {
          errorEvent = nexusEvent
        }
      }
    } catch (err) {
      const summary = buildUsageSummary({
        role: roleDefinition.role,
        eventCount,
        toolCallCount,
        toolResultCount,
        toolFailedCount,
        toolDeniedCount,
        resultSuccess,
        resultMessage,
        errorEvent,
        lastToolName,
        lastToolSuccess,
        lastToolOutputPreview,
        resultUsage,
        modelUsage,
        permissionDenials,
        assistantTextPreview: lastAssistantTextPreview,
        thinkingTextPreview: lastThinkingTextPreview,
      })
      const errorMessage = err instanceof Error ? err.message : String(err)
      const errorCode = options.signal?.aborted ? 'REQUEST_TIMEOUT' : 'RUNTIME_AGENT_STEP_ERROR'
      options.onUsageSummary?.({ ...summary, errorCode, errorMessage })
      throw err
    }

    if (errorEvent) {
      const summary = buildUsageSummary({
        role: roleDefinition.role,
        eventCount,
        toolCallCount,
        toolResultCount,
        toolFailedCount,
        toolDeniedCount,
        resultSuccess,
        resultMessage,
        errorEvent,
        lastToolName,
        lastToolSuccess,
        lastToolOutputPreview,
        resultUsage,
        modelUsage,
        permissionDenials,
        assistantTextPreview: lastAssistantTextPreview,
        thinkingTextPreview: lastThinkingTextPreview,
      })
      options.onUsageSummary?.(summary)
      throw new RuntimeAgentStepError(errorEvent.message, summary, errorEvent)
    }

    const summary = buildUsageSummary({
      role: roleDefinition.role,
      eventCount,
      toolCallCount,
      toolResultCount,
      toolFailedCount,
      toolDeniedCount,
      resultSuccess,
      resultMessage,
      errorEvent,
      lastToolName,
      lastToolSuccess,
      lastToolOutputPreview,
      resultUsage,
      modelUsage,
      permissionDenials,
      assistantTextPreview: lastAssistantTextPreview,
      thinkingTextPreview: lastThinkingTextPreview,
    })
    const assistantTextForParsing = buildAssistantTextForParsing(textParts, resultMessage)
    try {
      const parsed = await tryParseWithRepair({
        roleDefinition,
        input,
        resultPayload,
        assistantText: assistantTextForParsing,
        structuredOutputPayload,
        runtimeForRole,
        sessionId,
        targetModelId,
        cwd: stepCwd,
        signal: options.signal,
        executionEnvironment: options.executionEnvironment,
        remoteRunner: options.remoteRunner,
        allowedPaths: stepAllowedPaths,
        maxRepairAttempts: options.maxRepairAttempts ?? 1,
      })
      options.onUsageSummary?.({
        ...summary,
        ...(parsed.repairAttempts > 1 ? { repairAttempts: parsed.repairAttempts } : {}),
      })
      return parsed.output as TOutput
    } catch (err) {
      if (err instanceof RuntimeAgentStepError) {
        const failureSummary = {
          ...summary,
          structuredOutput: err.summary.structuredOutput,
          repairAttempts: err.summary.repairAttempts,
        }
        options.onUsageSummary?.(failureSummary)
        throw new RuntimeAgentStepError(err.message, failureSummary, err.cause)
      }
      throw err
    }
  }
}

async function tryParseWithRepair(context: {
  roleDefinition: AgentRoleDefinition
  input: unknown
  resultPayload: unknown
  assistantText: string
  structuredOutputPayload: unknown
  runtimeForRole: NexusRuntimeLike
  sessionId: string
  targetModelId: string
  cwd: string
  signal?: AbortSignal
  executionEnvironment?: 'local' | 'docker' | 'remote'
  remoteRunner?: RemoteToolRunner
  allowedPaths?: string[]
  maxRepairAttempts: number
}): Promise<{ output: unknown; repairAttempts: number }> {
  let attempt = 0
  let currentPrompt = buildAgentStepPrompt(context.roleDefinition, context.input)
  let currentTextParts: string[] = context.assistantText ? [context.assistantText] : []
  let currentResultPayload = context.resultPayload
  let currentStructuredOutputPayload = context.structuredOutputPayload
  let firstFailure: { error: unknown; diagnostics: StructuredOutputDiagnostics } | undefined

  while (attempt < context.maxRepairAttempts + 1) {
    attempt++

    // On first attempt, we already have the parsed values; on retries, re-execute
    if (attempt > 1) {
      const previousText = currentTextParts.join('')
      const previousResultPayload = currentResultPayload
      const previousStructuredOutputPayload = currentStructuredOutputPayload
      currentTextParts = []
      currentResultPayload = undefined
      currentStructuredOutputPayload = undefined

      const repairPrompt = buildRepairPrompt({
        roleDefinition: context.roleDefinition,
        input: context.input,
        attempt,
        previousText,
        previousResultPayload,
        previousStructuredOutputPayload,
      })
      currentPrompt = repairPrompt

      const executionResult = await executeRuntimeTurn(
        context.runtimeForRole,
        context.sessionId,
        currentPrompt,
        context.targetModelId,
        context.cwd,
        !context.roleDefinition.toolPolicy.requiresApproval,
        context.signal,
        context.executionEnvironment,
        context.remoteRunner,
        context.allowedPaths,
        (event) => {
          recordTaskSessionNexusEvent(context.sessionId, event)
          if (event.type === 'assistant_delta') currentTextParts.push(event.text)
          if (event.type === 'result') {
            currentResultPayload = (event as { result?: unknown }).result
            currentStructuredOutputPayload = (event as { structuredOutput?: unknown }).structuredOutput
          }
        },
      )
      if (currentTextParts.join('').trim().length === 0 && executionResult.resultMessage) {
        currentTextParts = [executionResult.resultMessage]
      }

      if (executionResult.errorEvent) {
        throw new RuntimeAgentStepError(
          executionResult.errorEvent.message,
          buildUsageSummaryFromExecution(executionResult),
          executionResult.errorEvent,
        )
      }
    }

    try {
      const parsed = parseStructuredAgentOutput(
        currentResultPayload,
        currentTextParts.join(''),
        context.roleDefinition.outputSchema,
        currentStructuredOutputPayload,
        context.input,
      )
      if (shouldRepairPlannerFallback(context.roleDefinition, parsed, attempt, context.maxRepairAttempts)) {
        throw new Error('Planner returned an empty plan; repair requires a smaller explicit task list.')
      }
      return { output: parsed, repairAttempts: attempt }
    } catch (err) {
      const diagnostics = buildStructuredOutputDiagnostics(
        err,
        currentResultPayload,
        currentTextParts.join(''),
        context.roleDefinition.outputSchema,
        currentStructuredOutputPayload,
      )
      firstFailure ??= { error: err, diagnostics }
      const isLastAttempt = attempt >= context.maxRepairAttempts + 1
      if (isLastAttempt) {
        const rootFailure = firstFailure ?? { error: err, diagnostics }
        const conservativeOutput = buildConservativeRoleOutput(
          context.roleDefinition,
          rootFailure.diagnostics,
        )
        if (conservativeOutput !== undefined) {
          return { output: conservativeOutput, repairAttempts: attempt }
        }
        const summary = buildUsageSummaryFromExecution({
          eventCount: 0,
          toolCallCount: 0,
          toolResultCount: 0,
          toolFailedCount: 0,
          toolDeniedCount: 0,
          resultSuccess: undefined,
          resultMessage: undefined,
          errorEvent: null,
        })
        throw new RuntimeAgentStepError(
          `Failed to parse ${context.roleDefinition.role} structured output after ${attempt} attempt(s): ${rootFailure.error instanceof Error ? rootFailure.error.message : String(rootFailure.error)}`,
          { ...summary, structuredOutput: rootFailure.diagnostics, repairAttempts: attempt },
          rootFailure.error,
        )
      }

      logger.debug(`Structured output repair attempt ${attempt} for ${context.roleDefinition.role}`, {
        error: err instanceof Error ? err.message : String(err),
        diagnostics,
      })
    }
  }

  // Should not reach here, but TypeScript needs it
  throw new Error('Repair loop exited unexpectedly')
}

function shouldRepairPlannerFallback(
  roleDefinition: AgentRoleDefinition,
  parsed: unknown,
  attempt: number,
  maxRepairAttempts: number,
): boolean {
  if (roleDefinition.role !== 'planner' || attempt > maxRepairAttempts) return false
  if (!isRecord(parsed) || !Array.isArray(parsed.tasks)) return false
  return parsed.tasks.some(task => {
    if (!isRecord(task) || !isRecord(task.metadata)) return false
    return task.metadata.generatedFallback === 'empty-planner-output'
  })
}

function intersectAllowedTools(roleTools: string[], overrideTools: string[]): string[] {
  const allowed = new Set(overrideTools.map(tool => tool.trim().toLowerCase()))
  return roleTools.filter(tool => allowed.has(tool.trim().toLowerCase()))
}

function buildRepairPrompt(options: {
  roleDefinition: AgentRoleDefinition
  input: unknown
  attempt: number
  previousText?: string
  previousResultPayload?: unknown
  previousStructuredOutputPayload?: unknown
}): string {
  const { roleDefinition, input, attempt } = options
  const role = roleDefinition.role
  let correctionInstruction = ''

  switch (role) {
    case 'planner':
      correctionInstruction = [
        'IMPORTANT: Your previous response was not valid JSON or did not match the required schema.',
        `Attempt ${attempt}: Return ONLY a smaller valid JSON object with "summary" and one to three concrete "tasks".`,
        'If the prior plan was empty or too broad, split the original goal into the smallest executable task list you can infer.',
        'Do not include any explanation, markdown formatting, or extra text.',
      ].join('\n')
      break
    case 'executor':
    case 'optimizer':
      correctionInstruction = [
        'IMPORTANT: Your previous response was not valid JSON or did not match the required schema.',
        `Attempt ${attempt}: Return ONLY a valid JSON object with "taskId" (string), "success" (boolean), and "result" (string).`,
        'Use the previous raw output to preserve the completed work summary in "result"; do not rerun tools just to restate it.',
        'Do not include any explanation, markdown formatting, or extra text.',
      ].join('\n')
      break
    case 'critic':
      correctionInstruction = [
        'IMPORTANT: Your previous response was not valid JSON or did not match the required schema.',
        `Attempt ${attempt}: Return ONLY a valid JSON object with "approved" (boolean) and optional "reason" (string).`,
        'If you cannot make a structured approval decision, return {"approved":false,"reason":"needs-human-review"}.',
        'Do not include any explanation, markdown formatting, or extra text.',
      ].join('\n')
      break
    default:
      correctionInstruction = [
        `Attempt ${attempt}: Please return ONLY a valid JSON object matching the schema below. No markdown, no explanation.`,
      ].join('\n')
  }

  const outputSchema = zodRoleOutputSchemaToJsonSchema(roleDefinition.outputSchema)
  return [
    roleDefinition.systemPrompt,
    '',
    correctionInstruction,
    '',
    'Previous invalid output:',
    summarizeRepairSource({
      text: options.previousText,
      resultPayload: options.previousResultPayload,
      structuredOutputPayload: options.previousStructuredOutputPayload,
    }),
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

function summarizeRepairSource(options: {
  text?: string
  resultPayload?: unknown
  structuredOutputPayload?: unknown
}): string {
  const parts = [
    options.text?.trim() ? `assistantText: ${options.text.trim()}` : undefined,
    options.resultPayload !== undefined ? `resultPayload: ${previewValue(options.resultPayload)}` : undefined,
    options.structuredOutputPayload !== undefined ? `structuredOutput: ${previewValue(options.structuredOutputPayload)}` : undefined,
  ].filter((part): part is string => Boolean(part))
  return parts.join('\n').slice(0, 2000) || '(empty)'
}

async function executeRuntimeTurn(
  runtime: NexusRuntimeLike,
  sessionId: string,
  prompt: string,
  model: string,
  cwd: string,
  skipPermissionCheck: boolean,
  signal: AbortSignal | undefined,
  executionEnvironment: 'local' | 'docker' | 'remote' | undefined,
  remoteRunner: RemoteToolRunner | undefined,
  allowedPaths: string[] | undefined,
  onEvent: (event: NexusEvent) => void,
): Promise<{
  errorEvent: RuntimeErrorEvent | null
  eventCount: number
  toolCallCount: number
  toolResultCount: number
  toolFailedCount: number
  toolDeniedCount: number
  resultSuccess?: boolean
  resultMessage?: string
}> {
  let errorEvent: RuntimeErrorEvent | null = null
  let eventCount = 0
  let toolCallCount = 0
  let toolResultCount = 0
  let toolFailedCount = 0
  let toolDeniedCount = 0
  let resultSuccess: boolean | undefined
  let resultMessage: string | undefined

  for await (const event of runtime.executeStream({
    sessionId,
    prompt,
    cwd,
    model,
    signal,
    timeoutSignal: signal,
    replaySessionHistory: false,
    maxOutputTokens: ROLE_STEP_MAX_OUTPUT_TOKENS,
    skipPermissionCheck,
    executionEnvironment,
    remoteRunner,
    allowedPaths,
  })) {
    const nexusEvent = event as NexusEvent
    eventCount++
    onEvent(nexusEvent)

    if (nexusEvent.type === 'tool_started') toolCallCount++
    if (nexusEvent.type === 'tool_denied') {
      toolDeniedCount++
      resultMessage = (nexusEvent as { message?: string }).message
    }
    if (nexusEvent.type === 'tool_completed') {
      toolResultCount++
      if (!(nexusEvent as { success?: boolean }).success) toolFailedCount++
    }
    if (nexusEvent.type === 'result') {
      resultSuccess = (nexusEvent as { success?: boolean }).success
      resultMessage = (nexusEvent as { message?: string }).message
    }
    if (nexusEvent.type === 'error') {
      errorEvent = nexusEvent as RuntimeErrorEvent
    }
  }

  return { errorEvent, eventCount, toolCallCount, toolResultCount, toolFailedCount, toolDeniedCount, resultSuccess, resultMessage }
}

function buildUsageSummaryFromExecution(execution: {
  eventCount: number
  toolCallCount: number
  toolResultCount: number
  toolFailedCount: number
  toolDeniedCount: number
  resultSuccess?: boolean
  resultMessage?: string
  errorEvent: RuntimeErrorEvent | null
}): RuntimeAgentStepUsageSummary {
  return {
    role: 'unknown',
    eventCount: execution.eventCount,
    toolCallCount: execution.toolCallCount,
    toolResultCount: execution.toolResultCount,
    toolFailedCount: execution.toolFailedCount,
    toolDeniedCount: execution.toolDeniedCount,
    resultSuccess: execution.resultSuccess,
    resultMessage: execution.resultMessage,
    errorCode: execution.errorEvent?.code,
    errorMessage: execution.errorEvent?.message,
  }
}

function buildAssistantTextForParsing(
  textParts: string[],
  resultMessage?: string,
): string {
  const streamedText = textParts.join('')
  if (streamedText.trim().length > 0) return streamedText
  return resultMessage ?? ''
}

function buildConservativeRoleOutput(
  roleDefinition: AgentRoleDefinition,
  diagnostics: StructuredOutputDiagnostics,
): unknown | undefined {
  if (roleDefinition.role !== 'critic') return undefined
  const output = {
    approved: false,
    reason: `needs-human-review: structured output ${diagnostics.failureType}`,
  }
  const parsed = roleDefinition.outputSchema.safeParse(output)
  return parsed.success ? parsed.data : undefined
}

function buildStructuredOutputDiagnostics(
  err: unknown,
  resultPayload: unknown,
  assistantText: string,
  outputSchema?: z.ZodTypeAny,
  structuredOutputPayload?: unknown,
): StructuredOutputDiagnostics {
  const candidates = collectStructuredOutputCandidates(
    resultPayload,
    assistantText,
    structuredOutputPayload,
  )
  const message = err instanceof Error ? err.message : String(err)
  const providerErrorCandidate = candidates
    .map(candidate => getProviderError(candidate.value))
    .find((providerError): providerError is string => Boolean(providerError))
  const schemaErrors = extractSchemaErrorSummaries(message)

  const failureType = providerErrorCandidate
    ? 'provider_error'
    : candidates.length > 0
      ? 'schema_mismatch'
      : 'no_structured_json'

  return {
    failureType,
    providerNeutralFailureKind: mapStructuredOutputFailureKind(failureType, message),
    candidateCount: candidates.length,
    candidateSources: candidates.map(candidate => candidate.source),
    missingRequiredKeys: inferMissingRequiredKeys(candidates, outputSchema),
    schemaErrors: schemaErrors.length > 0 ? schemaErrors : undefined,
    assistantTextPreview: summarizeForDiagnostics(assistantText),
    resultPayloadPreview: previewForDiagnostics(resultPayload),
    structuredOutputPreview: previewForDiagnostics(structuredOutputPayload),
  }
}

function mapStructuredOutputFailureKind(
  failureType: StructuredOutputDiagnostics['failureType'],
  message: string,
): ProviderNeutralAgentFailureKind {
  const normalized = message.toLowerCase()
  if (
    failureType === 'provider_error' ||
    normalized.includes('provider returned an error') ||
    normalized.includes('reasoning_content') ||
    normalized.includes('tool_call_id')
  ) {
    return 'provider_protocol'
  }
  if (normalized.includes('does not support tool calling') || normalized.includes('does not support structured output')) {
    return 'capability_gate'
  }
  if (failureType === 'schema_mismatch') return 'schema_mismatch'
  return 'json_parse_error'
}

function buildUsageSummary(input: {
  role: string
  eventCount: number
  toolCallCount: number
  toolResultCount: number
  toolFailedCount: number
  toolDeniedCount: number
  resultSuccess?: boolean
  resultMessage?: string
  errorEvent: RuntimeErrorEvent | null
  lastToolName?: string
  lastToolSuccess?: boolean
  lastToolOutputPreview?: string
  resultUsage?: unknown
  modelUsage?: unknown
  permissionDenials?: unknown
  assistantTextPreview?: string
  thinkingTextPreview?: string
}): RuntimeAgentStepUsageSummary {
  return {
    role: input.role,
    eventCount: input.eventCount,
    toolCallCount: input.toolCallCount,
    toolResultCount: input.toolResultCount,
    toolFailedCount: input.toolFailedCount,
    toolDeniedCount: input.toolDeniedCount,
    resultSuccess: input.resultSuccess,
    resultMessage: input.resultMessage,
    errorCode: input.errorEvent?.code,
    errorMessage: input.errorEvent?.message,
    assistantTextPreview: input.assistantTextPreview,
    thinkingTextPreview: input.thinkingTextPreview,
    lastToolName: input.lastToolName,
    lastToolSuccess: input.lastToolSuccess,
    lastToolOutputPreview: input.lastToolOutputPreview,
    resultUsage: input.resultUsage,
    modelUsage: input.modelUsage,
    permissionDenials: input.permissionDenials,
  }
}

function summarizeForDiagnostics(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  if (!text) return ''
  return text.length > 240 ? `${text.slice(0, 237)}...` : text
}

function previewForDiagnostics(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  return summarizeForDiagnostics(value)
}

function extractSchemaErrorSummaries(message: string): string[] {
  const lines = message
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
  const summaries: string[] = []

  for (const line of lines) {
    if (
      line.includes('Invalid input:') ||
      line.includes('expected') ||
      line.includes('Too small:') ||
      line.includes('Unrecognized key')
    ) {
      summaries.push(line)
    }
    if (summaries.length >= 4) break
  }

  return summaries
}

function inferMissingRequiredKeys(
  candidates: StructuredOutputCandidate[],
  outputSchema?: z.ZodTypeAny,
): string[] | undefined {
  if (!outputSchema) return undefined
  const requiredKeys = getRequiredZodObjectKeys(outputSchema)
  if (requiredKeys.length === 0) return undefined
  const missing = new Set<string>()

  for (const candidate of candidates) {
    if (!isRecord(candidate.value)) continue
    for (const key of requiredKeys) {
      if (!(key in candidate.value)) missing.add(key)
    }
  }

  return missing.size > 0 ? [...missing] : undefined
}

function withRoleToolPolicy<T extends NexusRuntimeLike>(runtime: T, allowedTools: string[]): T {
  if (!hasRolePolicyRuntime(runtime)) return runtime

  const rolePolicy = allowlistedTools(allowedTools)

  return new Proxy(runtime, {
    get(target, property, receiver) {
      if (property !== 'executeStream') {
        return Reflect.get(target, property, receiver)
      }
      return function executeStreamWithRolePolicy(...args: unknown[]) {
        return runtime.withToolPolicy(rolePolicy, () =>
          (target.executeStream as (...innerArgs: unknown[]) => AsyncIterable<NexusEvent>)(...args),
        )
      }
    },
  }) as T
}

function hasRolePolicyRuntime(runtime: NexusRuntimeLike): runtime is RolePolicyRuntime {
  return typeof (runtime as { withToolPolicy?: unknown }).withToolPolicy === 'function'
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
  inputDefaults?: unknown,
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
        inputDefaults,
      )
      if (normalized !== candidate.value) {
        const normalizedParsed = outputSchema.safeParse(normalized)
        if (normalizedParsed.success) return normalizedParsed.data
      }
      failures.push(parsed.error.message)
    }

    if (failures.length > 0) {
      const textFallback = buildStructuredOutputFromText(
        assistantText,
        outputSchema,
      )
      if (textFallback !== undefined) {
        return textFallback
      }
      throw new Error(
        [
          'Agent step returned JSON, but it did not match the role schema.',
          formatCandidateDiagnostics(candidates, failures),
        ].join('\n'),
      )
    }
  }

  const textFallback = buildStructuredOutputFromText(
    assistantText,
    outputSchema,
  )
  if (textFallback !== undefined) {
    return textFallback
  }

  throw new Error('Agent step did not return structured JSON output')
}

function buildStructuredOutputFromText(
  assistantText: string,
  outputSchema?: z.ZodTypeAny,
): unknown | undefined {
  if (!outputSchema) return undefined
  const schemaKeys = getZodObjectKeys(outputSchema)
  const isPlannerShape =
    schemaKeys.has('summary') &&
    schemaKeys.has('tasks')
  if (!isPlannerShape) return undefined

  const fallback = extractPlannerOutputFromText(assistantText)
  if (!fallback) return undefined
  const parsed = outputSchema.safeParse(fallback)
  return parsed.success ? parsed.data : undefined
}

function normalizeRoleOutputCandidate(
  value: unknown,
  outputSchema: z.ZodTypeAny,
  inputDefaults?: unknown,
): unknown {
  if (!isRecord(value)) return value
  if (outputSchema !== undefined && outputSchema !== null) {
    const schemaKeys = getZodObjectKeys(outputSchema)
    const isExecutorShape =
      schemaKeys.has('taskId') &&
      schemaKeys.has('success') &&
      schemaKeys.has('result')
    if (isExecutorShape) {
      return normalizeExecutorOutputCandidate(value, inputDefaults)
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
  if (!Array.isArray(value.tasks)) {
    if (Object.keys(value).length === 0 || typeof value.goal === 'string') {
      const summary = inferPlannerSummary(value) ?? 'Planner returned an empty plan; using conservative fallback.'
      return {
        ...value,
        summary,
        tasks: [
          {
            title: summary.slice(0, 80),
            description: 'Conservative fallback task generated because planner output was empty.',
            metadata: { generatedFallback: 'empty-planner-output' },
          },
        ],
      }
    }
    return value
  }

  return {
    ...value,
    ...(!('summary' in value) ? { summary: inferPlannerSummary(value) } : {}),
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
              : typeof task.action === 'string' && typeof task.file === 'string'
                ? `${task.action} ${task.file}`
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

function inferPlannerSummary(value: Record<string, unknown>): string | undefined {
  if (typeof value.summary === 'string') return value.summary
  if (typeof value.finalOutput === 'string') return value.finalOutput
  if (typeof value.goal === 'string') return value.goal
  if (typeof value.optimizationFocus === 'string') {
    return `Planned optimization with focus: ${value.optimizationFocus}`
  }
  return undefined
}

function extractPlannerOutputFromText(text: string): unknown | undefined {
  const lines = stripMarkdownFence(text)
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
  if (lines.length === 0) return undefined

  const tasks = lines
    .map(extractPlannerTaskFromLine)
    .filter((task): task is { title: string; description?: string } => task !== undefined)

  if (tasks.length === 0) return undefined

  const summaryLine =
    lines.find(line => !extractPlannerTaskFromLine(line) && !line.startsWith('|')) ??
    'Planner produced a fallback task list from natural language output.'

  return {
    summary: cleanMarkdownInline(summaryLine).slice(0, 240),
    tasks,
  }
}

function extractPlannerTaskFromLine(line: string): { title: string; description?: string } | undefined {
  if (line.startsWith('|')) return undefined
  const match = line.match(/^(?:[-*+]\s+|\d+[.)]\s+)(?:\[[ xX]\]\s+)?(.+)$/)
  if (!match) return undefined
  const cleaned = cleanMarkdownInline(match[1] ?? '')
  if (!cleaned) return undefined

  const separator = cleaned.match(/^([^:：\-–]+)[:：\-–]\s+(.+)$/)
  if (separator) {
    return {
      title: separator[1]!.trim().slice(0, 120),
      description: separator[2]!.trim(),
    }
  }
  return { title: cleaned.slice(0, 120) }
}

function cleanMarkdownInline(text: string): string {
  return text
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeExecutorOutputCandidate(
  value: Record<string, unknown>,
  inputDefaults?: unknown,
): unknown {
  const defaultTaskId = isRecord(inputDefaults) && typeof inputDefaults.taskId === 'string'
    ? inputDefaults.taskId
    : undefined
  const taskId = typeof value.taskId === 'string'
    ? value.taskId
    : typeof value.id === 'string'
      ? value.id
      : typeof value.id === 'number'
        ? String(value.id)
        : defaultTaskId
  const result =
    typeof value.result === 'string'
      ? value.result
      : isRecord(value.output) && typeof value.output.message === 'string'
        ? value.output.message
        : typeof value.summary === 'string'
          ? value.summary
          : typeof value.message === 'string'
            ? value.message
            : typeof value.finalOutput === 'string'
              ? value.finalOutput
              : Array.isArray(value.changes)
                ? `Completed with ${value.changes.length} reported change(s).`
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
  if (success === undefined) success = true

  const metadata: Record<string, unknown> = {}
  for (const key of ['sessionId', 'queueId', 'status', 'timestamp', 'executor', 'summary', 'role', 'output', 'message', 'finalOutput', 'changes']) {
    if (key in value) metadata[key] = value[key]
  }

  return {
    taskId,
    success,
    result,
    ...(typeof value.needsReview === 'boolean' ? { needsReview: value.needsReview } : {}),
    ...(Array.isArray(value.subTasks) ? { subTasks: value.subTasks } : {}),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  }
}

function getZodObjectKeys(schema: z.ZodTypeAny): Set<string> {
  const definition = schema._def as {
    type?: string
    typeName?: string
    shape?: (() => Record<string, z.ZodTypeAny>) | Record<string, z.ZodTypeAny>
  }
  if (definition.typeName !== 'ZodObject' && definition.type !== 'object') return new Set()
  const shape =
    typeof definition.shape === 'function'
      ? definition.shape()
      : definition.shape ?? {}
  return new Set(Object.keys(shape))
}

function getRequiredZodObjectKeys(schema: z.ZodTypeAny): string[] {
  const definition = schema._def as {
    type?: string
    typeName?: string
    shape?: (() => Record<string, z.ZodTypeAny>) | Record<string, z.ZodTypeAny>
  }
  if (definition.typeName !== 'ZodObject' && definition.type !== 'object') return []
  const shape =
    typeof definition.shape === 'function'
      ? definition.shape()
      : definition.shape ?? {}

  return Object.entries(shape)
    .filter(([, value]) => !value.isOptional())
    .map(([key]) => key)
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

export function zodRoleOutputSchemaToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const converted = z.toJSONSchema(schema)
  return isRecord(converted) ? converted : {}
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
