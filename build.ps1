$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$root = $PSScriptRoot
$firefoxManifest = Join-Path $root "manifest.json"
$chromiumManifest = Join-Path $root "manifest.chromium.json"

if (-not (Test-Path -LiteralPath $chromiumManifest -PathType Leaf)) {
    throw "manifest.chromium.json não existe. O build não criou nem alterou dist/."
}

$firefoxVersion = [string](Get-Content -LiteralPath $firefoxManifest -Raw | ConvertFrom-Json).version
$chromiumVersion = [string](Get-Content -LiteralPath $chromiumManifest -Raw | ConvertFrom-Json).version
$versionPattern = '^[0-9]+(?:\.[0-9]+){0,3}$'
if ($firefoxVersion -notmatch $versionPattern -or $chromiumVersion -notmatch $versionPattern) {
    throw "Versão inválida: use de 1 a 4 componentes numéricos (ex.: 0.0.48)."
}
if (-not $firefoxVersion -or $firefoxVersion -ne $chromiumVersion) {
    throw "Versões divergentes: Firefox='$firefoxVersion', Chromium='$chromiumVersion'."
}

$dist = Join-Path $root "dist"
$runtimeFiles = @(
    "content.js"
    "fi-core.js"
    "popup.html"
    "popup.js"
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
        throw "Arquivo obrigatório ausente: $relativePath"
    }
}

$lut = Join-Path $root "third_party/ravu-lite/ravu-lite-lut3.bin"
if ((Get-Item -LiteralPath $lut).Length -ne 59904) {
    throw "LUT RAVU inválida: esperado 59904 bytes."
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
        throw "ZIP em uso: feche/remova a extensão temporária antes de recompilar: $zip"
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
            throw "ZIP $Name contém caminhos inválidos ou assets RAVU ausentes."
        }
    } finally {
        $archive.Dispose()
    }
}

New-Package "firefox" $firefoxManifest
New-Package "chromium" $chromiumManifest
Write-Host "Pacotes $firefoxVersion criados em $dist"
