export type ProviderId = 'codex' | 'claude' | 'gemini'
export type AgentRole = 'orchestrator' | 'codebase' | 'coding' | 'research' | 'review'
export type TaskStatus = 'pending' | 'assigned' | 'running' | 'waiting_for_input' | 'waiting_for_approval' | 'completed' | 'failed' | 'cancelled'

export interface ProviderStatus {
  providerId: ProviderId
  installed: boolean
  version?: string
  authenticated: boolean | 'unknown'
  authMethod?: string
  error?: string
}

export interface AgentDefinition {
  id: AgentRole
  name: string
  description: string
  instructions: string
  providerId: ProviderId
  model: string
  providerModels: Partial<Record<ProviderId, string>>
  providerSessions: Record<string, string>
  filesystemPermission: 'read-only' | 'workspace-write'
  timeoutMs: number
}

export interface AgentTask {
  id: string
  root?: string
  parentTaskId?: string
  assignedAgentId: AgentRole
  title: string
  instructions: string
  dependencies: string[]
  status: TaskStatus
  createdAt: number
  updatedAt: number
}

export interface AgentResult {
  taskId: string
  agentId: AgentRole
  status: 'completed' | 'failed' | 'cancelled'
  summary: string
  findings: string[]
  changedFiles: string[]
  verification: string[]
  errors: string[]
  eventIds: string[]
  providerSessionId?: string
}

export type MultiAgentEventType = 'agent_started' | 'agent_message' | 'tool_started' | 'tool_completed' | 'approval_required' | 'agent_error' | 'agent_completed' | 'agent_cancelled' | 'task_created' | 'task_updated' | 'plan_ready' | 'orchestrator_message' | 'run_finished'

export interface MultiAgentEvent {
  id: string
  taskId?: string
  agentId?: AgentRole
  providerId?: ProviderId
  type: MultiAgentEventType
  time: number
  detail?: string
  data?: unknown
}

export interface PermissionProfile {
  filesystem: 'read-only' | 'workspace-write'
  terminal: 'none' | 'sandboxed'
  gitModification: boolean
}

export interface MultiAgentSnapshot {
  agents: AgentDefinition[]
  tasks: AgentTask[]
  events: MultiAgentEvent[]
  running: boolean
  root: string
  conversation: Array<{ role: 'user' | 'assistant'; content: string; time: number }>
}

export const permissionProfiles: Record<AgentRole, PermissionProfile> = {
  orchestrator: { filesystem: 'read-only', terminal: 'none', gitModification: false },
  codebase: { filesystem: 'read-only', terminal: 'none', gitModification: false },
  coding: { filesystem: 'workspace-write', terminal: 'sandboxed', gitModification: false },
  research: { filesystem: 'read-only', terminal: 'none', gitModification: false },
  review: { filesystem: 'read-only', terminal: 'none', gitModification: false }
}
