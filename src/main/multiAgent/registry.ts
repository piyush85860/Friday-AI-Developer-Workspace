import type { AgentDefinition, AgentRole, ProviderId } from './types'

const defaults: AgentDefinition[] = [
  { id: 'orchestrator', name: 'Orchestrator', description: 'Plans work and presents the final answer.', instructions: 'You are the sole user-facing coordinator. Return one JSON object matching the requested schema. Delegate only necessary work. Do not modify files or run commands.', providerId: 'codex', model: '', providerModels: {}, providerSessions: {}, filesystemPermission: 'read-only', timeoutMs: 120_000 },
  { id: 'codebase', name: 'Codebase Agent', description: 'Inspects project structure and implementation.', instructions: 'Inspect the project read-only. Return concise findings with relevant paths. Do not modify files or run commands.', providerId: 'codex', model: '', providerModels: {}, providerSessions: {}, filesystemPermission: 'read-only', timeoutMs: 180_000 },
  { id: 'coding', name: 'Coding Agent', description: 'Implements one assigned workspace task.', instructions: 'Implement only the assigned task in the authorized workspace. Preserve existing user changes. Do not commit, reset, or discard changes. Report changed files and actual verification.', providerId: 'codex', model: '', providerModels: {}, providerSessions: {}, filesystemPermission: 'workspace-write', timeoutMs: 600_000 },
  { id: 'research', name: 'Research Agent', description: 'Researches technical questions and returns evidence.', instructions: 'Research the assigned technical question. Clearly distinguish verified sources from inference. Do not modify files or run commands.', providerId: 'codex', model: '', providerModels: {}, providerSessions: {}, filesystemPermission: 'read-only', timeoutMs: 180_000 },
  { id: 'review', name: 'Review Agent', description: 'Independently reviews completed work.', instructions: 'Review the current workspace changes against the assigned requirements. Read-only. Report concrete findings, risks, and missing verification.', providerId: 'codex', model: '', providerModels: {}, providerSessions: {}, filesystemPermission: 'read-only', timeoutMs: 180_000 }
]

export class AgentRegistry {
  private agents = new Map<AgentRole, AgentDefinition>(defaults.map((agent) => [agent.id, { ...agent }]))
  list() { return [...this.agents.values()].map((agent) => ({ ...agent })) }
  get(id: AgentRole) { const agent = this.agents.get(id); if (!agent) throw new Error(`Unknown agent: ${id}`); return { ...agent } }
  restore(agent: AgentDefinition) {
    const current = this.get(agent.id)
    const providerModels = Object.fromEntries(Object.entries(agent.providerModels || {}).filter(([key, value]) => ['codex', 'claude', 'gemini'].includes(key) && typeof value === 'string' && /^[a-zA-Z0-9_.:/-]{0,100}$/.test(value))) as Partial<Record<ProviderId, string>>
    if (typeof agent.model === 'string' && /^[a-zA-Z0-9_.:/-]{0,100}$/.test(agent.model) && !providerModels[agent.providerId]) providerModels[agent.providerId] = agent.model
    const providerId: ProviderId = ['codex', 'claude', 'gemini'].includes(agent.providerId) ? agent.providerId : current.providerId
    const instructions = typeof agent.instructions === 'string' && agent.instructions.length > 0 && agent.instructions.length <= 8000 ? agent.instructions : current.instructions
    const timeoutMs = Number.isInteger(agent.timeoutMs) && agent.timeoutMs >= 10_000 && agent.timeoutMs <= 1_800_000 ? agent.timeoutMs : current.timeoutMs
    const providerSessions = Object.fromEntries(Object.entries(agent.providerSessions || {}).filter(([key, value]) => typeof key === 'string' && typeof value === 'string' && value.length <= 200))
    const filesystemPermission = agent.filesystemPermission === 'workspace-write' || agent.filesystemPermission === 'read-only' ? agent.filesystemPermission : current.filesystemPermission
    this.agents.set(agent.id, { ...current, ...agent, providerId, instructions, timeoutMs, providerModels, providerSessions, filesystemPermission, model: providerModels[providerId] || '' })
  }
  update(id: AgentRole, patch: { providerId?: ProviderId; model?: string; instructions?: string; timeoutMs?: number; filesystemPermission?: 'read-only' | 'workspace-write' }) {
    const current = this.get(id)
    if (patch.model !== undefined && patch.model !== '' && !/^[a-zA-Z0-9_.:/-]{1,100}$/.test(patch.model)) throw new Error('Model names may contain letters, numbers, dots, underscores, colons, slashes, and hyphens only.')
    if (patch.instructions !== undefined && (patch.instructions.length === 0 || patch.instructions.length > 8000)) throw new Error('Agent instructions must be between 1 and 8,000 characters.')
    if (patch.timeoutMs !== undefined && (!Number.isInteger(patch.timeoutMs) || patch.timeoutMs < 10_000 || patch.timeoutMs > 1_800_000)) throw new Error('Timeout must be between 10 seconds and 30 minutes.')
    if (patch.filesystemPermission !== undefined && !['read-only', 'workspace-write'].includes(patch.filesystemPermission)) throw new Error('Unsupported filesystem permission profile.')
    const providerId = patch.providerId || current.providerId
    const providerModels = { ...current.providerModels }
    if (patch.model !== undefined) providerModels[current.providerId] = patch.model
    const model = patch.providerId && patch.providerId !== current.providerId ? providerModels[providerId] || '' : patch.model ?? current.model
    const next = { ...current, ...patch, providerId, model, providerModels }
    this.agents.set(id, next)
    return { ...next }
  }
  setSession(id: AgentRole, providerId: ProviderId, root: string, sessionId?: string) {
    const current = this.get(id)
    if (!sessionId) return current
    const next = { ...current, providerSessions: { ...current.providerSessions, [`${providerId}:${root}`]: sessionId } }
    this.agents.set(id, next)
    return { ...next }
  }
  clearSessions() { for (const [id, agent] of this.agents) this.agents.set(id, { ...agent, providerSessions: {} }) }
}
