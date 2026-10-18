// Independent scalar RCAS oracle and production uniform-setting regressions.
// AMD's published optional FSR_RCAS_DENOISE equations are the reference:
// https://github.com/GPUOpen-Effects/FidelityFX-FSR/blob/master/ffx-fsr/ffx_fsr1.h
// Numerical shader execution is covered by webgpu-compositor-conformance.cjs.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Five normalized RGB samples in north, west, center, east, south order.
// Work with a positive sharpening magnitude rather than the shader's negative
// lobe. Derive the allowable magnitude independently from lower/upper clipping
// bounds across all channels, then solve the normalized sharpening equation.
function scalarRcas(taps, strength = 1, protectNoise = false) {
  assert.equal(taps.length, 5);
  assert.ok(Number.isFinite(strength) && strength >= 0 && strength <= 1);
  for (const pixel of taps) {
    assert.equal(pixel.length, 3);
    assert.ok(pixel.every(value => Number.isFinite(value) && value >= 0 && value <= 1));
  }
  const center = taps[2];
  const ring = [taps[0], taps[1], taps[3], taps[4]];
  let magnitude = 3 / 16;
  for (let channel = 0; channel < 3; channel++) {
    const values = ring.map(pixel => pixel[channel]);
    const low = Math.min(...values);
    const high = Math.max(...values);
    const lowerBound = Math.min(low, center[channel]) / Math.max(4 * high, 1e-4);
    const upperBound = (1 - Math.max(high, center[channel])) / Math.max(4 * (1 - low), 1e-4);
    magnitude = Math.min(magnitude, lowerBound, upperBound);
  }
  magnitude = Math.max(0, magnitude) * strength;
  let noiseFactor = 1;
  if (protectNoise) {
    const luminance = taps.map(pixel => pixel[0] / 2 + pixel[1] + pixel[2] / 2);
    const neighbors = [luminance[0], luminance[1], luminance[3], luminance[4]];
    const residual = Math.abs(neighbors.reduce((sum, value) => sum + value, 0) / 4 - luminance[2]);
    const range = Math.max(...luminance) - Math.min(...luminance);
    noiseFactor -= Math.min(1, residual / Math.max(range, 1e-4)) / 2;
    magnitude *= noiseFactor;
  }
  const rgb = center.map((value, channel) => {
    const neighbors = ring.reduce((sum, pixel) => sum + pixel[channel], 0);
    return (value - magnitude * neighbors) / (1 - 4 * magnitude);
  });
  return { rgb, noiseFactor, magnitude };
}

function imageReference(pixels, width, height, strength, protectNoise) {
  assert.equal(pixels.length, width * height * 4);
  const output = new Uint8Array(pixels.length);
  const pixel = (x, y) => {
    const index = (Math.max(0, Math.min(height - 1, y)) * width + Math.max(0, Math.min(width - 1, x))) * 4;
    return Array.from(pixels.slice(index, index + 3), value => value / 255);
  };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const taps = [pixel(x, y - 1), pixel(x - 1, y), pixel(x, y), pixel(x + 1, y), pixel(x, y + 1)];
    const color = scalarRcas(taps, strength, protectNoise).rgb;
    const index = (y * width + x) * 4;
    color.forEach((value, channel) => { output[index + channel] = Math.round(255 * Math.max(0, Math.min(1, value))); });
    output[index + 3] = 255;
  }
  return output;
}

function fixture(width, height, pattern) {
  const pixels = new Uint8Array(width * height * 4);
  let state = 0x71c3e2a5;
  const randomByte = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) % 41; };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let rgb;
    if (pattern === 'black') rgb = [0, 0, 0];
    else if (pattern === 'white') rgb = [255, 255, 255];
    else if (pattern === 'flat') rgb = [93, 128, 177];
    else if (pattern === 'gradient') rgb = [48 + 4 * x + 2 * y, 63 + 2 * x + 3 * y, 70 + 3 * x + y];
    else if (pattern === 'impulse') rgb = x === Math.floor(width / 2) && y === Math.floor(height / 2) ? [153, 143, 163] : [128, 128, 128];
    else if (pattern === 'noise') rgb = [108 + randomByte(), 108 + randomByte(), 108 + randomByte()];
    else throw new Error('Unknown RCAS fixture: ' + pattern);
    pixels.set([...rgb, 255], (y * width + x) * 4);
  }
  return pixels;
}

