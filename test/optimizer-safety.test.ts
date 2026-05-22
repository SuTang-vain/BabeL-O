import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkOptimizerSafety } from '../src/runtime/safetyCheck.js'
import { LocalCodingRuntime } from '../src/runtime/LocalCodingRuntime.js'
import { createDefaultToolRegistry } from '../src/tools/registry.js'
import { eventBase } from '../src/shared/events.js'

test('checkOptimizerSafety rules', () => {
  // Allowed cases
  assert.deepEqual(checkOptimizerSafety('Write', { path: 'src/app.ts' }, 'optimizer'), { allowed: true })
  assert.deepEqual(checkOptimizerSafety('Write', { path: 'package.json' }, 'executor'), { allowed: true })
  assert.deepEqual(checkOptimizerSafety('Bash', { command: 'npm install' }, 'optimizer'), { allowed: true })

  // Forbidden files
  assert.equal(checkOptimizerSafety('Write', { path: 'package.json' }, 'optimizer').allowed, false)
  assert.equal(checkOptimizerSafety('Write', { path: 'package-lock.json' }, 'optimizer').allowed, false)
  assert.equal(checkOptimizerSafety('Write', { path: 'tsconfig.json' }, 'optimizer').allowed, false)
  assert.equal(checkOptimizerSafety('Write', { path: 'bin/bbl.js' }, 'optimizer').allowed, false)
  assert.equal(checkOptimizerSafety('Write', { path: '.env.development' }, 'optimizer').allowed, false)
  assert.equal(checkOptimizerSafety('Edit', { path: 'package.json' }, 'optimizer').allowed, false)

  // Forbidden commands
  assert.equal(checkOptimizerSafety('Bash', { command: 'rm -rf node_modules' }, 'optimizer').allowed, false)
  assert.equal(checkOptimizerSafety('Bash', { command: 'git push origin main' }, 'optimizer').allowed, false)
  assert.equal(checkOptimizerSafety('Bash', { command: 'npm publish' }, 'optimizer').allowed, false)
  assert.equal(checkOptimizerSafety('Bash', { command: 'sudo rm -f test' }, 'optimizer').allowed, false)
})

test('LocalCodingRuntime blocks forbidden actions under optimizer role', async () => {
  const tools = createDefaultToolRegistry()
  const runtime = new LocalCodingRuntime(tools)

  // Forbidden edit
  const stream = runtime.executeStream({
    sessionId: 'test-session-safety',
    prompt: 'edit package.json "version": "1.0.0" "version": "2.0.0"',
    cwd: process.cwd(),
    role: 'optimizer',
  })

  const events = []
  for await (const event of stream) {
    events.push(event)
  }

  const toolDenied = events.find(e => e.type === 'tool_denied')
  assert.ok(toolDenied)
  assert.match(toolDenied.message, /File modification denied/)

  const result = events.find(e => e.type === 'result')
  assert.ok(result)
  assert.equal(result.success, false)

  // Allowed edit
  const allowedStream = runtime.executeStream({
    sessionId: 'test-session-allowed',
    prompt: 'edit src/nexus/server.ts "const host" "const host"',
    cwd: process.cwd(),
    role: 'optimizer',
    skipPermissionCheck: true,
  })

  const allowedEvents = []
  for await (const event of allowedStream) {
    allowedEvents.push(event)
  }

  // Should not deny
  const deniedEvent = allowedEvents.find(e => e.type === 'tool_denied')
  assert.equal(deniedEvent, undefined)
})
