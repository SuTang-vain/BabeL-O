import { z } from 'zod'
import { ErrorCodes, errorMessage } from '../../shared/errors.js'
import { createId, nowIso } from '../../shared/id.js'
import type { NexusTask, TaskStatus } from '../../shared/task.js'
import type { ToolDefinition } from '../Tool.js'

// ---------------------------------------------------------------------------
// TaskCreate
// ---------------------------------------------------------------------------

const createInputSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
})

export const taskTool: ToolDefinition<typeof createInputSchema> = {
  name: 'TaskCreate',
  description: 'Create a task marker for the current session.',
  prompt: () => 'Manage a structured task list for tracking progress. Create task markers to organize complex multi-step work.',
  risk: 'task',
  inputSchema: createInputSchema,
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
        // The task_created event is now yielded by the runtime
        // (runtimeToolLoop.ts) after tool_completed so that both
        // the WebSocket broadcast and storage persistence happen
        // through the single processRuntimeExecutionEvent path.
        // The REST API path (sessionTaskMutationRouter) still
        // persists its own task_created events independently.
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

// ---------------------------------------------------------------------------
// TaskList
// ---------------------------------------------------------------------------

const listInputSchema = z.object({
  status: z.enum(['pending', 'in_progress', 'blocked', 'completed', 'failed', 'cancelled']).optional(),
})

export const taskListTool: ToolDefinition<typeof listInputSchema> = {
  name: 'TaskList',
  description: 'List all tasks for the current session, optionally filtered by status.',
  prompt: () => 'Enumerate the task list for the current session. Optionally filter by status to focus on pending, in-progress, or completed items.',
  risk: 'read',
  inputSchema: listInputSchema,
  async execute(input, context) {
    if (!context.storage) {
      return {
        success: false,
        output: {
          code: ErrorCodes.STORAGE_UNAVAILABLE,
          message: 'Task storage is not available in this context.',
          repairHint: 'Tasks are only available when storage is connected.',
        },
      }
    }
    try {
      const tasks = await context.storage.listTasks(context.sessionId)
      let filtered = tasks
      if (input.status) {
        filtered = tasks.filter(t => t.status === input.status)
      }
      return {
        success: true,
        output: {
          tasks: filtered.map(t => ({
            taskId: t.taskId,
            title: t.title,
            status: t.status,
            description: t.description,
          })),
          total: filtered.length,
        },
      }
    } catch (error) {
      return {
        success: false,
        output: {
          code: 'TASK_LIST_FAILED',
          message: errorMessage(error),
          repairHint: 'Retry listing tasks, or continue without the task list.',
        },
      }
    }
  },
}

// ---------------------------------------------------------------------------
// TaskUpdate
// ---------------------------------------------------------------------------

const updateInputSchema = z.object({
  taskId: z.string().min(1),
  status: z.enum(['pending', 'in_progress', 'blocked', 'completed', 'failed', 'cancelled']).optional(),
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  result: z.string().optional(),
})

/**
 * Valid status transitions for TaskUpdate.
 *
 * Once a task reaches a terminal status (completed / failed / cancelled)
 * it cannot transition back to any non-terminal status.
 */
const VALID_TRANSITIONS: Record<string, string[]> = {
  pending:      ['in_progress', 'completed', 'cancelled'],
  in_progress:  ['completed', 'failed', 'cancelled'],
  blocked:      ['cancelled'],
  completed:    [],
  failed:       [],
  cancelled:    [],
}

function isValidTransition(from: TaskStatus, to: TaskStatus): boolean {
  if (from === to) return true // no-op is always valid
  const allowed = VALID_TRANSITIONS[from]
  if (!allowed) return false
  return allowed.includes(to)
}

export const taskUpdateTool: ToolDefinition<typeof updateInputSchema> = {
  name: 'TaskUpdate',
  description: 'Update an existing task: change its status, title, description, or result. Use this to advance tasks through their lifecycle (pending → in_progress → completed/failed/cancelled).',
  prompt: () => 'Update a task\'s status, title, description, or result. Status transitions are validated: completed/failed/cancelled tasks cannot be rolled back. Use TaskList first to find the taskId.',
  risk: 'task',
  requiresApproval: true,
  suggestedAllowRule: '- tool: TaskUpdate',
  inputSchema: updateInputSchema,
  async execute(input, context) {
    if (!context.storage) {
      return {
        success: false,
        output: {
          code: ErrorCodes.STORAGE_UNAVAILABLE,
          message: 'Task storage is not available in this context.',
          repairHint: 'Tasks are only available when storage is connected.',
        },
      }
    }
    try {
      const task = await context.storage.getTask(input.taskId)
      if (!task || task.sessionId !== context.sessionId) {
        return {
          success: false,
          output: {
            code: ErrorCodes.TASK_NOT_FOUND,
            message: `Task not found: ${input.taskId}`,
            repairHint: 'Use TaskList to find the correct taskId for this session.',
          },
        }
      }

      // Validate status transition
      if (input.status && !isValidTransition(task.status, input.status)) {
        return {
          success: false,
          output: {
            code: ErrorCodes.TASK_TERMINAL,
            message: `Cannot transition task from '${task.status}' to '${input.status}'. '${task.status}' tasks cannot be rolled back.`,
            repairHint: `Task '${task.taskId}' is in '${task.status}' state. Only pending or in-progress tasks can change status. Create a new task if needed.`,
          },
        }
      }

      const updated: NexusTask = {
        ...task,
        title: input.title ?? task.title,
        description: input.description !== undefined ? input.description : task.description,
        status: input.status ?? task.status,
        result: input.result !== undefined ? input.result : task.result,
        updatedAt: nowIso(),
      }

      await context.storage.saveTask(updated)

      return {
        success: true,
        output: {
          taskId: updated.taskId,
          title: updated.title,
          status: updated.status,
          updatedAt: updated.updatedAt,
        },
      }
    } catch (error) {
      // If the error is already a structured ToolResult, return it
      if (error && typeof error === 'object' && 'success' in (error as any)) {
        return error as any
      }
      return {
        success: false,
        output: {
          code: 'TASK_UPDATE_FAILED',
          message: errorMessage(error),
          repairHint: 'Retry the task update, or use TaskList to verify the current state.',
        },
      }
    }
  },
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function taskErrorDetails(error: unknown): Record<string, unknown> | undefined {
  if (!error || typeof error !== 'object') return undefined
  const record = error as Record<string, unknown>
  const details: Record<string, unknown> = {}
  if (record.code !== undefined) details.code = record.code
  if (record.name !== undefined) details.name = record.name
  return Object.keys(details).length > 0 ? details : undefined
}