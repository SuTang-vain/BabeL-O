/**
 * Skill session events.
 *
 * Phase 2 of the Skill execution governance plan introduces four observable
 * events on the Nexus event stream. They are intentionally *additional* to
 * the existing tool/task events (the integration index says new tool events
 * are not introduced — this is the Skill domain's own contract, not a tool
 * event, so the rule does not apply here).
 *
 * Per the Skill governance plan §Session events and observability:
 *  - `skill_matched`  — implicit trigger match in context assembly
 *  - `skill_invoked`  — explicit invocation (e.g. `/skill run <id>`)
 *  - `skill_validation` — validator diagnostics (typically from `/skill validate`)
 *  - `skill_saved`    — successful persistence after explicit confirmation
 *
 * NOTE — typed but not yet unioned: these schemas are defined here and may
 * be imported directly (e.g. by `src/skills/registry.ts` for typed emit).
 * They are *not* yet part of the `NexusEventSchema` discriminated union in
 * `./events.ts`; doing so regresses zod type inference on the existing
 * union (the runtime test surface asserts on `event.type` literally).
 * Re-integration is tracked as a separate item; it should be paired with
 * splitting the existing union or upgrading zod.
 */

import { z } from 'zod'
import {
  NEXUS_EVENT_SCHEMA_VERSION,
  baseEventFields,
} from './events.js'

export const SkillMatchedEventSchema = z.object({
  type: z.literal('skill_matched'),
  ...baseEventFields,
  skillIds: z.array(z.string()),
  matches: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      source: z.enum(['builtin', 'user', 'project']),
      score: z.number(),
      priority: z.number(),
      triggers: z.array(z.string()),
    }),
  ),
  promptPreview: z.string().max(200).optional(),
})

export const SkillInvokedEventSchema = z.object({
  type: z.literal('skill_invoked'),
  ...baseEventFields,
  skillId: z.string(),
  source: z.enum(['builtin', 'user', 'project']),
  invocationMode: z.enum(['explicit', 'implicit']),
})

export const SkillValidationEventSchema = z.object({
  type: z.literal('skill_validation'),
  ...baseEventFields,
  skillId: z.string().optional(),
  success: z.boolean(),
  diagnosticCount: z.number().int().nonnegative(),
  errorCount: z.number().int().nonnegative(),
  warningCount: z.number().int().nonnegative(),
})

export const SkillSavedEventSchema = z.object({
  type: z.literal('skill_saved'),
  ...baseEventFields,
  skillId: z.string(),
  scope: z.enum(['user', 'project']),
  filePath: z.string(),
  format: z.enum(['overwrite', 'new']).default('new'),
})

export const SkillEvents = [
  SkillMatchedEventSchema,
  SkillInvokedEventSchema,
  SkillValidationEventSchema,
  SkillSavedEventSchema,
] as const

export type SkillMatchedEvent = z.infer<typeof SkillMatchedEventSchema>
export type SkillInvokedEvent = z.infer<typeof SkillInvokedEventSchema>
export type SkillValidationEvent = z.infer<typeof SkillValidationEventSchema>
export type SkillSavedEvent = z.infer<typeof SkillSavedEventSchema>

// Re-export for the discriminated union aggregator in events.ts.
export const SKILL_NEXUS_EVENT_SCHEMA_VERSION = NEXUS_EVENT_SCHEMA_VERSION
