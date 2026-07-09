"use strict";
/*
 * Firefox Video Enhancer
 *
 * Prova: o <video> principal vira textura WebGL2 e é desenhado num canvas
 * sobreposto com FSR1 (EASU + RCAS) ou RAVU-lite AR + RCAS. No modo
 * Desativado, nenhum canvas ou callback de renderização permanece ativo.
 *
 * Canvas como irmão logo após o <video> (mesmo contêiner):
 *  - DOM order o coloca ACIMA do vídeo, sem brigar com z-index do site.
 *  - Rola/resize junto com o player; durante scroll o efeito pausa para liberar
 *    o compositor da página.
 *  - pointer-events:none => cliques atravessam; controles (irmãos depois do
 *    canvas) continuam visíveis e clicáveis.
 *
 * Self-check: `node content.js` roda asserções sobre o seletor de vídeo.
 */

// --------------------------------------------------------------------------
// Lógica pura (testável sem DOM)
// --------------------------------------------------------------------------

function visibleArea(rect, vw, vh) {
  const w = Math.max(0, Math.min(rect.left + rect.width, vw) - Math.max(rect.left, 0));
  const h = Math.max(0, Math.min(rect.top + rect.height, vh) - Math.max(rect.top, 0));
  return w * h;
}

function playingWeight(v) {
  const ready = v.readyState >= 2;
  const stopped = v.paused || v.ended;
  return ready && !stopped ? 1 : 0.3;
}

function pickLargestVideo(videos, vw, vh) {
  let best = null;
  let bestScore = 0;
  for (const v of videos) {
    const score = visibleArea(v.getBoundingClientRect(), vw, vh) * playingWeight(v);
    if (score > bestScore) {
      bestScore = score;
      best = v;
    }
  }
  return best;
}

const DEFAULT_SETTINGS = Object.freeze({
  mode: "ravu",
  strength: 100,
  outline: false,
  compare: false,
  quality: "high",
  interaction: "smooth",
  // Frame interpolation (A/B toggles). Defaults: infra off; sub-options ready.
  fiInfra: false,
  fiSceneCut: true,
  fiFpsGate: true,
  fiHalfLuma: true,
  fiBlockMatch: true,
  fiFallback: true,
});

function normalizeSettings(value = {}) {
  const strength = Number(value.strength);
  const mode = value.mode === "passthrough" ? "off" : value.mode;
  const fi = typeof fiNormalizeSettings === "function"
    ? fiNormalizeSettings(value)
    : {
      fiInfra: value.fiInfra === true,
      fiSceneCut: value.fiSceneCut !== false,
      fiFpsGate: value.fiFpsGate !== false,
      fiHalfLuma: value.fiHalfLuma !== false,
      fiBlockMatch: value.fiBlockMatch !== false,
      fiFallback: value.fiFallback !== false,
    };
  return {
    mode: ["off", "rcas", "ravu"].includes(mode) ? mode : DEFAULT_SETTINGS.mode,
    strength: Number.isFinite(strength)
      ? Math.min(100, Math.max(0, Math.round(strength)))
      : DEFAULT_SETTINGS.strength,
    outline: value.outline === true,
    compare: value.compare === true,
    quality: ["auto", "high", "balanced", "performance"].includes(value.quality)
      ? value.quality
      : DEFAULT_SETTINGS.quality,
    interaction: ["smooth", "balanced", "quality"].includes(value.interaction)
      ? value.interaction
      : DEFAULT_SETTINGS.interaction,
    ...fi,
  };
}

// --------------------------------------------------------------------------
// Shaders
// --------------------------------------------------------------------------

const VERT = `#version 300 es
layout(location=0) in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = vec2(a_pos.x * 0.5 + 0.5, 0.5 - a_pos.y * 0.5); // flip Y p/ vídeo
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const VERT_PLAIN = `#version 300 es
layout(location=0) in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const EASU_FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_tex;
in vec2 v_uv;
out vec4 outColor;

// EASU adaptado do AMD FidelityFX FSR1 (MIT). Ver THIRD_PARTY_NOTICES.txt.
vec3 loadEasu(ivec2 p) {
  ivec2 size = textureSize(u_tex, 0);
  return texelFetch(u_tex, clamp(p, ivec2(0), size - 1), 0).rgb;
}

float luma(vec3 c) {
  return c.g + 0.5 * (c.r + c.b);
}

void easuSet(
  inout vec2 dir, inout float len, float weight,
  float a, float b, float c, float d, float e
) {
  float lenX = max(abs(d - c), abs(c - b));
  float dirX = d - b;
  dir.x += dirX * weight;
  lenX = clamp(abs(dirX) / max(lenX, 1e-4), 0.0, 1.0);
  len += lenX * lenX * weight;

  float lenY = max(abs(e - c), abs(c - a));
  float dirY = e - a;
  dir.y += dirY * weight;
  lenY = clamp(abs(dirY) / max(lenY, 1e-4), 0.0, 1.0);
  len += lenY * lenY * weight;
}

void easuTap(
  inout vec3 color, inout float weight,
  vec2 offset, vec2 dir, vec2 len, float lobe, float clipPoint, vec3 tap
) {
  vec2 rotated = vec2(dot(offset, dir), dot(offset, vec2(-dir.y, dir.x)));
  rotated *= len;
  float distance2 = min(dot(rotated, rotated), clipPoint);
  float window = 0.4 * distance2 - 1.0;
  float base = lobe * distance2 - 1.0;
  window *= window;
  base *= base;
  window = 1.5625 * window - 0.5625;
  float tapWeight = window * base;
  color += tap * tapWeight;
  weight += tapWeight;
}

void main() {
  vec2 sourcePosition = v_uv * vec2(textureSize(u_tex, 0)) - 0.5;
  ivec2 fPosition = ivec2(floor(sourcePosition));
  vec2 subpixel = fract(sourcePosition);

  vec3 b = loadEasu(fPosition + ivec2( 0, -1));
  vec3 c = loadEasu(fPosition + ivec2( 1, -1));
  vec3 e = loadEasu(fPosition + ivec2(-1,  0));
  vec3 f = loadEasu(fPosition + ivec2( 0,  0));
  vec3 g = loadEasu(fPosition + ivec2( 1,  0));
  vec3 h = loadEasu(fPosition + ivec2( 2,  0));
  vec3 i = loadEasu(fPosition + ivec2(-1,  1));
  vec3 j = loadEasu(fPosition + ivec2( 0,  1));
  vec3 k = loadEasu(fPosition + ivec2( 1,  1));
  vec3 l = loadEasu(fPosition + ivec2( 2,  1));
  vec3 n = loadEasu(fPosition + ivec2( 0,  2));
  vec3 o = loadEasu(fPosition + ivec2( 1,  2));

  float bL=luma(b), cL=luma(c), eL=luma(e), fL=luma(f);
  float gL=luma(g), hL=luma(h), iL=luma(i), jL=luma(j);
  float kL=luma(k), lL=luma(l), nL=luma(n), oL=luma(o);
  vec2 dir = vec2(0.0);
  float len = 0.0;
  easuSet(dir, len, (1.0-subpixel.x)*(1.0-subpixel.y), bL,eL,fL,gL,jL);
  easuSet(dir, len, subpixel.x*(1.0-subpixel.y), cL,fL,gL,hL,kL);
  easuSet(dir, len, (1.0-subpixel.x)*subpixel.y, fL,iL,jL,kL,nL);
  easuSet(dir, len, subpixel.x*subpixel.y, gL,jL,kL,lL,oL);

  float directionLength = dot(dir, dir);
  if (directionLength < 1.0/32768.0) {
    dir = vec2(1.0, 0.0);
  } else {
    dir *= inversesqrt(directionLength);
  }
  len = 0.5 * len;
  len *= len;
  float stretch = 1.0 / max(abs(dir.x), abs(dir.y));
  vec2 anisotropicLength = vec2(
    1.0 + (stretch - 1.0) * len,
    1.0 - 0.5 * len
  );
  float lobe = 0.5 - 0.29 * len;
  float clipPoint = 1.0 / lobe;

  vec3 minimum = min(min(f, g), min(j, k));
  vec3 maximum = max(max(f, g), max(j, k));
  vec3 color = vec3(0.0);
  float weight = 0.0;
  easuTap(color,weight,vec2( 0,-1)-subpixel,dir,anisotropicLength,lobe,clipPoint,b);
  easuTap(color,weight,vec2( 1,-1)-subpixel,dir,anisotropicLength,lobe,clipPoint,c);
  easuTap(color,weight,vec2(-1, 1)-subpixel,dir,anisotropicLength,lobe,clipPoint,i);
  easuTap(color,weight,vec2( 0, 1)-subpixel,dir,anisotropicLength,lobe,clipPoint,j);
  easuTap(color,weight,vec2( 0, 0)-subpixel,dir,anisotropicLength,lobe,clipPoint,f);
  easuTap(color,weight,vec2(-1, 0)-subpixel,dir,anisotropicLength,lobe,clipPoint,e);
  easuTap(color,weight,vec2( 1, 1)-subpixel,dir,anisotropicLength,lobe,clipPoint,k);
  easuTap(color,weight,vec2( 2, 1)-subpixel,dir,anisotropicLength,lobe,clipPoint,l);
  easuTap(color,weight,vec2( 2, 0)-subpixel,dir,anisotropicLength,lobe,clipPoint,h);
  easuTap(color,weight,vec2( 1, 0)-subpixel,dir,anisotropicLength,lobe,clipPoint,g);
  easuTap(color,weight,vec2( 1, 2)-subpixel,dir,anisotropicLength,lobe,clipPoint,o);
  easuTap(color,weight,vec2( 0, 2)-subpixel,dir,anisotropicLength,lobe,clipPoint,n);
  outColor = vec4(clamp(color / weight, minimum, maximum), 1.0);
}`;

const FI_BLEND_FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_prev;
uniform sampler2D u_curr;
uniform float u_phase;
in vec2 v_uv;
out vec4 outColor;
void main() {
  vec3 a = texture(u_prev, v_uv).rgb;
  vec3 b = texture(u_curr, v_uv).rgb;
  outColor = vec4(mix(a, b, clamp(u_phase, 0.0, 1.0)), 1.0);
}`;

