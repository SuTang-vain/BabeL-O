# BabeL-O Context and Sub-agent Upgrade Plan

> Date: 2026-06-04
> Scope: BabeL-O Nexus runtime, context management, child/session agents, future model-visible agent tools.
> Status: Context Manager / ContextForker / read-only Explore-Review-Test AgentScheduler phases implemented; write-capable implement agents remain disabled.

## 1. Executive Summary

BabeL-O already has a strong context system. The current gap is not raw capability, but architecture normalization: the context pipeline needs clearer stages, standard context item abstractions, and first-class fork modes for child agents.

BabeL-O also already has real sub-agent capabilities through `runAgentLoop`, `TaskQueue`, child task sessions, transcript references, rerun support, and worktree isolation. The model-visible AgentScheduler path has now also landed for governed read-only/check-only jobs: `AgentSpawn`, `AgentWait`, `AgentList`, and `AgentCancel` can expose Explore/Review/Test profiles when explicitly enabled.

The recommended path has mostly been implemented:

1. Keep the existing context machinery and make it more explicit.
2. Context fork modes are implemented so parent sessions can create focused child-session context.
3. A dedicated `AgentScheduler` layer separate from `RemoteToolRunner` is implemented.
4. Read-only model-visible Explore Agent tools are implemented.
5. Persistent AgentJob storage, API/CLI management, ContextForker multi-mode diagnostics, and review/test profiles are implemented; write-capable implement agents remain disabled until worktree-isolated review/merge/reject safety exists.

The key architectural boundary is:

```text
Runtime = one model/tool loop
ToolExecutor = local or remote execution of one approved tool call
RemoteToolRunner = remote backend for approved tool calls only
AgentScheduler = child runtime/session/job orchestration
TaskQueue / runAgentLoop = planner/executor/critic optimize workflow
```

Do not merge `RemoteToolRunner` and `AgentScheduler`. Remote runners execute tools; they do not run provider loops, own sessions, or schedule child agents.

## 2. Current State

### 2.1 Context capabilities already present

BabeL-O currently has the following context features:

- Context assembly through `src/runtime/contextAssembler.ts`.
- System prompt sectioning through `src/runtime/systemPromptBuilder.ts`.
- Project memory loading and truncation.
- AGENTS.md / agent instruction loading.
- Git context injection.
- User intent guidance.
- Working set derivation from user messages and tool inputs.
- Compact boundary support.
- Retained segment verification.
- Post-compact state restoration.
- Session Memory Lite.
- Microcompaction and snipping for old or large tool results.
- Token estimation and context window state.
- Context blocking before provider calls.
- Reactive compact after tool output growth.
- `/context` diagnostics.
- Prefix cache diagnostics and cache-aware compact policy.
- Provider recovery signals and context-limit recovery metadata.

This is stronger than a simple history truncation design. The right next step is not a rewrite; it is turning the existing behavior into a more explicit Context Manager.

### 2.2 Sub-agent capabilities already present

BabeL-O currently has these agent orchestration capabilities:

- Planner / Executor / Critic / Optimizer roles.
- `bbl optimize` entrypoint.
- `runAgentLoop()` task orchestration.
- `TaskSession` and `TaskQueue`.
- Executor/optimizer `subTasks` delegation.
- Parent task blocking and resume after child completion.
- Child sub-agent sessions.
- Child transcript references.
- Failed/cancelled sub-agent rerun.
- Permission inheritance audit events.
- Worktree isolation and merge/recovery flows.
- TUI rendering for AgentLoop/sub-agent status.
- AgentLoop benchmark coverage.

This optimize/task path remains a real sub-agent implementation. In addition, the separate AgentScheduler path now provides explicitly enabled model-visible `AgentSpawn` / `AgentWait` / `AgentList` / `AgentCancel` tools for governed Explore/Review/Test jobs.

### 2.3 What remains insufficiently normalized

The current context system is powerful but still too implicit:

- Context Manager, ContextForker, `ContextItem` diagnostics, `AgentResult`, model-visible AgentScheduler tools, and AgentJob lifecycle have been implemented for the governed Explore/Review/Test path.
- The remaining boundary is not more generic agent spawning; it is write-capable child execution safety.
- Implement-capable child agents stay disabled until worktree-isolated execution, parent diff review, merge/reject/recovery, and independent write safety policy are implemented.
- Future agent tool additions should extend the existing AgentScheduler vocabulary, for example `AgentTranscript`, instead of adding parallel `define_subagent` / `invoke_subagent` names.

## 3. Goals

