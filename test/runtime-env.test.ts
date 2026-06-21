import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseRuntimeEnv } from '../src/runtime/env.js'

function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...overrides }
}

test('parseRuntimeEnv returns defaults when env is empty', () => {
  const runtimeEnv = parseRuntimeEnv(env(), '/home/test')
  assert.equal(runtimeEnv.nexus.host, '127.0.0.1')
  assert.equal(runtimeEnv.nexus.port, 3000)
  assert.equal(runtimeEnv.nexus.maxConcurrentExecutions, 8)
  assert.equal(runtimeEnv.nexus.maxToolOutputBytes, 200_000)
  assert.equal(runtimeEnv.nexus.bashMaxBufferBytes, 1_000_000)
  assert.equal(runtimeEnv.nexus.defaultPolicyMode, 'strict')
  assert.equal(runtimeEnv.nexus.enableMcp, false)
  assert.equal(runtimeEnv.nexus.enableAgentTools, false)
  assert.equal(runtimeEnv.nexus.apiKey, undefined)
  assert.equal(runtimeEnv.nexus.executeTimeoutMs, undefined)
  assert.equal(runtimeEnv.nexus.storagePath, undefined)
  assert.equal(runtimeEnv.nexus.allowedTools, undefined)
  assert.equal(runtimeEnv.nexus.agentExecutionEnvironment, undefined)
})

test('parseRuntimeEnv reads NEXUS_HOST / NEXUS_PORT', () => {
  const runtimeEnv = parseRuntimeEnv(
    env({ NEXUS_HOST: '0.0.0.0', NEXUS_PORT: '8080' }),
    '/home/test',
  )
  assert.equal(runtimeEnv.nexus.host, '0.0.0.0')
  assert.equal(runtimeEnv.nexus.port, 8080)
})

test('parseRuntimeEnv reads NEXUS_API_KEY through to apiKey field', () => {
  const runtimeEnv = parseRuntimeEnv(
    env({ NEXUS_API_KEY: 'secret-key' }),
    '/home/test',
  )
  assert.equal(runtimeEnv.nexus.apiKey, 'secret-key')
})

test('parseRuntimeEnv reads NEXUS_EXECUTE_TIMEOUT_MS as positive int', () => {
  const runtimeEnv = parseRuntimeEnv(
    env({ NEXUS_EXECUTE_TIMEOUT_MS: '30000' }),
    '/home/test',
  )
  assert.equal(runtimeEnv.nexus.executeTimeoutMs, 30000)
})

test('parseRuntimeEnv throws on non-positive NEXUS_EXECUTE_TIMEOUT_MS', () => {
  assert.throws(
    () => parseRuntimeEnv(env({ NEXUS_EXECUTE_TIMEOUT_MS: '0' }), '/home/test'),
    /positive integer/,
  )
  assert.throws(
    () => parseRuntimeEnv(env({ NEXUS_EXECUTE_TIMEOUT_MS: '-5' }), '/home/test'),
    /positive integer/,
  )
  assert.throws(
    () => parseRuntimeEnv(env({ NEXUS_EXECUTE_TIMEOUT_MS: 'abc' }), '/home/test'),
    /positive integer/,
  )
})

test('parseRuntimeEnv reads NEXUS_MAX_CONCURRENT_EXECUTIONS with default 8', () => {
  const def = parseRuntimeEnv(env(), '/home/test')
  assert.equal(def.nexus.maxConcurrentExecutions, 8)
  const overridden = parseRuntimeEnv(
    env({ NEXUS_MAX_CONCURRENT_EXECUTIONS: '16' }),
    '/home/test',
  )
  assert.equal(overridden.nexus.maxConcurrentExecutions, 16)
})

test('parseRuntimeEnv reads NEXUS_ALLOWED_TOOLS as comma-separated list', () => {
  const def = parseRuntimeEnv(env(), '/home/test')
  assert.equal(def.nexus.allowedTools, undefined)
  const single = parseRuntimeEnv(env({ NEXUS_ALLOWED_TOOLS: 'bash' }), '/home/test')
  assert.deepEqual(single.nexus.allowedTools, ['bash'])
  const many = parseRuntimeEnv(
    env({ NEXUS_ALLOWED_TOOLS: 'bash, read, grep' }),
    '/home/test',
  )
  assert.deepEqual(many.nexus.allowedTools, ['bash', 'read', 'grep'])
})

