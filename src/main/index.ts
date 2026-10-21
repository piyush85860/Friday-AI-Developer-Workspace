import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'
import { spawn, spawnSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import * as pty from 'node-pty'

let mainWindow: BrowserWindow | null = null
let terminal: pty.IPty | null = null
let currentRoot = ''
let agentConfig: { endpoint: string; model: string; apiKey: string } | null = null
let terminalKind: 'local' | 'ssh' | null = null
let pendingBrowserOpen = false
let browserOpenTimer: NodeJS.Timeout | null = null
const staticServers = new Map<string, { server: Server; port: number }>()
const ignoredFolders = new Set(['.git', 'node_modules', 'dist', 'out', 'build', '.next'])

function isWithinRoot(root: string, target: string) {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function ensureWithinRoot(target: string) {
  const resolved = path.resolve(target)
  if (!currentRoot || !isWithinRoot(currentRoot, resolved)) throw new Error('Path is outside the open project.')
  return resolved
}

async function existingWithinRoot(target: string) {
  const canonical = await realpath(ensureWithinRoot(target))
  if (!isWithinRoot(currentRoot, canonical)) throw new Error('Path resolves outside the open project.')
  return canonical
}

async function treeFor(root: string, folder = root): Promise<Array<{ name: string; path: string; directory: boolean }>> {
  const entries = await readdir(folder, { withFileTypes: true })
  const result = entries
    .filter((entry) => !(entry.isDirectory() && ignoredFolders.has(entry.name)) && !entry.name.startsWith('.DS_Store'))
    .map((entry) => ({ name: entry.name, path: path.join(folder, entry.name), directory: entry.isDirectory() }))
    .sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name))
  return result
}

function recentFile() {
  return path.join(app.getPath('userData'), 'recent-projects.json')
}

async function addRecent(projectPath: string) {
  let previous: string[] = []
  try { previous = JSON.parse(await readFile(recentFile(), 'utf8')) as string[] } catch { /* first launch */ }
  const recent = [projectPath, ...previous.filter((item) => item !== projectPath)].slice(0, 8)
  await writeFile(recentFile(), JSON.stringify(recent, null, 2), 'utf8')
  currentRoot = projectPath
  return recent
}

function sendTerminal(text: string) {
  mainWindow?.webContents.send('terminal:data', text)
}

type TerminalProfile = { id: string; label: string; command: string; args: string[] }

function detectedTerminalProfiles(): TerminalProfile[] {
  const profiles: TerminalProfile[] = []
  const addIfFound = (id: string, label: string, command: string, args: string[] = []) => {
    const result = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [command], { encoding: 'utf8', windowsHide: true })
    if (result.status === 0) profiles.push({ id, label, command: result.stdout.split(/\r?\n/)[0].trim() || command, args })
  }
  if (process.platform === 'win32') {
    addIfFound('pwsh', 'PowerShell 7', 'pwsh.exe', ['-NoLogo'])
    profiles.push({ id: 'powershell', label: 'Windows PowerShell', command: 'powershell.exe', args: ['-NoLogo'] })
    profiles.push({ id: 'cmd', label: 'Command Prompt', command: 'cmd.exe', args: [] })
    const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(Boolean) as string[]
    const gitBash = roots.map((root) => path.join(root, 'Git', 'bin', 'bash.exe')).find(existsSync)
    if (gitBash) profiles.push({ id: 'bash', label: 'Git Bash', command: gitBash, args: ['--login', '-i'] })
    addIfFound('wsl', 'WSL', 'wsl.exe', [])
  } else {
    const shellCommand = process.env.SHELL || '/bin/bash'
    profiles.push({ id: 'default', label: path.basename(shellCommand), command: shellCommand, args: ['-i'] })
    addIfFound('bash', 'Bash', 'bash', ['-i'])
    addIfFound('zsh', 'Zsh', 'zsh', ['-i'])
  }
  return profiles
}