const FI_WARP_FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_prev;
uniform sampler2D u_curr;
uniform sampler2D u_mv;
uniform vec2 u_texel;
uniform vec2 u_mv_grid;
uniform float u_phase;
in vec2 v_uv;
out vec4 outColor;
void main() {
  // MV texture: RG = motion of curr relative to prev, in source pixels.
  vec2 cell = clamp(floor(v_uv * u_mv_grid), vec2(0.0), u_mv_grid - 1.0);
  vec2 mvUv = (cell + 0.5) / u_mv_grid;
  // Packed as (pixel*4 + 128) / 255 in RG — decode back to source pixels.
  // ME defines mv so curr[p+mv] ≈ prev[p] (feature moves +mv from prev→curr).
  // Mid at phase t: sample prev at p - mv*t, curr at p + mv*(1-t).
  vec2 mv = (texture(u_mv, mvUv).rg * 255.0 - 128.0) / 4.0;
  float t = clamp(u_phase, 0.0, 1.0);
  vec2 fromPrev = v_uv - mv * t * u_texel;
  vec2 fromCurr = v_uv + mv * (1.0 - t) * u_texel;
  vec3 a = texture(u_prev, clamp(fromPrev, vec2(0.0), vec2(1.0))).rgb;
  vec3 b = texture(u_curr, clamp(fromCurr, vec2(0.0), vec2(1.0))).rgb;
  outColor = vec4(mix(a, b, t), 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_tex;
uniform vec2 u_texel;
uniform float u_strength;
uniform float u_compare;
in vec2 v_uv;
out vec4 outColor;

// RCAS adaptado do AMD FidelityFX FSR1 (MIT). Ver THIRD_PARTY_NOTICES.txt.
vec3 rcas(vec2 uv) {
  vec3 b = texture(u_tex, uv + vec2(0.0, -u_texel.y)).rgb;
  vec3 d = texture(u_tex, uv + vec2(-u_texel.x, 0.0)).rgb;
  vec3 e = texture(u_tex, uv).rgb;
  vec3 f = texture(u_tex, uv + vec2(u_texel.x, 0.0)).rgb;
  vec3 h = texture(u_tex, uv + vec2(0.0, u_texel.y)).rgb;

  vec3 mn4 = min(min(b, d), min(f, h));
  vec3 mx4 = max(max(b, d), max(f, h));
  vec3 hitMin = min(mn4, e) / max(4.0 * mx4, vec3(1e-4));
  vec3 hitMax = (vec3(1.0) - max(mx4, e)) /
    min(4.0 * mn4 - vec3(4.0), vec3(-1e-4));
  vec3 lobeRgb = max(-hitMin, hitMax);
  float lobe = max(-0.1875, min(max(lobeRgb.r, max(lobeRgb.g, lobeRgb.b)), 0.0));
  lobe *= u_strength;

  return (lobe * (b + d + f + h) + e) / (4.0 * lobe + 1.0);
}

void main() {
  bool compare = u_compare > 0.5;
  if (compare && abs(v_uv.x - 0.5) < 1.5 * u_texel.x) {
    outColor = vec4(0.0, 1.0, 0.53, 1.0);
    return;
  }
  if (u_strength <= 0.0 || (compare && v_uv.x < 0.5)) {
    outColor = vec4(texture(u_tex, v_uv).rgb, 1.0);
    return;
  }
  outColor = vec4(rcas(v_uv), 1.0);
}`;


// --------------------------------------------------------------------------
// Estado (módulo)
// --------------------------------------------------------------------------

const TAG = "[fv-enhancer]";
const CANVAS_ID = "fv-enhancer-canvas";
const COMPARE_LEFT_ID = "fv-enhancer-compare-left";
const COMPARE_RIGHT_ID = "fv-enhancer-compare-right";
const INTERACTION_PAUSE_MS = 450;
const INTERACTION_PREVIEW_MS = 67;
let canvas, gl, program, easuProgram, rcasProgram, ravuStepProgram, ravuComposeProgram;
let compareLeftEl = null;
let compareRightEl = null;
let flashTimer = null;
let vao, texture;
let uTexLoc = null, uTexelLoc = null, uStrengthLoc = null, uCompareLoc = null;
let easuTexLoc = null;
let rcasTexLoc = null, rcasTexelLoc = null, rcasStrengthLoc = null, rcasCompareLoc = null;
let ravuSourceLoc = null, ravuLutLoc = null;
let ravuComposeSourceLoc = null, ravuPackedLoc = null;
let ravuSourceSizeLoc = null, ravuOutputTexelLoc = null, ravuCompareLoc = null;
let framebuffer, upscaledTexture;
let intermediateWidth = 0, intermediateHeight = 0;
let ravuFramebuffer, ravuPackedTexture, ravuLutTexture;
let ravuWidth = 0, ravuHeight = 0;
let ravuLutReady = false, ravuLutPromise = null, ravuLutError = "";
let ravuShadersPromise = null, ravuShaderError = "";
let ravuFloatTarget = false, ravuFloatChecked = false;
let textureWidth = 0, textureHeight = 0;
let timerExt = null;
let timerExtChecked = false;
const gpuQueries = [];
let gpuFrame = 0;
let cpuFrame = 0;
let gpuTimingUntil = 0;
let currentVideo = null;
let hiddenVideo = null;
let hiddenVideoOpacity = "";
let rafId = null;
let scheduledKind = null;
let schedulerMode = "video";
let lastDisplayDrawTime = 0;
let stopped = false;
let overlayVisible = true;
let scrolling = false;
let scrollResumeTimer = null;
let videoInViewport = true;
let lastError = "";
let status = "idle"; // "ok" | "tainted" | "error" | "no-webgl" | "no-video"
let layoutDirty = true;
let layoutRafScheduled = false;
let rescanRafScheduled = false;
let activePageListeners = false;
let discoveryListeners = false;
let videoResizeObserver = null;
let videoIntersectionObserver = null;
let settingsLoaded = false;
let settings = normalizeSettings(DEFAULT_SETTINGS);
let lastPresentedFrames = null;
let lastMediaTime = null;
let lastPlaybackDropped = null;
let lastPlaybackTotal = null;
let renderScale = 1;
let targetWidth = 0;
let targetHeight = 0;
let stableWindows = 0;
let activePipeline = "desativado";
let lastCanvasVisibility = "";
let lastDatasetPipeline = "";
let lastDatasetError = "";
let lastDirectTexelX = NaN, lastDirectTexelY = NaN;
let lastDirectStrength = NaN, lastDirectCompare = NaN;
let lastRcasTexelX = NaN, lastRcasTexelY = NaN;
let lastRcasStrength = NaN, lastRcasCompare = NaN;
let lastRavuSourceW = NaN, lastRavuSourceH = NaN;
let lastRavuOutTexelX = NaN, lastRavuOutTexelY = NaN;
let lastRavuCompare = NaN;
let metricWindow = null;
let metricReport = {
  fps: 0, videoFps: 0, missed: 0, missedPct: 0, latePct: null,
  videoDropped: 0, videoDroppedPct: 0,
  cpuMs: 0, cpuMaxMs: 0, gpuMs: null, decoderMs: null,
  renderScale: 1,
};

// --------------------------------------------------------------------------
// Frame interpolation state (GL + CPU). Pure decisions live in fi-core.js.
// --------------------------------------------------------------------------
let fiPrevTexture = null;
let fiCurrTexture = null;
let fiOutTexture = null;
let fiMvTexture = null;
let fiOutFb = null;
let fiCopyFb = null; // dedicated FBO for texture copies — never share with fiOutFb
let fiHasPrev = false;
let fiHasCurr = false;
let fiPrevLuma = null;
let fiCurrLuma = null;
let fiLumaW = 0;
let fiLumaH = 0;
let fiSampleCanvas = null;
let fiSampleCtx = null;
let fiMidTimer = null;
let fiMidRaf = null;
let fiMethod = "skip";
let fiConfidence = 0;
let fiSceneCutHold = 0;
let fiFpsEligible = false;
let fiFpsEligibleSticky = false;
let fiLastMatch = null;
let fiBlendProgram = null;
let fiWarpProgram = null;
let fiBlendPrevLoc = null, fiBlendCurrLoc = null, fiBlendPhaseLoc = null;
let fiWarpPrevLoc = null, fiWarpCurrLoc = null, fiWarpMvLoc = null;
let fiWarpTexelLoc = null, fiWarpGridLoc = null, fiWarpPhaseLoc = null;
let fiOutW = 0, fiOutH = 0;
let fiDrawingMid = false;

function log(...args) {
  console.log(TAG, ...args);
}

function canRender() {
  return settings.mode !== "off" && overlayVisible &&
    (!scrolling || settings.interaction !== "smooth") && videoInViewport &&
    (typeof document === "undefined" || !document.hidden);
}

function canShowOverlayFrame() {
  return settings.mode !== "off" && overlayVisible && videoInViewport &&
    status === "ok" &&
    (typeof document === "undefined" || !document.hidden);
}

function effectiveRenderScale() {
  return scrolling && settings.interaction === "balanced"
    ? Math.min(renderScale, 0.5)
    : renderScale;
}

function restoreVideoPaint() {
  if (!hiddenVideo) return;
  hiddenVideo.style.opacity = hiddenVideoOpacity;
  hiddenVideo = null;
  hiddenVideoOpacity = "";
}

function updateVideoPaintVisibility(rendered = status === "ok") {
  if (!currentVideo || !rendered || settings.mode === "off" ||
      !overlayVisible || !videoInViewport ||
      (typeof document !== "undefined" && document.hidden)) {
    restoreVideoPaint();
    return;
  }
  if (hiddenVideo !== currentVideo) {
    restoreVideoPaint();
    hiddenVideo = currentVideo;
    hiddenVideoOpacity = currentVideo.style.opacity;
  }
  if (hiddenVideo.style.opacity !== "0") hiddenVideo.style.opacity = "0";
}

function updateCanvasVisibility() {
  const next = canShowOverlayFrame() ? "visible" : "hidden";
  if (!canvas) {
    if (next !== "visible") restoreVideoPaint();
    return;
  }
  if (lastCanvasVisibility !== next) {
    canvas.style.display = next === "visible" ? "" : "none";
    canvas.style.visibility = next;
    lastCanvasVisibility = next;
  }
  if (compareLeftEl) compareLeftEl.style.visibility = next;
  if (compareRightEl) compareRightEl.style.visibility = next;
  updateVideoPaintVisibility(next === "visible");
}

function modeDisplayName(mode) {
  if (mode === "ravu") return "RAVU";
  if (mode === "rcas") return "FSR1";
  return "Enhanced";
}

function applyCanvasOutline(flashing = false) {
  if (!canvas) return;
  if (flashing) {
    canvas.style.outline = "2px solid #3b82f6";
    canvas.style.outlineOffset = "-2px";
    return;
  }
  canvas.style.outline = settings.outline ? "2px solid #00ff88" : "none";
  canvas.style.outlineOffset = settings.outline ? "-2px" : "";
}

function flashModeChange() {
  if (!canvas || settings.mode === "off") return;
  if (flashTimer !== null) clearTimeout(flashTimer);
  applyCanvasOutline(true);
  flashTimer = setTimeout(() => {
    flashTimer = null;
    applyCanvasOutline(false);
  }, 400);
}

function removeCompareLabels() {
  if (compareLeftEl) {
    compareLeftEl.remove();
    compareLeftEl = null;
  }
  if (compareRightEl) {
    compareRightEl.remove();
    compareRightEl = null;
  }
  const staleLeft = document.getElementById(COMPARE_LEFT_ID);
  const staleRight = document.getElementById(COMPARE_RIGHT_ID);
  if (staleLeft) staleLeft.remove();
  if (staleRight) staleRight.remove();
}

function ensureCompareLabels() {
  if (!canvas || !canvas.parentNode || !settings.compare || settings.mode === "off") {
    removeCompareLabels();
    return;
  }
  const labelStyle =
    "position:absolute;pointer-events:none;padding:4px 8px;border-radius:6px;" +
    "font:600 11px/1.2 system-ui,sans-serif;color:#fff;background:rgba(0,0,0,.55);" +
    "letter-spacing:.02em;contain:layout paint;z-index:0;";
  if (!compareLeftEl || !compareLeftEl.isConnected) {
    compareLeftEl = document.createElement("div");
    compareLeftEl.id = COMPARE_LEFT_ID;
    compareLeftEl.textContent = "Original";
    compareLeftEl.style.cssText = labelStyle;
    canvas.parentNode.insertBefore(compareLeftEl, canvas.nextSibling);
  }
  if (!compareRightEl || !compareRightEl.isConnected) {
    compareRightEl = document.createElement("div");
    compareRightEl.id = COMPARE_RIGHT_ID;
    compareRightEl.style.cssText = labelStyle;
    const after = compareLeftEl && compareLeftEl.isConnected
      ? compareLeftEl.nextSibling
      : canvas.nextSibling;
    canvas.parentNode.insertBefore(compareRightEl, after);
  }
  compareRightEl.textContent = modeDisplayName(settings.mode);
  const vis = canShowOverlayFrame() ? "visible" : "hidden";
  compareLeftEl.style.visibility = vis;
  compareRightEl.style.visibility = vis;
}

function positionCompareLabels(left, top, width) {
  if (!compareLeftEl || !compareRightEl) return;
  const leftPx = `${left + 8}px`;
  const topPx = `${top + 8}px`;
  const rightPx = `${left + width * 0.5 + 8}px`;
  if (compareLeftEl.style.left !== leftPx) compareLeftEl.style.left = leftPx;
  if (compareLeftEl.style.top !== topPx) compareLeftEl.style.top = topPx;
  if (compareRightEl.style.left !== rightPx) compareRightEl.style.left = rightPx;
  if (compareRightEl.style.top !== topPx) compareRightEl.style.top = topPx;
}

function updateCanvasDataset(pipeline, error = "") {
  if (!canvas) return;
  if (lastDatasetPipeline !== pipeline) {
    canvas.dataset.fvPipeline = pipeline;
    lastDatasetPipeline = pipeline;
  }
  if (lastDatasetError !== error) {
    canvas.dataset.fvError = error;
    lastDatasetError = error;
  }
}

function setDirectUniforms(texelX, texelY, strength, compare) {
  if (lastDirectTexelX === texelX && lastDirectTexelY === texelY &&
      lastDirectStrength === strength && lastDirectCompare === compare) return;
  gl.uniform2f(uTexelLoc, texelX, texelY);
  gl.uniform1f(uStrengthLoc, strength);
  gl.uniform1f(uCompareLoc, compare);
  lastDirectTexelX = texelX;
  lastDirectTexelY = texelY;
  lastDirectStrength = strength;
  lastDirectCompare = compare;
}

function setRcasUniforms(texelX, texelY, strength, compare) {
  if (lastRcasTexelX === texelX && lastRcasTexelY === texelY &&
      lastRcasStrength === strength && lastRcasCompare === compare) return;
  gl.uniform2f(rcasTexelLoc, texelX, texelY);
  gl.uniform1f(rcasStrengthLoc, strength);
  gl.uniform1f(rcasCompareLoc, compare);
  lastRcasTexelX = texelX;
  lastRcasTexelY = texelY;
  lastRcasStrength = strength;
  lastRcasCompare = compare;
}

function setRavuComposeUniforms(sourceW, sourceH, outTexelX, outTexelY, compare) {
  if (lastRavuSourceW === sourceW && lastRavuSourceH === sourceH &&
      lastRavuOutTexelX === outTexelX && lastRavuOutTexelY === outTexelY &&
      lastRavuCompare === compare) return;
  gl.uniform2f(ravuSourceSizeLoc, sourceW, sourceH);
  gl.uniform2f(ravuOutputTexelLoc, outTexelX, outTexelY);
  gl.uniform1f(ravuCompareLoc, compare);
  lastRavuSourceW = sourceW;
  lastRavuSourceH = sourceH;
  lastRavuOutTexelX = outTexelX;
  lastRavuOutTexelY = outTexelY;
  lastRavuCompare = compare;
}

function resetMetricWindow(now) {
  metricWindow = {
    start: now, callbacks: 0, drawn: 0, missed: 0, late: 0,
    cpuTotal: 0, cpuMax: 0, cpuSamples: 0, gpuTotal: 0, gpuSamples: 0,
    decoderTotal: 0, decoderSamples: 0, hasMetadata: false,
    mediaDelta: 0, mediaFrames: 0,
    videoDropped: 0, videoTotal: 0,
  };
}

function setRenderScale(value, reason) {
  if (renderScale === value) return;
  renderScale = value;
  layoutDirty = true;
  scheduleLayoutSync();
  log("escala interna", Math.round(value * 100) + "%", reason || "");
}

function selectAutoScale(currentScale, stableCount, report) {
  const levels = [0.5, 0.7, 0.85, 1];
  if (report.videoFps <= 0) return { scale: currentScale, stable: stableCount };
  const budget = 1000 / report.videoFps;
  const gpu = report.gpuMs === null ? 0 : report.gpuMs;
  const late = report.latePct === null ? 0 : report.latePct;
  const expensive = report.cpuMs > budget * 0.5 || gpu > budget * 0.6;
  const overloaded = report.missedPct > 1 || late > 10 || expensive;
  const severe = report.missedPct > 8 || late > 35 ||
    report.cpuMs > budget * 0.8 || gpu > budget * 0.9;
  const index = levels.indexOf(currentScale);
  if (overloaded && index > 0) {
    return { scale: levels[Math.max(0, index - (severe ? 2 : 1))], stable: 0 };
  }
  if (!overloaded && report.missed === 0 && late <= 2) {
    const stable = stableCount + 1;
    if (stable >= 5 && index < levels.length - 1) {
      return { scale: levels[index + 1], stable: 0 };
    }
    return { scale: currentScale, stable };
  }
  return { scale: currentScale, stable: 0 };
}

function autoScaleCap(width, height, fps = 60) {
  // ponytail: degraus conservadores; recalibrar só com telemetria real diversa.
  const megapixelsPerSecond = width * height * (fps || 60) / 1e6;
  if (megapixelsPerSecond > 700) return 0.5;
  if (megapixelsPerSecond > 350) return 0.7;
  if (megapixelsPerSecond > 180) return 0.85;
  return 1;
}

function shouldUseDisplayScheduler(report) {
  return report.videoFps > 0 && report.missedPct > 10 &&
    report.videoFps > report.fps * 1.25;
}

function displayPollDelay(lastDraw, now, fps) {
  if (!lastDraw || fps <= 0) return 0;
  return Math.max(0, 1000 / fps - (now - lastDraw) - 2);
}

function adjustedRcasStrength(strength, upscaleRatio) {
  const haloProtection = Math.max(0.7, 1 - 0.15 * Math.max(0, upscaleRatio - 1));
  return strength * haloProtection;
}

function adaptRenderScale(report) {
  if (settings.quality !== "auto") return;
  const next = selectAutoScale(renderScale, stableWindows, report);
  next.scale = Math.min(
    next.scale,
    autoScaleCap(targetWidth, targetHeight, report.videoFps || 60),
  );
  stableWindows = next.stable;
  if (next.scale !== renderScale) {
    setRenderScale(next.scale,
      next.scale < renderScale ? "— sobrecarga detectada" : "— cinco janelas estáveis");
  }
}

function publishMetrics(now) {
  if (!metricWindow || metricWindow.callbacks === 0 || now - metricWindow.start < 1000) return;
  const elapsed = now - metricWindow.start;
  const totalFrames = metricWindow.drawn + metricWindow.missed;
  metricReport = {
    fps: metricWindow.drawn * 1000 / elapsed,
    videoFps: metricWindow.mediaDelta
      ? metricWindow.mediaFrames / metricWindow.mediaDelta
      : (metricWindow.videoTotal ? metricWindow.videoTotal * 1000 / elapsed : 0),
    missed: metricWindow.missed,
    missedPct: totalFrames ? metricWindow.missed * 100 / totalFrames : 0,
    videoDropped: metricWindow.videoDropped,
    videoDroppedPct: metricWindow.videoTotal
      ? metricWindow.videoDropped * 100 / metricWindow.videoTotal
      : 0,
    latePct: metricWindow.hasMetadata
      ? metricWindow.late * 100 / metricWindow.callbacks
      : null,
    cpuMs: metricWindow.cpuSamples ? metricWindow.cpuTotal / metricWindow.cpuSamples : 0,
    cpuMaxMs: metricWindow.cpuMax,
    gpuMs: metricWindow.gpuSamples
      ? metricWindow.gpuTotal / metricWindow.gpuSamples
      : null,
    decoderMs: metricWindow.decoderSamples
      ? metricWindow.decoderTotal / metricWindow.decoderSamples
      : null,
    renderScale: effectiveRenderScale(),
  };
  if (schedulerMode === "video" && shouldUseDisplayScheduler(metricReport)) {
    schedulerMode = "display";
    log("rVFC perdeu frames; trocando para sincronização com a tela");
  }
  if (canRender()) adaptRenderScale(metricReport);
  metricReport.renderScale = effectiveRenderScale();
  resetMetricWindow(now);
}

function recordVideoFrame(now, metadata) {
  if (!metricWindow) resetMetricWindow(now);
  metricWindow.callbacks++;
  let qualityDelta = null;
  const needsQuality = (!metadata && !scrolling) || schedulerMode === "display" ||
    metricWindow.callbacks % 15 === 0;
  const quality = needsQuality && currentVideo && currentVideo.getVideoPlaybackQuality
    ? currentVideo.getVideoPlaybackQuality()
    : null;
  if (quality) {
    if (lastPlaybackDropped !== null && quality.droppedVideoFrames >= lastPlaybackDropped) {
      metricWindow.videoDropped += quality.droppedVideoFrames - lastPlaybackDropped;
    }
    if (lastPlaybackTotal !== null && quality.totalVideoFrames >= lastPlaybackTotal) {
      qualityDelta = quality.totalVideoFrames - lastPlaybackTotal;
      metricWindow.videoTotal += qualityDelta;
      if (schedulerMode === "display" && canRender() &&
          qualityDelta > 1) {
        metricWindow.missed += qualityDelta - 1;
      }
    }
    lastPlaybackDropped = quality.droppedVideoFrames;
    lastPlaybackTotal = quality.totalVideoFrames;
  }
  if (!metadata) return qualityDelta === null || qualityDelta > 0;
  metricWindow.hasMetadata = true;
  let presentedDelta = 1;
  if (lastPresentedFrames !== null) {
    presentedDelta = Math.max(1, metadata.presentedFrames - lastPresentedFrames);
  }
  if (canRender() && lastPresentedFrames !== null &&
      metadata.presentedFrames > lastPresentedFrames + 1) {
    metricWindow.missed += metadata.presentedFrames - lastPresentedFrames - 1;
  }
  lastPresentedFrames = metadata.presentedFrames;
  if (lastMediaTime !== null) {
    const delta = metadata.mediaTime - lastMediaTime;
    if (delta > 0 && delta < 1) {
      metricWindow.mediaDelta += delta;
      metricWindow.mediaFrames += presentedDelta;
    }
  }
  lastMediaTime = metadata.mediaTime;
  if (metadata.expectedDisplayTime - now < 1) metricWindow.late++;
  if (Number.isFinite(metadata.processingDuration)) {
    metricWindow.decoderTotal += metadata.processingDuration * 1000;
    metricWindow.decoderSamples++;
  }
  return true;
}

function recordDraw(cpuMs) {
  if (!metricWindow) resetMetricWindow(performance.now());
  metricWindow.drawn++;
  if (Number.isFinite(cpuMs)) {
    metricWindow.cpuSamples++;
    metricWindow.cpuTotal += cpuMs;
    metricWindow.cpuMax = Math.max(metricWindow.cpuMax, cpuMs);
  }
}

function pollGpuTimers() {
  if (!timerExt || gpuQueries.length === 0) return;
  while (gpuQueries.length) {
    const query = gpuQueries[0];
    if (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) break;
    gpuQueries.shift();
    if (!gl.getParameter(timerExt.GPU_DISJOINT_EXT) && metricWindow) {
      metricWindow.gpuTotal += gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6;
      metricWindow.gpuSamples++;
    }
    gl.deleteQuery(query);
  }
}

function cancelFiMid() {
  if (fiMidTimer !== null) {
    clearTimeout(fiMidTimer);
    fiMidTimer = null;
  }
  if (fiMidRaf !== null) {
    cancelAnimationFrame(fiMidRaf);
    fiMidRaf = null;
  }
}

function resetFiPairState() {
  cancelFiMid();
  fiHasPrev = false;
  fiHasCurr = false;
  fiPrevLuma = null;
  fiCurrLuma = null;
  fiLumaW = 0;
  fiLumaH = 0;
  fiMethod = "skip";
  fiConfidence = 0;
  fiSceneCutHold = 0;
  fiLastMatch = null;
  fiDrawingMid = false;
}

function fiMakeTexture() {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  return tex;
}

function fiEnsurePrograms() {
  if (fiBlendProgram && fiWarpProgram) return true;
  fiBlendProgram = linkProgram(VERT_PLAIN, FI_BLEND_FRAG);
  fiWarpProgram = linkProgram(VERT_PLAIN, FI_WARP_FRAG);
  if (!fiBlendProgram || !fiWarpProgram) return false;
  fiBlendPrevLoc = gl.getUniformLocation(fiBlendProgram, "u_prev");
  fiBlendCurrLoc = gl.getUniformLocation(fiBlendProgram, "u_curr");
  fiBlendPhaseLoc = gl.getUniformLocation(fiBlendProgram, "u_phase");
  fiWarpPrevLoc = gl.getUniformLocation(fiWarpProgram, "u_prev");
  fiWarpCurrLoc = gl.getUniformLocation(fiWarpProgram, "u_curr");
  fiWarpMvLoc = gl.getUniformLocation(fiWarpProgram, "u_mv");
  fiWarpTexelLoc = gl.getUniformLocation(fiWarpProgram, "u_texel");
  fiWarpGridLoc = gl.getUniformLocation(fiWarpProgram, "u_mv_grid");
  fiWarpPhaseLoc = gl.getUniformLocation(fiWarpProgram, "u_phase");
  gl.useProgram(fiBlendProgram);
  gl.uniform1i(fiBlendPrevLoc, 0);
  gl.uniform1i(fiBlendCurrLoc, 1);
  gl.useProgram(fiWarpProgram);
  gl.uniform1i(fiWarpPrevLoc, 0);
  gl.uniform1i(fiWarpCurrLoc, 1);
  gl.uniform1i(fiWarpMvLoc, 2);
  return true;
}

function fiBindOutTarget() {
  if (!fiOutFb || !fiOutTexture) return false;
  gl.bindFramebuffer(gl.FRAMEBUFFER, fiOutFb);
  gl.framebufferTexture2D(
    gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, fiOutTexture, 0,
  );
  return gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
}

function fiEnsureOut(w, h) {
  if (!fiOutTexture) fiOutTexture = fiMakeTexture();
  if (!fiOutFb) fiOutFb = gl.createFramebuffer();
  if (fiOutW !== w || fiOutH !== h) {
    gl.bindTexture(gl.TEXTURE_2D, fiOutTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    fiOutW = w;
    fiOutH = h;
  }
  // Always re-attach: fiCopyTexture must never leave this FBO pointing at video tex.
  const ok = fiBindOutTarget();
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return ok;
}

function fiCopyTexture(src, dst, w, h) {
  // Use a dedicated copy FBO so COLOR_ATTACHMENT0 on fiOutFb always stays fiOutTexture.
  if (!fiCopyFb) fiCopyFb = gl.createFramebuffer();
  gl.bindTexture(gl.TEXTURE_2D, dst);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.bindFramebuffer(gl.FRAMEBUFFER, fiCopyFb);
  gl.framebufferTexture2D(
    gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, src, 0,
  );
  gl.bindTexture(gl.TEXTURE_2D, dst);
  gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, w, h);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}

function fiUpdateLumaSample(video) {
  const srcW = video.videoWidth;
  const srcH = video.videoHeight;
  if (!srcW || !srcH) return;
  let tw = srcW;
  let th = srcH;
  if (settings.fiHalfLuma) {
    tw = Math.max(16, Math.round(srcW / 4));
    th = Math.max(16, Math.round(srcH / 4));
    // keep aspect-ish block grid friendly
    tw = Math.max(16, tw - (tw % 8));
    th = Math.max(16, th - (th % 8));
  } else {
    tw = Math.min(srcW, 320);
    th = Math.min(srcH, 180);
    tw = Math.max(16, tw - (tw % 8));
    th = Math.max(16, th - (th % 8));
  }
  if (!fiSampleCanvas) {
    fiSampleCanvas = document.createElement("canvas");
    fiSampleCtx = fiSampleCanvas.getContext("2d", { willReadFrequently: true });
  }
  if (fiSampleCanvas.width !== tw || fiSampleCanvas.height !== th) {
    fiSampleCanvas.width = tw;
    fiSampleCanvas.height = th;
  }
  try {
    fiSampleCtx.drawImage(video, 0, 0, tw, th);
    const rgba = fiSampleCtx.getImageData(0, 0, tw, th).data;
    const luma = typeof fiRgbaToLuma === "function"
      ? fiRgbaToLuma(rgba, tw * th)
      : new Float32Array(tw * th);
    fiPrevLuma = fiCurrLuma;
    fiCurrLuma = luma;
    fiLumaW = tw;
    fiLumaH = th;
  } catch {
    // tainted sample — skip CPU FI aids this frame
  }
}

function fiUploadMvTexture(match) {
  if (!match) return;
  if (!fiMvTexture) {
    fiMvTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, fiMvTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  }
  const { gridW, gridH, mvs } = match;
  // Pack mx,my into RG float via RGBA8 normalized ±32 px
  const data = new Uint8Array(gridW * gridH * 4);
  for (let i = 0, p = 0; i < gridW * gridH; i++, p += 4) {
    const mx = mvs[i * 2];
    const my = mvs[i * 2 + 1];
    data[p] = Math.max(0, Math.min(255, Math.round(mx * 4 + 128)));
    data[p + 1] = Math.max(0, Math.min(255, Math.round(my * 4 + 128)));
    data[p + 2] = 0;
    data[p + 3] = 255;
  }
  gl.bindTexture(gl.TEXTURE_2D, fiMvTexture);
  gl.texImage2D(
    gl.TEXTURE_2D, 0, gl.RGBA, gridW, gridH, 0, gl.RGBA, gl.UNSIGNED_BYTE, data,
  );
}

function fiDecodeMvScale() {
  // inverse of upload packing: (byte-128)/4 = pixels on luma grid
  return 1 / 4;
}

function fiComputeDecision() {
  const fps = metricReport.videoFps || 0;
  fiFpsEligibleSticky = typeof fiFpsAllows2xSticky === "function"
    ? fiFpsAllows2xSticky(fps, fiFpsEligibleSticky)
    : (fps >= 20 && fps <= 34);
  fiFpsEligible = typeof fiFpsAllows2x === "function"
    ? fiFpsAllows2x(fps)
    : fiFpsEligibleSticky;

  let sceneCut = false;
  let confidence = 0.5;
  fiLastMatch = null;

  if (fiPrevLuma && fiCurrLuma && fiPrevLuma.length === fiCurrLuma.length) {
    const score = typeof fiSceneCutScore === "function"
      ? fiSceneCutScore(fiPrevLuma, fiCurrLuma)
      : 0;
    if (settings.fiSceneCut && typeof fiIsSceneCut === "function" && fiIsSceneCut(score)) {
      sceneCut = true;
      fiSceneCutHold = 3;
    } else if (fiSceneCutHold > 0) {
      sceneCut = true;
      fiSceneCutHold -= 1;
    }

    if (settings.fiBlockMatch && typeof fiHierarchicalBlockMatch === "function") {
      fiLastMatch = fiHierarchicalBlockMatch(
        fiPrevLuma, fiCurrLuma, fiLumaW, fiLumaH,
        { block: 8, coarseRange: 4, refineRange: 2 },
      );
      confidence = fiLastMatch.confidence;
      // Scale MVs from luma grid pixels to full video pixels
      if (currentVideo && currentVideo.videoWidth && fiLumaW) {
        const sx = currentVideo.videoWidth / fiLumaW;
        const sy = currentVideo.videoHeight / fiLumaH;
        for (let i = 0; i < fiLastMatch.mvs.length; i += 2) {
          fiLastMatch.mvs[i] *= sx;
          fiLastMatch.mvs[i + 1] *= sy;
        }
      }
      fiUploadMvTexture(fiLastMatch);
    }
  } else if (fiSceneCutHold > 0) {
    sceneCut = true;
    fiSceneCutHold -= 1;
  }

  fiConfidence = confidence;
  fiMethod = typeof fiPickMethod === "function"
    ? fiPickMethod({
      infra: settings.fiInfra,
      fpsGate: settings.fiFpsGate,
      fpsOk: fiFpsEligibleSticky,
      sceneCutEnabled: settings.fiSceneCut,
      sceneCut,
      blockMatchEnabled: settings.fiBlockMatch,
      fallbackEnabled: settings.fiFallback,
      confidence,
    })
    : "skip";
  return fiMethod;
}

function fiRenderMidToOut(phase) {
  if (!fiHasPrev || !fiHasCurr || !fiPrevTexture || !fiCurrTexture) return false;
  if (!fiEnsurePrograms()) return false;
  const w = textureWidth;
  const h = textureHeight;
  if (!w || !h || !fiEnsureOut(w, h)) return false;

  const method = fiMethod;
  // Re-bind every mid draw so attachment is never the video texture after a copy.
  if (!fiBindOutTarget()) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return false;
  }
  gl.viewport(0, 0, w, h);
  gl.bindVertexArray(vao);

  if (method === "duplicate") {
    gl.useProgram(fiBlendProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, fiPrevTexture);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, fiPrevTexture);
    gl.uniform1f(fiBlendPhaseLoc, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  } else if (method === "block" && fiLastMatch && fiMvTexture) {
    gl.useProgram(fiWarpProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, fiPrevTexture);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, fiCurrTexture);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, fiMvTexture);
    // u_texel multiplies mv (already in source pixels) → uv offset = mv * texel
    gl.uniform2f(fiWarpTexelLoc, 1 / w, 1 / h);
    gl.uniform2f(fiWarpGridLoc, fiLastMatch.gridW, fiLastMatch.gridH);
    gl.uniform1f(fiWarpPhaseLoc, phase);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  } else {
    // blend (default mid)
    gl.useProgram(fiBlendProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, fiPrevTexture);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, fiCurrTexture);
    gl.uniform1f(fiBlendPhaseLoc, phase);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return true;
}

function fiAfterVideoUpload(video) {
  if (!settings.fiInfra || !gl) return;
  if (!fiPrevTexture) fiPrevTexture = fiMakeTexture();
  if (!fiCurrTexture) fiCurrTexture = fiMakeTexture();
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) return;

  if (fiHasCurr) {
    // previous curr becomes prev
    const tmp = fiPrevTexture;
    fiPrevTexture = fiCurrTexture;
    fiCurrTexture = tmp;
    fiHasPrev = true;
  }
  // copy current video texture into fiCurrTexture
  fiCopyTexture(texture, fiCurrTexture, w, h);
  fiHasCurr = true;
  fiUpdateLumaSample(video);
  fiComputeDecision();
}

function fiScheduleMidFrame() {
  cancelFiMid();
  if (!settings.fiInfra || !canRender() || fiMethod === "skip") return;
  if (!fiHasPrev || !fiHasCurr) return;
  const fps = metricReport.videoFps > 0 ? metricReport.videoFps : 30;
  const delay = Math.max(6, Math.min(40, 500 / fps));
  fiMidTimer = setTimeout(() => {
    fiMidTimer = null;
    if (!settings.fiInfra || !canRender() || fiMethod === "skip") return;
    fiDrawingMid = true;
    try {
      draw({ fiMid: true });
    } finally {
      fiDrawingMid = false;
    }
  }, delay);
}

// --------------------------------------------------------------------------
// Overlay + GL
// --------------------------------------------------------------------------

function createOverlay() {
  const existing = document.getElementById(CANVAS_ID);
  if (existing) existing.remove();

  canvas = document.createElement("canvas");
  canvas.id = CANVAS_ID;
  lastCanvasVisibility = "";
  lastDatasetPipeline = "";
  lastDatasetError = "";
  // ponytail: position:absolute no contêiner do vídeo (attachCanvasTo põe o
  // canvas como irmão logo após o <video>). z-index omitido de propósito: a
  // ordem no DOM já o desenha acima do vídeo; controles vêm depois e ficam acima.
  canvas.style.cssText =
    "position:absolute;left:0;top:0;width:0;height:0;pointer-events:none;contain:layout paint size;";
  // parenting acontece em attachCanvasTo, quando sabemos qual é o vídeo.

  gl = canvas.getContext("webgl2", {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: false,
    powerPreference: "high-performance",
    desynchronized: true,
  });
  if (!gl) {
    status = "no-webgl";
    lastError = "WebGL2 indisponível";
    log("WebGL2 indisponível neste Firefox/hardware");
    return false;
  }
  program = linkProgram(VERT, FRAG);
  easuProgram = linkProgram(VERT, EASU_FRAG);
  rcasProgram = linkProgram(VERT_PLAIN, FRAG);
  if (!program || !easuProgram || !rcasProgram) {
    status = "no-webgl";
    return false;
  }
  uTexLoc = gl.getUniformLocation(program, "u_tex");
  uTexelLoc = gl.getUniformLocation(program, "u_texel");
  uStrengthLoc = gl.getUniformLocation(program, "u_strength");
  uCompareLoc = gl.getUniformLocation(program, "u_compare");
  easuTexLoc = gl.getUniformLocation(easuProgram, "u_tex");
  rcasTexLoc = gl.getUniformLocation(rcasProgram, "u_tex");
  rcasTexelLoc = gl.getUniformLocation(rcasProgram, "u_texel");
  rcasStrengthLoc = gl.getUniformLocation(rcasProgram, "u_strength");
  rcasCompareLoc = gl.getUniformLocation(rcasProgram, "u_compare");
  gl.useProgram(program);
  gl.uniform1i(uTexLoc, 0);
  gl.useProgram(easuProgram);
  gl.uniform1i(easuTexLoc, 0);
  gl.useProgram(rcasProgram);
  gl.uniform1i(rcasTexLoc, 0);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const loc = gl.getAttribLocation(program, "a_pos");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

  upscaledTexture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, upscaledTexture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  framebuffer = gl.createFramebuffer();

  applyCanvasOutline(false);
  fiEnsurePrograms();
  if (!fiPrevTexture) fiPrevTexture = fiMakeTexture();
  if (!fiCurrTexture) fiCurrTexture = fiMakeTexture();
  return true;
}

function compile(type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    log("erro de compilação de shader:", gl.getShaderInfoLog(s));
    gl.deleteShader(s);
    return null;
  }
  return s;
}

function linkProgram(vertexSource, fragmentSource) {
  const vs = compile(gl.VERTEX_SHADER, vertexSource);
  const fs = compile(gl.FRAGMENT_SHADER, fragmentSource);
  if (!vs || !fs) {
    lastError = "Shader não compilou";
    return null;
  }
  const linked = gl.createProgram();
  gl.attachShader(linked, vs);
  gl.attachShader(linked, fs);
  gl.linkProgram(linked);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(linked, gl.LINK_STATUS)) {
    lastError = gl.getProgramInfoLog(linked) || "Link do shader falhou";
    log("link do programa falhou:", lastError);
    gl.deleteProgram(linked);
    return null;
  }
  return linked;
}

function extractRavuShader(source, name) {
  const marker = `${name}: String.raw\``;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`Shader RAVU ${name} ausente`);
  const bodyStart = start + marker.length;
  const end = source.indexOf("`,", bodyStart);
  if (end < 0) throw new Error(`Shader RAVU ${name} truncado`);
  return source.slice(bodyStart, end);
}

