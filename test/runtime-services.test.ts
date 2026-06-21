import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ConfigManager } from '../src/shared/config.js'
import { ContextBroadcaster } from '../src/nexus/contextBroadcaster.js'
import { EverCoreRuntimeManager } from '../src/nexus/everCoreRuntimeManager.js'
import { ProviderSessionRules } from '../src/runtime/providerSessionRules.js'
import { parseRuntimeEnv } from '../src/runtime/env.js'
import { createRuntimeServices, type RuntimeServices } from '../src/nexus/services.js'

function makeFakeConfigManager(): ConfigManager {
  return new ConfigManager({ configFile: '/tmp/babel-o-test-config.json' })
}

test('createRuntimeServices returns a container with all 5 fields', () => {
  const services = createRuntimeServices({
    configManager: makeFakeConfigManager(),
    processEnv: {},
    homeDir: '/home/test',
  })
  assert.ok(services.configManager)
  assert.ok(services.contextBroadcaster)
  assert.ok(services.everCoreManager)
  assert.ok(services.providerSessionRules)
  assert.ok(services.env)
  assert.equal(services.env.nexus.host, '127.0.0.1')
})

test('createRuntimeServices uses caller-provided configManager (no getInstance() reach-through)', () => {
  const cm = makeFakeConfigManager()
  const services = createRuntimeServices({ configManager: cm, processEnv: {}, homeDir: '/home/test' })
  assert.equal(services.configManager, cm)
})

test('createRuntimeServices uses caller-provided contextBroadcaster', () => {
  const cb = new ContextBroadcaster()
  const services = createRuntimeServices({
    configManager: makeFakeConfigManager(),
    contextBroadcaster: cb,
    processEnv: {},
    homeDir: '/home/test',
  })
  assert.equal(services.contextBroadcaster, cb)
})

test('createRuntimeServices uses caller-provided everCoreManager', () => {
  const ecm = new EverCoreRuntimeManager()
  const services = createRuntimeServices({
    configManager: makeFakeConfigManager(),
    everCoreManager: ecm,
    processEnv: {},
    homeDir: '/home/test',
  })
  assert.equal(services.everCoreManager, ecm)
})

test('createRuntimeServices uses caller-provided providerSessionRules', () => {
  const psr = new ProviderSessionRules()
  const services = createRuntimeServices({
    configManager: makeFakeConfigManager(),
    providerSessionRules: psr,
    processEnv: {},
    homeDir: '/home/test',
  })
  assert.equal(services.providerSessionRules, psr)
})

test('createRuntimeServices uses caller-provided env (no re-parse of processEnv)', () => {
  const env = parseRuntimeEnv({}, '/home/test')
  const services = createRuntimeServices({
    configManager: makeFakeConfigManager(),
    env,
    processEnv: { NEXUS_HOST: 'should-not-be-used.example' },
    homeDir: '/home/test',
  })
  assert.equal(services.env, env)
  assert.equal(services.env.nexus.host, '127.0.0.1')
})

test('createRuntimeServices with no overrides falls back to legacy defaults (configManager + everCoreManager are process-shared)', () => {
  const a: RuntimeServices = createRuntimeServices({ processEnv: {}, homeDir: '/home/test' })
  const b: RuntimeServices = createRuntimeServices({ processEnv: {}, homeDir: '/home/test' })
  // ConfigManager.getInstance() returns the same instance
  assert.equal(a.configManager, b.configManager)
  // defaultEverCoreRuntimeManager is module-shared
  assert.equal(a.everCoreManager, b.everCoreManager)
  // contextBroadcaster + providerSessionRules are fresh per call (no module-level state)
  assert.notEqual(a.contextBroadcaster, b.contextBroadcaster)
  assert.notEqual(a.providerSessionRules, b.providerSessionRules)
})

test('createRuntimeServices parses processEnv when env not provided', () => {
  const services = createRuntimeServices({
    configManager: makeFakeConfigManager(),
    processEnv: { NEXUS_HOST: '0.0.0.0', NEXUS_PORT: '9000' },
    homeDir: '/home/test',
  })
  assert.equal(services.env.nexus.host, '0.0.0.0')
  assert.equal(services.env.nexus.port, 9000)
})
