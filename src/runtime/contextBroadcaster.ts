import type { AssembledContext } from './contextAssembler.js'

export type RuntimeContextEvent = {
  type: 'assembled'
  sessionId: string
  context: AssembledContext
  timestamp: string
}

export type RuntimeContextBroadcaster = {
  publish(cwd: string, event: RuntimeContextEvent): void
}
