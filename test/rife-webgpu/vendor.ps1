param(
  [Parameter(Mandatory = $true)][string]$ModelPath,
  [switch]$Force
)

$ErrorActionPreference = "Stop"
$ortVersion = "1.27.0"
$modelHashes = @(
  "9E98E435747AD3E045D810BA69EBB8325D6425D92C14CC7BF043657387E6BC18",
  "6DCF030CDE735FFFE27609379CD325682ACECE01F634BAC5BB9E00CFABF88C6C"
)
$root = [IO.Path]::GetFullPath($PSScriptRoot)
$modelSource = [IO.Path]::GetFullPath($ModelPath)
if (-not (Test-Path -LiteralPath $modelSource -PathType Leaf)) {
  throw "Modelo oficial exportado não encontrado: $modelSource"
}
$modelSha256 = (Get-FileHash -LiteralPath $modelSource -Algorithm SHA256).Hash
if ($modelSha256 -notin $modelHashes) {
  throw "SHA-256 inesperado. Exporte o Practical-RIFE 4.25 Lite com export-model.py."
}
$vendor = [IO.Path]::GetFullPath((Join-Path $root "vendor"))
if (-not $vendor.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Destino de vendor saiu da pasta do protótipo: $vendor"
}
if ($modelSource.StartsWith($vendor, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Use um ModelPath fora de vendor; -Force recria essa pasta."
}

$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$temp = [IO.Path]::GetFullPath((Join-Path $tempRoot "fve-rife-vendor-$PID"))
if (-not $temp.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Pasta temporária inválida: $temp"
}

if ((Test-Path $vendor) -and -not $Force) {
  throw "vendor já existe; use -Force para atualizar"
}
if (Test-Path $vendor) {
  Remove-Item -LiteralPath $vendor -Recurse -Force
}

try {
  [IO.Directory]::CreateDirectory($temp) | Out-Null
  [IO.Directory]::CreateDirectory($vendor) | Out-Null
  Push-Location $temp
  try {
    $archive = (npm.cmd pack "onnxruntime-web@$ortVersion" --silent | Select-Object -Last 1).Trim()
    if (-not $archive) { throw "npm pack não retornou o arquivo" }
    tar -xf $archive
  } finally {
    Pop-Location
  }

  foreach ($name in @(
    "ort.webgpu.min.js",
    "ort-wasm-simd-threaded.asyncify.mjs",
    "ort-wasm-simd-threaded.asyncify.wasm"
  )) {
    Copy-Item -LiteralPath (Join-Path $temp "package\dist\$name") -Destination (Join-Path $vendor $name) -Force
  }

  $model = Join-Path $vendor "rife.onnx"
  Copy-Item -LiteralPath $modelSource -Destination $model
  $actual = (Get-FileHash -LiteralPath $model -Algorithm SHA256).Hash
  if ($actual -ne $modelSha256) {
    throw "SHA-256 do modelo divergente: $actual"
  }

  Invoke-WebRequest -UseBasicParsing `
    -Uri "https://raw.githubusercontent.com/microsoft/onnxruntime/v$ortVersion/LICENSE" `
    -OutFile (Join-Path $vendor "onnxruntime-LICENSE.txt")
  Invoke-WebRequest -UseBasicParsing `
    -Uri "https://raw.githubusercontent.com/hzwer/Practical-RIFE/main/LICENSE" `
    -OutFile (Join-Path $vendor "Practical-RIFE-LICENSE.txt")

  @(
    "onnxruntime-web $ortVersion (MIT): https://www.npmjs.com/package/onnxruntime-web/v/$ortVersion",
    "Practical-RIFE 4.25 Lite, commit 17d8c7a1005b37f4c97bfee04e316aaec7fdc536 (MIT)",
    "Official checkpoint Google Drive ID: 1zlKblGuKNatulJNFf5jdB-emp9AqGK05",
    "Official checkpoint SHA-256: 81CDBA223FE72A120130CC8552E5D2ECAC824259D406F0C15323B3DECF96B8B1",
    "Exported ONNX SHA-256: $modelSha256",
    "Export recipe: ../export-model.py"
  ) | Set-Content -LiteralPath (Join-Path $vendor "SOURCES.txt") -Encoding utf8

  Write-Output "Vendor pronto: $vendor"
  Write-Output "Modelo verificado: $modelSha256"
} finally {
  if (Test-Path $temp) { Remove-Item -LiteralPath $temp -Recurse -Force }
}
