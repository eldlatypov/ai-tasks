# AI Tasks

Task tabs for working with CLI AI agents such as [Claude Code](https://claude.com/claude-code) in
VS Code. One task is one agent with its own terminals, its open files, its repositories and the
links it produced.

```
┌──────────────────────┬───────────────────────────┬──────────────────────────┐
│ Changes              │ Agent | Terminal 2        │ file1 | file2            │
│ repo-a  3 changes    │                           │                          │
│   src/app.ts   M     │  claude …                 │  diff / file             │
│ repo-b  1 change     │                           │                          │
│ Tasks                │                           │                          │
│   Task 1 · finished  │                           │                          │
│     Artifacts  4     │                           │                          │
│   Task 2 · working   │                           │                          │
└──────────────────────┴───────────────────────────┴──────────────────────────┘
```

## Features

- **Tasks.** A task is an agent terminal, extra terminals and a set of open files. Switching tasks
  hides the other task's terminals and files; their processes keep running in the background, and
  showing a terminal again replays its screen. Tasks are listed in the AI Tasks › Tasks view and in
  the status bar; drag them in the view to reorder.
- **Agent status** from Claude Code hooks: working, needs your input (permission prompt), finished
  and not looked at yet, idle, not running. A background task that needs input raises a
  notification. Global Claude Code settings are not modified: task agents start with
  `claude --settings <generated file>`.
- **Artifacts.** Each task has a Markdown file with links to what it produced: Jira issues, merge
  requests in any repository, Confluence pages, the feature stand. The agent is asked to keep it up
  to date; open it from the Artifacts item under the task.
- **Changes.** An "only changes" explorer over the repositories of the active task: its folder,
  files its agent edited and repositories where it ran git commands that change them, so sibling
  repos, nested repos and worktrees are included. Two modes:
  - **MR delta**: everything the branch changes against the base branch (merge base → working
    tree, untracked files included), what reviewers will see in the merge request;
  - **uncommitted changes**: working tree against HEAD.
- **Agent / Classic** layout switch in the status bar.
- After a window reload tasks are kept and the active task's agent resumes its session
  (`claude --resume`).

## Requirements

- The agent CLI on `PATH` (`claude` by default, see `aiTasks.agentCommand`).
- The built-in Git extension enabled (for the Changes view).

## Keys

| Keys | |
|---|---|
| `Ctrl+Alt+N` | new task |
| `Ctrl+Alt+1…9` | switch to task N |
| `Ctrl+Alt+T` | pick a task |
| ``Ctrl+Alt+` `` | new terminal in the current task |

## Settings

- `aiTasks.agentCommand` (default `claude`): what starts in a new task's first terminal; empty starts
  a plain shell.
- `aiTasks.baseBranch`: the branch the MR delta is computed against, e.g. `origin/develop`. Empty:
  the remote's default branch, else `origin/main`, `origin/master`, `main`, `master`.
- `aiTasks.shell`, `aiTasks.shellArgs`: shell for task terminals. Empty: Windows PowerShell on Windows,
  `$SHELL` elsewhere.
- `aiTasks.resumeActiveTaskOnStartup` (default on).

## Notes

- Task terminals run their processes through the copy of node-pty that ships with VS Code.
- On Windows, Ctrl+V pastes into task terminals even when VS Code's PowerShell paste binding
  is active (it would otherwise send a raw `^V`).

## Development

```
npm install
npm run package          # typecheck, bundle, ai-tasks.vsix
code --install-extension ai-tasks.vsix --force
```

Publishing to [Open VSX](https://open-vsx.org): bump `version`, add a CHANGELOG entry, then
`npm run publish:ovsx` with the access token in `OVSX_PAT`.

- `src/tasks.ts`: tasks, switching, per-task editors, persistence.
- `src/backgroundTerminal.ts`: terminals whose process outlives the tab. The process runs in
  VS Code's own node-pty and a headless xterm keeps the screen, so hiding a terminal only closes
  its view; showing it replays the screen.
- `src/status.ts` + `hooks/hook.js`: task agents start as `claude --settings <generated file>`
  with hooks that write the agent state to a per-task file, ask the agent to keep the artifacts
  file and log the paths it writes to. The hook is a no-op outside task terminals.
- `src/changes.ts`, `src/branchDelta.ts`, `src/repoTracker.ts`: the Changes view over the
  active task's repositories, uncommitted or as the MR delta.
- `src/taskStrip.ts`: tasks and the layout switch in the status bar.
- `src/layoutMode.ts`: Agent / Classic, applies a few settings and restores the previous values.
