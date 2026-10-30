import { useEffect, useMemo, useRef, useState } from 'react'
import { Bot, Check, CircleAlert, LoaderCircle, RefreshCw, Send, Settings, Square, Trash2 } from 'lucide-react'

const providerNames: Record<MultiAgentProvider, string> = { codex: 'Codex CLI', claude: 'Claude Code', gemini: 'Gemini CLI' }
const roleNames: Record<MultiAgentRole, string> = { orchestrator: 'Orchestrator', codebase: 'Codebase Agent', coding: 'Coding Agent', research: 'Research Agent', review: 'Review Agent' }

export default function MultiAgentWorkspace({ root, dirtyPaths, onAuth, onOpenFile, onRefresh }: { root: string; dirtyPaths: string[]; onAuth: (provider: MultiAgentProvider) => void; onOpenFile: (path: string) => void; onRefresh: () => void }) {
  const [snapshot, setSnapshot] = useState<MultiAgentSnapshot | null>(null)
  const [providers, setProviders] = useState<MultiAgentStatus[]>([])
  const [events, setEvents] = useState<MultiAgentEvent[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [selectedAgent, setSelectedAgent] = useState<MultiAgentRole>('orchestrator')
  const [selectedTask, setSelectedTask] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [checking, setChecking] = useState(false)
  const [approval, setApproval] = useState<MultiAgentEvent | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const onRefreshRef = useRef(onRefresh)
  onRefreshRef.current = onRefresh

  const refresh = async () => {
    const next = await window.workspaceAPI.multiAgentSnapshot()
    setSnapshot(next)
    setEvents(next.events)
  }
  const checkProviders = async () => {
    setChecking(true)
    try { setProviders(await window.workspaceAPI.multiAgentProviders()) }
    finally { setChecking(false) }
  }
  useEffect(() => {
    void refresh().catch((e: Error) => setError(e.message))
    void checkProviders()
    return window.workspaceAPI.onMultiAgentEvent((event) => {
      setEvents((current) => [...current.slice(-299), event])
      if (event.type === 'approval_required') setApproval(event)
      if (event.type === 'run_finished') setApproval(null)
      if (event.type === 'agent_completed' && event.agentId === 'coding') onRefreshRef.current()
      if (event.type === 'orchestrator_message' && event.data && typeof event.data === 'object' && (event.data as { role?: string }).role === 'user') return
      void refresh().catch((e: Error) => setError(e.message))
    })
  }, [root])
  useEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight }, [snapshot?.conversation, events, busy])

  const selected = snapshot?.agents.find((agent) => agent.id === selectedAgent)
  const selectedTaskDetails = snapshot?.tasks.find((task) => task.id === selectedTask) || snapshot?.tasks.at(-1)
  const statuses = useMemo(() => new Map(providers.map((item) => [item.providerId, item])), [providers])
  const run = async () => {
    if (!input.trim() || busy) return
    const request = input.trim(); setInput(''); setError(''); setBusy(true)
    try { await window.workspaceAPI.multiAgentStart(request, dirtyPaths); await refresh() }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); await refresh().catch(() => undefined) }
    finally { setBusy(false) }
  }
  const updateConfig = async (patch: Partial<Pick<MultiAgentAgent, 'providerId' | 'model' | 'instructions' | 'timeoutMs' | 'filesystemPermission'>>) => {
    if (!selected) return
    try { const updated = await window.workspaceAPI.multiAgentConfigure(selected.id, patch); setSnapshot((old) => old ? { ...old, agents: old.agents.map((agent) => agent.id === updated.id ? updated : agent) } : old); await checkProviders() }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }
  const clear = async () => {
    if (busy || !window.confirm('Clear Multi-Agent conversation and task history?')) return
    try { setSnapshot(await window.workspaceAPI.multiAgentClear()); setEvents([]); setError('') }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  return <section className="multi-agent-workspace">
    <header className="multi-agent-header"><div><Bot size={17} /><strong>Multi-Agent</strong><span className="multi-agent-root" title={root}>{root.split(/[\\/]/).filter(Boolean).at(-1) || 'No workspace'}</span></div><div><button title="Refresh CLI availability" onClick={() => void checkProviders()} disabled={checking}><RefreshCw size={14} className={checking ? 'agent-spin' : ''} /></button><button title="Clear Multi-Agent history" onClick={() => void clear()} disabled={busy}><Trash2 size={14} /></button></div></header>
    {!root && <div className="multi-agent-warning"><CircleAlert size={14} />Open a workspace to use Multi-Agent.</div>}
    <div className="multi-agent-grid">
      <aside className="multi-agent-agents"><div className="multi-agent-section-title">AGENTS</div>{snapshot?.agents.map((agent) => {
        const status = statuses.get(agent.providerId)
        const active = events.slice().reverse().find((event) => event.agentId === agent.id && event.type === 'agent_started')
        const finished = events.slice().reverse().find((event) => event.agentId === agent.id && ['agent_completed', 'agent_error', 'agent_cancelled', 'run_finished'].includes(event.type))
        const running = Boolean(active && (!finished || finished.time < active.time))
        return <button key={agent.id} className={`multi-agent-agent ${selectedAgent === agent.id ? 'selected' : ''}`} onClick={() => { setSelectedAgent(agent.id); setSettingsOpen(true) }}><span className="multi-agent-agent-name">{agent.name}</span><small>{providerNames[agent.providerId]}</small><span className={`multi-agent-dot ${status?.installed && status.authenticated === true ? 'ready' : status?.installed && status.authenticated === 'unknown' ? 'unknown' : ''}`} title={status?.error || (status?.authenticated === 'unknown' ? 'Authentication will be checked by the CLI when it runs.' : status?.authenticated ? 'Authenticated' : 'Unavailable')} />{running && <small className="multi-agent-current">Working…</small>}</button>
      })}</aside>
      <section className="multi-agent-chat">
        <div className="multi-agent-chat-scroll" ref={scrollRef}>
          {(!snapshot?.conversation.length && events.length === 0) && <div className="multi-agent-welcome"><Bot size={30} /><strong>Delegate work across your agents</strong><span>The Orchestrator plans and coordinates. Each role has its own provider and task session.</span></div>}
          {snapshot?.conversation.map((message, index) => <article className={`multi-agent-message ${message.role}`} key={`${message.time}-${index}`}><small>{message.role === 'user' ? 'YOU' : 'ORCHESTRATOR'}</small><div>{message.content}</div></article>)}
          {error && <div className="multi-agent-error"><CircleAlert size={14} />{error}</div>}
          {busy && <div className="multi-agent-running"><LoaderCircle size={14} className="agent-spin" /> Orchestrator is coordinating sequential tasks…</div>}
        </div>
        {approval && <div className="multi-agent-approval"><div><strong>Approval required</strong><span>{approval.detail}</span></div><button className="secondary-button" onClick={() => { if (approval.taskId) void window.workspaceAPI.multiAgentApprove(approval.taskId, false); setApproval(null) }}>Deny</button><button className="primary-button" onClick={() => { if (approval.taskId) void window.workspaceAPI.multiAgentApprove(approval.taskId, true); setApproval(null) }}><Check size={13} /> Allow</button></div>}
        <form className="multi-agent-input" onSubmit={(event) => { event.preventDefault(); void run() }}><textarea value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void run() } }} placeholder="Describe work for the Orchestrator…" disabled={busy || !root} /><div><small>Enter to send · Shift+Enter for a new line{dirtyPaths.length ? ` · ${dirtyPaths.length} unsaved file(s)` : ''}</small>{busy ? <button type="button" className="agent-stop" onClick={() => void window.workspaceAPI.multiAgentCancel()}><Square size={13} /> Stop</button> : <button type="submit" className="primary-button" disabled={!input.trim() || !root}><Send size={13} /> Send</button>}</div></form>
      </section>
      <aside className="multi-agent-details"><div className="multi-agent-section-title">TASK DETAILS</div>{selectedTaskDetails ? <><label>Task<select value={selectedTaskDetails.id} onChange={(event) => setSelectedTask(event.target.value)}>{snapshot?.tasks.slice().reverse().map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}</select></label><dl><dt>Agent</dt><dd>{roleNames[selectedTaskDetails.assignedAgentId]}</dd><dt>Provider</dt><dd>{providerNames[snapshot?.agents.find((agent) => agent.id === selectedTaskDetails.assignedAgentId)?.providerId || 'codex']}</dd><dt>Status</dt><dd>{selectedTaskDetails.status}</dd><dt>Workspace</dt><dd title={selectedTaskDetails.root}>{selectedTaskDetails.root?.split(/[\\/]/).filter(Boolean).at(-1) || 'Current workspace'}</dd><dt>Dependencies</dt><dd>{selectedTaskDetails.dependencies.length || 'None'}</dd></dl><h4>{selectedTaskDetails.title}</h4><p>{selectedTaskDetails.instructions}</p><div className="multi-agent-detail-result">{events.slice().reverse().find((event) => event.taskId === selectedTaskDetails.id && ['agent_completed', 'agent_error', 'agent_cancelled'].includes(event.type))?.detail || 'Waiting for task result.'}</div>{(() => { const event = events.slice().reverse().find((item) => item.taskId === selectedTaskDetails.id && ['agent_completed', 'agent_error', 'agent_cancelled'].includes(item.type)); const files = event?.data && typeof event.data === 'object' && Array.isArray((event.data as { changedFiles?: unknown }).changedFiles) ? (event.data as { changedFiles: string[] }).changedFiles : []; const taskRoot = selectedTaskDetails.root || root; return files.length ? <div className="multi-agent-changed-files"><h4>CHANGED FILES</h4>{files.map((file) => <button key={file} title={file} onClick={() => onOpenFile(`${taskRoot}${taskRoot.endsWith('/') || taskRoot.endsWith('\\') ? '' : '\\'}${file}`)}>{file}</button>)}</div> : null })()}</> : <p>No tasks yet. The Orchestrator will add tasks when delegation is useful.</p>}</aside>
    </div>
    <section className="multi-agent-activity"><div className="multi-agent-section-title">EXECUTION ACTIVITY</div><div>{events.slice(-40).map((event) => <div className={`multi-agent-event ${event.type.includes('error') ? 'failed' : ''}`} key={event.id}><time>{new Date(event.time).toLocaleTimeString()}</time><b>{event.agentId ? roleNames[event.agentId] : 'Friday'}</b><span>{event.detail || event.type.replaceAll('_', ' ')}</span></div>)}{events.length === 0 && <span className="multi-agent-muted">Actual CLI events appear here when a task runs.</span>}</div></section>
    {settingsOpen && selected && <div className="multi-agent-config-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) setSettingsOpen(false) }}><section className="multi-agent-config"><header><h2><Settings size={16} /> {selected.name} settings</h2><button onClick={() => setSettingsOpen(false)}>Close</button></header><label>Provider<select disabled={busy} value={selected.providerId} onChange={(event) => void updateConfig({ providerId: event.target.value as MultiAgentProvider })}><option value="codex">Codex CLI</option><option value="claude">Claude Code</option><option value="gemini">Gemini CLI</option></select></label>{(() => { const status = statuses.get(selected.providerId); const statusClass = !status?.installed || status.authenticated === false ? 'missing' : status.authenticated === 'unknown' ? 'unknown' : 'ready'; return <div className={`multi-agent-provider-status ${statusClass}`}>{status?.installed ? `${status.version || providerNames[selected.providerId]} · ${status.authenticated === 'unknown' ? 'authentication checked when run' : status.authenticated ? `authenticated${status.authMethod ? ` (${status.authMethod})` : ''}` : 'not authenticated'}` : 'CLI not detected'}{status?.error && <small>{status.error}</small>}{status?.installed && status.authenticated !== true && <button className="secondary-button" onClick={() => { setSettingsOpen(false); onAuth(selected.providerId) }}>{status.authenticated === 'unknown' ? 'Open sign-in flow' : `Sign in with ${providerNames[selected.providerId]}`}</button>}</div> })()}<label>Filesystem permission<select disabled={busy} value={selected.filesystemPermission} onChange={(event) => void updateConfig({ filesystemPermission: event.target.value as MultiAgentAgent['filesystemPermission'] })}><option value="read-only">Read only</option><option value="workspace-write">Workspace write</option></select></label><p>Workspace write requires approval before the task starts. Each CLI enforces its own command and sandbox rules; Friday does not bypass them.</p><label>Model (optional)<input disabled={busy} value={selected.model} onChange={(event) => setSnapshot((old) => old ? { ...old, agents: old.agents.map((agent) => agent.id === selected.id ? { ...agent, model: event.target.value } : agent) } : old)} onBlur={(event) => void updateConfig({ model: event.target.value })} placeholder="CLI default" /></label><label>Task timeout (seconds)<input disabled={busy} type="number" min="10" max="1800" value={Math.round(selected.timeoutMs / 1000)} onChange={(event) => setSnapshot((old) => old ? { ...old, agents: old.agents.map((agent) => agent.id === selected.id ? { ...agent, timeoutMs: Number(event.target.value) * 1000 } : agent) } : old)} onBlur={(event) => void updateConfig({ timeoutMs: Number(event.target.value) * 1000 })} /></label><label>Role instructions<textarea disabled={busy} value={selected.instructions} onChange={(event) => setSnapshot((old) => old ? { ...old, agents: old.agents.map((agent) => agent.id === selected.id ? { ...agent, instructions: event.target.value } : agent) } : old)} onBlur={(event) => void updateConfig({ instructions: event.target.value })} /></label><p>Friday does not store CLI credentials. Authentication remains with the selected CLI.</p></section></div>}
  </section>
}
