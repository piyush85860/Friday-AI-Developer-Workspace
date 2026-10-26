import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import test from 'node:test'
import type { SpawnOptions } from 'node:child_process'
import { FridayAgent } from './agent.ts'

type Message = { id?: string | number; method?: string; params?: Record<string, unknown>; result?: unknown }
class FakeChild extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  stdin: Writable
  killed = false
  readonly requests: Message[] = []
  private readonly onMessage: (child: FakeChild, message: Message) => void
  constructor(onMessage: (child: FakeChild, message: Message) => void) {
    super()
    this.onMessage = onMessage
    this.stdin = new Writable({ write: (chunk, _encoding, callback) => { for (const line of chunk.toString().split(/\r?\n/)) if (line.trim()) { const message = JSON.parse(line) as Message; this.requests.push(message); this.onMessage(this, message) }; callback() } })
  }
  send(message: Message | Record<string, unknown>) { this.stdout.write(`${JSON.stringify(message)}\n`) }
  kill() { if (!this.killed) { this.killed = true; queueMicrotask(() => this.emit('close', null, 'SIGTERM')) }; return true }
}

function createHarness(options: { approve?: boolean; waitForInterrupt?: boolean } = {}) {
  const events: Array<Record<string, unknown>> = []; const children: FakeChild[] = []; let agent!: FridayAgent
  const fakeSpawn = ((command: string, args: string[], _options: SpawnOptions) => {
    if (command === 'git' && args[0] === 'status') {
      const child = new FakeChild(() => undefined); children.push(child)
      queueMicrotask(() => { child.stdout.write('## main\n'); child.emit('close', 0, null) })
      return child
    }
    if (args[0] === '--version') {
      const child = new FakeChild(() => undefined); children.push(child)
      queueMicrotask(() => { child.stdout.write('codex-cli 0.162.1\n'); child.emit('close', 0, null) })
      return child
    }
    const child = new FakeChild((self, message) => {
      if (message.method === 'initialize') self.send({ id: message.id!, result: { serverInfo: { name: 'codex', version: 'test' } } })
      if (message.method === 'thread/start') self.send({ id: message.id!, result: { thread: { id: 'thread-1' } } })
      if (message.method === 'turn/start') {
        self.send({ id: message.id!, result: { turn: { id: 'turn-1', status: 'inProgress' } } })
        if (options.approve) self.send({ id: 'approval-1', method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', command: 'npm run typecheck', cwd: process.cwd(), reason: 'The check needs approval.' } })
        else if (!options.waitForInterrupt) queueMicrotask(() => {
          self.send({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-1' } } })
          self.send({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', delta: 'Codex inspected the project.' } })
          self.send({ method: 'turn/diff/updated', params: { threadId: 'thread-1', turnId: 'turn-1', diff: 'diff --git a/note.txt b/note.txt\n--- /dev/null\n+++ b/note.txt\n+created\n' } })
          self.send({ method: 'turn/completed', params: { thread: { id: 'thread-1' }, turn: { id: 'turn-1', status: 'completed', items: [] } } })
        })
      }
      if (message.id === 'approval-1' && message.result) self.send({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed', items: [] } } })
      if (message.method === 'turn/interrupt') {
        self.send({ id: message.id!, result: {} })
        self.send({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'interrupted', items: [] } } })
      }
    }); children.push(child); return child
  }) as unknown as typeof import('node:child_process').spawn
  agent = new FridayAgent(() => ({ webContents: { send: (_channel: string, event: Record<string, unknown>) => {
    events.push(event)
    if (options.approve && event.type === 'approval_required' && typeof event.approvalId === 'string') agent.decide(event.approvalId, true)
  } } } as never), fakeSpawn)
  agent.setRoot(process.cwd())
  return { agent, events, children }
}

test('checks local Codex CLI availability without requiring an API key', async () => {
  const { agent } = createHarness()
  const status = await agent.status()
  assert.equal(status.available, true)
  assert.equal(status.version, 'codex-cli 0.162.1')
})

test('starts app-server, initializes, starts one scoped thread, streams the assistant response and captures changed files', async () => {
  const { agent, events, children } = createHarness()
  const result = await agent.send('Create a note')
  assert.equal(result.result, 'Codex inspected the project.')
  assert.equal(result.changedFiles.length, 1)
  assert.ok(events.some((event) => event.type === 'model_delta' && event.delta === 'Codex inspected the project.'))
  const appServer = children.find((child) => child.requests.some((message) => message.method === 'initialize'))
  assert.ok(appServer)
  assert.ok(appServer.requests.some((message) => message.method === 'initialized'))
  const thread = appServer.requests.find((message) => message.method === 'thread/start')?.params
  assert.equal(thread?.sandbox, 'workspace-write')
  assert.equal(thread?.approvalPolicy, 'on-request')
  assert.equal(thread?.runtimeWorkspaceRoots, undefined)
  const turn = appServer.requests.find((message) => message.method === 'turn/start')?.params
  assert.equal((turn?.sandboxPolicy as { type: string }).type, 'workspaceWrite')
  assert.equal((turn?.input as Array<{ type: string; text: string }>)[0].type, 'text')
})

test('routes Codex command approval through Friday approval UI and responds to the server request', async () => {
  const { agent, events, children } = createHarness({ approve: true })
  const result = await agent.send('Run typecheck')
  assert.equal(result.result, 'Codex completed the task without an assistant message.')
  const approval = events.find((event) => event.type === 'approval_required')
  assert.ok(approval)
  assert.equal(approval.action, 'Run Codex command')
  const server = children.find((child) => child.requests.some((message) => message.method === 'turn/start'))!
  assert.ok(server.requests.some((message) => message.id === 'approval-1' && (message.result as { decision?: string })?.decision === 'accept'))
})

test('blocks tasks when dirty editor buffers would be at risk', async () => {
  const { agent, children } = createHarness()
  await assert.rejects(agent.send('Change the open file', { buffers: [{ path: 'dirty.ts', content: 'unsaved', dirty: true }] }), /Save your unsaved editor changes/)
  assert.equal(children.length, 0)
})

test('interrupts the active Codex turn when cancelled', async () => {
  const { agent, children } = createHarness({ waitForInterrupt: true })
  const task = agent.send('Work until cancelled')
  for (let index = 0; index < 50 && !children.some((child) => child.requests.some((message) => message.method === 'turn/start')); index++) await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(agent.cancel(), true)
  const result = await task
  assert.equal(result.cancelled, true)
  assert.ok(children.some((child) => child.requests.some((message) => message.method === 'turn/interrupt')))
})
