/**
 * Skill tool — model-visible bounded skill tools (Phase 6).
 *
 * Per `skill-execution-and-automated-normalized-skill-generation-governance-plan.md`:
 *   - `SkillList`     read  — list visible skills
 *   - `SkillShow`     read  — show one skill + body
 *   - `SkillValidate` read  — validate raw markdown or by id+cwd
 *   - `SkillDraft`    read  — generate a normalized draft (in-memory)
 *   - `SkillSave`     write — persist a draft (write risk + permission flow)
 *
 * Failure semantics (per `tool-governance-reference-integration.md` §5.2):
 *   - never throw to the tool loop; return `{ success: false, output: { errorCode, message, ... } }`.
 *   - errorCodes: SKILL_NOT_FOUND / SKILL_INVALID_INPUT / SKILL_LOAD_FAILED /
 *     SKILL_VALIDATION_FAILED / SKILL_DRAFT_INVALID_TITLE / SKILL_DRAFT_ID_CONFLICT /
 *     SKILL_SAVE_NOT_CONFIRMED / SKILL_SAVE_OVERWRITE_REQUIRED / SKILL_SAVE_PERSIST_FAILED.
 *
 * Test isolation: cwd comes from `input.cwd ?? context.cwd`; the runtime cwd
 * is whatever the session has. Tests pass a temp cwd explicitly.
 */

import { z } from 'zod'
import type { ToolDefinition, ToolContext, ToolResult } from '../Tool.js'
import { loadSkillRegistry, validateRegistrySkill } from '../../skills/registry.js'
import { validateSkill } from '../../skills/validator.js'
import { formatSkill } from '../../skills/formatter.js'
import { generateSkillDraft, type SkillDraftInput } from '../../skills/generator.js'
import { saveSkill, type SkillSaveInput } from '../../skills/storage.js'

function failure(errorCode: string, message: string, extras: Record<string, unknown> = {}): ToolResult {
  return { success: false, output: { errorCode, message, ...extras } }
}

// --- SkillList -------------------------------------------------------------

const skillListInputSchema = z.object({
  cwd: z.string().optional(),
  source: z.enum(['builtin', 'user', 'project']).optional(),
  status: z.enum(['active', 'draft', 'disabled']).optional(),
  builtInDir: z.string().optional(),
})

export const skillListTool: ToolDefinition<typeof skillListInputSchema> = {
  name: 'SkillList',
  description:
    'List visible skills (built-in / user / project). Returns normalized metadata only, not full bodies; use SkillShow to inspect a specific skill.',
  risk: 'read',
  inputSchema: skillListInputSchema,
  async execute(input, context: ToolContext): Promise<ToolResult> {
    const cwd = input.cwd ?? context.cwd
    try {
      const reg = await loadSkillRegistry({
        cwd,
        ...(input.builtInDir ? { builtInDir: input.builtInDir } : {}),
      })
      let skills = reg.list()
      if (input.source) skills = skills.filter(s => s.source === input.source)
      if (input.status) skills = skills.filter(s => s.status === input.status)
      return {
        success: true,
        output: {
          skills: skills.map(s => ({
            id: s.id,
            name: s.name,
            description: s.description,
            source: s.source,
            scope: s.scope,
            status: s.status,
            risk: s.risk,
            triggers: s.triggers,
            priority: s.priority,
            allowedTools: s.allowedTools,
          })),
        },
      }
    } catch (err) {
      return failure('SKILL_LOAD_FAILED', err instanceof Error ? err.message : String(err))
    }
  },
}

// --- SkillShow -------------------------------------------------------------

const skillShowInputSchema = z.object({
  cwd: z.string().optional(),
  id: z.string().min(1),
  builtInDir: z.string().optional(),
})

