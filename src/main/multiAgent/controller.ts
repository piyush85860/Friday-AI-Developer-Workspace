import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import type { BrowserWindow } from 'electron'
import { AgentRegistry } from './registry'
import { TaskManager } from './taskManager'
import { detectProvider, runProvider, terminate } from './providers'
import type { AgentResult, AgentRole, MultiAgentEvent, MultiAgentSnapshot, ProviderId, ProviderStatus } from './types'

type ConversationMessage = { role: 'user' | 'assistant'; content: string; time: number }
type Active = { taskId?: string; agentId: AgentRole; child?: ChildProcess; cancelled: boolean }
type SavedState = { version: 1; agents: ReturnType<AgentRegistry['list']>; tasks: ReturnType<TaskManager['list']>; events: MultiAgentEvent[]; workspaceRoot?: string; conversation?: ConversationMessage[]; conversations?: Record<string, ConversationMessage[]> }
const roles: AgentRole[] = ['orchestrator', 'codebase', 'coding', 'research', 'review']

export class MultiAgentController {
  private getWindow: () => BrowserWindow | null
  private storagePath: string
  private root = ''
  private pendingRoot?: string
  private registry = new AgentRegistry()
  private tasks = new TaskManager((task) => { this.emit('task_updated', task.assignedAgentId, task.id, task.status); this.persist() })
  private events: MultiAgentEvent[] = []
  private conversations = new Map<string, ConversationMessage[]>()
  private active?: Active
  private initialized?: Promise<void>
  private busy = false
  private runCount = 0
  private cancelRequested = false
  private approvalWaiter?: { taskId: string; resolve: (approved: boolean) => void }