function loadRavuShaders() {
  if (ravuStepProgram && ravuComposeProgram) return Promise.resolve(true);
  if (ravuShadersPromise) return ravuShadersPromise;
  ravuShadersPromise = fetch(browser.runtime.getURL("third_party/ravu-lite/ravu-lite-webgl2.js"))
    .then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.text();
    })
    .then((source) => {
      ravuStepProgram = linkProgram(VERT, extractRavuShader(source, "step1"));
      ravuComposeProgram = linkProgram(VERT_PLAIN, extractRavuShader(source, "compose"));
      if (!ravuStepProgram || !ravuComposeProgram) {
        throw new Error(lastError || "Shader RAVU-lite não compilou");
      }
      ravuSourceLoc = gl.getUniformLocation(ravuStepProgram, "u_source");
      ravuLutLoc = gl.getUniformLocation(ravuStepProgram, "u_lut");
      ravuComposeSourceLoc = gl.getUniformLocation(ravuComposeProgram, "u_source");
      ravuPackedLoc = gl.getUniformLocation(ravuComposeProgram, "u_packed");
      ravuSourceSizeLoc = gl.getUniformLocation(ravuComposeProgram, "u_source_size");
      ravuOutputTexelLoc = gl.getUniformLocation(ravuComposeProgram, "u_output_texel");
      ravuCompareLoc = gl.getUniformLocation(ravuComposeProgram, "u_compare");
      gl.useProgram(ravuStepProgram);
      gl.uniform1i(ravuSourceLoc, 0);
      gl.uniform1i(ravuLutLoc, 1);
      gl.useProgram(ravuComposeProgram);
      gl.uniform1i(ravuComposeSourceLoc, 0);
      gl.uniform1i(ravuPackedLoc, 1);
      gl.uniform1f(ravuCompareLoc, 0);
      ravuShaderError = "";
      return true;
    })
    .catch((error) => {
      ravuShaderError = `RAVU-lite: ${error.message || error}`;
      lastError = ravuShaderError;
      log("falha ao carregar shaders RAVU-lite:", error);
      return false;
    });
  return ravuShadersPromise;
}