function startPty(command: string, args: string[], cwd: string) {
  terminal?.kill()
  const session = pty.spawn(command, args, { cwd, name: 'xterm-256color', cols: 100, rows: 30, env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string> })
  terminal = session
  session.onData((data) => {
    sendTerminal(data)
    const plainOutput = data.replace(/\x1b\[[0-9;]*m/g, '')
    const localUrl = pendingBrowserOpen ? plainOutput.match(/https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?[^\s]*/)?.[0].replace(/[),.;]+$/, '') : undefined
    if (localUrl) { pendingBrowserOpen = false; if (browserOpenTimer) clearTimeout(browserOpenTimer); browserOpenTimer = null; void shell.openExternal(localUrl) }
  })
  session.onExit(({ exitCode }) => {
    sendTerminal(`\r\n[process exited${exitCode === undefined ? '' : ` with code ${exitCode}`} ]\r\n`)
    if (terminal === session) { terminal = null; terminalKind = null }
  })
}

function startLocalTerminal(profileId?: string) {
  const profile = detectedTerminalProfiles().find((item) => item.id === profileId) || detectedTerminalProfiles()[0]
  if (!profile) throw new Error('No supported terminal shell was found.')
  startPty(profile.command, profile.args, currentRoot)
  terminalKind = 'local'
}

function quoteForShell(value: string) {
  return process.platform === 'win32' ? `'${value.replace(/'/g, "''")}'` : `'${value.replace(/'/g, "'\\''")}'`
}

function writeTerminalCommand(command: string) {
  terminal?.write(`${command}${process.platform === 'win32' ? '\r\n' : '\n'}`)
}

async function serveHtmlFile(file: string) {
  const root = currentRoot
  let existing = staticServers.get(root)
  if (!existing) {
    const mimeTypes: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2' }
    const server = createServer(async (request, response) => {
      try {
        const pathname = decodeURIComponent(new URL(request.url || '/', 'http://localhost').pathname)
        let target = path.resolve(root, `.${pathname}`)
        if (!isWithinRoot(root, target)) { response.writeHead(403).end('Forbidden'); return }
        if ((await stat(target).catch(() => null))?.isDirectory()) target = path.join(target, 'index.html')
        const canonical = await realpath(target)
        if (!isWithinRoot(root, canonical)) { response.writeHead(403).end('Forbidden'); return }
        const contents = await readFile(canonical)
        response.writeHead(200, { 'Content-Type': mimeTypes[path.extname(canonical).toLowerCase()] || 'application/octet-stream' })
        response.end(contents)
      } catch { response.writeHead(404).end('Not found') }
    })
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Could not start the local web server.')
    existing = { server, port: address.port }
    staticServers.set(root, existing)
  }
  const relative = path.relative(root, file).split(path.sep).map(encodeURIComponent).join('/')
  const url = `http://127.0.0.1:${existing.port}/${relative}`
  sendTerminal(`\r\nServing ${root} at http://127.0.0.1:${existing.port}/\r\n`)
  await shell.openExternal(url)
}

