import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  buildEverOSSourceWithPip,
  detectPipFallbackAvailability,
} from '../src/cli/everosFallbackBuild.js'

function makeTempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'babel-o-fallback-build-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('detectPipFallbackAvailability: returns true when python3 -m venv --help exits 0', async () => {
  const runner = async (command: string) => {
    if (command === 'python3') return Promise.resolve({ code: 0, stdout: 'usage: venv', stderr: '' })
    return Promise.resolve({ code: 127, stdout: '', stderr: 'not found' })
  }
  const result = await detectPipFallbackAvailability(runner)
  assert.equal(result.available, true)
})

test('detectPipFallbackAvailability: returns false with reason when venv is missing', async () => {
  const runner = async (command: string) => {
    return Promise.resolve({ code: 1, stdout: '', stderr: 'No module named venv' })
  }
  const result = await detectPipFallbackAvailability(runner)
  assert.equal(result.available, false)
  assert.match(result.reason ?? '', /venv/)
})

test('buildEverOSSourceWithPip: creates venv when missing, then installs requirements.txt', async () => {
  const { dir, cleanup } = makeTempDir()
  try {
    writeFileSync(join(dir, 'requirements.txt'), 'requests==2.31.0\n', 'utf8')
    const calls: string[] = []
    const runner = async (command: string, args: string[]) => {
      calls.push(`${command} ${args.join(' ')}`)
      if (command === 'python3' && args[0] === '-m' && args[1] === 'venv') {
        // Simulate venv creation by writing the pip script
        // into a plausible location.
        const path = await import('node:path')
        const fs = await import('node:fs')
        const venvDir = args[2]!
        const isWindows = process.platform === 'win32'
        const pip = isWindows
          ? path.join(venvDir, 'Scripts', 'pip.exe')
          : path.join(venvDir, 'bin', 'pip')
        fs.mkdirSync(path.dirname(pip), { recursive: true })
        fs.writeFileSync(pip, '#!/bin/sh\n', 'utf8')
        return { code: 0, stdout: '', stderr: '' }
      }
      return { code: 0, stdout: 'success', stderr: '' }
    }
    const result = await buildEverOSSourceWithPip({ runner, sourceDir: dir })
    assert.equal(result.ok, true)
    assert.ok(calls.some(c => c.includes('python3 -m venv')))
    // The pip command is invoked with a full path to the venv
    // binary plus an absolute path to requirements.txt, so we
    // assert on the basename + action instead of the full path.
    assert.ok(
      calls.some(c => c.endsWith('pip install -r ' + join(dir, 'requirements.txt'))),
      `expected pip install -r requirements.txt, calls=${JSON.stringify(calls)}`,
    )
  } finally {
    cleanup()
  }
})

test('buildEverOSSourceWithPip: fails when pip is not produced in the venv', async () => {
  const { dir, cleanup } = makeTempDir()
  try {
    const runner = async (command: string) => {
      if (command === 'python3') return Promise.resolve({ code: 0, stdout: '', stderr: '' })
      return Promise.resolve({ code: 0, stdout: '', stderr: '' })
    }
    const result = await buildEverOSSourceWithPip({ runner, sourceDir: dir })
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.match(result.errorMessage, /pip not found/)
  } finally {
    cleanup()
  }
})

test('buildEverOSSourceWithPip: prefers pyproject.toml when no requirements.txt is present', async () => {
  const { dir, cleanup } = makeTempDir()
  try {
    writeFileSync(join(dir, 'pyproject.toml'), '[project]\nname = "demo"\n', 'utf8')
    const calls: string[] = []
    const runner = async (command: string, args: string[]) => {
      calls.push(`${command} ${args.join(' ')}`)
      if (command === 'python3' && args[0] === '-m' && args[1] === 'venv') {
        const path = await import('node:path')
        const fs = await import('node:fs')
        const venvDir = args[2]!
        const isWindows = process.platform === 'win32'
        const pip = isWindows
          ? path.join(venvDir, 'Scripts', 'pip.exe')
          : path.join(venvDir, 'bin', 'pip')
        fs.mkdirSync(path.dirname(pip), { recursive: true })
        fs.writeFileSync(pip, '#!/bin/sh\n', 'utf8')
      }
      return { code: 0, stdout: 'ok', stderr: '' }
    }
    const result = await buildEverOSSourceWithPip({ runner, sourceDir: dir })
    assert.equal(result.ok, true)
    assert.ok(calls.some(c => c.includes('pip install .')))
    assert.ok(!calls.some(c => c.includes('-r requirements.txt')))
  } finally {
    cleanup()
  }
})

test('buildEverOSSourceWithPip: returns clear error when neither requirements.txt nor pyproject.toml is present', async () => {
  const { dir, cleanup } = makeTempDir()
  try {
    const runner = async (command: string) => {
      if (command === 'python3') {
        const path = await import('node:path')
        const fs = await import('node:fs')
        const venvDir = path.join(dir, '.venv')
        const isWindows = process.platform === 'win32'
        const pip = isWindows
          ? path.join(venvDir, 'Scripts', 'pip.exe')
          : path.join(venvDir, 'bin', 'pip')
        fs.mkdirSync(path.dirname(pip), { recursive: true })
        fs.writeFileSync(pip, '#!/bin/sh\n', 'utf8')
        return { code: 0, stdout: '', stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    }
    const result = await buildEverOSSourceWithPip({ runner, sourceDir: dir })
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.match(result.errorMessage, /requirements.txt or pyproject.toml/)
  } finally {
    cleanup()
  }
})

test('buildEverOSSourceWithPip: surfaces pip install failure with stderr context', async () => {
  const { dir, cleanup } = makeTempDir()
  try {
    writeFileSync(join(dir, 'requirements.txt'), 'nonexistent-pkg==99.99.99\n', 'utf8')
    const runner = async (command: string) => {
      if (command === 'python3') {
        const path = await import('node:path')
        const fs = await import('node:fs')
        const venvDir = path.join(dir, '.venv')
        const isWindows = process.platform === 'win32'
        const pip = isWindows
          ? path.join(venvDir, 'Scripts', 'pip.exe')
          : path.join(venvDir, 'bin', 'pip')
        fs.mkdirSync(path.dirname(pip), { recursive: true })
        fs.writeFileSync(pip, '#!/bin/sh\n', 'utf8')
        return { code: 0, stdout: '', stderr: '' }
      }
      if (command.endsWith('pip') || command.endsWith('pip.exe')) {
        return { code: 1, stdout: '', stderr: 'ERROR: Could not find a version that satisfies the requirement' }
      }
      return { code: 0, stdout: '', stderr: '' }
    }
    const result = await buildEverOSSourceWithPip({ runner, sourceDir: dir })
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.match(result.errorMessage, /Could not find a version/)
  } finally {
    cleanup()
  }
})
