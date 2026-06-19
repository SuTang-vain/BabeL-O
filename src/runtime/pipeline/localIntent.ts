export type LocalRuntimeParsedIntent =
  | { kind: 'tool'; toolName: string; input: unknown }
  | { kind: 'file_question'; path: string; question: string }
  | { kind: 'task_status' }
  | { kind: 'task_update'; selector: string; status: 'pending' | 'in_progress' | 'completed' | 'failed'; result?: string }
  | { kind: 'text'; text: string }

export function parseLocalRuntimeIntent(prompt: string): LocalRuntimeParsedIntent {
  const trimmed = prompt.trim()
  const [verb = '', ...rest] = splitCommand(trimmed)
  const arg = rest.join(' ')

  if (verb.includes(':') && arg) {
    const toolName = verb.endsWith(':') ? verb.slice(0, -1) : verb
    try {
      return {
        kind: 'tool',
        toolName,
        input: JSON.parse(arg),
      }
    } catch {
      return {
        kind: 'tool',
        toolName,
        input: {},
      }
    }
  }

  if ((verb === 'listdir' || verb === 'ls') && (arg || verb === 'ls')) {
    return { kind: 'tool', toolName: 'ListDir', input: { path: arg || '.' } }
  }
  if (verb === 'read' && arg) {
    return { kind: 'tool', toolName: 'Read', input: { path: arg } }
  }
  if (verb === 'write' && rest.length >= 2) {
    const [path, ...content] = rest
    return {
      kind: 'tool',
      toolName: 'Write',
      input: { path, content: content.join(' ') },
    }
  }
  if (verb === 'edit' && rest.length >= 3) {
    const [path, oldString, ...newString] = rest
    return {
      kind: 'tool',
      toolName: 'Edit',
      input: { path, oldString, newString: newString.join(' ') },
    }
  }
  if (verb === 'grep' && arg) {
    return { kind: 'tool', toolName: 'Grep', input: { pattern: arg } }
  }
  if (verb === 'glob' && arg) {
    return { kind: 'tool', toolName: 'Glob', input: { pattern: arg } }
  }
  if (verb === 'bash' && arg) {
    return { kind: 'tool', toolName: 'Bash', input: { command: arg } }
  }
  if (verb === 'task' && rest[0] === 'status') {
    return { kind: 'task_status' }
  }
  if (verb === 'task' && rest[0] === 'update' && rest.length >= 3) {
    const [, selector, status, ...resultParts] = rest
    if (isSupportedTaskUpdateStatus(status)) {
      return {
        kind: 'task_update',
        selector,
        status,
        result: resultParts.length > 0 ? resultParts.join(' ') : undefined,
      }
    }
  }
  if (verb === 'task' && arg) {
    return { kind: 'tool', toolName: 'TaskCreate', input: { title: arg } }
  }

  const fileQuestionPath = extractFileQuestionPath(trimmed)
  if (fileQuestionPath) {
    return { kind: 'file_question', path: fileQuestionPath, question: trimmed }
  }

  return {
    kind: 'text',
    text:
      `BabeL-O local runtime is active. I can already run explicit coding tools: ` +
      '`listdir <dir>`, `glob <pattern>`, `grep <pattern>`, `read <file>`, ' +
      '`write <file> <text>`, `edit <file> <old> <new>`, `bash <command>`, `task <title>`. ' +
      `You said: ${trimmed || '(empty prompt)'}`,
  }
}

function isSupportedTaskUpdateStatus(status: string | undefined): status is 'pending' | 'in_progress' | 'completed' | 'failed' {
  return status === 'pending' || status === 'in_progress' || status === 'completed' || status === 'failed'
}

function extractFileQuestionPath(prompt: string): string | undefined {
  if (!/(file|文件|read|读取|内容|content|about|关于|what|does|say)/i.test(prompt)) return undefined
  const match = prompt.match(/(?:^|\s)([\w./-]+\.[A-Za-z0-9_]+)(?=$|\s|[，。！？,.!?])/)
  return match?.[1]
}

function splitCommand(input: string): string[] {
  const matches = input.match(/"[^"]*"|'[^']*'|\S+/g) ?? []
  return matches.map(part => {
    if (
      (part.startsWith('"') && part.endsWith('"')) ||
      (part.startsWith("'") && part.endsWith("'"))
    ) {
      return part.slice(1, -1)
    }
    return part
  })
}