  constructor(getWindow: () => BrowserWindow | null, storagePath: string) { this.getWindow = getWindow; this.storagePath = storagePath }
  setRoot(root: string) {
    const next = root ? path.resolve(root) : ''
    if (this.busy) { this.pendingRoot = next; return }
    this.root = next
  }
  private currentConversation() { const list = this.conversations.get(this.root) || []; this.conversations.set(this.root, list); return list }
  async initialize() {
    if (this.initialized) return this.initialized
    this.initialized = (async () => {
      try {
        const saved = JSON.parse(await readFile(this.storagePath, 'utf8')) as SavedState
        if (saved.version !== 1) return
        for (const agent of saved.agents || []) if (roles.includes(agent.id) && ['codex', 'claude', 'gemini'].includes(agent.providerId)) this.registry.restore(agent)
        for (const task of saved.tasks || []) this.tasks.restore(task)
        this.events = (saved.events || []).slice(-500)
        if (saved.conversations && typeof saved.conversations === 'object') {
          for (const [root, messages] of Object.entries(saved.conversations)) if (Array.isArray(messages)) this.conversations.set(root, messages.filter((message) => message && ['user', 'assistant'].includes(message.role) && typeof message.content === 'string').slice(-200))
        } else if (saved.workspaceRoot && Array.isArray(saved.conversation)) this.conversations.set(saved.workspaceRoot, saved.conversation.slice(-200))
      } catch { /* First launch or unreadable/old history; start with fresh Multi-Agent state. */ }
    })()
    return this.initialized
  }
  private persistTimer?: NodeJS.Timeout
  private persist() {
    if (this.persistTimer) clearTimeout(this.persistTimer)
    this.persistTimer = setTimeout(() => {
      const state: SavedState = { version: 1, agents: this.registry.list(), tasks: this.tasks.list().slice(-200), events: this.events.slice(-500), conversations: Object.fromEntries([...this.conversations.entries()].slice(-30).map(([root, messages]) => [root, messages.slice(-200)])) }
      void mkdir(path.dirname(this.storagePath), { recursive: true }).then(async () => {
        const temporary = `${this.storagePath}.${process.pid}.tmp`
        await writeFile(temporary, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 })
        await rename(temporary, this.storagePath)
      }).catch(() => undefined)
    }, 250)
  }
  private emit(type: MultiAgentEvent['type'], agentId?: AgentRole, taskId?: string, detail?: string, data?: unknown) {
    const agent = agentId ? this.registry.get(agentId) : undefined
    const event: MultiAgentEvent = { id: randomUUID(), type, agentId, taskId, providerId: agent?.providerId, time: Date.now(), detail, data }
    this.events.push(event); this.events = this.events.slice(-1000)
    this.getWindow()?.webContents.send('multi-agent:event', event)
    this.persist()
  }
  snapshot(): MultiAgentSnapshot { return { agents: this.registry.list(), tasks: this.tasks.list(), events: this.events.slice(-300), running: this.busy, root: this.root, conversation: this.currentConversation().slice(-100) } }
  conversationHistory() { return [...this.currentConversation()] }
  updateAgent(id: AgentRole, patch: { providerId?: ProviderId; model?: string; instructions?: string; timeoutMs?: number; filesystemPermission?: 'read-only' | 'workspace-write' }) {
    if (this.busy) throw new Error('Change agent settings after the current Multi-Agent run ends.')
    const updated = this.registry.update(id, patch); this.persist(); return updated
  }
  async providerStatus(id: ProviderId): Promise<ProviderStatus> { return detectProvider(id) }
  async start(request: string, dirtyBuffers: string[] = []) {
    await this.initialize()
    if (this.busy) throw new Error('A Multi-Agent task is already running.')
    if (!this.root) throw new Error('Open a workspace before starting Multi-Agent.')
    if (!request.trim() || request.length > 12_000) throw new Error('Enter a request under 12,000 characters.')
    this.busy = true; this.runCount = 0; this.cancelRequested = false
    this.currentConversation().push({ role: 'user', content: request.trim(), time: Date.now() }); this.persist()
    this.emit('orchestrator_message', 'orchestrator', undefined, request.trim(), { role: 'user' })
    try {
      const results: AgentResult[] = []
      for (let step = 0; step < 12; step++) {
        const response = await this.askOrchestrator(request.trim(), results)
        if (this.cancelRequested) return { status: 'cancelled' }
        if (response.action === 'ask_user') {
          this.currentConversation().push({ role: 'assistant', content: response.message, time: Date.now() }); this.emit('orchestrator_message', 'orchestrator', undefined, response.message); this.persist(); return { status: 'waiting_for_input', message: response.message }
        }
        if (response.action === 'final') {
          this.currentConversation().push({ role: 'assistant', content: response.message, time: Date.now() }); this.emit('orchestrator_message', 'orchestrator', undefined, response.message); this.persist(); return { status: 'completed', message: response.message }
        }
        if (this.runCount >= 10) throw new Error('The Orchestrator reached the 10-task limit for one request.')
        if (this.registry.get(response.agentId).filesystemPermission === 'workspace-write' && dirtyBuffers.length) throw new Error(`Save unsaved editor changes before a workspace-write task starts: ${dirtyBuffers.slice(0, 6).join(', ')}`)
        this.runCount++
        const task = this.tasks.create(response.agentId, response.title, response.instructions, results.filter((result) => result.status === 'completed').slice(-1).map((result) => result.taskId), undefined, this.root)
        this.tasks.transition(task.id, 'assigned', task.assignedAgentId)
        this.active = { taskId: task.id, agentId: task.assignedAgentId, cancelled: false }
        if (this.registry.get(task.assignedAgentId).filesystemPermission === 'workspace-write') {
          this.tasks.transition(task.id, 'waiting_for_approval', task.assignedAgentId)
          this.emit('approval_required', task.assignedAgentId, task.id, `Allow ${this.registry.get(task.assignedAgentId).name} to write files in ${this.root}?`, { title: task.title, permissions: 'Workspace file changes; provider sandbox and command approvals still apply.' })
          const approved = await new Promise<boolean>((resolve) => { this.approvalWaiter = { taskId: task.id, resolve } })
          this.approvalWaiter = undefined
          if (!approved || this.cancelRequested) {
            this.tasks.transition(task.id, 'cancelled', task.assignedAgentId)
            results.push({ taskId: task.id, agentId: task.assignedAgentId, status: 'cancelled', summary: '', findings: [], changedFiles: [], verification: [], errors: ['Workspace write permission was denied.'], eventIds: this.events.filter((event) => event.taskId === task.id).map((event) => event.id) })
            this.active = undefined
            if (this.cancelRequested) return { status: 'cancelled' }
            continue
          }
          this.tasks.transition(task.id, 'running', task.assignedAgentId)
        } else this.tasks.transition(task.id, 'running', task.assignedAgentId)
        this.emit('agent_started', task.assignedAgentId, task.id, `Started ${response.title}`)
        let changedFiles: string[] = []
        const before = this.registry.get(task.assignedAgentId).filesystemPermission === 'workspace-write' ? await workspaceMetadata(this.root) : undefined
        const gitBaseline = before ? await gitStatusAtStart(this.root) : ''
        try {
          const output = await this.runAgent(task.assignedAgentId, task.id, response.instructions, results, (child) => { if (this.active?.taskId === task.id) this.active.child = child }, gitBaseline)
          if (this.active?.cancelled || this.cancelRequested) throw new Error('Task cancelled by user.')
          if (before) changedFiles = await changedWorkspaceFiles(this.root, before)
          const report = parseAgentReport(output.text)
          const result: AgentResult = { taskId: task.id, agentId: task.assignedAgentId, status: 'completed', summary: report.summary, findings: report.findings, changedFiles, verification: report.verification, errors: report.errors, eventIds: this.events.filter((event) => event.taskId === task.id).map((event) => event.id), providerSessionId: output.sessionId }
          this.tasks.transition(task.id, 'completed', task.assignedAgentId)
          results.push(result); this.emit('agent_completed', task.assignedAgentId, task.id, report.summary, { changedFiles, findings: report.findings, verification: report.verification, errors: report.errors })
        } catch (error) {
          const cancelled = this.active?.cancelled === true || this.cancelRequested
          const message = error instanceof Error ? error.message : String(error)
          if (before) changedFiles = await changedWorkspaceFiles(this.root, before).catch(() => [])
          this.tasks.transition(task.id, cancelled ? 'cancelled' : 'failed', task.assignedAgentId)
          const result: AgentResult = { taskId: task.id, agentId: task.assignedAgentId, status: cancelled ? 'cancelled' : 'failed', summary: '', findings: [], changedFiles, verification: [], errors: [message], eventIds: this.events.filter((event) => event.taskId === task.id).map((event) => event.id) }
          results.push(result); this.emit(cancelled ? 'agent_cancelled' : 'agent_error', task.assignedAgentId, task.id, message, { changedFiles })
          if (cancelled) return { status: 'cancelled' }
        } finally { if (this.active?.taskId === task.id) this.active = undefined }
      }
      throw new Error('The Orchestrator did not return a final response within the task limit.')
    } catch (error) {
      if (this.cancelRequested) return { status: 'cancelled' }
      throw error
    } finally {
      this.active = undefined; this.emit('run_finished', 'orchestrator', undefined, this.cancelRequested ? 'Multi-Agent run cancelled.' : 'Multi-Agent run finished.')
      this.busy = false
      if (this.pendingRoot !== undefined) { this.root = this.pendingRoot; this.pendingRoot = undefined }
      this.persist()
    }
  }
  private async askOrchestrator(request: string, results: AgentResult[]) {
    const agent = this.registry.get('orchestrator')
    const contract = `Return exactly one JSON object and no markdown. Allowed forms: {"action":"delegate","agentId":"codebase|coding|research|review","title":"short title","instructions":"specific task"}; {"action":"ask_user","message":"question"}; {"action":"final","message":"final response"}. Delegate one task at a time. Never invent completed work; use only returned task results. Do not assign coding unless changes are requested.`
    const prompt = `${agent.instructions}\n${contract}\n\nWorkspace root: ${this.root}\nConversation so far (JSON): ${JSON.stringify(this.currentConversation())}\nCurrent user request: ${request}\nCompleted task results (JSON): ${JSON.stringify(results)}\nChoose the next action now.`
    this.emit('agent_started', 'orchestrator', undefined, 'Orchestrator is deciding the next step.')
    this.active = { agentId: 'orchestrator', cancelled: false }
    let output
    try { output = await this.executeAgent(agent, prompt, undefined, (child) => { if (this.active?.agentId === 'orchestrator') this.active.child = child }) }
    finally { if (this.active?.agentId === 'orchestrator') this.active = undefined }
    const decision = parseDecision(output.text)
    if (decision.action === 'delegate') this.emit('plan_ready', 'orchestrator', undefined, `${decision.agentId}: ${decision.title}`, decision)
    return decision
  }
  private async runAgent(role: AgentRole, taskId: string, instructions: string, results: AgentResult[], onChild: (child: ChildProcess) => void, gitBaseline: string) {
    const agent = this.registry.get(role)
    const baselineContext = gitBaseline ? `\nGit status before this task (preserve these pre-existing changes):\n${gitBaseline}\n` : ''
    const prompt = `${agent.instructions}\nReturn one JSON object with string summary and string arrays findings, changedFiles, verification, errors. Do not include markdown. Report evidence and limitations. Do not claim tests or changes without evidence.\n\nAssigned task: ${instructions}\nWorkspace root: ${this.root}${baselineContext}\nPrior task results: ${JSON.stringify(results)}`
    return this.executeAgent(agent, prompt, taskId, onChild)
  }
  private async executeAgent(agent: ReturnType<AgentRegistry['get']>, prompt: string, taskId?: string, onChild?: (child: ChildProcess) => void) {
    const status = await detectProvider(agent.providerId)
    if (!status.installed) throw new Error(status.error || `${agent.providerId} CLI is missing.`)
    if (status.authenticated === false) throw new Error(status.error || `${agent.providerId} CLI is not authenticated.`)
    if (this.cancelRequested) throw new Error('Multi-Agent run cancelled.')
    const output = await runProvider({ agent, root: this.root, prompt }, (_line, parsed) => {
      if (!parsed) return
      const type = String(parsed.type || '')
      const item = parsed.item && typeof parsed.item === 'object' ? parsed.item as Record<string, unknown> : undefined
      if (type === 'tool_use' || (type === 'item.started' && item?.type !== 'agent_message')) this.emit('tool_started', agent.id, taskId, 'Provider reported a tool start.')
      else if (type === 'tool_result' || (type === 'item.completed' && item?.type !== 'agent_message')) this.emit('tool_completed', agent.id, taskId, 'Provider reported a completed tool.')
      else if (type === 'error') this.emit('agent_error', agent.id, taskId, String(parsed.message || 'Provider reported an error.'))
      else if ((type === 'assistant' || type === 'message') && parsed.role !== 'user') this.emit('agent_message', agent.id, taskId, 'Provider reported an assistant message.')
      else if (type === 'item.completed' && item?.type === 'agent_message') this.emit('agent_message', agent.id, taskId, 'Provider reported an assistant message.')
    }, (child) => { onChild?.(child); if (this.cancelRequested) terminate(child) })
    this.registry.setSession(agent.id, agent.providerId, this.root, output.sessionId)
    this.persist()
    return output
  }
  cancel() {
    if (!this.busy || this.cancelRequested) return false
    this.cancelRequested = true
    if (this.approvalWaiter) { this.approvalWaiter.resolve(false); this.approvalWaiter = undefined }
    if (this.active) {
      this.active.cancelled = true
      if (this.active.child) terminate(this.active.child)
      this.emit('agent_cancelled', this.active.agentId, this.active.taskId, 'Cancellation requested.')
    }
    return true
  }
  approveTask(taskId: string, approved: boolean) {
    if (!this.approvalWaiter || this.approvalWaiter.taskId !== taskId || this.active?.taskId !== taskId) return false
    this.approvalWaiter.resolve(approved); this.approvalWaiter = undefined
    return true
  }
  async clearHistory() {
    if (this.busy) throw new Error('Stop active work before clearing history.')
    this.tasks.clear(); this.events = []; this.conversations.clear(); this.conversations.set(this.root, []); this.registry.clearSessions(); this.persist()
    await mkdir(path.dirname(this.storagePath), { recursive: true });
    await writeFile(this.storagePath, JSON.stringify({ version: 1, agents: this.registry.list(), tasks: [], events: [], conversations: { [this.root]: [] } } satisfies SavedState), { encoding: 'utf8', mode: 0o600 })
    return this.snapshot()
  }
  dispose() { this.cancelRequested = true; this.approvalWaiter?.resolve(false); this.approvalWaiter = undefined; if (this.persistTimer) clearTimeout(this.persistTimer); if (this.active?.child) terminate(this.active.child) }
}

