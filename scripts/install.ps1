# AI IDE installer: portable VS Code + AI IDE extension + title-bar task strip.
# Everything lives under this repo's "vscode" folder; the regular VS Code install is not touched.
#
#   powershell -ExecutionPolicy Bypass -File scripts\install.ps1 [-OpenFolder D:\repos] [-SkipDownload] [-NoShortcut]
#
# Safe to re-run: it rebuilds and reinstalls the extension and re-applies the workbench patch.

param(
    [string]$OpenFolder = (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)),
    [switch]$SkipDownload,
    [switch]$NoShortcut
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$vscodeDir = Join-Path $root 'vscode'
$dataDir = Join-Path $vscodeDir 'data'
$userDir = Join-Path $dataDir 'user-data\User'

function Step($text) { Write-Host "==> $text" -ForegroundColor Cyan }
. (Join-Path $PSScriptRoot 'paste-keybinding.ps1')

# --- 1. portable VS Code -------------------------------------------------------------------
if (-not (Test-Path (Join-Path $vscodeDir 'Code.exe'))) {
    if ($SkipDownload) { throw "No VS Code in $vscodeDir and -SkipDownload was given." }
    Step 'Downloading VS Code (portable zip)'
    $zip = Join-Path $root '.download\vscode.zip'
    New-Item -ItemType Directory -Force (Split-Path $zip) | Out-Null
    $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest 'https://update.code.visualstudio.com/latest/win32-x64-archive/stable' -OutFile $zip
    Expand-Archive $zip -DestinationPath $vscodeDir -Force
}
# A "data" folder next to Code.exe switches VS Code to portable mode: settings, extensions and
# state stay inside it.
New-Item -ItemType Directory -Force $userDir | Out-Null

# --- 2. settings ---------------------------------------------------------------------------
$settingsPath = Join-Path $userDir 'settings.json'
if (-not (Test-Path $settingsPath)) {
    Step 'Writing initial settings'
    $settings = [ordered]@{
        # Pinned version: updates could overwrite the workbench patch. Update by re-running this script.
        'update.mode'                         = 'none'
        'window.titleBarStyle'                = 'custom'
        'workbench.startupEditor'             = 'none'
        # Sibling repos: open the parent folder and let git find every repo one level down.
        'git.autoRepositoryDetection'         = $true
        'git.repositoryScanMaxDepth'          = 1
        'git.openRepositoryInParentFolders'   = 'never'
        'files.watcherExclude'                = [ordered]@{ '**/node_modules/**' = $true; '**/ComfyUI_windows_portable/**' = $true }
        'search.exclude'                      = [ordered]@{ '**/ComfyUI_windows_portable' = $true }
        # Carried over from the regular VS Code settings.
        'explorer.confirmDelete'              = $false
        'terminal.integrated.mouseWheelScrollSensitivity' = 3
        'terminal.integrated.gpuAcceleration' = 'off'
        'extensions.ignoreRecommendations'    = $true
    }
    $settings | ConvertTo-Json -Depth 5 | Out-File -Encoding utf8 $settingsPath
}
# This install gets the title-bar task strip (step 4); tell the extension, also on existing installs.
try {
    $current = Get-Content -Raw $settingsPath | ConvertFrom-Json
    if ($current.'aiIde.titleBarStrip' -ne $true) {
        $current | Add-Member -NotePropertyName 'aiIde.titleBarStrip' -NotePropertyValue $true -Force
        $current | ConvertTo-Json -Depth 10 | Out-File -Encoding utf8 $settingsPath
    }
} catch {
    Write-Warning "Could not update $settingsPath (comments in it?). Add `"aiIde.titleBarStrip`": true by hand."
}
$mainKeybindings = Join-Path $env:APPDATA 'Code\User\keybindings.json'
$keybindingsPath = Join-Path $userDir 'keybindings.json'
if ((Test-Path $mainKeybindings) -and -not (Test-Path $keybindingsPath)) {
    Copy-Item $mainKeybindings $keybindingsPath
}
Add-PasteKeybinding $keybindingsPath

# --- 3. extension --------------------------------------------------------------------------
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
Step 'Installing the extension into the portable VS Code'
& (Join-Path $vscodeDir 'bin\code.cmd') --install-extension (Join-Path $extDir 'ai-ide.vsix') --force
if ($LASTEXITCODE) { throw 'extension install failed' }

# --- 4. workbench patch (task strip in the title bar) --------------------------------------
Step 'Patching the workbench with the task strip'
$appDirs = Get-ChildItem $vscodeDir -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'resources\app\product.json') }
if (-not $appDirs) { $appDirs = @(Get-Item $vscodeDir) }  # older, non-versioned layout
foreach ($dir in $appDirs) {
    $app = Join-Path $dir.FullName 'resources\app'
    $workbenchDir = Join-Path $app 'out\vs\code\electron-browser\workbench'
    $html = Join-Path $workbenchDir 'workbench.html'
    Copy-Item (Join-Path $root 'injected\taskstrip.js') (Join-Path $workbenchDir 'aiide-taskstrip.js') -Force

    $content = [IO.File]::ReadAllText($html)
    $tag = '<script src="./aiide-taskstrip.js"></script>'
    if (-not $content.Contains($tag)) {
        $content = $content.Replace('</html>', "`t$tag`n</html>")
        [IO.File]::WriteAllText($html, $content)
    }

    # VS Code verifies a few core files against product.json and shows "installation appears to be
    # corrupt" otherwise, so record the checksum of the patched file.
    $productPath = Join-Path $app 'product.json'
    $product = [IO.File]::ReadAllText($productPath)
    $sha = [Security.Cryptography.SHA256]::Create().ComputeHash([IO.File]::ReadAllBytes($html))
    $checksum = [Convert]::ToBase64String($sha).TrimEnd('=')
    $key = 'vs/code/electron-browser/workbench/workbench.html'
    $pattern = '("' + [regex]::Escape($key) + '"\s*:\s*")[^"]*(")'
    $updated = [regex]::Replace($product, $pattern, { param($m) $m.Groups[1].Value + $checksum + $m.Groups[2].Value })
    if ($updated -ne $product) { [IO.File]::WriteAllText($productPath, $updated) }
    Write-Host "    patched $html"
}

# --- 5. shortcuts --------------------------------------------------------------------------
if (-not $NoShortcut) {
    Step 'Creating "AI IDE" shortcuts (Desktop and Start menu)'
    $shell = New-Object -ComObject WScript.Shell
    $targets = @(
        (Join-Path ([Environment]::GetFolderPath('Desktop')) 'AI IDE.lnk'),
        (Join-Path ([Environment]::GetFolderPath('Programs')) 'AI IDE.lnk')
    )
    foreach ($lnkPath in $targets) {
        $lnk = $shell.CreateShortcut($lnkPath)
        $lnk.TargetPath = Join-Path $vscodeDir 'Code.exe'
        $lnk.Arguments = '"' + $OpenFolder + '"'
        $lnk.WorkingDirectory = $vscodeDir
        $lnk.IconLocation = (Join-Path $vscodeDir 'Code.exe') + ',0'
        $lnk.Description = 'VS Code with the AI IDE agent layout'
        $lnk.Save()
    }
}

Step "Done. Start it with the 'AI IDE' shortcut (opens $OpenFolder)."
