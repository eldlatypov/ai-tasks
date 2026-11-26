const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { buildSync } = require('esbuild');
const Module = require('node:module');

function loadModule(vscode, pty, entryPoint = 'src/tasks.ts', openCodeService) {
  const external = pty ? ['vscode', './pty'] : ['vscode'];
  if (openCodeService) external.push('@opencode/client/service');
  const compiled = buildSync({ entryPoints: [entryPoint], platform: 'node', format: 'cjs',
    bundle: true, write: false, external }).outputFiles[0].text;
  const m = new Module('task-test', module);
  m.require = id => {
    if (id === 'vscode') return vscode;
    if (id === './pty' && pty) return pty;
    if (id === '@opencode/client/service' && openCodeService) return { Service: openCodeService };
    return require(id);
  };
  m._compile(compiled, 'task-test.cjs');
  return m.exports;
}

test('changing the default starts new tasks and reopens each saved task with its own CLI', async () => {
  const cwd = process.cwd();
  const sessionId = '01234567-89ab-cdef-0123-456789abcdef';
  const legacy = { id: 'older', name: 'Older', cwd, editors: [], sessionId };
  let saved = { tasks: [legacy] };
  let command = 'claude';
  let selectedAgent = 'codex';
  let pickerItems;
  const config = {
    get: () => command, inspect: () => ({}),
    update: async (key, value, target) => {
      assert.equal(key, 'agentCommand');
      assert.equal(target, 'global');
      command = value;
    },
  };
  const vscode = {
    ConfigurationTarget: { Global: 'global' }, ViewColumn: { One: 1 },
    EventEmitter: class { event() {} fire() {} },
    workspace: { getConfiguration: () => config },
    window: {
      createOutputChannel: () => ({}),
      tabGroups: { onDidChangeTabs() {} },
      showInputBox: async () => 'New task',
      showQuickPick: async choices => {
        pickerItems = choices;
        return choices.find(choice => choice.command === selectedAgent);
      },
    },
  };
  const { TaskManager, selectDefaultAgent } = loadModule(vscode);
  const context = { workspaceState: { get: () => structuredClone(saved), update: (_, value) => { saved = structuredClone(value); } } };
  const status = { onStatus() {}, claudeSettingsPath: 'claude-hooks.json' };
  const manager = new TaskManager(context, status, {});
  assert.equal(saved.tasks[0].agentCommand, 'claude');
  await selectDefaultAgent();
  const launches = [];
  manager.spawn = (_, kind, name, initial) => { launches.push(initial); return {}; };
  manager.pickFolder = async () => cwd;
  manager.activate = async id => manager.startAgent(manager.get(id));
  await manager.createTask();
  assert.match(launches.shift(), /^codex --no-daemon /);
  manager.applyStatus(manager.all[1].id, { state: 'thinking', sessionId });
  selectedAgent = 'opencode';
  await selectDefaultAgent();
  assert.equal(command, 'opencode');
  await manager.createTask();
  const openCodeLaunch = launches.shift();
  assert.match(openCodeLaunch, /^opencode --session ses_[0-9a-f]{32}$/);

  command = 'opencode.cmd --standalone';
  await selectDefaultAgent();
  assert.equal(pickerItems.find(choice => choice.label === 'OpenCode')?.description, 'Current default');
  assert.equal(command, 'opencode.cmd --standalone');

  command = '';
  const restored = new TaskManager(context, status, {});
  restored.spawn = manager.spawn;
  await restored.startAgent(restored.all[1]);
  assert.ok(launches.shift().endsWith(' resume ' + sessionId));
  await restored.startAgent(restored.all[0]);
  assert.match(launches.shift(), /^claude --settings /);
  await restored.startAgent(restored.all[2]);
  assert.equal(launches.shift(), openCodeLaunch);
  await manager.createTask();
  assert.deepEqual(launches.splice(0), [undefined]);
  command = 'my-custom-cli --flag';
  await manager.createTask();
  assert.deepEqual(launches, [command]);
});

