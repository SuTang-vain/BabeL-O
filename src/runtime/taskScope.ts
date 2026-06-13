import { existsSync, lstatSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { eventBase, type NexusEvent } from '../shared/events.js'
import { extractAbsolutePaths } from './systemPromptBuilder.js'

export type TaskScopeDeclaredEvent = Extract<NexusEvent, { type: 'task_scope_declared' }>
export type ScopeBoundaryDetectedEvent = Extract<NexusEvent, { type: 'scope_boundary_detected' }>
export type ScopeBoundaryConfirmedEvent = Extract<NexusEvent, { type: 'scope_boundary_confirmed' }>

export type ToolScopeBoundary = Pick<ScopeBoundaryDetectedEvent,
  'toolUseId' | 'toolName' | 'targetRoot' | 'boundaryKind' | 'action' | 'reason' | 'suggestedPrompt' | 'scopeRisk' | 'taskPrimaryRoot'
>

const CROSS_PROJECT_INTENT_PATTERN = /(对比|比较|集成|迁移|借鉴|审计|cross[- ]?project|compare|integrat|migrat|audit)/i
const TOOL_PATH_KEYS: Record<string, string[]> = {
  read: ['path'],
  grep: ['path'],
  glob: ['path', 'pattern'],
  listdir: ['path'],
  list_dir: ['path'],
}

export function deriveTaskScope(options: {
  sessionId: string
  requestId?: string
  cwd: string
  prompt: string
  events?: NexusEvent[]
  allowedPaths?: readonly string[]
}): Omit<TaskScopeDeclaredEvent, 'type' | 'schemaVersion' | 'sessionId' | 'timestamp' | 'requestId' | 'message'> {
  const primaryRoot = inferProjectRoot(options.cwd)
  const promptRoots = extractAbsolutePaths(options.prompt)
    .map(path => inferProjectRoot(resolve(path)))
  const explicitRoots = uniqueRoots(promptRoots.filter(root => !isWithinRoot(primaryRoot, root)))
  const confirmedExternalRoots = uniqueRoots([
    ...(options.allowedPaths ?? []).map(path => inferProjectRoot(resolve(options.cwd, path))),
    ...confirmedRootsFromEvents(options.events ?? []),
  ].filter(root => !isWithinRoot(primaryRoot, root)))
  const hasCrossProjectIntent = CROSS_PROJECT_INTENT_PATTERN.test(options.prompt)
  const mode: TaskScopeDeclaredEvent['mode'] = hasCrossProjectIntent && (explicitRoots.length > 0 || confirmedExternalRoots.length > 0)
    ? 'cross_project'
    : (explicitRoots.length > 0 || confirmedExternalRoots.length > 0)
      ? 'multi_root'
      : 'single_root'
  const source: TaskScopeDeclaredEvent['source'] = confirmedExternalRoots.length > 0
    ? 'user_confirmation'
    : explicitRoots.length > 0
      ? 'prompt_paths'
      : 'cwd'

  return {
    cwd: resolve(options.cwd),
    primaryRoot,
    explicitRoots,
    confirmedExternalRoots,
    inferredCandidateRoots: [],
    mode,
    source,
  }
}

export function buildTaskScopeDeclaredEvent(options: {
  sessionId: string
  requestId?: string
  cwd: string
  prompt: string
  events?: NexusEvent[]
  allowedPaths?: readonly string[]
  message?: string
}): TaskScopeDeclaredEvent {
  const scope = deriveTaskScope(options)
  return {
    type: 'task_scope_declared',
    ...eventBase(options.sessionId),
    ...(options.requestId && { requestId: options.requestId }),
    ...scope,
    message: options.message ?? buildTaskScopeMessage(scope),
  }
}

export function classifyToolScopeBoundary(options: {
  taskScope: Pick<TaskScopeDeclaredEvent, 'cwd' | 'primaryRoot' | 'explicitRoots' | 'confirmedExternalRoots'>
  toolUseId: string
  toolName: string
  toolInput: unknown
}): ToolScopeBoundary | undefined {
  const targetPaths = extractToolTargetPaths(options.toolName, options.toolInput, options.taskScope.cwd)
  for (const targetPath of targetPaths) {
    const boundary = classifyPathBoundary(options.taskScope, targetPath)
    if (!boundary) continue
    return {
      toolUseId: options.toolUseId,
      toolName: options.toolName,
      ...boundary,
    }
  }
  return undefined
}

export function buildScopeBoundaryDetectedEvent(options: {
  sessionId: string
  requestId?: string
  boundary: ToolScopeBoundary
}): ScopeBoundaryDetectedEvent {
  return {
    type: 'scope_boundary_detected',
    ...eventBase(options.sessionId),
    ...(options.requestId && { requestId: options.requestId }),
    toolUseId: options.boundary.toolUseId,
    toolName: options.boundary.toolName,
    targetRoot: options.boundary.targetRoot,
    taskPrimaryRoot: options.boundary.taskPrimaryRoot,
    boundaryKind: options.boundary.boundaryKind,
    action: options.boundary.action,
    scopeRisk: options.boundary.scopeRisk,
    reason: options.boundary.reason,
    suggestedPrompt: options.boundary.suggestedPrompt,
  }
}

export function buildScopeBoundaryConfirmedEvent(options: {
  sessionId: string
  requestId?: string
  targetRoot: string
  confirmationScope?: ScopeBoundaryConfirmedEvent['confirmationScope']
  confirmedBy?: ScopeBoundaryConfirmedEvent['confirmedBy']
  message?: string
}): ScopeBoundaryConfirmedEvent {
  return {
    type: 'scope_boundary_confirmed',
    ...eventBase(options.sessionId),
    ...(options.requestId && { requestId: options.requestId }),
    targetRoot: options.targetRoot,
    confirmationScope: options.confirmationScope ?? 'once',
    confirmedBy: options.confirmedBy ?? 'user',
    message: options.message ?? `Scope boundary confirmed for external root ${options.targetRoot}.`,
  }
}

export function buildTaskScopeMessage(scope: Pick<TaskScopeDeclaredEvent, 'primaryRoot' | 'explicitRoots' | 'confirmedExternalRoots' | 'mode'>): string {
  const externalRoots = [...scope.explicitRoots, ...scope.confirmedExternalRoots]
  if (externalRoots.length === 0) {
    return `Current task scope is single-root: ${scope.primaryRoot}. Do not inspect sibling projects unless the user explicitly asks or confirms.`
  }
  return `Current task scope is ${scope.mode}: primary=${scope.primaryRoot}; external=${externalRoots.join(', ')}.`
}

export function extractToolTargetPaths(toolName: string, toolInput: unknown, cwd: string): string[] {
  const normalizedToolName = normalizeToolName(toolName)
  if (normalizedToolName === 'bash') {
    return extractBashTargetPaths(extractCommand(toolInput), cwd)
  }
  const record = asRecord(toolInput)
  if (!record) return []
  const keys = TOOL_PATH_KEYS[normalizedToolName] ?? []
  const paths: string[] = []
  for (const key of keys) {
    const value = record[key]
    if (typeof value !== 'string' || !value.trim()) continue
    const target = pathFromPotentialGlob(value.trim())
    if (!target) continue
    paths.push(resolve(cwd, target))
  }
  return uniqueStrings(paths)
}

function classifyPathBoundary(
  taskScope: Pick<TaskScopeDeclaredEvent, 'primaryRoot' | 'explicitRoots' | 'confirmedExternalRoots'>,
  targetPath: string,
): Omit<ToolScopeBoundary, 'toolUseId' | 'toolName'> | undefined {
  const resolvedTarget = resolve(targetPath)
  if (isWithinAnyRoot(resolvedTarget, [taskScope.primaryRoot, ...taskScope.explicitRoots, ...taskScope.confirmedExternalRoots])) {
    return undefined
  }

  const primaryParent = dirname(taskScope.primaryRoot)
  const parentRelation = relative(resolvedTarget, taskScope.primaryRoot)
  if (parentRelation && !parentRelation.startsWith('..') && !isAbsolute(parentRelation)) {
    const targetRoot = resolvedTarget
    return {
      targetRoot,
      taskPrimaryRoot: taskScope.primaryRoot,
      boundaryKind: 'parent_scan',
      action: 'require_confirmation',
      scopeRisk: 'parent_scan',
      reason: `Tool target ${targetRoot} is a parent of current task root ${taskScope.primaryRoot}.`,
      suggestedPrompt: `This would inspect a parent directory outside the current task scope. Confirm whether to include ${targetRoot}.`,
    }
  }

  const siblingRoot = siblingRootForTarget(taskScope.primaryRoot, resolvedTarget)
  if (siblingRoot) {
    return {
      targetRoot: siblingRoot,
      taskPrimaryRoot: taskScope.primaryRoot,
      boundaryKind: 'sibling_repo',
      action: 'require_confirmation',
      scopeRisk: 'sibling_repo',
      reason: `Tool target ${siblingRoot} is a sibling root outside current task root ${taskScope.primaryRoot}.`,
      suggestedPrompt: `This would inspect sibling project ${siblingRoot}. Ask the user to confirm before using it as evidence.`,
    }
  }

  const targetRoot = inferProjectRoot(resolvedTarget)
  const scopeRisk: ScopeBoundaryDetectedEvent['scopeRisk'] = targetRoot.startsWith(resolve(process.env.HOME ?? '', '.babel-o'))
    ? 'global_cache_path'
    : 'outside_current_project'
  return {
    targetRoot,
    taskPrimaryRoot: taskScope.primaryRoot,
    boundaryKind: scopeRisk === 'global_cache_path' ? 'global_cache_path' : 'external_absolute_path',
    action: 'require_confirmation',
    scopeRisk,
    reason: `Tool target ${targetRoot} is outside current task root ${taskScope.primaryRoot}.`,
    suggestedPrompt: `This would inspect external path ${targetRoot}. Confirm whether to include it in the current task scope.`,
  }
}

function confirmedRootsFromEvents(events: NexusEvent[]): string[] {
  return events
    .filter((event): event is ScopeBoundaryConfirmedEvent => event.type === 'scope_boundary_confirmed')
    .map(event => event.targetRoot)
}

function extractBashTargetPaths(command: string, cwd: string): string[] {
  if (!command) return []
  const tokens = tokenizeShellWords(command)
  const paths: string[] = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (!token) continue
    const lower = token.toLowerCase()
    if (lower === 'cd') {
      pushResolvedPath(paths, cwd, tokens[index + 1])
      continue
    }
    if (lower === 'git' && tokens[index + 1] === '-C') {
      pushResolvedPath(paths, cwd, tokens[index + 2])
      index += 2
      continue
    }
    if (lower === 'find' || lower === 'ls' || lower === 'cat' || lower === 'head' || lower === 'tail') {
      pushFirstPathArgument(paths, cwd, tokens, index + 1)
      continue
    }
    if (lower === 'rg' || lower === 'grep') {
      pushLastPathArgument(paths, cwd, tokens, index + 1)
    }
  }
  return uniqueStrings(paths)
}