function loadRavuLut() {
  if (ravuLutReady) return Promise.resolve(true);
  if (ravuLutPromise) return ravuLutPromise;
  ravuLutPromise = fetch(browser.runtime.getURL("third_party/ravu-lite/ravu-lite-lut3.bin"))
    .then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.arrayBuffer();
    })
    .then((buffer) => {
      if (buffer.byteLength !== 59904) {
        throw new Error(`LUT com ${buffer.byteLength} bytes; esperado 59904`);
      }
      ravuLutTexture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, ravuLutTexture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texImage2D(
        gl.TEXTURE_2D, 0, gl.RGBA16F, 13, 288, 0,
        gl.RGBA, gl.FLOAT, new Float32Array(buffer),
      );
      ravuLutReady = true;
      ravuLutError = "";
      log("LUT RAVU-lite carregada");
      return true;
    })
    .catch((error) => {
      ravuLutError = `RAVU-lite: ${error.message || error}`;
      lastError = ravuLutError;
      log("falha ao carregar LUT RAVU-lite:", error);
      return false;
    });
  return ravuLutPromise;
}

function loadRavuAssets() {
  return Promise.all([loadRavuShaders(), loadRavuLut()])
    .then(([shaders, lut]) => shaders && lut);
}

function ensureIntermediate() {
  if (intermediateWidth === canvas.width && intermediateHeight === canvas.height) return true;
  gl.bindTexture(gl.TEXTURE_2D, upscaledTexture);
  gl.texImage2D(
    gl.TEXTURE_2D, 0, gl.RGBA, canvas.width, canvas.height,
    0, gl.RGBA, gl.UNSIGNED_BYTE, null,
  );
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(
    gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, upscaledTexture, 0,
  );
  const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  if (!complete) {
    status = "error";
    lastError = "Framebuffer intermediário incompleto";
    return false;
  }
  intermediateWidth = canvas.width;
  intermediateHeight = canvas.height;
  return true;
}

