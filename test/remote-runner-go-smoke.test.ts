import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { ExploreAgentScheduler } from '../src/nexus/agents/AgentScheduler.js'
import { createAgentToolRegistry } from '../src/nexus/agents/AgentTools.js'
import { allowlistedTools } from '../src/runtime/LocalCodingRuntime.js'
import type { NexusRuntime, RuntimeExecuteOptions } from '../src/runtime/Runtime.js'
import {
  HttpRemoteToolRunner,
  REMOTE_RUNNER_PROTOCOL_VERSION,
  type RemoteToolRunner,
  type RemoteToolRunnerCancelRequest,
  type RemoteToolRunnerExecuteRequest,
} from '../src/runtime/remoteRunner.js'
import { buildRuntimeResultEvent, createRuntimeExecutionMetrics, type RuntimeProviderToolCall } from '../src/runtime/runtimePipeline.js'
import { executeProviderToolCall } from '../src/runtime/runtimeToolLoop.js'
import type { NexusEvent } from '../src/shared/events.js'
import { MemoryStorage } from '../src/storage/MemoryStorage.js'
import type { NexusStorage } from '../src/storage/Storage.js'
import { createDefaultToolRegistry } from '../src/tools/registry.js'

const runGoSmoke = process.env.BABEL_O_RUN_GO_RUNNER_SMOKE === '1'
const goRunnerDir = resolve(process.cwd(), 'runners/go-runner')

