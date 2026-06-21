export type ActiveExecutionTransport = 'http' | 'websocket'

export type ActiveExecution = {
  requestId: string
  abortController: AbortController
  transport: ActiveExecutionTransport
  startedAt: string
}

export type ActiveExecutionSnapshot = {
  requestId: string
  transport: ActiveExecutionTransport
  startedAt: string
}

export type ActiveExecutionLease = {
  release(): void
}

export type CancelledActiveExecution = {
  requestId: string
  transport: ActiveExecutionTransport
}

export class ActiveExecutionRegistry {
  private readonly activeExecutions = new Map<string, ActiveExecution>()

  register(sessionId: string, execution: ActiveExecution): ActiveExecutionLease {
    this.activeExecutions.set(sessionId, execution)
    let released = false
    return {
      release: () => {
        if (released) return
        released = true
        this.clear(sessionId, execution.requestId)
      },
    }
  }

  clear(sessionId: string, requestId: string): void {
    if (this.activeExecutions.get(sessionId)?.requestId === requestId) {
      this.activeExecutions.delete(sessionId)
    }
  }

  snapshot(sessionId: string): ActiveExecutionSnapshot | null {
    const activeExecution = this.activeExecutions.get(sessionId)
    return activeExecution
      ? {
          requestId: activeExecution.requestId,
          transport: activeExecution.transport,
          startedAt: activeExecution.startedAt,
        }
      : null
  }

  cancel(sessionId: string): CancelledActiveExecution | null {
    const activeExecution = this.activeExecutions.get(sessionId)
    if (!activeExecution) return null
    activeExecution.abortController.abort()
    return {
      requestId: activeExecution.requestId,
      transport: activeExecution.transport,
    }
  }

  clearByAbortController(abortController: AbortController): void {
    for (const [sessionId, execution] of this.activeExecutions.entries()) {
      if (execution.abortController === abortController) {
        this.clear(sessionId, execution.requestId)
        return
      }
    }
  }
}