type Decision = { action: 'delegate'; agentId: Exclude<AgentRole, 'orchestrator'>; title: string; instructions: string } | { action: 'ask_user'; message: string } | { action: 'final'; message: string }
function parseDecision(text: string): Decision {
  const first = text.indexOf('{'); const last = text.lastIndexOf('}')
  if (first < 0 || last <= first) throw new Error('Orchestrator returned no valid JSON action.')
  let value: unknown
  try { value = JSON.parse(text.slice(first, last + 1)) } catch { throw new Error('Orchestrator returned invalid JSON.') }
  if (!value || typeof value !== 'object') throw new Error('Orchestrator action must be an object.')
  const action = value as Record<string, unknown>
  if (action.action === 'delegate' && ['codebase', 'coding', 'research', 'review'].includes(String(action.agentId)) && typeof action.title === 'string' && action.title.length <= 200 && typeof action.instructions === 'string' && action.instructions.length <= 20_000 && action.instructions.trim()) return action as Decision
  if ((action.action === 'ask_user' || action.action === 'final') && typeof action.message === 'string' && action.message.trim() && action.message.length <= 20_000) return action as Decision
  throw new Error('Orchestrator action does not match the supported task contract.')
}

function parseAgentReport(text: string) {
  const first = text.indexOf('{'); const last = text.lastIndexOf('}')
  if (first >= 0 && last > first) {
    try {
      const value = JSON.parse(text.slice(first, last + 1)) as Record<string, unknown>
      const stringArray = (key: string) => Array.isArray(value[key]) ? (value[key] as unknown[]).filter((item): item is string => typeof item === 'string').slice(0, 30).map((item) => item.slice(0, 2_000)) : []
      return { summary: typeof value.summary === 'string' ? value.summary.slice(0, 20_000) : text.slice(0, 20_000), findings: stringArray('findings'), verification: stringArray('verification'), errors: stringArray('errors') }
    } catch { /* Keep a plain-text fallback when a provider does not honor the task format. */ }
  }
  return { summary: text.slice(0, 20_000), findings: [], verification: [], errors: [] }
}

