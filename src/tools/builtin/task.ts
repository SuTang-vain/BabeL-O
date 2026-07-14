import { z } from 'zod'
import { eventBase } from '../../shared/events.js'
import { errorMessage } from '../../shared/errors.js'
import { createId, nowIso } from '../../shared/id.js'
import type { NexusTask } from '../../shared/task.js'
import type { ToolDefinition } from '../Tool.js'

const inputSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
})

export const taskTool: ToolDefinition<typeof inputSchema> = {
  name: 'TaskCreate',
  description: 'Create a task marker for the current session.',
  prompt: () => 'Manage a structured task list for tracking progress. Create task markers to organize complex multi-step work.',
  risk: 'task',
  inputSchema,
  async execute(input, context) {
    const task: NexusTask = {
      taskId: createId('task'),
      sessionId: context.sessionId,
      title: input.title,
      description: input.description,
      status: 'pending',
      dependsOn: [],
      blocks: [],
      retryCount: 0,
      source: 'user',
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }
    if (context.storage) {
      try {
        await context.storage.saveTask(task)
        // Emit a task_created event so WebSocket consumers (Go TUI,
        // loop driver, etc.) receive real-time notification without
        // waiting for an end-of-turn HTTP poll. Mirrors the same
        // appendEvent call in the REST API handler
        // (sessionTaskMutationRouter.ts:107-112).
        await context.storage.appendEvent(context.sessionId, {
          type: 'task_created',
          ...eventBase(context.sessionId),
          taskId: task.taskId,
          title: task.title,
        })
      } catch (error) {
        return {
          success: false,
          output: {
            code: 'TASK_SAVE_FAILED',
            message: errorMessage(error),
            title: input.title,
            repairHint: 'Retry task creation after storage is available, or continue without a persisted task marker.',
            details: taskErrorDetails(error),
          },
        }
      }
    }
    return {
      success: true,
      output: {
        taskId: task.taskId,
        title: task.title,
        status: task.status,
      },
    }
  },
}

function taskErrorDetails(error: unknown): Record<string, unknown> | undefined {
  if (!error || typeof error !== 'object') return undefined
  const record = error as Record<string, unknown>
  const details: Record<string, unknown> = {}
  if (record.code !== undefined) details.code = record.code
  if (record.name !== undefined) details.name = record.name
  return Object.keys(details).length > 0 ? details : undefined
}
