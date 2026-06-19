import type { ToolResultContentBlock } from '../providers/adapters/ModelAdapter.js'
import type { NexusEvent } from '../shared/events.js'
import type { NexusStorage } from '../storage/Storage.js'
import type { AnyTool } from '../tools/Tool.js'
import type { ToolPolicy } from './LocalCodingRuntime.js'
import type { RuntimeExecuteOptions } from './Runtime.js'
import {
  buildContextGroundingConfirmedEventForToolResult,
  resolveProviderToolCallInput,
  type RuntimeExecutionMetrics,
  type RuntimeProviderToolCall,
} from './runtimePipeline.js'
import {
  executeProviderToolCall,
  type ReadFileCacheEntry,
} from './runtimeToolLoop.js'
import { type ProviderSessionRules } from './providerSessionRules.js'
import {
  deriveTaskScope,
  type TaskScopeDeclaredEvent,
} from './taskScope.js'

export type ToolDispatchPipelineResult =
  | {
    kind: 'continue'
    previousEvents: NexusEvent[]
    taskScopeEvent: TaskScopeDeclaredEvent
    toolResults: ToolResultContentBlock[]
  }
  | {
    kind: 'terminal'
    previousEvents: NexusEvent[]
    taskScopeEvent: TaskScopeDeclaredEvent
  }

export class ToolDispatchPipeline {
  constructor(
    private readonly deps: {
      tools: Map<string, AnyTool>
      toolPolicy: ToolPolicy
      storage: NexusStorage
      metrics: RuntimeExecutionMetrics
      readFileCache: Map<string, ReadFileCacheEntry>
      providerSessionRules: ProviderSessionRules
      applyWorkingSetUpdate?: (sessionId: string, events: NexusEvent[], cwd: string) => void
    },
  ) {}

  async *run(options: {
    toolCalls: RuntimeProviderToolCall[]
    runtimeOptions: RuntimeExecuteOptions
    previousEvents: NexusEvent[]
    taskScopeEvent: TaskScopeDeclaredEvent
  }): AsyncGenerator<NexusEvent, ToolDispatchPipelineResult> {
    let previousEvents = options.previousEvents
    let taskScopeEvent = options.taskScopeEvent
    const toolResults: ToolResultContentBlock[] = []

    for (const toolCall of options.toolCalls) {
      const toolEvents: NexusEvent[] = []
      const toolExecution = executeProviderToolCall({
        toolCall,
        tools: this.deps.tools,
        toolPolicy: this.deps.toolPolicy,
        runtimeOptions: options.runtimeOptions,
        storage: this.deps.storage,
        metrics: this.deps.metrics,
        readFileCache: this.deps.readFileCache,
        taskScope: taskScopeEvent,
        providerSessionRules: this.deps.providerSessionRules,
      })
      let next = await toolExecution.next()
      while (!next.done) {
        toolEvents.push(next.value)
        yield next.value
        next = await toolExecution.next()
      }

      previousEvents = [...previousEvents, ...toolEvents]
      this.deps.applyWorkingSetUpdate?.(
        options.runtimeOptions.sessionId,
        toolEvents,
        options.runtimeOptions.cwd,
      )

      if (next.value.kind === 'terminal') {
        return { kind: 'terminal', previousEvents, taskScopeEvent }
      }

      const completedEvent = toolEvents.findLast((event): event is Extract<NexusEvent, { type: 'tool_completed' }> =>
        event.type === 'tool_completed' && event.toolUseId === toolCall.id
      )
      if (completedEvent) {
        const groundingConfirmedEvent = buildContextGroundingConfirmedEventForToolResult({
          sessionId: options.runtimeOptions.sessionId,
          requestId: options.runtimeOptions.requestId,
          events: previousEvents,
          toolCompleted: completedEvent,
          toolInput: resolveProviderToolCallInput(toolCall),
        })
        if (groundingConfirmedEvent) {
          previousEvents = [...previousEvents, groundingConfirmedEvent]
          yield groundingConfirmedEvent
        }
      }

      const scopeConfirmationEvents = toolEvents.filter((event): event is Extract<NexusEvent, { type: 'scope_boundary_confirmed' }> =>
        event.type === 'scope_boundary_confirmed'
      )
      if (scopeConfirmationEvents.length > 0) {
        taskScopeEvent = {
          ...taskScopeEvent,
          ...deriveTaskScope({
            sessionId: options.runtimeOptions.sessionId,
            requestId: options.runtimeOptions.requestId,
            cwd: options.runtimeOptions.cwd,
            prompt: options.runtimeOptions.prompt,
            events: previousEvents,
            allowedPaths: options.runtimeOptions.allowedPaths,
          }),
          message: taskScopeEvent.message,
        }
      }

      toolResults.push(next.value.toolResult)
    }

    return {
      kind: 'continue',
      previousEvents,
      taskScopeEvent,
      toolResults,
    }
  }
}
