import { useEffect, useRef, useState } from 'react'
import { Bot, Check, CircleAlert, LoaderCircle, Play, Send, Settings, Square, X } from 'lucide-react'

type AgentEvent = { type: string; taskId?: string; time: number; [key: string]: unknown }
type Message = { role: 'user' | 'assistant'; content: string }
type ModelTrace = { taskId: string; iteration: number; thinking: string; content: string }
type BufferInfo = { path: string; content: string; dirty: boolean }
type CodexStatus = { provider: string; available: boolean; version?: string; error?: string }
const labels: Record<string, string> = { task_started: 'Task started', baseline_ready: 'Git baseline collected', context_ready: 'Workspace context ready', model_request: 'Codex is working', tool_started: 'Codex activity', tool_completed: 'Codex activity completed', tool_failed: 'Codex activity failed', approval_required: 'Waiting for approval', file_changed: 'Workspace file changed', diff_updated: 'Workspace diff updated', command_output: 'Command output', permission_denied: 'Permission request denied', cancelling: 'Cancelling', task_completed: 'Task completed', task_failed: 'Task failed', task_cancelled: 'Task cancelled', protocol_error: 'Codex protocol error' }

export default function AgentPanel({ root, buffers, onOpenFile, onRefresh }: { root: string; buffers: BufferInfo[]; onOpenFile: (path: string) => void; onRefresh: () => void }) {
  const [messages, setMessages] = useState<Message[]>([]); const [events, setEvents] = useState<AgentEvent[]>([]); const [traces, setTraces] = useState<ModelTrace[]>([])
  const [input, setInput] = useState(''); const [status, setStatus] = useState<CodexStatus | null>(null); const [running, setRunning] = useState(false)
  const [approval, setApproval] = useState<AgentEvent | null>(null); const [error, setError] = useState(''); const [files, setFiles] = useState<string[]>([])
  const [settingsOpen, setSettingsOpen] = useState(false); const [settingsMessage, setSettingsMessage] = useState(''); const [checking, setChecking] = useState(false)
  const scroll = useRef<HTMLDivElement>(null); const refreshRef = useRef(onRefresh); refreshRef.current = onRefresh; const submitted = useRef(false)
  const check = async () => { try {
    const result = await window.workspaceAPI.agentStatus()
    if (!result || result.provider !== 'Codex CLI' || typeof result.available !== 'boolean') throw new Error('Friday is still using its old AI process. Fully quit and restart Friday to load the Codex CLI integration.')
    setStatus(result)
  } catch (e) { setStatus({ provider: 'Codex CLI', available: false, error: e instanceof Error ? e.message : String(e) }) } }
  useEffect(() => { void check() }, [])
  useEffect(() => window.workspaceAPI.onAgentEvent((event) => {
    if (event.type === 'model_request' && typeof event.taskId === 'string' && typeof event.iteration === 'number') setTraces((old) => [...old, { taskId: event.taskId!, iteration: event.iteration as number, thinking: '', content: '' }])
    if (event.type === 'model_delta' && typeof event.taskId === 'string' && typeof event.iteration === 'number' && typeof event.delta === 'string') {
      const channel = event.channel === 'reasoning' ? 'thinking' : 'content'
      setTraces((old) => old.map((trace) => trace.taskId === event.taskId && trace.iteration === event.iteration ? { ...trace, [channel]: trace[channel] + String(event.delta) } : trace)); return
    }
    setEvents((old) => [...old.slice(-119), event]); if (event.type === 'approval_required') setApproval(event)
    if (event.type === 'file_changed' && typeof event.path === 'string') setFiles((old) => [...new Set([...old, event.path as string])])
    if (['task_completed', 'task_failed', 'task_cancelled'].includes(event.type)) { setRunning(false); setApproval(null); refreshRef.current() }
  }), [])
  useEffect(() => { if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight }, [messages, events, running, traces])
  const testConnection = async () => { setChecking(true); setSettingsMessage('Starting Codex app-server…'); try {
    const result = await window.workspaceAPI.agentTestConnection()
    if (!result || result.provider !== 'Codex CLI' || typeof result.available !== 'boolean') throw new Error('Friday is still using its old AI process. Fully quit and restart Friday to load the Codex CLI integration.')
    setStatus(result); setSettingsMessage(result.message || result.error || (result.available ? 'Codex CLI is ready.' : 'Codex CLI is unavailable.'))
  } catch (e) { setSettingsMessage(e instanceof Error ? e.message : String(e)) } finally { setChecking(false) } }
  const send = async () => {
    if (submitted.current || running || !input.trim()) return
    submitted.current = true; const prompt = input.trim(); setInput(''); setError(''); setEvents([]); setFiles([]); setTraces([])
    setMessages((old) => [...old, { role: 'user', content: prompt }]); setRunning(true)
    try { const result = await window.workspaceAPI.agentSend(prompt, { buffers, history: messages.slice(-12) }); if (result.result) setMessages((old) => [...old, { role: 'assistant', content: result.result! }]) }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setRunning(false); submitted.current = false; void check() }
  }
  const approve = async (yes: boolean) => { if (!approval || typeof approval.approvalId !== 'string') return; const id = approval.approvalId; setApproval(null); await window.workspaceAPI.agentApprove(id, yes) }
  const activityName = (event: AgentEvent) => event.type === 'tool_started' || event.type === 'tool_completed' || event.type === 'tool_failed' ? `${labels[event.type]}: ${String(event.name || 'operation')}` : event.type === 'approval_required' ? `${labels[event.type]}: ${String(event.action || 'operation')}` : labels[event.type] || event.type
  const usable = Boolean(status?.available)
  return <section className="agent-panel">
    <header className="agent-header"><div><Bot size={17} /><strong>Normal Agent</strong><span className={`agent-status ${usable ? 'online' : ''}`}><i />{!status ? 'Checking Codex CLI…' : usable ? `${status.version || 'Codex CLI'} ready` : 'Codex CLI not found'}</span></div><button title="Codex CLI settings" onClick={() => setSettingsOpen((open) => !open)}><Settings size={14} /></button></header>
    {settingsOpen && <section className="agent-settings"><h3>Codex CLI</h3><p>{usable ? <>Detected: <code>{status?.version}</code></> : status?.error || 'Install Codex CLI and make sure it is available on PATH.'}</p><p>Friday starts <code>codex app-server</code> for workspace conversations. Authentication uses your existing Codex CLI sign-in; Friday does not store an API key.</p><p>If the first task reports an authentication error, sign in from a terminal with <code>codex login</code>, then retry.</p><button className="secondary-button" onClick={() => void testConnection()} disabled={checking}><Play size={13} /> {checking ? 'Checking…' : 'Check Codex'}</button>{settingsMessage && <div className="agent-settings-message">{settingsMessage}</div>}</section>}
    {status && !usable && <div className="agent-banner"><CircleAlert size={15} /><span>{status.error || 'Codex CLI was not found. Install Codex CLI and ensure its command is on PATH, then check again.'}</span></div>}
    {!root && <div className="agent-banner">Open a project folder to use the Normal Agent.</div>}
    <div className="agent-content" ref={scroll}>
      {messages.length === 0 && <div className="agent-welcome"><Bot size={28} /><strong>What should I work on?</strong><span>Friday will run one Codex agent in the open workspace and stream its activity here.</span></div>}
      {messages.map((message, i) => <article className={`agent-message ${message.role}`} key={`${i}-${message.role}`}><small>{message.role === 'user' ? 'YOU' : 'FRIDAY'}</small><div>{message.content}</div></article>)}
      {traces.length > 0 && <section className="agent-model-traces"><h3>CODEX LIVE OUTPUT</h3>{traces.map((trace) => <details className="agent-model-trace" key={`${trace.taskId}-${trace.iteration}`} open={running && trace === traces.at(-1)}><summary>Turn {trace.iteration} · streamed Codex output</summary>{trace.thinking && <div className="agent-trace-part"><strong>Reasoning summary</strong><pre>{trace.thinking}</pre></div>}{trace.content && <div className="agent-trace-part"><strong>Assistant message</strong><pre>{trace.content}</pre></div>}{!trace.thinking && !trace.content && <div className="agent-trace-waiting">Waiting for Codex output…</div>}</details>)}<small className="agent-settings-note">The panel shows the messages and reasoning events emitted by Codex app-server.</small></section>}
      {events.length > 0 && <div className="agent-activity"><h3>ACTIVITY</h3>{events.slice(-45).map((event, index) => <details key={`${event.time}-${index}`} open={event.type === 'tool_failed' || event.type === 'approval_required' || event.type === 'permission_denied'} className={`agent-event ${event.type.includes('failed') || event.type === 'permission_denied' ? 'failed' : ''}`}><summary><span>{activityName(event)}</span><time>{new Date(event.time).toLocaleTimeString()}</time></summary>{Boolean(event.error || event.result || event.details || event.content || event.diff || event.delta || event.reason) && <pre>{(() => { const value = event.error || event.result || event.details || event.diff || event.delta || event.reason; return typeof value === 'string' ? value : JSON.stringify(value, null, 2) })()}</pre>}</details>)}</div>}
      {files.length > 0 && <div className="agent-files"><h3>CHANGED FILES</h3>{files.map((file) => <button key={file} onClick={() => onOpenFile(file)}>{file.replace(root, '').replace(/^[\\/]/, '')}</button>)}</div>}
      {running && !approval && <div className="agent-running"><LoaderCircle size={14} className="agent-spin" /> Codex is working…</div>}{error && <div className="agent-error">{error}</div>}
    </div>
    {approval && <div className="agent-approval"><div><strong>Approval required: {String(approval.action)}</strong><span>{String(approval.reason)}</span><pre>{JSON.stringify(approval.details, null, 2)}</pre></div><div><button className="secondary-button" onClick={() => void approve(false)}><X size={13} /> Reject</button><button className="primary-button" onClick={() => void approve(true)}><Check size={13} /> Approve</button></div></div>}
    <form className="agent-input" onSubmit={(event) => { event.preventDefault(); void send() }}><textarea value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send() } }} placeholder="Ask Friday to inspect or change your project…" disabled={running || !root} /><div><small>Enter to send · Shift+Enter for a new line</small>{running ? <button type="button" className="agent-stop" onClick={() => void window.workspaceAPI.agentCancel()}><Square size={13} /> Stop</button> : <button type="submit" className="primary-button" disabled={!input.trim() || !usable || !root}><Send size={13} /> Send</button>}</div></form>
  </section>
}
