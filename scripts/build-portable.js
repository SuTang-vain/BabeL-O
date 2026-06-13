#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageJson = JSON.parse(await import('node:fs/promises').then(fs => fs.readFile(join(repoRoot, 'package.json'), 'utf8')))

const args = parseArgs(process.argv.slice(2))
const platform = args.platform ?? process.platform
const arch = args.arch ?? process.arch
const suffix = platformSuffix(platform, arch)
const packageSuffix = suffix.replace(/\.exe$/, '')
const smokeMode = args.smoke ?? 'full'
const version = packageJson.version
const portableName = `babel-o-v${version}-${packageSuffix}`
const portableRoot = resolve(repoRoot, 'dist', 'portable')
const stageRoot = join(portableRoot, portableName)
const output = resolve(repoRoot, args.out ?? join('dist', `${assetNameForSuffix(suffix)}.tar.gz`))
const goTuiPath = resolve(repoRoot, args.goTui ?? join('clients', 'go-tui', 'bin', defaultGoTuiBinaryName(platform)))

if (!existsSync(join(repoRoot, 'dist', 'cli', 'program.js'))) {
  throw new Error('dist/cli/program.js is missing. Run `npm run build` before building a portable package.')
}
if (!existsSync(goTuiPath)) {
  throw new Error(`Go TUI binary is missing: ${goTuiPath}. Run \`cd clients/go-tui && make build\` first.`)
}

rmSync(stageRoot, { recursive: true, force: true })
mkdirSync(stageRoot, { recursive: true })
mkdirSync(join(stageRoot, 'bin'), { recursive: true })

writeRuntimePackageJson(stageRoot)
copyRuntimeTree(stageRoot, suffix, goTuiPath)
installProductionDependencies(stageRoot)
writeLaunchers(stageRoot)
archivePortable(stageRoot, output)
smokePortable(stageRoot, smokeMode)

console.log(JSON.stringify({
  type: 'portable_bundle',
  version,
  platform,
  arch,
  suffix,
  packageSuffix,
  smokeMode,
  output,
  bytes: statSync(output).size,
}, null, 2))

function parseArgs(values) {
  const parsed = {}
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]
    if (value.startsWith('--platform=')) parsed.platform = value.slice('--platform='.length)
    else if (value === '--platform') parsed.platform = values[++index]
    else if (value.startsWith('--arch=')) parsed.arch = value.slice('--arch='.length)
    else if (value === '--arch') parsed.arch = values[++index]
    else if (value.startsWith('--go-tui=')) parsed.goTui = value.slice('--go-tui='.length)
    else if (value === '--go-tui') parsed.goTui = values[++index]
    else if (value.startsWith('--out=')) parsed.out = value.slice('--out='.length)
    else if (value === '--out') parsed.out = values[++index]
    else if (value.startsWith('--smoke=')) parsed.smoke = value.slice('--smoke='.length)
    else if (value === '--smoke') parsed.smoke = values[++index]
    else throw new Error(`Unknown argument: ${value}`)
  }
  if (parsed.smoke !== undefined && !['full', 'basic', 'none'].includes(parsed.smoke)) {
    throw new Error(`Unsupported --smoke mode: ${parsed.smoke}`)
  }
  return parsed
}

function writeRuntimePackageJson(targetRoot) {
  const runtimePackage = {
    name: packageJson.name,
    version,
    description: packageJson.description,
    type: packageJson.type,
    private: true,
    bin: packageJson.bin,
    engines: packageJson.engines,
    dependencies: packageJson.dependencies,
    optionalDependencies: packageJson.optionalDependencies,
  }
  writeFileSync(join(targetRoot, 'package.json'), `${JSON.stringify(runtimePackage, null, 2)}\n`)
  copyFileSync(join(repoRoot, 'package-lock.json'), join(targetRoot, 'package-lock.json'))
}

