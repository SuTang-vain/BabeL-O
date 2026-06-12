import type { AnyTool } from './Tool.js'
import { bashTool } from './builtin/bash.js'
import { editTool } from './builtin/edit.js'
import { globTool } from './builtin/glob.js'
import { grepTool } from './builtin/grep.js'
import { listDirTool } from './builtin/listDir.js'
import { readTool } from './builtin/read.js'
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
  ]
  return new Map(tools.map(tool => [tool.name, tool as AnyTool]))
}
