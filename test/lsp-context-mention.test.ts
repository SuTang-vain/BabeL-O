import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { makeCompleter } from '../src/cli/completer.js'
import {
  completeLspContextMention,
  LSP_CONTEXT_INDEX_LIMIT,
  WorkspaceLspContextIndex,
} from '../src/cli/lspContextMention.js'

async function createFixture() {
  const cwd = join(tmpdir(), `babel-o-lsp-context-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  await mkdir(join(cwd, 'src', 'runtime'), { recursive: true })
  await mkdir(join(cwd, 'node_modules', 'ignored'), { recursive: true })
  await writeFile(join(cwd, 'src', 'runtime', 'contextForker.ts'), [
    'export class ContextForker {',
    '  forkContext() { return true }',
    '}',
    'export interface ContextForkOptions { mode: string }',
    'export function buildContextForker() { return new ContextForker() }',
    '// TODO: expose richer LSP diagnostics when a real server is configured',
    '',
  ].join('\n'), 'utf8')
  await writeFile(join(cwd, 'src', 'runtime', 'agentLoop.go'), [
    'package runtime',
    'func runAgentLoop() {}',
    'type AgentJob struct {}',
    '// FIXME: preserve worktree recovery metadata',
    '',
  ].join('\n'), 'utf8')
  await writeFile(join(cwd, 'node_modules', 'ignored', 'ignored.ts'), 'export class IgnoredSymbol {}\n', 'utf8')
  return cwd
}

test('WorkspaceLspContextIndex lazily completes @symbol mentions with semantic references', async () => {
  const cwd = await createFixture()
  const index = new WorkspaceLspContextIndex(cwd)

  assert.equal(index.built, false)
  const completion = completeLspContextMention('inspect @symbol:ContextForker', cwd, index)

  assert.ok(completion)
  assert.equal(completion!.substring, '@symbol:ContextForker')
  assert.ok(completion!.hits.includes('@symbol:src/runtime/contextForker.ts#ContextForker'))
  assert.ok(completion!.hits.includes('@symbol:src/runtime/contextForker.ts#buildContextForker'))
  assert.equal(index.built, true)
  assert.ok(index.symbolCount > 0)
})

test('LSP context mention supports diagnostics and skips dependency trees', async () => {
  const cwd = await createFixture()
  const index = new WorkspaceLspContextIndex(cwd)

  const diagnostics = completeLspContextMention('fix @diagnostic:worktree', cwd, index)
  const ignored = completeLspContextMention('inspect @symbol:IgnoredSymbol', cwd, index)

  assert.ok(diagnostics)
  assert.deepEqual(diagnostics!.hits, ['@diagnostic:src/runtime/agentLoop.go:4'])
  assert.ok(ignored)
  assert.deepEqual(ignored!.hits, [])
  assert.equal(index.diagnosticCount, 2)
})

test('makeCompleter returns LSP context references before path mentions', async () => {
  const cwd = await createFixture()
  const completer = makeCompleter(cwd)

  const symbolCompletion = completer('inspect @symbol:AgentJob') as [string[], string]
  const diagnosticCompletion = completer('fix @diag:TODO') as [string[], string]
  const pathCompletion = completer('inspect @contextForker') as [string[], string]

  assert.equal(symbolCompletion[1], '@symbol:AgentJob')
  assert.deepEqual(symbolCompletion[0], ['@symbol:src/runtime/agentLoop.go#AgentJob'])
  assert.equal(diagnosticCompletion[1], '@diag:TODO')
  assert.deepEqual(diagnosticCompletion[0], ['@diagnostic:src/runtime/contextForker.ts:6'])
  assert.equal(pathCompletion[1], '@contextForker')
  assert.deepEqual(pathCompletion[0], ['@src/runtime/contextForker.ts'])
})

test('LSP context mention aliases and limits entries', async () => {
  const cwd = await createFixture()
  const index = new WorkspaceLspContextIndex(cwd, { maxEntries: 1, scanBudgetMs: 1000 })

  const symbols = completeLspContextMention('inspect @sym:', cwd, index)
  const diagnostics = completeLspContextMention('fix @diag:', cwd, index)
  const pathMention = completeLspContextMention('inspect @src/runtime/contextForker.ts', cwd, index)
  const url = completeLspContextMention('see https://example.com/@symbol:Foo', cwd, index)

  assert.ok(symbols)
  assert.ok(symbols!.hits.length + diagnostics!.hits.length <= 1)
  assert.equal(pathMention, undefined)
  assert.equal(url, undefined)
  assert.equal(LSP_CONTEXT_INDEX_LIMIT, 10_000)
})
