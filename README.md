# AI Tasks

**Run several CLI agents in VS Code at once, one task each.** A task is an agent such as
[Claude Code](https://claude.com/claude-code) or [Codex CLI](https://developers.openai.com/codex/cli/) with its own terminals, its own open files, its own
repositories and the links it produced. Switch tasks like browser tabs: the others keep working in
the background and tell you when they need you.

[![A task: the agent asks to edit a file on the left, the merge request delta it is working on on the right](media/screenshots/tasks-and-mr-delta.png)](https://github.com/eldlatypov/ai-tasks/raw/HEAD/media/screenshots/tasks-and-mr-delta.png)

## Every task knows its state

The Tasks view and the status bar show what each agent is doing: working, **needs your input**
(a permission prompt or a question), **waiting for background work** (its turn is over but a
Monitor watch, a background command or agent, or a scheduled wakeup will bring it back; the tooltip
lists them), finished, idle. A bell marks tasks that need your attention. Open the task to answer in its terminal.

Switching tasks hides the other task's terminals and files and brings back this one's, exactly as
you left them. The processes keep running; showing a terminal again replays its screen.

[![Another task: its own repository in Changes and the review its agent finished in the background, while the first task waits for an answer](media/screenshots/task-switch.png)](https://github.com/eldlatypov/ai-tasks/raw/HEAD/media/screenshots/task-switch.png)

## The merge request delta, across repositories

**Changes** lists what the active task's branches change against their base branch, from the merge
base to the working tree, untracked files included: what reviewers will see. It covers every
repository the task's agent touched, so a feature that spans `shop-api` and `shop-web` shows up as
one list. Click a file for the diff; switch to plain uncommitted changes from the view's title bar.

## Links in one place

Under each task, **Artifacts** keeps the links the work produced: the Jira issue, merge requests in
every repository, Confluence pages, the feature stand. The agent adds them as it goes.

[![The artifacts of a task: Jira issue, two merge requests, a Confluence page and the stand](media/screenshots/artifacts.png)](https://github.com/eldlatypov/ai-tasks/raw/HEAD/media/screenshots/artifacts.png)

## Your VS Code stays yours

AI Tasks works in your normal profile and changes settings only when you choose the **Agent layout**.
The layout opens terminals as editor tabs, closes empty editor groups and hides the chat sidebar.
Turn it on from **Get Started with AI Tasks** or the status bar. Switch back from the status bar
to restore your settings before uninstalling.

[![Get Started with AI Tasks](media/screenshots/get-started.png)](https://github.com/eldlatypov/ai-tasks/raw/HEAD/media/screenshots/get-started.png)

## Getting started

1. Install Claude Code or Codex CLI and sign in. Open **AI Tasks: Select Default Agent…** in the
   command palette or the Tasks view menu and choose the CLI for new tasks. The initial choice is Claude Code.
2. **Ctrl+Alt+N** starts a task: pick its folder, name it, and the agent opens.
3. **Ctrl+Alt+1…9** switches tasks, **Ctrl+Alt+T** picks one from a list,
   **Ctrl+Alt+`** opens another terminal in the current task.

Each task remembers its agent and session across window reloads. Claude Code receives a task
settings file. Codex receives per-session hooks and runs with its own local server. Use a Codex
CLI with `--no-daemon` and lifecycle hook support. Before sending the first prompt, open `/hooks` in Codex,
review the **ai-tasks-codex-hook** commands and trust them to enable status, session capture,
artifact instructions and repository tracking. Artifact edits follow the CLI's normal filesystem permissions.

**Settings:** `aiTasks.agentCommand` (default `claude`), `aiTasks.baseBranch` (the MR delta's base
when it is not the remote's default branch, e.g. `origin/develop`), `aiTasks.shell` and
`aiTasks.shellArgs` (default: PowerShell on Windows, `$SHELL` elsewhere),
`aiTasks.resumeActiveTaskOnStartup`, `aiTasks.checkForUpdates`.

**Updates:** Cursor, Windsurf, VSCodium and other editors that install from Open VSX update AI Tasks
themselves. VS Code only updates extensions from Microsoft's marketplace, so there AI Tasks looks
for a new version on Open VSX once a day and offers to install it (the package is checked against
its SHA-256 first). **AI Tasks: Check for Updates** does it on demand; `aiTasks.checkForUpdates`
turns it off.

## Development

```
npm install
npm run package          # typecheck, bundle, ai-tasks.vsix
code --install-extension ai-tasks.vsix --force
```

Publishing to [Open VSX](https://open-vsx.org): bump `version`, add a CHANGELOG entry, push `main`
to GitHub (the store page loads the screenshots from there), then `npm run publish:ovsx`. The
access token comes from `OVSX_PAT`, in the environment or in a git-ignored `.env` next to
`package.json` (`OVSX_PAT=...`).

- `src/tasks.ts`: tasks, switching, per-task editors, persistence.
- `src/backgroundTerminal.ts`: terminals whose process outlives the tab. The process runs in
  VS Code's own node-pty and a headless xterm keeps the screen, so hiding a terminal only closes
  its view; showing it replays the screen. On Windows a lone `^V` from VS Code's PowerShell paste
  binding is turned into a paste of the clipboard.
- `src/status.ts` + `hooks/hook.js`: the hooks write the agent state to a per-task file, ask the
  agent to keep the artifacts file and log the paths it writes to.
- `src/changes.ts`, `src/branchDelta.ts`, `src/repoTracker.ts`: the Changes view over the active
  task's repositories, uncommitted or as the MR delta.
- `src/taskStrip.ts`: tasks and the layout switch in the status bar.
- `src/layoutMode.ts` applies the optional Agent layout and restores the previous settings.