test('optional Go Remote Runner Phase D smoke', { skip: runGoSmoke ? false : 'Set BABEL_O_RUN_GO_RUNNER_SMOKE=1 to run Go runner smoke.' }, async () => {
  const port = String(42000 + Math.floor(Math.random() * 1000))
  const baseUrl = `http://127.0.0.1:${port}`
  let workspace = ''
  const child = spawn('go', ['run', './cmd/go-runner'], {
    cwd: goRunnerDir,
    env: {
      ...process.env,
      GO_RUNNER_HOST: '127.0.0.1',
      GO_RUNNER_PORT: port,
      GO_RUNNER_ID: 'go-remote-runner-smoke',
      GO_RUNNER_ENABLE_BASH: '1',
      GO_RUNNER_ENABLE_WRITE: '1',
    },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  try {
    await waitForCapabilities(baseUrl, child)

    const capabilities = await fetchJson(`${baseUrl}/v1/remote-runner/capabilities`)
    assert.equal(capabilities.protocolVersion, REMOTE_RUNNER_PROTOCOL_VERSION)
    assert.equal(capabilities.id, 'go-remote-runner-smoke')
    assert.deepEqual(capabilities.capabilities.tools, ['Read', 'Grep', 'Glob', 'Bash', 'Write', 'Edit'])
    assert.equal(capabilities.capabilities.bashEnabled, true)
    assert.equal(capabilities.capabilities.writeEnabled, true)

    workspace = await mkdtemp(join(tmpdir(), 'babel-o-go-runner-smoke-'))
    await mkdir(join(workspace, 'src'), { recursive: true })
    await writeFile(join(workspace, 'README.md'), 'hello\nneedle one\n')
    await writeFile(join(workspace, 'src', 'main.go'), 'package main\n// needle two\n')

    const runner = new HttpRemoteToolRunner({ baseUrl, capabilities: { tools: ['Read', 'Grep', 'Glob', 'Bash', 'Write', 'Edit'] } })
    const read = await runner.executeTool({
      protocolVersion: REMOTE_RUNNER_PROTOCOL_VERSION,
      sessionId: 'session-go-smoke',
      requestId: 'request-read',
      toolUseId: 'tool-read',
      toolName: 'Read',
      toolInput: { path: 'README.md', offset: 0, limit: 5 },
      cwd: workspace,
      allowedPaths: [workspace],
      maxOutputBytes: 1000,
      bashMaxBufferBytes: 1000,
    })
    assert.equal(read.kind, 'result')
    assert.equal(read.kind === 'result' ? read.success : false, true)
    assert.match((read as any).output, /^hello/)

    const grep = await runner.executeTool({
      protocolVersion: REMOTE_RUNNER_PROTOCOL_VERSION,
      sessionId: 'session-go-smoke',
      requestId: 'request-grep',
      toolUseId: 'tool-grep',
      toolName: 'Grep',
      toolInput: { pattern: 'needle', path: '.', maxMatches: 10 },
      cwd: workspace,
      allowedPaths: [workspace],
      maxOutputBytes: 1000,
      bashMaxBufferBytes: 1000,
    })
    assert.equal(grep.kind, 'result')
    assert.equal(grep.kind === 'result' ? grep.success : false, true)
    assert.match((grep as any).output, /README\.md:2:needle one/)
    assert.match((grep as any).output, /src\/main\.go:2:\/\/ needle two/)

    const glob = await runner.executeTool({
      protocolVersion: REMOTE_RUNNER_PROTOCOL_VERSION,
      sessionId: 'session-go-smoke',
      requestId: 'request-glob',
      toolUseId: 'tool-glob',
      toolName: 'Glob',
      toolInput: { pattern: '**/*.go', maxResults: 10 },
      cwd: workspace,
      allowedPaths: [workspace],
      maxOutputBytes: 1000,
      bashMaxBufferBytes: 1000,
    })
    assert.equal(glob.kind, 'result')
    assert.equal(glob.kind === 'result' ? glob.success : false, true)
    assert.deepEqual((glob as any).output, ['src/main.go'])

    const bash = await runner.executeTool({
      protocolVersion: REMOTE_RUNNER_PROTOCOL_VERSION,
      sessionId: 'session-go-smoke',
      requestId: 'request-bash',
      toolUseId: 'tool-bash',
      toolName: 'Bash',
      toolInput: { command: 'printf bash-ok' },
      cwd: workspace,
      allowedPaths: [workspace],
      maxOutputBytes: 1000,
      bashMaxBufferBytes: 1000,
    })
    assert.equal(bash.kind, 'result')
    assert.equal(bash.kind === 'result' ? bash.success : false, true)
    assert.equal((bash as any).output.stdout, 'bash-ok')

    const write = await runner.executeTool({
      protocolVersion: REMOTE_RUNNER_PROTOCOL_VERSION,
      sessionId: 'session-go-smoke',
      requestId: 'request-write',
      toolUseId: 'tool-write',
      toolName: 'Write',
      toolInput: { path: 'worktree/notes.txt', content: 'hello worktree' },
      cwd: workspace,
      allowedPaths: [workspace],
      maxOutputBytes: 1000,
      bashMaxBufferBytes: 1000,
    })
    assert.equal(write.kind, 'result')
    assert.equal(write.kind === 'result' ? write.success : false, true)
    assert.equal((write as any).output, 'Wrote worktree/notes.txt')

    const edit = await runner.executeTool({
      protocolVersion: REMOTE_RUNNER_PROTOCOL_VERSION,
      sessionId: 'session-go-smoke',
      requestId: 'request-edit',
      toolUseId: 'tool-edit',
      toolName: 'Edit',
      toolInput: { path: 'worktree/notes.txt', oldString: 'worktree', newString: 'remote' },
      cwd: workspace,
      allowedPaths: [workspace],
      maxOutputBytes: 1000,
      bashMaxBufferBytes: 1000,
    })
    assert.equal(edit.kind, 'result')
    assert.equal(edit.kind === 'result' ? edit.success : false, true)
    assert.equal((edit as any).output, 'Edited worktree/notes.txt')

    const readEdited = await runner.executeTool({
      protocolVersion: REMOTE_RUNNER_PROTOCOL_VERSION,
      sessionId: 'session-go-smoke',
      requestId: 'request-read-edited',
      toolUseId: 'tool-read-edited',
      toolName: 'Read',
      toolInput: { path: 'worktree/notes.txt' },
      cwd: workspace,
      allowedPaths: [workspace],
      maxOutputBytes: 1000,
      bashMaxBufferBytes: 1000,
    })
    assert.equal(readEdited.kind, 'result')
    assert.equal(readEdited.kind === 'result' ? readEdited.success : false, true)
    assert.equal((readEdited as any).output, 'hello remote')

    const escape = await runner.executeTool({
      protocolVersion: REMOTE_RUNNER_PROTOCOL_VERSION,
      sessionId: 'session-go-smoke',
      requestId: 'request-escape',
      toolUseId: 'tool-escape',
      toolName: 'Read',
      toolInput: { path: '../secret.txt' },
      cwd: workspace,
      allowedPaths: [workspace],
      maxOutputBytes: 1000,
      bashMaxBufferBytes: 1000,
    })
    assert.equal(escape.kind, 'error')
    assert.equal(escape.kind === 'error' ? escape.code : undefined, 'WORKSPACE_PATH_DENIED')

    const mismatch = await runner.executeTool({
      protocolVersion: 'unsupported' as typeof REMOTE_RUNNER_PROTOCOL_VERSION,
      sessionId: 'session-go-smoke',
      requestId: 'request-2',
      toolUseId: 'tool-2',
      toolName: 'Read',
      toolInput: { path: 'README.md' },
      cwd: workspace,
      allowedPaths: [workspace],
      maxOutputBytes: 1000,
      bashMaxBufferBytes: 1000,
    })
    assert.equal(mismatch.kind, 'error')
    assert.equal(mismatch.kind === 'error' ? mismatch.code : undefined, 'REMOTE_RUNNER_PROTOCOL_MISMATCH')
  } finally {
    await terminateChildProcessGroup(child)
    if (workspace) await rm(workspace, { recursive: true, force: true })
  }
})

test('optional Go Explore Agent remote execution smoke', { skip: runGoSmoke ? false : 'Set BABEL_O_RUN_GO_RUNNER_SMOKE=1 to run Go Explore Agent remote smoke.' }, async () => {
  const port = String(43000 + Math.floor(Math.random() * 1000))
  const baseUrl = `http://127.0.0.1:${port}`
  let workspace = ''
  const child = spawn('go', ['run', './cmd/go-runner'], {
    cwd: goRunnerDir,
    env: {
      ...process.env,
      GO_RUNNER_HOST: '127.0.0.1',
      GO_RUNNER_PORT: port,
      GO_RUNNER_ID: 'go-explore-agent-remote-smoke',
    },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  try {
    await waitForCapabilities(baseUrl, child)
    const capabilities = await fetchJson(`${baseUrl}/v1/remote-runner/capabilities`)
    assert.equal(capabilities.id, 'go-explore-agent-remote-smoke')
    assert.deepEqual(capabilities.capabilities.tools, ['Read', 'Grep', 'Glob'])

    workspace = await mkdtemp(join(tmpdir(), 'babel-o-go-explore-agent-smoke-'))
    await mkdir(join(workspace, 'src'), { recursive: true })
    await writeFile(join(workspace, 'README.md'), 'hello\nneedle one\n')
    await writeFile(join(workspace, 'src', 'main.go'), 'package main\n// needle two\n')

    const runner = new RecordingRemoteToolRunner(new HttpRemoteToolRunner({
      baseUrl,
      capabilities: { tools: ['Read', 'Grep', 'Glob'] },
    }))
    const storage = new MemoryStorage()
    await saveParentSession(storage, 'session-agent-parent', workspace)
    const scheduler = new ExploreAgentScheduler({
      storage,
      cwd: workspace,
      executionEnvironment: 'remote',
      remoteRunner: runner,
      runtimeFactory: options => new ScriptedRemoteToolRuntime({
        storage: options.storage,
        allowedTools: options.allowedTools,
        summary: 'Explore Agent remote smoke completed.',
        toolCalls: [
          toolCall('tool-agent-read', 'Read', { path: 'README.md', offset: 0, limit: 5 }),
          toolCall('tool-agent-grep', 'Grep', { pattern: 'needle', path: '.', maxMatches: 10 }),
          toolCall('tool-agent-glob', 'Glob', { pattern: '**/*.go', maxResults: 10 }),
        ],
      }),
    })
    const agentTools = createAgentToolRegistry(scheduler)
    assert.deepEqual([...agentTools.keys()], ['AgentSpawn', 'AgentWait', 'AgentList', 'AgentCancel'])
    const spawned = await agentTools.get('AgentSpawn')!.execute({
      prompt: 'Find needle files through the remote runner.',
      agentType: 'explore',
      wait: true,
      timeoutMs: 10_000,
    }, toolContext('session-agent-parent', workspace))

    assert.equal(spawned.success, true)
    const output = spawned.output as any
    assert.equal(output.status, 'completed')
    assert.equal(output.result.summary, 'Explore Agent remote smoke completed.')
    assert.deepEqual(runner.requests.map(request => request.toolName), ['Read', 'Grep', 'Glob'])
    assert.deepEqual(runner.requests.map(request => request.cwd), [workspace, workspace, workspace])
    assert.deepEqual(runner.requests.map(request => request.allowedPaths), [[workspace], [workspace], [workspace]])
    const jobs = await scheduler.listAgents()
    assert.equal(jobs[0]?.transcriptPath, `nexus://sessions/${output.childSessionId}/events`)
    assert.equal(jobs[0]?.result?.findings?.some(finding => /Read completed/.test(finding.message)), true)
    const childEvents = await storage.listEvents(output.childSessionId)
    assert.deepEqual(
      childEvents.events
        .filter((event): event is Extract<NexusEvent, { type: 'tool_completed' }> => event.type === 'tool_completed')
        .map(event => event.name),
      ['Read', 'Grep', 'Glob'],
    )
    const parentEvents = await storage.listEvents('session-agent-parent')
    const completedEvent = parentEvents.events.find(event => event.type === 'task_session_event' && event.eventType === 'agent_job_completed')
    assert.equal(completedEvent?.type === 'task_session_event' ? (completedEvent.payload as any).result.summary : undefined, 'Explore Agent remote smoke completed.')

    const failureStorage = new MemoryStorage()
    await saveParentSession(failureStorage, 'session-agent-parent-failure', workspace)
    const failureScheduler = new ExploreAgentScheduler({
      storage: failureStorage,
      cwd: workspace,
      executionEnvironment: 'remote',
      remoteRunner: runner,
      runtimeFactory: options => new ScriptedRemoteToolRuntime({
        storage: options.storage,
        allowedTools: options.allowedTools,
        summary: 'Should not complete.',
        toolCalls: [toolCall('tool-agent-escape', 'Read', { path: '../secret.txt' })],
      }),
    })
    const failed = await createAgentToolRegistry(failureScheduler).get('AgentSpawn')!.execute({
      prompt: 'Verify workspace escape failures are summarized.',
      agentType: 'explore',
      wait: true,
      timeoutMs: 10_000,
    }, toolContext('session-agent-parent-failure', workspace))
    const failedOutput = failed.output as any
    assert.equal(failedOutput.status, 'failed')
    const failedJob = (await failureScheduler.listAgents())[0]
    assert.equal(failedJob?.error?.code, 'WORKSPACE_PATH_DENIED')
    const failedChild = await failureStorage.getSession(failedOutput.childSessionId)
    assert.equal(failedChild?.phase, 'failed')
    const failureParentEvents = await failureStorage.listEvents('session-agent-parent-failure')
    const failedEvent = failureParentEvents.events.find(event => event.type === 'task_session_event' && event.eventType === 'agent_job_failed')
    assert.equal(failedEvent?.type === 'task_session_event' ? (failedEvent.payload as any).error.code : undefined, 'WORKSPACE_PATH_DENIED')
  } finally {
    await terminateChildProcessGroup(child)
    if (workspace) await rm(workspace, { recursive: true, force: true })
  }
})

async function waitForCapabilities(baseUrl: string, child: ChildProcess): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < 10_000) {
    if (child.exitCode !== null) {
      throw new Error(`Go runner exited before readiness with code ${child.exitCode}.`)
    }
    try {
      await fetchJson(`${baseUrl}/v1/remote-runner/capabilities`)
      return
    } catch {
      await delay(100)
    }
  }
  throw new Error('Timed out waiting for Go runner capabilities endpoint.')
}

async function terminateChildProcessGroup(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null) return
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    return
  }
  const exited = once(child, 'exit').then(() => true)
  const timedOut = delay(2_000).then(() => false)
  if (await Promise.race([exited, timedOut])) return
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    return
  }
}

