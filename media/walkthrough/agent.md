# The agent CLI

Install Claude Code, Codex CLI or OpenCode 2, sign in and run **AI Tasks: Select Default Agent…**. New tasks use your selection. When an agent terminal restarts, AI Tasks can resume the task's session.

For Codex, review and trust the **ai-tasks-codex-hook** entries under `/hooks` before the
first prompt. These hooks report progress, identify changed repositories and give
the agent the location of the task's artifacts file.

Leave `aiTasks.agentCommand` empty to get a plain shell instead.
