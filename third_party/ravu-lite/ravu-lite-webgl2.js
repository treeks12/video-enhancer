"use strict";
/*
 * RAVU-Lite-AR r3 WebGL2 port.
 * Copyright belongs to the upstream mpv-prescalers contributors.
 * Licensed under LGPL-3.0-or-later; see third_party/ravu-lite/LICENSE.
 * Modified for RGB input, WebGL2 uniforms and fused arbitrary-ratio output.
 * Upstream commit: 3f24e7c53085854d122bb5d6629d1d503ba29e35
 */
globalThis.__fvRavuShaders = Object.freeze({
  commit: "3f24e7c53085854d122bb5d6629d1d503ba29e35",
  classify: String.raw`#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D u_source;
uniform int u_gradient_count;
in vec2 v_uv;
out vec4 outColor;

float loadLuma(ivec2 p) {
  ivec2 size = textureSize(u_source, 0);
  vec3 rgb = texelFetch(u_source, clamp(p, ivec2(0), size - 1), 0).rgb;
  return dot(rgb, vec3(0.2126, 0.7152, 0.0722));
}

void main() {
  ivec2 base = ivec2(floor(v_uv * vec2(textureSize(u_source, 0))));
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
float a = abd.x, b = abd.y, d = abd.z;
float T = a + d, D = a * d - b * b;
float delta = sqrt(max(T * T / 4.0 - D, 0.0));
float L1 = T / 2.0 + delta, L2 = T / 2.0 - delta;
float sqrtL1 = sqrt(L1), sqrtL2 = sqrt(L2);
float theta = mix(mod(atan(L1 - a, b) + 3.141592653589793, 3.141592653589793), 0.0, abs(b) < 1.192092896e-7);
float lambda = sqrtL1;
float mu = mix((sqrtL1 - sqrtL2) / (sqrtL1 + sqrtL2), 0.0, sqrtL1 + sqrtL2 < 1.192092896e-7);
float angle = floor(theta * 24.0 / 3.141592653589793);
float strength = mix(mix(0.0, 1.0, lambda >= 0.004), mix(2.0, 3.0, lambda >= 0.05), lambda >= 0.016);
float coherence = mix(mix(0.0, 1.0, mu >= 0.25), 2.0, mu >= 0.5);
float classificationRow = clamp((angle * 4.0 + strength) * 3.0 + coherence, 0.0, 287.0);
outColor = vec4(mod(classificationRow, 256.0) / 255.0, floor(classificationRow / 256.0) / 255.0, 0.0, 1.0);
}`,
  step1: String.raw`#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D u_source;
uniform sampler2D u_lut;
uniform sampler2D u_classification;
in vec2 v_uv;
out vec4 outColor;

float loadLuma(ivec2 p) {
  ivec2 size = textureSize(u_source, 0);
  vec3 rgb = texelFetch(u_source, clamp(p, ivec2(0), size - 1), 0).rgb;
  return dot(rgb, vec3(0.2126, 0.7152, 0.0722));
}

void main() {
  ivec2 base = ivec2(floor(v_uv * vec2(textureSize(u_source, 0))));
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
}`,
  compose: String.raw`#version 300 es
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
}`,
});
