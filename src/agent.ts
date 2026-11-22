/** Commands outside these two CLIs are passed through as configured (including an empty shell). */
export function agentKind(command: string): 'claude' | 'codex' | 'custom' {
  const match = /^(claude|codex)(?:\.exe|\.cmd)?(?:\s|$)/i.exec(command);
  return match ? match[1].toLowerCase() as 'claude' | 'codex' : 'custom';
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