function ensureRavuIntermediate() {
  const width = currentVideo.videoWidth;
  const height = currentVideo.videoHeight;
  if (ravuWidth === width && ravuHeight === height) return true;
  if (!ravuFloatChecked) {
    ravuFloatTarget = Boolean(gl.getExtension("EXT_color_buffer_float"));
    ravuFloatChecked = true;
  }
  if (!ravuPackedTexture) {
    ravuPackedTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, ravuPackedTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  }
  if (!ravuFramebuffer) ravuFramebuffer = gl.createFramebuffer();
  gl.bindTexture(gl.TEXTURE_2D, ravuPackedTexture);
  gl.texImage2D(
    gl.TEXTURE_2D, 0, ravuFloatTarget ? gl.RGBA16F : gl.RGBA8,
    width, height, 0, gl.RGBA,
    ravuFloatTarget ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE, null,
  );
  gl.bindFramebuffer(gl.FRAMEBUFFER, ravuFramebuffer);
  gl.framebufferTexture2D(
    gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, ravuPackedTexture, 0,
  );
  const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  if (!complete) {
    status = "error";
    lastError = "Framebuffer RAVU-lite incompleto";
    return false;
  }
  ravuWidth = width;
  ravuHeight = height;
  return true;
}

function attachCanvasTo(video) {
  if (!canvas || !video.parentElement) return;
  if (canvas.parentNode !== video.parentElement) {
    // ponytail: insere logo APÓS o vídeo => acima no paint, abaixo dos controles.
    video.parentElement.insertBefore(canvas, video.nextSibling);
  }
  ensureCompareLabels();
}