export const skillShowTool: ToolDefinition<typeof skillShowInputSchema> = {
  name: 'SkillShow',
  description: 'Show a single skill by id, including its body (canonical Markdown).',
  risk: 'read',
  inputSchema: skillShowInputSchema,
  async execute(input, context: ToolContext): Promise<ToolResult> {
    const cwd = input.cwd ?? context.cwd
    try {
      const reg = await loadSkillRegistry({
        cwd,
        ...(input.builtInDir ? { builtInDir: input.builtInDir } : {}),
      })
      const skill = reg.get(input.id)
      if (!skill) {
        return failure('SKILL_NOT_FOUND', `Skill "${input.id}" not found in registry (cwd=${cwd}).`, { id: input.id })
      }
      return {
        success: true,
        output: {
          skill: {
            id: skill.id,
            name: skill.name,
            description: skill.description,
            source: skill.source,
            scope: skill.scope,
            status: skill.status,
            risk: skill.risk,
            triggers: skill.triggers,
            priority: skill.priority,
            allowedTools: skill.allowedTools,
            body: formatSkill(skill),
          },
        },
      }
    } catch (err) {
      return failure('SKILL_LOAD_FAILED', err instanceof Error ? err.message : String(err))
    }
  },
}

// --- SkillValidate ---------------------------------------------------------

const skillValidateInputSchema = z.object({
  cwd: z.string().optional(),
  id: z.string().optional(),
  body: z.string().optional(),
})

export const skillValidateTool: ToolDefinition<typeof skillValidateInputSchema> = {
  name: 'SkillValidate',
  description:
    'Validate a skill: either by id (loads from cwd registry) or by raw markdown body. Returns structured diagnostics; never throws.',
  risk: 'read',
  inputSchema: skillValidateInputSchema,
  async execute(input, context: ToolContext): Promise<ToolResult> {
    if (!input.id && !input.body) {
      return failure(
        'SKILL_INVALID_INPUT',
        'Either `id` (with cwd) or `body` (raw markdown) is required.',
        { field: 'id|body' },
      )
    }
    if (input.body) {
      const { parseFrontMatter } = await import('../../skills/loader.js')
      const raw = parseFrontMatter(input.body)
      if (!raw) {
        return failure('SKILL_VALIDATION_FAILED', 'Failed to parse front matter (missing/invalid id or delimiters).', {
          diagnostics: [
            {
              severity: 'error',
              code: 'SKILL_PARSE_FAILED',
              message: 'Failed to parse front matter (missing/invalid id or delimiters).',
            },
          ],
        })
      }
      const result = validateSkill(raw)
      return result.ok
        ? { success: true, output: { ok: true, skillId: raw.id, diagnostics: result.diagnostics } }
        : failure('SKILL_VALIDATION_FAILED', `Validation failed for skill "${raw.id}".`, {
            skillId: raw.id,
            diagnostics: result.diagnostics,
          })
    }
    // by id
    const cwd = input.cwd ?? context.cwd
    try {
      // Note: by-id validation does not currently accept builtInDir override
      // because validation only reads from cwd registry; if builtInDir is
      // added to this schema, propagate it here.
      const reg = await loadSkillRegistry({ cwd })
      const result = validateRegistrySkill(reg, input.id!)
      if (!result) {
        return failure('SKILL_NOT_FOUND', `Skill "${input.id}" not found in registry.`, { id: input.id })
      }
      return result.ok
        ? { success: true, output: { ok: true, skillId: input.id, diagnostics: result.diagnostics } }
        : failure('SKILL_VALIDATION_FAILED', `Validation failed for skill "${input.id}".`, {
            skillId: input.id,
            diagnostics: result.diagnostics,
          })
    } catch (err) {
      return failure('SKILL_LOAD_FAILED', err instanceof Error ? err.message : String(err))
    }
  },
}

// --- SkillDraft ------------------------------------------------------------

const skillDraftInputSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  idHint: z.string().optional(),
  triggers: z.array(z.string()).optional(),
  explicitOnly: z.boolean().optional(),
  sessionSummary: z.string().optional(),
  toolOutcomes: z.string().optional(),
  risk: z.enum(['read', 'write', 'execute', 'network', 'task']).optional(),
  allowedTools: z.array(z.string()).optional(),
  scope: z.enum(['user', 'project']).optional(),
})

