param(
  [string]$Root = (Split-Path -Parent $PSScriptRoot),
  [switch]$Offline,
  [switch]$Check
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
if (-not $Check) { [IO.Directory]::CreateDirectory($target) | Out-Null }

if ($Offline) {
  $hook = [IO.File]::ReadAllText((Join-Path $target "ravu-lite-ar-r3.hook"))
  $license = [IO.File]::ReadAllText((Join-Path $target "LICENSE"))
} else {
  $hook = (Invoke-WebRequest -UseBasicParsing "$raw/ravu-lite-ar-r3.hook").Content
  $license = (Invoke-WebRequest -UseBasicParsing "$raw/LICENSE").Content
}
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
if ($firstHook -lt 0 -or $secondDesc -lt 0) { throw "RAVU steps not found" }

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

# Split classification from the filter to bound synchronous driver compilation.
# Keep upstream math and tap order; adapt row encoding and repeated tap control.
$step1 = $step1.Replace("`r`n", "`n")
$lumaStart = $step1.IndexOf("float luma0")
$classifyEnd = $step1.IndexOf("float coord_y =")
$filterStart = $step1.IndexOf("vec4 res =")
$eigenStart = $step1.IndexOf("float a = abd.x")
if ($lumaStart -lt 0 -or $eigenStart -le $lumaStart -or $classifyEnd -le $eigenStart -or $filterStart -le $classifyEnd) {
  throw "RAVU classification/filter boundaries changed"
}
$tapCount = [regex]::Matches($step1, 'w = texture\(u_lut, vec2\(').Count
if ($tapCount -ne 13) { throw "RAVU filter no longer has thirteen LUT taps" }
$classifyTail = @'
float classificationRow = clamp((angle * 4.0 + strength) * 3.0 + coherence, 0.0, 287.0);
outColor = vec4(mod(classificationRow, 256.0) / 255.0, floor(classificationRow / 256.0) / 255.0, 0.0, 1.0);
}
'@
$gradientBody = @'
vec3 abd = vec3(0.0);
for (int gradient = 0; gradient < u_gradient_count; gradient++) {
  ivec2 offset = ivec2(gradient / 3 - 1, gradient % 3 - 1);
  ivec2 center = base + offset;
  float gx = (loadLuma(center + ivec2(1, 0)) - loadLuma(center - ivec2(1, 0))) / 2.0;
  float gy = (loadLuma(center + ivec2(0, 1)) - loadLuma(center - ivec2(0, 1))) / 2.0;
  float weight = 0.1018680644198163;
  if (offset.x == 0 || offset.y == 0) weight = 0.11543163961422666;
  if (gradient == 4) weight = 0.13080118386382833;
  abd += vec3(gx * gx, gx * gy, gy * gy) * weight;
}
'@
$filterTail = @'
vec4 res = vec4(0.0), w;
vec4 lo = vec4(0.0), hi = vec4(0.0), lo2 = vec4(0.0), hi2 = vec4(0.0), wg, cg4, cg4_1;
// Runtime iteration avoids duplicated anti-ringing code and private arrays.
// Re-fetch the same luma texels in the original tap/accumulator order; the
// LUT's integer coordinates match its fixed 13 x 288 NEAREST sampling.
vec2 rowBytes = round(texelFetch(u_classification, base, 0).rg * 255.0);
int lutRow = clamp(int(rowBytes.r) + int(rowBytes.g) * 256, 0, textureSize(u_lut, 0).y - 1);
for (int tap = 0; tap < textureSize(u_lut, 0).x; tap++) {
  ivec2 offset = ivec2(tap / 5 - 2, tap % 5 - 2);
  float nearLuma = loadLuma(base + offset);
  float farLuma = nearLuma;
  if (tap < 12) farLuma = loadLuma(base - offset);
  w = texelFetch(u_lut, ivec2(tap, lutRow), 0);
  if (tap == 12) {
    res += nearLuma * w;
  } else {
    res += nearLuma * w + farLuma * w.wzyx;
  }
  if (tap == 2 || tap == 6 || tap == 7 || tap == 8 || tap == 10 || tap == 11 || tap == 12) {
    wg = max(vec4(0.0), w);
    cg4 = vec4(0.1 + nearLuma, 1.1 - nearLuma, 0.1 + farLuma, 1.1 - farLuma);
    cg4_1 = cg4;
    cg4 *= cg4;cg4 *= cg4;cg4 *= cg4;cg4 *= cg4;cg4 *= cg4;
    if (tap == 12) {
      hi += cg4.x * wg;
      lo += cg4.y * wg;
    } else {
      hi += cg4.x * wg + cg4.z * wg.wzyx;
      lo += cg4.y * wg + cg4.w * wg.wzyx;
    }
    cg4 *= cg4_1;
    if (tap == 12) {
      hi2 += cg4.x * wg;
      lo2 += cg4.y * wg;
    } else {
      hi2 += cg4.x * wg + cg4.z * wg.wzyx;
      lo2 += cg4.y * wg + cg4.w * wg.wzyx;
    }
  }
}
lo = 1.1 - lo2 / lo;
hi = hi2 / hi - 0.1;
res = mix(res, clamp(res, lo, hi), 0.800000);
outColor = res;
}
'@
$classify = $step1.Substring(0, $lumaStart).Replace("uniform sampler2D u_lut;`n", "").Replace(
  "uniform sampler2D u_source;", "uniform sampler2D u_source;`nuniform int u_gradient_count;"
) + $gradientBody + "`n" + $step1.Substring($eigenStart, $classifyEnd - $eigenStart) + $classifyTail
$step1 = $step1.Substring(0, $lumaStart).Replace(
  "uniform sampler2D u_lut;",
  "uniform sampler2D u_lut;`nuniform sampler2D u_classification;"
) + $filterTail

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
  classify: String.raw``$classify``,
  step1: String.raw``$step1``,
  compose: String.raw``$compose``,
});
"@

# Deterministic UTF-8/LF output on every generation host.
$port = $port.Replace("`r`n", "`n").TrimEnd("`r", "`n") + "`n"

$hex = $lines[201].Trim()
if ($hex.Length -ne 119808) { throw "RAVU LUT has an unexpected size" }
$lut = [Convert]::FromHexString($hex)

$outputs = @{
  "ravu-lite-ar-r3.hook" = $utf8.GetBytes($hook)
  "LICENSE" = $utf8.GetBytes($license)
  "ravu-lite-lut3.bin" = $lut
  "ravu-lite-webgl2.js" = $utf8.GetBytes($port)
}
foreach ($name in $outputs.Keys) {
  $destination = Join-Path $target $name
  if ($Check) {
    if (-not [IO.File]::Exists($destination) -or
        [Convert]::ToBase64String([IO.File]::ReadAllBytes($destination)) -cne [Convert]::ToBase64String($outputs[$name])) {
      throw "Generated output differs: $name"
    }
  } else {
    [IO.File]::WriteAllBytes($destination, $outputs[$name])
  }
}
if ($Check) { Write-Output "PASS: generated RAVU artifacts match byte for byte"; return }

Write-Output "Generated RAVU-lite port from $commit"
Write-Output "LUT bytes: $($lut.Length)"
