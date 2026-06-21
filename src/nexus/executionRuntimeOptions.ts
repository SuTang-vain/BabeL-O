import type { RuntimeExecuteOptions } from '../runtime/Runtime.js'
import type { RemoteToolRunner } from '../runtime/remoteRunner.js'
import type { NexusStorage } from '../storage/Storage.js'
import type { ExecuteBody, PreparedExecution } from './executionPreparation.js'

export type BuildRuntimeExecuteOptionsParams = {
  body: ExecuteBody
  prepared: PreparedExecution
  maxToolOutputBytes: number
  bashMaxBufferBytes: number
  storage: NexusStorage
  remoteRunner?: RemoteToolRunner
}

export function buildRuntimeExecuteOptions(params: BuildRuntimeExecuteOptionsParams): RuntimeExecuteOptions {
  const { body, prepared } = params
  return {
    sessionId: prepared.sessionId,
    prompt: body.prompt,
    cwd: prepared.cwd,
    signal: prepared.abortController.signal,
    timeoutSignal: prepared.timeoutController.signal,
    maxToolOutputBytes: body.maxToolOutputBytes ?? params.maxToolOutputBytes,
    bashMaxBufferBytes: params.bashMaxBufferBytes,
    skipPermissionCheck: body.skipPermissionCheck,
    requestId: prepared.requestId,
    model: body.model,
    budget: body.budget,
    executionEnvironment: body.executionEnvironment,
    remoteRunner: params.remoteRunner,
    allowedPaths: prepared.allowedPaths,
    policyMode: prepared.policyMode,
    // Phase C2 (cwd-drift plan §11): propagate Nexus storage so context tools
    // receive a non-null ToolContext.storage on both HTTP and WebSocket paths.
    storage: params.storage,
    // Bug 2 (§13.4): Phase B continuity inputs — immutable originCwd
    // (storedSessionCwd) + most recent task_scope_declared primaryRoot.
    ...(prepared.storedSessionCwd !== undefined && { storedSessionCwd: prepared.storedSessionCwd }),
    ...(prepared.latestTaskPrimaryRoot !== undefined && { latestTaskPrimaryRoot: prepared.latestTaskPrimaryRoot }),
    ...(prepared.allowedTools && { allowedTools: prepared.allowedTools }),
  }
}