function deactivateRenderer() {
  cancelScheduledFrame();
  cancelFiMid();
  resetFiPairState();
  detachActivePageListeners();
  restoreVideoPaint();
  if (scrollResumeTimer !== null) clearTimeout(scrollResumeTimer);
  scrollResumeTimer = null;
  scrolling = false;
  if (flashTimer !== null) {
    clearTimeout(flashTimer);
    flashTimer = null;
  }
  removeCompareLabels();
  if (videoResizeObserver) videoResizeObserver.disconnect();
  if (videoIntersectionObserver) videoIntersectionObserver.disconnect();
  currentVideo = null;
  videoInViewport = true;
  if (canvas && canvas.parentNode) canvas.remove();
  activePipeline = "desativado";
  status = "off";
  lastError = "";
  resetMetricWindow(performance.now());
}

function activateRenderer() {
  if (!currentVideo || settings.mode === "off") return false;
  if (!canvas && !createOverlay()) return false;
  attachCanvasTo(currentVideo);
  attachActivePageListeners();
  layoutDirty = true;
  updateCanvasVisibility();
  draw();
  schedule();
  return true;
}

function syncLayout() {
  if (stopped || !currentVideo || !canvas || !canvas.parentNode) return;
  if (!layoutDirty) return;
  const parent = currentVideo.parentElement;
  const vRect = currentVideo.getBoundingClientRect();
  const pRect = parent.getBoundingClientRect();
  // coords relativas ao contêiner posicionado (player geralmente position:relative)
  const left = vRect.left - pRect.left;
  const top = vRect.top - pRect.top;

  // ponytail: cap em DPR 2 — resolver 4K num canvas de 900px é desperdício.
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  targetWidth = Math.max(1, Math.round(vRect.width * dpr));
  targetHeight = Math.max(1, Math.round(vRect.height * dpr));
  if (settings.quality === "auto") {
    const cap = autoScaleCap(
      targetWidth, targetHeight, metricReport.videoFps || 60,
    );
    if (renderScale > cap) {
      renderScale = cap;
      stableWindows = 0;
      log("escala interna", Math.round(cap * 100) + "% — orçamento de pixels");
    }
  }
  const scale = effectiveRenderScale();
  const w = Math.max(1, Math.round(targetWidth * scale));
  const h = Math.max(1, Math.round(targetHeight * scale));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const cssLeft = left + "px";
  const cssTop = top + "px";
  const cssWidth = vRect.width + "px";
  const cssHeight = vRect.height + "px";
  if (canvas.style.left !== cssLeft) canvas.style.left = cssLeft;
  if (canvas.style.top !== cssTop) canvas.style.top = cssTop;
  if (canvas.style.width !== cssWidth) canvas.style.width = cssWidth;
  if (canvas.style.height !== cssHeight) canvas.style.height = cssHeight;
  if (settings.compare) {
    ensureCompareLabels();
    positionCompareLabels(left, top, vRect.width);
  }
  layoutDirty = false;
}

function draw(options = {}) {
  if (stopped || !canRender() ||
      !currentVideo || !gl || !canvas.parentNode) return;
  const isFiMid = options.fiMid === true;
  if (settings.mode === "ravu" &&
      (!ravuLutReady || !ravuStepProgram || !ravuComposeProgram)) {
    const ravuError = ravuShaderError || ravuLutError;
    activePipeline = ravuError ? "RAVU-lite indisponível" : "RAVU-lite carregando";
    updateCanvasDataset(activePipeline, ravuError);
    if (ravuError) {
      // Assets ausentes/quebrados: não deixar canvas preto cobrindo o vídeo.
      status = "error";
      lastError = ravuError;
      if (canvas) {
        canvas.style.visibility = "hidden";
        lastCanvasVisibility = "hidden";
      }
      removeCompareLabels();
      cancelScheduledFrame();
      cancelFiMid();
    } else {
      loadRavuAssets().then((ready) => {
        if (ready && settings.mode === "ravu" && currentVideo) {
          updateCanvasVisibility();
          draw(options);
        } else if (!ready && settings.mode === "ravu") {
          draw(options);
        }
      });
    }
    return;
  }
  cpuFrame = (cpuFrame + 1) % 15;
  const measureCpu = cpuFrame === 0 || !metricWindow;
  const cpuStart = measureCpu ? performance.now() : 0;
  syncLayout();
  if (canvas.width === 0 || canvas.height === 0) return;
  if (currentVideo.videoWidth === 0 || currentVideo.videoHeight === 0) return;

  gl.bindVertexArray(vao);
  pollGpuTimers();
  let gpuQuery = null;
  gpuFrame = (gpuFrame + 1) % 15;
  if (timerExt && gpuFrame === 0 && gpuQueries.length < 2 &&
      (measureCpu ? cpuStart : performance.now()) < gpuTimingUntil) {
    gpuQuery = gl.createQuery();
    gl.beginQuery(timerExt.TIME_ELAPSED_EXT, gpuQuery);
  }

  let sourceTex = texture;
  let fiTag = "";

  if (isFiMid) {
    if (!fiRenderMidToOut(0.5)) {
      if (gpuQuery) {
        gl.endQuery(timerExt.TIME_ELAPSED_EXT);
        gl.deleteQuery(gpuQuery);
      }
      return;
    }
    sourceTex = fiOutTexture;
    fiTag = ` · FI ${fiMethod}`;
  } else {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    try {
      if (textureWidth !== currentVideo.videoWidth || textureHeight !== currentVideo.videoHeight) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, currentVideo);
        textureWidth = currentVideo.videoWidth;
        textureHeight = currentVideo.videoHeight;
      } else {
        gl.texSubImage2D(
          gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, currentVideo,
        );
      }
    } catch (e) {
      if (gpuQuery) {
        gl.endQuery(timerExt.TIME_ELAPSED_EXT);
        gl.deleteQuery(gpuQuery);
      }
      if (e && (e.name === "SecurityError" || /security/i.test(String(e && e.message)))) {
        status = "tainted";
        lastError = e.message || "CORS bloqueou o frame";
        log("CORS bloqueou o acesso ao frame:", e.message);
      } else {
        status = "error";
        lastError = String(e && (e.message || e));
        log("texImage2D falhou inesperadamente:", e);
      }
      stop();
      return;
    }
    if (settings.fiInfra) {
      try {
        fiAfterVideoUpload(currentVideo);
      } catch (err) {
        log("FI pair update failed:", err);
        fiMethod = "skip";
      }
    } else {
      cancelFiMid();
      fiMethod = "skip";
    }
    sourceTex = texture;
  }

  const srcW = isFiMid ? fiOutW : currentVideo.videoWidth;
  const srcH = isFiMid ? fiOutH : currentVideo.videoHeight;

  if (settings.mode === "ravu") {
    const rcasStrength = adjustedRcasStrength(
      settings.strength / 100,
      Math.max(canvas.width / srcW, canvas.height / srcH),
    );
    const useRcas = rcasStrength > 0;
    if (!ensureRavuIntermediate() || (useRcas && !ensureIntermediate())) {
      if (gpuQuery) {
        gl.endQuery(timerExt.TIME_ELAPSED_EXT);
        gl.deleteQuery(gpuQuery);
      }
      ravuLutError = lastError;
      return;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, ravuFramebuffer);
    gl.viewport(0, 0, currentVideo.videoWidth, currentVideo.videoHeight);
    gl.useProgram(ravuStepProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, sourceTex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, ravuLutTexture);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.bindFramebuffer(gl.FRAMEBUFFER, useRcas ? framebuffer : null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.useProgram(ravuComposeProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, sourceTex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, ravuPackedTexture);
    setRavuComposeUniforms(
      currentVideo.videoWidth, currentVideo.videoHeight,
      1 / canvas.width, 1 / canvas.height,
      settings.compare ? 1 : 0,
    );
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    if (useRcas) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.useProgram(rcasProgram);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, upscaledTexture);
      setRcasUniforms(
        1 / canvas.width, 1 / canvas.height,
        rcasStrength, settings.compare ? 1 : 0,
      );
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    activePipeline = useRcas
      ? `RAVU-lite AR → RCAS${ravuFloatTarget ? "" : " (8-bit)"}`
      : `RAVU-lite AR${ravuFloatTarget ? "" : " (8-bit)"}`;
  } else {
    const useEasu = canvas.width > srcW || canvas.height > srcH;
    const rcasStrength = adjustedRcasStrength(
      settings.strength / 100,
      Math.max(canvas.width / srcW, canvas.height / srcH),
    );
    if (useEasu && !ensureIntermediate()) {
      if (gpuQuery) {
        gl.endQuery(timerExt.TIME_ELAPSED_EXT);
        gl.deleteQuery(gpuQuery);
      }
      stop();
      return;
    }
    if (useEasu) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.useProgram(easuProgram);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, sourceTex);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.useProgram(rcasProgram);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, upscaledTexture);
      setRcasUniforms(
        1 / canvas.width, 1 / canvas.height,
        rcasStrength, settings.compare ? 1 : 0,
      );
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      activePipeline = "EASU → RCAS";
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.useProgram(program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, sourceTex);
      setDirectUniforms(
        1 / srcW, 1 / srcH,
        rcasStrength, settings.compare ? 1 : 0,
      );
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      activePipeline = "RCAS";
    }
  }
  activePipeline += fiTag;
  if (gpuQuery) {
    gl.endQuery(timerExt.TIME_ELAPSED_EXT);
    gpuQueries.push(gpuQuery);
  }
  updateCanvasDataset(activePipeline, "");
  recordDraw(measureCpu ? performance.now() - cpuStart : null);

  if (status !== "ok") {
    status = "ok";
    lastError = "";
    log("renderizando", activePipeline, settings.strength + "% sobre <video>",
        currentVideo.clientWidth + "x" + currentVideo.clientHeight);
  }
  updateCanvasVisibility();
  if (!isFiMid && settings.fiInfra) fiScheduleMidFrame();
}

// --------------------------------------------------------------------------
// Loop de frames
// --------------------------------------------------------------------------

function onFrame(now, metadata) {
  rafId = null;
  scheduledKind = null;
  if (stopped) return;
  const freshFrame = recordVideoFrame(now, metadata);
  publishMetrics(now);
  if (!currentVideo || !document.body.contains(currentVideo)) {
    if (videoResizeObserver) videoResizeObserver.disconnect();
    if (videoIntersectionObserver) videoIntersectionObserver.disconnect();
    currentVideo = null;
    hideCanvas();
    rescan();
    schedule();
    return;
  }
  if (document.hidden) {
    schedule();
    return;
  }
  if (freshFrame) {
    draw();
    if (schedulerMode === "display" && canRender()) lastDisplayDrawTime = now;
  }
  schedule();
}

