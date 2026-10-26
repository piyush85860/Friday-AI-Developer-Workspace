# Friday

A desktop coding workspace built with Electron, React, Monaco Editor, and xterm.js.

## Run locally

```sh
npm install
npm run dev
```

Open a folder to browse and edit files. Use `Ctrl+S` to save, `Ctrl+O` to open another folder, and `Ctrl+Shift+P` for the command palette. The integrated terminal runs PowerShell on Windows and the configured shell on macOS and Linux.

## Normal Agent

Friday's Normal Agent uses the locally installed Codex CLI through `codex app-server`. Install Codex CLI, sign in with `codex login`, open the Agent view, and use Agent settings to check the CLI connection. Friday starts a single Codex app-server process for streamed workspace tasks and uses the signed-in Codex CLI account.

Codex runs with the open workspace as its writable sandbox and asks Friday for approval when it requests an operation outside its configured permissions. Save open editor changes before starting a task; Friday blocks tasks while dirty buffers exist so Codex cannot overwrite unsaved editor state. Review the activity and resulting Git diff after a task.
