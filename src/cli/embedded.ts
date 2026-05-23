import { createNexusApp } from '../nexus/app.js'
import { createDefaultNexusRuntime } from '../nexus/createRuntime.js'

export async function executeEmbedded(prompt: string, cwd: string) {
  const { runtime, storage } = await createDefaultNexusRuntime()
  const app = await createNexusApp({ runtime, storage, defaultCwd: cwd })
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/execute',
      payload: { prompt, cwd },
    })
    if (response.statusCode >= 400) {
      throw new Error(response.body)
    }
    return response.json()
  } finally {
    await app.close()
    await storage.close?.()
  }
}
