import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Editor from '@monaco-editor/react'
import { Activity, Bot, Braces, ChevronDown, ChevronRight, CircleHelp, Clock3, Code2, Command, FileCode2, FilePlus2, Files, Folder, FolderOpen, FolderPlus, GitBranch, Keyboard, Menu, Minus, MoreHorizontal, Network, PanelBottom, PanelRight, Plus, Search, Settings, SquareTerminal, Trash2, X } from 'lucide-react'
import AgentPanel from './AgentPanel'
import MultiAgentWorkspace from './MultiAgentWorkspace'

type Entry = { name: string; path: string; directory: boolean }
type Project = { root: string; recent: string[]; tree: Entry[] }
type OpenTab = { path: string; name: string; contents: string; savedContents: string }
type SearchResult = { path: string; name: string; line?: number; preview?: string }
const languages: Record<string, string> = { ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', json: 'json', css: 'css', html: 'html', md: 'markdown', py: 'python', rs: 'rust', go: 'go', sh: 'shell', yml: 'yaml', yaml: 'yaml', xml: 'xml' }

function pathContains(parent: string, target: string) {
  const base = parent.replace(/[\\/]+$/, '').toLowerCase()
  const child = target.toLowerCase()
  return child === base || child.startsWith(`${base}\\`) || child.startsWith(`${base}/`)
}

function fileIcon(name: string) {
  const ext = name.split('.').pop()?.toLowerCase()
  if (['tsx', 'jsx'].includes(ext || '')) return <Braces size={14} className="file-icon code" />
  if (['ts', 'js'].includes(ext || '')) return <Braces size={14} className="file-icon script" />
  if (ext === 'json') return <Braces size={14} className="file-icon json" />
  return <FileCode2 size={14} className="file-icon" />
}
function TreeNode({ entry, depth, openFile, createEntry, deleteEntry, collapseKey, workspaceFolders, onSelectDirectory, removeWorkspaceFolder, selectedPath }: { entry: Entry; depth: number; openFile: (entry: Entry) => void; createEntry: (parent: string, directory: boolean) => void; deleteEntry: (entry: Entry) => Promise<void>; collapseKey: number; workspaceFolders: WorkspaceFolder[]; onSelectDirectory: (path: string) => void; removeWorkspaceFolder: (path: string) => void; selectedPath: string }) {
  const [expanded, setExpanded] = useState(depth < 1)
  const [children, setChildren] = useState<Entry[]>([])
  const [menuOpen, setMenuOpen] = useState(false)
  const refresh = useCallback(async () => setChildren(await window.workspaceAPI.listDirectory(entry.path)), [entry.path])
  const nestedWorkspaceFolders = workspaceFolders.filter((folder) => folder.parentPath === entry.path)
  const visibleChildren = [...children, ...nestedWorkspaceFolders.filter((folder) => !children.some((child) => child.path === folder.path)).map((folder) => ({ ...folder, directory: true }))]
  useEffect(() => { if (expanded && entry.directory) void refresh() }, [expanded, entry.directory, refresh])
  useEffect(() => { if (selectedPath === entry.path && entry.directory) setExpanded(true) }, [selectedPath, entry.path, entry.directory])
  useEffect(() => { if (collapseKey) setExpanded(false) }, [collapseKey])
  const activate = () => { if (entry.directory) { onSelectDirectory(entry.path); setExpanded((value) => !value) } else openFile(entry) }
  return <div className="tree-node">
    <div className={`tree-row ${selectedPath === entry.path && entry.directory ? 'selected' : ''}`} style={{ paddingLeft: 10 + depth * 14 }} onClick={activate} onContextMenu={(event) => { event.preventDefault(); setMenuOpen((value) => !value) }}>
      {entry.directory ? (expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />) : <span className="tree-spacer" />}
      {entry.directory ? (expanded ? <FolderOpen size={14} className="folder-icon" /> : <Folder size={14} className="folder-icon" />) : fileIcon(entry.name)}
      <span className="tree-label">{entry.name}</span>
      {menuOpen && <div className="context-menu" onClick={(event) => event.stopPropagation()}>
        {entry.directory && <><button onClick={() => { createEntry(entry.path, false); setMenuOpen(false) }}><FilePlus2 size={14} /> New File</button><button onClick={() => { createEntry(entry.path, true); setMenuOpen(false) }}><FolderPlus size={14} /> New Folder</button></>}
        {workspaceFolders.some((folder) => folder.path === entry.path) ? <button onClick={() => { removeWorkspaceFolder(entry.path); setMenuOpen(false) }}><Minus size={14} /> Remove from Workspace</button> : <button className="danger-text" onClick={() => { void deleteEntry(entry); setMenuOpen(false) }}><Trash2 size={14} /> Delete</button>}
      </div>}
      {!entry.directory && <span className="tree-git-dot" />}
    </div>
    {expanded && entry.directory && <div>{visibleChildren.map((child) => <TreeNode key={`${child.path}-${collapseKey}`} entry={child} depth={depth + 1} openFile={openFile} createEntry={createEntry} deleteEntry={deleteEntry} collapseKey={collapseKey} workspaceFolders={workspaceFolders} onSelectDirectory={onSelectDirectory} removeWorkspaceFolder={removeWorkspaceFolder} selectedPath={selectedPath} />)}
      <div className="tree-inline-actions"><button title="New file" onClick={() => createEntry(entry.path, false)}><FilePlus2 size={13} /></button><button title="New folder" onClick={() => createEntry(entry.path, true)}><FolderPlus size={13} /></button><button title="Refresh" onClick={() => void refresh()}><Activity size={13} /></button></div>
    </div>}
  </div>
}

type TerminalSessionInfo = { id: string; root: string; profile: string; sshHost: string | null }

function TerminalSessionView({ session, active, onReady }: { session: TerminalSessionInfo; active: boolean; onReady: (id: string, terminal: import('@xterm/xterm').Terminal | null) => void }) {
  const host = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<import('@xterm/xterm').Terminal | null>(null)
  const fitRef = useRef<{ fit: () => void } | null>(null)
  useEffect(() => {
    let disposed = false
    let terminal: import('@xterm/xterm').Terminal | null = null
    let unsubscribe = () => {}
    let dataSubscription: { dispose: () => void } | undefined
    let resizeSubscription: { dispose: () => void } | undefined
    let resizeObserver: ResizeObserver | undefined
    void Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')]).then(async ([xtermModule, fitModule]) => {
      if (disposed || !host.current) return
      terminal = new xtermModule.Terminal({ theme: { background: '#17191d', foreground: '#d5d9e0', cursor: '#c5d5f5', selectionBackground: '#31415d' }, fontFamily: 'Cascadia Code, Consolas, monospace', fontSize: 13, cursorBlink: true, convertEol: false, allowProposedApi: true, scrollback: 10000 })
      terminalRef.current = terminal
      onReady(session.id, terminal)
      const fit = new fitModule.FitAddon()
      fitRef.current = fit
      terminal.loadAddon(fit)
      terminal.open(host.current)
      fit.fit()
      unsubscribe = window.workspaceAPI.onTerminalData((sessionId, data) => { if (sessionId === session.id) terminal?.write(data) })
      dataSubscription = terminal.onData((data) => { void window.workspaceAPI.terminalInput(data, session.id) })
      resizeSubscription = terminal.onResize(({ cols, rows }) => { void window.workspaceAPI.resizeTerminal(cols, rows, session.id) })
      terminal.attachCustomKeyEventHandler((event) => {
        if (event.type !== 'keydown' || !(event.ctrlKey || event.metaKey)) return true
        const key = event.key.toLowerCase()
        if (key === 'c' && terminal?.hasSelection()) {
          void window.workspaceAPI.writeClipboardText(terminal.getSelection()).catch(() => {})
          return false
        }
        if (key === 'v') {
          void window.workspaceAPI.readClipboardText().then((text) => terminal?.paste(text)).catch(() => {})
          return false
        }
        return true
      })
      resizeObserver = new ResizeObserver(() => fit.fit())
      resizeObserver.observe(host.current)
      if (session.sshHost) await window.workspaceAPI.startSsh(session.sshHost, terminal.cols, terminal.rows, session.root, session.id)
      else await window.workspaceAPI.startTerminalProfile(session.profile, terminal.cols, terminal.rows, session.root, session.id)
      fit.fit()
      await window.workspaceAPI.resizeTerminal(terminal.cols, terminal.rows, session.id)
      if (active) terminal.focus()
    }).catch((error: Error) => terminal?.writeln(`Terminal error: ${error.message}`))
    return () => { disposed = true; unsubscribe(); dataSubscription?.dispose(); resizeSubscription?.dispose(); resizeObserver?.disconnect(); terminal?.dispose(); fitRef.current = null; terminalRef.current = null; onReady(session.id, null); void window.workspaceAPI.stopTerminal(session.id) }
  }, [session.id, session.root, session.sshHost])
  useEffect(() => { if (active) { fitRef.current?.fit(); terminalRef.current?.focus() } }, [active])
  return <div className={`terminal-session-view ${active ? 'active' : ''}`}><div className="terminal-body" ref={host} /></div>
}

