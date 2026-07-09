param(
  [string]$Root = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = "Stop"
$commit = "3f24e7c53085854d122bb5d6629d1d503ba29e35"
$hookHash = "6225C2362567F818CF6E67E66CD7125A32EC0EA727285643B1E5A377387C5B5F"
$licenseHash = "DA7EABB7BAFDF7D3AE5E9F223AA5BDC1EECE45AC569DC21B3B037520B4464768"
$raw = "https://raw.githubusercontent.com/bjin/mpv-prescalers/$commit"

$rootPath = [IO.Path]::GetFullPath($Root)
$target = [IO.Path]::GetFullPath((Join-Path $rootPath "third_party\ravu-lite"))
if (-not $target.StartsWith($rootPath, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Destino saiu do workspace: $target"
}
[IO.Directory]::CreateDirectory($target) | Out-Null

$hook = (Invoke-WebRequest -UseBasicParsing "$raw/ravu-lite-ar-r3.hook").Content
$license = (Invoke-WebRequest -UseBasicParsing "$raw/LICENSE").Content
$utf8 = [Text.UTF8Encoding]::new($false)

function Assert-Hash([string]$Text, [string]$Expected, [string]$Name) {
  $actual = [Convert]::ToHexString(
    [Security.Cryptography.SHA256]::HashData($utf8.GetBytes($Text))
  )
  if ($actual -ne $Expected) { throw "$Name SHA-256 divergente: $actual" }
}

Assert-Hash $hook $hookHash "RAVU hook"
Assert-Hash $license $licenseHash "LGPL"

$lines = $hook -split "`n"
$firstHook = [Array]::IndexOf($lines, "vec4 hook() {")
$secondDesc = [Array]::IndexOf($lines, "//!DESC RAVU-Lite-AR (step2, r3)")
if ($firstHook -lt 0 -or $secondDesc -lt 0) { throw "Passos RAVU não encontrados" }

$body = ($lines[$firstHook..($secondDesc - 1)] -join "`n")
$body = $body.Replace("vec4 hook() {", "void main() {`n  ivec2 base = ivec2(floor(v_uv * vec2(textureSize(u_source, 0))));")
$body = [regex]::Replace(
  $body,
  'HOOKED_texOff\(vec2\(([-0-9.]+), ([-0-9.]+)\)\)\.x',
  {
    param($match)
    $x = [int][double]$match.Groups[1].Value
    $y = [int][double]$match.Groups[2].Value
    "loadLuma(base + ivec2($x, $y))"
  }
)
$body = $body.Replace("ravu_lite_lut3", "u_lut")
$body = $body.Replace("return res;", "outColor = res;")

$step1 = @"
#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D u_source;
uniform sampler2D u_lut;
in vec2 v_uv;
out vec4 outColor;

float loadLuma(ivec2 p) {
  ivec2 size = textureSize(u_source, 0);
  vec3 rgb = texelFetch(u_source, clamp(p, ivec2(0), size - 1), 0).rgb;
  return dot(rgb, vec3(0.2126, 0.7152, 0.0722));
}

$body
"@

$compose = @'
#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D u_source;
uniform sampler2D u_packed;
uniform vec2 u_source_size;
uniform vec2 u_output_texel;
uniform float u_compare;
in vec2 v_uv;
out vec4 outColor;

float componentAt(vec4 value, int index) {
  if (index == 0) return value.x;
  if (index == 1) return value.y;
  if (index == 2) return value.z;
  return value.w;
}

float fetchRavu(ivec2 logicalPixel) {
  ivec2 logicalSize = ivec2(u_source_size) * 2;
  logicalPixel = clamp(logicalPixel, ivec2(0), logicalSize - 1);
  ivec2 packedPixel = logicalPixel / 2;
  ivec2 parity = logicalPixel - packedPixel * 2;
  int index = parity.x * 2 + parity.y;
  return componentAt(texelFetch(u_packed, packedPixel, 0), index);
}

float sampleRavu(vec2 uv) {
  vec2 position = uv * (u_source_size * 2.0) - 0.5;
  ivec2 base = ivec2(floor(position));
  vec2 fraction = fract(position);
  float a = fetchRavu(base);
  float b = fetchRavu(base + ivec2(1, 0));
  float c = fetchRavu(base + ivec2(0, 1));
  float d = fetchRavu(base + ivec2(1, 1));
  return mix(mix(a, b, fraction.x), mix(c, d, fraction.x), fraction.y);
}

float luma(vec3 rgb) {
  return dot(rgb, vec3(0.2126, 0.7152, 0.0722));
}

void main() {
  vec3 original = texture(u_source, vec2(v_uv.x, 1.0 - v_uv.y)).rgb;
  if (u_compare > 0.5 && abs(v_uv.x - 0.5) < 1.5 * u_output_texel.x) {
    outColor = vec4(0.0, 1.0, 0.53, 1.0);
    return;
  }
  if (u_compare > 0.5 && v_uv.x < 0.5) {
    outColor = vec4(original, 1.0);
    return;
  }
  float enhancedLuma = sampleRavu(v_uv);
  vec3 enhanced = clamp(original + vec3(enhancedLuma - luma(original)), 0.0, 1.0);
  outColor = vec4(enhanced, 1.0);
}
'@

$port = @"
"use strict";
/*
 * RAVU-Lite-AR r3 WebGL2 port.
 * Copyright belongs to the upstream mpv-prescalers contributors.
 * Licensed under LGPL-3.0-or-later; see third_party/ravu-lite/LICENSE.
 * Modified for RGB input, WebGL2 uniforms and fused arbitrary-ratio output.
 * Upstream commit: $commit
 */
globalThis.__fvRavuShaders = Object.freeze({
  commit: "$commit",
  step1: String.raw``$step1``,
  compose: String.raw``$compose``,
});
"@

$hex = $lines[201].Trim()
if ($hex.Length -ne 119808) { throw "LUT RAVU com tamanho inesperado" }
$lut = [Convert]::FromHexString($hex)

[IO.File]::WriteAllText((Join-Path $target "ravu-lite-ar-r3.hook"), $hook, $utf8)
[IO.File]::WriteAllText((Join-Path $target "LICENSE"), $license, $utf8)
[IO.File]::WriteAllBytes((Join-Path $target "ravu-lite-lut3.bin"), $lut)
[IO.File]::WriteAllText((Join-Path $target "ravu-lite-webgl2.js"), $port, $utf8)

Write-Output "Generated RAVU-lite port from $commit"
Write-Output "LUT bytes: $($lut.Length)"
