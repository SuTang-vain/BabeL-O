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

  /**
   * Abort every in-flight execution. Used by the daemon graceful-shutdown
   * coordinator (Phase 1 of
   * `docs/nexus/proposals/daemon-graceful-shutdown-and-orphan-reaper-plan.md`)
   * so long-running agent loops stop instead of blocking `app.close()`.
   *
   * Returns the count of executions whose abort controller was signalled.
   * Each aborted execution's route handler finally-block is responsible
   * for releasing its lease (which removes it from this registry) and
   * settling the session state.
   */
  cancelAll(): number {
    let cancelled = 0
    for (const execution of this.activeExecutions.values()) {
      execution.abortController.abort()
      cancelled += 1
    }
    return cancelled
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
