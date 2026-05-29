import * as childProcess from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

// Export spawner wrapper to allow easy mocking in unit tests
export const _spawner = {
  spawn: childProcess.spawn
}

/**
 * Opens an external editor (Vim, Nano, etc.) to edit the prompt.
 * Suspends readline input, launches the editor on a temp file, and resumes readline afterwards.
 */
export async function openExternalEditor(initialContent: string, cwd: string): Promise<string> {
  const editor = process.env.VISUAL || process.env.EDITOR || 'nano'

  const tempDir = path.join(cwd, '.babel-o')
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true })
  }

  const tempFile = path.join(tempDir, `babel-o-prompt-${Date.now()}.txt`)

  // Write initial content
  fs.writeFileSync(tempFile, initialContent, 'utf8')

  // Save the terminal's raw mode and keypress/data listeners
  const wasRaw = process.stdin.isRaw
  const keypressListeners = process.stdin.listeners('keypress')
  const dataListeners = process.stdin.listeners('data')

  // Clean up process.stdin listeners before spawning
  process.stdin.removeAllListeners('keypress')
  process.stdin.removeAllListeners('data')
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false)
  }

  return new Promise<string>((resolve) => {
    const child = _spawner.spawn(editor, [tempFile], { stdio: 'inherit', shell: true })

    child.on('error', () => {
      // If editor command fails, try nano as fallback, then vi
      if (editor !== 'nano') {
        const fallbackChild = _spawner.spawn('nano', [tempFile], { stdio: 'inherit', shell: true })
        fallbackChild.on('close', (code) => {
          finalize(code)
        })
        fallbackChild.on('error', () => {
          const viChild = _spawner.spawn('vi', [tempFile], { stdio: 'inherit', shell: true })
          viChild.on('close', (code) => {
            finalize(code)
          })
          viChild.on('error', () => {
            finalize(-1)
          })
        })
      } else {
        finalize(-1)
      }
    })

    child.on('close', (code) => {
      finalize(code)
    })

    function finalize(code: number | null) {
      // Restore stdin state
      for (const listener of keypressListeners) {
        process.stdin.on('keypress', listener as any)
      }
      for (const listener of dataListeners) {
        process.stdin.on('data', listener as any)
      }
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(wasRaw)
      }

      if (code !== 0) {
        // If child failed or was interrupted, clean up and return original
        if (fs.existsSync(tempFile)) {
          try {
            fs.unlinkSync(tempFile)
          } catch {}
        }
        resolve(initialContent)
        return
      }

      let result = initialContent
      if (fs.existsSync(tempFile)) {
        try {
          result = fs.readFileSync(tempFile, 'utf8')
          fs.unlinkSync(tempFile)
        } catch {}
      }
      resolve(result)
    }
  })
}
