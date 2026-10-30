import { randomUUID } from 'node:crypto'
import type { AgentRole, AgentTask, TaskStatus } from './types'

const transitions: Record<TaskStatus, TaskStatus[]> = {
  pending: ['assigned', 'cancelled'], assigned: ['running', 'waiting_for_approval', 'cancelled', 'failed'], running: ['waiting_for_input', 'waiting_for_approval', 'completed', 'failed', 'cancelled'], waiting_for_input: ['running', 'cancelled', 'failed'], waiting_for_approval: ['running', 'cancelled', 'failed'], completed: [], failed: [], cancelled: []
}

export class TaskManager {
  private tasks = new Map<string, AgentTask>()
  private onChange: (task: AgentTask) => void
  constructor(onChange: (task: AgentTask) => void) { this.onChange = onChange }
  list() { return [...this.tasks.values()].map((task) => ({ ...task })) }
  restore(task: AgentTask) {
    if (!task.id || !['orchestrator', 'codebase', 'coding', 'research', 'review'].includes(task.assignedAgentId)) return
    this.tasks.set(task.id, { ...task, status: ['pending', 'assigned', 'running', 'waiting_for_input', 'waiting_for_approval'].includes(task.status) ? 'failed' : task.status })
  }
  create(agent: AgentRole, title: string, instructions: string, dependencies: string[] = [], parentTaskId?: string, root?: string) {
    if (!title.trim() || title.length > 200 || !instructions.trim() || instructions.length > 20_000) throw new Error('Invalid task title or instructions.')
    if (dependencies.some((id) => !this.tasks.has(id) || this.tasks.get(id)?.status !== 'completed')) throw new Error('Every task dependency must exist and be completed first.')
    if (parentTaskId && !this.tasks.has(parentTaskId)) throw new Error('Parent task does not exist.')
    const now = Date.now()
    const task: AgentTask = { id: randomUUID(), root, parentTaskId, assignedAgentId: agent, title: title.trim(), instructions: instructions.trim(), dependencies: [...dependencies], status: 'pending', createdAt: now, updatedAt: now }
    this.tasks.set(task.id, task); this.onChange(task)
    return { ...task }
  }
  transition(id: string, next: TaskStatus, owner: AgentRole) {
    const task = this.tasks.get(id)
    if (!task || task.assignedAgentId !== owner) throw new Error('Task ownership validation failed.')
    if (!transitions[task.status].includes(next)) throw new Error(`Invalid task state transition: ${task.status} → ${next}.`)
    task.status = next; task.updatedAt = Date.now(); this.onChange(task)
    return { ...task }
  }
  get(id: string) { const task = this.tasks.get(id); return task ? { ...task } : undefined }
  clear() { if ([...this.tasks.values()].some((task) => ['assigned', 'running', 'waiting_for_approval', 'waiting_for_input'].includes(task.status))) throw new Error('Stop active work before clearing task history.'); this.tasks.clear() }
}
