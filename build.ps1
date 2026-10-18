# Single packaging implementation, shared by Windows and other platforms.
param([ValidateSet('all','store','personal')][string]$Flavor = 'all')
$ErrorActionPreference = 'Stop'
$script = Join-Path $PSScriptRoot 'tools/package.py'
if (Get-Command py -ErrorAction SilentlyContinue) {
    & py -3 $script --flavor $Flavor
} elseif (Get-Command python -ErrorAction SilentlyContinue) {
    & python $script --flavor $Flavor
} else {
    throw 'Python 3.10 or newer is required. The builder uses only the standard library.'
}
if ($LASTEXITCODE -ne 0) { throw "Package build failed (exit $LASTEXITCODE)." }
