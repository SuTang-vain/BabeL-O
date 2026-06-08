import type { EvidenceRef, SessionChannel, SessionMessage } from '../shared/sessionChannel.js'

export type GovernedMemoryScope = 'project' | 'user' | 'channel' | 'unknown'
export type MemoryCandidateDecision = 'requires_approval' | 'rejected'
export type MemoryCandidateStalenessStatus = 'fresh' | 'stale' | 'superseded' | 'unknown'
export type MemoryCandidateApprovalTarget = 'user' | 'policy'

export type MemoryCandidateGovernance = {
  version: '2026-06-08.memory-candidate-governance.v1'
  source: 'session_channel'
  scope: GovernedMemoryScope
  confidence: number
  decision: MemoryCandidateDecision
  autoWrite: false
  approval: {
    status: 'required' | 'rejected'
    requiredBy: MemoryCandidateApprovalTarget
    reason: string
  }
  evidenceRefs: EvidenceRef[]
  staleness: {
    status: MemoryCandidateStalenessStatus
    observedAt?: string
    expiresAt?: string
    supersedes: string[]
    supersededBy?: string
  }
  writePolicy: {
    allowMemoryWriteRequests: boolean
    requestedWrite: boolean
  }
  blockedReasons: string[]
  reviewReasons: string[]
}

export function evaluateSessionMemoryCandidate(input: {
  channel: SessionChannel
  message: SessionMessage
}): MemoryCandidateGovernance {
  const candidateInput = asRecord(input.message.metadata?.memoryCandidate)
  const evidenceRefs = input.message.evidence ?? []
  const scope = classifyMemoryCandidateScope(input.message, candidateInput)
  const confidence = clampConfidence(numberValue(candidateInput?.confidence) ?? inferConfidence(input.message))
  const staleness = buildStaleness(candidateInput, input.message.createdAt)
  const requestedWrite = booleanValue(candidateInput?.requestedWrite) ?? booleanValue(candidateInput?.requestWrite) ?? false
  const blockedReasons = buildBlockedReasons({
    scope,
    confidence,
    evidenceRefs,
    staleness,
    requestedWrite,
    allowMemoryWriteRequests: input.channel.policy.allowMemoryWriteRequests,
  })
  const approvalTarget = approvalTargetForScope(scope)
  const decision: MemoryCandidateDecision = blockedReasons.length > 0 ? 'rejected' : 'requires_approval'

  return {
    version: '2026-06-08.memory-candidate-governance.v1',
    source: 'session_channel',
    scope,
    confidence,
    decision,
    autoWrite: false,
    approval: {
      status: decision === 'rejected' ? 'rejected' : 'required',
      requiredBy: approvalTarget,
      reason: decision === 'rejected'
        ? 'Candidate failed governance checks and was not written.'
        : `${scope} memory candidates require ${approvalTarget} approval before any write.`,
    },
    evidenceRefs,
    staleness,
    writePolicy: {
      allowMemoryWriteRequests: input.channel.policy.allowMemoryWriteRequests,
      requestedWrite,
    },
    blockedReasons,
    reviewReasons: buildReviewReasons(scope, approvalTarget, input.channel.policy.allowMemoryWriteRequests),
  }
}

export function formatMemoryCandidateGovernanceForInbox(message: SessionMessage): string {
  const governance = asRecord(message.metadata?.memoryCandidateGovernance)
  if (!governance) return ''
  const decision = stringValue(governance.decision) ?? 'unknown'
  const scope = stringValue(governance.scope) ?? 'unknown'
  const autoWrite = governance.autoWrite === true ? 'true' : 'false'
  const approval = asRecord(governance.approval)
  const approvalStatus = stringValue(approval?.status) ?? 'unknown'
  const approvalTarget = stringValue(approval?.requiredBy) ?? 'unknown'
  return ` governance=${decision} scope=${scope} approval=${approvalStatus}:${approvalTarget} auto_write=${autoWrite}`
}

function classifyMemoryCandidateScope(
  message: SessionMessage,
  candidateInput: Record<string, unknown> | undefined,
): GovernedMemoryScope {
  const declared = scopeValue(candidateInput?.scope) ?? scopeValue(candidateInput?.memoryScope)
  if (declared) return declared
  const normalized = message.content.toLowerCase()
  if (normalized.includes('user prefers') || normalized.includes('user preference') || normalized.includes('用户偏好') || normalized.includes('用户习惯')) {
    return 'user'
  }
  if ((message.evidence ?? []).some(ref => ref.type === 'file' || ref.type === 'tool_trace' || ref.type === 'session_event')) {
    return 'project'
  }
  if (message.channelId) return 'channel'
  return 'unknown'
}

function buildStaleness(
  candidateInput: Record<string, unknown> | undefined,
  createdAt: string,
): MemoryCandidateGovernance['staleness'] {
  const observedAt = stringValue(candidateInput?.observedAt) ?? createdAt
  const expiresAt = stringValue(candidateInput?.expiresAt)
  const supersedes = stringArrayValue(candidateInput?.supersedes)
  const supersededBy = stringValue(candidateInput?.supersededBy)
  const status: MemoryCandidateStalenessStatus = supersededBy
    ? 'superseded'
    : expiresAt && expiresAt <= createdAt
      ? 'stale'
      : observedAt
        ? 'fresh'
        : 'unknown'
  return {
    status,
    ...(observedAt && { observedAt }),
    ...(expiresAt && { expiresAt }),
    supersedes,
    ...(supersededBy && { supersededBy }),
  }
}

function buildBlockedReasons(input: {
  scope: GovernedMemoryScope
  confidence: number
  evidenceRefs: EvidenceRef[]
  staleness: MemoryCandidateGovernance['staleness']
  requestedWrite: boolean
  allowMemoryWriteRequests: boolean
}): string[] {
  const reasons: string[] = []
  if (input.scope === 'unknown') reasons.push('unknown_scope')
  if (input.evidenceRefs.length === 0) reasons.push('missing_evidence_refs')
  if (input.confidence < 0.6) reasons.push('low_confidence')
  if (input.staleness.status === 'stale') reasons.push('stale_candidate')
  if (input.staleness.status === 'superseded') reasons.push('superseded_candidate')
  if (input.requestedWrite && !input.allowMemoryWriteRequests) reasons.push('memory_write_requests_disabled')
  if (input.scope === 'project' && !input.evidenceRefs.some(ref => ref.type === 'file' || ref.type === 'tool_trace' || ref.type === 'session_event')) {
    reasons.push('project_scope_requires_workspace_evidence')
  }
  return reasons
}

function buildReviewReasons(
  scope: GovernedMemoryScope,
  approvalTarget: MemoryCandidateApprovalTarget,
  allowMemoryWriteRequests: boolean,
): string[] {
  return [
    'memory_candidates_are_not_persisted_automatically',
    `${scope}_scope_requires_${approvalTarget}_approval`,
    allowMemoryWriteRequests ? 'memory_write_requests_allowed_but_still_gated' : 'memory_write_requests_disabled_by_policy',
    'evidence_confidence_staleness_and_supersession_checked',
  ]
}

function approvalTargetForScope(scope: GovernedMemoryScope): MemoryCandidateApprovalTarget {
  return scope === 'channel' ? 'policy' : 'user'
}

function inferConfidence(message: SessionMessage): number {
  return (message.evidence?.length ?? 0) > 0 ? 0.6 : 0.4
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

function scopeValue(value: unknown): GovernedMemoryScope | undefined {
  return value === 'project' || value === 'user' || value === 'channel' || value === 'unknown'
    ? value
    : undefined
}

function stringArrayValue(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