async function runFile(target: string) {
  pendingBrowserOpen = false
  if (browserOpenTimer) clearTimeout(browserOpenTimer)
  browserOpenTimer = null
  const file = await existingWithinRoot(target)
  const extension = path.extname(file).toLowerCase()
  const guiExtensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.pdf', '.svg', '.exe', '.app', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx'])
  if (guiExtensions.has(extension)) {
    const error = await shell.openPath(file)
    if (error) throw new Error(error)
    return { kind: 'desktop', message: `Opened ${path.basename(file)} in its default app.` }
  }

  if (['.html', '.htm', '.ts', '.tsx', '.js', '.jsx', '.css'].includes(extension)) {
    try {
      const packageJson = JSON.parse(await readFile(path.join(currentRoot, 'package.json'), 'utf8')) as { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
      const packages = { ...packageJson.dependencies, ...packageJson.devDependencies }
      const isElectronApp = 'electron-vite' in packages || 'electron' in packages
      const isWebApp = isElectronApp || ['vite', 'react-scripts', 'next', 'webpack', 'parcel', 'astro', 'nuxt', '@angular/cli', 'svelte'].some((name) => name in packages)
      const script = ['dev', 'start', 'serve'].find((name) => packageJson.scripts?.[name])
      if (isWebApp && script) {
        if (terminalKind !== 'local' || !terminal) startLocalTerminal()
        pendingBrowserOpen = !isElectronApp
        if (pendingBrowserOpen) browserOpenTimer = setTimeout(() => { pendingBrowserOpen = false; browserOpenTimer = null }, 30000)
        writeTerminalCommand(`npm run ${script}`)
        sendTerminal(`\r\nStarting web app with npm run ${script}…\r\n`)
        return { kind: 'terminal', message: isElectronApp ? 'Starting the desktop app in the integrated terminal.' : 'Starting the web app; its local URL will open when the server is ready.' }
      }
    } catch { /* no web package manifest: serve this HTML project directly */ }
    if (['.html', '.htm'].includes(extension)) {
      await serveHtmlFile(file)
      return { kind: 'browser', message: `Opened ${path.basename(file)} from a local web server.` }
    }
  }

  const commands: Record<string, string> = {
    '.py': `python ${quoteForShell(file)}`,
    '.pyw': `pythonw ${quoteForShell(file)}`,
    '.js': `node ${quoteForShell(file)}`,
    '.mjs': `node ${quoteForShell(file)}`,
    '.cjs': `node ${quoteForShell(file)}`,
    '.ps1': process.platform === 'win32' ? `powershell -ExecutionPolicy Bypass -File ${quoteForShell(file)}` : `pwsh -File ${quoteForShell(file)}`,
    '.bat': `& ${quoteForShell(file)}`,
    '.cmd': `& ${quoteForShell(file)}`,
    '.sh': `bash ${quoteForShell(file)}`,
    '.go': `go run ${quoteForShell(file)}`,
    '.java': `java ${quoteForShell(file)}`
  }
  let command = commands[extension]
  if (extension === '.csproj') command = `dotnet run --project ${quoteForShell(file)}`
  if (extension === '.rs') {
    const cargoManifest = path.join(currentRoot, 'Cargo.toml')
    command = existsSync(cargoManifest) ? `cargo run --manifest-path ${quoteForShell(cargoManifest)}` : process.platform === 'win32' ? `$ErrorActionPreference='Stop'; rustc ${quoteForShell(file)}; if ($LASTEXITCODE -eq 0) { & ${quoteForShell(file.replace(/\.rs$/i, '.exe'))} }` : `rustc ${quoteForShell(file)} && ${quoteForShell(file.replace(/\.rs$/i, ''))}`
  }
  if (!command) throw new Error(`No run action is configured for ${extension || 'this file type'}.`)
  if (terminalKind !== 'local' || !terminal) startLocalTerminal()
  writeTerminalCommand(command)
  return { kind: 'terminal', message: `Running ${path.basename(file)} in the integrated terminal.` }
}