async function workspaceMetadata(root: string) {
  const records = new Map<string, string>()
  const ignored = new Set(['.git', 'node_modules', 'out', 'dist', 'build', '.next'])
  const visit = async (folder: string) => {
    if (records.size >= 12_000) return
    let entries
    try { entries = await readdir(folder, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (records.size >= 12_000) return
      if (entry.isDirectory() && ignored.has(entry.name)) continue
      const target = path.join(folder, entry.name)
      if (entry.isDirectory()) await visit(target)
      else if (entry.isFile()) {
        try { const info = await stat(target); records.set(path.relative(root, target), `${info.size}:${info.mtimeMs}`) } catch { /* race with an external file change */ }
      }
    }
  }
  await visit(root)
  return records
}

async function changedWorkspaceFiles(root: string, before: Map<string, string>) {
  const after = await workspaceMetadata(root)
  return [...new Set([...before.keys(), ...after.keys()])].filter((file) => before.get(file) !== after.get(file)).sort()
}

async function gitStatusAtStart(root: string) {
  return new Promise<string>((resolve) => {
    let child: ChildProcess
    try { child = spawn('git', ['status', '--short', '--branch'], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }) }
    catch { resolve('Git status unavailable.'); return }
    let output = ''; let settled = false
    const finish = (text: string) => { if (settled) return; settled = true; clearTimeout(timer); resolve(text.slice(0, 12_000)) }
    const timer = setTimeout(() => { child.kill(); finish('Git status timed out.') }, 4_000)
    child.stdout?.on('data', (chunk: Buffer) => { output = (output + chunk.toString()).slice(-12_000) })
    child.on('error', () => finish('Git status unavailable.'))
    child.on('close', (code) => finish(code === 0 ? output.trim() || 'No pre-existing Git changes.' : 'Git status unavailable.'))
  })
}