function TerminalPanel({ onClose, onNewTerminal, root, sshHost, hidden, authRequest, onAuthHandled }: { onClose: () => void; onNewTerminal: () => Promise<string | null>; root: string; sshHost: string | null; hidden: boolean; authRequest: { id: number; provider: MultiAgentProvider } | null; onAuthHandled: () => void }) {
  const [profiles, setProfiles] = useState<Array<{ id: string; label: string }>>([])
  const [sessions, setSessions] = useState<TerminalSessionInfo[]>([])
  const [activeId, setActiveId] = useState('')
  const terminalRefs = useRef(new Map<string, import('@xterm/xterm').Terminal>())
  const handledAuthRef = useRef(0)
  const activeSession = sessions.find((session) => session.id === activeId)
  useEffect(() => {
    let cancelled = false
    void window.workspaceAPI.terminalProfiles().then((available) => {
      if (cancelled) return
      setProfiles(available)
      const session = { id: crypto.randomUUID(), root, profile: available[0]?.id || '', sshHost }
      setSessions([session])
      setActiveId(session.id)
    }).catch((error: Error) => { if (!cancelled) console.error('Unable to load terminal profiles:', error) })
    return () => { cancelled = true }
  }, [root, sshHost])
  useEffect(() => {
    if (!authRequest || !profiles.length || handledAuthRef.current === authRequest.id) return
    handledAuthRef.current = authRequest.id
    const session = { id: crypto.randomUUID(), root, profile: profiles[0].id, sshHost: null }
    setSessions((current) => [...current, session]); setActiveId(session.id)
    const command = authRequest.provider === 'codex' ? 'codex login' : authRequest.provider === 'claude' ? 'claude auth login' : 'gemini'
    window.setTimeout(() => { void window.workspaceAPI.terminalInput(`${command}\r`, session.id) }, 1800)
    onAuthHandled()
  }, [authRequest, profiles, root, sshHost, onAuthHandled])
  const addSession = (cwd: string) => {
    const session = { id: crypto.randomUUID(), root: cwd, profile: profiles[0]?.id || '', sshHost: null }
    setSessions((current) => [...current, session])
    setActiveId(session.id)
  }
  const requestNewSession = async () => {
    const cwd = await onNewTerminal()
    if (cwd) addSession(cwd)
  }
  const removeSession = (id: string) => {
    if (sessions.length <= 1) return
    void window.workspaceAPI.stopTerminal(id)
    setSessions((current) => {
      const next = current.filter((session) => session.id !== id)
      if (activeId === id) setActiveId(next.at(-1)?.id || '')
      return next
    })
  }
  const changeProfile = (profile: string) => {
    if (!activeSession) return
    setSessions((current) => current.map((session) => session.id === activeId ? { ...session, profile } : session))
    const terminal = terminalRefs.current.get(activeId)
    if (terminal) { terminal.clear(); void window.workspaceAPI.startTerminalProfile(profile, terminal.cols, terminal.rows, activeSession.root, activeId).catch((error: Error) => terminal.writeln(`Terminal error: ${error.message}`)) }
  }
  return <section className={`terminal-pane ${hidden ? 'hidden' : ''}`}>
    <div className="panel-tabs"><div className="panel-tab-active">TERMINAL <ChevronDown size={12} /></div><div className="terminal-session-tabs">{sessions.map((session) => <div className={`terminal-session-tab ${activeId === session.id ? 'active' : ''}`} key={session.id}><button title={session.root} onClick={() => { setActiveId(session.id); void window.workspaceAPI.activateTerminal(session.id) }}>{session.sshHost ? `SSH ${session.sshHost}` : `${session.root.split(/[\\/]/).filter(Boolean).at(-1)} · ${profiles.find((profile) => profile.id === session.profile)?.label || 'Terminal'}`}</button><button title={sessions.length <= 1 ? 'Keep one terminal session open' : 'Kill terminal'} aria-label="Kill terminal" disabled={sessions.length <= 1} onClick={() => removeSession(session.id)}><X size={12} /></button></div>)}</div><div className="terminal-shell-name">{activeSession && !activeSession.sshHost && <select aria-label="Terminal profile" value={activeSession.profile} onChange={(event) => changeProfile(event.target.value)}>{profiles.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select>}</div><div className="panel-tools"><button title="New terminal" onClick={() => void requestNewSession()}><Plus size={15} /></button><button title="Clear terminal" onClick={() => { const terminal = terminalRefs.current.get(activeId); terminal?.clear(); terminal?.focus() }}><Trash2 size={14} /></button><button title="Close terminal panel" onClick={onClose}><X size={15} /></button></div></div>
    <div className="terminal-workarea">{sessions.map((session) => <TerminalSessionView key={session.id} session={session} active={session.id === activeId} onReady={(id, terminal) => terminal ? terminalRefs.current.set(id, terminal) : terminalRefs.current.delete(id)} />)}</div>
  </section>
}

export default function App() {
  const [project, setProject] = useState<Project | null>(null)
  const [workspaceFolders, setWorkspaceFolders] = useState<WorkspaceFolder[]>([])
  const [selectedParentPath, setSelectedParentPath] = useState('')
  const [treeVersion, setTreeVersion] = useState(0)
  const [terminalPanelVersion, setTerminalPanelVersion] = useState(0)
  const [recent, setRecent] = useState<string[]>([])
  const [tabs, setTabs] = useState<OpenTab[]>([])
  const [activePath, setActivePath] = useState('')
  const [activeView, setActiveView] = useState<'files' | 'search' | 'source' | 'agent' | 'multiAgent'>('files')
  const [showTerminal, setShowTerminal] = useState(true)
  const [authRequest, setAuthRequest] = useState<{ id: number; provider: MultiAgentProvider } | null>(null)
  const [showTerminalProjectPicker, setShowTerminalProjectPicker] = useState(false)
  const [busy, setBusy] = useState(false)
  const [query, setQuery] = useState('')
  const [modal, setModal] = useState<'clone' | 'ssh' | null>(null)
  const [modalValue, setModalValue] = useState('')
  const [sshHost, setSshHost] = useState<string | null>(null)
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const [pendingLine, setPendingLine] = useState<number | undefined>()
  const [notice, setNotice] = useState('')
  const [showCommand, setShowCommand] = useState(false)
  const [commandMode, setCommandMode] = useState<'commands' | 'files'>('commands')
  const [quickFiles, setQuickFiles] = useState<Array<{ name: string; path: string }>>([])
  const [showShortcuts, setShowShortcuts] = useState(false)
  const [showSidebar, setShowSidebar] = useState(true)
  const [closedTabs, setClosedTabs] = useState<OpenTab[]>([])
  const [menuOpen, setMenuOpen] = useState('')
  const [editorFontSize, setEditorFontSize] = useState(14)
  const [wordWrap, setWordWrap] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [collapsed, setCollapsed] = useState(0)
  const [gitStatus, setGitStatus] = useState('')
  const [commitMessage, setCommitMessage] = useState('')
  const [isExplorerExpanded, setIsExplorerExpanded] = useState(true)
  const [createTarget, setCreateTarget] = useState<{ parent: string; directory: boolean } | null>(null)
  const [createName, setCreateName] = useState('')
  const [commandQuery, setCommandQuery] = useState('')
  const commandRef = useRef<HTMLInputElement>(null)
  const editorRef = useRef<import('monaco-editor').editor.IStandaloneCodeEditor | null>(null)
  const openRequestRef = useRef(0)
  const runActiveRef = useRef<() => void>(() => {})
  const keyChordRef = useRef(false)
  const keyChordTimerRef = useRef<number | null>(null)
  const workspaceKeyRootRef = useRef('')
  const terminalRootResolverRef = useRef<((root: string | null) => void) | null>(null)
  const requestProviderAuth = (provider: MultiAgentProvider) => { setAuthRequest({ id: Date.now(), provider }); setActiveView('files'); setShowSidebar(true); setShowTerminal(true) }
  const authHandled = useCallback(() => setAuthRequest(null), [])
  const activeTab = tabs.find((tab) => tab.path === activePath)
  const topWorkspaceFolders = workspaceFolders.filter((folder) => folder.parentPath === null)
  const selectedDirectory = selectedParentPath && selectedParentPath !== '__workspace__' ? selectedParentPath : project?.root || ''
  const isDirty = (tab: OpenTab) => tab.contents !== tab.savedContents
  const files = useMemo(() => {
    const result: Entry[] = []
    const visit = (entries: Entry[]) => entries.forEach((entry) => { result.push(entry); if (entry.directory) { /* tree is loaded lazily */ } })
    visit(project?.tree || [])
    return result
  }, [project])

  useEffect(() => { void window.workspaceAPI.recentProjects().then(setRecent) }, [])
  useEffect(() => {
    if (activeView !== 'search' || !query.trim() || !project) { setSearchResults([]); return }
    const timer = window.setTimeout(() => { void window.workspaceAPI.searchProject(query).then(setSearchResults).catch((error: Error) => say(error.message)) }, 220)
    return () => window.clearTimeout(timer)
  }, [activeView, query, project])
  useEffect(() => {
    if (activeView !== 'source' || !project) return
    void window.workspaceAPI.gitStatus().then(setGitStatus).catch((error: Error) => setGitStatus(error.message))
  }, [activeView, project, treeVersion])
  useEffect(() => {
    const editor = editorRef.current
    if (!editor || !pendingLine) return
    const timer = window.setTimeout(() => {
      if (editorRef.current !== editor) return
      editor.setPosition({ lineNumber: pendingLine, column: 1 })
      editor.revealLineInCenter(pendingLine)
      setPendingLine(undefined)
    }, 0)
    return () => window.clearTimeout(timer)
  }, [activePath, pendingLine])
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey
      const key = event.key.toLowerCase()
      if (keyChordRef.current) {
        keyChordRef.current = false
        if (keyChordTimerRef.current !== null) window.clearTimeout(keyChordTimerRef.current)
        keyChordTimerRef.current = null
        if (mod && key === 's') { event.preventDefault(); setShowShortcuts(true); return }
        if (mod && key === 'w') { event.preventDefault(); closeAllTabs(); return }
      }
      if (mod && key === 'k' && !event.shiftKey && !event.altKey) {
        keyChordRef.current = true
        if (keyChordTimerRef.current !== null) window.clearTimeout(keyChordTimerRef.current)
        keyChordTimerRef.current = window.setTimeout(() => { keyChordRef.current = false; keyChordTimerRef.current = null }, 1200)
        return
      }
      if (mod && key === 's') { event.preventDefault(); void saveActive(); return }
      if (mod && key === 'o') { event.preventDefault(); void openProject(); return }
      if (mod && key === 'n' && !event.shiftKey) { event.preventDefault(); if (selectedDirectory) createEntry(selectedDirectory, false); return }
      if (mod && key === 'p' && event.shiftKey) { event.preventDefault(); openCommandPalette('commands'); return }
      if (event.key === 'F1') { event.preventDefault(); openCommandPalette('commands'); return }
      if (mod && key === 'p') { event.preventDefault(); openCommandPalette('files'); return }
      if (mod && key === 'f' && !activeTab) { event.preventDefault(); setActiveView('search'); setShowSidebar(true); window.setTimeout(() => document.querySelector<HTMLInputElement>('.search-sidebar input')?.focus(), 20); return }
      if (mod && event.shiftKey && key === 'e') { event.preventDefault(); setActiveView('files'); setShowSidebar(true); return }
      if (mod && event.shiftKey && key === 'f') { event.preventDefault(); setActiveView('search'); setShowSidebar(true); window.setTimeout(() => document.querySelector<HTMLInputElement>('.search-sidebar input')?.focus(), 20); return }
      if (mod && event.shiftKey && key === 'g') { event.preventDefault(); setActiveView('source'); setShowSidebar(true); return }
      if (mod && event.shiftKey && key === 'x') { event.preventDefault(); void window.workspaceAPI.openExternal('https://marketplace.visualstudio.com/VSCode'); return }
      if (mod && key === 'b') { event.preventDefault(); setShowSidebar((value) => !value); return }
      if (mod && (key === 'j' || key === '`')) { event.preventDefault(); setShowTerminal((value) => !value); return }
      if (mod && event.shiftKey && event.code === 'Backquote') { event.preventDefault(); requestNewTerminal(); return }
      if (mod && key === ',') { event.preventDefault(); setShowSettings(true); return }
      if (mod && event.shiftKey && key === 'w') { event.preventDefault(); void window.workspaceAPI.closeWindow(); return }
      if (mod && (key === 'w' || event.key === 'F4')) { event.preventDefault(); if (activeTab) closeTab(activeTab.path); return }
      if (mod && event.key === 'Tab') { event.preventDefault(); cycleTab(event.shiftKey ? -1 : 1); return }
      if (mod && event.shiftKey && key === 't') { event.preventDefault(); reopenTab(); return }
      if (event.key === 'F5' || mod && event.key === 'F5') { event.preventDefault(); runActiveRef.current(); return }
      const editorFocused = event.target instanceof HTMLElement && Boolean(event.target.closest('.monaco-editor'))
      if (event.shiftKey && !event.ctrlKey && !event.metaKey && event.key === 'Enter' && editorFocused && activeTab && !event.defaultPrevented) { event.preventDefault(); runActiveRef.current(); return }
      if (event.key === 'Escape') { setShowCommand(false); setShowShortcuts(false); setModal(null) }
    }
    window.addEventListener('keydown', keydown)
    return () => window.removeEventListener('keydown', keydown)
  })

  const say = (message: string) => { setNotice(message); window.setTimeout(() => setNotice(''), 2600) }
  const persistWorkspaceFolders = async (folders: WorkspaceFolder[]) => {
    setWorkspaceFolders(folders)
    const keyRoot = workspaceKeyRootRef.current || project?.root || ''
    if (keyRoot) localStorage.setItem(`friday-workspace:${keyRoot}`, JSON.stringify(folders))
    await window.workspaceAPI.setWorkspaceRoots(folders.map((folder) => folder.path))
  }
  const installWorkspace = async (loaded: Project) => {
    const keyRoot = loaded.root
    workspaceKeyRootRef.current = keyRoot
    let folders: WorkspaceFolder[] = []
    try {
      const parsed = JSON.parse(localStorage.getItem(`friday-workspace:${keyRoot}`) || '[]') as WorkspaceFolder[]
      if (Array.isArray(parsed)) folders = parsed.filter((item) => item && typeof item.name === 'string' && typeof item.path === 'string' && (typeof item.parentPath === 'string' || item.parentPath === null))
    } catch { /* start with the selected folder */ }
    if (!folders.some((folder) => folder.path === loaded.root && folder.parentPath === null)) folders.unshift({ name: loaded.root.split(/[\\/]/).filter(Boolean).at(-1) || loaded.root, path: loaded.root, parentPath: null })
    try { await window.workspaceAPI.setWorkspaceRoots(folders.map((folder) => folder.path)) } catch {
      folders = [{ name: loaded.root.split(/[\\/]/).filter(Boolean).at(-1) || loaded.root, path: loaded.root, parentPath: null }]
      await window.workspaceAPI.setWorkspaceRoots([loaded.root])
    }
    setWorkspaceFolders(folders)
    setSelectedParentPath(folders.find((folder) => folder.parentPath === null)?.path || loaded.root)
    setProject(loaded)
    setTerminalPanelVersion((version) => version + 1)
  }
  const openCommandPalette = (mode: 'commands' | 'files') => {
    setCommandMode(mode)
    setCommandQuery('')
    setShowCommand(true)
    if (mode === 'files') void window.workspaceAPI.listFiles().then(setQuickFiles).catch((error: Error) => say(error.message))
    window.setTimeout(() => commandRef.current?.focus(), 20)
  }
  const openProject = async () => {
    if (tabs.some(isDirty) && !window.confirm('Discard unsaved changes and open another project?')) return
    try { const result = await window.workspaceAPI.openProject(); if (result) { openRequestRef.current += 1; await window.workspaceAPI.stopTerminal(); await installWorkspace(result); setRecent(result.recent); setTabs([]); setActivePath(''); setSshHost(null) } } catch (error) { say((error as Error).message) }
  }
  const loadRecent = async (path: string) => {
    try { const loaded = await window.workspaceAPI.loadProject(path); openRequestRef.current += 1; await installWorkspace(loaded); setRecent(loaded.recent); setTabs([]); setActivePath(''); setSshHost(null) } catch (error) { say((error as Error).message) }
  }
  const refreshProject = async () => {
    if (!project) return
    setProject({ ...project, tree: await window.workspaceAPI.refreshFolder(project.root) })
    setTreeVersion((version) => version + 1)
  }
  const addWorkspaceFolder = async () => {
    if (!project) return
    const parent = selectedParentPath === '__workspace__' ? null : selectedParentPath || project.root
    try {
      const folder = await window.workspaceAPI.openWorkspaceFolder(parent)
      if (!folder) return
      if (workspaceFolders.some((item) => item.path === folder.path)) { say('That folder is already in this workspace.'); return }
      if (parent && pathContains(folder.path, parent)) { say('A folder cannot be added beneath itself.'); return }
      const next = [...workspaceFolders, { name: folder.name, path: folder.path, parentPath: parent }]
      await persistWorkspaceFolders(next)
      setSelectedParentPath(folder.path)
      setTreeVersion((version) => version + 1)
    } catch (error) { say((error as Error).message) }
  }
  const removeWorkspaceFolder = async (folderPath: string) => {
    const selectedFolder = workspaceFolders.find((folder) => folder.path === folderPath)
    if (!selectedFolder) { say('Select a workspace folder to remove.'); return }
    const topLevel = workspaceFolders.filter((folder) => folder.parentPath === null)
    if (selectedFolder.parentPath === null && topLevel.length === 1) { say('A workspace must keep at least one top-level folder.'); return }
    const removed = new Set([folderPath])
    let changed = true
    while (changed) {
      changed = false
      for (const folder of workspaceFolders) if (folder.parentPath && [...removed].some((root) => pathContains(root, folder.parentPath!)) && !removed.has(folder.path)) { removed.add(folder.path); changed = true }
    }
    const hasUnsavedFiles = tabs.some((tab) => [...removed].some((root) => pathContains(root, tab.path)) && isDirty(tab))
    if (hasUnsavedFiles) { say('Save or close unsaved files in this folder before removing it.'); return }
    const next = workspaceFolders.filter((folder) => !removed.has(folder.path))
    try {
      await persistWorkspaceFolders(next)
      const remainingRoots = next.filter((folder) => folder.parentPath === null)
      const nextRoot = remainingRoots[0]?.path || ''
      if (selectedFolder.parentPath === null && project && nextRoot) {
        const tree = await window.workspaceAPI.refreshFolder(nextRoot)
        setProject({ ...project, root: nextRoot, tree })
      }
      const removedTabs = tabs.filter((tab) => [...removed].some((root) => pathContains(root, tab.path)))
      if (removedTabs.length) {
        setTabs((current) => current.filter((tab) => !removedTabs.some((removedTab) => removedTab.path === tab.path)))
        if (removedTabs.some((tab) => tab.path === activePath)) setActivePath('')
      }
      setSelectedParentPath(selectedFolder.parentPath || nextRoot)
      setTreeVersion((version) => version + 1)
    } catch (error) { say((error as Error).message) }
  }
  const requestNewTerminal = () => {
    setShowTerminal(true)
    if (topWorkspaceFolders.length > 1) return new Promise<string | null>((resolve) => { terminalRootResolverRef.current = resolve; setShowTerminalProjectPicker(true) })
    return Promise.resolve(topWorkspaceFolders[0]?.path || project?.root || null)
  }
  const resolveTerminalProject = (root: string | null) => {
    setShowTerminalProjectPicker(false)
    const resolve = terminalRootResolverRef.current
    terminalRootResolverRef.current = null
    resolve?.(root)
  }
  const openFile = async (entry: Entry, line?: number) => {
    const request = ++openRequestRef.current
    const existing = tabs.find((tab) => tab.path === entry.path)
    if (existing) { setActivePath(existing.path); setPendingLine(line); return }
    try {
      const contents = await window.workspaceAPI.readFile(entry.path)
      if (request !== openRequestRef.current) return
      const next = { path: entry.path, name: entry.name, contents, savedContents: contents }
      setTabs((current) => [...current, next]); setActivePath(entry.path); setPendingLine(line)
    } catch (error) { if (request === openRequestRef.current) say((error as Error).message) }
  }
  const openAgentFile = async (filePath: string) => {
    const current = tabs.find((tab) => tab.path === filePath)
    setActiveView('files'); setShowSidebar(true)
    if (!current) { await openFile({ name: filePath.split(/[\\/]/).filter(Boolean).at(-1) || filePath, path: filePath, directory: false }); return }
    if (isDirty(current)) { say('This editor has unsaved changes. Save or review them before reloading the agent file.'); setActivePath(current.path); return }
    try {
      const contents = await window.workspaceAPI.readFile(filePath)
      setTabs((existing) => existing.map((tab) => tab.path === filePath && !isDirty(tab) ? { ...tab, contents, savedContents: contents } : tab))
      setActivePath(filePath)
    } catch (error) { say((error as Error).message) }
  }
  const saveActive = async () => {
    if (!activeTab || !isDirty(activeTab)) return true
    try {
      await window.workspaceAPI.writeFile(activeTab.path, activeTab.contents, activeTab.savedContents)
      setTabs((current) => current.map((tab) => tab.path === activeTab.path ? { ...tab, savedContents: tab.contents } : tab))
      say('Saved')
      return true
    } catch (error) { say((error as Error).message); return false }
  }
  const changeContents = (value: string | undefined) => {
    setTabs((current) => current.map((tab) => tab.path === activePath ? { ...tab, contents: value ?? '' } : tab))
  }
  const closeTab = (path: string) => {
    const index = tabs.findIndex((tab) => tab.path === path)
    if (tabs[index] && isDirty(tabs[index])) { say('Save this file before closing the tab.'); return }
    if (tabs[index]) setClosedTabs((current) => [tabs[index], ...current.filter((tab) => tab.path !== path)].slice(0, 20))
    setTabs((current) => current.filter((tab) => tab.path !== path))
    if (activePath === path) setActivePath(tabs[index + 1]?.path || tabs[index - 1]?.path || '')
  }
  const closeAllTabs = () => {
    if (tabs.some(isDirty)) { say('Save or close unsaved files first.'); return }
    setClosedTabs((current) => [...tabs.slice().reverse(), ...current].slice(0, 20))
    setTabs([])
    setActivePath('')
  }
  const cycleTab = (direction: number) => {
    if (!tabs.length) return
    const index = tabs.findIndex((tab) => tab.path === activePath)
    setActivePath(tabs[(index + direction + tabs.length) % tabs.length].path)
  }
  const reopenTab = () => {
    const [tab, ...remaining] = closedTabs
    if (!tab) return
    setClosedTabs(remaining)
    setTabs((current) => current.some((item) => item.path === tab.path) ? current : [...current, tab])
    setActivePath(tab.path)
  }
  const createEntry = (parent: string, directory: boolean) => { setCreateTarget({ parent, directory }); setCreateName('') }
  const submitCreateEntry = async () => {
    if (!createTarget || !createName.trim()) return
    const { parent, directory } = createTarget
    const name = createName.trim()
    try {
      const createdPath = await window.workspaceAPI.createEntry(parent, name, directory)
      await refreshProject()
      setCreateTarget(null)
      setCreateName('')
      if (!directory) await openFile({ name: name.split(/[\\/]/).filter(Boolean).at(-1) || name, path: createdPath, directory: false })
    } catch (error) { say((error as Error).message) }
  }
  const deleteEntry = async (entry: Entry) => {
    if (!window.confirm(`Delete ${entry.name}?`)) return
    try { await window.workspaceAPI.deleteEntry(entry.path); setTabs((current) => current.filter((tab) => !tab.path.startsWith(entry.path))); await refreshProject() } catch (error) { say((error as Error).message) }
  }
  const startClone = async () => {
    if (!modalValue.trim()) return
    setBusy(true)
    try { const root = await window.workspaceAPI.cloneRepository(modalValue.trim()); if (root) await loadRecent(root); setModal(null); setModalValue('') } catch (error) { say((error as Error).message) } finally { setBusy(false) }
  }
  const startSsh = async () => {
    const host = modalValue.trim()
    if (!/^[\w.@:-]+$/.test(host)) { say('Enter an SSH host such as user@example.com.'); return }
    setSshHost(host); setModal(null); setModalValue(''); setShowTerminal(true)
    say(`Opening SSH session: ${host}`)
  }
  const stageChanges = async () => {
    try { await window.workspaceAPI.gitStageAll(); setGitStatus(await window.workspaceAPI.gitStatus()); say('Changes staged') }
    catch (error) { say((error as Error).message) }
  }
  const commitChanges = async () => {
    try { await window.workspaceAPI.gitCommit(commitMessage); setCommitMessage(''); setGitStatus(await window.workspaceAPI.gitStatus()); say('Commit created') }
    catch (error) { say((error as Error).message) }
  }
  const runActiveFile = async () => {
    if (!activeTab) { say('Open a file before running it.'); return }
    if (!await saveActive()) return
    if (typeof window.workspaceAPI?.runFile !== 'function') { say('Run support is missing from the app preload. Rebuild and restart Friday.'); return }
    try {
      const result = await window.workspaceAPI.runFile(activeTab.path)
      if (result.kind !== 'desktop') setShowTerminal(true)
      say(result.message)
    } catch (error) { say((error as Error).message) }
  }
  runActiveRef.current = () => { void runActiveFile() }
  const commandItems = [
    { label: 'File: Open Folder…', action: openProject },
    { label: 'File: Save', action: saveActive },
    { label: 'File: Close Editor', action: () => activeTab && closeTab(activeTab.path) },
    { label: 'View: Explorer', action: () => { setActiveView('files'); setShowSidebar(true) } },
    { label: 'View: Search', action: () => { setActiveView('search'); setShowSidebar(true) } },
    { label: 'View: Source Control', action: () => { setActiveView('source'); setShowSidebar(true) } },
    { label: 'View: Keyboard Shortcuts', action: () => setShowShortcuts(true) },
    { label: 'View: Toggle Sidebar', action: () => setShowSidebar((value) => !value) },
    { label: 'View: Toggle Terminal', action: () => setShowTerminal((value) => !value) },
    { label: 'Run: Run Active File', action: runActiveFile },
    { label: 'Terminal: New Terminal', action: requestNewTerminal },
    { label: 'Preferences: Open Settings', action: () => setShowSettings(true) },
    { label: 'View: Toggle Word Wrap', action: () => setWordWrap((value) => !value) },
    { label: 'File: New File', action: () => selectedDirectory && createEntry(selectedDirectory, false) }
  ].filter((item) => item.label.toLowerCase().includes(commandQuery.toLowerCase()))
  const quickOpenResults = quickFiles.filter((file) => `${file.name} ${file.path}`.toLowerCase().includes(commandQuery.toLowerCase())).slice(0, 100)

  if (!project) return <main className="welcome-shell">
    <header className="welcome-menubar"><div className="app-mark"><Code2 size={16} /></div>{['File','Edit','Selection','View','Go','Run','Terminal','Help'].map((name) => <button key={name} onClick={() => { if (name === 'File') void openProject(); else if (name === 'Terminal') say('Open a project to use its integrated terminal.'); else if (name === 'View') setShowCommand(true); else say(`${name} commands are available after opening a project.`) }}>{name}</button>)}<div className="welcome-title">Friday</div><button className="icon-button" aria-label="Settings" onClick={() => setShowSettings(true)}><Settings size={16} /></button></header>
    <section className="welcome-content">
      <div className="brand-lockup"><div className="brand-icon"><Code2 size={30} /></div><div><h1>FRIDAY</h1><span>Your coding workspace</span></div></div>
      <div className="launch-grid">
        <button className="launch-card" onClick={() => void openProject()}><FolderOpen size={18} /><span>Open project</span><kbd>Ctrl O</kbd></button>
        <button className="launch-card" onClick={() => { setModal('clone'); setModalValue('') }}><GitBranch size={18} /><span>Clone repository</span></button>
        <button className="launch-card" onClick={() => { setModal('ssh'); setModalValue('') }}><SquareTerminal size={18} /><span>Connect via SSH</span></button>
        <button className="launch-card" onClick={() => void openProject()}><Command size={18} /><span>Open workspace</span></button>
      </div>
      <div className="recent-list"><div className="section-label"><Clock3 size={14} /> RECENT PROJECTS</div>{recent.length ? recent.map((item) => <button key={item} className="recent-item" onClick={() => void loadRecent(item)}><span className="recent-name">{item.split(/[\\/]/).filter(Boolean).at(-1)}</span><span className="recent-path">{item}</span></button>) : <div className="empty-recent">Your recent projects will show up here.</div>}</div>
      <footer className="welcome-foot"><span><Keyboard size={13} /> Ctrl+Shift+P Command Palette</span><span>Friday Studio · Workspace</span></footer>
    </section>
    {(modal === 'clone' || modal === 'ssh') && <Modal modal={modal} value={modalValue} setValue={setModalValue} close={() => setModal(null)} submit={modal === 'clone' ? startClone : startSsh} busy={busy} />}
    {showShortcuts && <ShortcutsDialog close={() => setShowShortcuts(false)} />}
    {showCommand && <div className="command-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowCommand(false) }}><div className="command-box"><div className="command-search"><Search size={15} /><input ref={commandRef} value={commandQuery} onChange={(event) => setCommandQuery(event.target.value)} placeholder="Type a command to search…" onKeyDown={(event) => { if (event.key === 'Enter' && commandItems[0]) { void commandItems[0].action(); setShowCommand(false) } }} /></div>{commandItems.map((item) => <button key={item.label} onClick={() => { void item.action(); setShowCommand(false) }}><Command size={14} />{item.label}<span>↵</span></button>)}</div></div>}
    {showSettings && <SettingsDialog fontSize={editorFontSize} setFontSize={setEditorFontSize} wordWrap={wordWrap} setWordWrap={setWordWrap} close={() => setShowSettings(false)} />}
    {notice && <div className="toast">{notice}</div>}
  </main>

  return <main className="ide-shell">
    <header className="ide-menubar"><div className="app-mark"><Code2 size={15} /></div><button className="menu-button" onClick={() => openCommandPalette('commands')}><Menu size={15} /></button>{['File','Edit','Selection','View','Go','Run','Terminal','Help'].map((name) => <div className="menu-wrap" key={name}><button onClick={() => setMenuOpen(menuOpen === name ? '' : name)}>{name}</button>{menuOpen === name && <div className="context-menu top-menu">{(name === 'File' ? [['Open Folder…', () => void openProject()], ['New File', () => selectedDirectory && createEntry(selectedDirectory, false)], ['Save', () => void saveActive()], ['Close Editor', () => activeTab && closeTab(activeTab.path)]] : name === 'View' ? [['Explorer', () => { setActiveView('files'); setShowSidebar(true) }], ['Search', () => { setActiveView('search'); setShowSidebar(true) }], ['Source Control', () => { setActiveView('source'); setShowSidebar(true) }], ['Toggle Sidebar', () => setShowSidebar((v) => !v)], ['Toggle Terminal', () => setShowTerminal((v) => !v)], ['Settings', () => setShowSettings(true)], ['Keyboard Shortcuts', () => setShowShortcuts(true)]] : name === 'Terminal' ? [['New Terminal', requestNewTerminal]] : name === 'Run' ? [['Run Active File    Shift+Enter', () => void runActiveFile()]] : name === 'Help' ? [['Command Palette', () => openCommandPalette('commands')], ['Keyboard Shortcuts', () => setShowShortcuts(true)]] : [['Command Palette', () => openCommandPalette('commands')], ['Settings', () => setShowSettings(true)]]).map(([label, action]) => <button key={label as string} onClick={() => { (action as () => void)(); setMenuOpen('') }}>{label as string}</button>)}</div>}</div>)}<button className="title-project">{project.root.split(/[\\/]/).filter(Boolean).at(-1)}</button><button className="header-icon" title="Command palette" onClick={() => openCommandPalette('commands')}><Search size={16} /></button><button className="window-dot" title="Minimize" onClick={() => window.workspaceAPI.minimizeWindow()} /><button className="window-dot" title="Maximize" onClick={() => window.workspaceAPI.toggleMaximizeWindow()} /><button className="window-dot close" title="Close" onClick={() => window.workspaceAPI.closeWindow()} /></header>
    <div className={`workspace ${showSidebar ? '' : 'sidebar-hidden'}`}>
      <nav className="activity-bar">
        <button className={activeView === 'files' ? 'active' : ''} title="Explorer" onClick={() => { setActiveView('files'); setShowSidebar(true) }}><Files size={21} /></button>
        <button className={activeView === 'search' ? 'active' : ''} title="Search" onClick={() => { setActiveView('search'); setShowSidebar(true) }}><Search size={21} /></button>
        <button className={activeView === 'source' ? 'active' : ''} title="Source control" onClick={() => { setActiveView('source'); setShowSidebar(true) }}><GitBranch size={21} /></button>
        <button className={activeView === 'agent' ? 'active' : ''} title="Agent" aria-label="Agent" onClick={() => { setActiveView(activeView === 'agent' ? 'files' : 'agent'); setShowSidebar(true) }}><Bot size={21} /></button>
        <button className={activeView === 'multiAgent' ? 'active' : ''} title="Multi-Agent" aria-label="Multi-Agent" onClick={() => { setActiveView(activeView === 'multiAgent' ? 'files' : 'multiAgent'); setShowSidebar(activeView !== 'multiAgent') }}><Network size={20} /></button>
        <div className="activity-spacer" /><button title="Extensions" onClick={() => { void window.workspaceAPI.openExternal('https://marketplace.visualstudio.com/VSCode'); say('Opened the VS Code extension marketplace in your browser.') }}><Braces size={20} /></button><button title="Settings" onClick={() => setShowSettings(true)}><Settings size={20} /></button>
      </nav>
      <aside className="sidebar">
        <div className="sidebar-heading">{activeView === 'files' || activeView === 'agent' ? 'EXPLORER' : activeView === 'search' ? 'SEARCH' : 'SOURCE CONTROL'}<button className="subtle-icon" onClick={() => openCommandPalette('commands')}><MoreHorizontal size={16} /></button></div>
        {activeView === 'files' || activeView === 'agent' ? <>
          <div className="project-root-row"><button aria-label={isExplorerExpanded ? 'Collapse workspace folders' : 'Expand workspace folders'} title="Select workspace to add a top-level folder" onClick={() => { setSelectedParentPath('__workspace__'); setIsExplorerExpanded((value) => !value) }}>{isExplorerExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}WORKSPACE</button><div><button title="New file in selected folder" onClick={() => createEntry(selectedDirectory, false)}><FilePlus2 size={14} /></button><button title="Add new folder under selected folder" onClick={() => createEntry(selectedDirectory, true)}><FolderPlus size={14} /></button><button title={selectedParentPath === '__workspace__' ? 'Add a top-level folder to the workspace' : 'Open a folder under the selected parent'} onClick={() => void addWorkspaceFolder()}><FolderOpen size={14} /></button><button title="Remove selected folder from workspace" aria-label="Remove selected folder from workspace" onClick={() => void removeWorkspaceFolder(selectedParentPath)}><Minus size={15} /></button><button title="Refresh selected folder" onClick={() => void refreshProject()}><Activity size={14} /></button><button title="Collapse all folders" onClick={() => setCollapsed((value) => value + 1)}><MoreHorizontal size={14} /></button></div></div>
          {isExplorerExpanded && <div className="tree-scroll">{topWorkspaceFolders.map((folder) => <TreeNode key={`${folder.path}-${treeVersion}`} entry={{ name: folder.name, path: folder.path, directory: true }} depth={0} openFile={openFile} createEntry={createEntry} deleteEntry={deleteEntry} collapseKey={collapsed} workspaceFolders={workspaceFolders} onSelectDirectory={setSelectedParentPath} removeWorkspaceFolder={(path) => void removeWorkspaceFolder(path)} selectedPath={selectedParentPath} />)}</div>}
          <div className="sidebar-bottom"><button onClick={() => activeTab ? say('Outline is based on symbols in the open file; Monaco symbol navigation is available with Ctrl+Shift+O.') : say('Open a file to see its outline.')}><ChevronRight size={13} /> OUTLINE</button><button onClick={() => activeTab ? say(`Timeline for ${activeTab.name}: view Git history with git log --follow -- ${activeTab.name}`) : say('Open a file to see its timeline.')}><ChevronRight size={13} /> TIMELINE</button></div>
        </> : activeView === 'search' ? <div className="search-sidebar"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search in files" autoFocus /><div className="search-results">{searchResults.map((result, index) => <button key={`${result.path}-${result.line}-${index}`} onClick={() => void openFile({ name: result.name, path: result.path, directory: false }, result.line)}><span>{result.name}{result.line ? `:${result.line}` : ''}</span><small>{result.preview || result.path.replace(project.root, '')}</small></button>)}{query && searchResults.length === 0 && <p>No matching files or text.</p>}</div></div> : <div className="search-sidebar source-control"><p>SOURCE CONTROL</p><pre>{gitStatus || 'Working tree clean'}</pre><button className="secondary-button" onClick={() => void stageChanges()}>Stage All Changes</button><input value={commitMessage} onChange={(event) => setCommitMessage(event.target.value)} placeholder="Commit message" /><button className="primary-button" disabled={!commitMessage.trim()} onClick={() => void commitChanges()}>Commit</button></div>}
      </aside>
      <section className={`editor-column ${activeView === 'agent' ? 'agent-open' : ''} ${activeView === 'multiAgent' ? 'multi-agent-open' : ''}`}>
        <div className={`agent-main-view ${activeView === 'agent' ? '' : 'hidden'}`}><AgentPanel key={project.root} root={project.root} buffers={tabs.map((tab) => ({ path: tab.path, content: tab.contents, dirty: isDirty(tab) }))} onOpenFile={(path) => void openAgentFile(path)} onRefresh={() => void refreshProject()} /></div>
        <div className={`multi-agent-full-view ${activeView === 'multiAgent' ? '' : 'hidden'}`}><MultiAgentWorkspace root={project.root} dirtyPaths={tabs.filter(isDirty).map((tab) => tab.path)} onAuth={requestProviderAuth} onOpenFile={(target) => void openAgentFile(target)} onRefresh={() => void refreshProject()} /></div>
        <div className={`editor-main-view ${activeView === 'multiAgent' ? 'hidden' : ''}`}>
        <div className="tabs-row">{tabs.map((tab) => <button key={tab.path} onClick={() => setActivePath(tab.path)} className={`editor-tab ${activePath === tab.path ? 'selected' : ''}`}>{fileIcon(tab.name)}<span>{tab.name}</span>{isDirty(tab) ? <span className="dirty-dot" /> : null}<span className="tab-close" onClick={(event) => { event.stopPropagation(); closeTab(tab.path) }}><X size={13} /></span></button>)}<div className="tab-actions"><button title="Toggle word wrap" onClick={() => setWordWrap((value) => !value)}><PanelRight size={15} /></button><button title="Command palette" onClick={() => { setShowCommand(true); setTimeout(() => commandRef.current?.focus(), 20) }}><MoreHorizontal size={16} /></button></div></div>
        {activeTab ? <><div className="breadcrumbs">{activeTab.path.replace(project.root, project.root.split(/[\\/]/).filter(Boolean).at(-1) || '').split(/[\\/]/).map((part, index, array) => <span key={`${part}-${index}`}>{part}{index < array.length - 1 ? <ChevronRight size={12} /> : null}</span>)}</div>
          <div className="code-editor"><Editor height="100%" theme="vs-dark" path={activeTab.path} language={languages[activeTab.name.split('.').pop()?.toLowerCase() || ''] || 'plaintext'} value={activeTab.contents} onChange={changeContents} loading={<div className="editor-loading">Loading editor…</div>} onMount={(editor, monaco) => { editorRef.current = editor; editor.addAction({ id: 'friday.run-active-file', label: 'Run Active File', keybindings: [monaco.KeyMod.Shift | monaco.KeyCode.Enter], run: () => runActiveRef.current() }); if (pendingLine) { editor.setPosition({ lineNumber: pendingLine, column: 1 }); editor.revealLineInCenter(pendingLine); setPendingLine(undefined) } }} options={{ readOnly: busy, fontSize: editorFontSize, fontFamily: 'Cascadia Code, Consolas, monospace', minimap: { enabled: false }, scrollBeyondLastLine: false, automaticLayout: true, wordWrap: wordWrap ? 'on' : 'off', padding: { top: 14 }, renderLineHighlight: 'line', lineNumbersMinChars: 3, tabSize: 2 }} /></div></> : <div className="editor-empty"><div className="empty-logo"><Code2 size={44} /></div><div className="shortcut-list"><div><button onClick={() => setShowTerminal(true)}>Show Terminal</button><kbd>Ctrl</kbd><span>+</span><kbd>J</kbd></div><div><button onClick={() => { setActiveView('search'); document.querySelector<HTMLInputElement>('.search-sidebar input')?.focus() }}>Search Files</button><kbd>Ctrl</kbd><span>+</span><kbd>Shift</kbd><span>+</span><kbd>F</kbd></div></div></div>}
        <TerminalPanel key={`${project.root}:${terminalPanelVersion}:${sshHost || 'local'}`} root={topWorkspaceFolders[0]?.path || project.root} sshHost={sshHost} onNewTerminal={requestNewTerminal} onClose={() => setShowTerminal(false)} hidden={!showTerminal || activeView === 'multiAgent'} authRequest={authRequest} onAuthHandled={authHandled} />
        </div>
      </section>
    </div>
    <footer className="status-bar"><div><span><GitBranch size={13} /> main</span><span>0 errors</span><span>0 warnings</span></div><div><button onClick={() => setShowTerminal((value) => !value)}><SquareTerminal size={13} /> Terminal</button><span>UTF-8</span><span>Spaces: 2</span><span>{activeTab ? languages[activeTab.name.split('.').pop()?.toLowerCase() || ''] || 'Plain Text' : 'Ready'}</span></div></footer>
    {modal && <Modal modal={modal} value={modalValue} setValue={setModalValue} close={() => setModal(null)} submit={modal === 'clone' ? startClone : startSsh} busy={busy} />}
    {showTerminalProjectPicker && <div className="modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) resolveTerminalProject(null) }}><div className="dialog terminal-project-picker"><div className="dialog-heading"><h2>Choose a project for this terminal</h2><button aria-label="Close" onClick={() => resolveTerminalProject(null)}><X size={17} /></button></div><p>The terminal will start in the selected workspace folder.</p>{topWorkspaceFolders.map((folder) => <button className="terminal-project-choice" key={folder.path} onClick={() => resolveTerminalProject(folder.path)}><FolderOpen size={15} /><span>{folder.name}<small>{folder.path}</small></span></button>)}</div></div>}
    {createTarget && <CreateEntryDialog directory={createTarget.directory} name={createName} setName={setCreateName} close={() => setCreateTarget(null)} submit={() => void submitCreateEntry()} />}
    {showSettings && <SettingsDialog fontSize={editorFontSize} setFontSize={setEditorFontSize} wordWrap={wordWrap} setWordWrap={setWordWrap} close={() => setShowSettings(false)} />}
    {showCommand && <div className="command-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowCommand(false) }}><div className="command-box"><div className="command-search"><Search size={15} /><input ref={commandRef} value={commandQuery} onChange={(event) => setCommandQuery(event.target.value)} placeholder={commandMode === 'files' ? 'Search files by name…' : 'Type a command to search…'} onKeyDown={(event) => { if (event.key === 'Enter') { if (commandMode === 'files' && quickOpenResults[0]) void openFile({ ...quickOpenResults[0], directory: false }); else if (commandMode === 'commands' && commandItems[0]) void commandItems[0].action(); setShowCommand(false) } }} /></div>{commandMode === 'files' ? <>{quickOpenResults.map((file) => <button key={file.path} onClick={() => { void openFile({ ...file, directory: false }); setShowCommand(false) }}><FileCode2 size={14} />{file.name}<span>{file.path.replace(project.root, '').replace(/^[\\/]/, '')}</span></button>)}{quickFiles.length === 0 && <p className="command-empty">Loading project files…</p>}{quickFiles.length > 0 && quickOpenResults.length === 0 && <p className="command-empty">No matching files.</p>}</> : commandItems.map((item) => <button key={item.label} onClick={() => { void item.action(); setShowCommand(false) }}><Command size={14} />{item.label}<span>↵</span></button>)}</div></div>}
    {showShortcuts && <ShortcutsDialog close={() => setShowShortcuts(false)} />}
    {notice && <div className="toast">{notice}</div>}
  </main>
}

function Modal({ modal, value, setValue, close, submit, busy }: { modal: 'clone' | 'ssh'; value: string; setValue: (value: string) => void; close: () => void; submit: () => void; busy: boolean }) {
  const isClone = modal === 'clone'
  const isSsh = modal === 'ssh'
  const title = isClone ? 'Clone repository' : isSsh ? 'Connect via SSH' : 'Open folder'
  return <div className="modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) close() }}><form className="dialog" onSubmit={(event) => { event.preventDefault(); submit() }}><div className="dialog-heading"><h2>{title}</h2><button type="button" onClick={close}><X size={17} /></button></div><p>{isClone ? 'Enter a repository URL. The app will ask where to save it.' : isSsh ? 'Connect to a host from your SSH configuration.' : 'Choose a project folder.'}</p><label>{isClone ? 'Repository URL' : 'SSH host'}<input autoFocus value={value} onChange={(event) => setValue(event.target.value)} placeholder={isClone ? 'https://github.com/user/repository.git' : 'user@example.com'} /></label><div className="dialog-actions"><button type="button" className="secondary-button" onClick={close}>Cancel</button><button type="submit" className="primary-button" disabled={busy || !value.trim()}>{busy ? 'Working…' : isClone ? 'Clone' : 'Connect'}</button></div></form></div>
}

function CreateEntryDialog({ directory, name, setName, close, submit }: { directory: boolean; name: string; setName: (value: string) => void; close: () => void; submit: () => void }) {
  return <div className="modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) close() }}><form className="dialog" onSubmit={(event) => { event.preventDefault(); submit() }}><div className="dialog-heading"><h2>New {directory ? 'Folder' : 'File'}</h2><button type="button" aria-label="Close" onClick={close}><X size={17} /></button></div><p>Enter a name for the new {directory ? 'folder' : 'file'}.</p><label>{directory ? 'Folder name' : 'File name'}<input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder={directory ? 'components' : 'untitled.tsx'} /></label><div className="dialog-actions"><button type="button" className="secondary-button" onClick={close}>Cancel</button><button type="submit" className="primary-button" disabled={!name.trim() || name.trim() === '.' || name.trim() === '..'}>Create</button></div></form></div>
}

function SettingsDialog({ fontSize, setFontSize, wordWrap, setWordWrap, close }: { fontSize: number; setFontSize: (value: number) => void; wordWrap: boolean; setWordWrap: (value: boolean) => void; close: () => void }) {
  return <div className="modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) close() }}><div className="dialog"><div className="dialog-heading"><h2>Editor Settings</h2><button onClick={close}><X size={17} /></button></div><p>Changes apply to the current editor immediately.</p><label>Font size<input type="number" min="10" max="32" value={fontSize} onChange={(event) => setFontSize(Math.min(32, Math.max(10, Number(event.target.value) || 14)))} /></label><label className="setting-check"><input type="checkbox" checked={wordWrap} onChange={(event) => setWordWrap(event.target.checked)} /> Wrap long lines</label><div className="dialog-actions"><button className="primary-button" onClick={close}>Done</button></div></div></div>
}

function ShortcutsDialog({ close }: { close: () => void }) {
  const groups = [
    { title: 'Friday', rows: [['Ctrl+Shift+P', 'Command Palette'], ['Ctrl+P', 'Quick Open File'], ['Ctrl+O', 'Open Project'], ['Ctrl+N', 'New File'], ['Ctrl+S', 'Save File'], ['Ctrl+W', 'Close Editor'], ['Ctrl+Shift+T', 'Reopen Closed Editor'], ['Ctrl+Tab / Ctrl+Shift+Tab', 'Next / Previous Editor'], ['Ctrl+Shift+E', 'Explorer'], ['Ctrl+Shift+F', 'Search in Files'], ['Ctrl+Shift+G', 'Source Control'], ['Ctrl+Shift+X', 'Extensions Marketplace'], ['Ctrl+B', 'Toggle Sidebar'], ['Ctrl+J / Ctrl+`', 'Toggle Terminal'], ['Ctrl+Shift+`', 'New Terminal'], ['Ctrl+,', 'Settings'], ['Ctrl+K, Ctrl+S', 'Keyboard Shortcuts'], ['Shift+Enter / F5', 'Run Active File']] },
    { title: 'Editor (Monaco)', rows: [['Ctrl+C / Ctrl+X / Ctrl+V', 'Copy / Cut / Paste'], ['Ctrl+Z / Ctrl+Y', 'Undo / Redo'], ['Ctrl+A', 'Select All'], ['Ctrl+F / Ctrl+H', 'Find / Replace'], ['Ctrl+G', 'Go to Line'], ['Ctrl+/', 'Toggle Line Comment'], ['Ctrl+Shift+K', 'Delete Line'], ['Alt+↑ / Alt+↓', 'Move Line'], ['Shift+Alt+↑ / Shift+Alt+↓', 'Copy Line'], ['Ctrl+Space', 'Trigger Suggestions'], ['F2 / F12', 'Rename / Go to Definition'], ['Alt+Z', 'Toggle Word Wrap']] }
  ]
  return <div className="modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) close() }}><div className="dialog shortcuts-dialog"><div className="dialog-heading"><h2>Keyboard Shortcuts</h2><button aria-label="Close" onClick={close}><X size={17} /></button></div><p>Windows keybindings. Editor text commands are provided by Monaco.</p>{groups.map((group) => <section className="shortcut-group" key={group.title}><h3>{group.title}</h3>{group.rows.map(([keys, action]) => <div className="shortcut-row" key={keys}><kbd>{keys}</kbd><span>{action}</span></div>)}</section>)}</div></div>
}
