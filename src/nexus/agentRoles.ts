import { z } from 'zod'

export type AgentRole = 'planner' | 'executor' | 'critic' | 'optimizer'

export type AgentRoleDefinition = {
  role: AgentRole
  version: string
  systemPrompt: string
  modelPreference: {
    capability: 'long-context' | 'tool-stable' | 'structured-output'
  }
  toolPolicy: {
    allowedTools: string[]
    requiresApproval: boolean
  }
  inputSchema: z.ZodTypeAny
  outputSchema: z.ZodTypeAny
}

export const PlannerInputSchema = z.object({
  sessionId: z.string().min(1),
  goal: z.string().min(1),
  queueId: z.string().min(1),
  context: z.string().optional(),
})

export const PlannerOutputSchema = z.object({
  summary: z.string().min(1),
  tasks: z
    .array(
      z.object({
        title: z.string().min(1),
        description: z.string().optional(),
        dependsOn: z.array(z.string()).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .min(1),
  needsUserInput: z.boolean().optional(),
  userPrompt: z.string().optional(),
})

export const ExecutorInputSchema = z.object({
  sessionId: z.string().min(1),
  queueId: z.string().min(1),
  taskId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
})

export const ExecutorOutputSchema = z.object({
  taskId: z.string().min(1),
  success: z.boolean(),
  result: z.string().min(1),
  needsReview: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})

export const CriticInputSchema = z.object({
  sessionId: z.string().min(1),
  queueId: z.string().min(1),
  taskId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  result: z.string().min(1),
  executorMetadata: z.record(z.string(), z.unknown()).optional(),
})

export const CriticOutputSchema = z.object({
  approved: z.boolean(),
  reason: z.string().optional(),
  retryTaskTitle: z.string().optional(),
  retryTaskDescription: z.string().optional(),
})

export const PLANNER_ROLE: AgentRoleDefinition = {
  role: 'planner',
  version: '2026-05-17.p1-b',
  systemPrompt:
    'You are the Planner in a BabeL-Nexus workforce. Clarify the goal, identify risks, and decompose the user request into small executable tasks. Return only structured JSON matching the PlannerOutput schema.',
  modelPreference: {
    capability: 'long-context',
  },
  toolPolicy: {
    allowedTools: [],
    requiresApproval: false,
  },
  inputSchema: PlannerInputSchema,
  outputSchema: PlannerOutputSchema,
}

export const EXECUTOR_ROLE: AgentRoleDefinition = {
  role: 'executor',
  version: '2026-05-17.p1-b',
  systemPrompt:
    'You are the Executor in a BabeL-Nexus workforce. Claim one task, execute only that task through the BabeL Runtime, and return a concise structured result. Do not create unrelated tasks.',
  modelPreference: {
    capability: 'tool-stable',
  },
  toolPolicy: {
    allowedTools: ['Read', 'Write', 'Edit', 'Bash'],
    requiresApproval: true,
  },
  inputSchema: ExecutorInputSchema,
  outputSchema: ExecutorOutputSchema,
}

export const CRITIC_ROLE: AgentRoleDefinition = {
  role: 'critic',
  version: '2026-05-17.p1-b',
  systemPrompt:
    'You are the Critic in a BabeL-Nexus workforce. Review executor output against the original task, identify regressions, and decide whether a retry task is required. Return only structured JSON.',
  modelPreference: {
    capability: 'structured-output',
  },
  toolPolicy: {
    allowedTools: [],
    requiresApproval: false,
  },
  inputSchema: CriticInputSchema,
  outputSchema: CriticOutputSchema,
}

export const OPTIMIZER_ROLE: AgentRoleDefinition = {
  role: 'optimizer',
  version: '2026-05-22.p2-b',
  systemPrompt:
    'You are the Optimizer in a BabeL-Nexus workforce. Your goal is to optimize existing code for better performance, complexity, safety, and cleanliness. Ensure compilation passes and run validation tests. Return only structured JSON matching the ExecutorOutput schema.',
  modelPreference: {
    capability: 'tool-stable',
  },
  toolPolicy: {
    allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'],
    requiresApproval: false, // self-optimizing runs automatically
  },
  inputSchema: ExecutorInputSchema,
  outputSchema: ExecutorOutputSchema,
}

export const AGENT_ROLE_DEFINITIONS = {
  planner: PLANNER_ROLE,
  executor: EXECUTOR_ROLE,
  critic: CRITIC_ROLE,
  optimizer: OPTIMIZER_ROLE,
} satisfies Record<AgentRole, AgentRoleDefinition>
