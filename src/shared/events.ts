export const NEXUS_EVENT_SCHEMA_VERSION = '2026-05-21.babel-o.v1'

export type NexusEvent =
  | {
      type: 'session_started'
      schemaVersion: typeof NEXUS_EVENT_SCHEMA_VERSION
      sessionId: string
      timestamp: string
      cwd: string
    }
  | {
      type: 'assistant_delta'
      schemaVersion: typeof NEXUS_EVENT_SCHEMA_VERSION
      sessionId: string
      timestamp: string
      text: string
    }
  | {
      type: 'thinking_delta'
      schemaVersion: typeof NEXUS_EVENT_SCHEMA_VERSION
      sessionId: string
      timestamp: string
      text: string
    }
  | {
      type: 'user_message'
      schemaVersion: typeof NEXUS_EVENT_SCHEMA_VERSION
      sessionId: string
      timestamp: string
      text: string
    }
  | {
      type: 'tool_started'
      schemaVersion: typeof NEXUS_EVENT_SCHEMA_VERSION
      sessionId: string
      timestamp: string
      toolUseId: string
      name: string
      input: unknown
    }
  | {
      type: 'tool_completed'
      schemaVersion: typeof NEXUS_EVENT_SCHEMA_VERSION
      sessionId: string
      timestamp: string
      toolUseId: string
      name: string
      success: boolean
      output: unknown
      truncated?: boolean
      originalBytes?: number
    }
  | {
      type: 'tool_denied'
      schemaVersion: typeof NEXUS_EVENT_SCHEMA_VERSION
      sessionId: string
      timestamp: string
      name: string
      risk: 'read' | 'write' | 'execute' | 'task'
      message: string
    }
  | {
      type: 'task_created'
      schemaVersion: typeof NEXUS_EVENT_SCHEMA_VERSION
      sessionId: string
      timestamp: string
      taskId: string
      title: string
    }
  | {
      type: 'result'
      schemaVersion: typeof NEXUS_EVENT_SCHEMA_VERSION
      sessionId: string
      timestamp: string
      success: boolean
      message: string
    }
  | {
      type: 'error'
      schemaVersion: typeof NEXUS_EVENT_SCHEMA_VERSION
      sessionId: string
      timestamp: string
      code: string
      message: string
    }

export function eventBase(sessionId: string) {
  return {
    schemaVersion: NEXUS_EVENT_SCHEMA_VERSION,
    sessionId,
    timestamp: new Date().toISOString(),
  } as const
}
