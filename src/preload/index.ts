import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('workspaceAPI', {
  agentStatus: () => ipcRenderer.invoke('agent:status'),
  agentTestConnection: () => ipcRenderer.invoke('agent:test-connection'),
  agentSend: (request: string, options: { buffers?: Array<{ path: string; content: string; dirty: boolean }>; history?: Array<{ role: 'user' | 'assistant'; content: string }> }) => ipcRenderer.invoke('agent:send', request, options),
  agentApprove: (id: string, approved: boolean) => ipcRenderer.invoke('agent:approve', id, approved),
  agentCancel: () => ipcRenderer.invoke('agent:cancel'),
  onAgentEvent: (callback: (event: { type: string; taskId?: string; time: number; [key: string]: unknown }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: { type: string; taskId?: string; time: number; [key: string]: unknown }) => callback(payload)
    ipcRenderer.on('agent:event', listener)
    return () => ipcRenderer.removeListener('agent:event', listener)
  },
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximizeWindow: () => ipcRenderer.invoke('window:toggle-maximize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  openExternal: (target: string) => ipcRenderer.invoke('shell:open-external', target),
  gitStatus: () => ipcRenderer.invoke('git:status'),
  gitStageAll: () => ipcRenderer.invoke('git:stage-all'),
  gitCommit: (message: string) => ipcRenderer.invoke('git:commit', message),
  runFile: (target: string) => ipcRenderer.invoke('run:file', target),
  openProject: () => ipcRenderer.invoke('project:open'),
  loadProject: (projectPath: string) => ipcRenderer.invoke('project:load', projectPath),
  recentProjects: () => ipcRenderer.invoke('project:recent'),
  refreshTree: () => ipcRenderer.invoke('project:refresh'),
  refreshFolder: (folder: string) => ipcRenderer.invoke('project:refresh', folder),
  openWorkspaceFolder: (parent: string | null) => ipcRenderer.invoke('workspace:open-folder', parent),
  setWorkspaceRoots: (roots: string[]) => ipcRenderer.invoke('workspace:set-roots', roots),
  listDirectory: (folder: string) => ipcRenderer.invoke('project:list-directory', folder),
  listFiles: () => ipcRenderer.invoke('project:list-files'),
  searchProject: (query: string) => ipcRenderer.invoke('project:search', query),
  readFile: (target: string) => ipcRenderer.invoke('file:read', target),
  writeFile: (target: string, contents: string) => ipcRenderer.invoke('file:write', target, contents),
  createEntry: (parent: string, name: string, directory: boolean) => ipcRenderer.invoke('file:create', parent, name, directory),
  deleteEntry: (target: string) => ipcRenderer.invoke('file:delete', target),
  cloneRepository: (url: string) => ipcRenderer.invoke('repo:clone', url),
  startTerminal: () => ipcRenderer.invoke('terminal:start'),
  terminalProfiles: () => ipcRenderer.invoke('terminal:profiles'),
  activateTerminal: (sessionId: string) => ipcRenderer.invoke('terminal:activate', sessionId),
  startTerminalProfile: (profile: string, cols: number, rows: number, cwd: string, sessionId: string) => ipcRenderer.invoke('terminal:start-profile', profile, cols, rows, cwd, sessionId),
  resizeTerminal: (cols: number, rows: number, sessionId?: string) => ipcRenderer.invoke('terminal:resize', cols, rows, sessionId),
  readClipboardText: () => ipcRenderer.invoke('clipboard:read-text'),
  writeClipboardText: (value: string) => ipcRenderer.invoke('clipboard:write-text', value),
  terminalInput: (input: string, sessionId?: string) => ipcRenderer.invoke('terminal:input', input, sessionId),
  stopTerminal: (sessionId?: string) => ipcRenderer.invoke('terminal:stop', sessionId),
  startSsh: (host: string, cols: number, rows: number, cwd: string, sessionId: string) => ipcRenderer.invoke('ssh:start', host, cols, rows, cwd, sessionId),
  onTerminalData: (callback: (sessionId: string, data: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, sessionId: string, data: string) => callback(sessionId, data)
    ipcRenderer.on('terminal:data', listener)
    return () => ipcRenderer.removeListener('terminal:data', listener)
  }
})
