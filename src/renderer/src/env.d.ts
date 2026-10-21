type TreeEntry = { name: string; path: string; directory: boolean }
type Project = { root: string; recent: string[]; tree: TreeEntry[] }
type SearchResult = { path: string; name: string; line?: number; preview?: string }

interface Window {
  workspaceAPI: {
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
    listDirectory: (folder: string) => Promise<TreeEntry[]>
    listFiles: () => Promise<Array<{ name: string; path: string }>>
    searchProject: (query: string) => Promise<SearchResult[]>
    readFile: (path: string) => Promise<string>
    writeFile: (path: string, contents: string) => Promise<boolean>
    createEntry: (parent: string, name: string, directory: boolean) => Promise<string>
    deleteEntry: (path: string) => Promise<boolean>
    cloneRepository: (url: string) => Promise<string | null>
    startTerminal: () => Promise<boolean>
    terminalProfiles: () => Promise<Array<{ id: string; label: string }>>
    startTerminalProfile: (profile: string) => Promise<boolean>
    resizeTerminal: (cols: number, rows: number) => Promise<boolean>
    readClipboardText: () => Promise<string>
    writeClipboardText: (value: string) => Promise<void>
    terminalInput: (input: string) => Promise<boolean>
    stopTerminal: () => Promise<boolean>
    startSsh: (host: string) => Promise<boolean>
    configureAgent: (config: { endpoint: string; model: string; apiKey: string }) => Promise<boolean>
    agentChat: (messages: Array<{ role: 'user' | 'assistant'; content: string }>, context: string) => Promise<string>
    onTerminalData: (callback: (data: string) => void) => () => void
  }
}
