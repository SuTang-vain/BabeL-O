import { spawnSync } from 'node:child_process'
import {
  writeFileSync,
  mkdirSync,
  existsSync,
  rmSync,
  chmodSync,
  readFileSync,
  createWriteStream,
} from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const distDir = join(root, 'dist')

function runCommand(command, args) {
  console.log(`Running: ${command} ${args.join(' ')}`)
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    shell: true,
  })
  if (result.status !== 0) {
    if (result.error) throw result.error
    throw new Error(`Command failed: ${command} ${args.join(' ')} with exit code ${result.status}`)
  }
}

function hasSentinel(binaryPath) {
  try {
    console.log(`Checking if base binary ${binaryPath} contains the SEA sentinel...`)
    const buffer = readFileSync(binaryPath)
    return buffer.includes('NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2')
  } catch (err) {
    console.error(`Error reading sentinel from ${binaryPath}:`, err)
    return false
  }
}

async function getFallbackVersion(version) {
  try {
    const cleanVersion = version.startsWith('v') ? version : `v${version}`
    const major = cleanVersion.split('.')[0]

    console.log(`Querying Node.js release index for fallback version in major line ${major}...`)
    const res = await fetch('https://nodejs.org/dist/index.json')
    if (!res.ok) {
      console.warn(`Failed to fetch Node.js release index: ${res.status}`)
      return null
    }

    const list = await res.json()
    // Find the latest in the same major version
    const matches = list.filter(item => item.version.startsWith(major + '.'))
    if (matches.length > 0) {
      console.log(`Found matching version in index: ${matches[0].version}`)
      return matches[0].version
    }

    // Fallback to latest LTS
    const ltsMatch = list.find(item => item.lts)
    if (ltsMatch) {
      console.log(`Using fallback LTS version: ${ltsMatch.version}`)
      return ltsMatch.version
    }

    if (list.length > 0) {
      console.log(`Using fallback latest version: ${list[0].version}`)
      return list[0].version
    }
  } catch (err) {
    console.warn(`Failed to fetch fallback version: ${err.message}`)
  }
  return null
}

async function downloadOfficialNode(version, platform, arch, versionDir) {
  const isWin = platform === 'win32'
  const ext = isWin ? '' : (platform === 'darwin' ? '.tar.gz' : '.tar.xz')
  const archiveName = isWin ? 'node.exe' : `node-${version}-${platform}-${arch}${ext}`

  const url = isWin
    ? `https://nodejs.org/dist/${version}/win-${arch}/node.exe`
    : `https://nodejs.org/dist/${version}/${archiveName}`

  console.log(`Downloading official Node.js binary from ${url}...`)

  const archivePath = join(versionDir, archiveName)
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`Failed to download official Node.js from ${url}: Status ${res.status} ${res.statusText}`)
  }

  const fileStream = createWriteStream(archivePath)
  await pipeline(Readable.fromWeb(res.body), fileStream)
  console.log(`Downloaded ${archiveName} successfully.`)

  if (!isWin) {
    console.log(`Extracting ${archiveName}...`)
    runCommand('tar', ['-xf', archivePath, '-C', versionDir])

    const extractedBin = join(versionDir, `node-${version}-${platform}-${arch}`, 'bin', 'node')
    if (!existsSync(extractedBin)) {
      throw new Error(`Extraction succeeded but node executable not found at: ${extractedBin}`)
    }

    chmodSync(extractedBin, 0o755)
    rmSync(archivePath, { force: true })
    return extractedBin
  }

  chmodSync(archivePath, 0o755)
  return archivePath
}