function schedule() {
  if (stopped || rafId !== null || !currentVideo || !canRender()) return;
  if (scrolling && settings.interaction === "balanced") {
    scheduledKind = "timeout";
    rafId = setTimeout(() => {
      onFrame(performance.now(), null);
    }, INTERACTION_PREVIEW_MS);
    return;
  }
  if (schedulerMode === "video" &&
      typeof currentVideo.requestVideoFrameCallback === "function") {
    scheduledKind = "video";
    rafId = currentVideo.requestVideoFrameCallback(onFrame);
  } else {
    const delay = displayPollDelay(
      lastDisplayDrawTime, performance.now(), metricReport.videoFps || 60,
    );
    if (delay > 4) {
      scheduledKind = "timeout";
      rafId = setTimeout(() => {
        rafId = null;
        scheduledKind = null;
        schedule();
      }, delay);
    } else {
      scheduledKind = "animation";
      rafId = requestAnimationFrame(onFrame);
    }
  }
}

function cancelScheduledFrame(video = currentVideo) {
  if (rafId === null) return;
  if (scheduledKind === "video" && video &&
      typeof video.cancelVideoFrameCallback === "function") {
    video.cancelVideoFrameCallback(rafId);
  } else if (scheduledKind === "timeout") {
    clearTimeout(rafId);
  } else {
    cancelAnimationFrame(rafId);
  }
  rafId = null;
  scheduledKind = null;
  // mid-frame FI is independent of rVFC handle; cancel on full stop paths only
}

function scheduleLayoutSync() {
  // reposiciona o canvas mesmo quando pausado (theater/resize sem nova frame)
  if (stopped || layoutRafScheduled || !currentVideo) return;
  layoutRafScheduled = true;
  requestAnimationFrame(() => {
    layoutRafScheduled = false;
    if (currentVideo) syncLayout();
  });
}

function markDirty() {
  layoutDirty = true;
  scheduleLayoutSync();
}

function scheduleRescan() {
  if (stopped || rescanRafScheduled || settings.mode === "off") return;
  rescanRafScheduled = true;
  requestAnimationFrame(() => {
    rescanRafScheduled = false;
    rescan();
  });
}

function handleVisibilityChange() {
  updateCanvasVisibility();
  if (document.hidden) cancelScheduledFrame();
  else {
    scheduleRescan();
    schedule();
  }
}

function ensureVideoIntersectionObserver() {
  if (typeof IntersectionObserver !== "function") return null;
  if (!videoIntersectionObserver) {
    videoIntersectionObserver = new IntersectionObserver(handleVideoIntersection, {
      threshold: 0.01,
    });
  }
  return videoIntersectionObserver;
}

function attachActivePageListeners() {
  if (activePageListeners) return;
  activePageListeners = true;
  if (typeof ResizeObserver === "function" && !videoResizeObserver) {
    videoResizeObserver = new ResizeObserver(markDirty);
  }
  ensureVideoIntersectionObserver();
  if (videoResizeObserver && currentVideo) videoResizeObserver.observe(currentVideo);
  if (videoIntersectionObserver && currentVideo) videoIntersectionObserver.observe(currentVideo);
  window.addEventListener("resize", markDirty, { passive: true });
  window.addEventListener("wheel", suspendOverlayForInteraction, { passive: true, capture: true });
  window.addEventListener("touchmove", suspendOverlayForInteraction, { passive: true, capture: true });
  window.addEventListener("scroll", suspendOverlayForInteraction, { passive: true, capture: true });
  window.addEventListener("keydown", suspendOverlayForNavigationKey, true);
  document.addEventListener("fullscreenchange", markDirty);
  document.addEventListener("visibilitychange", handleVisibilityChange);
}

function detachActivePageListeners() {
  if (!activePageListeners) return;
  activePageListeners = false;
  window.removeEventListener("resize", markDirty);
  window.removeEventListener("wheel", suspendOverlayForInteraction, true);
  window.removeEventListener("touchmove", suspendOverlayForInteraction, true);
  window.removeEventListener("scroll", suspendOverlayForInteraction, true);
  window.removeEventListener("keydown", suspendOverlayForNavigationKey, true);
  document.removeEventListener("fullscreenchange", markDirty);
  document.removeEventListener("visibilitychange", handleVisibilityChange);
  if (videoResizeObserver) videoResizeObserver.disconnect();
  if (videoIntersectionObserver) videoIntersectionObserver.disconnect();
}

function handleVideoDiscovery() {
  scheduleRescan();
}

function handleStillFrame() {
  if (currentVideo) draw();
}

function attachDiscoveryListeners() {
  if (discoveryListeners) return;
  discoveryListeners = true;
  // Eventos nativos descobrem vídeos novos em SPAs sem varrer a página em loop.
  document.addEventListener("play", handleVideoDiscovery, true);
  document.addEventListener("loadedmetadata", handleVideoDiscovery, true);
  document.addEventListener("emptied", handleVideoDiscovery, true);
  // Redraw explícito em seek/load quando pausado (rVFC não dispara parado).
  document.addEventListener("seeked", handleStillFrame, true);
  document.addEventListener("loadeddata", handleStillFrame, true);
}

function detachDiscoveryListeners() {
  if (!discoveryListeners) return;
  discoveryListeners = false;
  document.removeEventListener("play", handleVideoDiscovery, true);
  document.removeEventListener("loadedmetadata", handleVideoDiscovery, true);
  document.removeEventListener("emptied", handleVideoDiscovery, true);
  document.removeEventListener("seeked", handleStillFrame, true);
  document.removeEventListener("loadeddata", handleStillFrame, true);
}

// --------------------------------------------------------------------------
// Seleção de vídeo
// --------------------------------------------------------------------------

function handleVideoIntersection(entries) {
  if (!currentVideo) {
    if (entries.some((entry) => entry.isIntersecting)) scheduleRescan();
    return;
  }
  const entry = entries.find((candidate) => candidate.target === currentVideo);
  if (!entry) return;
  const visible = entry.isIntersecting && entry.intersectionRatio > 0;
  if (visible === videoInViewport) return;
  videoInViewport = visible;
  resetMetricWindow(performance.now());
  lastPresentedFrames = null;
  lastMediaTime = null;
  lastPlaybackDropped = null;
  lastPlaybackTotal = null;
  updateCanvasVisibility();
  if (visible) {
    schedule();
    draw();
  } else {
    cancelScheduledFrame();
  }
}

function rescan() {
  if (stopped || !settingsLoaded) return;
  if (settings.mode === "off") {
    deactivateRenderer();
    return;
  }
  const videos = document.querySelectorAll("video");
  if (videos.length === 0) {
    cancelScheduledFrame();
    restoreVideoPaint();
    if (videoResizeObserver) videoResizeObserver.disconnect();
    if (videoIntersectionObserver) videoIntersectionObserver.disconnect();
    detachActivePageListeners();
    currentVideo = null;
    if (status !== "no-video") {
      status = "no-video";
      log("nenhum <video> na página");
    }
    hideCanvas();
    return;
  }
  const next = pickLargestVideo(videos, window.innerWidth, window.innerHeight);
  if (!next && !currentVideo) {
    const observer = ensureVideoIntersectionObserver();
    if (observer) {
      observer.disconnect();
      for (const video of videos) observer.observe(video);
    }
    return;
  }
  if (next && next !== currentVideo) {
    cancelScheduledFrame();
    restoreVideoPaint();
    lastPresentedFrames = null;
    lastMediaTime = null;
    lastPlaybackDropped = null;
    lastPlaybackTotal = null;
    lastDisplayDrawTime = 0;
    if (settings.quality === "auto") {
      renderScale = 1;
      stableWindows = 0;
    }
    currentVideo = next;
    videoInViewport = true;
    if (activePageListeners && videoResizeObserver) {
      videoResizeObserver.disconnect();
      videoResizeObserver.observe(next);
    }
    if (activePageListeners && videoIntersectionObserver) {
      videoIntersectionObserver.disconnect();
      videoIntersectionObserver.observe(next);
    }
    layoutDirty = true;
    log("vídeo selecionado:", next.clientWidth + "x", next.clientHeight,
        next.videoWidth ? "(src " + next.videoWidth + "x" + next.videoHeight + ")" : "");
    if (settings.mode !== "off" && !activateRenderer()) return;
  }
  if (currentVideo && layoutDirty) syncLayout();
  if (currentVideo && currentVideo.paused && currentVideo.readyState >= 2) draw();
  schedule();
}

function hideCanvas() {
  restoreVideoPaint();
  if (canvas) {
    canvas.style.width = "0";
    canvas.style.height = "0";
  }
}

function applySettings(value) {
  const previous = settings;
  settings = normalizeSettings(value);
  const modeChanged = settings.mode !== previous.mode;
  const qualityChanged = settings.quality !== previous.quality;
  const visualChanged = settings.strength !== previous.strength ||
    settings.compare !== previous.compare;
  const outlineChanged = settings.outline !== previous.outline;
  const compareChanged = settings.compare !== previous.compare;
  const interactionChanged = settings.interaction !== previous.interaction;
  const fiChanged =
    settings.fiInfra !== previous.fiInfra ||
    settings.fiSceneCut !== previous.fiSceneCut ||
    settings.fiFpsGate !== previous.fiFpsGate ||
    settings.fiHalfLuma !== previous.fiHalfLuma ||
    settings.fiBlockMatch !== previous.fiBlockMatch ||
    settings.fiFallback !== previous.fiFallback;

  if (settings.mode === "off") {
    detachDiscoveryListeners();
    deactivateRenderer();
    return;
  }
  attachDiscoveryListeners();
  if (settings.quality !== "auto" && qualityChanged) {
    const scales = { high: 1, balanced: 0.75, performance: 0.5 };
    setRenderScale(scales[settings.quality]);
  } else if (settings.quality === "auto" && previous.quality !== "auto") {
    stableWindows = 0;
    setRenderScale(1, "— modo automático reiniciado");
  }
  if (!settings.fiInfra || settings.fiInfra !== previous.fiInfra) {
    cancelFiMid();
    if (!settings.fiInfra) resetFiPairState();
  }
  if (canvas) {
    if (outlineChanged && flashTimer === null) applyCanvasOutline(false);
    if (compareChanged || modeChanged) {
      ensureCompareLabels();
      if (settings.compare && currentVideo) {
        layoutDirty = true;
        scheduleLayoutSync();
      }
    }
  }
  if (!currentVideo) {
    if (modeChanged) rescan();
    if (modeChanged && canvas) flashModeChange();
    return;
  }
  if (previous.mode === "off") {
    status = "idle";
    rescan();
  } else if (modeChanged || qualityChanged) {
    activateRenderer();
  } else if (interactionChanged || fiChanged) {
    layoutDirty = true;
    resetMetricWindow(performance.now());
    updateCanvasVisibility();
    cancelScheduledFrame();
    schedule();
    if (currentVideo) draw();
  } else if (visualChanged) {
    draw();
  }
  if (modeChanged && canvas) flashModeChange();
}

function loadSettings() {
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    const next = { ...settings };
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (changes[key]) next[key] = changes[key].newValue;
    }
    applySettings(next);
  });
  return browser.storage.local.get(DEFAULT_SETTINGS)
    .then(applySettings)
    .catch((error) => {
      log("não foi possível carregar preferências:", error);
    })
    .finally(() => {
      settingsLoaded = true;
    });
}

