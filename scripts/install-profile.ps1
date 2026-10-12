# AI IDE as a profile of the regular VS Code (variant B).
# The extension goes into its own "AI Agents" profile: the default profile and its settings are
# not touched. No title-bar task strip here (that needs the patched workbench of the portable
# install, see install.ps1): tasks live in the status bar and in the AI IDE > Tasks view.
#
#   powershell -ExecutionPolicy Bypass -File scripts\install-profile.ps1 [-ProfileName "AI Agents"] [-OpenFolder D:\repos] [-NoShortcut] [-SkipExtensions]
#
# Safe to re-run: it rebuilds and reinstalls the extension into the profile.

param(
    [string]$ProfileName = 'AI Agents',
    [string]$OpenFolder = (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)),
    [switch]$NoShortcut,
    # Do not copy the default profile's extensions (e.g. Claude Code) into the new profile.
    [switch]$SkipExtensions
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$userDir = Join-Path $env:APPDATA 'Code\User'
$storagePath = Join-Path $userDir 'globalStorage\storage.json'

function Step($text) { Write-Host "==> $text" -ForegroundColor Cyan }
. (Join-Path $PSScriptRoot 'paste-keybinding.ps1')

$codeCmd = (Get-Command code.cmd -ErrorAction SilentlyContinue).Source
if (-not $codeCmd) { throw 'VS Code CLI (code.cmd) not found on PATH.' }
$codeExe = Join-Path (Split-Path -Parent (Split-Path -Parent $codeCmd)) 'Code.exe'

function Get-ProfileLocation {
    if (-not (Test-Path $storagePath)) { return $null }
    $storage = Get-Content -Raw $storagePath | ConvertFrom-Json
    $match = @($storage.userDataProfiles) | Where-Object { $_.name -eq $ProfileName } | Select-Object -First 1
    if ($match) { return Join-Path $userDir "profiles\$($match.location)" }
    return $null
}

# --- 1. extension ----------------------------------------------------------------------------
Step 'Building the AI IDE extension'
$extDir = Join-Path $root 'extension'
Push-Location $extDir
try {
    if (-not (Test-Path 'node_modules')) { npm install --no-audit --no-fund; if ($LASTEXITCODE) { throw 'npm install failed' } }
    npm run package
    if ($LASTEXITCODE) { throw 'extension build failed' }
} finally {
    Pop-Location
}

# --- 2. profile --------------------------------------------------------------------------------
# The CLI cannot create profiles; VS Code creates one when a window is opened with --profile.
$profileDir = Get-ProfileLocation
if (-not $profileDir) {
    Step "Creating the '$ProfileName' profile (opens a VS Code window)"
    & $codeCmd --profile $ProfileName --new-window $OpenFolder
    for ($i = 0; $i -lt 60 -and -not $profileDir; $i++) {
        Start-Sleep -Seconds 1
        $profileDir = Get-ProfileLocation
    }
    if (-not $profileDir) { throw "VS Code did not create the '$ProfileName' profile." }
}
New-Item -ItemType Directory -Force $profileDir | Out-Null
Write-Host "    profile folder: $profileDir"

# --- 3. extensions -----------------------------------------------------------------------------
Step 'Installing the AI IDE extension into the profile'
& $codeCmd --profile $ProfileName --install-extension (Join-Path $extDir 'ai-ide.vsix') --force
if ($LASTEXITCODE) { throw 'extension install failed' }
if (-not $SkipExtensions) {
    $inProfile = & $codeCmd --profile $ProfileName --list-extensions
    foreach ($id in (& $codeCmd --list-extensions)) {
        if ($inProfile -notcontains $id) {
            Step "Copying extension $id from the default profile"
            & $codeCmd --profile $ProfileName --install-extension $id
        }
    }
}

# --- 4. settings -------------------------------------------------------------------------------
# Start from the default profile's settings, add what AI IDE needs; never overwrite the profile's own values.
Step 'Writing profile settings'
$settingsPath = Join-Path $profileDir 'settings.json'
$settings = [ordered]@{}
foreach ($source in @($settingsPath, (Join-Path $userDir 'settings.json'))) {
    if (-not (Test-Path $source)) { continue }
    try {
        $json = Get-Content -Raw $source | ConvertFrom-Json
        foreach ($p in $json.PSObject.Properties) {
            if (-not $settings.Contains($p.Name)) { $settings[$p.Name] = $p.Value }
        }
    } catch {
        Write-Warning "Skipping $source (not plain JSON: comments?)."
    }
}
$defaults = [ordered]@{
    # Sibling repos: open the parent folder and let git find every repo one level down.
    'git.autoRepositoryDetection'       = $true
    'git.repositoryScanMaxDepth'        = 1
    'git.openRepositoryInParentFolders' = 'never'
    'workbench.startupEditor'           = 'none'
    'aiIde.titleBarStrip'               = $false
}
foreach ($k in $defaults.Keys) {
    if (-not $settings.Contains($k)) { $settings[$k] = $defaults[$k] }
}
$settings | ConvertTo-Json -Depth 10 | Out-File -Encoding utf8 $settingsPath

$keybindings = Join-Path $profileDir 'keybindings.json'
$mainKeybindings = Join-Path $userDir 'keybindings.json'
if ((Test-Path $mainKeybindings) -and -not (Test-Path $keybindings)) { Copy-Item $mainKeybindings $keybindings }
Add-PasteKeybinding $keybindings

# --- 5. shortcuts ------------------------------------------------------------------------------
if (-not $NoShortcut) {
    Step "Creating 'VS Code - $ProfileName' shortcuts (Desktop and Start menu)"
    $shell = New-Object -ComObject WScript.Shell
    foreach ($dir in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {
        $lnk = $shell.CreateShortcut((Join-Path $dir "VS Code - $ProfileName.lnk"))
        $lnk.TargetPath = $codeExe
        $lnk.Arguments = "--profile `"$ProfileName`" `"$OpenFolder`""
        $lnk.WorkingDirectory = Split-Path -Parent $codeExe
        $lnk.IconLocation = "$codeExe,0"
        $lnk.Description = "VS Code, '$ProfileName' profile with the AI IDE layout"
        $lnk.Save()
    }
}

Step "Done. Open it with the 'VS Code - $ProfileName' shortcut. If a window of this profile was already open, run 'Developer: Reload Window' in it."