// Inputs and expected bytes are computed in Node, outside the browser shaders.
// Native conformance compares both actual GLSL and actual WGSL to these bytes
// at 1:1 size, isolating filter math from resampling/texture orientation errors.
function oracleFixtures() {
  const width = 16, height = 12;
  return ['black', 'white', 'flat', 'gradient', 'impulse', 'noise'].map(pattern => {
    const pixels = fixture(width, height, pattern);
    const cases = [];
    for (const strength of [0, 0.65, 1]) for (const protectNoise of [false, true]) {
      cases.push({ strength, protectNoise, expected: Array.from(imageReference(pixels, width, height, strength, protectNoise)) });
    }
    return { pattern, width, height, pixels: Array.from(pixels), cases };
  });
}

function properties() {
  const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) <= 1e-12, `${label}: ${actual} vs ${expected}`);
  const gray = value => [value, value, value];
  for (const color of [gray(0), gray(1), gray(0.5), [0.1, 0.6, 0.9]]) {
    for (const strength of [0, 0.65, 1]) for (const guard of [false, true]) {
      const actual = scalarRcas(Array.from({ length: 5 }, () => color), strength, guard);
      actual.rgb.forEach((value, channel) => near(value, color[channel], 'flat color stays unchanged and finite'));
      near(actual.noiseFactor, 1, 'flat signal has no noise response');
    }
  }
  const ramp = [0.3, 0.4, 0.5, 0.6, 0.7].map(gray);
  for (const guard of [false, true]) {
    const actual = scalarRcas(ramp, 1, guard);
    near(actual.noiseFactor, 1, 'linear gradient has zero high-pass response');
    actual.rgb.forEach(value => near(value, 0.5, 'linear gradient center remains unchanged'));
  }
  const impulse = [0.5, 0.5, 0.6, 0.5, 0.5].map(gray);
  scalarRcas(impulse, 1, false).rgb.forEach(value => near(value, 0.9, 'unprotected impulse golden value'));
  const protectedImpulse = scalarRcas(impulse, 1, true);
  near(protectedImpulse.noiseFactor, 0.5, 'isolated impulse reaches the maximum attenuation');
  protectedImpulse.rgb.forEach(value => near(value, 0.66, 'protected impulse golden value'));
  for (const taps of [[gray(0), gray(0), gray(1), gray(0), gray(0)], [gray(1), gray(1), gray(0), gray(1), gray(1)]]) {
    assert.deepEqual(scalarRcas(taps, 1, true).rgb, taps[2], 'clipping limiter preserves saturated isolated pixels');
  }

  let state = 0x81236fba, unprotectedEnergy = 0, protectedEnergy = 0;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 0x100000000; };
  for (let i = 0; i < 1024; i++) {
    const taps = Array.from({ length: 5 }, () => Array.from({ length: 3 }, () => 0.35 + random() * 0.3));
    const original = scalarRcas(taps, 1, false), protectedResult = scalarRcas(taps, 1, true);
    assert.ok(protectedResult.noiseFactor >= 0.5 && protectedResult.noiseFactor <= 1);
    assert.deepEqual(scalarRcas(taps, 0, true).rgb, taps[2], 'zero strength is an exact bypass');
    for (let channel = 0; channel < 3; channel++) {
      const before = original.rgb[channel] - taps[2][channel];
      const after = protectedResult.rgb[channel] - taps[2][channel];
      assert.ok(Number.isFinite(after));
      assert.ok(Math.abs(after) <= Math.abs(before) + 1e-12, 'noise guard never increases sharpening displacement');
      assert.ok(after * before >= -1e-12, 'noise guard does not reverse sharpening polarity');
      unprotectedEnergy += before * before;
      protectedEnergy += after * after;
    }
  }
  assert.ok(protectedEnergy < unprotectedEnergy, 'seeded colored noise has strictly less sharpening amplification');
}