function copyRuntimeTree(targetRoot, suffix, goTuiBinary) {
  const distSource = join(repoRoot, 'dist')
  const distTarget = join(targetRoot, 'dist')
  mkdirSync(distTarget, { recursive: true })
  for (const entry of readdirSync(distSource)) {
    if (shouldSkipDistEntry(entry)) continue
    cpSync(join(distSource, entry), join(distTarget, entry), { recursive: true })
  }
  cpSync(join(repoRoot, 'bin', 'bbl.js'), join(targetRoot, 'bin', 'bbl.js'))
  chmodSync(join(targetRoot, 'bin', 'bbl.js'), 0o755)
  copyFileSync(goTuiBinary, join(targetRoot, 'bin', `go-tui-${suffix}`))
  chmodSync(join(targetRoot, 'bin', `go-tui-${suffix}`), 0o755)
  copyFileSync(join(repoRoot, 'LICENSE'), join(targetRoot, 'LICENSE'))
  copyFileSync(join(repoRoot, 'README.md'), join(targetRoot, 'README.md'))
  if (existsSync(join(repoRoot, 'README.zh-CN.md'))) {
    copyFileSync(join(repoRoot, 'README.zh-CN.md'), join(targetRoot, 'README.zh-CN.md'))
  }
}

function shouldSkipDistEntry(name) {
  const isReleaseArchive = /^bbl-[A-Za-z0-9.-]+\.tar\.gz$/.test(name)
  const isGoTuiMirror = name === 'go-tui'
  return name === 'bbl' ||
    name === 'bbl.exe' ||
    name === 'bbl-bundled.mjs' ||
    name === 'sea-config.json' ||
    name === 'portable' ||
    isReleaseArchive ||
    isGoTuiMirror
}

function installProductionDependencies(targetRoot) {
  execFileSync('npm', ['ci', '--omit=dev', '--no-audit', '--fund=false'], {
    cwd: targetRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      NODE_ENV: 'production',
    },
  })
}

function writeLaunchers(targetRoot) {
  const shellLauncher = `#!/bin/sh
set -eu
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
exec node "$SCRIPT_DIR/bbl.js" "$@"
`
  writeFileSync(join(targetRoot, 'bin', 'bbl'), shellLauncher)
  chmodSync(join(targetRoot, 'bin', 'bbl'), 0o755)

  const cmdLauncher = `@echo off\r\nnode "%~dp0\\bbl.js" %*\r\n`
  writeFileSync(join(targetRoot, 'bin', 'bbl.cmd'), cmdLauncher)
}

function archivePortable(targetRoot, outputPath) {
  mkdirSync(dirname(outputPath), { recursive: true })
  rmSync(outputPath, { force: true })
  execFileSync('tar', ['-czf', outputPath, '-C', dirname(targetRoot), basename(targetRoot)], {
    stdio: 'inherit',
  })
}

function smokePortable(targetRoot, mode) {
  if (mode === 'none') return
  const versionOutput = execFileSync(process.execPath, [join(targetRoot, 'bin', 'bbl.js'), '--version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
  if (!versionOutput.includes(version)) {
    throw new Error(`Portable bbl --version returned ${JSON.stringify(versionOutput)}, expected ${version}.`)
  }
  if (mode === 'basic') return

  const checkOutput = execFileSync(
    process.execPath,
    [
      join(targetRoot, 'bin', 'bbl.js'),
      'go',
      '--check',
      '--no-start-nexus',
      '--url',
      'http://127.0.0.1:9',
    ],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  if (!/Result: OK/.test(checkOutput)) {
    throw new Error(`Portable bbl go --check did not pass:\n${checkOutput}`)
  }
}

function platformSuffix(platform, arch) {
  if (platform === 'darwin') return arch === 'x64' ? 'darwin-x64' : 'darwin-arm64'
  if (platform === 'linux') return arch === 'arm64' ? 'linux-arm64' : 'linux-x64'
  if (platform === 'win32' || platform === 'windows') return 'windows-x64.exe'
  throw new Error(`Unsupported portable platform: ${platform}`)
}

function assetNameForSuffix(suffix) {
  return `bbl-${suffix.replace(/\.exe$/, '')}`
}

function defaultGoTuiBinaryName(platform) {
  return platform === 'win32' || platform === 'windows' ? 'go-tui.exe' : 'go-tui'
}
