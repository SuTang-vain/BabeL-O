import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createDefaultToolRegistry } from '../src/tools/registry.js'
import { buildSystemPromptSections } from '../src/runtime/systemPromptBuilder.js'

describe('Tool prompt()', () => {
  test('every builtin tool has a prompt() that returns non-empty string longer than description', async () => {
    const registry = await createDefaultToolRegistry()
    const tools = [...registry.values()]

    assert.ok(tools.length > 0, 'No tools found in registry')

    for (const tool of tools) {
      assert.ok(typeof tool.prompt === 'function', `Tool ${tool.name} missing prompt()`)
      const promptText = tool.prompt!()
      assert.ok(typeof promptText === 'string' && promptText.length > 0, `Tool ${tool.name} prompt() returned empty`)
      assert.ok(
        promptText.length >= tool.description.length,
        `Tool ${tool.name} prompt() (${promptText.length} chars) shorter than description (${tool.description.length} chars)`,
      )
    }
  })

  test('tool prompt content is distinct from description', async () => {
    const registry = await createDefaultToolRegistry()
    for (const tool of registry.values()) {
      const promptText = tool.prompt!()
      assert.notEqual(
        promptText,
        tool.description,
        `Tool ${tool.name} prompt() is identical to description`,
      )
    }
  })

  test('source inspection guidance discourages Bash sed grep head', async () => {
    const registry = await createDefaultToolRegistry()
    const bashPrompt = registry.get('Bash')!.prompt!()
    const readPrompt = registry.get('Read')!.prompt!()
    const grepPrompt = registry.get('Grep')!.prompt!()
    const listDirPrompt = registry.get('ListDir')!.prompt!()

    assert.match(bashPrompt, /Do NOT use Bash for ordinary source code reading/)
    assert.match(bashPrompt, /sed -n/)
    assert.match(bashPrompt, /grep \| head/)
    assert.match(bashPrompt, /Read with lineOffset\/lineLimit/)
    assert.match(bashPrompt, /Grep to locate text/)
    assert.match(bashPrompt, /ListDir for directory inventory/)
    assert.match(bashPrompt, /WebSearch for public web lookups/)
    assert.match(bashPrompt, /TaskCreate for structured progress tracking/)

    assert.match(readPrompt, /Prefer Read over Bash cat, sed -n, head, or tail/)
    assert.match(grepPrompt, /prefer it over Bash grep, rg, or grep \| head/)
    assert.match(listDirPrompt, /pair ListDir with Grep and Read instead of Bash sed\/head\/grep pipelines/)
  })

  test('system prompt pins source inspection tool boundaries', () => {
    const toolUsage = buildSystemPromptSections({
      cwd: '/tmp/test',
      platform: 'darwin',
    }).find(section => section.id === 'tool_usage')

    assert.ok(toolUsage)
    assert.match(toolUsage!.content, /ordinary source code inspection/)
    assert.match(toolUsage!.content, /do NOT use Bash commands such as sed, head, grep, rg, or shell pipelines/)
    assert.match(toolUsage!.content, /use Grep instead of grep, rg, or grep \| head/)
    assert.match(toolUsage!.content, /use Read instead of cat, sed -n, head, or tail/)
    assert.match(toolUsage!.content, /use WebSearch/)
    assert.match(toolUsage!.content, /Do not send secrets, private code, credentials, tokens, or confidential user data to WebSearch/)
    assert.match(toolUsage!.content, /use TaskCreate/)
  })
})