export const skillDraftTool: ToolDefinition<typeof skillDraftInputSchema> = {
  name: 'SkillDraft',
  description:
    'Generate a normalized skill draft from a title and optional context. Drafts are in-memory only; use SkillSave (with confirm: true) to persist.',
  risk: 'read',
  inputSchema: skillDraftInputSchema,
  async execute(input): Promise<ToolResult> {
    const draftInput: SkillDraftInput = {
      title: input.title,
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.idHint !== undefined ? { idHint: input.idHint } : {}),
      ...(input.triggers !== undefined ? { triggers: input.triggers } : {}),
      ...(input.explicitOnly !== undefined ? { explicitOnly: input.explicitOnly } : {}),
      ...(input.sessionSummary !== undefined ? { sessionSummary: input.sessionSummary } : {}),
      ...(input.toolOutcomes !== undefined ? { toolOutcomes: input.toolOutcomes } : {}),
      ...(input.risk !== undefined ? { risk: input.risk } : {}),
      ...(input.allowedTools !== undefined ? { allowedTools: input.allowedTools } : {}),
      ...(input.scope !== undefined ? { scope: input.scope } : {}),
    }
    const result = generateSkillDraft(draftInput)
    if (!result.ok) {
      return failure(result.errorCode, result.message, { diagnostics: result.diagnostics })
    }
    return {
      success: true,
      output: {
        ok: true,
        draft: {
          id: result.draft.id,
          name: result.draft.name,
          description: result.draft.description,
          source: result.draft.source,
          scope: result.draft.scope,
          status: 'draft' as const,
          risk: result.draft.risk,
          triggers: result.draft.triggers,
          priority: result.draft.priority,
          allowedTools: result.draft.allowedTools,
          body: result.body,
        },
        redactionWarnings: result.redactionWarnings,
        validationWarnings: result.validationWarnings,
      },
    }
  },
}

// --- SkillSave -------------------------------------------------------------

const skillSaveInputSchema = z.object({
  cwd: z.string().optional(),
  builtInDir: z.string().optional(),
  draft: z.object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    version: z.number(),
    status: z.string(),
    source: z.enum(['builtin', 'user', 'project']),
    scope: z.enum(['builtin', 'user', 'project']),
    triggers: z.array(z.string()),
    priority: z.number(),
    risk: z.enum(['read', 'write', 'execute', 'network', 'task']),
    allowedTools: z.array(z.string()),
    content: z.string(),
    filePath: z.string().optional(),
  }),
  confirm: z.boolean().default(false),
  overwrite: z.boolean().optional(),
  scope: z.enum(['user', 'project']).optional(),
})

export const skillSaveTool: ToolDefinition<typeof skillSaveInputSchema> = {
  name: 'SkillSave',
  description:
    'Persist a skill draft to disk. Requires explicit `confirm: true` after preview. Write risk; goes through runtime permission flow.',
  risk: 'write',
  requiresApproval: true,
  suggestedAllowRule: '- tool: SkillSave',
  inputSchema: skillSaveInputSchema,
  async execute(input, context: ToolContext): Promise<ToolResult> {
    const cwd = input.cwd ?? context.cwd
    const saveInput: SkillSaveInput = {
      cwd,
      draft: input.draft as unknown as SkillSaveInput['draft'],
      confirm: input.confirm,
      ...(input.overwrite !== undefined ? { overwrite: input.overwrite } : {}),
      ...(input.scope !== undefined ? { scope: input.scope } : {}),
    }
    // Note: builtInDir is accepted in the schema for future use (e.g. when
    // save needs to re-load for duplicate detection against an alternate
    // built-in root). The current preview path uses cwd; this is a placeholder
    // pass-through to keep the schema stable.
    const result = await saveSkill(saveInput)
    if (!result.ok) {
      // preview-only is not a failure — surface the preview so the model can
      // call SkillSave again with confirm: true.
      if (result.errorCode === 'SKILL_SAVE_NOT_CONFIRMED' && result.preview) {
        return {
          success: true,
          output: {
            ok: false,
            previewOnly: true,
            errorCode: result.errorCode,
            message: result.message,
            preview: {
              scope: result.preview.scope,
              filePath: result.preview.filePath,
              body: result.preview.body,
              isNewFile: result.preview.isNewFile,
              duplicateWarnings: result.preview.duplicateWarnings,
            },
          },
        }
      }
      return failure(result.errorCode, result.message, {
        ...(result.preview
          ? {
              preview: {
                scope: result.preview.scope,
                filePath: result.preview.filePath,
                body: result.preview.body,
                isNewFile: result.preview.isNewFile,
                duplicateWarnings: result.preview.duplicateWarnings,
              },
            }
          : {}),
      })
    }
    return {
      success: true,
      output: {
        ok: true,
        scope: result.scope,
        filePath: result.filePath,
        format: result.format,
        saved: result.saved,
      },
    }
  },
}
