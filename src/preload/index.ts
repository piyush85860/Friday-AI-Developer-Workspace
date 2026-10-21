import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('workspaceAPI', {
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
  startTerminalProfile: (profile: string) => ipcRenderer.invoke('terminal:start-profile', profile),
  resizeTerminal: (cols: number, rows: number) => ipcRenderer.invoke('terminal:resize', cols, rows),
  readClipboardText: () => ipcRenderer.invoke('clipboard:read-text'),
  writeClipboardText: (value: string) => ipcRenderer.invoke('clipboard:write-text', value),
  terminalInput: (input: string) => ipcRenderer.invoke('terminal:input', input),
  stopTerminal: () => ipcRenderer.invoke('terminal:stop'),
  startSsh: (host: string) => ipcRenderer.invoke('ssh:start', host),
  configureAgent: (config: { endpoint: string; model: string; apiKey: string }) => ipcRenderer.invoke('agent:configure', config),
  agentChat: (messages: Array<{ role: 'user' | 'assistant'; content: string }>, context: string) => ipcRenderer.invoke('agent:chat', messages, context),
  onTerminalData: (callback: (data: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: string) => callback(data)
    ipcRenderer.on('terminal:data', listener)
    return () => ipcRenderer.removeListener('terminal:data', listener)
  }
})