async function ensureSeaBaseBinary() {
  const currentBin = process.execPath

  // 1. Check if the current node binary contains the sentinel
  if (hasSentinel(currentBin)) {
    console.log('Current Node.js binary contains the sentinel. Using it directly.')
    return currentBin
  }

  console.log('\n--- Alert: Current Node.js binary is stripped / optimized (common with Homebrew) ---')
  console.log('A standard official Node.js binary is required to build the Single Executable Application.')

  const version = process.version
  const platform = process.platform
  const arch = process.arch

  const cacheDir = join(root, '.cache', 'node-sea')
  const versionDir = join(cacheDir, version)
  mkdirSync(versionDir, { recursive: true })

  const expectedBin = platform === 'win32'
    ? join(versionDir, 'node.exe')
    : join(versionDir, `node-${version}-${platform}-${arch}`, 'bin', 'node')

  // 2. Check if already cached and has sentinel
  if (existsSync(expectedBin) && hasSentinel(expectedBin)) {
    console.log(`Found valid official Node.js binary in cache at: ${expectedBin}`)
    return expectedBin
  }

  // 3. Try to download
  try {
    return await downloadOfficialNode(version, platform, arch, versionDir)
  } catch (err) {
    console.warn(`Download failed for version ${version}: ${err.message}`)

    // 4. Try fallback version
    const fallbackVersion = await getFallbackVersion(version)
    if (fallbackVersion && fallbackVersion !== version) {
      console.log(`Attempting download with fallback version ${fallbackVersion}...`)
      const fallbackDir = join(cacheDir, fallbackVersion)
      mkdirSync(fallbackDir, { recursive: true })

      const fallbackBin = platform === 'win32'
        ? join(fallbackDir, 'node.exe')
        : join(fallbackDir, `node-${fallbackVersion}-${platform}-${arch}`, 'bin', 'node')

      if (existsSync(fallbackBin) && hasSentinel(fallbackBin)) {
        console.log(`Found valid fallback Node.js binary in cache at: ${fallbackBin}`)
        return fallbackBin
      }

      try {
        return await downloadOfficialNode(fallbackVersion, platform, arch, fallbackDir)
      } catch (fallbackErr) {
        console.error(`Download also failed for fallback version ${fallbackVersion}:`, fallbackErr.message)
      }
    }

    throw new Error('Could not obtain an official Node.js binary with the required SEA sentinel.')
  }
}

async function main() {
  console.log('--- Starting BabeL-O Single Executable Application (SEA) Build ---')

  // 1. Ensure dist directory exists and is clean
  mkdirSync(distDir, { recursive: true })

  // 2. Bundle the CLI and Server into a single ESM file using esbuild
  const bundleFile = join(distDir, 'bbl-bundled.mjs')
  console.log(`Bundling code with esbuild to ${bundleFile}...`)
  runCommand('npx', [
    'esbuild',
    join(root, 'src/cli/program.ts'),
    '--bundle',
    '--platform=node',
    '--target=node22',
    '--format=esm',
    '--banner:js="import { createRequire } from \'node:module\'; const require = createRequire(import.meta.url);"',
    `--outfile=${bundleFile}`,
  ])

  // 3. Define output binary path
  const binaryExt = process.platform === 'win32' ? '.exe' : ''
  const destBinary = join(distDir, `bbl${binaryExt}`)

  // Clean previous binary if exists to prevent EACCES issues
  if (existsSync(destBinary)) {
    rmSync(destBinary, { force: true })
  }

  // 4. Get the node binary to use for building/compiling (copies this base)
  const baseBinary = await ensureSeaBaseBinary()

  // 5. Write sea-config.json dynamically for native --build-sea
  const seaConfigPath = join(distDir, 'sea-config.json')
  const config = {
    main: bundleFile,
    output: destBinary,
    mainFormat: 'module',
    disableSentinelFuse: true,
    assets: {
      'skills/built-in/coding.md': 'src/skills/built-in/coding.md',
      'skills/built-in/debugging.md': 'src/skills/built-in/debugging.md',
      'skills/built-in/git.md': 'src/skills/built-in/git.md',
      'skills/built-in/optimization.md': 'src/skills/built-in/optimization.md',
      'skills/built-in/testing.md': 'src/skills/built-in/testing.md',
    },
  }
  writeFileSync(seaConfigPath, JSON.stringify(config, null, 2))
  console.log(`Created SEA config at ${seaConfigPath}`)

  // 6. Generate the single executable application natively using --build-sea
  console.log(`Compiling native single executable via --build-sea to ${destBinary}...`)
  runCommand(baseBinary, ['--build-sea', seaConfigPath])

  // 7. On macOS, resign the binary using ad-hoc signature to prevent gatekeeper crash
  if (process.platform === 'darwin') {
    console.log('Resigning binary copy on macOS...')
    const codesignAdd = spawnSync('codesign', ['--sign', '-', '--force', destBinary], { stdio: 'ignore' })
    if (codesignAdd.status !== 0) {
      console.warn('Warning: Failed to apply ad-hoc signature. Executable might trigger gatekeeper blocks.')
    }
  }

  console.log('\n--- SEA Build Success! ---')
  console.log(`Native binary generated: ${destBinary}`)
}

main().catch(err => {
  console.error('Fatal error during SEA build:', err)
  process.exit(1)
})
