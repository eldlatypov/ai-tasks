const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { buildSync } = require('esbuild');
const Module = require('node:module');

test('changing the default starts new Codex tasks and reopens each saved task with its own CLI', async () => {
  const cwd = process.cwd();
  const sessionId = '01234567-89ab-cdef-0123-456789abcdef';
  const legacy = { id: 'older', name: 'Older', cwd, editors: [], sessionId };
  let saved = { tasks: [legacy] };
  let command = 'claude';
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
      showInputBox: async () => 'New Codex task',
      showQuickPick: async choices => choices.find(choice => choice.command === 'codex'),
    },
  };
  const compiled = buildSync({ entryPoints: ['src/tasks.ts'], platform: 'node', format: 'cjs',
    bundle: true, write: false, external: ['vscode'] }).outputFiles[0].text;
  const m = new Module('task-test', module);
  m.require = id => id === 'vscode' ? vscode : require(id);
  m._compile(compiled, 'task-test.cjs');
  const { TaskManager, selectDefaultAgent } = m.exports;
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
  assert.match(launches[0], /^codex --no-daemon /);
  manager.applyStatus(manager.all[1].id, { state: 'thinking', sessionId });
  command = '';
  const restored = new TaskManager(context, status, {});
  restored.spawn = manager.spawn;
  restored.startAgent(restored.all[1]);
  assert.ok(launches[1].endsWith(' resume ' + sessionId));
  restored.startAgent(restored.all[0]);
  assert.match(launches[2], /^claude --settings /);
  await manager.createTask();
  assert.equal(launches[3], undefined);
  command = 'my-custom-cli --flag';
  await manager.createTask();
  assert.equal(launches[4], command);
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