test('existing OpenCode tasks use separate sessions and can adopt a previous session', async () => {
  const cwd = process.cwd();
  const first = { id: 'first', name: 'First', cwd, agentCommand: 'opencode', editors: [] };
  const second = { ...first, id: 'second', name: 'Second', agentCommand: 'opencode.cmd --standalone' };
  const explicitCommand = 'opencode --session ses_explicit';
  const explicit = { ...first, id: 'explicit', name: 'Explicit', agentCommand: explicitCommand };
  let saved = { tasks: [first, second, explicit], activeId: first.id };
  let enteredId = 'ses_previous';
  const warnings = [];
  const vscode = {
    ViewColumn: { One: 1 },
    EventEmitter: class { event() {} },
    window: {
      createOutputChannel: () => ({}),
      tabGroups: { onDidChangeTabs() {} },
      showInformationMessage() {},
      showWarningMessage: message => warnings.push(message),
      showInputBox: async ({ validateInput }) => {
        assert.ok(validateInput('ses_test; invalid'));
        assert.equal(validateInput(enteredId), undefined);
        return enteredId;
      },
    },
  };
  const { TaskManager } = loadModule(vscode);
  const context = {
    workspaceState: {
      get: () => structuredClone(saved),
      update: async (_, value) => { saved = structuredClone(value); },
    },
  };
  const manager = new TaskManager(context, { onStatus() {} }, {});
  const launches = [];
  manager.spawn = (_, kind, name, initial) => { launches.push(initial); return {}; };

  await manager.startAgent(manager.get(first.id));
  await manager.startAgent(manager.get(second.id));
  assert.notEqual(saved.tasks[0].openCodeSessionId, saved.tasks[1].openCodeSessionId);
  assert.equal(launches[0], `opencode --session ${saved.tasks[0].openCodeSessionId}`);
  assert.equal(launches[1], `opencode.cmd --standalone --session ${saved.tasks[1].openCodeSessionId}`);

  await manager.useExistingOpenCodeSession();
  assert.equal(saved.tasks[0].openCodeSessionId, enteredId);
  const restored = new TaskManager(context, { onStatus() {} }, {});
  restored.spawn = manager.spawn;
  await restored.startAgent(restored.get(first.id));
  await restored.startAgent(restored.get(explicit.id));
  assert.deepEqual(launches.slice(2), ['opencode --session ses_previous', explicitCommand]);

  enteredId = saved.tasks[1].openCodeSessionId;
  await restored.useExistingOpenCodeSession();
  assert.equal(warnings.length, 1);
  assert.equal(saved.tasks[0].openCodeSessionId, 'ses_previous');
});

test('a question in a background task updates its status without a VS Code notification', () => {
  const notifications = [];
  const vscode = {
    ViewColumn: { One: 1 },
    EventEmitter: class {
      event = listener => { this.listener = listener; };
      fire() { this.listener?.(); }
    },
    window: {
      createOutputChannel: () => ({}),
      tabGroups: { onDidChangeTabs() {} },
      showInformationMessage: async message => { notifications.push(message); },
    },
  };
  const { TaskManager } = loadModule(vscode);
  const active = { id: 'active', name: 'Active', cwd: process.cwd(), agentCommand: 'codex', editors: [] };
  const background = { ...active, id: 'background', name: 'Background' };
  const context = { workspaceState: { get: () => ({ tasks: [active, background], activeId: active.id }) } };
  let reportStatus;
  const status = { onStatus: listener => { reportStatus = listener; } };
  const manager = new TaskManager(context, status, {});
  const states = [];
  manager.onDidChange(() => states.push(manager.get(background.id).state));

  reportStatus({ taskId: background.id, record: { state: 'waiting', message: 'Choose an option.' } });

  assert.deepEqual(states, ['waiting']);
  assert.equal(manager.active.id, active.id);
  assert.deepEqual(notifications, []);
});

test('the Codex terminal distinguishes automatic review from prompts that require a response', async () => {
  let terminalOutput;
  const pty = {
    loadNodePty: () => ({
      spawn: () => ({
        onData: listener => { terminalOutput = listener; },
        onExit() {},
        write() {},
      }),
    }),
    childEnv: env => env,
  };
  const vscode = {
    ViewColumn: { One: 1 },
    EventEmitter: class {
      event = listener => { this.listener = listener; };
      fire() { this.listener?.(); }
    },
    workspace: { getConfiguration: () => ({ get: (_, fallback) => fallback }) },
    window: {
      createOutputChannel: () => ({ error: (_, error) => { throw error; } }),
      tabGroups: { onDidChangeTabs() {} },
    },
  };
  const { TaskManager } = loadModule(vscode, pty);
  const saved = { id: 'codex', name: 'Codex', cwd: process.cwd(), agentCommand: 'codex', editors: [] };
  const context = { workspaceState: { get: () => ({ tasks: [saved] }) } };
  let reportStatus;
  const status = {
    onStatus: listener => { reportStatus = listener; },
    statusFileFor: () => 'codex.json',
    codexEnvironment: () => ({}),
  };
  const manager = new TaskManager(context, status, { ensure: () => 'artifacts.md' });
  const task = manager.get(saved.id);
  assert.equal(await manager.startAgent(task), true);
  const permissionRequest = { taskId: task.id, record: { state: 'waiting', event: 'PermissionRequest' } };
  const renderedStates = [];
  manager.onDidChange(() => renderedStates.push(task.state));

  async function reportTerminalStatus(...chunks) {
    for (const chunk of chunks) terminalOutput(chunk);
    await new Promise(resolve => task.agentTerminal.screen.write('', resolve));
  }

  reportStatus(permissionRequest);
  assert.equal(task.state, 'waiting');
  await reportTerminalStatus('\x1b]7501;state=working:app=codex\x1b\\');
  assert.equal(task.state, 'thinking');
  assert.equal(renderedStates.at(-1), 'thinking');

  reportStatus(permissionRequest);
  assert.equal(task.state, 'thinking');
  await reportTerminalStatus('\x1b]7501;state=blo', 'cked:app=codex:kind=permission\x1b\\');
  assert.equal(task.state, 'waiting');
  assert.equal(renderedStates.at(-1), 'waiting');
  reportStatus({ taskId: task.id, record: { state: 'thinking', event: 'PostToolUse' } });
  assert.equal(task.state, 'waiting');

  await reportTerminalStatus('\x1b]7501;state=working:app=codex\x1b\\');
  assert.equal(task.state, 'thinking');
  await reportTerminalStatus('\x1b]7501;state=blocked:app=codex:kind=question\x1b\\');
  assert.equal(task.state, 'waiting');
  await reportTerminalStatus('\x1b]7501;state=clear\x1b\\');
  assert.equal(task.state, 'thinking');
});