### 3.1 Context goals

- Preserve existing context features.
- Make context assembly explicit and testable as a staged pipeline.
- Introduce a common context item model.
- Add context fork modes for child agents.
- Keep cacheable prompt blocks stable and volatile content last.
- Improve diagnostics so the system can explain retained and dropped context.
- Allow runtime chat, optimize workflow, review agents, and explore agents to share the same context foundation.

### 3.2 Agent goals

- Keep current `runAgentLoop` behavior stable.
- Add an `AgentScheduler` layer for model-visible child jobs.
- Add read-only Explore Agent first.
- Add `AgentSpawn`, `AgentWait`, `AgentList`, `AgentCancel`, and later `AgentTranscript` tools.
- Add persistent `AgentJob` state and structured `AgentResult` output.
- Nexus HTTP API and CLI management commands are implemented for AgentScheduler jobs.
- Review/test profiles are implemented with restricted check-only Bash.
- Add implement agents only with worktree isolation and explicit merge/review flow.

## 4. Non-goals

- Do not rewrite the runtime.
- Do not replace the current context assembler in one large refactor.
- Do not make `RemoteToolRunner` run child agents.
- Do not start with write-capable parallel agents.
- Do not import BabeL-X/BabeL-2 complexity by default.
- Do not copy BabeL-2 leaked-source code or file structure.
- Do not make automatic model switching part of this plan.
- Do not add unconstrained user shell hooks as part of agent scheduling.

## 5. Proposed Target Architecture

```text
Nexus Server
  ├─ Runtime API
  │   └─ LLMCodingRuntime
  │       ├─ ContextManager / ContextAssembler
  │       ├─ ProviderRegistry
  │       ├─ RuntimeToolLoop
  │       └─ ToolExecutor
  │
  ├─ Tool Execution
  │   ├─ Built-in Tools
  │   ├─ MCP Tools
  │   └─ RemoteToolRunner
  │
  ├─ Agent Scheduler
  │   ├─ AgentJobRegistry
  │   ├─ AgentProfiles
  │   ├─ ContextForker
  │   ├─ ChildSessionManager
  │   ├─ AgentResultNormalizer
  │   └─ AgentConcurrencyLimiter
  │
  ├─ Task Orchestration
  │   ├─ runAgentLoop
  │   ├─ Planner / Executor / Critic / Optimizer
  │   └─ TaskQueue
  │
  └─ Storage / Event Log
      ├─ NexusEvent
      ├─ TaskSessionEvent
      ├─ AgentJobEvent
      ├─ ChildSessionTranscript
      └─ ContextDiagnostics
```

## 6. Context Manager Normalization

### 6.1 Pipeline stages

Current status: the first normalization slice is implemented in `src/runtime/contextManager.ts`. The runtime assembler path now exposes explicit phases for collection, item building, scoring, budget selection, compact/snipping, rendering, budget validation, and diagnostics while preserving the existing `assembleContext()` selection behavior. `ForkForChildAgent` is now backed by `src/nexus/agents/ContextForker.ts` for child-agent prompt construction and fork diagnostics.

```text
CollectContextSources
  -> BuildContextItems
  -> ScoreContextItems
  -> SelectWithinBudget
  -> CompactAndSnip
  -> ForkForChildAgent
  -> RenderPromptBlocks
  -> EstimateAndValidateBudget
  -> EmitDiagnostics
```

### 6.2 Suggested types

Current status: `ContextItem`, `ScoredContextItem`, `SelectedContextItem`, `ContextItemKind`, and selection diagnostic types are implemented. They are currently observational diagnostics around the existing assembler rather than a replacement selector.

```ts
export type ContextItemKind =
  | 'system'
  | 'memory'
  | 'agent_md'
  | 'git'
  | 'working_set'
  | 'event'
  | 'tool_result'
  | 'task_state'
  | 'child_agent_state'
  | 'compact_summary'
  | 'skill'
  | 'mcp'

export type ContextItem = {
  id: string
  kind: ContextItemKind
  text: string
  source: string
  cacheable: boolean
  volatile: boolean
  estimatedTokens: number
  metadata?: Record<string, unknown>
}

export type ScoredContextItem = ContextItem & {
  score: number
  scoreReasons: string[]
}

export type SelectedContextItem = ScoredContextItem & {
  retained: boolean
  droppedReason?: string
}
```

### 6.3 Collection phase

Collect these sources:

- Stable system rules.
- Environment and cwd.
- Memory files.
- AGENTS.md files.
- Git status.
- Skills.
- MCP/tool contract reminders.
- Session events.
- Compact boundary and summary.
- Retained segment metadata.
- Working set entries.
- Task/session state.
- Child-agent state.
- Hook/activity summaries.

### 6.4 Scoring phase

Score context by:

- Recent user mention.
- Tool touch count.
- Edit/write mutation.
- Failure relevance.
- Permission relevance.
- Task dependency relevance.
- Child-agent result relevance.
- Path relevance to current prompt.
- Recency.
- Cache stability.

### 6.5 Selection phase

Recommended retention order:

1. Stable system rules and tool contracts.
2. Current user prompt and explicit paths.
3. Safety, permission, and task-state constraints.
4. Working set and recently changed files.
5. Compact summary and open decisions.
6. Failed tool attempts and recovery hints.
7. Recent tool pairs with invariant protection.
8. Older success outputs only if directly relevant.

Large tool output should be snipped or persisted by reference before it is dropped entirely.

### 6.6 Rendering phase

Maintain strict prompt block ordering:

```text
cacheable stable prefix
  -> non-cacheable environment/project state
  -> volatile working set / git / task / summary state
  -> recent messages
```

The invariant is: stable content first, volatile content last.

### 6.7 Diagnostics phase

Current status: `/context` now shows retained/dropped selection item counts plus representative retained/dropped item kind, reason, and estimated tokens. The structured diagnostics include phases, estimated/max/percent, retained/dropped arrays, working set paths, and compact boundary.

Diagnostics should answer:

- Which items were retained?
- Which items were dropped?
- Why was each major item retained or dropped?
- How many tokens did each layer consume?
- What is the current context window state?
- What compact boundary is active?
- What working set paths are active?
- What child agent results are included?
- What child transcripts are only referenced?
- Is the immutable prefix stable?

Suggested shape:

```ts
export type ContextSelectionDiagnostics = {
  estimatedTokens: number
  maxTokens: number
  percentUsed: number
  retained: Array<{ id: string; kind: ContextItemKind; reason: string; estimatedTokens: number }>
  dropped: Array<{ id: string; kind: ContextItemKind; reason: string; estimatedTokens: number }>
  workingSetPaths: string[]
  compactBoundary?: string
  prefixCacheFingerprint?: string
  fork?: {
    mode: ContextForkMode
    inheritedItems: number
    omittedItems: number
  }
}
```

## 7. Context Fork Modes

Current status: implemented in `src/nexus/agents/ContextForker.ts`. All five fork modes produce focused child prompts, allowed path narrowing, inherited/omitted counts, and structured fork diagnostics. `ExploreAgentScheduler` stores fork diagnostics on child session metadata, and `/context` displays fork mode plus inherited/omitted item counts.

### 7.1 Type

```ts
export type ContextForkMode =
  | 'minimal'
  | 'working-set'
  | 'task-focused'
  | 'full-summary'
  | 'debug-replay'
```

### 7.2 `minimal`

For read-only exploration.

Include:

- Stable system/tool rules.
- cwd/environment.
- AGENTS.md/project instructions.
- Current child task prompt.
- Explicit paths from the prompt.

Exclude:

- Full parent history.
- Large tool results.
- Unrelated compact summary.
- Child transcripts.

Default for: `explore`.

### 7.3 `working-set`

For local implementation or focused debugging.

Include:

- Everything in `minimal`.
- Top working-set paths.
- Recently read/edited files by reference or snippet.
- Relevant compact summary sections.
- Failed attempts related to the working set.

Default for: small `implement` tasks.

### 7.4 `task-focused`

For review/test agents.

Include:

- Task description.
- Acceptance criteria.
- Changed files or diff references.
- Test targets.
- Relevant prior failures.
- Parent constraints.

Default for: `review`, `test`.

### 7.5 `full-summary`

For continuation and rerun cases.

Include:

- Compact summary.
- Open decisions.
- Task state.
- Working set.
- Relevant child agent results.
- Prior failure reason.

Default for: failed sub-agent rerun, optimizer continuation.

### 7.6 `debug-replay`

For reproducing failures.

Include:

- Selected raw events.
- Failed tool inputs and outputs.
- Provider errors.
- Permission decisions.
- Cancellation/timeout details.

Use only with strict token caps.

## 8. Agent Scheduler Design

### 8.1 New modules

Suggested directory:

```text
src/nexus/agents/
  types.ts
  AgentProfiles.ts
  AgentResult.ts
  AgentJobRegistry.ts
  ContextForker.ts
  AgentScheduler.ts
  AgentEvents.ts
  AgentConcurrencyLimiter.ts
```