function snapshot() {
  const now = performance.now();
  if (gl && !timerExtChecked) {
    timerExt = gl.getExtension("EXT_disjoint_timer_query_webgl2");
    timerExtChecked = true;
  }
  gpuTimingUntil = now + 1200;
  publishMetrics(now);
  return {
    status,
    lastError,
    visible: overlayVisible,
    hasVideo: Boolean(currentVideo),
    canvasWidth: canvas ? canvas.width : 0,
    canvasHeight: canvas ? canvas.height : 0,
    pipeline: activePipeline,
    scheduler: schedulerMode === "video" ? "frame do vídeo" : "refresh da tela",
    settings: { ...settings },
    metrics: { ...metricReport, gpuSupported: Boolean(timerExt) },
    fi: {
      method: fiMethod,
      confidence: fiConfidence,
      fpsEligible: fiFpsEligibleSticky,
      videoFps: metricReport.videoFps || 0,
      sceneCutHold: fiSceneCutHold,
      hasPair: fiHasPrev && fiHasCurr,
      halfLuma: Boolean(settings.fiHalfLuma),
      sample: fiLumaW && fiLumaH ? `${fiLumaW}×${fiLumaH}` : "—",
    },
  };
}

function toggleOverlay() {
  if (settings.mode === "off") return snapshot();
  overlayVisible = !overlayVisible;
  resetMetricWindow(performance.now());
  updateCanvasVisibility();
  if (overlayVisible) {
    attachActivePageListeners();
    schedule();
    if (currentVideo) draw();
  } else {
    if (scrollResumeTimer !== null) clearTimeout(scrollResumeTimer);
    scrollResumeTimer = null;
    scrolling = false;
    cancelScheduledFrame();
    detachActivePageListeners();
  }
  return snapshot();
}

function suspendOverlayForNavigationKey(event) {
  if (![
    "ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End", " ",
  ].includes(event.key)) return;
  suspendOverlayForInteraction();
}

function suspendOverlayForInteraction() {
  if (stopped || settings.mode === "off" || !overlayVisible || !canvas ||
      (typeof document !== "undefined" && document.hidden)) return;
  if (settings.interaction === "quality") return;
  if (scrollResumeTimer !== null) clearTimeout(scrollResumeTimer);
  if (!scrolling) {
    scrolling = true;
    layoutDirty = true;
    cancelScheduledFrame();
    cancelFiMid();
    updateCanvasVisibility();
    schedule();
  }
  scrollResumeTimer = setTimeout(() => {
    scrollResumeTimer = null;
    scrolling = false;
    layoutDirty = true;
    resetMetricWindow(performance.now());
    updateCanvasVisibility();
    schedule();
  }, INTERACTION_PAUSE_MS);
}

function stop() {
  stopped = true;
  cancelScheduledFrame();
  cancelFiMid();
  resetFiPairState();
  restoreVideoPaint();
  detachActivePageListeners();
  detachDiscoveryListeners();
  if (scrollResumeTimer !== null) clearTimeout(scrollResumeTimer);
  if (videoResizeObserver) videoResizeObserver.disconnect();
  if (videoIntersectionObserver) videoIntersectionObserver.disconnect();
  hideCanvas();
}

// --------------------------------------------------------------------------
// Bootstrap
// --------------------------------------------------------------------------

function runSpike() {
  if (window.top !== window) return;

  // Evita duplicação se a extensão for injetada manualmente mais de uma vez.
  if (window.__fvEnhancerLoaded) {
    log("já carregado nesta página — ignorando re-injeção");
    return;
  }
  window.__fvEnhancerLoaded = true;

  browser.runtime.onMessage.addListener((message) => {
    if (message && message.type === "fv-status") return Promise.resolve(snapshot());
    if (message && message.type === "fv-toggle") return Promise.resolve(toggleOverlay());
    if (message && message.type === "fv-settings") {
      applySettings({ ...settings, ...message.settings });
      return Promise.resolve(snapshot());
    }
  });

  loadSettings().finally(() => {
    if (settings.mode !== "off") attachDiscoveryListeners();
    rescan();
  });

  log("inicializado em", location.href);
}

// --------------------------------------------------------------------------
// Self-check (roda só fora do navegador, ex.: `node content.js`)
// --------------------------------------------------------------------------

function selfCheck() {
  const fake = (w, h, paused, ready = 4, left = 0, top = 0) => ({
    getBoundingClientRect: () => ({ width: w, height: h, left, top }),
    clientWidth: w,
    clientHeight: h,
    paused,
    ended: false,
    readyState: ready,
  });

  const a = [fake(100, 100, true), fake(1280, 720, false), fake(640, 360, false)];
  const pickA = pickLargestVideo(a, 1920, 1080);
  if (pickA !== a[1]) throw new Error("selfCheck: esperava o 1280x720 em reprodução");

  const b = [fake(2000, 2000, true), fake(500, 500, false)];
  const pickB = pickLargestVideo(b, 3000, 3000);
  if (pickB !== b[0]) throw new Error("selfCheck: peso 0.3x quebrou a regra esperada");

  const c = [fake(5000, 5000, false)];
  const pickC = pickLargestVideo(c, 1920, 1080);
  if (pickC !== c[0]) throw new Error("selfCheck: área visível truncada falhou");

  const d = [fake(2000, 2000, false, 4, -3000, 0), fake(320, 180, false)];
  const pickD = pickLargestVideo(d, 1920, 1080);
  if (pickD !== d[1]) throw new Error("selfCheck: vídeo fora da tela foi selecionado");

  const normalized = normalizeSettings({
    mode: "invalid", strength: 150.4, outline: 1, compare: 1, quality: "invalid",
    interaction: "invalid",
  });
  if (normalized.mode !== "ravu" || normalized.strength !== 100 ||
      normalized.outline || normalized.compare || normalized.quality !== "high" ||
      normalized.interaction !== "smooth") {
    throw new Error("selfCheck: normalização de preferências falhou");
  }
  if (normalizeSettings({ mode: "passthrough" }).mode !== "off" ||
      normalizeSettings({ mode: "ravu" }).mode !== "ravu" ||
      normalizeSettings({ interaction: "balanced" }).interaction !== "balanced") {
    throw new Error("selfCheck: migração de passthrough ou modo RAVU falhou");
  }

  settings = normalizeSettings({ interaction: "balanced" });
  scrolling = true;
  renderScale = 1;
  if (effectiveRenderScale() !== 0.5) {
    throw new Error("selfCheck: perfil Equilíbrio não reduziu escala durante navegação");
  }
  scrolling = false;
  settings = normalizeSettings(DEFAULT_SETTINGS);
  if (settings.fiInfra !== false || settings.fiSceneCut !== true) {
    throw new Error("selfCheck: defaults FI incorretos");
  }
  if (typeof fiSelfCheck === "function") fiSelfCheck();
  // Shipped warp shader must use ME-correct sampling (not inverted).
  if (!FI_WARP_FRAG.includes("v_uv - mv * t * u_texel") ||
      !FI_WARP_FRAG.includes("v_uv + mv * (1.0 - t) * u_texel") ||
      /fromPrev = v_uv \+ mv \* t/.test(FI_WARP_FRAG)) {
    throw new Error("selfCheck: FI_WARP_FRAG motion sampling direction wrong");
  }
  // FBO separation: copy binds fiCopyFb; mid path re-binds out target every time.
  const copySrc = String(fiCopyTexture);
  if (!copySrc.includes("fiCopyFb") ||
      !/bindFramebuffer\(\s*gl\.FRAMEBUFFER\s*,\s*fiCopyFb\s*\)/.test(copySrc) ||
      /bindFramebuffer\(\s*gl\.FRAMEBUFFER\s*,\s*fiOutFb\s*\)/.test(copySrc)) {
    throw new Error("selfCheck: fiCopyTexture must bind fiCopyFb, not fiOutFb");
  }
  if (!String(fiEnsureOut).includes("fiBindOutTarget") ||
      !String(fiRenderMidToOut).includes("fiBindOutTarget")) {
    throw new Error("selfCheck: mid-out path must re-bind fiOutTexture via fiBindOutTarget");
  }

  const severe = selectAutoScale(1, 0, {
    videoFps: 60, missed: 8, missedPct: 12, latePct: 0,
    cpuMs: 1, gpuMs: 1,
  });
  if (severe.scale !== 0.7 || severe.stable !== 0) {
    throw new Error("selfCheck: Auto não reagiu à sobrecarga severa");
  }
  let recovery = { scale: 0.7, stable: 0 };
  for (let i = 0; i < 5; i++) {
    recovery = selectAutoScale(recovery.scale, recovery.stable, {
      videoFps: 60, missed: 0, missedPct: 0, latePct: 0,
      cpuMs: 1, gpuMs: 1,
    });
  }
  if (recovery.scale !== 0.85 || recovery.stable !== 0) {
    throw new Error("selfCheck: Auto não recuperou após cinco janelas estáveis");
  }
  if (!shouldUseDisplayScheduler({ videoFps: 60, fps: 24, missedPct: 60 }) ||
      shouldUseDisplayScheduler({ videoFps: 60, fps: 59, missedPct: 1 })) {
    throw new Error("selfCheck: fallback de agendamento escolheu o modo errado");
  }
  if (autoScaleCap(1920, 1080, 60) !== 1 ||
      autoScaleCap(2560, 1440, 60) !== 0.85 ||
      autoScaleCap(3840, 2160, 60) !== 0.7) {
    throw new Error("selfCheck: orçamento de megapixels escolheu escala errada");
  }
  if (displayPollDelay(100, 105, 60) < 9 ||
      displayPollDelay(100, 120, 60) !== 0) {
    throw new Error("selfCheck: polling adaptativo calculou atraso errado");
  }
  if (adjustedRcasStrength(1, 1) !== 1 ||
      Math.abs(adjustedRcasStrength(1, 3) - 0.7) > 1e-6) {
    throw new Error("selfCheck: proteção de halos calculou intensidade errada");
  }
  const shaderFixture = "step1: String.raw`um`,\ncompose: String.raw`dois`,";
  if (extractRavuShader(shaderFixture, "step1") !== "um" ||
      extractRavuShader(shaderFixture, "compose") !== "dois") {
    throw new Error("selfCheck: parser lazy do RAVU falhou");
  }

  resetMetricWindow(0);
  lastPresentedFrames = null;
  lastMediaTime = null;
  recordVideoFrame(0, { presentedFrames: 1, mediaTime: 0, expectedDisplayTime: 5 });
  recordVideoFrame(20, { presentedFrames: 3, mediaTime: 0.04, expectedDisplayTime: 25 });
  if (metricWindow.mediaFrames !== 2 || metricWindow.missed !== 1) {
    throw new Error("selfCheck: salto de frames não foi contabilizado corretamente");
  }

  console.log(TAG, "selfCheck OK");
}

if (typeof window !== "undefined" && window.document) {
  runSpike();
} else {
  // Node: load pure FI units so selfCheck can exercise shipped fi-core functions.
  try {
    const fs = require("fs");
    const path = require("path");
    const vm = require("vm");
    const fiPath = path.join(__dirname, "fi-core.js");
    vm.runInThisContext(fs.readFileSync(fiPath, "utf8"), { filename: fiPath });
  } catch (error) {
    console.warn("[fv-enhancer] não carregou fi-core.js no self-check:", error.message || error);
  }
  selfCheck();
}
