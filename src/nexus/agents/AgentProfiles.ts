import type { AgentProfile, AgentProfileId } from './types.js'

export const EXPLORE_AGENT_PROFILE: AgentProfile = {
  id: 'explore',
  displayName: 'Explore Agent',
  defaultTools: ['Read', 'Grep', 'Glob'],
  defaultContextForkMode: 'minimal',
  defaultIsolation: 'none',
  canEdit: false,
  canRunBash: false,
  requiresApproval: false,
  maxRuntimeMs: 120_000,
  maxOutputTokens: 2_048,
}

export const REVIEW_AGENT_PROFILE: AgentProfile = {
  id: 'review',
  displayName: 'Review Agent',
  defaultTools: ['Read', 'Grep', 'Glob', 'Bash'],
  defaultContextForkMode: 'task-focused',
  defaultIsolation: 'none',
  canEdit: false,
  canRunBash: true,
  requiresApproval: false,
  maxRuntimeMs: 180_000,
  maxOutputTokens: 3_000,
}

export const TEST_AGENT_PROFILE: AgentProfile = {
  id: 'test',
  displayName: 'Test Agent',
  defaultTools: ['Read', 'Grep', 'Glob', 'Bash'],
  defaultContextForkMode: 'task-focused',
  defaultIsolation: 'none',
  canEdit: false,
  canRunBash: true,
  requiresApproval: false,
  maxRuntimeMs: 300_000,
  maxOutputTokens: 3_000,
}

export const agentProfiles: Record<'explore' | 'review' | 'test', AgentProfile> = {
  explore: EXPLORE_AGENT_PROFILE,
  review: REVIEW_AGENT_PROFILE,
  test: TEST_AGENT_PROFILE,
}

export function getAgentProfile(profileId: AgentProfileId): AgentProfile | undefined {
  return profileId in agentProfiles
    ? agentProfiles[profileId as keyof typeof agentProfiles]
    : undefined
}

export function assertAgentProfile(profileId: AgentProfileId): AgentProfile {
  const profile = getAgentProfile(profileId)
  if (!profile) {
    throw new Error(`Agent profile is not enabled: ${profileId}`)
  }
  return profile
}
