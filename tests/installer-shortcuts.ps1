param(
    [string] $InstallerInclude,
    [string] $SourceExecutable,
    [switch] $KeepArtifacts
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$sourceExe = if ($SourceExecutable) {
    (Resolve-Path -LiteralPath $SourceExecutable).Path
} else {
    Join-Path $repo 'dist-electron\win-unpacked\Sunday Room.exe'
}
if (-not (Test-Path -LiteralPath $sourceExe -PathType Leaf)) {
    throw "Build the unpacked desktop app first: $sourceExe"
}

$id = [Guid]::NewGuid().ToString('N').Substring(0, 12)
$name = "Sunday Room Shortcut Test $id"
$appId = "com.sundayroom.shortcuttest.$id"
$packageName = "sunday-room-shortcut-test-$id"
$runRoot = Join-Path $repo ".scratch\installer-shortcuts-$id"
$fixture = Join-Path $runRoot 'fixture'
$output = Join-Path $runRoot 'output'
$install = Join-Path $runRoot "install\$name"
$installer = Join-Path $output 'Shortcut-Test-Setup.exe'
$installedExe = Join-Path $install "$name.exe"
$uninstaller = Join-Path $install "Uninstall $name.exe"
$desktopLink = Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) "$name.lnk"
$startLink = Join-Path ([Environment]::GetFolderPath('Programs')) "$name.lnk"
$fixtureExe = Join-Path $fixture "$name.exe"
$updaterCache = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) "$packageName-updater"
$installed = $false
$ownsShortcuts = $false

function Invoke-Installer([string] $extraArguments) {
    $arguments = "/S /currentuser $extraArguments /D=$install"
    $start = [Diagnostics.ProcessStartInfo]::new($installer, $arguments)
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $process = [Diagnostics.Process]::Start($start)
    if (-not $process.WaitForExit(120000)) {
        $process.Kill()
        throw "Installer timed out: $arguments"
    }
    if ($process.ExitCode -ne 0) {
        throw "Installer exited $($process.ExitCode): $arguments"
    }
}

function Assert-Shortcut([string] $linkPath) {
    if (-not (Test-Path -LiteralPath $linkPath -PathType Leaf)) {
        throw "Missing shortcut: $linkPath"
    }
    $shortcut = $script:shell.CreateShortcut($linkPath)
    if ($shortcut.TargetPath -ine $installedExe) {
        throw "Wrong target for $linkPath. Expected $installedExe, got $($shortcut.TargetPath)"
    }
    if ($shortcut.IconLocation -ine "$installedExe,0") {
        throw "Wrong icon for $linkPath. Expected $installedExe,0, got $($shortcut.IconLocation)"
    }
}

function Assert-Shortcuts {
    if (-not (Test-Path -LiteralPath $installedExe -PathType Leaf)) {
        throw "Missing installed executable: $installedExe"
    }
    Assert-Shortcut $desktopLink
    Assert-Shortcut $startLink
}

try {
    New-Item -ItemType Directory -Path (Join-Path $fixture 'resources'), $output -Force | Out-Null
    Copy-Item -LiteralPath $sourceExe -Destination $fixtureExe
    $builder = Join-Path $repo 'node_modules\electron-builder\out\cli\cli.js'
    $builderArgs = @(
        $builder, '--win', 'nsis', '--x64', '--publish', 'never',
        '--prepackaged', $fixture, '-c.compression=store',
        "-c.appId=$appId", "-c.extraMetadata.name=$packageName",
        "-c.productName=$name", "-c.win.executableName=$name",
        "-c.nsis.shortcutName=$name", '-c.nsis.runAfterFinish=false',
        '-c.win.signAndEditExecutable=false',
        "-c.directories.output=$output", '-c.artifactName=Shortcut-Test-Setup.exe'
    )
    if ($InstallerInclude) {
        $builderArgs += "-c.nsis.include=$((Resolve-Path -LiteralPath $InstallerInclude).Path)"
    }
    Push-Location $repo
    try {
        & node @builderArgs
        if ($LASTEXITCODE -ne 0) { throw "electron-builder exited $LASTEXITCODE" }
    } finally {
        Pop-Location
    }
    if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) {
        throw "Test installer was not built: $installer"
    }
    if ((Test-Path -LiteralPath $desktopLink) -or (Test-Path -LiteralPath $startLink)) {
        throw "Test shortcut name already exists: $name"
    }
    $ownsShortcuts = $true

    $shell = New-Object -ComObject WScript.Shell
    $installed = $true
    Invoke-Installer ''
    Assert-Shortcuts
    Write-Host 'Fresh install created both shortcuts with the installed executable and icon.'

    Remove-Item -LiteralPath $desktopLink, $startLink
    Invoke-Installer '--updated'
    Assert-Shortcuts
    Write-Host 'Updated install recreated both deleted shortcuts.'

    Invoke-Installer '--updated'
    Assert-Shortcuts
    Write-Host 'Repeated updated install kept both shortcuts valid.'

    Remove-Item -LiteralPath $desktopLink, $startLink
    Invoke-Installer ''
    Assert-Shortcuts
    Write-Host 'Repeated manual install recreated both deleted shortcuts.'
} finally {
    if ($installed -and (Test-Path -LiteralPath $uninstaller -PathType Leaf)) {
        $start = [Diagnostics.ProcessStartInfo]::new($uninstaller, "/S /currentuser _?=$install")
        $start.UseShellExecute = $false
        $start.CreateNoWindow = $true
        $process = [Diagnostics.Process]::Start($start)
        if (-not $process.WaitForExit(120000)) {
            $process.Kill()
            throw "Test uninstaller timed out: $uninstaller"
        }
        if ($process.ExitCode -ne 0) {
            throw "Test uninstaller exited $($process.ExitCode): $uninstaller"
        }
    }
    if ($ownsShortcuts) {
        Remove-Item -LiteralPath $desktopLink, $startLink -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $updaterCache) {
        $resolvedCache = [IO.Path]::GetFullPath($updaterCache)
        $localData = [Environment]::GetFolderPath('LocalApplicationData')
        if ([IO.Path]::GetDirectoryName($resolvedCache) -ine $localData -or
            [IO.Path]::GetFileName($resolvedCache) -ne "$packageName-updater") {
            throw "Refusing to remove a cache outside the test package: $resolvedCache"
        }
        Remove-Item -LiteralPath $resolvedCache -Recurse -Force
    }
    if (-not $KeepArtifacts -and (Test-Path -LiteralPath $runRoot)) {
        $resolvedRoot = [IO.Path]::GetFullPath($runRoot)
        $scratchRoot = [IO.Path]::GetFullPath((Join-Path $repo '.scratch'))
        if (-not $resolvedRoot.StartsWith("$scratchRoot\", [StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing to remove a directory outside scratch: $resolvedRoot"
        }
        Remove-Item -LiteralPath $resolvedRoot -Recurse -Force
    }
}