test('OpenCode reports foreground activity and background work for its own session only', async (t) => {
  let terminalOutput;
  const writes = [];
  const pty = {
    loadNodePty: () => ({
      spawn: () => ({
        onData: listener => { terminalOutput = listener; },
        onExit() {},
        write: data => writes.push(data),
      }),
    }),
    childEnv: env => env,
  };
  const vscode = {
    ViewColumn: { One: 1 },
    EventEmitter: class {
      event = listener => { this.listener = listener; };
      fire() { this.listener?.(); }
    },
    workspace: { getConfiguration: () => ({ get: (_, fallback) => fallback }) },
    window: {
      createOutputChannel: () => ({ error: (_, error) => { throw error; } }),
      tabGroups: { onDidChangeTabs() {} },
    },
  };
  const sessionId = 'ses_0123456789abcdef0123456789abcdef';
  const id = `ses_${createHash('sha256').update(sessionId).digest('hex').slice(0, 16)}`;
  let parentIsRunning = false;
  const backgroundJobs = [{ kind: 'subagent', description: 'Refresh sibling Git refs' }];
  const server = http.createServer((request, response) => {
    assert.equal(request.headers.authorization, 'test authorization');
    const url = new URL(request.url, 'http://localhost');
    response.setHeader('content-type', 'application/json');
    if (url.pathname === '/api/session/active') {
      response.end(JSON.stringify({ data: {
        ...(parentIsRunning ? { [sessionId]: { type: 'running' } } : {}),
        ses_other: { type: 'running' },
      } }));
      return;
    }
    assert.equal(url.pathname, '/api/experimental/job');
    assert.equal(url.searchParams.get('sessionID'), sessionId);
    assert.equal(url.searchParams.get('status'), 'running');
    assert.equal(url.searchParams.get('descendants'), 'true');
    response.end(JSON.stringify({ data: backgroundJobs }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const service = {
    discover: async () => ({ url: `http://127.0.0.1:${server.address().port}` }),
    headers: () => ({ authorization: 'test authorization' }),
  };
  const { TaskManager } = loadModule(vscode, pty, 'src/tasks.ts', service);
  const saved = {
    id: 'opencode', name: 'OpenCode', cwd: process.cwd(), agentCommand: 'opencode',
    openCodeSessionId: sessionId, editors: [],
  };
  const context = { workspaceState: { get: () => ({ tasks: [saved] }) } };
  const status = { onStatus() {}, statusFileFor: () => 'opencode.json' };
  const manager = new TaskManager(context, status, { ensure: () => 'artifacts.md' });
  const task = manager.get(saved.id);
  assert.equal(await manager.startAgent(task), true);
  t.after(() => task.agentTerminal.openCodeActivity.stop());
  const states = [];
  let onChange;
  manager.onDidChange(() => {
    states.push(task.state);
    onChange?.();
  });

  function waitForState(state) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`OpenCode did not report ${state}`)), 3000);
      onChange = () => {
        if (task.state !== state) return;
        clearTimeout(timeout);
        onChange = undefined;
        resolve();
      };
      onChange();
    });
  }

  async function report(data) {
    terminalOutput(`\x1b]7501;${data}\x1b\\`);
    await new Promise(resolve => task.agentTerminal.screen.write('', resolve));
  }

  await report('?');
  assert.match(writes.at(-1), /^\x1b\]7501;\?:states=/);
  await report('state=blocked:app=opencode');
  await report('state=working:id=ses_other:app=opencode');
  assert.equal(task.state, 'idle');
  await report(`state=working:id=${id}:app=opencode`);
  await waitForState('background');
  assert.deepEqual(task.background, [{ kind: 'agent', label: 'Refresh sibling Git refs' }]);
  await report(`state=working:id=${id}:app=opencode:title=VXBkYXRlZA==`);
  assert.equal(task.state, 'background');
  parentIsRunning = true;
  await waitForState('thinking');
  assert.deepEqual(task.background, []);
  await report(`state=blocked:id=${id}:app=opencode:kind=permission`);
  await report(`state=working:id=${id}:app=opencode`);
  await report(`state=clear:id=${id}`);
  await report('state=idle:app=opencode');
  assert.deepEqual(states, ['thinking', 'background', 'thinking', 'waiting', 'thinking', 'done']);
  await report('state=clear');
  assert.equal(task.state, 'stopped');
});

