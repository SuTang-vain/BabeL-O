import type { NexusEvent } from './events.js'

export type SessionPhase =
  | 'created'
  | 'executing'
  | 'waiting_permission'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type SessionSnapshot = {
  sessionId: string
  cwd: string
  prompt: string
  phase: SessionPhase
  createdAt: string
  updatedAt: string
  events: NexusEvent[]
  result?: string
  error?: string
  lastUserInput?: string
}
