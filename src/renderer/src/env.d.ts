type TreeEntry = { name: string; path: string; directory: boolean }
type Project = { root: string; recent: string[]; tree: TreeEntry[] }
type SearchResult = { path: string; name: string; line?: number; preview?: string }
type WorkspaceFolder = { name: string; path: string; parentPath: string | null }
interface Window {
  workspaceAPI: {
    agentStatus: () => Promise<{ provider: string; available: boolean; version?: string; error?: string }>
    agentTestConnection: () => Promise<{ provider: string; available: boolean; version?: string; error?: string; appServerReady?: boolean; message?: string }>
    agentSend: (request: string, options: { buffers?: Array<{ path: string; content: string; dirty: boolean }>; history?: Array<{ role: 'user' | 'assistant'; content: string }> }) => Promise<{ taskId: string; result?: string; cancelled?: boolean; changedFiles: string[] }>
    agentApprove: (id: string, approved: boolean) => Promise<boolean>
    agentCancel: () => Promise<boolean>
    onAgentEvent: (callback: (event: { type: string; taskId?: string; time: number; [key: string]: unknown }) => void) => () => void
    minimizeWindow: () => Promise<void>
    toggleMaximizeWindow: () => Promise<void>
    closeWindow: () => Promise<void>
    openExternal: (target: string) => Promise<void>
    gitStatus: () => Promise<string>
    gitStageAll: () => Promise<string>
    gitCommit: (message: string) => Promise<string>
    runFile: (target: string) => Promise<{ kind: 'desktop' | 'browser' | 'terminal'; message: string }>
    openProject: () => Promise<Project | null>
    loadProject: (path: string) => Promise<Project>
    recentProjects: () => Promise<string[]>
    refreshTree: () => Promise<TreeEntry[]>
    refreshFolder: (folder: string) => Promise<TreeEntry[]>
    openWorkspaceFolder: (parent: string | null) => Promise<TreeEntry | null>
    setWorkspaceRoots: (roots: string[]) => Promise<boolean>
    listDirectory: (folder: string) => Promise<TreeEntry[]>
    listFiles: () => Promise<Array<{ name: string; path: string }>>
    searchProject: (query: string) => Promise<SearchResult[]>
    readFile: (path: string) => Promise<string>
    writeFile: (path: string, contents: string) => Promise<boolean>
    createEntry: (parent: string, name: string, directory: boolean) => Promise<string>
    deleteEntry: (path: string) => Promise<boolean>
    cloneRepository: (url: string) => Promise<string | null>
    startTerminal: () => Promise<string>
    terminalProfiles: () => Promise<Array<{ id: string; label: string }>>
    activateTerminal: (sessionId: string) => Promise<boolean>
    startTerminalProfile: (profile: string, cols: number, rows: number, cwd: string, sessionId: string) => Promise<string>
    resizeTerminal: (cols: number, rows: number, sessionId?: string) => Promise<boolean>
    readClipboardText: () => Promise<string>
    writeClipboardText: (value: string) => Promise<void>
    terminalInput: (input: string, sessionId?: string) => Promise<boolean>
    stopTerminal: (sessionId?: string) => Promise<boolean>
    startSsh: (host: string, cols: number, rows: number, cwd: string, sessionId: string) => Promise<string>
    onTerminalData: (callback: (sessionId: string, data: string) => void) => () => void
  }
}
