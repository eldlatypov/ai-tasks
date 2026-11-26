# Changelog

## 0.1.7

- Choose OpenCode as the agent for new tasks and see when a session needs input.
- Resume OpenCode 2 sessions when reopening a task, or link an existing session with **Use Existing OpenCode Session…**.

## 0.1.6

- Keep mouse input working in terminal apps when you reopen a task terminal.

## 0.1.5

- Keep VS Code notifications for extension updates. Agent prompts stay in the task terminal.
- Use the Codex terminal's status to distinguish auto-review from prompts that need input.

## 0.1.4

- Choose Claude Code or Codex CLI for new tasks with **Select Default Agent…**.
  Each task keeps its agent and resumes its own session when reopened.
- Codex hooks report task status, track file edits across repositories and provide the task's
  artifact instructions. Review the AI Tasks hooks in Codex on first use.

## 0.1.3

- New task state, waiting for background work: the agent ended its turn but a Monitor watch, a
  background command or agent, or a scheduled wakeup it started is still pending. Shown with a
  telescope icon; the tooltip lists what it waits on. Before, such a task showed as finished.
- Updates in VS Code: AI Tasks checks Open VSX once a day and offers to install a new version
  (checksum-verified), as VS Code itself only updates extensions from its own marketplace. Command
  **Check for Updates**, setting `aiTasks.checkForUpdates`. Other editors update from Open VSX as before.

## 0.1.2

- Screenshots on the store page open full size on click.

## 0.1.1

- Store page with screenshots; source on GitHub.

## 0.1.0

First public release.

- Tasks: an agent terminal plus extra terminals and a set of open files per task; switching hides
  the other tasks' terminals and files while their processes keep running.
- Agent status on each task from Claude Code hooks: working, needs input, finished, idle, stopped.
- Task artifacts: a per-task file with links to Jira issues, merge requests, Confluence pages and
  the feature stand, kept up to date by the agent.
- Changes: changed files across the repositories of the active task, as uncommitted changes or as
  the MR delta against the base branch.
- Agent layout: optional, offered once on the first start and in the Get Started walkthrough;
  your previous settings come back with one click.
- Ctrl+V pastes into task terminals on Windows even when VS Code's PowerShell paste binding is
  active.
