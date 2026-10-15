# AI IDE

A separate, portable copy of VS Code reorganised for working with CLI AI agents (Claude Code).
The regular VS Code install is not touched.

```
┌──────────────────────┬──────────────────────────────────────────────────────┐
│ Changes | Explorer   │  Task 1 ●   Task 2 ✳   Task 3 –   +     (title bar)    │
├──────────────────────┼───────────────────────────┬──────────────────────────┤
│ repo-a  3 changes    │ Agent | Terminal 2        │ file1 | file2            │
│   src/app.ts   M     │                           │                          │
│ repo-b  1 change     │  claude …                 │  diff / file             │
│ Tasks                │                           │  (close it → only the    │
│   Task 1 · finished  │                           │   terminal remains)      │
└──────────────────────┴───────────────────────────┴──────────────────────────┘
```

- **Tasks** — tabs in the title bar, right after the menu; drag a tab to reorder.
  A task = an agent terminal (+ extra terminals) and its own set of open files. Switching a task hides the other task's terminals and files; their processes keep
  running in the background.
- **Agent status on the tab** (from Claude Code hooks): `✳` working, bell — needs your input
  (permission prompt), `●` finished and not looked at yet, `–` idle, `⊘` not running.
  A background task that needs input also raises a notification.
- **Changes** — "only changes" explorer over **the repos of the active task**: its folder, files
  its agent edited, and repos where it ran a git command that changes them (`worktree add`,
  `switch`, `commit`, …), so sibling repos like `D:\repos\other`, nested repos and worktrees are
  in. A repo the agent only read stays out, and so do the repos other tasks are on; with no task
  open the view covers every repo the git extension knows.
  Each task's repos are remembered per workspace. Click a file for a diff against HEAD. Title
  buttons: full Explorer, refresh, add a repository to the active task by hand. Repos outside a
  trusted folder trigger VS Code's one-time "trust this folder?" prompt.
- **Agent / Classic** — the item at the right of the status bar switches the layout back to plain
  VS Code and again, in one click.
- After a window restart tasks are kept; the active task's agent is resumed (`claude --resume`).

## Install / update

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install.ps1
```

It downloads portable VS Code into `vscode\` (if missing), writes initial settings, builds and installs
the extension, patches the workbench with the task strip, and creates **AI IDE** shortcuts on the
Desktop and in the Start menu (opening `D:\repos`). Re-run it after changing the code;
`-SkipDownload`, `-NoShortcut`, `-OpenFolder <path>` are available.

To remove everything: delete the `vscode\` folder and the two `AI IDE` shortcuts.

### Variant B: a profile of the regular VS Code

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-profile.ps1
```

Installs the extension into an **AI Agents** profile of the installed VS Code (created on first run,
which opens a window), copies the default profile's settings, keybindings and extensions into it,
and creates **VS Code - AI Agents** shortcuts (`--profile "AI Agents" D:\repos`). The default profile
is not touched; switch with the shortcut or the profile switcher.

Same features except the title-bar task strip (that needs the patched workbench of the portable
copy): tasks are in the status bar and the AI IDE > Tasks view, where they can be dragged to reorder.
Options: `-ProfileName`, `-OpenFolder`, `-NoShortcut`, `-SkipExtensions`.

VS Code remembers a profile per folder, so a folder opened before (e.g. via "Open with Code") keeps
opening in the default profile. To open any folder in the profile from Explorer:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-context-menu.ps1
```

adds **Open in AI Agents** to the context menu of folders and folder backgrounds (per user,
no admin; on Windows 11 under "Show more options"). `-Uninstall` removes it.

## Keys

| Keys | |
|---|---|
| `Ctrl+Alt+N` | new task |
| `Ctrl+Alt+1…9` | switch to task N |
| `Ctrl+Alt+T` | pick a task |
| ``Ctrl+Alt+` `` | new terminal in the current task |

## Settings

- `aiIde.agentCommand` (default `claude`) — what starts in a new task's first terminal.
- `aiIde.shell`, `aiIde.shellArgs` — shell for task terminals (default Windows PowerShell).
- `aiIde.resumeActiveTaskOnStartup` (default on).

## How it works

- `extension/` — the VS Code extension.
  - `backgroundTerminal.ts`: terminals whose process outlives the tab. The process runs in node-pty
    (VS Code's own copy) and a headless xterm keeps the screen, so hiding a terminal only closes its
    view; showing it replays the screen.
    VS Code can't see which program runs in such a terminal, so its `terminalShellType` context key
    keeps the value of the last regular terminal. When that was PowerShell, the built-in
    `pastePwsh` binding takes Ctrl+V and sends a raw `^V` instead of the clipboard text. A
    keybinding contributed by the extension loses to `pastePwsh`, so the installers add a user
    keybinding (`scripts/paste-keybinding.ps1`) that sends Ctrl+V in editor-area terminals to
    `workbench.action.terminal.paste`.
  - `status.ts` + `hooks/hook.js`: task agents start as `claude --settings <generated file>` with
    hooks (UserPromptSubmit, PostToolUse, Notification, Stop, …) that write the state to a per-task
    file. Global Claude Code settings are not modified; the hook is a no-op outside AI IDE terminals.
  - `tasks.ts`: tasks, switching, per-task editors, persistence.
  - `changes.ts`: the multi-repo Changes view (built-in git extension API).
  - `taskStrip.ts`: tasks published as status bar items — the fallback switcher and the data source
    for the title-bar strip.
  - `layoutMode.ts`: Agent / Classic — applies a few settings and restores the previous values.
- `injected/taskstrip.js` — loaded into the VS Code window by a `<script>` tag that the installer adds
  to `workbench.html` (the checksum in `product.json` is updated so VS Code does not report a
  corrupt install). It only mirrors the status bar items as tabs and forwards clicks, so if a VS Code
  update breaks it, tasks remain usable from the status bar and the Tasks view.
- Auto-update of the portable copy is off (`update.mode: none`) so updates do not drop the patch.
  To update VS Code: delete `vscode\` except `vscode\data\`, re-run the installer.
