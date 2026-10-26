# Friday: project handoff for continued development

This document is a working map of the repository for a new developer or coding LLM. Treat the source code as authoritative when it disagrees with this document. Refresh this handoff when the architecture or feature state changes.

## What Friday is

Friday is an early Windows-first desktop coding workspace built with Electron, React, and TypeScript. It combines a local project explorer, Monaco code editor, integrated terminals, basic Git actions, and a coding agent powered by the locally installed Codex CLI. It is a functional prototype, not a release-hardened IDE.

## Start here

- `src/main/index.ts`: Electron main process. Owns windows, filesystem operations, project roots, PTY terminals, SSH, running files, Git, and IPC handlers.
- `src/preload/index.ts`: the narrow `window.workspaceAPI` bridge between renderer and main process.
- `src/renderer/src/env.d.ts`: TypeScript contract for that bridge.
- `src/renderer/src/App.tsx`: main workspace UI and most project/editor/terminal state and commands.
- `src/renderer/src/AgentPanel.tsx`: agent chat, status, activity, approvals, and prompt input.
- `src/main/agent.ts`: Codex app-server lifecycle and JSON-RPC protocol, turns, approvals, events, and cancellation.
- `src/renderer/src/styles.css` and `search.css`: renderer styling.
- `electron.vite.config.ts`: Electron Vite build configuration.
- `package.json`: scripts and dependencies.

## Run and develop

Requirements: Node.js/npm and the native dependencies needed by Electron and `node-pty`. The AI Agent additionally requires Codex CLI installed and authenticated (`codex login`).

```sh
npm install
npm run dev
```

Other scripts:

```sh
npm run typecheck
npm run build
npm run preview
npm test
```

`npm test` runs the Node test file `src/main/agent.test.ts`. Do not assume that test coverage covers the renderer, Electron IPC, or full end-to-end workflows. Test behavior on the target OS; terminal discovery and command execution are platform-sensitive.

## Current feature map

### Workspace and files

- Welcome screen supports opening a folder, cloning a Git repository, and connecting an SSH terminal.
- Recent projects are stored in the Electron user-data directory (`recent-projects.json`).
- A workspace can contain multiple roots. The Explorer can add/remove roots, expand folders lazily, select a directory for create actions, refresh, create files/folders, and delete files/folders.
- The editor supports multiple tabs, Monaco language selection by extension, breadcrumbs, dirty indicators, save, quick open, text search with line navigation, and closing/reopening tabs. Unsaved changes are guarded before closing/switching.
- Editor settings include font size and word wrap; these are currently React session state, not a durable preferences store.
- File operations are exposed over IPC. Main-process helpers check that paths belong to the configured workspace roots and use canonical paths for existing targets to reduce traversal/symlink escapes. Keep path validation in the main process for any new file API.

### Run and terminals

- xterm.js + `node-pty`; profile detection chooses installed shells (PowerShell/cmd and optional shells on Windows, common shells elsewhere).
- Multiple terminal sessions are represented by IDs, can use different workspace roots, and can be switched or closed. SSH uses the system `ssh` command/config.
- Run action supports a set of common source extensions and project types; it is not a general build/debug configuration system.
- HTML preview is served locally. Common web-project scripts can be started in the integrated terminal and a detected local URL opened.
- Terminal processes and local preview servers are managed by the main process. Preserve cleanup behavior when changing terminal lifecycle code.

### Git and other UI

- Source Control exposes status, stage all (`git add -A`), and commit. It does not provide per-file staging, a diff viewer, branch management, or conflict resolution UI.
- Command palette, quick file open, keyboard shortcuts, status bar, settings dialog, menu bar, and custom window controls are present.
- Outline and Timeline are informational placeholders. Extensions opens the VS Code marketplace website; Friday has no extension host.
- The status bar's error/warning counts are placeholders, not compiler diagnostics.

### AI Agent

