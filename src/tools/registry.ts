import type { NexusStorage } from '../storage/Storage.js'
import type { AnyTool } from './Tool.js'
import { bashTool } from './builtin/bash.js'
import { contextRecentTool } from './builtin/contextRecent.js'
import { contextSearchTool } from './builtin/contextSearch.js'
import { contextSummarizeTool } from './builtin/contextSummarize.js'
import { editTool } from './builtin/edit.js'
import { globTool } from './builtin/glob.js'
import { grepTool } from './builtin/grep.js'
import { listDirTool } from './builtin/listDir.js'
import { readTool } from './builtin/read.js'
import {
  skillDraftTool,
  skillListTool,
  skillSaveTool,
  skillShowTool,
  skillValidateTool,
} from './builtin/skillTool.js'
import { taskTool } from './builtin/task.js'
import { webSearchTool } from './builtin/webSearch.js'
import { writeTool } from './builtin/write.js'

export interface CreateToolRegistryOptions {
  // `storage: null` means "no storage available; hide context* tools so
  // the model prompt does not advertise tools that always fail with
  // CONTEXT_STORAGE_UNAVAILABLE." This is the sentinel used by direct
  // LocalCodingRuntime construction (e.g. Go TUI local mode) where
  // storage is intentionally absent.
  // `storage: undefined` (or opts not provided) preserves the historical
  // default: all tools including context* are registered, and the
  // tool's own storage gate returns CONTEXT_STORAGE_UNAVAILABLE at
  // execute time.
  storage?: NexusStorage | null
}

const CONTEXT_TOOL_NAMES = new Set(['contextSearch', 'contextSummarize', 'contextRecent'])

export function createDefaultToolRegistry(opts: CreateToolRegistryOptions = {}): Map<string, AnyTool> {
  const tools: AnyTool[] = [
    listDirTool,
    globTool,
    grepTool,
    readTool,
    writeTool,
    editTool,
    bashTool,
    taskTool,
    webSearchTool,
    // PR-8: on-demand context tools (Track A Phase 2). Read risk, no approval.
    // Do NOT enter active context (INV-L12); called by model on demand.
    contextSearchTool,
    contextSummarizeTool,
    contextRecentTool,
    // Skill tools (Phase 6 of the Skill execution governance plan).
    // 5 bounded tools: SkillList / SkillShow / SkillValidate / SkillDraft / SkillSave.
    // SkillSave has write risk + requiresApproval; the other 4 are read risk.
    skillListTool,
    skillShowTool,
    skillValidateTool,
    skillDraftTool,
    skillSaveTool,
  ]
  const registry = new Map(tools.map(tool => [tool.name, tool as AnyTool]))

  // When the caller explicitly passes `storage: null`, drop the context*
  // tools. The model prompt for an LLM-runtime without storage should
  // not advertise tools that will always return CONTEXT_STORAGE_UNAVAILABLE.
  if (opts.storage === null) {
    for (const name of CONTEXT_TOOL_NAMES) {
      registry.delete(name)
    }
  }
  return registry
}
