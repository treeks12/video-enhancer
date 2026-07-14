$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$root = $PSScriptRoot
$firefoxManifest = Join-Path $root "manifest.json"
$chromiumManifest = Join-Path $root "manifest.chromium.json"

if (-not (Test-Path -LiteralPath $chromiumManifest -PathType Leaf)) {
    throw "manifest.chromium.json does not exist. The build did not create or change dist/."
}

$firefoxVersion = [string](Get-Content -LiteralPath $firefoxManifest -Raw | ConvertFrom-Json).version
$chromiumVersion = [string](Get-Content -LiteralPath $chromiumManifest -Raw | ConvertFrom-Json).version
$versionPattern = '^[0-9]+(?:\.[0-9]+){0,3}$'
if ($firefoxVersion -notmatch $versionPattern -or $chromiumVersion -notmatch $versionPattern) {
    throw "Invalid version: use 1 to 4 numeric components (for example, 0.0.48)."
}
if (-not $firefoxVersion -or $firefoxVersion -ne $chromiumVersion) {
    throw "Version mismatch: Firefox='$firefoxVersion', Chromium='$chromiumVersion'."
}

$dist = Join-Path $root "dist"
$runtimeFiles = @(
    "content.js"
    "fi-core.js"
    "popup.html"
    "popup.js"
    "_locales/en/messages.json"
    "icons/icon.svg"
    "icons/icon-16.png"
    "icons/icon-32.png"
    "icons/icon-48.png"
    "icons/icon-128.png"
    "THIRD_PARTY_NOTICES.txt"
    "third_party/ravu-lite/LICENSE"
    "third_party/ravu-lite/GPL-3.0.txt"
    "third_party/ravu-lite/ravu-lite-ar-r3.hook"
    "third_party/ravu-lite/ravu-lite-lut3.bin"
    "third_party/ravu-lite/ravu-lite-webgl2.js"
)

foreach ($relativePath in $runtimeFiles) {
    if (-not (Test-Path -LiteralPath (Join-Path $root $relativePath) -PathType Leaf)) {
        throw "Required file missing: $relativePath"
    }
}

$lut = Join-Path $root "third_party/ravu-lite/ravu-lite-lut3.bin"
if ((Get-Item -LiteralPath $lut).Length -ne 59904) {
    throw "Invalid RAVU LUT: expected 59904 bytes."
}

New-Item -ItemType Directory -Path $dist -Force | Out-Null

function New-Package([string]$Name, [string]$Manifest) {
    $target = Join-Path $dist $Name
    if (Test-Path -LiteralPath $target) {
        Remove-Item -LiteralPath $target -Recurse -Force
    }
    New-Item -ItemType Directory -Path $target -Force | Out-Null

    Copy-Item -LiteralPath $Manifest -Destination (Join-Path $target "manifest.json")
    foreach ($relativePath in $runtimeFiles) {
        $destination = Join-Path $target $relativePath
        New-Item -ItemType Directory -Path (Split-Path $destination) -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $root $relativePath) -Destination $destination
    }

    $zip = Join-Path $dist "firefox-video-enhancer-$Name-$firefoxVersion.zip"
    Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $zip) {
        throw "ZIP is in use: close/remove the temporary extension before rebuilding: $zip"
    }
    $archive = [IO.Compression.ZipFile]::Open($zip, [IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($file in Get-ChildItem -LiteralPath $target -Recurse -File) {
            $entryName = $file.FullName.Substring($target.Length + 1).Replace('\', '/')
            [IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
                $archive, $file.FullName, $entryName,
                [IO.Compression.CompressionLevel]::Optimal
            ) | Out-Null
        }
    } finally {
        $archive.Dispose()
    }

    $archive = [IO.Compression.ZipFile]::OpenRead($zip)
    try {
        $entries = @($archive.Entries.FullName)
        if ($entries -match '\\' -or
            "manifest.json" -notin $entries -or
            "third_party/ravu-lite/ravu-lite-lut3.bin" -notin $entries -or
            "third_party/ravu-lite/ravu-lite-webgl2.js" -notin $entries) {
            throw "ZIP $Name contains invalid paths or missing RAVU assets."
        }
    } finally {
        $archive.Dispose()
    }
}

New-Package "firefox" $firefoxManifest
New-Package "chromium" $chromiumManifest
Write-Host "Packages $firefoxVersion created in $dist"