- Friday starts `codex app-server --listen stdio://` as a child process in the workspace. It uses the user's existing Codex CLI sign-in; Friday does not ask for or store an API key.
- Main process speaks JSON-RPC over the child process stdio, starts/reuses a thread for the active root, streams app-server events to the renderer, surfaces approval requests, and supports cancellation. One active task is allowed at a time.
- Agent gets current editor buffers and a short recent chat history from the panel. Dirty buffers block sending so the agent does not work against unsaved editor contents. Save first, then inspect the agent's changed files and Git diff.
- Approval policy is on-request. The UI offers approve/reject for supported requests.
- The Agent activity icon opens the agent in a right-side panel while leaving the editor and Explorer visible. The panel can be toggled closed by clicking the icon again. This right-side layout is recent work and has not been runtime-verified in this handoff.
- Agent setup/status is in the panel settings. If unavailable, install Codex CLI, ensure it is on PATH, run `codex login`, then use Check Codex.

## Architecture and boundaries

```text
React renderer (App.tsx, AgentPanel.tsx)
       | window.workspaceAPI (preload)
       | ipcRenderer.invoke / event subscription
Electron main process (index.ts, agent.ts)
       | filesystem / git / node-pty / child_process
Local project, terminal shells, git, Codex CLI
```

- `contextIsolation` is enabled and renderer Node integration is disabled. Keep privileged Node APIs in main and expose narrowly scoped, typed operations from preload.
- Validate IPC arguments in the main process. Never trust renderer-provided paths, IDs, or command text by default.
- The app has a multi-root renderer model. Review all workspace roots and the path helpers before changing reads/writes/search/delete/terminal cwd semantics.
- The agent's approval flow is distinct from the app's workspace path protections. Preserve both when modifying agent permissions or IPC.
- Renderer UI and agent state are largely local React state. Conversation persistence and durable workspace/editor layout restoration are not implemented.

## Important current repository state

The checkout has uncommitted work. At the time this handoff was written, Git showed modifications in `README.md`, `package.json`, `src/main/index.ts`, `src/preload/index.ts`, `src/renderer/src/App.tsx`, `src/renderer/src/env.d.ts`, `src/renderer/src/styles.css`, and `tsconfig.json`; untracked files included `PROJECT_STATUS.md`, `src/main/agent.test.ts`, `src/main/agent.ts`, and `src/renderer/src/AgentPanel.tsx`. These are existing work and must be reviewed and preserved. Do not reset, clean, or overwrite them as a starting step.

Recent committed history includes `e3601f0 Prototype completing`, preceded by CSS and file-saving commits. The current agent, multi-root workspace, and multi-session terminal work is part of the uncommitted tree; verify the current Git status yourself before editing because it will change over time.

`PROJECT_STATUS.md` is an older status report and contains stale descriptions (notably the earlier AI description). Prefer this handoff and the current implementation, and update or replace stale documentation when appropriate.

## Known gaps and next steps

1. Validate the current uncommitted work with typecheck/build and manual workflows before release. In particular check the right-side agent layout, Explorer + multiple workspace roots, terminal session creation/switch/close, SSH failures, dirty-buffer protection, and project switching.
2. Add/extend automated tests around path validation, file operations, workspace roots, terminals, and renderer behavior. Existing `agent.test.ts` covers agent protocol behavior only.
3. Improve source control with diff review and per-file staging.
4. Decide how to persist preferences, workspace roots/layout, tabs, and agent conversations.
5. Replace placeholder diagnostics with real language diagnostics or label them clearly.
6. Improve packaging, installer/update flow, platform support documentation, and end-to-end reliability.

## Working guidance for an LLM continuing the project

- First inspect `git status`, this document, and the relevant source files. Preserve all pre-existing user changes.
- Make focused changes that fit the Electron main/preload/renderer boundary. Update the preload API and `env.d.ts` together when changing IPC.
- Do not claim verification that was not run. Run the appropriate script or explicitly say that it was not run.
- For agent-related changes, inspect both `src/main/agent.ts` and `AgentPanel.tsx`; protocol details and user-facing state have to stay aligned.
- For workspace/file changes, trace the renderer call through preload to the main IPC handler and path validation.
- Update this handoff and README when a feature, script, dependency, or architectural boundary materially changes.
