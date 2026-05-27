import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createDefaultToolRegistry } from '../src/tools/registry.js'

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
})
