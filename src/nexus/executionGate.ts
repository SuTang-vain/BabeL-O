export class ExecutionGate {
  private active = 0

  constructor(private readonly maxActive: number) {}

  tryAcquire(): (() => void) | null {
    if (!Number.isFinite(this.maxActive) || this.maxActive <= 0) {
      return () => {}
    }
    if (this.active >= this.maxActive) return null
    this.active += 1
    let released = false
    return () => {
      if (released) return
      released = true
      this.active = Math.max(0, this.active - 1)
    }
  }
}