function productionUniforms() {
  const source = fs.readFileSync(path.join(__dirname, '../content.js'), 'utf8');
  const functionSource = name => {
    const match = source.match(new RegExp('(?:^|\\n)function ' + name + '\\([\\s\\S]*?\\r?\\n\\}'));
    assert.ok(match, 'production function ' + name);
    return match[0];
  };
  const defaults = source.match(/const DEFAULT_SETTINGS = Object\.freeze\(\{[\s\S]*?\r?\n\}\);/);
  assert.ok(defaults, 'production defaults available');
  const sandbox = { settings: { protectNoise: false }, writes: [], gl: {
    uniform1f(location, value) { sandbox.writes.push({ location, value }); },
    uniform2f(location, x, y) { sandbox.writes.push({ location, value: [x, y] }); }
  } };
  vm.runInNewContext(`
    ${defaults[0]}
    ${functionSource('normalizeSettings')}
    let lastDirectTexelX=NaN,lastDirectTexelY=NaN,lastDirectStrength=NaN,lastDirectCompare=NaN,lastDirectNoiseGuard=NaN;
    let lastRcasTexelX=NaN,lastRcasTexelY=NaN,lastRcasStrength=NaN,lastRcasCompare=NaN,lastRcasNoiseGuard=NaN;
    const uTexelLoc='direct.texel',uStrengthLoc='direct.strength',uCompareLoc='direct.compare',uNoiseGuardLoc='direct.noise';
    const rcasTexelLoc='post.texel',rcasStrengthLoc='post.strength',rcasCompareLoc='post.compare',rcasNoiseGuardLoc='post.noise';
    ${functionSource('setDirectUniforms')}
    ${functionSource('setRcasUniforms')}
    globalThis.api={normalizeSettings,setDirectUniforms,setRcasUniforms,defaults:DEFAULT_SETTINGS};
  `, sandbox);
  assert.equal(sandbox.api.defaults.protectNoise, false, 'default preserves the original rendering');
  assert.equal(sandbox.api.normalizeSettings().protectNoise, false, 'older settings default off');
  for (const value of [false, null, undefined, 0, 1, 'true', 'false']) {
    assert.equal(sandbox.api.normalizeSettings({ protectNoise: value }).protectNoise, false, 'only explicit true enables the option');
  }
  assert.equal(sandbox.api.normalizeSettings({ protectNoise: true }).protectNoise, true);
  for (const [name, location] of [['setDirectUniforms', 'direct.noise'], ['setRcasUniforms', 'post.noise']]) {
    sandbox.writes.length = 0;
    const apply = sandbox.api[name];
    sandbox.settings.protectNoise = false;
    apply(1 / 128, 1 / 72, 0.65, 0);
    const initialized = sandbox.writes.length;
    apply(1 / 128, 1 / 72, 0.65, 0);
    assert.equal(sandbox.writes.length, initialized, 'unchanged uniform values stay cached');
    sandbox.settings.protectNoise = true;
    apply(1 / 128, 1 / 72, 0.65, 0);
    const enabled = sandbox.writes.length;
    assert.ok(enabled > initialized, 'the noise toggle alone invalidates the uniform cache');
    apply(1 / 128, 1 / 72, 0.65, 0);
    assert.equal(sandbox.writes.length, enabled, 'enabled state is cached without redundant uploads');
    sandbox.settings.protectNoise = false;
    apply(1 / 128, 1 / 72, 0.65, 0);
    assert.deepEqual(sandbox.writes.filter(write => write.location === location).map(write => write.value), [0, 1, 0], 'toggle round trip reaches the real GL uniform setter');
  }
}

module.exports = { scalarRcas, imageReference, fixture, oracleFixtures };
if (require.main === module) {
  properties();
  productionUniforms();
  console.log('PASS RCAS noise protection: scalar clipping/noise oracle, flat colors, gradients, impulses, seeded noise and zero-strength bypass');
  console.log('PASS RCAS noise protection: explicit opt-in normalization and direct/postprocess uniform cache toggle round trips');
}