### 8.2 Agent job model

```ts
export type AgentJobStatus =
  | 'queued'
  | 'running'
  | 'waiting_permission'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type AgentIsolationMode = 'none' | 'worktree'

export type AgentJob = {
  jobId: string
  parentSessionId: string
  childSessionId: string
  parentTaskId?: string
  agentType: AgentProfileId
  status: AgentJobStatus
  prompt: string
  contextForkMode: ContextForkMode
  isolation: AgentIsolationMode
  createdAt: string
  updatedAt: string
  startedAt?: string
  completedAt?: string
  result?: AgentResult
  error?: {
    code: string
    message: string
    details?: unknown
  }
  transcriptPath?: string
  metadata?: Record<string, unknown>
}
```

### 8.3 Agent result model

```ts
export type AgentResult = {
  summary: string
  findings?: AgentFinding[]
  changedFiles?: string[]
  testsRun?: string[]
  commandsRun?: string[]
  nextSteps?: string[]
  confidence?: 'low' | 'medium' | 'high'
}

export type AgentFinding = {
  severity: 'info' | 'warning' | 'error'
  message: string
  file?: string
  line?: number
  evidence?: string
}
```

### 8.4 Scheduler interface

```ts
export interface AgentScheduler {
  spawnAgent(request: AgentSpawnRequest): Promise<AgentJob>
  waitForAgent(jobId: string, options?: AgentWaitOptions): Promise<AgentJob>
  listAgents(filter?: AgentJobFilter): Promise<AgentJob[]>
  cancelAgent(jobId: string, reason?: string): Promise<AgentJob>
}
```

### 8.5 Spawn request

```ts
export type AgentSpawnRequest = {
  parentSessionId: string
  prompt: string
  agentType?: AgentProfileId
  contextForkMode?: ContextForkMode
  isolation?: AgentIsolationMode
  allowedTools?: string[]
  maxRuntimeMs?: number
  maxOutputTokens?: number
  metadata?: Record<string, unknown>
}
```

## 9. Agent Profiles

### 9.1 Type

```ts
export type AgentProfileId =
  | 'explore'
  | 'review'
  | 'test'
  | 'implement'
  | 'debug'
  | 'general'

export type AgentProfile = {
  id: AgentProfileId
  displayName: string
  defaultTools: string[]
  defaultContextForkMode: ContextForkMode
  defaultIsolation: AgentIsolationMode
  canEdit: boolean
  canRunBash: boolean
  requiresApproval: boolean
  maxRuntimeMs: number
  maxOutputTokens: number
}
```

### 9.2 Explore Agent

Current status: implemented as the first model-visible read-only profile.

```ts
{
  id: 'explore',
  displayName: 'Explore Agent',
  defaultTools: ['ListDir', 'Glob', 'Grep', 'Read'],
  defaultContextForkMode: 'minimal',
  defaultIsolation: 'none',
  canEdit: false,
  canRunBash: false,
  requiresApproval: false,
  maxRuntimeMs: 120_000,
  maxOutputTokens: 2_048,
}
```

Use for:

- Finding files.
- Locating definitions.
- Summarizing local architecture.
- Answering “where is X?” questions.

### 9.3 Review Agent

Current status: implemented with `task-focused` context and restricted check-only Bash.

```ts
{
  id: 'review',
  displayName: 'Review Agent',
  defaultTools: ['ListDir', 'Glob', 'Grep', 'Read', 'Bash'],
  defaultContextForkMode: 'task-focused',
  defaultIsolation: 'none',
  canEdit: false,
  canRunBash: true,
  requiresApproval: false,
  maxRuntimeMs: 180_000,
  maxOutputTokens: 3_000,
}
```

Bash is restricted by the child runtime wrapper to `npm run typecheck`, `npm run format:check`, `npm run deps:audit`, and focused `npx tsx --test ...` commands; Edit/Write remain unavailable.

### 9.4 Test Agent

Current status: implemented with `task-focused` context and the same restricted check-only Bash boundary as Review Agent.

```ts
{
  id: 'test',
  displayName: 'Test Agent',
  defaultTools: ['ListDir', 'Glob', 'Grep', 'Read', 'Bash'],
  defaultContextForkMode: 'task-focused',
  defaultIsolation: 'none',
  canEdit: false,
  canRunBash: true,
  requiresApproval: false,
  maxRuntimeMs: 300_000,
  maxOutputTokens: 3_000,
}
```