function gitCommand(args: string[]) {
  if (!currentRoot) throw new Error('Open a project first.')
  return new Promise<string>((resolve, reject) => {
    const child = spawn('git', args, { cwd: currentRoot, windowsHide: true, shell: false })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (data: Buffer) => { stdout += data.toString() })
    child.stderr.on('data', (data: Buffer) => { stderr += data.toString() })
    child.on('error', reject)
    child.on('close', (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr.trim() || `git exited with code ${code}`)))
  })
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 940,
    minHeight: 620,
    backgroundColor: '#171717',
    title: 'Friday',
    webPreferences: {
      preload: path.join(import.meta.dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  if (process.env.ELECTRON_RENDERER_URL) void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void mainWindow.loadFile(path.join(import.meta.dirname, '../renderer/index.html'))
  mainWindow.on('closed', () => { mainWindow = null })
}

app.whenReady().then(() => {
  ipcMain.handle('run:file', async (_event, target: string) => runFile(target))
  ipcMain.handle('git:status', () => gitCommand(['status', '--short', '--branch']))
  ipcMain.handle('git:stage-all', () => gitCommand(['add', '-A']))
  ipcMain.handle('git:commit', async (_event, message: string) => {
    if (!message.trim()) throw new Error('Enter a commit message.')
    await gitCommand(['add', '-A'])
    return gitCommand(['commit', '-m', message.trim()])
  })
  ipcMain.handle('window:minimize', () => mainWindow?.minimize())
  ipcMain.handle('window:toggle-maximize', () => { if (!mainWindow) return; if (mainWindow.isMaximized()) mainWindow.unmaximize(); else mainWindow.maximize() })
  ipcMain.handle('window:close', () => mainWindow?.close())
  ipcMain.handle('shell:open-external', async (_event, target: string) => {
    const url = new URL(target)
    if (url.protocol !== 'https:' || url.hostname !== 'marketplace.visualstudio.com') throw new Error('Only the VS Code marketplace can be opened from this action.')
    await shell.openExternal(url.toString())
  })
  ipcMain.handle('project:open', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    if (result.canceled || !result.filePaths[0]) return null
    const root = await realpath(result.filePaths[0])
    const recent = await addRecent(root)
    return { root, recent, tree: await treeFor(root) }
  })
  ipcMain.handle('project:recent', async () => {
    try {
      const projects = JSON.parse(await readFile(recentFile(), 'utf8')) as string[]
      return projects.filter((item) => existsSync(item))
    } catch { return [] }
  })
  ipcMain.handle('project:load', async (_event, projectPath: string) => {
    if (!existsSync(projectPath)) throw new Error('That project folder no longer exists.')
    currentRoot = await realpath(path.resolve(projectPath))
    const recent = await addRecent(currentRoot)
    return { root: currentRoot, recent, tree: await treeFor(currentRoot) }
  })
  ipcMain.handle('project:refresh', async () => currentRoot ? treeFor(currentRoot) : [])
  ipcMain.handle('project:list-directory', async (_event, folder: string) => treeFor(currentRoot, await existingWithinRoot(folder)))
  ipcMain.handle('project:list-files', async () => {
    if (!currentRoot) return []
    const files: Array<{ name: string; path: string }> = []
    const walk = async (folder: string): Promise<void> => {
      if (files.length >= 3000) return
      for (const entry of await readdir(folder, { withFileTypes: true })) {
        if (entry.isDirectory()) { if (!ignoredFolders.has(entry.name) && !entry.name.startsWith('.')) await walk(path.join(folder, entry.name)); continue }
        if (!entry.isFile() || entry.name.startsWith('.')) continue
        const file = path.join(folder, entry.name)
        files.push({ name: entry.name, path: file })
        if (files.length >= 3000) break
      }
    }
    await walk(currentRoot)
    return files
  })
  ipcMain.handle('project:search', async (_event, query: string) => {
    if (!currentRoot || !query.trim()) return []
    const needle = query.toLowerCase()
    const matches: Array<{ path: string; name: string; line?: number; preview?: string }> = []
    const walk = async (folder: string): Promise<void> => {
      for (const entry of await readdir(folder, { withFileTypes: true })) {
        if (entry.isDirectory()) { if (!ignoredFolders.has(entry.name) && !entry.name.startsWith('.')) await walk(path.join(folder, entry.name)); continue }
        if (matches.length >= 120 || entry.name.startsWith('.') || entry.isSymbolicLink()) continue
        const file = path.join(folder, entry.name)
        if (entry.name.toLowerCase().includes(needle)) matches.push({ path: file, name: entry.name })
        const fileStats = await stat(file).catch(() => null)
        if (matches.length >= 120 || !fileStats || fileStats.size > 400_000) continue
        try {
          const content = await readFile(file, 'utf8')
          if (content.includes('\0')) continue
          const lines = content.split(/\r?\n/)
          for (let index = 0; index < lines.length && matches.length < 120; index++) {
            if (lines[index].toLowerCase().includes(needle)) matches.push({ path: file, name: entry.name, line: index + 1, preview: lines[index].trim().slice(0, 180) })
          }
        } catch { /* non-text or transient file */ }
      }
    }
    await walk(currentRoot)
    return matches
  })
  ipcMain.handle('file:read', async (_event, target: string) => readFile(await existingWithinRoot(target), 'utf8'))
  ipcMain.handle('file:write', async (_event, target: string, contents: string) => {
    const resolved = await existingWithinRoot(target)
    await mkdir(path.dirname(resolved), { recursive: true })
    await writeFile(resolved, contents, 'utf8')
    return true
  })
  ipcMain.handle('file:create', async (_event, parent: string, name: string, directory: boolean) => {
    const safeParent = await existingWithinRoot(parent)
    const target = ensureWithinRoot(path.join(safeParent, name))
    if (directory) await mkdir(target, { recursive: true })
    else { await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, '', { flag: 'wx' }) }
    return target
  })
  ipcMain.handle('file:delete', async (_event, target: string) => {
    const resolved = await existingWithinRoot(target)
    if (resolved === currentRoot) throw new Error('Cannot delete the project root.')
    const { rm } = await import('node:fs/promises')
    await rm(resolved, { recursive: true })
    return true
  })
  ipcMain.handle('repo:clone', async (_event, url: string) => {
    const destination = await dialog.showOpenDialog({ title: 'Choose where to clone the repository', properties: ['openDirectory', 'createDirectory'] })
    if (destination.canceled || !destination.filePaths[0]) return null
    return new Promise<string>((resolve, reject) => {
      const process = spawn('git', ['clone', url], { cwd: destination.filePaths[0], windowsHide: true, shell: false })
      process.stderr.on('data', (data: Buffer) => sendTerminal(data.toString()))
      process.on('error', reject)
      process.on('close', async (code) => {
        if (code === 0) { const project = path.join(destination.filePaths[0], path.basename(url.replace(/\.git$/, ''))); await addRecent(project); resolve(project) }
        else reject(new Error(`git clone exited with code ${code}`))
      })
    })
  })
  ipcMain.handle('terminal:start', async () => {
    if (!currentRoot) throw new Error('Open a project first.')
    if (terminal && terminalKind === 'local') return true
    sendTerminal('\x1b[2J\x1b[H')
    startLocalTerminal()
    return true
  })
  ipcMain.handle('terminal:profiles', async () => detectedTerminalProfiles().map(({ id, label }) => ({ id, label })))
  ipcMain.handle('terminal:start-profile', async (_event, id: string) => {
    if (!currentRoot) throw new Error('Open a project first.')
    startLocalTerminal(id)
    return true
  })
  ipcMain.handle('terminal:input', async (_event, input: string) => { terminal?.write(input); return true })
  ipcMain.handle('terminal:resize', async (_event, cols: number, rows: number) => { if (terminal && cols > 0 && rows > 0) terminal.resize(cols, rows); return true })
  ipcMain.handle('clipboard:read-text', () => clipboard.readText())
  ipcMain.handle('clipboard:write-text', (_event, value: string) => clipboard.writeText(value))
  ipcMain.handle('terminal:stop', async () => { terminal?.kill(); terminal = null; terminalKind = null; return true })
  ipcMain.handle('ssh:start', async (_event, host: string) => {
    if (!/^[\w.@:-]+$/.test(host)) throw new Error('Enter an SSH host such as user@example.com.')
    sendTerminal(`Connecting to ${host}…\r\n`)
    startPty('ssh', ['-tt', host], currentRoot || app.getPath('home'))
    terminalKind = 'ssh'
    return true
  })
  ipcMain.handle('agent:configure', async (_event, config: { endpoint: string; model: string; apiKey: string }) => {
    const endpoint = new URL(config.endpoint)
    if (!['http:', 'https:'].includes(endpoint.protocol)) throw new Error('The API endpoint must use HTTP or HTTPS.')
    if (!config.model.trim() || !config.apiKey.trim()) throw new Error('Enter a model name and API key.')
    agentConfig = { ...config, endpoint: endpoint.toString().replace(/\/$/, '') }
    return true
  })
  ipcMain.handle('agent:chat', async (_event, messages: Array<{ role: 'user' | 'assistant'; content: string }>, context: string) => {
    if (!agentConfig) throw new Error('Configure an AI provider first.')
    const endpoint = /\/chat\/completions$/.test(agentConfig.endpoint) ? agentConfig.endpoint : `${agentConfig.endpoint}/chat/completions`
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${agentConfig.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: agentConfig.model, messages: [{ role: 'system', content: `You are a coding assistant inside Friday. Project root: ${currentRoot || 'none'}. ${context}` }, ...messages] })
    })
    const result = await response.json() as { error?: { message?: string }; choices?: Array<{ message?: { content?: string } }> }
    if (!response.ok) throw new Error(result.error?.message || `Provider returned HTTP ${response.status}.`)
    return result.choices?.[0]?.message?.content || 'The provider returned an empty answer.'
  })

  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

app.on('window-all-closed', () => {
  for (const { server } of staticServers.values()) server.close()
  staticServers.clear()
  if (process.platform !== 'darwin') app.quit()
})
