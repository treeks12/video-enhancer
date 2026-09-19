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
  step1: String.raw`#version 300 es
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

void main() {
  ivec2 base = ivec2(floor(v_uv * vec2(textureSize(u_source, 0))));
float luma0 = loadLuma(base + ivec2(-2, -2));
float luma1 = loadLuma(base + ivec2(-2, -1));
float luma2 = loadLuma(base + ivec2(-2, 0));
float luma3 = loadLuma(base + ivec2(-2, 1));
float luma4 = loadLuma(base + ivec2(-2, 2));
float luma5 = loadLuma(base + ivec2(-1, -2));
float luma6 = loadLuma(base + ivec2(-1, -1));
float luma7 = loadLuma(base + ivec2(-1, 0));
float luma8 = loadLuma(base + ivec2(-1, 1));
float luma9 = loadLuma(base + ivec2(-1, 2));
float luma10 = loadLuma(base + ivec2(0, -2));
float luma11 = loadLuma(base + ivec2(0, -1));
float luma12 = loadLuma(base + ivec2(0, 0));
float luma13 = loadLuma(base + ivec2(0, 1));
float luma14 = loadLuma(base + ivec2(0, 2));
float luma15 = loadLuma(base + ivec2(1, -2));
float luma16 = loadLuma(base + ivec2(1, -1));
float luma17 = loadLuma(base + ivec2(1, 0));
float luma18 = loadLuma(base + ivec2(1, 1));
float luma19 = loadLuma(base + ivec2(1, 2));
float luma20 = loadLuma(base + ivec2(2, -2));
float luma21 = loadLuma(base + ivec2(2, -1));
float luma22 = loadLuma(base + ivec2(2, 0));
float luma23 = loadLuma(base + ivec2(2, 1));
float luma24 = loadLuma(base + ivec2(2, 2));
vec3 abd = vec3(0.0);
float gx, gy;
gx = (luma11-luma1)/2.0;
gy = (luma7-luma5)/2.0;
abd += vec3(gx * gx, gx * gy, gy * gy) * 0.1018680644198163;
gx = (luma12-luma2)/2.0;
gy = (luma8-luma6)/2.0;
abd += vec3(gx * gx, gx * gy, gy * gy) * 0.11543163961422666;
gx = (luma13-luma3)/2.0;
gy = (luma9-luma7)/2.0;
abd += vec3(gx * gx, gx * gy, gy * gy) * 0.1018680644198163;
gx = (luma16-luma6)/2.0;
gy = (luma12-luma10)/2.0;
abd += vec3(gx * gx, gx * gy, gy * gy) * 0.11543163961422666;
gx = (luma17-luma7)/2.0;
gy = (luma13-luma11)/2.0;
abd += vec3(gx * gx, gx * gy, gy * gy) * 0.13080118386382833;
gx = (luma18-luma8)/2.0;
gy = (luma14-luma12)/2.0;
abd += vec3(gx * gx, gx * gy, gy * gy) * 0.11543163961422666;
gx = (luma21-luma11)/2.0;
gy = (luma17-luma15)/2.0;
abd += vec3(gx * gx, gx * gy, gy * gy) * 0.1018680644198163;
gx = (luma22-luma12)/2.0;
gy = (luma18-luma16)/2.0;
abd += vec3(gx * gx, gx * gy, gy * gy) * 0.11543163961422666;
gx = (luma23-luma13)/2.0;
gy = (luma19-luma17)/2.0;
abd += vec3(gx * gx, gx * gy, gy * gy) * 0.1018680644198163;
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
float coord_y = ((angle * 4.0 + strength) * 3.0 + coherence + 0.5) / 288.0;
vec4 res = vec4(0.0), w;
vec4 lo = vec4(0.0), hi = vec4(0.0), lo2 = vec4(0.0), hi2 = vec4(0.0), wg, cg4, cg4_1;
w = texture(u_lut, vec2(0.038461538461538464, coord_y));
res += luma0 * w + luma24 * w.wzyx;
w = texture(u_lut, vec2(0.11538461538461539, coord_y));
res += luma1 * w + luma23 * w.wzyx;
w = texture(u_lut, vec2(0.19230769230769232, coord_y));
wg = max(vec4(0.0), w);
res += luma2 * w + luma22 * w.wzyx;
cg4 = vec4(0.1 + luma2, 1.1 - luma2, 0.1 + luma22, 1.1 - luma22);
cg4_1 = cg4;
cg4 *= cg4;cg4 *= cg4;cg4 *= cg4;cg4 *= cg4;cg4 *= cg4;
hi += cg4.x * wg + cg4.z * wg.wzyx;
lo += cg4.y * wg + cg4.w * wg.wzyx;
cg4 *= cg4_1;
hi2 += cg4.x * wg + cg4.z * wg.wzyx;
lo2 += cg4.y * wg + cg4.w * wg.wzyx;
w = texture(u_lut, vec2(0.2692307692307692, coord_y));
res += luma3 * w + luma21 * w.wzyx;
w = texture(u_lut, vec2(0.34615384615384615, coord_y));
res += luma4 * w + luma20 * w.wzyx;
w = texture(u_lut, vec2(0.4230769230769231, coord_y));
res += luma5 * w + luma19 * w.wzyx;
w = texture(u_lut, vec2(0.5, coord_y));
wg = max(vec4(0.0), w);
res += luma6 * w + luma18 * w.wzyx;
cg4 = vec4(0.1 + luma6, 1.1 - luma6, 0.1 + luma18, 1.1 - luma18);
cg4_1 = cg4;
cg4 *= cg4;cg4 *= cg4;cg4 *= cg4;cg4 *= cg4;cg4 *= cg4;
hi += cg4.x * wg + cg4.z * wg.wzyx;
lo += cg4.y * wg + cg4.w * wg.wzyx;
cg4 *= cg4_1;
hi2 += cg4.x * wg + cg4.z * wg.wzyx;
lo2 += cg4.y * wg + cg4.w * wg.wzyx;
w = texture(u_lut, vec2(0.5769230769230769, coord_y));
wg = max(vec4(0.0), w);
res += luma7 * w + luma17 * w.wzyx;
cg4 = vec4(0.1 + luma7, 1.1 - luma7, 0.1 + luma17, 1.1 - luma17);
cg4_1 = cg4;
cg4 *= cg4;cg4 *= cg4;cg4 *= cg4;cg4 *= cg4;cg4 *= cg4;
hi += cg4.x * wg + cg4.z * wg.wzyx;
lo += cg4.y * wg + cg4.w * wg.wzyx;
cg4 *= cg4_1;
hi2 += cg4.x * wg + cg4.z * wg.wzyx;
lo2 += cg4.y * wg + cg4.w * wg.wzyx;
w = texture(u_lut, vec2(0.6538461538461539, coord_y));
wg = max(vec4(0.0), w);
res += luma8 * w + luma16 * w.wzyx;
cg4 = vec4(0.1 + luma8, 1.1 - luma8, 0.1 + luma16, 1.1 - luma16);
cg4_1 = cg4;
cg4 *= cg4;cg4 *= cg4;cg4 *= cg4;cg4 *= cg4;cg4 *= cg4;
hi += cg4.x * wg + cg4.z * wg.wzyx;
lo += cg4.y * wg + cg4.w * wg.wzyx;
cg4 *= cg4_1;
hi2 += cg4.x * wg + cg4.z * wg.wzyx;
lo2 += cg4.y * wg + cg4.w * wg.wzyx;
w = texture(u_lut, vec2(0.7307692307692307, coord_y));
res += luma9 * w + luma15 * w.wzyx;
w = texture(u_lut, vec2(0.8076923076923077, coord_y));
wg = max(vec4(0.0), w);
res += luma10 * w + luma14 * w.wzyx;
cg4 = vec4(0.1 + luma10, 1.1 - luma10, 0.1 + luma14, 1.1 - luma14);
cg4_1 = cg4;
cg4 *= cg4;cg4 *= cg4;cg4 *= cg4;cg4 *= cg4;cg4 *= cg4;
hi += cg4.x * wg + cg4.z * wg.wzyx;
lo += cg4.y * wg + cg4.w * wg.wzyx;
cg4 *= cg4_1;
hi2 += cg4.x * wg + cg4.z * wg.wzyx;
lo2 += cg4.y * wg + cg4.w * wg.wzyx;
w = texture(u_lut, vec2(0.8846153846153846, coord_y));
wg = max(vec4(0.0), w);
res += luma11 * w + luma13 * w.wzyx;
cg4 = vec4(0.1 + luma11, 1.1 - luma11, 0.1 + luma13, 1.1 - luma13);
cg4_1 = cg4;
cg4 *= cg4;cg4 *= cg4;cg4 *= cg4;cg4 *= cg4;cg4 *= cg4;
hi += cg4.x * wg + cg4.z * wg.wzyx;
lo += cg4.y * wg + cg4.w * wg.wzyx;
cg4 *= cg4_1;
hi2 += cg4.x * wg + cg4.z * wg.wzyx;
lo2 += cg4.y * wg + cg4.w * wg.wzyx;
w = texture(u_lut, vec2(0.9615384615384616, coord_y));
wg = max(vec4(0.0), w);
res += luma12 * w;
vec2 cg2 = vec2(0.1 + luma12, 1.1 - luma12);
vec2 cg2_1 = cg2;
cg2 *= cg2;cg2 *= cg2;cg2 *= cg2;cg2 *= cg2;cg2 *= cg2;
hi += cg2.x * wg;
lo += cg2.y * wg;
cg2 *= cg2_1;
hi2 += cg2.x * wg;
lo2 += cg2.y * wg;
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