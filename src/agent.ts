type AgentKind = 'claude' | 'codex' | 'opencode' | 'custom';

export function agentKind(command: string): AgentKind {
  const match = /^(claude|codex|opencode)(?:\.exe|\.cmd)?(?:\s|$)/i.exec(command);
  return match ? match[1].toLowerCase() as AgentKind : 'custom';
}

export function usesManagedOpenCodeSession(command: string): boolean {
  return agentKind(command) === 'opencode'
    && !/^\S+\s+[^-\s]/.test(command)
    && !/\s(?:--session|--continue|-s|-c)(?:\s|=|$)/.test(command);
}

export function isOpenCodeSessionId(id: string | undefined): id is string {
  return !!id && /^ses_[A-Za-z0-9_-]+$/.test(id);
}

const codexEvents = [
  'SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'PostToolUse', 'SubagentStart',
  'SubagentStop', 'Stop', 'Interrupt', 'SessionEnd',
];

export function codexCommand(command: string, sessionId?: string): string {
  // Keep the hook arguments usable in PowerShell (including 5.1), cmd and POSIX shells.
  // The private server inherits this task terminal's environment, even with several tasks in one cwd.
  const handler = "hooks=[{type='command',command='ai-tasks-codex-hook'}]";
  const hooks = codexEvents.map(event => `${event}=[{${handler}}]`);
  hooks.push(`PreToolUse=[{matcher='^(request_user_input|request_user_input_async)$',${handler}}]`);
  const resume = isSessionId(sessionId) ? ` resume ${sessionId}` : '';
  return `${command} --no-daemon -c "hooks={${hooks.join(',')}}"${resume}`;
}

export function isSessionId(id: string | undefined): id is string {
  return !!id && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id);
}
