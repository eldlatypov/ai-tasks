# AI IDE

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
  showing a terminal again replays its screen. Tasks are listed in the AI IDE › Tasks view and in
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

- The agent CLI on `PATH` (`claude` by default, see `aiIde.agentCommand`).
- The built-in Git extension enabled (for the Changes view).

## Keys

| Keys | |
|---|---|
| `Ctrl+Alt+N` | new task |
| `Ctrl+Alt+1…9` | switch to task N |
| `Ctrl+Alt+T` | pick a task |
| ``Ctrl+Alt+` `` | new terminal in the current task |

## Settings

- `aiIde.agentCommand` (default `claude`): what starts in a new task's first terminal; empty starts
  a plain shell.
- `aiIde.baseBranch`: the branch the MR delta is computed against, e.g. `origin/develop`. Empty:
  the remote's default branch, else `origin/main`, `origin/master`, `main`, `master`.
- `aiIde.shell`, `aiIde.shellArgs`: shell for task terminals. Empty: Windows PowerShell on Windows,
  `$SHELL` elsewhere.
- `aiIde.resumeActiveTaskOnStartup` (default on).

## Notes

- Task terminals run their processes through the copy of node-pty that ships with VS Code.
- The title-bar task strip (`aiIde.titleBarStrip`) needs a patched workbench and is only available
  with the portable install from the project's scripts; leave it off in a regular VS Code.