test('a reopened terminal preserves the mouse reporting format requested by its program', async (t) => {
  let output;
  let view;
  const pty = {
    childEnv: env => env,
    loadNodePty: () => ({
      spawn: () => ({
        onData: listener => { output = listener; },
        onExit() {},
        kill() {},
      }),
    }),
  };
  const vscode = {
    EventEmitter: class {
      event = listener => { this.listener = listener; };
      fire(data) { this.listener?.(data); }
      dispose() { this.listener = undefined; }
    },
    ThemeIcon: class {},
    window: {
      createTerminal({ pty }) {
        view = pty;
        return { dispose: () => pty.close() };
      },
    },
  };
  const { BackgroundTerminal } = loadModule(vscode, pty, 'src/backgroundTerminal.ts');
  const terminal = new BackgroundTerminal({
    id: 'agent', name: 'Agent', kind: 'agent', cwd: process.cwd(), shell: '', shellArgs: [], env: {},
  });
  t.after(() => terminal.dispose());

  function reopen() {
    terminal.hide();
    terminal.show(1, false);
    return new Promise(resolve => {
      view.onDidWrite(resolve);
      view.open();
    });
  }

  await reopen();
  output('\x1b[?1049h\x1b[?1003;10');
  output('06h');
  const cellMouseSnapshot = await reopen();
  assert.ok(cellMouseSnapshot.includes('\x1b[?1003h'));
  assert.ok(cellMouseSnapshot.includes('\x1b[?1006h'));

  output('\x1b[?1006l');
  assert.ok(!(await reopen()).includes('\x1b[?1006h'));

  output('\x1b[?1003;1016h');
  assert.ok((await reopen()).includes('\x1b[?1016h'));

  output('\x1bc');
  assert.ok(!(await reopen()).includes('\x1b[?1016h'));
});

test('Codex hooks report the task session, requests, artifacts and written repositories', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-tasks-test-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const file = path.join(cwd, 'task.json');
  const session = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  function hook(event, extra = {}) {
    const run = spawnSync(process.execPath, [path.resolve('hooks/hook.js'), 'codex'], {
      env: { ...process.env, AI_TASKS_STATUS_FILE: file, AI_TASKS_ARTIFACTS_FILE: path.join(cwd, 'artifacts.md') },
      input: JSON.stringify({ session_id: session, hook_event_name: event, cwd, ...extra }),
      encoding: 'utf8',
    });
    assert.equal(run.status, 0, run.stderr);
    return { record: JSON.parse(fs.readFileSync(file)), output: run.stdout };
  }
  const start = hook('SessionStart');
  assert.equal(start.record.state, 'idle');
  assert.equal(start.record.sessionId, session);
  assert.match(JSON.parse(start.output).hookSpecificOutput.additionalContext, /artifacts\.md/);
  assert.equal(hook('UserPromptSubmit').record.state, 'thinking');
  assert.equal(hook('PermissionRequest').record.state, 'waiting');
  assert.equal(hook('PreToolUse', { tool_name: 'request_user_input' }).record.state, 'waiting');
  assert.equal(hook('PostToolUse', {tool_name: 'apply_patch', tool_input: {
    command: '*** Begin Patch\n*** Update File: old name\n*** Move to: new name\n@@\n-old\n+new\n*** End Patch',
  }}).record.state, 'thinking');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(cwd, 'task.writes'), 'utf8')), [
    path.join(cwd, 'old name'), path.join(cwd, 'new name'),
  ]);
  hook('SubagentStart', {agent_id: 'worker', agent_type: 'reviewer'});
  assert.equal(hook('Stop').record.state, 'background');
  assert.equal(hook('SubagentStop', {agent_id: 'worker'}).record.state, 'done');
  assert.equal(hook('SessionEnd').record.state, 'stopped');
});