test('parseRuntimeEnv reads NEXUS_STORAGE_WAL_* into storageWal', () => {
  const runtimeEnv = parseRuntimeEnv(
    env({
      NEXUS_STORAGE_WAL_BATCH_SIZE: '50',
      NEXUS_STORAGE_WAL_FLUSH_INTERVAL_MS: '500',
      NEXUS_STORAGE_WAL_FSYNC: '1',
    }),
    '/home/test',
  )
  assert.equal(runtimeEnv.nexus.storageWal.batchSize, 50)
  assert.equal(runtimeEnv.nexus.storageWal.flushIntervalMs, 500)
  assert.equal(runtimeEnv.nexus.storageWal.fsync, true)
})

test('parseRuntimeEnv reads NEXUS_DEFAULT_POLICY_MODE strict and soft-deny', () => {
  const strict = parseRuntimeEnv(env({ NEXUS_DEFAULT_POLICY_MODE: 'strict' }), '/home/test')
  assert.equal(strict.nexus.defaultPolicyMode, 'strict')
  const soft = parseRuntimeEnv(env({ NEXUS_DEFAULT_POLICY_MODE: 'soft-deny' }), '/home/test')
  assert.equal(soft.nexus.defaultPolicyMode, 'soft-deny')
})

test('parseRuntimeEnv throws on invalid NEXUS_DEFAULT_POLICY_MODE', () => {
  assert.throws(
    () => parseRuntimeEnv(env({ NEXUS_DEFAULT_POLICY_MODE: 'invalid' }), '/home/test'),
    /must be one of "strict" or "soft-deny"/,
  )
})

test('parseRuntimeEnv reads BABEL_O_ENABLE_MCP / ENABLE_AGENT_TOOLS as boolean', () => {
  const def = parseRuntimeEnv(env(), '/home/test')
  assert.equal(def.nexus.enableMcp, false)
  assert.equal(def.nexus.enableAgentTools, false)
  const on = parseRuntimeEnv(
    env({ BABEL_O_ENABLE_MCP: '1', BABEL_O_ENABLE_AGENT_TOOLS: '1' }),
    '/home/test',
  )
  assert.equal(on.nexus.enableMcp, true)
  assert.equal(on.nexus.enableAgentTools, true)
})

test('parseRuntimeEnv reads NEXUS_AGENT_EXECUTION_ENVIRONMENT local and remote', () => {
  const local = parseRuntimeEnv(
    env({ NEXUS_AGENT_EXECUTION_ENVIRONMENT: 'local' }),
    '/home/test',
  )
  assert.equal(local.nexus.agentExecutionEnvironment, 'local')
  const remote = parseRuntimeEnv(
    env({ NEXUS_AGENT_EXECUTION_ENVIRONMENT: 'remote' }),
    '/home/test',
  )
  assert.equal(remote.nexus.agentExecutionEnvironment, 'remote')
})

test('parseRuntimeEnv throws on invalid NEXUS_AGENT_EXECUTION_ENVIRONMENT', () => {
  assert.throws(
    () => parseRuntimeEnv(env({ NEXUS_AGENT_EXECUTION_ENVIRONMENT: 'invalid' }), '/home/test'),
    /'local' or 'remote'/,
  )
})

test('parseRuntimeEnv reads BABEL_O_WORKSPACE into workspace.cwd', () => {
  const runtimeEnv = parseRuntimeEnv(env({ BABEL_O_WORKSPACE: '/tmp/work' }), '/home/test')
  assert.equal(runtimeEnv.workspace.cwd, '/tmp/work')
})

test('parseRuntimeEnv resolves workspace.configDir from BABEL_O_CONFIG_DIR', () => {
  const runtimeEnv = parseRuntimeEnv(
    env({ BABEL_O_CONFIG_DIR: '/etc/babel-o' }),
    '/home/test',
  )
  assert.equal(runtimeEnv.workspace.configDir, '/etc/babel-o')
})

test('parseRuntimeEnv resolves workspace.configDir from BABEL_O_CONFIG_FILE dirname', () => {
  const runtimeEnv = parseRuntimeEnv(
    env({ BABEL_O_CONFIG_FILE: '/etc/babel-o/config.json' }),
    '/home/test',
  )
  assert.equal(runtimeEnv.workspace.configDir, '/etc/babel-o')
})

test('parseRuntimeEnv falls back to homeDir/.babel-o when no configDir env vars set', () => {
  const runtimeEnv = parseRuntimeEnv(env(), '/home/test')
  assert.equal(runtimeEnv.workspace.configDir, '/home/test/.babel-o')
})
