import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { BrowserWindow } from 'electron'

type RpcId = string | number
type RpcObject = { id?: RpcId; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message?: string; code?: number } }
type PendingRpc = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
type Approval = { rpcId: RpcId; method: string; params: Record<string, unknown> }
type ActiveTask = { id: string; status: 'running' | 'waiting_for_approval' | 'cancelling' | 'completed' | 'failed' | 'cancelled'; startedAt: number; turnId?: string; result: string; changedFiles: Set<string>; settled: boolean }

const DEVELOPER_INSTRUCTIONS = `You are Friday's single coding agent. Inspect the open workspace and its Git status before editing. Preserve pre-existing changes and existing behavior. Make focused changes, verify them, and report what was actually changed and checked. Use the workspace tools available through Codex. Do not claim a task is complete while tools or checks are still running. Ask before actions that Codex marks as requiring approval, and report errors honestly. Friday runs one agent for this task; do not delegate or create subagents.`
const MAX_LINE = 4_000_000
const MAX_TEXT = 28_000
const trim = (text: string) => text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n[output truncated]` : text
const within = (root: string, candidate: string) => { const relative = path.relative(path.resolve(root), path.resolve(candidate)); return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) }

function commandForCodex() {
  if (process.platform !== 'win32') return { command: 'codex', args: ['app-server', '--listen', 'stdio://'] }
  const installed = process.env.APPDATA ? path.join(process.env.APPDATA, 'npm', 'codex.cmd') : ''
  const command = installed && existsSync(installed) ? installed : 'codex.cmd'
  return { command, args: ['app-server', '--listen', 'stdio://'], shell: true as const }
}

function codexEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  const home = process.env.HOME || process.env.USERPROFILE || (process.env.HOMEDRIVE && process.env.HOMEPATH ? path.join(process.env.HOMEDRIVE, process.env.HOMEPATH) : undefined)
  if (home) env.HOME = home
  if (!env.CODEX_HOME && home) env.CODEX_HOME = path.join(home, '.codex')
  return env
}

export async function checkCodexCli(timeoutMs = 8_000, spawnProcess: typeof spawn = spawn) {
  const launch = process.platform === 'win32'
    ? (() => { const installed = process.env.APPDATA ? path.join(process.env.APPDATA, 'npm', 'codex.cmd') : ''; return { command: installed && existsSync(installed) ? installed : 'codex.cmd', args: ['--version'], shell: true as const } })()
    : { command: 'codex', args: ['--version'], shell: false as const }
  return new Promise<{ provider: string; available: boolean; version?: string; error?: string }>((resolve) => {
    let output = ''; let settled = false; let timer: NodeJS.Timeout | undefined
    const finish = (value: { provider: string; available: boolean; version?: string; error?: string }) => { if (settled) return; settled = true; if (timer) clearTimeout(timer); resolve(value) }
    let child: ReturnType<typeof spawn>
    try { child = spawnProcess(launch.command, launch.args, { shell: launch.shell, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }) }
    catch (error) { return finish({ provider: 'Codex CLI', available: false, error: error instanceof Error ? error.message : String(error) }) }
    timer = setTimeout(() => { child.kill(); finish({ provider: 'Codex CLI', available: false, error: 'Codex CLI version check timed out.' }) }, timeoutMs)
    child.stdout?.on('data', (chunk: Buffer) => { output = (output + chunk.toString()).slice(0, 400) })
    child.stderr?.on('data', (chunk: Buffer) => { output = (output + chunk.toString()).slice(0, 400) })
    child.on('error', (error) => finish({ provider: 'Codex CLI', available: false, error: `Could not start Codex CLI: ${error.message}. Install it and make sure it is on PATH.` }))
    child.on('close', (code) => finish(code === 0
      ? { provider: 'Codex CLI', available: true, version: output.trim().split(/\r?\n/).find((line) => /codex-cli/i.test(line))?.trim() || output.trim() || 'available' }
      : { provider: 'Codex CLI', available: false, error: output.trim() || 'Codex CLI was not found. Install it and make sure it is on PATH.' }))
  })
}

export class FridayAgent {
  private readonly getWindow: () => BrowserWindow | null
  private readonly spawnProcess: typeof spawn
  private child?: ChildProcessWithoutNullStreams
  private root = ''
  private threadRoot = ''
  private threadId = ''
  private initialized?: Promise<void>
  private sequence = 0
  private readonly pending = new Map<string, PendingRpc>()
  private readonly approvals = new Map<string, Approval>()
  private task?: ActiveTask
  private currentTurnCompletion?: { resolve: (value: { status: string; error?: string }) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  private stderr = ''

  constructor(getWindow: () => BrowserWindow | null, spawnProcess: typeof spawn = spawn) { this.getWindow = getWindow; this.spawnProcess = spawnProcess }
  setRoot(root: string) { this.root = path.resolve(root) }
  async status() { return checkCodexCli(8_000, this.spawnProcess) }
  async testConnection() {
    const cli = await checkCodexCli(8_000, this.spawnProcess)
    if (!cli.available) return cli
    try { await this.ensureThread(); return { ...cli, appServerReady: true, message: 'Codex app-server and workspace thread are ready. Sign-in is checked when you send the first task.' } }
    catch (error) { return { ...cli, appServerReady: false, error: error instanceof Error ? error.message : String(error) } }
  }
  private emit(type: string, detail: Record<string, unknown> = {}) { this.getWindow()?.webContents.send('agent:event', { type, taskId: this.task?.id, time: Date.now(), ...detail }) }
  private write(message: Record<string, unknown>) {
    if (!this.child || this.child.killed || !this.child.stdin.writable) throw new Error('Codex app-server is not running.')
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }
  private notify(method: string, params: Record<string, unknown> = {}) { this.write({ method, params }) }
  private rpc(method: string, params: Record<string, unknown> = {}, timeoutMs = 20_000): Promise<unknown> {
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(String(id)); reject(new Error(`Codex app-server request timed out: ${method}`)) }, timeoutMs)
      this.pending.set(String(id), { resolve, reject, timer })
      try { this.write({ id, method, params }) } catch (error) { clearTimeout(timer); this.pending.delete(String(id)); reject(error instanceof Error ? error : new Error(String(error))) }
    })
  }
  private rejectPending(error: Error) {
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error) }
    this.pending.clear()
    this.currentTurnCompletion?.reject(error)
    if (this.currentTurnCompletion) clearTimeout(this.currentTurnCompletion.timer)
    this.currentTurnCompletion = undefined
  }
  private async ensureServer() {
    if (this.initialized) return this.initialized
    this.initialized = (async () => {
      if (!this.root || !existsSync(this.root)) throw new Error('Open an existing workspace before starting Codex.')
      const launch = commandForCodex()
      let child: ReturnType<typeof spawn>
      try { child = this.spawnProcess(launch.command, launch.args, { cwd: this.root, env: codexEnvironment(), shell: launch.shell, detached: process.platform !== 'win32', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }) }
      catch (error) { throw new Error(`Could not start Codex CLI: ${error instanceof Error ? error.message : String(error)}. Install Codex CLI and make sure it is on PATH.`) }
      this.child = child as ChildProcessWithoutNullStreams
      this.stderr = ''
      let pendingLine = ''
      child.stdout?.on('data', (chunk: Buffer) => {
        pendingLine += chunk.toString('utf8')
        if (pendingLine.length > MAX_LINE) { const error = new Error('Codex app-server sent an oversized protocol message.'); this.rejectPending(error); this.disposeServer(); return }
        const lines = pendingLine.split(/\r?\n/); pendingLine = lines.pop() || ''
        for (const line of lines) if (line.trim()) {
          try { this.handleMessage(JSON.parse(line) as RpcObject) }
          catch (error) { const message = error instanceof Error ? error.message : String(error); this.emit('protocol_error', { error: message }) }
        }
      })
      child.stderr?.on('data', (chunk: Buffer) => { this.stderr = (this.stderr + chunk.toString('utf8')).slice(-4_000) })
      child.on('error', (error) => { this.rejectPending(new Error(`Codex CLI failed: ${error.message}`)); this.child = undefined; this.initialized = undefined })
      child.on('close', (code, signal) => {
        if (this.child !== child) return
        const detail = this.stderr.trim()
        const suffix = detail ? ` ${detail.slice(-1000)}` : ''
        this.rejectPending(new Error(`Codex app-server exited${code === null ? ` (${signal || 'unknown signal'})` : ` with code ${code}`}.${suffix}`))
        this.child = undefined; this.threadId = ''; this.initialized = undefined
      })
      await this.rpc('initialize', { clientInfo: { name: 'friday', title: 'Friday', version: '0.1.0' }, capabilities: { experimentalApi: false } })
      this.notify('initialized')
    })().catch((error) => { this.initialized = undefined; throw error })
    return this.initialized
  }
  private handleMessage(message: RpcObject) {
    if (message.method) {
      if (message.id !== undefined) { void this.handleServerRequest(message.id, message.method, message.params || {}).catch((error) => this.emit('protocol_error', { error: error instanceof Error ? error.message : String(error) })); return }
      this.handleNotification(message.method, message.params || {})
      return
    }
    if (message.id === undefined) return
    const pending = this.pending.get(String(message.id))
    if (!pending) return
    this.pending.delete(String(message.id)); clearTimeout(pending.timer)
    if (message.error) pending.reject(new Error(message.error.message || 'Codex app-server request failed.'))
    else pending.resolve(message.result)
  }
  private handleNotification(method: string, params: Record<string, unknown>) {
    if (method === 'turn/started' && params.turn && typeof params.turn === 'object' && this.task) this.task.turnId = String((params.turn as { id?: unknown }).id || this.task.turnId || '')
    if (method === 'item/agentMessage/delta' && typeof params.delta === 'string' && this.task) {
      this.task.result = trim(this.task.result + params.delta)
      this.emit('model_delta', { iteration: 1, channel: 'content', delta: params.delta })
      return
    }
    if ((method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta') && typeof params.delta === 'string') {
      this.emit('model_delta', { iteration: 1, channel: 'reasoning', delta: params.delta })
      return
    }
    if (method === 'item/started') {
      const item = params.item && typeof params.item === 'object' ? params.item as Record<string, unknown> : {}
      const type = String(item.type || 'Codex activity')
      const name = type === 'commandExecution' ? 'run command' : type === 'fileChange' ? 'change files' : type === 'reasoning' ? 'reasoning' : type
      this.emit('tool_started', { name, itemId: item.id, details: { type, ...(typeof item.command === 'string' ? { command: item.command } : {}), ...(typeof item.cwd === 'string' ? { cwd: item.cwd } : {}), ...(typeof item.path === 'string' ? { path: item.path } : {}) } })
      return
    }
    if (method === 'item/commandExecution/outputDelta' && typeof params.delta === 'string') {
      this.emit('command_output', { itemId: params.itemId, delta: params.delta.slice(0, 2_000) })
      return
    }
    if (method === 'turn/diff/updated' && typeof params.diff === 'string') {
      const diff = params.diff
      this.emit('diff_updated', { diff: trim(diff) })
      const changedPaths = new Set<string>()
      for (const match of diff.matchAll(/^(?:\+\+\+ b\/|--- a\/)(.+)$/gm)) changedPaths.add(match[1].replace(/^"|"$/g, ''))
      for (const changedPath of changedPaths) {
        const fullPath = path.resolve(this.root, changedPath)
        if (within(this.root, fullPath) && !this.task?.changedFiles.has(fullPath)) { this.task?.changedFiles.add(fullPath); this.emit('file_changed', { path: fullPath, operation: 'Codex change' }) }
      }
      return
    }
    if (method === 'turn/completed') this.completeTurn(params.turn && typeof params.turn === 'object' ? params.turn as Record<string, unknown> : {})
    else if (method === 'item/completed') {
      const item = params.item && typeof params.item === 'object' ? params.item as Record<string, unknown> : {}
      if (item.type === 'commandExecution' || item.type === 'fileChange') this.emit('tool_completed', { name: item.type === 'commandExecution' ? 'run command' : 'change files', result: trim(JSON.stringify(item)) })
    }
  }
  private completeTurn(turn: Record<string, unknown>) {
    const task = this.task
    const waiter = this.currentTurnCompletion
    if (!task || !waiter || task.settled) return
    const status = String(turn.status || 'failed')
    const error = turn.error && typeof turn.error === 'object' ? String((turn.error as { message?: unknown }).message || 'Codex turn failed.') : undefined
    if (status === 'completed') {
      const diff = (turn.items as unknown[] | undefined) || []
      for (const value of diff) {
        if (!value || typeof value !== 'object') continue
        const item = value as Record<string, unknown>
        if (item.type === 'fileChange' && typeof item.path === 'string') {
          const fullPath = path.resolve(this.root, item.path)
          if (within(this.root, fullPath)) { task.changedFiles.add(fullPath); this.emit('file_changed', { path: fullPath, operation: 'Codex change', diff: item.diff }) }
        }
      }
    }
    clearTimeout(waiter.timer); this.currentTurnCompletion = undefined; waiter.resolve({ status, ...(error ? { error } : {}) })
  }
  private async handleServerRequest(id: RpcId, method: string, params: Record<string, unknown>) {
    if (method === 'item/permissions/requestApproval') {
      this.write({ id, error: { code: -32000, message: 'Friday does not grant permissions outside the configured workspace sandbox.' } })
      this.emit('permission_denied', { reason: 'Codex requested permissions beyond the workspace sandbox.', details: params })
      return
    }
    const supported = new Set(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'applyPatchApproval', 'execCommandApproval'])
    if (!supported.has(method)) {
      this.write({ id, error: { code: -32601, message: 'Friday does not support this Codex approval request.' } })
      this.emit('permission_denied', { reason: 'Friday denied an unsupported Codex permission request.', details: { method, ...params } })
      return
    }
    const approvalId = randomUUID()
    this.approvals.set(approvalId, { rpcId: id, method, params })
    if (this.task) this.task.status = 'waiting_for_approval'
    const action = method.includes('command') || method === 'execCommandApproval' ? 'Run Codex command' : 'Apply Codex file changes'
    this.emit('approval_required', { approvalId, action, reason: String(params.reason || 'Codex requested approval for this operation.'), details: params })
  }
  decide(approvalId: string, approved: boolean) {
    const approval = this.approvals.get(approvalId)
    if (!approval || !this.child) return false
    this.approvals.delete(approvalId)
    let result: Record<string, unknown>
    if (approval.method === 'applyPatchApproval') result = { decision: approved ? 'approved' : { denied: { rejection: 'Friday user rejected this operation.' } } }
    else result = { decision: approved ? 'accept' : 'decline' }
    this.write({ id: approval.rpcId, result })
    if (this.task && !this.approvals.size && this.task.status === 'waiting_for_approval') this.task.status = 'running'
    return true
  }
  private async ensureThread() {
    await this.ensureServer()
    if (this.threadId && this.threadRoot === this.root) return
    const response = await this.rpc('thread/start', {
      cwd: this.root,
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
      ephemeral: true,
      developerInstructions: DEVELOPER_INSTRUCTIONS
    }) as { thread?: { id?: string } }
    if (!response?.thread?.id) throw new Error('Codex app-server did not return a thread ID.')
    this.threadId = response.thread.id
    this.threadRoot = this.root
  }
  async send(request: string, opts: { buffers?: Array<{ path: string; content: string; dirty: boolean }>; history?: Array<{ role: 'user' | 'assistant'; content: string }> } = {}): Promise<{ taskId: string; result?: string; cancelled?: boolean; changedFiles: string[] }> {
    if (this.task && ['running', 'waiting_for_approval', 'cancelling'].includes(this.task.status)) throw new Error('A Codex task is already active.')
    if (!this.root) throw new Error('Open a workspace before starting the Friday Agent.')
    if (typeof request !== 'string' || !request.trim() || request.length > 12_000) throw new Error('Enter a request under 12,000 characters.')
    const dirty = (opts.buffers || []).filter((buffer) => buffer.dirty).map((buffer) => buffer.path)
    if (dirty.length) throw new Error(`Save your unsaved editor changes before starting Codex. Dirty files: ${dirty.slice(0, 8).join(', ')}`)
    const task: ActiveTask = { id: randomUUID(), status: 'running', startedAt: Date.now(), result: '', changedFiles: new Set(), settled: false }
    this.task = task
    this.emit('task_started', { request: request.trim() })
    this.emit('context_ready', { detail: `Codex will inspect ${this.root} directly.`, provider: 'Codex CLI' })
    this.emit('model_request', { iteration: 1 })
    try {
      await this.ensureThread()
      const gitBaseline = await this.gitBaseline()
      const preamble = `${DEVELOPER_INSTRUCTIONS}\n\nWorkspace root: ${this.root}\nExisting Git status at task start (preserve these user changes):\n${gitBaseline}\n\nUser request:\n${request.trim()}`
      const completion = new Promise<{ status: string; error?: string }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Codex task exceeded Friday’s 30-minute task limit.')), 30 * 60_000)
        this.currentTurnCompletion = { resolve, reject, timer }
      })
      const response = await this.rpc('turn/start', {
        threadId: this.threadId,
        cwd: this.root,
        input: [{ type: 'text', text: preamble }],
        effort: 'high',
        approvalPolicy: 'on-request',
        sandboxPolicy: { type: 'workspaceWrite', writableRoots: [this.root], networkAccess: false, excludeSlashTmp: true, excludeTmpdirEnvVar: true }
      }, 60_000) as { turn?: { id?: string; status?: string } }
      task.turnId = response?.turn?.id || task.turnId
      if (!task.turnId) throw new Error('Codex app-server did not return a turn ID.')
      const outcome = await completion
      if (task.status === 'cancelling' || outcome.status === 'interrupted' || outcome.status === 'cancelled') {
        task.status = 'cancelled'; task.settled = true
        const result = { taskId: task.id, cancelled: true, changedFiles: [...task.changedFiles] }
        this.emit('task_cancelled', { durationMs: Date.now() - task.startedAt, changedFiles: result.changedFiles }); return result
      }
      if (outcome.status !== 'completed') throw new Error(outcome.error || `Codex turn ended with status ${outcome.status}.`)
      task.status = 'completed'; task.settled = true
      const changedFiles = [...task.changedFiles]
      const result = task.result.trim() || 'Codex completed the task without an assistant message.'
      this.emit('task_completed', { result, changedFiles, durationMs: Date.now() - task.startedAt })
      return { taskId: task.id, result, changedFiles }
    } catch (error) {
      if (this.currentTurnCompletion) { clearTimeout(this.currentTurnCompletion.timer); this.currentTurnCompletion = undefined }
      if (task.status === 'cancelling') {
        task.status = 'cancelled'; task.settled = true
        const result = { taskId: task.id, cancelled: true, changedFiles: [...task.changedFiles] }
        this.emit('task_cancelled', { durationMs: Date.now() - task.startedAt, changedFiles: result.changedFiles }); return result
      }
      task.status = 'failed'; task.settled = true
      const message = error instanceof Error ? error.message : String(error)
      const helpful = /login|auth|not authenticated|unauthorized/i.test(message) ? `${message} Sign in to Codex CLI in a terminal, then retry.` : message
      this.emit('task_failed', { error: helpful, changedFiles: [...task.changedFiles] })
      this.disposeServer()
      throw new Error(helpful)
    }
  }
  private async gitBaseline() {
    return new Promise<string>((resolve) => {
      let child: ReturnType<typeof spawn>
      try { child = this.spawnProcess('git', ['status', '--short', '--branch'], { cwd: this.root, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }) }
      catch { resolve('Git status unavailable.'); return }
      let output = ''; const timer = setTimeout(() => { child.kill(); resolve('Git status timed out.') }, 3_000)
      child.stdout?.on('data', (chunk: Buffer) => { output = trim(output + chunk.toString()) })
      child.on('error', () => { clearTimeout(timer); resolve('Git status unavailable.') })
      child.on('close', (code) => { clearTimeout(timer); resolve(code === 0 ? output || 'No pre-existing Git changes.' : 'Git status unavailable.') })
    })
  }
  cancel() {
    const task = this.task
    if (!task || !['running', 'waiting_for_approval'].includes(task.status)) return false
    task.status = 'cancelling'
    for (const [approvalId, approval] of this.approvals) {
      this.write({ id: approval.rpcId, result: { decision: approval.method === 'applyPatchApproval' ? 'abort' : 'cancel' } })
      this.approvals.delete(approvalId)
    }
    this.emit('cancelling')
    if (task.turnId && this.threadId) {
      void this.rpc('turn/interrupt', { threadId: this.threadId, turnId: task.turnId }, 5_000).catch(() => undefined)
      const guard = setTimeout(() => { if (this.task === task && !task.settled) this.disposeServer() }, 8_000)
      guard.unref()
    } else this.disposeServer()
    return true
  }
  disposeServer() {
    const child = this.child
    this.child = undefined; this.initialized = undefined; this.threadId = ''; this.threadRoot = ''; this.approvals.clear()
    this.rejectPending(new Error('Codex app-server was stopped.'))
    if (child && !child.killed) {
      if (process.platform === 'win32' && child.pid) {
        const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
        killer.on('error', () => child.kill())
      } else if (child.pid && process.platform !== 'win32') {
        try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill() }
      } else child.kill()
    }
  }
  dispose() { this.disposeServer() }
  statusSnapshot() { return { available: Boolean(this.task), task: this.task ? { id: this.task.id, status: this.task.status } : null } }
}