Use for targeted test/typecheck/lint runs. `AgentResult` records both `commandsRun` and `testsRun` for parent-session summaries.

### 9.5 Implement Agent

Current status: evaluated; disabled until the write-safety boundary exists.

`implement` remains a schema-level future profile, not an enabled AgentScheduler profile. Do not add `Edit` / `Write` to ordinary child agents or enable `implement` by only extending the current ExploreAgentScheduler allowlist.

Future minimum contract:

```ts
{
  id: 'implement',
  displayName: 'Implement Agent',
  defaultTools: ['ListDir', 'Glob', 'Grep', 'Read', 'Edit', 'Write'],
  defaultContextForkMode: 'working-set',
  defaultIsolation: 'worktree',
  canEdit: true,
  canRunBash: false,
  requiresApproval: true,
  maxRuntimeMs: 600_000,
  maxOutputTokens: 4_096,
}
```

Required before enabling:

- Nexus creates the worktree before child execution.
- Child `cwd` and `allowedPaths` are narrowed to the worktree.
- `isolation: none` is rejected for implement jobs.
- Changed files and diff summary are recorded in `AgentResult` / job metadata.
- Parent has explicit review, merge, reject and recovery actions.
- Merge conflicts preserve the worktree and expose recovery metadata.
- Bash is disabled initially or replaced with an implement-specific restricted policy.
- Remote runner Write/Edit is only an execution backend; it does not own permissions, scheduling, sessions, review, merge or recovery.

## 10. Model-visible Agent Tools

### 10.1 Tool set

Initial tools:

```text
AgentSpawn
AgentWait
AgentList
AgentCancel
```

Later:

```text
AgentTranscript
AgentRerun
```

### 10.2 `AgentSpawn`

Input:

```ts
const AgentSpawnInputSchema = z.object({
  prompt: z.string().min(1),
  agentType: z.enum(['explore', 'review', 'test', 'implement', 'debug', 'general']).default('explore'),
  contextForkMode: z.enum(['minimal', 'working-set', 'task-focused', 'full-summary', 'debug-replay']).optional(),
  isolation: z.enum(['none', 'worktree']).optional(),
  wait: z.boolean().default(false),
  timeoutMs: z.number().int().positive().optional(),
})
```

Output:

```ts
export type AgentSpawnOutput = {
  jobId: string
  childSessionId: string
  status: AgentJobStatus
  agentType: AgentProfileId
  message: string
}
```

### 10.3 `AgentWait`

```ts
const AgentWaitInputSchema = z.object({
  jobId: z.string(),
  timeoutMs: z.number().int().positive().optional(),
})
```

Output includes final `AgentResult` or structured error.

### 10.4 `AgentList`

```ts
const AgentListInputSchema = z.object({
  status: z.enum(['queued', 'running', 'waiting_permission', 'completed', 'failed', 'cancelled']).optional(),
  parentSessionId: z.string().optional(),
})
```

### 10.5 `AgentCancel`

```ts
const AgentCancelInputSchema = z.object({
  jobId: z.string(),
  reason: z.string().optional(),
})
```

## 11. Nexus API Plan

Current status: implemented for `explore`, `review`, and `test` AgentScheduler jobs. Transcript retrieval stays outside `AgentScheduler` and is served by reading the child session event log on demand.

Implemented:

```text
POST /v1/agents
GET  /v1/agents
GET  /v1/agents/:jobId
POST /v1/agents/:jobId/wait
POST /v1/agents/:jobId/cancel
GET  /v1/agents/:jobId/transcript
GET  /v1/sessions/:sessionId/agents
```

Example request:

```json
{
  "parentSessionId": "session-123",
  "prompt": "Find the files involved in compact post-restore.",
  "agentType": "explore",
  "contextForkMode": "minimal",
  "isolation": "none",
  "wait": false
}
```

Example response:

```json
{
  "type": "agent_job_spawned",
  "job": {
    "jobId": "agent-job-abc",
    "childSessionId": "session-123-agent-abc",
    "status": "queued",
    "agentType": "explore"
  }
}
```

## 12. CLI Plan

Current status: implemented for Nexus-backed AgentScheduler management.

Implemented:

```text
bbl agents spawn
bbl agents list
bbl agents show
bbl agents wait
bbl agents cancel
bbl agents transcript
bbl agents session
```

Examples:

```bash
bbl agents spawn --parent-session-id session-123 --agent-type explore "Find all files related to prefix cache diagnostics"
bbl agents wait agent-job-abc
bbl agents list --status running
bbl agents show agent-job-abc
bbl agents cancel agent-job-abc --reason "No longer needed"
bbl agents transcript agent-job-abc
bbl agents session session-123
```

