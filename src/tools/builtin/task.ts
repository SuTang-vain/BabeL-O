import { z } from 'zod'
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
      await context.storage.saveTask(task)
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
