# Friday Project Status

**Reviewed:** 22 October 2026  
**Project:** Friday, a desktop coding workspace built with Electron, React, TypeScript, Monaco Editor, and xterm.js.  
**Current stage:** Functional prototype in active development. The app has a usable editor workflow and several IDE features, but it still needs validation, polish, and product-level completeness before being treated as a stable release.

## At a glance

Friday currently supports opening projects, browsing and editing files, saving changes, searching, running supported files and web projects, using an integrated terminal, basic Git operations, SSH terminal sessions, and an optional AI chat panel. The interface includes keyboard shortcuts, a command palette, quick file opening, editor settings, and a welcome screen.

The latest committed change is `e3601f0` (`Prototype completing`). The working tree also contains uncommitted changes to `src/main/index.ts`, `src/preload/index.ts`, `src/renderer/src/App.tsx`, `src/renderer/src/env.d.ts`, and `src/renderer/src/styles.css`. These add multi-folder workspace handling and multi-session terminals and are described below as **in progress / uncommitted**.

## Implemented features

### Project and file workflow

- Welcome screen to open a project, clone a Git repository, or connect over SSH.
- Recently opened project list, persisted in the app's user data folder.
- File explorer with expandable folders, refresh, create file/folder, and delete actions.
- Monaco editor with language selection for common extensions, multiple tabs, breadcrumbs, dirty indicators, save, and protection against closing unsaved tabs or switching projects with unsaved changes.
- `Ctrl+S` save support and editor settings for font size and word wrap.
- Quick Open file search, project text search with results that open at the matching line, and command palette.
- Common keyboard shortcuts and a shortcuts reference dialog.
- Workspace path checks in the main process restrict file reads, writes, and deletes to open workspace roots and verify resolved paths against symlinks.

### Running code and terminals

- Integrated xterm.js terminal backed by `node-pty`.
- Terminal profile detection for Windows PowerShell, Command Prompt, optional PowerShell 7 / Git Bash / WSL, and common Unix shells.
- Run actions for Python, JavaScript, PowerShell, shell scripts, Go, Java, Rust, .NET projects, and common GUI file types.
- Detects common web app package scripts and starts them in the terminal; opens the detected local URL when available.
- Serves standalone HTML projects locally for browser preview.
- SSH terminal connection using the system `ssh` executable and SSH configuration.

### Git and AI

- Basic source control view with Git status, stage-all, and commit actions.
- Repository cloning through `git clone`.
- Optional AI chat using an OpenAI-compatible Chat Completions endpoint, model, and API key. The key is held in memory for the current app session. The agent receives project context and can include the active file in a prompt.

### Interface and app foundation

- Dark IDE-style interface with activity bar, explorer/search/source control views, editor tabs, status bar, terminal panel, and AI panel.
- Custom window controls and a restricted preload API with context isolation enabled and renderer Node integration disabled.
- VS Code Marketplace link for extensions; this opens the marketplace website rather than installing extensions into Friday.
- Build and typecheck scripts are present in `package.json`.

## Current uncommitted work

The working tree indicates active implementation of:

- Multi-folder workspaces, including adding/removing folders, selecting directories, and refreshing a folder.
- Multiple terminal sessions, terminal tabs, shell profiles, per-session input/resize/stop, and retaining terminal views while hidden.
- Choosing which workspace folder a new terminal should use.
- Small explorer and terminal UI updates.

These changes have not been committed yet. This report is based on code inspection; it does not claim that the uncommitted features have been runtime-verified.

## Known gaps and limits visible in the current implementation

- Outline and Timeline are placeholders that show guidance text; they are not implemented panels.
- Extensions is a link to the external marketplace, not an extension host or installer.
- Source control is intentionally basic: there is no per-file staging, diff viewer, branch management, or conflict workflow in the UI.
- The AI panel is chat only. It does not apply code edits, stream responses, manage conversation history persistently, or securely store credentials across restarts.
- The status bar currently displays fixed `0 errors` and `0 warnings`; it is not connected to diagnostics.
- Editor settings such as font size and word wrap appear to be session state rather than persisted preferences.
- No automated test suite is listed in the package scripts. This review did not run the build, typecheck, or manual app workflows.
- The code-running feature covers selected extensions and common web-app conventions; it is not a general build/debug system.

## Suggested next additions

### Highest priority: reliability and release readiness

1. Run the typecheck/build and manually exercise the main flows on supported platforms, especially file save/delete, project switching with dirty files, terminal session lifecycle, SSH failures, Git errors, and web preview.
2. Add automated tests around workspace path validation, file operations, project search, terminal session management, and key unsaved-file behaviors.
3. Add user-facing error/loading states where operations can fail or take time, and fix any encoding or platform-specific issues found during verification.
4. Document supported operating systems, setup, limitations, and packaging/release steps in the README.

### Product improvements

5. Complete the latest multi-root and multi-terminal work, verify it, then commit it as a coherent change.
6. Add a real diff and per-file staging workflow to source control.
7. Persist editor/workspace preferences and recent workspace layout; consider restoring open tabs safely.
8. Connect diagnostics and formatting/language services, or make the status bar clearly reflect that these are not yet available.
9. Improve the AI assistant with streaming, conversation reset/history, clearer context controls, and an explicit code-change review/apply workflow.
10. Add richer run/debug configuration so users can configure commands and environments beyond the built-in extension mappings.

## Development history

Recent commit subjects show the project moving from the initial editor shell toward a working prototype:

- Initial Friday/IDE shell and Monaco editor.
- Filesystem explorer connected to the editor and file loading.
- File saving, dirty state, and `Ctrl+S` support.
- Styling and prototype completion work.
- Current uncommitted iteration adds multi-folder workspaces and terminal sessions.

## Where the project stands

Friday is beyond a static UI mockup: the core local editing loop and several supporting workflows are implemented. The best description is **an early, feature-rich IDE prototype**. The immediate next step is to verify the current working tree, especially the new workspace and terminal changes, then address reliability and the most visible gaps before expanding the feature set further.
