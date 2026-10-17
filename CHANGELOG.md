# Changelog

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