## 13. Event Model

Add job-level events rather than overloading existing task sub-agent events:

```ts
export type AgentJobQueuedEvent = {
  type: 'agent_job_queued'
  sessionId: string
  jobId: string
  childSessionId: string
  agentType: AgentProfileId
  contextForkMode: ContextForkMode
}

export type AgentJobStartedEvent = {
  type: 'agent_job_started'
  sessionId: string
  jobId: string
  childSessionId: string
}

export type AgentJobCompletedEvent = {
  type: 'agent_job_completed'
  sessionId: string
  jobId: string
  childSessionId: string
  result: AgentResult
}

export type AgentJobFailedEvent = {
  type: 'agent_job_failed'
  sessionId: string
  jobId: string
  childSessionId: string
  error: {
    code: string
    message: string
    details?: unknown
  }
}

export type AgentJobCancelledEvent = {
  type: 'agent_job_cancelled'
  sessionId: string
  jobId: string
  childSessionId: string
  reason?: string
}
```

Existing `sub_agent_session_*` and `subagent_*` events should remain for `runAgentLoop` task orchestration. `agent_job_*` events are for model-visible runtime-spawned child jobs.

## 14. Storage Plan

### 14.1 First stage

Use an in-memory `AgentJobRegistry`, while also appending job lifecycle events to session storage.

### 14.2 Persistent stage

Add storage support for:

```text
job_id
parent_session_id
child_session_id
agent_type
status
prompt
context_fork_mode
isolation
created_at
updated_at
started_at
completed_at
result_json
error_json
transcript_path
metadata_json
```

### 14.3 Transcript policy

Do not inject full child transcripts into parent context by default.

Use:

```text
child raw events -> child session storage
child structured summary -> parent agent_job_completed event
child transcript reference -> parent context as reference only
```

Read full transcript only when explicitly requested or when using `debug-replay` fork mode.

## 15. Concurrency and Safety

### 15.1 Config

Add:

```text
NEXUS_MAX_CONCURRENT_AGENTS=3
NEXUS_MAX_AGENT_DEPTH=2
NEXUS_AGENT_TIMEOUT_MS=300000
NEXUS_AGENT_MAX_TRANSCRIPT_BYTES=1000000
```

### 15.2 Default limits

- Max concurrent agents: 3.
- Max depth: 2.
- Default agent timeout: 5 minutes.
- Explore agents: read-only.
- Implement agents: disabled or explicit opt-in until worktree merge flow is ready.

### 15.3 Permission inheritance

Child agents must inherit safety boundaries, not broad approvals.

Required:

- allowed paths are inherited or narrowed.
- tool policies are profile-based.
- permission audit is recorded.
- hooks still run through runtime/tool loop paths.
- child agents do not bypass path safety.
- child agents do not directly call remote runners.

### 15.4 Write safety

Write-capable child agents require:

- worktree isolation by default.
- explicit merge/apply review.
- changed files summary.
- conflict recovery path.
- no `git add .` or destructive git shortcuts.

## 16. Phased Roadmap

### Phase 0: Boundary and type groundwork

Current status:

- `ContextForkMode` type is implemented in `src/nexus/agents/types.ts`.
- `AgentProfileId` / `AgentProfile` types are implemented in `src/nexus/agents/types.ts`.
- `AgentJob` type is implemented in `src/nexus/agents/types.ts`.
- `AgentResult` type is implemented in `src/nexus/agents/types.ts` and re-exported from `src/nexus/agents/AgentResult.ts`.
- Built-in read-only `explore` profile is implemented in `src/nexus/agents/AgentProfiles.ts`.
- In-memory `AgentJobRegistry` is implemented in `src/nexus/agents/AgentJobRegistry.ts`.

Do not alter existing `runAgentLoop` behavior.

Acceptance:

- Typecheck passes.
- Unit tests cover profile defaults and job state transitions.
- No existing AgentLoop tests regress.

### Phase 1: Read-only Explore Agent MVP

Current status:

- `AgentScheduler.spawnAgent()` for `explore` is implemented by `ExploreAgentScheduler`.
- `AgentWait` support is implemented through scheduler waiters and `AgentWait` tool.
- `AgentSpawn`, `AgentWait`, `AgentList`, `AgentCancel` tools are implemented in `src/nexus/agents/AgentTools.ts` and require explicit runtime opt-in.
- Child runtime is constrained to `Read`, `Grep`, `Glob` only.
- `minimal` context fork is implemented and preserved as the Explore Agent default in `src/nexus/agents/ContextForker.ts`.
- Structured `AgentResult` summary is normalized from child runtime events.

