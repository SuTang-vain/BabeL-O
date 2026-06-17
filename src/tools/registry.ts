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

export function createDefaultToolRegistry(): Map<string, AnyTool> {
  const tools = [
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
  return new Map(tools.map(tool => [tool.name, tool as AnyTool]))
}
