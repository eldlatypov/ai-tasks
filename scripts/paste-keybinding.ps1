# Dot-sourced by the installers.
#
# Task terminals are extension terminals, so VS Code never learns which program runs in them and
# its terminalShellType context key keeps the value of the last regular terminal. When that was
# PowerShell, the built-in pastePwsh binding takes Ctrl+V and sends a raw ^V instead of the
# clipboard text. A binding contributed by the extension does not win over pastePwsh; a user
# keybinding does, so the installers add one to keybindings.json.

$PasteKeybinding = @'
    {
        "key": "ctrl+v",
        "command": "workbench.action.terminal.paste",
        "when": "terminalFocus && terminalEditorFocus"
    }
'@

function Add-PasteKeybinding([string]$Path) {
    if (-not (Test-Path $Path)) {
        [IO.File]::WriteAllText($Path, "[`n$PasteKeybinding`n]`n")
        return
    }
    $text = [IO.File]::ReadAllText($Path)
    if ($text -match '"workbench\.action\.terminal\.paste"') {
        return # already there, or the user has their own paste binding
    }
    $end = $text.LastIndexOf(']')
    if ($end -lt 0) {
        Write-Warning "Could not parse $Path. Add a ctrl+v binding to workbench.action.terminal.paste by hand."
        return
    }
    $head = $text.Substring(0, $end).TrimEnd()
    if (-not $head.EndsWith('[')) {
        # Comma right after the last entry, not at the end of the text: a trailing // comment would swallow it.
        $lastEntry = $head.LastIndexOf('}')
        $head = $head.Substring(0, $lastEntry + 1) + ',' + $head.Substring($lastEntry + 1)
    }
    [IO.File]::WriteAllText($Path, "$head`n$PasteKeybinding`n]`n")
}