Acceptance:

- Parent runtime can spawn an explore child when Agent tools are explicitly enabled.
- Explore child can locate files and return findings.
- Parent can wait for the job.
- Explore child cannot edit or run Bash.
- Cancel maps to `cancelled` status.

### Phase 2: Context Forker

Current status: implemented.

Delivered:

- `ContextForker` module.
- `minimal`, `working-set`, `task-focused`, `full-summary`, and `debug-replay` modes.
- Fork diagnostics with included/omitted categories, working set paths, and parent event references.
- Working-set relevance for child prompts.
- AgentScheduler child session metadata plus HTTP/CLI `/context` fork diagnostics display.

Acceptance:

- Each fork mode has focused regression tests.
- Child context does not include full parent history by default.
- Diagnostics show inherited and omitted context.

### Phase 3: API and CLI

Current status:

- `/v1/agents` API family is implemented in `src/nexus/app.ts`.
- `bbl agents` command family is implemented in `src/cli/commands/agents.ts`.
- Transcript query is implemented as on-demand child session event paging.
- Job listing by session/status/profile is implemented through `AgentScheduler.listAgents()` filters.

Acceptance:

- CLI can spawn/list/show/wait/cancel jobs.
- Server can show parent-session agent jobs.
- Transcript remains reference-only unless requested.

### Phase 4: Review and Test agents

Current status: implemented.

Delivered:

- `review` profile.
- `test` profile.
- Restricted Bash policy for check-only validation commands.
- Reuse of the implemented `task-focused` context fork.
- Structured findings/testsRun/commandsRun in `AgentResult`.

Acceptance:

- Review agent can inspect changed files/diff.
- Test agent can run targeted test commands.
- Neither can edit files.
- Results are summarized for parent context.

### Phase 5: Implement agent with worktree isolation

Current status: evaluated; not enabled.

Decision:

- Do not enable the `implement` profile yet.
- Do not expose `Edit` / `Write` to model-visible child agents through the existing ExploreAgentScheduler path.
- Treat `runAgentLoop()` optimizer/worktree flow as the current source of truth for write-capable orchestration.
- Future implement support must be a worktree-owned scheduler flow with explicit parent review, merge, reject and recovery semantics.

Required before implementation:

- `implement` profile defaults to `worktree` isolation and rejects `isolation: none`.
- Scheduler creates the worktree and narrows child `cwd` / `allowedPaths` to it before runtime execution.
- Child jobs produce changed files and diff summary without mutating the parent workspace directly.
- Parent review action is required before merge/apply.
- Reject removes or preserves the worktree according to an explicit action.
- Merge uses existing worktree merge primitives and preserves conflict recovery metadata.
- Multiple implement jobs cannot write to the same in-place workspace.
- Tests cover profile gating, worktree-only path safety, remote Write/Edit gating, review/merge/reject/recovery and conflict preservation.

### Phase 6: Integrate with existing AgentLoop

Current status: evaluated; no execution bridge now.

Decision:

- Do not migrate `runAgentLoop()` subtask delegation into `AgentScheduler`.
- Preserve existing Planner/Executor/Critic/Optimizer behavior and direct recursive `runAgentLoop()` child sessions.
- Keep optimize/task orchestration, parent task blocked/resume, retry/critic, worktree merge/recovery, permission inheritance and SubagentStart/SubagentStop hooks owned by `runAgentLoop()`.
- Keep model-visible Explore/Review/Test jobs, ContextForker, AgentJob governance/storage and `agent_job_event` lifecycle owned by AgentScheduler.
- Reuse existing context/summary/metrics recognition of both `task_session_event` sub-agent events and `agent_job_event` jobs.
- If dashboard or TUI multi-agent UX needs a unified view later, evaluate a read-only observability/status bridge that mirrors runAgentLoop sub-agent references without changing execution semantics.

Acceptance:

- No rewrite or migration of `runAgentLoop()` main flow.
- Existing `test/agent-loop.test.ts` behavior remains the source of truth for optimize sub-agents.
- Failed sub-agent rerun, transcripts and worktree isolation continue to use the existing TaskSession path.
- AgentScheduler remains the source of truth for model-visible Agent tools and persistent AgentJob jobs.

## 17. Test Plan

### 17.1 Unit tests

Add:

