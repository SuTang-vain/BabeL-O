import type { NexusEvent } from '../shared/events.js'
import type { HooksConfig } from '../shared/config.js'
import type { NexusStorage } from '../storage/Storage.js'
import type { ToolRisk } from '../tools/Tool.js'
import type { RuntimeHook } from './hooks.js'
import type { RemoteToolRunner } from './remoteRunner.js'

export type RuntimeExecuteOptions = {
  sessionId: string
  prompt: string
  cwd: string
  role?: string
  signal?: AbortSignal
  timeoutSignal?: AbortSignal
  maxToolOutputBytes?: number
  bashMaxBufferBytes?: number
  skipPermissionCheck?: boolean
  requestId?: string
  model?: string
  budget?: number
  maxOutputTokens?: number
  replaySessionHistory?: boolean
  executionEnvironment?: 'local' | 'docker' | 'remote'
  remoteRunner?: RemoteToolRunner
  storage?: NexusStorage
  allowedPaths?: string[]
  hooks?: HooksConfig
  runtimeHooks?: RuntimeHook[]
  /**
   * Per-request policy mode (Phase B of
   * docs/nexus/reference/go-tui-permission-policy-governance-plan.md).
   *   - 'strict' (default): tools not in the allowlist are policy-blocked
   *     before `permission_request` fires.
   *   - 'soft-deny': the policy block is bypassed; the existing approval
   *     gate then emits `permission_request` for write/execute-risk
   *     tools so the user can approve via the Go TUI permission panel.
   */
  policyMode?: 'strict' | 'soft-deny'
  /**
   * Per-request tool allowlist (Phase D of
   * docs/nexus/reference/go-tui-permission-policy-governance-plan.md).
   * When set, the runtime temporarily applies an allowlist-based
   * policy for this turn only; the next turn re-evaluates from the
   * (possibly different) body. Empty / omitted → no per-turn override;
   * the server-startup `denyByDefaultTools()` (or whichever policy
   * the runtime was constructed with) applies. `*` / `all` →
   * allowAllTools. `policyMode: 'soft-deny'` continues to work
   * orthogonally: allowedTools controls *which* tools are isAllowed,
   * while policyMode controls *whether* the policy block fires
   * for tools outside the allowlist.
   */
  allowedTools?: readonly string[]
  /**
   * Internal runtime carry-over for user-approved `scope=session`
   * permission rules. Unlike `allowedTools`, these rules represent
   * an explicit user approval from an earlier turn in the same
   * session, so a matching write/execute tool call may skip the
   * permission prompt for that session only.
   */
  sessionApprovedRules?: readonly string[]
  contextFork?: {
    mode: string
    inheritedItems: number
    omittedItems: number
  }
  /**
   * Phase B of docs/nexus/reference/context-cwd-drift-and-recall-governance-plan.md.
   * When the caller has a previously-stored session cwd or a
   * task_scope_declared.primaryRoot, pass them so
   * `resolveCwdWithContinuity` can prefer them over a freshly-resolved
   * cwd from the prompt. Both are optional; if omitted the runtime
   * falls back to the 2-arg `resolveCwdFromPrompt` heuristic.
   */
  storedSessionCwd?: string
  latestTaskPrimaryRoot?: string
  /**
   * When true, an external prompt path (i.e. a real path that lives
   * outside `cwd`) is allowed to switch cwd. Default false: the
   * runtime keeps cwd and surfaces a `session_root_continuity` event
   * with `decision: require_confirmation` so the user / scope flow
   * can decide. Set true only for opt-in flows (e.g. `bbl go` with
   * `--external-ok`).
   */
  acceptExternalPromptPath?: boolean
}

export interface NexusRuntime {
  executeStream(options: RuntimeExecuteOptions): AsyncIterable<NexusEvent>
  listTools?(): RuntimeToolAuditEntry[]
}

export type RuntimeToolAuditEntry = {
  name: string
  description: string
  risk: ToolRisk
  allowed: boolean
  inputSchema?: unknown
  requiresApproval?: boolean
  suggestedAllowRule?: string
  mcpServerAllowed?: boolean
  source?: {
    type: 'builtin' | 'mcp'
    serverName?: string
    originalName?: string
  }
}
