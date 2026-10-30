import { spawn, type ChildProcess } from 'node:child_process'
import type { AgentDefinition, ProviderId, ProviderStatus } from './types'

type CliLaunch = { command: string; args: string[]; windowsShell?: boolean }
export interface AgentRunInput { agent: AgentDefinition; root: string; prompt: string }
export interface AgentRunOutput { text: string; sessionId?: string }

function providerEnvironment(providerId: ProviderId): NodeJS.ProcessEnv {
  const names = process.platform === 'win32'
    ? ['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'SYSTEMDRIVE', 'TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GEMINI_CLI_HOME']
    : ['PATH', 'HOME', 'SHELL', 'TMPDIR', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GEMINI_CLI_HOME']
  if (providerId === 'claude') names.push('ANTHROPIC_API_KEY')
  if (providerId === 'gemini') names.push('GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION')
  const env: NodeJS.ProcessEnv = {}
  for (const name of names) { const value = process.env[name]; if (value !== undefined) env[name] = value }
  return env
}

const commandFor = (id: ProviderId): CliLaunch => {
  const command = id === 'codex' ? 'codex' : id === 'claude' ? 'claude' : 'gemini'
  if (process.platform !== 'win32') return { command, args: [] }
  return { command: `${command}.cmd`, args: [], windowsShell: true }
}

function execute(id: ProviderId, launch: CliLaunch, cwd?: string, input = '', timeoutMs = 10_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess
    try { child = spawn(launch.command, launch.args, { cwd, shell: launch.windowsShell, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: providerEnvironment(id) }) }
    catch (error) { reject(error); return }
    let stdout = ''; let stderr = ''; let settled = false
    const timer = setTimeout(() => { child.kill(); finish(new Error(`${id} CLI check timed out.`)) }, timeoutMs)
    const finish = (error?: Error, code: number | null = null) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve({ code, stdout, stderr }) }
    child.stdout?.on('data', (chunk: Buffer) => { stdout = (stdout + chunk.toString()).slice(-64_000) })
    child.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-16_000) })
    child.on('error', (error) => finish(error))
    child.on('close', (code) => finish(undefined, code))
    if (input) child.stdin?.end(input)
    else child.stdin?.end()
  })
}

export async function detectProvider(providerId: ProviderId): Promise<ProviderStatus> {
  const launch = commandFor(providerId)
  try {
    launch.args = ['--version']
    const versionResult = await execute(providerId, launch)
    if (versionResult.code !== 0) return { providerId, installed: false, authenticated: false, error: versionResult.stderr.trim() || `${providerId} CLI was not found on PATH.` }
    const version = `${versionResult.stdout}${versionResult.stderr}`.trim().split(/\r?\n/)[0] || 'available'
    if (providerId === 'codex') {
      const auth = await execute(providerId, { ...launch, args: ['login', 'status'] })
      const authMethod = `${auth.stdout}\n${auth.stderr}`.trim().slice(0, 100) || undefined
      const chatgptLogin = auth.code === 0 && !/api[ -]?key/i.test(authMethod || '')
      return { providerId, installed: true, version, authenticated: chatgptLogin, authMethod, error: chatgptLogin ? undefined : 'Sign in to Codex CLI with your ChatGPT account by running codex login in a terminal.' }
    }
    if (providerId === 'claude') {
      const auth = await execute(providerId, { ...launch, args: ['auth', 'status'] })
      try {
        const data = JSON.parse(auth.stdout) as { loggedIn?: boolean; authMethod?: string }
        if (typeof data.loggedIn === 'boolean') return { providerId, installed: true, version, authenticated: data.loggedIn, authMethod: data.authMethod, error: data.loggedIn ? undefined : 'Run claude auth login in a terminal.' }
      } catch { /* Some supported CLI releases may not provide JSON status. */ }
      try {
        const data = JSON.parse(auth.stderr) as { loggedIn?: boolean; authMethod?: string }
        if (typeof data.loggedIn === 'boolean') return { providerId, installed: true, version, authenticated: data.loggedIn, authMethod: data.authMethod, error: data.loggedIn ? undefined : 'Run claude auth login in a terminal.' }
      } catch { /* Authentication status may be written to stderr by some CLI versions. */ }
      if (auth.code === 1 && /not logged|not authenticated|logged out/i.test(`${auth.stdout}\n${auth.stderr}`)) return { providerId, installed: true, version, authenticated: false, error: 'Run claude auth login in a terminal.' }
      return { providerId, installed: true, version, authenticated: 'unknown', error: 'Claude Code is installed. Authentication status could not be checked; sign in using claude auth login.' }
    }
    return { providerId, installed: true, version, authenticated: 'unknown', error: 'Gemini CLI authentication is checked by Gemini CLI when a task starts.' }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { providerId, installed: false, authenticated: false, error: message }
  }
}

