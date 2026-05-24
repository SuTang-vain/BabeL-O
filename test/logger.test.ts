import { test } from 'node:test'
import assert from 'node:assert/strict'
import { logger } from '../src/shared/logger.js'

test('logger respects NEXUS_LOG_LEVEL=silent', () => {
  const previousLevel = process.env.NEXUS_LOG_LEVEL
  const previousWrite = process.stderr.write
  let output = ''

  process.env.NEXUS_LOG_LEVEL = 'silent'
  process.stderr.write = ((chunk: string | Uint8Array) => {
    output += String(chunk)
    return true
  }) as typeof process.stderr.write

  try {
    logger.error('hidden')
    logger.warn('hidden')
    assert.equal(output, '')
  } finally {
    process.stderr.write = previousWrite
    if (previousLevel === undefined) {
      delete process.env.NEXUS_LOG_LEVEL
    } else {
      process.env.NEXUS_LOG_LEVEL = previousLevel
    }
  }
})

test('logger emits structured json for enabled levels', () => {
  const previousLevel = process.env.NEXUS_LOG_LEVEL
  const previousWrite = process.stderr.write
  let output = ''

  process.env.NEXUS_LOG_LEVEL = 'error'
  process.stderr.write = ((chunk: string | Uint8Array) => {
    output += String(chunk)
    return true
  }) as typeof process.stderr.write

  try {
    logger.error('visible', new Error('boom'))
    const parsed = JSON.parse(output)
    assert.equal(parsed.level, 'error')
    assert.equal(parsed.message, 'visible')
    assert.equal(parsed.meta.message, 'boom')
  } finally {
    process.stderr.write = previousWrite
    if (previousLevel === undefined) {
      delete process.env.NEXUS_LOG_LEVEL
    } else {
      process.env.NEXUS_LOG_LEVEL = previousLevel
    }
  }
})
