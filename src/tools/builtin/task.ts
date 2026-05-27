import { z } from 'zod'
import type { ToolDefinition } from '../Tool.js'

const inputSchema = z.object({
  title: z.string().min(1),
})

export const taskTool: ToolDefinition<typeof inputSchema> = {
  name: 'TaskCreate',
  description: 'Create a task marker for the current session.',
  prompt: () => 'Manage a structured task list for tracking progress. Create task markers to organize complex multi-step work.',
  risk: 'task',
  inputSchema,
  async execute(input) {
    return {
      success: true,
      output: {
        title: input.title,
        status: 'pending',
      },
    }
  },
}