function makeLaunch(agent: AgentDefinition, root: string): CliLaunch {
  const model = agent.model.trim()
  if (model && !/^[a-zA-Z0-9_.:/-]{1,100}$/.test(model)) throw new Error('Model names may contain letters, numbers, dots, underscores, colons, slashes, and hyphens only.')
  const rawSession = agent.providerSessions?.[`${agent.providerId}:${root}`]
  const session = rawSession && /^[a-zA-Z0-9._-]{1,200}$/.test(rawSession) ? rawSession : undefined
  if (agent.providerId === 'codex') {
    const common = ['--skip-git-repo-check', '--json', ...(model ? ['--model', model] : [])]
    return session
      ? { ...commandFor('codex'), args: ['exec', 'resume', ...common, '--config', `sandbox_mode="${agent.filesystemPermission}"`, session, '-'] }
      : { ...commandFor('codex'), args: ['exec', ...common, '--sandbox', agent.filesystemPermission, '-'] }
  }
  if (agent.providerId === 'claude') return { ...commandFor('claude'), args: ['-p', 'Follow the task supplied on standard input.', '--output-format', 'stream-json', '--verbose', '--permission-mode', agent.filesystemPermission === 'workspace-write' ? 'acceptEdits' : 'plan', ...(session ? ['--resume', session] : []), ...(model ? ['--model', model] : [])] }
  return { ...commandFor('gemini'), args: ['-p', 'Follow the task supplied on standard input.', '--output-format', 'stream-json', '--approval-mode', agent.filesystemPermission === 'workspace-write' ? 'auto_edit' : 'plan', '--sandbox', ...(session ? ['--resume', session] : []), ...(model ? ['--model', model] : [])] }
}

function eventText(data: Record<string, unknown>, provider: ProviderId): string[] {
  const texts: string[] = []
  if (typeof data.response === 'string' && provider === 'gemini') texts.push(data.response)
  if (typeof data.result === 'string' && provider === 'claude') texts.push(data.result)
  if (data.type === 'item.completed' && data.item && typeof data.item === 'object') {
    const item = data.item as Record<string, unknown>
    if (item.type === 'agent_message' && typeof item.text === 'string') texts.push(item.text)
  }
  if ((data.type === 'assistant' || data.type === 'message') && data.message && typeof data.message === 'object') {
    const message = data.message as Record<string, unknown>
    if (Array.isArray(message.content)) for (const item of message.content) if (item && typeof item === 'object' && typeof (item as Record<string, unknown>).text === 'string') texts.push(String((item as Record<string, unknown>).text))
  }
  if (data.type === 'message' && typeof data.content === 'string') texts.push(data.content)
  return texts
}

export function runProvider(input: AgentRunInput, onLine: (line: string, parsed?: Record<string, unknown>) => void, onChild: (child: ChildProcess) => void): Promise<AgentRunOutput> {
  const { agent, root, prompt } = input
  const launch = makeLaunch(agent, root)
  return new Promise((resolve, reject) => {
    let child: ChildProcess
    try { child = spawn(launch.command, launch.args, { cwd: root, shell: launch.windowsShell, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'], env: providerEnvironment(agent.providerId) }) }
    catch (error) { reject(error); return }
    onChild(child)
    let pending = ''; let stderr = ''; let lastText = ''; let sessionId: string | undefined; let settled = false
    const timer = setTimeout(() => { terminate(child); finish(new Error(`${agent.name} exceeded its ${Math.round(agent.timeoutMs / 1000)} second time limit.`)) }, agent.timeoutMs)
    const finish = (error?: Error, code: number | null = null) => {
      if (settled) return
      settled = true; clearTimeout(timer)
      if (error) { reject(error); return }
      if (code !== 0) { reject(new Error(stderr.trim() || `${agent.providerId} CLI exited with code ${code}.`)); return }
      if (!lastText.trim()) { reject(new Error(`${agent.providerId} CLI exited without a final response.`)); return }
      resolve({ text: lastText.trim(), sessionId })
    }
    const consume = (line: string) => {
      if (!line.trim()) return
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>
        if (typeof parsed.session_id === 'string') sessionId = parsed.session_id
        if (typeof parsed.thread_id === 'string') sessionId = parsed.thread_id
        if (parsed.type === 'init' && typeof parsed.sessionId === 'string') sessionId = parsed.sessionId
        const texts = eventText(parsed, agent.providerId)
        const nestedMessage = parsed.message && typeof parsed.message === 'object' ? parsed.message as Record<string, unknown> : undefined
        const geminiAssistantChunk = agent.providerId === 'gemini' && parsed.type === 'message' && (parsed.role === 'assistant' || nestedMessage?.role === 'assistant')
        for (const text of texts) lastText = (geminiAssistantChunk ? lastText + text : text).slice(0, 100_000)
        onLine(line, parsed)
      } catch { onLine(line) }
    }
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => { pending += chunk; if (pending.length > 1_000_000) { finish(new Error('Provider output exceeded the 1 MB line limit.')); terminate(child); return }; let index: number; while ((index = pending.indexOf('\n')) >= 0) { consume(pending.slice(0, index).replace(/\r$/, '')); pending = pending.slice(index + 1) } })
    child.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-16_000) })
    child.on('error', (error) => finish(new Error(`Could not start ${agent.providerId} CLI: ${error.message}`)))
    child.on('close', (code) => { if (pending.trim()) consume(pending); finish(undefined, code) })
    child.stdin?.end(`${prompt}\n`)
  })
}

export function terminate(child: ChildProcess) {
  if (child.killed) return
  if (process.platform === 'win32' && child.pid) {
    const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
    killer.on('error', () => child.kill())
  } else if (child.pid && process.platform !== 'win32') {
    try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill() }
  } else child.kill()
}

