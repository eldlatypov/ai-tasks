# The agent CLI

A new task opens a terminal and runs the agent command in it, `claude` by default
([Claude Code](https://docs.claude.com/en/docs/claude-code/setup)).

It is started with an extra settings file that adds hooks: they report the agent's state
(working, needs input, finished) to AI Tasks. Your own Claude Code settings are not changed, and
the hooks do nothing outside task terminals.

Leave `aiTasks.agentCommand` empty to get a plain shell instead.
