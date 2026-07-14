import { z } from 'zod'
import { ErrorCodes } from '../../shared/errors.js'
import type { ToolDefinition } from '../Tool.js'

const optionSchema = z.object({
  label: z.string().min(1),
  description: z.string().optional(),
})

const inputSchema = z.object({
  question: z.string().min(1),
  header: z.string().optional(),
  options: z.array(optionSchema).min(2).max(4),
  multiSelect: z.boolean().default(false),
})

export const askUserQuestionTool: ToolDefinition<typeof inputSchema> = {
  name: 'AskUserQuestion',
  description: 'Ask the user a structured multi-choice question. Use when you need the user to choose between defined options, such as selecting an approach, confirming a preference, or picking a workflow path.',
  prompt: () => 'Present a structured question to the user with predefined choices. For single-select questions the user picks one option; for multi-select they can pick several. Keep options concise and mutually exclusive.',
  risk: 'task',
  inputSchema,
  requiresApproval: false,
  async execute(input, _context) {
    if (input.options.length < 2 || input.options.length > 4) {
      return {
        success: false,
        output: {
          code: ErrorCodes.ASK_QUESTION_OPTIONS_OUT_OF_RANGE,
          message: `AskUserQuestion requires 2-4 options, got ${input.options.length}.`,
          repairHint: 'Provide between 2 and 4 options for the user to choose from.',
        },
      }
    }

    // The tool returns a pending_question status — the runtime intercepts
    // this in executeProviderToolCall, emits the ask_user_question event
    // with the real toolUseId, and waits for the user's response via the
    // question-response HTTP endpoint before returning the final tool_result.
    return {
      success: true,
      output: {
        status: 'pending_question',
        question: input.question,
        header: input.header,
        options: input.options.map((o: { label: string; description?: string }) => ({
          label: o.label,
          ...(o.description ? { description: o.description } : {}),
        })),
        multiSelect: input.multiSelect ?? false,
      },
    }
  },
}
