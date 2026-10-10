# "Open in AI Agents" in the Explorer context menu: opens a folder in the regular VS Code with the
# AI Agents profile (variant B, see install-profile.ps1). Without it, VS Code uses the profile it
# remembers for the folder, which is the default one for every folder opened before.
#
#   powershell -ExecutionPolicy Bypass -File scripts\install-context-menu.ps1 [-ProfileName "AI Agents"] [-Uninstall]
#
# Per user (HKCU), no admin rights needed. On Windows 11 the item is under "Show more options".

param(
    [string]$ProfileName = 'AI Agents',
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$keyName = 'VSCodeAIAgents'
# Right-click on a folder and inside a folder (empty space). Not on drives: "D:\" would end in \",
# which Windows parses as an escaped quote.
$parents = @(
    @{ Path = 'HKCU:\Software\Classes\Directory\shell'; Arg = '%1' },
    @{ Path = 'HKCU:\Software\Classes\Directory\Background\shell'; Arg = '%V' }
)

function Step($text) { Write-Host "==> $text" -ForegroundColor Cyan }

if ($Uninstall) {
    Step "Removing 'Open in $ProfileName' from the context menu"
    foreach ($p in $parents) {
        $key = Join-Path $p.Path $keyName
        if (Test-Path $key) { Remove-Item -Recurse -Force $key }
    }
    return
}

$codeCmd = (Get-Command code.cmd -ErrorAction SilentlyContinue).Source
if (-not $codeCmd) { throw 'VS Code CLI (code.cmd) not found on PATH.' }
$codeExe = Join-Path (Split-Path -Parent (Split-Path -Parent $codeCmd)) 'Code.exe'
if (-not (Test-Path $codeExe)) { throw "Code.exe not found next to the CLI: $codeExe" }

Step "Adding 'Open in $ProfileName' to the context menu"
foreach ($p in $parents) {
    $key = Join-Path $p.Path $keyName
    New-Item -Force $key | Out-Null
    Set-ItemProperty $key -Name '(default)' -Value "Open in $ProfileName"
    Set-ItemProperty $key -Name 'Icon' -Value "`"$codeExe`",0"
    New-Item -Force (Join-Path $key 'command') | Out-Null
    Set-ItemProperty (Join-Path $key 'command') -Name '(default)' -Value "`"$codeExe`" --profile `"$ProfileName`" `"$($p.Arg)`""
}
Step 'Done.'