function pushFirstPathArgument(paths: string[], cwd: string, tokens: string[], start: number): void {
  for (let index = start; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (!token || token.startsWith('-') || isShellOperator(token)) continue
    pushResolvedPath(paths, cwd, token)
    return
  }
}

function pushLastPathArgument(paths: string[], cwd: string, tokens: string[], start: number): void {
  for (let index = tokens.length - 1; index >= start; index -= 1) {
    const token = tokens[index]
    if (!token || token.startsWith('-') || isShellOperator(token)) continue
    if (looksLikeSearchPattern(token)) continue
    pushResolvedPath(paths, cwd, token)
    return
  }
}

function pushResolvedPath(paths: string[], cwd: string, value: string | undefined): void {
  if (!value || isShellOperator(value)) return
  const normalized = pathFromPotentialGlob(value)
  if (!normalized) return
  paths.push(resolve(cwd, normalized))
}

function pathFromPotentialGlob(value: string): string | undefined {
  if (!value || value === '-') return undefined
  const globIndex = value.search(/[*?[{]/)
  const pathValue = globIndex >= 0 ? value.slice(0, globIndex) : value
  const cleaned = pathValue.replace(/[,:;]+$/u, '').replace(/\/$/, '')
  if (!cleaned || cleaned === '.') return '.'
  return cleaned
}

function looksLikeSearchPattern(value: string): boolean {
  return !value.includes('/') && !value.startsWith('.') && !isAbsolute(value) && /[A-Za-z0-9_*?[{]/.test(value)
}

function tokenizeShellWords(command: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  for (let index = 0; index < command.length; index += 1) {
    const ch = command[index]
    if (quote) {
      if (ch === quote) quote = null
      else current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (/\s/.test(ch)) {
      flushToken(tokens, current)
      current = ''
      continue
    }
    if ((ch === '&' && command[index + 1] === '&') || (ch === '|' && command[index + 1] === '|')) {
      flushToken(tokens, current)
      current = ''
      tokens.push(command.slice(index, index + 2))
      index += 1
      continue
    }
    if (ch === ';' || ch === '|') {
      flushToken(tokens, current)
      current = ''
      tokens.push(ch)
      continue
    }
    current += ch
  }
  flushToken(tokens, current)
  return tokens.filter(Boolean)
}

function flushToken(tokens: string[], token: string): void {
  if (token) tokens.push(token)
}

function extractCommand(input: unknown): string {
  if (typeof input === 'string') return input.trim()
  const record = asRecord(input)
  if (!record) return ''
  for (const key of ['command', 'CommandLine', 'cmd']) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function asRecord(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === 'object' ? input as Record<string, unknown> : undefined
}

function isShellOperator(value: string): boolean {
  return value === '&&' || value === '||' || value === ';' || value === '|'
}

function inferProjectRoot(path: string): string {
  let current = resolve(path)
  try {
    if (existsSync(current) && lstatSync(current).isFile()) current = dirname(current)
  } catch {}
  for (;;) {
    if (existsSync(resolve(current, '.git')) || existsSync(resolve(current, 'package.json')) || existsSync(resolve(current, 'go.mod'))) {
      return current
    }
    const parent = dirname(current)
    if (parent === current) return resolve(path)
    current = parent
  }
}

function siblingRootForTarget(primaryRoot: string, targetPath: string): string | undefined {
  const primaryParent = dirname(primaryRoot)
  const relation = relative(primaryParent, targetPath)
  if (!relation || relation.startsWith('..') || isAbsolute(relation)) return undefined
  const firstSegment = relation.split(sep).filter(Boolean)[0]
  if (!firstSegment) return undefined
  const candidate = resolve(primaryParent, firstSegment)
  if (candidate === primaryRoot || isWithinRoot(primaryRoot, candidate)) return undefined
  return candidate
}

function isWithinAnyRoot(path: string, roots: readonly string[]): boolean {
  return roots.some(root => isWithinRoot(root, path))
}

function isWithinRoot(root: string, path: string): boolean {
  const relation = relative(resolve(root), resolve(path))
  return relation === '' || (!!relation && !relation.startsWith('..') && !isAbsolute(relation))
}

function uniqueRoots(paths: string[]): string[] {
  const roots: string[] = []
  for (const path of paths.map(value => resolve(value))) {
    if (roots.some(root => isWithinRoot(root, path))) continue
    roots.push(path)
  }
  return roots
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map(value => resolve(value)))]
}

function normalizeToolName(toolName: string): string {
  return toolName.replace(/[-_\s]/g, '').toLowerCase()
}