async function fetchJson(url: string): Promise<any> {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`)
  }
  return response.json()
}

function toolCall(id: string, name: string, input: unknown): RuntimeProviderToolCall {
  return {
    id,
    name,
    input,
    partialInput: JSON.stringify(input),
  }
}

function toolContext(sessionId: string, cwd: string) {
  return {
    cwd,
    sessionId,
    maxOutputBytes: 100_000,
    bashMaxBufferBytes: 100_000,
  }
}

async function saveParentSession(storage: NexusStorage, sessionId: string, cwd: string): Promise<void> {
  await storage.saveSession({
    sessionId,
    cwd,
    prompt: 'Parent prompt',
    phase: 'executing',
    createdAt: '2026-06-04T00:00:00.000Z',
    updatedAt: '2026-06-04T00:00:00.000Z',
    allowedPaths: [cwd],
    events: [],
  })
}

class RecordingRemoteToolRunner implements RemoteToolRunner {
  readonly requests: RemoteToolRunnerExecuteRequest[] = []
  readonly cancelRequests: RemoteToolRunnerCancelRequest[] = []

  constructor(private readonly runner: RemoteToolRunner) {}

  get id(): string {
    return this.runner.id
  }

  get capabilities() {
    return this.runner.capabilities
  }

  canExecuteTool(tool: Parameters<RemoteToolRunner['canExecuteTool']>[0]): boolean {
    return this.runner.canExecuteTool(tool)
  }

  async executeTool(request: RemoteToolRunnerExecuteRequest) {
    this.requests.push(request)
    return this.runner.executeTool(request)
  }

  async cancelTool(request: RemoteToolRunnerCancelRequest): Promise<void> {
    this.cancelRequests.push(request)
    await this.runner.cancelTool?.(request)
  }
}

class ScriptedRemoteToolRuntime implements NexusRuntime {
  private readonly tools = createDefaultToolRegistry()

  constructor(private readonly options: {
    storage: NexusStorage
    allowedTools: string[]
    toolCalls: RuntimeProviderToolCall[]
    summary: string
  }) {}

  async *executeStream(runtimeOptions: RuntimeExecuteOptions): AsyncIterable<NexusEvent> {
    yield {
      type: 'session_started',
      schemaVersion: '2026-05-21.babel-o.v1',
      sessionId: runtimeOptions.sessionId,
      timestamp: '2026-06-04T00:00:00.000Z',
      cwd: runtimeOptions.cwd,
    }

    const metrics = createRuntimeExecutionMetrics()
    for (const call of this.options.toolCalls) {
      const stream = executeProviderToolCall({
        toolCall: call,
        tools: this.tools,
        toolPolicy: allowlistedTools(this.options.allowedTools),
        runtimeOptions,
        storage: this.options.storage,
        metrics,
        readFileCache: new Map(),
      })
      for await (const event of stream) {
        yield event
        if (event.type === 'error') return
      }
    }

    yield buildRuntimeResultEvent(runtimeOptions.sessionId, true, this.options.summary)
  }
}
