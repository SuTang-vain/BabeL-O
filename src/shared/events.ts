import { z } from 'zod'

/**
 * NOTE — Skill events live in `./skillEvents.ts` (`skill_matched` /
 * `skill_invoked` / `skill_validation` / `skill_saved`) but are
 * intentionally not part of this discriminated union. See skillEvents.ts
 * for the rationale and re-integration plan.
 */

export const NEXUS_EVENT_SCHEMA_VERSION = '2026-05-21.babel-o.v1'

export const baseEventFields = {
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
  problemTarget: z.enum(['agent_failure', 'runtime_replay', 'tool_evidence', 'project_feature', 'user_artifact', 'unknown']).optional(),
  reason: z.string(),
  guidance: z.string().optional(),
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
  /**
   * Per-input effective risk after the tool's `riskForInput` override is
   * applied. Differs from the tool's static `risk` for tools like Bash
   * whose classifier downgrades read-only subcommands. Populated by
   * the runtime when the tool defines `riskForInput`; otherwise omitted
   * (callers should fall back to the tool's static risk).
   */
  effectiveRisk: z.enum(['read', 'write', 'execute', 'task']).optional(),
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
  toolUseId: z.string().optional(),
  name: z.string(),
  risk: z.enum(['read', 'write', 'execute', 'task']),
  message: z.string(),
  denialKind: z.enum(['policy', 'hook', 'optimizer_safety', 'permission']).optional(),
  recoverable: z.boolean().optional(),
  terminal: z.boolean().optional(),
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

export const ExecuteSummaryEventSchema = z.object({
  type: z.literal('execute_summary'),
  ...baseEventFields,
  requestId: z.string().optional(),
  timeoutMs: z.number().int().nonnegative(),
  executeDurationMs: z.number().nonnegative(),
  nearTimeout: z.boolean(),
  outcome: z.enum(['success', 'error', 'cancelled', 'timeout']),
})

export const NearTimeoutWarningEventSchema = z.object({
  type: z.literal('near_timeout_warning'),
  ...baseEventFields,
  requestId: z.string().optional(),
  timeoutMs: z.number().int().positive(),
  elapsedMs: z.number().nonnegative(),
  thresholdRatio: z.number(),
  partialSummary: z.string().optional(),
  message: z.string(),
})

/**
 * Soft-budget exhaustion event (Phase 2 of the
 * task-adaptive-recoverable-timeout plan).
 *
 * Emitted once when the soft timeout budget has been reached but the
 * runtime is intentionally NOT aborted — the hard watchdog is still
 * running. The model sees this event in its next provider call and is
 * expected to decide between continuing, summarizing, narrowing
 * scope, or retrying the last tool with a larger budget.
 *
 * Unlike `near_timeout_warning` (fires at thresholdRatio * timeoutMs
 * to nudge the model toward an early summary), this event fires AT
 * the budget itself and is only produced when the request opted into
 * `timeoutPolicy: 'soft'`.
 */
export const TimeoutBudgetExceededEventSchema = z.object({
  type: z.literal('timeout_budget_exceeded'),
  ...baseEventFields,
  requestId: z.string().optional(),
  timeoutMs: z.number().int().positive(),
  elapsedMs: z.number().nonnegative(),
  policy: z.literal('soft'),
  partialSummary: z.string().optional(),
  suggestedActions: z.array(z.enum(['continue', 'summarize', 'narrow_scope', 'retry_last_tool'])).optional(),
  message: z.string(),
})

/**
 * Soft-budget extension granted (Phase 3 of the
 * task-adaptive-recoverable-timeout plan).
 *
 * Emitted right after a `timeout_budget_exceeded` event when the
 * runtime has an extension allowance left. The extension is granted
 * automatically so the model has time to react to the budget warning
 * with a deliberate choice (continue / summarize / narrow_scope /
 * retry_last_tool); without it the model would have to react inside
 * the same provider step that produced the exhaustion, which the
 * model usually cannot do.
 *
 * `extensionCount` is 1-indexed and counts the extension just
 * granted. `totalSoftBudgetMs` is the new running soft budget after
 * the extension is applied. Hard watchdog is never extended here —
 * it remains the only fatal cutoff.
 */
export const TimeoutExtensionGrantedEventSchema = z.object({
  type: z.literal('timeout_extension_granted'),
  ...baseEventFields,
  requestId: z.string().optional(),
  extensionCount: z.number().int().positive(),
  maxExtensions: z.number().int().nonnegative(),
  additionalMs: z.number().int().positive(),
  totalSoftBudgetMs: z.number().int().positive(),
  elapsedMs: z.number().nonnegative(),
  policy: z.literal('soft'),
  reason: z.enum(['auto-first-budget-exhausted', 'auto-followup-budget-exhausted']),
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
    // Phase 2 of docs/nexus/proposals/daemon-graceful-shutdown-and-orphan-reaper-plan.md:
    // reaper emits a dedicated event type so dashboards can distinguish
    // an orphan-reaped job from a normal failure.
    'agent_job_orphaned',
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
  /**
   * Model-suggested allow rule (e.g. `cd:./repo`, `git:status`,
   * `npm install`). Surfaced from the tool's `suggestedAllowRule`
   * plus a per-input deriver. The Go TUI permission panel
   * presents it to the user as the default rule for the
   * "Approve for this session" and "Approve with editable rule"
   * options. Optional; when absent the panel falls back to a
   * placeholder ("<tool-name>:*").
   */
  suggestedRule: z.string().optional(),
  scopeRisk: z.enum(['none', 'outside_current_project', 'sibling_repo', 'parent_scan', 'historical_path', 'memory_hit_path', 'global_cache_path']).optional(),
  targetRoot: z.string().optional(),
  taskPrimaryRoot: z.string().optional(),
  scopeReason: z.string().optional(),
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
  /**
   * Scope of the decision (Phase A.1 of the enhanced permission
   * panel):
   *   - 'once' (default): apply to the current call only.
   *   - 'session': apply the rule to the remainder of the session;
   *     requires `rule` to be set.
   *   - 'rule' (future): persist a custom rule (e.g. user-edited);
   *     requires `rule` to be set.
   */
  scope: z.enum(['once', 'session', 'rule']).optional(),
  /**
   * The actual allow rule when `scope` is 'session' or 'rule'.
   * Ignored for scope='once'.
   */
  rule: z.string().optional(),
  /**
   * User feedback text the model should act on (typically
   * paired with `approved: false` for the
   * "Reject, tell the model what to do instead" path).
   */
  feedback: z.string().optional(),
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
  preTokens: z.number().optional(),
  postTokens: z.number().optional(),
  estimatedTokensSaved: z.number().optional(),
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

export const ContextCompactBoundaryEventSchema = z.object({
  type: z.literal('context_compact_boundary'),
  ...baseEventFields,
  boundaryId: z.string(),
  sourceBoundaryTimestamp: z.string(),
  trigger: z.enum(['manual', 'auto', 'reactive']),
  beforeEventCount: z.number(),
  afterEventCount: z.number(),
  preTokens: z.number().optional(),
  postTokens: z.number().optional(),
  estimatedTokensSaved: z.number().optional(),
  summaryChars: z.number(),
  snippedToolResults: z.number(),
  messagesSummarized: z.number(),
  droppedItemCount: z.number(),
  retainedEventCount: z.number(),
  retainedItemCount: z.number(),
  droppedReasons: z.record(z.string(), z.number()).optional(),
  preservedFirstEventId: z.string().optional(),
  preservedTailEventId: z.string().optional(),
  retainedSegmentHash: z.string().optional(),
  modelId: z.string().optional(),
  userVisibleSummary: z.string().optional(),
  message: z.string(),
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

export const ContextUsageEventSchema = z.object({
  type: z.literal('context_usage'),
  ...baseEventFields,
  requestId: z.string().optional(),
  modelId: z.string(),
  providerId: z.string(),
  tokenEstimate: z.number(),
  maxTokens: z.number(),
  percentUsed: z.number(),
  warningThresholdTokens: z.number(),
  compactThresholdTokens: z.number(),
  blockingLimitTokens: z.number(),
  ...contextPolicyFields,
  cachePreservationMode: z.boolean().optional(),
  longContextUtilizationMode: z.boolean().optional(),
  source: z.enum(['initial_refresh', 'pre_provider_call', 'after_compact', 'after_message_budget']),
  message: z.string(),
})

export const ContextMicrocompactEventSchema = z.object({
  type: z.literal('context_microcompact'),
  ...baseEventFields,
  requestId: z.string().optional(),
  trigger: z.enum(['initial_refresh', 'pre_provider_call', 'after_compact', 'after_message_budget']),
  compactedEventCount: z.number(),
  deduplicatedToolResultCount: z.number(),
  bytesBefore: z.number(),
  bytesAfter: z.number(),
  bytesSaved: z.number(),
  estimatedTokensSaved: z.number(),
  message: z.string(),
})

export const ContextRecoveryAttemptedEventSchema = z.object({
  type: z.literal('context_recovery_attempted'),
  ...baseEventFields,
  requestId: z.string().optional(),
  providerId: z.string().optional(),
  modelId: z.string().optional(),
  providerErrorCode: z.string(),
  strategy: z.enum(['microcompact_retry', 'semantic_compact_retry', 'reduce_tool_schema_retry', 'fallback_model_retry']),
  attempt: z.number().int().positive(),
  maxAttempts: z.number().int().positive(),
  preTokens: z.number(),
  postTokens: z.number().optional(),
  retryable: z.boolean(),
  message: z.string(),
})

export const ContextGroundingRequiredEventSchema = z.object({
  type: z.literal('context_grounding_required'),
  ...baseEventFields,
  requestId: z.string().optional(),
  boundaryId: z.string().optional(),
  source: z.enum(['post_compact', 'resume', 'context_recovery']),
  state: z.literal('summary-derived'),
  requiredFor: z.array(z.enum(['file_facts', 'test_results', 'git_status', 'task_completion', 'implementation_status'])),
  suggestedActions: z.array(z.enum(['re_read_referenced_files', 'inspect_changed_files', 'inspect_git_status', 'run_focused_tests', 'inspect_event_log'])),
  message: z.string(),
})

export const ContextGroundingConfirmedEventSchema = z.object({
  type: z.literal('context_grounding_confirmed'),
  ...baseEventFields,
  requestId: z.string().optional(),
  confirmedByToolUseId: z.string(),
  toolName: z.string(),
  confirmationKind: z.enum(['file_read', 'git_status', 'git_diff', 'test_output', 'event_log', 'search_result']),
  confirmedFor: z.array(z.enum(['file_facts', 'test_results', 'git_status', 'task_completion', 'implementation_status'])),
  source: z.enum(['tool_result', 'event_log']),
  message: z.string(),
})

export const WorkspaceDirtyDetectedEventSchema = z.object({
  type: z.literal('workspace_dirty_detected'),
  ...baseEventFields,
  requestId: z.string().optional(),
  source: z.enum(['post_compact', 'resume', 'pre_summary']),
  changedFileCount: z.number().int().nonnegative(),
  changedFiles: z.array(z.string()),
  truncated: z.boolean().optional(),
  suggestedActions: z.array(z.enum(['inspect_changed_files', 'inspect_git_status', 'inspect_diff'])),
  message: z.string(),
})

export const TaskScopeDeclaredEventSchema = z.object({
  type: z.literal('task_scope_declared'),
  ...baseEventFields,
  requestId: z.string().optional(),
  cwd: z.string(),
  primaryRoot: z.string(),
  explicitRoots: z.array(z.string()),
  confirmedExternalRoots: z.array(z.string()),
  inferredCandidateRoots: z.array(z.string()),
  mode: z.enum(['single_root', 'multi_root', 'cross_project']),
  source: z.enum(['cwd', 'prompt_paths', 'user_confirmation', 'session_metadata']),
  message: z.string(),
})

// Phase B of docs/nexus/reference/context-cwd-drift-and-recall-governance-plan.md.
// Pure decision projector: surfaces WHY a session's effective cwd is what
// it is. Always emitted together with task_scope_declared; CLI inspector
// renders it as a separate "session root continuity" block. Never used
// to drive runtime decisions directly — the runtime still calls
// `resolveCwdFromPrompt` and derives cwd from existing fields.
export const SessionRootContinuityEventSchema = z.object({
  type: z.literal('session_root_continuity'),
  ...baseEventFields,
  requestId: z.string().optional(),
  requestCwd: z.string(),
  storedSessionCwd: z.string().optional(),
  latestTaskPrimaryRoot: z.string().optional(),
  promptPathCandidates: z.array(z.string()),
  resolvedCwd: z.string(),
  decision: z.enum([
    'keep_request_cwd',
    'use_prompt_path',
    'keep_session_root',
    'require_confirmation',
  ]),
  reason: z.enum([
    'no_paths_in_prompt',
    'cjk_prose_excluded',
    'url_excluded',
    'all_candidates_non_existent',
    'prompt_internal_path_inferred',
    'prompt_external_path_inferred',
    'session_primary_root_inherited',
    'stored_session_cwd_inherited',
    'base_cwd_fallback',
  ]),
  isExternalRoot: z.boolean(),
  wasProjectRootKept: z.boolean(),
  warnings: z.array(z.string()),
  message: z.string(),
})

export const ScopeBoundaryDetectedEventSchema = z.object({
  type: z.literal('scope_boundary_detected'),
  ...baseEventFields,
  requestId: z.string().optional(),
  toolUseId: z.string(),
  toolName: z.string(),
  targetRoot: z.string(),
  taskPrimaryRoot: z.string(),
  boundaryKind: z.enum(['parent_scan', 'sibling_repo', 'external_absolute_path', 'historical_session_path', 'memory_hit_path', 'global_cache_path']),
  action: z.enum(['warn', 'require_confirmation', 'deny']),
  scopeRisk: z.enum(['outside_current_project', 'sibling_repo', 'parent_scan', 'historical_path', 'memory_hit_path', 'global_cache_path']),
  reason: z.string(),
  suggestedPrompt: z.string(),
})

export const ScopeBoundaryConfirmedEventSchema = z.object({
  type: z.literal('scope_boundary_confirmed'),
  ...baseEventFields,
  requestId: z.string().optional(),
  targetRoot: z.string(),
  confirmationScope: z.enum(['once', 'session', 'task']),
  confirmedBy: z.enum(['user', 'policy']),
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
  decisionReason: z.enum(['disabled', 'duplicate_turn', 'growth_threshold', 'forced', 'insufficient_signal']).optional(),
  estimatedTokensSinceLastUpdate: z.number().optional(),
  toolCallCount: z.number().optional(),
  summaryMaxChars: z.number().optional(),
  summaryMode: z.enum(['extractive']).optional(),
})

/**
 * §3.5 of `docs/nexus/reference/agent-runtime-architecture-maturity-plan.md`:
 * MemoryOS/EverCore long-term memory retrieval. Emitted by the hot path
 * (analyzeContext / contextAssembler / memory_search route) so the
 * `/v1/runtime/memory/status` quality dashboard and the
 * `agentTrace.ts` `memory_retrieval` span have a durable record of
 * every retrieval — including auto-search skips, which are the most
 * important signal that memory was *deliberately not consulted*.
 *
 * This event is independent of `session_memory_updated` (which is
 * session-memory-lite, single-session rolling summary). `memory_retrieval`
 * covers the long-term memory layer: the MemoryProvider boundary, the
 * auto-search decision, and the budget / truncation result.
 *
 * The `error` field is reserved for transport-level failures (network,
 * timeout, schema); successful empty retrievals use `hitCount: 0` and
 * leave `error` undefined.
 */
export const MemoryRetrievalEventSchema = z.object({
  type: z.literal('memory_retrieval'),
  ...baseEventFields,
  provider: z.string(),
  enabled: z.boolean(),
  scope: z.enum(['project', 'user', 'channel', 'unknown']),
  namespaceId: z.string().optional(),
  namespaceSource: z.enum(['explicit', 'workspace', 'default']).optional(),
  isolationKey: z.enum(['projectId', 'userId', 'channelId']).optional(),
  autoSearchTriggered: z.boolean(),
  autoSearchReason: z.enum([
    'aborted',
    'empty_prompt',
    'explicit_memory_cue',
    'current_workspace_only',
    'execution_status_only',
    'permission_response',
    'no_memory_cue',
  ]),
  autoSearchCue: z.string().optional(),
  hitCount: z.number(),
  injectedChars: z.number(),
  budgetChars: z.number(),
  maxHitChars: z.number(),
  truncated: z.boolean(),
  searchLatencyMs: z.number().optional(),
  error: z.string().optional(),
  prompt: z.string().optional(),
  cwd: z.string().optional(),
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

// Phase C of `docs/nexus/reference/cache-observability-and-nexus-realtime-detection-plan.md`.
// Emitted after `execution_metrics` when the resulting CacheHealthSnapshot
// has `summary.status !== 'ok'` (i.e., 'warning' or 'critical'). The dedup
// invariant (no duplicate cache_health for the same requestId) is enforced
// at the emit site, not the schema.
export const CacheHealthEventSchema = z.object({
  type: z.literal('cache_health'),
  ...baseEventFields,
  requestId: z.string().optional(),
  cacheHealth: z.unknown(), // CacheHealthSnapshot shape lives in nexus/cacheHealth.ts
  trigger: z.enum(['after_execution_metrics', 'manual']).default('after_execution_metrics'),
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
  ContextCompactBoundaryEventSchema,
  CompactFailureEventSchema,
  ContextWarningEventSchema,
  ContextBlockingEventSchema,
  ContextUsageEventSchema,
  ContextMicrocompactEventSchema,
  ContextRecoveryAttemptedEventSchema,
  ContextGroundingRequiredEventSchema,
  ContextGroundingConfirmedEventSchema,
  WorkspaceDirtyDetectedEventSchema,
  TaskScopeDeclaredEventSchema,
  SessionRootContinuityEventSchema,
  ScopeBoundaryDetectedEventSchema,
  ScopeBoundaryConfirmedEventSchema,
  SessionMemoryUpdatedEventSchema,
  MemoryRetrievalEventSchema,
  ExecutionMetricsEventSchema,
  CacheHealthEventSchema,
  ExecuteSummaryEventSchema,
  NearTimeoutWarningEventSchema,
  TimeoutBudgetExceededEventSchema,
  TimeoutExtensionGrantedEventSchema,
])

export type NexusEvent = z.infer<typeof NexusEventSchema>

export function eventBase(sessionId: string) {
  return {
    schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
    sessionId,
    timestamp: new Date().toISOString(),
  } as const
}
