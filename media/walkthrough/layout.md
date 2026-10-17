# The Agent layout

Tasks work in any layout. The Agent layout sets these user settings so that a task's terminals
and files sit side by side:

| Setting | Value |
|---|---|
| `terminal.integrated.defaultLocation` | `editor`: terminals open as editor tabs |
| `workbench.editor.closeEmptyGroups` | `true`: closing a task's last file leaves its terminals |
| `scm.defaultViewMode` | `tree` |
| `workbench.secondarySideBar.defaultVisibility` | `hidden`: the chat side bar stays closed |

Your previous values are kept. Click **Agent** in the status bar or run
**AI Tasks: Restore My Layout Settings** to get them back; a setting you changed by hand in the
meantime stays as you set it. Do this before uninstalling the extension: VS Code gives an
extension no way to undo settings when it is removed.