```text
test/agent-profiles.test.ts
test/agent-job-registry.test.ts
test/context-forker.test.ts
test/agent-scheduler.test.ts
test/agent-tools.test.ts
test/agent-api.test.ts
test/agents-command.test.ts
```

Cover:

- profile defaults.
- allowed tools.
- job lifecycle transitions.
- cancel and timeout.
- context fork item selection.
- result normalization.

### 17.2 Integration tests

Add:

```text
test/agent-scheduler-runtime.test.ts
test/agent-tools-runtime.test.ts
test/agent-worktree.test.ts
```

Cover:

- parent runtime uses AgentSpawn.
- child runtime emits session events.
- parent waits and receives result.
- cancel aborts child runtime.
- transcript query works.
- worktree isolation for implement agents.

### 17.3 Regression tests to keep running

```bash
npm run typecheck
npm test
npm run lint
npm run build:smoke
```

Tests must keep using isolated BabeL-O config. Do not allow tests to write the real `~/.babel-o/config.json`.

## 18. Documentation Plan

This document is now the unified planning document for context normalization and model-visible sub-agent scheduling.

Older documents replaced by this plan:

- `CONTEXT_GAP_ANALYSIS.md` — historical BabeL-O vs BabeL-X gap analysis; obsolete because the listed gaps have mostly landed.
- `CONTEXT_UPGRADE_ROADMAP.md` — historical context-only implementation path; obsolete as a primary roadmap, with completed facts preserved in TODO/DONE/WORK_LOG.
- `CONCURRENT_SUBAGENTS_ROADMAP.md` — older concurrent-subagent sketch; obsolete because concurrency now belongs under the AgentScheduler plan.

The remaining planning entrypoints are:

- `TODO.md` for top-level current priorities.
- `TODO_runtime.md` for runtime/context/security/storage tasks.
- `TODO_agents.md` for AgentLoop/task/session/worktree tasks.
- This file for the cross-cutting context + model-visible agent upgrade.

## 19. Risk Register

### 19.1 Token cost explosion

Mitigation:

- cap concurrent agents.
- cap runtime per job.
- cap output tokens.
- do not inject child transcripts into parent context by default.

### 19.2 File conflicts

Mitigation:

- start read-only.
- require worktree for implement agents.
- require merge/review flow.

### 19.3 Permission bypass

Mitigation:

- child agents use normal runtime/tool loop.
- no direct scheduler-level tool execution.
- inherit/narrow allowed paths.
- profile-level tool policies.
- audit all permission decisions.

### 19.4 Context pollution

Mitigation:

- structured `AgentResult` only by default.
- transcript references instead of full transcript injection.
- explicit `debug-replay` mode for raw replay.

### 19.5 Regressing stable AgentLoop behavior

Mitigation:

- keep AgentScheduler independent in early phases.
- do not migrate `runAgentLoop` until Phase 6.
- preserve existing tests.

### 19.6 Leaked-source contamination

Mitigation:

- do not copy BabeL-2 code.
- treat BabeL-2 only as UX/concept reference.
- implement from BabeL-O architecture and tests.

## 20. Recommended First PRs

### PR 1: Agent core types

Files:

```text
src/nexus/agents/types.ts
src/nexus/agents/AgentProfiles.ts
src/nexus/agents/AgentResult.ts
test/agent-profiles.test.ts
```

### PR 2: In-memory job registry

Files:

```text
src/nexus/agents/AgentJobRegistry.ts
test/agent-job-registry.test.ts
```

### PR 3: Minimal ContextForker

Files:

```text
src/nexus/agents/ContextForker.ts
test/context-forker.test.ts
```

### PR 4: AgentScheduler MVP

Files:

```text
src/nexus/agents/AgentScheduler.ts
test/agent-scheduler.test.ts
```

### PR 5: Read-only Agent tools

Files:

```text
src/tools/builtin/agent.ts
test/agent-tools.test.ts
```

Initial tool exposure should be limited to `explore`.

## 21. Final Recommendation

BabeL-O context capability is already a strength. The next context work should be normalization: explicit pipeline stages, shared context item abstractions, and child-agent fork modes.

BabeL-O sub-agent capability is also real, but currently centered on optimize/task orchestration. The next agent work should add model-visible agent jobs without destabilizing `runAgentLoop`.

The best first implementation target is:

```text
read-only Explore Agent
+ AgentSpawn / AgentWait
+ minimal ContextForker
+ in-memory AgentJobRegistry
```

This gives BabeL-O the missing multi-agent runtime surface while keeping cost, permission, and file mutation risk low.
