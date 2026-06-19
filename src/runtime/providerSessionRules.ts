import type { AnyTool } from '../tools/Tool.js'
import { buildSessionRulesPolicy } from './LocalCodingRuntime.js'

/**
 * Process-local provider session approval rules. Each instance owns its
 * sessionId -> rule[] map so runtimes/tests can isolate approvals without a
 * module-level mutable Map in the tool loop hot path.
 */
export class ProviderSessionRules {
  private readonly bySession = new Map<string, string[]>()

  addRule(sessionId: string, rule: string): void {
    const trimmed = rule.trim()
    if (!trimmed) return
    const current = this.bySession.get(sessionId) ?? []
    if (current.includes(trimmed)) return
    this.bySession.set(sessionId, [...current, trimmed])
  }

  getRules(sessionId: string): readonly string[] {
    return this.bySession.get(sessionId) ?? []
  }

  isAllowed(sessionId: string, tool: AnyTool, input: unknown): boolean {
    const rules = this.getRules(sessionId)
    if (rules.length === 0) return false
    return buildSessionRulesPolicy(rules).isAllowed(tool, input)
  }

  clear(): void {
    this.bySession.clear()
  }
}

export const defaultProviderSessionRules = new ProviderSessionRules()
