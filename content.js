"use strict";
const ext = globalThis.browser ?? globalThis.chrome;
if (typeof FiQuality === "undefined" && typeof require === "function") globalThis.FiQuality = require("./fi-quality.js");
/*
 * Firefox Video Enhancer
 *
 * The main <video> becomes a WebGL2 texture and is drawn on an overlaid canvas
 * with FSR1 (EASU + RCAS) or RAVU-lite AR + RCAS. In Disabled mode, no canvas
 * or rendering callback remains active.
 *
 * Canvas as a sibling immediately after <video> (same container):
 *  - DOM order places it ABOVE the video without fighting the site's z-index.
 *  - Scrolls/resizes with the player; while scrolling, the effect pauses to free
 *    the page compositor.
 *  - pointer-events:none => clicks pass through; controls (siblings after the
 *    canvas) remain visible and clickable.
 *
 * Self-check: `node content.js` runs assertions over the video selector.
 */

// --------------------------------------------------------------------------
// Pure logic (testable without a DOM)
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
  mode: "off",
  strength: 100,
  outline: false,
  compare: false,
  quality: "high",
  interaction: "smooth",
  // Frame interpolation (A/B toggles). Defaults: infra off; sub-options ready.
  fiInfra: false,
  fiEngine: "analytic",
  fiModelRevision: "",
  fiProfile: "balanced",
  fiDebug: 0,
  fiNeuralRevision: 0,
  fiSceneCut: true,
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
      fiHalfLuma: value.fiHalfLuma !== false,
      fiBlockMatch: value.fiBlockMatch !== false,
      fiFallback: value.fiFallback !== false,
    };
  return {
    mode: ["off", "native", "rcas", "ravu"].includes(mode) ? mode : DEFAULT_SETTINGS.mode,
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
    fiEngine: ((globalThis.VE_BUILD?.personal !== false ? ["analytic","classic","neural","ifrnet"] : ["analytic","classic"]).includes(value.fiEngine)) ? value.fiEngine : "analytic",
    fiModelRevision: typeof value.fiModelRevision === "string" ? value.fiModelRevision : "",
    fiProfile: value.fiProfile === "quality" ? "quality" : "balanced",
    fiDebug: [0, 1, 2, 3, 4].includes(Number(value.fiDebug)) ? Number(value.fiDebug) : 0,
    fiNeuralRevision: Number.isSafeInteger(value.fiNeuralRevision) ? value.fiNeuralRevision : 0,
  };
}

// --------------------------------------------------------------------------
// Shaders
// --------------------------------------------------------------------------

const VERT = `#version 300 es
layout(location=0) in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = vec2(a_pos.x * 0.5 + 0.5, 0.5 - a_pos.y * 0.5); // flip Y for video
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
uniform sampler2D u_mv_forward;
uniform sampler2D u_mv_backward;
uniform vec2 u_texel;
uniform vec2 u_mv_grid;
uniform float u_phase;
in vec2 v_uv;
out vec4 outColor;
void main() {
  // MV texture (RGBA16F): RG = motion in luma pixels, A = local confidence.
  // Sample continuously instead of by cell; hard cells show up as square artifacts.
  vec2 halfCell = 0.5 / u_mv_grid;
  vec2 lo = halfCell;
  vec2 hi = vec2(1.0) - halfCell;
  vec4 packedForward = texture(u_mv_forward, clamp(v_uv, lo, hi));
  vec4 packedBackward = texture(u_mv_backward, clamp(v_uv, lo, hi));
  // ME defines mv so curr[p+mv] ≈ prev[p] (feature moves +mv from prev→curr).
  // Mid at phase t: sample prev at p - mv*t, curr at p + mv*(1-t).
  float t = clamp(u_phase, 0.0, 1.0);
  // Vectors belong to endpoint coordinates, not the intermediate image.
  // One inverse-warp refinement keeps object edges from borrowing background motion.
  vec2 forwardMv = packedForward.xy;
  vec2 backwardMv = packedBackward.xy;
  packedForward = texture(u_mv_forward, clamp(v_uv - forwardMv * t * u_texel, lo, hi));
  packedBackward = texture(u_mv_backward, clamp(v_uv - backwardMv * (1.0 - t) * u_texel, lo, hi));
  forwardMv = packedForward.xy;
  backwardMv = packedBackward.xy;
  float forwardConfidence = smoothstep(0.15, 0.8, packedForward.a);
  float backwardConfidence = smoothstep(0.15, 0.8, packedBackward.a);
  vec2 fromPrev = v_uv - forwardMv * t * u_texel;
  vec2 fromCurr = v_uv - backwardMv * (1.0 - t) * u_texel;
  vec3 a = texture(u_prev, clamp(fromPrev, vec2(0.0), vec2(1.0))).rgb;
  vec3 b = texture(u_curr, clamp(fromCurr, vec2(0.0), vec2(1.0))).rgb;
  if (max(forwardConfidence, backwardConfidence) < 0.12) {
    outColor = vec4(texture(u_prev, v_uv).rgb, 1.0);
    return;
  }
  float wa = (1.0 - t) * forwardConfidence;
  float wb = t * backwardConfidence;
  vec3 warped = (a * wa + b * wb) / max(wa + wb, 1e-4);
  // Occlusion test: at one point, forward and backward vectors must cancel
  // (mv_f ≈ -mv_b). A large sum means the vectors describe different layers
  // (an occlusion) or one of them failed — those must never be averaged.
  float occluded = smoothstep(0.75, 2.0, length(forwardMv + backwardMv));
  // Photometric test: after a correct warp the endpoints agree. Averaging
  // slightly misaligned samples is what creates double-edge ghosting.
  float disagree = smoothstep(0.025, 0.12, length(a - b));
  float pick = max(occluded, disagree);
  // Show the more confident, nearer endpoint instead of a ghost average.
  vec3 near = wa >= wb ? a : b;
  outColor = vec4(mix(warped, near, pick), 1.0);
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
// Module state
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
let ravuRetryPromise = null, ravuPendingCaptureVideo = null;
let ravuRetryGeneration = 0;
let ravuFloatTarget = false, ravuFloatChecked = false;
let textureWidth = 0, textureHeight = 0;
let timerExt = null;
let timerExtChecked = false;
const gpuQueries = [];
let gpuFrame = 0;
let cpuFrame = 0;
let gpuTimingUntil = 0;
let currentVideo = null;
let blockedVideo = null;
let frameWatchdog = null;
let useAnimationFallback = false;
let lastFreshFrameTime = null;
let rafId = null;
let scheduledKind = null;
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
let lastExpectedDisplayTime = null;
let lastVideoCallbackTime = null;
let lastVideoFrameDurationMs = 0;
let fiResumeGap = false;
let lastPlaybackDropped = null;
let lastPlaybackTotal = null;
let renderScale = 1;
let targetWidth = 0;
let targetHeight = 0;
let stableWindows = 0;
let activePipeline = "disabled";
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
  fps: 0, midFps: 0, videoFps: 0, missed: 0, missedPct: 0, latePct: null,
  videoDropped: 0, videoDroppedPct: 0,
  cpuMs: 0, cpuMaxMs: 0, gpuMs: null, decoderMs: null,
  renderScale: 1,
};

// --------------------------------------------------------------------------
// Frame interpolation state (GL + CPU). Pure decisions live in fi-core.js.
// --------------------------------------------------------------------------
let fiPrevTexture = null;
let fiCurrTexture = null;
let fiTextureW = 0;
let fiTextureH = 0;
let fiOutTexture = null;
let fiForwardMvTexture = null;
let fiBackwardMvTexture = null;
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
let fiMidRaf = null;
let fiMethod = "skip";
let fiConfidence = 0;
let fiSceneCutHold = 0;
let fiLastMatch = null;
let fiLastBackwardMatch = null;
let fiBlendProgram = null;
let fiWarpProgram = null;
let fiBlendPrevLoc = null, fiBlendCurrLoc = null, fiBlendPhaseLoc = null;
let fiWarpPrevLoc = null, fiWarpCurrLoc = null;
let fiWarpForwardMvLoc = null, fiWarpBackwardMvLoc = null;
let fiWarpTexelLoc = null, fiWarpGridLoc = null, fiWarpPhaseLoc = null;
let fiOutW = 0, fiOutH = 0;
let fiPairSerial = 0;
let fiLatencyActive = false;
let fiLastPresentation = "current";
let fiMidPerSec = 0;
let fiRealPerSec = 0;
let fiLastExplain = "";
let fiLastRealCpuMs = 0;
let fiMotionRetryAt = 0;
let fiGpuEngine = null;
let fiGpuInit = null;
let fiGpuGeneration = 0;
let fiNeuralFailure = "";
let fiAnalyticStep = 0, fiAnalyticSlow = 0;
let fiAnalyticLate = 0, fiAnalyticRetryAt = 0;
let fiNeuralResult = null, fiNeuralTarget = null;
let fiPairAnchorTime = 0, fiDisplayReference = 0;
let fiGpuState = "idle";
let fiGpuError = "";
let fiGpuBusy = false;
let fiGpuReadySerial = -1;
let fiGpuElapsedMs = 0;
let fiGpuSampleScale = 1;
let fiGpuSlowPairs = 0;
let fiPairDiscontinuous = false;
let fiMidCpuMs = 2;
let fiDisplayPeriod = 1000 / 60;
let fiDisplayRaf = null;
let fiSkipReason = ""; // why mid was not presented (smoothness)

function log(...args) {
  console.log(TAG, ...args);
}

function canRender() {
  return settings.mode !== "off" && overlayVisible && (!currentVideo || currentVideo !== blockedVideo) &&
    (!scrolling || settings.interaction !== "smooth") && videoInViewport &&
    (typeof document === "undefined" || !document.hidden);
}

function canShowOverlayFrame() {
  return canRender() && status === "ok";
}

function effectiveRenderScale() {
  return scrolling && settings.interaction === "balanced"
    ? Math.min(renderScale, 0.5)
    : renderScale;
}

function updateCanvasVisibility() {
  const next = canShowOverlayFrame() ? "visible" : "hidden";
  if (!canvas) {
    return;
  }
  if (lastCanvasVisibility !== next) {
    canvas.style.display = next === "visible" ? "" : "none";
    canvas.style.visibility = next;
    lastCanvasVisibility = next;
  }
  if (compareLeftEl) compareLeftEl.style.visibility = next;
  if (compareRightEl) compareRightEl.style.visibility = next;
}

function modeDisplayName(mode) {
  if (mode === "ravu") return "RAVU";
  if (mode === "rcas") return "FSR1";
  if (mode === "native") return "Native";
  return "Disabled";
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
    start: now, callbacks: 0, realDrawn: 0, midDrawn: 0, missed: 0, late: 0,
    cpuTotal: 0, cpuMax: 0, cpuSamples: 0, gpuTotal: 0, gpuSamples: 0,
    decoderTotal: 0, decoderSamples: 0, hasMetadata: false,
    mediaDelta: 0, mediaFrames: 0,
    videoDropped: 0, videoTotal: 0,
  };
}

function resetVideoFrameHistory() {
  lastFreshFrameTime = null;
  lastPresentedFrames = null;
  lastMediaTime = null;
  lastExpectedDisplayTime = null;
  lastVideoCallbackTime = null;
  lastVideoFrameDurationMs = 0;
  lastPlaybackDropped = null;
  lastPlaybackTotal = null;
  fiResumeGap = false;
}

function setRenderScale(value, reason) {
  if (renderScale === value) return;
  renderScale = value;
  layoutDirty = true;
  scheduleLayoutSync();
  log("internal scale", Math.round(value * 100) + "%", reason || "");
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
  // ponytail: conservative steps; recalibrate only with diverse real telemetry.
  const megapixelsPerSecond = width * height * (fps || 60) / 1e6;
  if (megapixelsPerSecond > 700) return 0.5;
  if (megapixelsPerSecond > 350) return 0.7;
  if (megapixelsPerSecond > 180) return 0.85;
  return 1;
}

function adjustedRcasStrength(strength, upscaleRatio) {
  const haloProtection = Math.max(0.7, 1 - 0.15 * Math.max(0, upscaleRatio - 1));
  return strength * haloProtection;
}

function fiOutputFps(sourceFps, enabled) {
  const fps = Number(sourceFps);
  return Number.isFinite(fps) && fps > 0 ? fps * (enabled ? 2 : 1) : 0;
}

function shouldUseRavu(sourceW, sourceH, outputW, outputH, quality) {
  return quality === "high" || outputW > sourceW || outputH > sourceH;
}

function fiFrameDurationMs(expectedDeltaMs, mediaDeltaSeconds, playbackRate) {
  const rate = Number.isFinite(playbackRate) && playbackRate > 0 ? playbackRate : 1;
  if (Number.isFinite(mediaDeltaSeconds) && mediaDeltaSeconds > 0 && mediaDeltaSeconds < 1) {
    return mediaDeltaSeconds * 1000 / rate;
  }
  if (Number.isFinite(expectedDeltaMs) && expectedDeltaMs > 0 && expectedDeltaMs <= 500) {
    return expectedDeltaMs;
  }
  return 0;
}

function fiMidBudgetMs(pairDurationMs, sourceFps) {
  const duration = Number(pairDurationMs);
  if (Number.isFinite(duration) && duration > 0) return duration / 2;
  const fps = Number(sourceFps);
  return 500 / (Number.isFinite(fps) && fps > 0 ? fps : 30);
}

function fiIsTimingGap(deltaMs, frameDurationMs) {
  if (!Number.isFinite(deltaMs) || deltaMs <= 0) return false;
  const nominal = Number.isFinite(frameDurationMs) && frameDurationMs > 0
    ? frameDurationMs
    : 1000 / 30;
  return deltaMs > Math.max(250, nominal * 3);
}

function frameDrawKind(options = {}) {
  if (options.fiMid === true) return "mid";
  if (options.newVideoFrame === true) return "capture";
  return "redraw";
}

function adaptRenderScale(report) {
  if (settings.quality !== "auto") return;
  const next = selectAutoScale(renderScale, stableWindows, {
    ...report,
    videoFps: fiOutputFps(
      report.videoFps,
      settings.fiInfra,
    ),
  });
  next.scale = Math.min(
    next.scale,
    autoScaleCap(targetWidth, targetHeight, report.videoFps || 60),
  );
  stableWindows = next.stable;
  if (next.scale !== renderScale) {
    setRenderScale(next.scale,
      next.scale < renderScale ? "— overload detected" : "— five stable windows");
  }
}

function fiExplainStatus() {
  if (!settings.fiInfra) {
    return "Smoothing is off. Enable it to generate one midpoint per pair (up to 2×).";
  }
  if (!fiHasPrev || !fiHasCurr) {
    return "Waiting for the second video frame to build a pair…";
  }
  if (fiSkipReason) {
    return fiSkipReason;
  }
  const mids = fiMidPerSec;
  const reals = fiRealPerSec;
  if (fiMethod === "skip") {
    return "Interpolation is enabled, but no midpoints are being generated right now (budget or confidence).";
  }
  if (mids < 1 && reals > 5) {
    return "No stable midpoints — prioritizing the real cadence instead of forcing late frames.";
  }
  return `Motion midpoints ~${mids.toFixed(0)}/s · anchors ~${reals.toFixed(0)}/s · confidence ${(fiConfidence * 100).toFixed(0)}%. If playback stutters, disable smoothing or use FSR1.`;
}

/**
 * Smoothness-first gate: only present a mid when it is likely to help, not hurt.
 * - No mid if last real frame already ate the frame budget.
 */
function fiShouldPresentMid() {
  const priorSkipReason = fiSkipReason;
  fiSkipReason = "";
  if (!settings.fiInfra || fiMethod === "skip") {
    if (priorSkipReason) fiSkipReason = priorSkipReason;
    return false;
  }
  if (!fiHasPrev || !fiHasCurr) return false;
  if (fiMethod === "duplicate") {
    fiSkipReason = "Uncertain scene or motion — keeping the real cadence without duplicating the pipeline.";
    return false;
  }
  if (!["block", "webgpu", "neural", "analytic", "ifrnet"].includes(fiMethod)) return false;
  const fps = metricReport.videoFps > 0 ? metricReport.videoFps : 30;
  const budget = fiMidBudgetMs(lastVideoFrameDurationMs, fps);
  if (fiLastRealCpuMs > budget) {
    fiSkipReason =
      `Last real frame took ${fiLastRealCpuMs.toFixed(1)} ms (budget ~${budget.toFixed(0)} ms) — midpoint cancelled to avoid stutter.`;
    return false;
  }
  if (priorSkipReason) fiSkipReason = priorSkipReason;
  return true;
}

function publishMetrics(now) {
  if (!metricWindow || metricWindow.callbacks === 0 || now - metricWindow.start < 1000) return;
  const elapsed = now - metricWindow.start;
  const totalFrames = metricWindow.realDrawn + metricWindow.missed;
  fiMidPerSec = metricWindow.midDrawn * 1000 / elapsed;
  fiRealPerSec = metricWindow.realDrawn * 1000 / elapsed;
  metricReport = {
    fps: metricWindow.realDrawn * 1000 / elapsed,
    midFps: metricWindow.midDrawn * 1000 / elapsed,
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
  fiLastExplain = fiExplainStatus();
  if (canRender()) adaptRenderScale(metricReport);
  metricReport.renderScale = effectiveRenderScale();
  resetMetricWindow(now);
}

function recordVideoFrame(now, metadata) {
  if (!metricWindow) resetMetricWindow(now);
  metricWindow.callbacks++;
  fiResumeGap = false;
  const callbackDelta = lastVideoCallbackTime === null ? 0 : now - lastVideoCallbackTime;
  lastVideoCallbackTime = now;
  let qualityDelta = null;
  const needsQuality = (!metadata && !scrolling) || metricWindow.callbacks % 15 === 0;
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
      if (!metadata && canRender() && qualityDelta > 1) {
        metricWindow.missed += qualityDelta - 1;
      }
    }
    lastPlaybackDropped = quality.droppedVideoFrames;
    lastPlaybackTotal = quality.totalVideoFrames;
  }
  if (!metadata) {
    fiResumeGap = qualityDelta > 1 || fiIsTimingGap(callbackDelta, lastVideoFrameDurationMs);
    return qualityDelta === null || qualityDelta > 0;
  }
  metricWindow.hasMetadata = true;
  let presentedDelta = 1;
  if (lastPresentedFrames !== null) {
    presentedDelta = Math.max(1, metadata.presentedFrames - lastPresentedFrames);
  }
  if (canRender() && lastPresentedFrames !== null &&
      metadata.presentedFrames > lastPresentedFrames + 1) {
    metricWindow.missed += metadata.presentedFrames - lastPresentedFrames - 1;
  }
  const expectedTime = Number(metadata.expectedDisplayTime);
  const expectedDelta = Number.isFinite(expectedTime) && lastExpectedDisplayTime !== null
    ? expectedTime - lastExpectedDisplayTime
    : NaN;
  const mediaDelta = lastMediaTime === null ? NaN : metadata.mediaTime - lastMediaTime;
  const playbackRate = currentVideo && Number(currentVideo.playbackRate) > 0
    ? Number(currentVideo.playbackRate)
    : 1;
  const wallDelta = Number.isFinite(expectedDelta)
    ? expectedDelta
    : (Number.isFinite(mediaDelta) ? mediaDelta * 1000 / playbackRate : callbackDelta);
  // Non-adjacent endpoints cannot use the nominal one-frame presentation phase.
  const timingGap = fiIsTimingGap(wallDelta, lastVideoFrameDurationMs);
  fiResumeGap = presentedDelta > 1 || timingGap;
  const duration = fiFrameDurationMs(
    expectedDelta / presentedDelta, mediaDelta / presentedDelta, playbackRate,
  );
  if (!timingGap && duration > 0) lastVideoFrameDurationMs = duration;

  lastPresentedFrames = metadata.presentedFrames;
  if (lastMediaTime !== null) {
    if (mediaDelta > 0 && mediaDelta < 1) {
      metricWindow.mediaDelta += mediaDelta;
      metricWindow.mediaFrames += presentedDelta;
    }
  }
  lastMediaTime = metadata.mediaTime;
  lastExpectedDisplayTime = Number.isFinite(expectedTime) ? expectedTime : null;
  if (Number.isFinite(expectedTime) && expectedTime - now < 1) metricWindow.late++;
  if (Number.isFinite(metadata.processingDuration)) {
    metricWindow.decoderTotal += metadata.processingDuration * 1000;
    metricWindow.decoderSamples++;
  }
  return true;
}

function recordDraw(cpuMs, isFiMid = false) {
  if (!metricWindow) resetMetricWindow(performance.now());
  metricWindow[isFiMid ? "midDrawn" : "realDrawn"]++;
  if (!isFiMid && Number.isFinite(cpuMs)) {
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
  if (fiMidRaf !== null) {
    cancelAnimationFrame(fiMidRaf);
    fiMidRaf = null;
  }
}

function resetFiPairState(preserveBudget = false) {
  fiPairDiscontinuous = false;
  fiGpuReadySerial = -1;
  fiNeuralResult = fiNeuralTarget = null;
  fiGpuEngine?.reset?.();
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
  fiLastBackwardMatch = null;
  if (!preserveBudget) {
    fiLastRealCpuMs = 0;
    fiMotionRetryAt = 0;
  }
  fiSkipReason = "";
  fiLatencyActive = false;
  fiLastPresentation = "current";
  fiPairSerial++;
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
  fiWarpForwardMvLoc = gl.getUniformLocation(fiWarpProgram, "u_mv_forward");
  fiWarpBackwardMvLoc = gl.getUniformLocation(fiWarpProgram, "u_mv_backward");
  fiWarpTexelLoc = gl.getUniformLocation(fiWarpProgram, "u_texel");
  fiWarpGridLoc = gl.getUniformLocation(fiWarpProgram, "u_mv_grid");
  fiWarpPhaseLoc = gl.getUniformLocation(fiWarpProgram, "u_phase");
  gl.useProgram(fiBlendProgram);
  gl.uniform1i(fiBlendPrevLoc, 0);
  gl.uniform1i(fiBlendCurrLoc, 1);
  gl.useProgram(fiWarpProgram);
  gl.uniform1i(fiWarpPrevLoc, 0);
  gl.uniform1i(fiWarpCurrLoc, 1);
  gl.uniform1i(fiWarpForwardMvLoc, 2);
  gl.uniform1i(fiWarpBackwardMvLoc, 3);
  return true;
}

function warmFiPrograms() {
  if (!settings.fiInfra || !gl || (fiBlendProgram && fiWarpProgram)) return;
  queueMicrotask(() => {
    if (settings.fiInfra && gl && !fiEnsurePrograms()) {
      log("FI shaders unavailable:", lastError);
    }
  });
}

function fiWarmGpu() {
  if (!settings.fiInfra || fiGpuInit || fiGpuState === "unavailable") return;
  if (fiGpuEngine && !fiGpuEngine.lost) {
    if (["analytic","ifrnet"].includes(fiGpuEngine.kind) && currentVideo &&
        (fiGpuEngine.sourceW !== currentVideo.videoWidth || fiGpuEngine.sourceH !== currentVideo.videoHeight)) fiReleaseGpu(false);
    else return;
  }
  if (settings.fiEngine !== "classic" && (!gl || !currentVideo?.videoWidth)) return;
  const generation = fiGpuGeneration;
  const requested = settings.fiEngine;
  const profile = settings.fiProfile;
  fiGpuState = "initializing";
  fiMeasureDisplay();
  fiGpuInit = Promise.resolve().then(async () => {
/* PERSONAL_ONLY_BEGIN */
    if (globalThis.VE_BUILD?.personal !== false && requested === "neural" && !fiNeuralFailure) {
      try { return await FiNeural.create({ profile }); }
      catch (error) { if (generation === fiGpuGeneration) fiNeuralFailure = String(error.message || error); }
    }
/* PERSONAL_ONLY_END */
    if (requested === "ifrnet" && !fiNeuralFailure) {
      try {
        const bytes = await VENeuralClient.load();
        if (generation !== fiGpuGeneration || !gl || !currentVideo?.videoWidth) return null;
        const width=currentVideo.videoWidth,height=currentVideo.videoHeight;
        const engine = await VENeuralRuntime.create(gl, bytes, width, height, profile);
        engine.kind = "ifrnet"; engine.sourceW = width; engine.sourceH = height;
        engine.whenLost = new Promise(() => {}); engine.stats = {completed:0,late:0,ms:0};
        engine.modelSize = {width:engine.dimensions.activeW,height:engine.dimensions.activeH};
        return engine;
      } catch (error) { if (generation === fiGpuGeneration) fiNeuralFailure = String(error.message || error); }
    }
    if (generation !== fiGpuGeneration) return null;
    if (requested !== "classic") {
      if (!gl || !currentVideo?.videoWidth) throw new Error("Waiting for a video and WebGL2 context");
      return await FiAnalytic.create(gl, currentVideo.videoWidth, currentVideo.videoHeight, profile, fiAnalyticStep);
    }
    if (typeof FiWebGpu === "undefined") throw new Error("WebGPU module unavailable. Reload the extension and page.");
    const engine = await FiWebGpu.create();
    engine.kind = "classic";
    return engine;
  }).then(engine => {
    if (!engine) return;
    if (generation !== fiGpuGeneration || !settings.fiInfra || settings.mode === "off" || stopped) {
      engine.destroy();
      return;
    }
    fiGpuEngine = engine;
    fiGpuState = "ready";
    fiGpuError = "";
    engine.whenLost.then(error => {
      if (fiGpuEngine !== engine) return;
      if (["neural","ifrnet"].includes(engine.kind)) { fiUseClassicFallback(engine, error); return; }
      fiGpuState = "unavailable";
      fiGpuError = String(error.message || error);
      fiMethod = "skip";
      fiGpuReadySerial = -1;
      fiSkipReason = "Motion backend unavailable; showing original frames. " + fiGpuError;
    });
  }).catch(error => {
    if (generation !== fiGpuGeneration) return;
    fiGpuState = "unavailable";
    fiGpuError = String(error.message || error);
  }).finally(() => { if (generation === fiGpuGeneration) fiGpuInit = null; });
}

function fiUseClassicFallback(engine, error) {
  if (fiGpuEngine !== engine) return;
  fiNeuralFailure = String(error?.message || error || "Neural processing failed");
  fiReleaseGpu(false);
  fiSkipReason = "Optional neural backend unavailable; using Analytic Flow. " + fiNeuralFailure;
  fiWarmGpu();
}

function fiReleaseGpu(clearNeuralFailure = true) {
  fiGpuGeneration++;
  fiGpuInit = null;
  if (fiDisplayRaf !== null) cancelAnimationFrame(fiDisplayRaf);
  fiDisplayRaf = null;
  cancelFiMid();
  fiNeuralResult = fiNeuralTarget = null;
  fiGpuReadySerial = -1;
  const engine = fiGpuEngine;
  fiGpuEngine = null;
  fiGpuState = "idle";
  fiGpuBusy = false;
  fiMethod = "skip";
  if (clearNeuralFailure) fiNeuralFailure = "";
  if (engine) engine.destroy();
}

/* PERSONAL_ONLY_BEGIN */
function fiRequestNeuralPair() {
  const engine = fiGpuEngine, serial = fiPairSerial, video = currentVideo;
  fiNeuralResult = fiNeuralTarget = null;
  const duration = lastVideoFrameDurationMs || 1000 / ((metricReport.videoFps || 30) * (video.playbackRate || 1));
  const slot = FiQuality.neuralSlot(fiPairAnchorTime, duration, fiDisplayPeriod,
    fiDisplayReference || fiPairAnchorTime);
  const hasLumaPair = fiPrevLuma && fiCurrLuma && fiPrevLuma.length === fiCurrLuma.length;
  const cut = Boolean(settings.fiSceneCut && hasLumaPair &&
    fiIsSceneCut(fiSceneCutScore(fiPrevLuma, fiCurrLuma)) &&
    fiSceneDistributionChange(fiPrevLuma, fiCurrLuma) > .35);
  const skip = !fiHasPrev || !hasLumaPair || fiPairDiscontinuous || cut || !slot || !settings.fiBlockMatch;
  const valid = () => fiGpuEngine === engine && serial === fiPairSerial && video === currentVideo &&
    settings.fiInfra && canRender() && slot && performance.now() <= slot.expires;
  let work;
  try {
    // submit snapshots the video synchronously, even when a pair will be skipped.
    work = engine.submit(video, { serial, phase: slot?.phase || .5, skip, valid, debug: settings.fiDebug });
  } catch (error) { fiUseClassicFallback(engine, error); return false; }
  if (!work) {
    fiSkipReason = cut ? "Scene cut; keeping original anchors." : skip ?
      "No safe extra-frame slot; keeping original anchors." : "Neural buffering or busy; keeping original anchors.";
    return false;
  }
  fiNeuralTarget = slot;
  fiGpuBusy = true;
  fiMethod = "pending";
  fiSkipReason = "Reconstructing with the compact neural network.";
  work.then(result => {
    if (fiGpuEngine !== engine || serial !== fiPairSerial || video !== currentVideo) return;
    fiGpuElapsedMs = engine.stats.ms;
    if (!result || !valid()) { fiMethod = "skip"; fiSkipReason = "Neural frame missed its slot; preserving source cadence."; return; }
    fiNeuralResult = result;
    fiGpuReadySerial = serial;
    fiMethod = "neural";
    fiSkipReason = "";
  }).catch(error => fiUseClassicFallback(engine, error)).finally(() => {
    if (fiGpuEngine === engine) fiGpuBusy = false;
  });
  return true;
}

/* PERSONAL_ONLY_END */
function fiRequestAnalyticPair() {
  const engine=fiGpuEngine,serial=fiPairSerial,video=currentVideo;
  if (!fiHasPrev || fiPairDiscontinuous || !settings.fiBlockMatch || fiGpuBusy) return false;
  if(performance.now()<fiAnalyticRetryAt){fiSkipReason="Analytic cooldown after sustained overload; preserving source frames.";return false;}
  const duration=lastVideoFrameDurationMs || 1000/((metricReport.videoFps||30)*(video.playbackRate||1));
  if (duration<fiDisplayPeriod*1.45) {fiSkipReason="No additional display slot; preserving the source cadence.";return false;}
  fiGpuBusy=true;fiMethod="pending";fiSkipReason="Estimating bidirectional motion on the GPU.";
  engine.estimate(fiPrevTexture,fiCurrTexture,serial).then(result=>{
    if(fiGpuEngine!==engine || video!==currentVideo || !settings.fiInfra || !canRender())return;
    fiGpuElapsedMs=result?.elapsedMs||0;
    fiAnalyticSlow=fiGpuElapsedMs>duration*.8 ? fiAnalyticSlow+1 : 0;
    // Reduce inference work only between pairs; never mutate active textures.
    if(fiAnalyticSlow>=4){
      if(fiAnalyticStep<2){fiAnalyticStep++;fiAnalyticSlow=0;fiReleaseGpu(false);fiWarmGpu();return;}
      fiAnalyticSlow=0;fiAnalyticRetryAt=performance.now()+3000;
    }
    if(!result || !result.valid || serial!==fiPairSerial || fiGpuElapsedMs>=duration){
      fiAnalyticLate++;if(serial===fiPairSerial){fiMethod="skip";fiSkipReason="Motion arrived late; keeping the timed source anchor.";}return;
    }
    if(settings.fiSceneCut&&result.sceneCut){fiMethod="skip";fiSkipReason="Scene cut; keeping original anchors.";return;}
    fiConfidence=result.confidence;fiGpuReadySerial=serial;fiMethod="analytic";fiSkipReason="";
  }).catch(error=>{
    if(fiGpuEngine!==engine)return;fiGpuError=String(error.message||error);fiGpuState="unavailable";
    fiMethod="skip";fiGpuReadySerial=-1;engine.destroy();fiSkipReason="Analytic Flow unavailable; showing original frames. "+fiGpuError;
  }).finally(()=>{if(fiGpuEngine===engine)fiGpuBusy=false;});
  return true;
}

function fiRequestIfrPair() {
  const engine=fiGpuEngine,serial=fiPairSerial,video=currentVideo;
  const duration=lastVideoFrameDurationMs||1000/((metricReport.videoFps||30)*(video.playbackRate||1));
  const slot=FiQuality.neuralSlot(fiPairAnchorTime,duration,fiDisplayPeriod,fiDisplayReference||fiPairAnchorTime);
  fiNeuralResult=fiNeuralTarget=null;
  if(!slot||!fiHasPrev||fiPairDiscontinuous||fiGpuBusy||!settings.fiBlockMatch)return false;
  fiNeuralTarget=slot;fiGpuBusy=true;fiMethod="pending";
  engine.estimate(fiPrevTexture,fiCurrTexture,serial,slot.phase).then(result=>{
    if(fiGpuEngine!==engine||video!==currentVideo||serial!==fiPairSerial||!settings.fiInfra||!canRender())return;
    fiGpuElapsedMs=result?.elapsedMs||0;engine.stats.ms=fiGpuElapsedMs;engine.stats.completed++;
    if(!result?.valid||performance.now()>slot.expires){engine.stats.late++;fiMethod="skip";return;}
    if(settings.fiSceneCut&&result.sceneCut){fiMethod="skip";fiSkipReason="Scene cut; keeping original anchors.";return;}
    fiNeuralResult=result;fiGpuReadySerial=serial;fiMethod="ifrnet";fiSkipReason="";
  }).catch(error=>fiUseClassicFallback(engine,error)).finally(()=>{if(fiGpuEngine===engine)fiGpuBusy=false;});return true;
}
function fiMeasureDisplay() {
  if (fiDisplayRaf !== null) return;
  let previous = null;
  const intervals = [];
  const sample = now => {
    fiDisplayRaf = null;
    if (!settings.fiInfra || document.hidden || stopped) return;
    if (previous !== null && now - previous > 2 && now - previous < 80) intervals.push(now - previous);
    previous = now;
    fiDisplayReference = now;
    if (intervals.length >= 12) {
      intervals.sort((a, b) => a - b);
      fiDisplayPeriod = intervals[Math.floor(intervals.length / 2)];
    } else fiDisplayRaf = requestAnimationFrame(sample);
  };
  fiDisplayRaf = requestAnimationFrame(sample);
}

function fiRequestGpuPair() {
  fiGpuReadySerial = -1;
  fiMethod = "skip";
  fiConfidence = 0;
  fiLastMatch = null;
  fiLastBackwardMatch = null;
  fiWarmGpu();
  if (!fiGpuEngine || fiGpuEngine.lost || fiGpuState !== "ready") {
    fiSkipReason = fiGpuError || "Preparing the motion backend; showing original frames.";
    return false;
  }
/* PERSONAL_ONLY_BEGIN */
  if (fiGpuEngine.kind === "neural") return fiRequestNeuralPair();
/* PERSONAL_ONLY_END */
  if (fiGpuEngine.kind === "analytic") return fiRequestAnalyticPair();
  if (fiGpuEngine.kind === "ifrnet") return fiRequestIfrPair();
  if (!settings.fiBlockMatch) {
    fiSkipReason = "Motion estimation disabled; showing original frames.";
    return false;
  }
  if (!fiHasPrev || !fiPrevLuma || !fiCurrLuma || fiPrevLuma.length !== fiCurrLuma.length) return false;
  if (fiPairDiscontinuous) {
    fiSkipReason = "A source frame was missed; keeping the presentation cadence.";
    return false;
  }
  const duration = lastVideoFrameDurationMs || 1000 / ((metricReport.videoFps || 30) * (currentVideo.playbackRate || 1));
  if (duration < fiDisplayPeriod * 1.45) {
    fiSkipReason = "The display has no reliable slot for an extra frame; showing original frames.";
    return false;
  }
  if (fiGpuBusy) {
    fiSkipReason = "Finishing motion estimation; keeping the presentation cadence.";
    return false;
  }
  const score = fiSceneCutScore(fiPrevLuma, fiCurrLuma);
  if (settings.fiSceneCut && fiIsSceneCut(score) && fiSceneDistributionChange(fiPrevLuma, fiCurrLuma) > .35) {
    fiSkipReason = "Scene cut; showing original frames.";
    return false;
  }
  const serial = fiPairSerial;
  const video = currentVideo;
  const start = performance.now();
  const engine = fiGpuEngine;
  fiGpuBusy = true;
  fiMethod = "pending";
  fiSkipReason = "Estimating motion with WebGPU.";
  engine.estimate(fiPrevLuma, fiCurrLuma, fiLumaW, fiLumaH).then(result => {
    fiGpuElapsedMs = performance.now() - start;
    if (video !== currentVideo || fiGpuEngine !== engine || !settings.fiInfra || !canRender()) return;
    fiGpuSlowPairs = fiGpuElapsedMs > duration * .8 ? fiGpuSlowPairs + 1 : 0;
    if (fiGpuSlowPairs >= 3) {
      fiGpuSampleScale = Math.max(.5, fiGpuSampleScale - .25);
      fiGpuSlowPairs = 0;
    }
    if (serial !== fiPairSerial) return;
    if (fiGpuElapsedMs >= duration) {
      fiMethod = "skip";
      fiSkipReason = "Motion arrived after its frame; keeping the presentation cadence.";
      return;
    }
    result.forward = FiQuality.regularize(result.forward, fiPrevLuma, fiLumaW, fiLumaH);
    result.backward = FiQuality.regularize(result.backward, fiCurrLuma, fiLumaW, fiLumaH);
    const pair = fiBidirectionalConsistency(result.forward, result.backward);
    fiConfidence = pair ? pair.confidence : 0;
    if (!pair || (settings.fiSceneCut && fiIsSceneCut(score) && fiConfidence < .2 &&
        Math.min(result.forward.meanResidual, result.backward.meanResidual) > 18)) {
      fiMethod = "skip";
      fiSkipReason = "Scene transition; keeping original anchors on the same clock.";
      return;
    }
    result.forward.confidences = pair.forward;
    result.backward.confidences = pair.backward;
    fiLastMatch = result.forward;
    fiLastBackwardMatch = result.backward;
    gl.activeTexture(gl.TEXTURE0);
    fiForwardMvTexture = fiUploadMvTexture(fiLastMatch, fiForwardMvTexture);
    fiBackwardMvTexture = fiUploadMvTexture(fiLastBackwardMatch, fiBackwardMvTexture);
    fiGpuReadySerial = serial;
    fiMethod = "webgpu";
    fiSkipReason = "";
  }).catch(error => {
    if (fiGpuEngine !== engine) return;
    fiGpuError = String(error.message || error);
    fiGpuState = "unavailable";
    engine.destroy();
    if (serial === fiPairSerial) {
      fiMethod = "skip";
      fiSkipReason = "WebGPU failed; showing original frames. " + fiGpuError;
    }
  }).finally(() => {
    if (fiGpuEngine === engine) fiGpuBusy = false;
  });
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
  gl.bindFramebuffer(gl.FRAMEBUFFER, fiCopyFb);
  gl.framebufferTexture2D(
    gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, src, 0,
  );
  gl.bindTexture(gl.TEXTURE_2D, dst);
  gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, w, h);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}

function fiEnsureFrameTextures(w, h) {
  if (!fiPrevTexture) fiPrevTexture = fiMakeTexture();
  if (!fiCurrTexture) fiCurrTexture = fiMakeTexture();
  if (fiTextureW === w && fiTextureH === h) return;
  resetFiPairState();
  for (const tex of [fiPrevTexture, fiCurrTexture]) {
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  }
  fiTextureW = w;
  fiTextureH = h;
}

function fiLumaSampleSize(srcW, srcH, halfLuma) {
  // GPU optical flow uses a larger luma image; transfers remain bounded.
  const p = FiQuality.profile(settings.fiProfile);
  const neural = fiGpuEngine?.kind === "neural";
  const maxW = neural ? 160 : (halfLuma ? p.motionW : p.motionW * 1.25) * fiGpuSampleScale;
  const maxH = neural ? 90 : (halfLuma ? p.motionH : p.motionH * 1.25) * fiGpuSampleScale;
  const scale = Math.min(1, maxW / srcW, maxH / srcH);
  let tw = Math.max(16, Math.round(srcW * scale));
  let th = Math.max(16, Math.round(srcH * scale));
  // keep block grid friendly
  tw = Math.max(16, tw - (tw % 8));
  th = Math.max(16, th - (th % 8));
  return { width: tw, height: th };
}

function fiUpdateLumaSample(video) {
  const srcW = video.videoWidth;
  const srcH = video.videoHeight;
  if (!srcW || !srcH) return;
  const size = fiLumaSampleSize(srcW, srcH, settings.fiHalfLuma);
  const tw = size.width;
  const th = size.height;
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
    // Never reuse stale luma from an earlier pair after a failed readback.
    fiPrevLuma = null;
    fiCurrLuma = null;
  }
}

const fiHalfBits = new ArrayBuffer(4);
const fiHalfF32 = new Float32Array(fiHalfBits);
const fiHalfU32 = new Uint32Array(fiHalfBits);

function fiFloatToHalf(value) {
  return FiQuality.floatToHalf(value);
}

function fiUploadMvTexture(match, texture) {
  if (!match) return;
  if (!texture) {
    texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  }
  const { gridW, gridH, mvs } = match;
  const confidences = match.confidences;
  // RGBA16F: raw motion in R/G (luma pixels), local confidence in A. Half-float
  // keeps sub-pixel motion; the old 8-bit packing quantized vectors to 0.25 px
  // of the luma grid, which showed up as steppy pans.
  const data = new Uint16Array(gridW * gridH * 4);
  for (let i = 0, p = 0; i < gridW * gridH; i++, p += 4) {
    const gx = i % gridW;
    const gy = Math.floor(i / gridW);
    const c = confidences ? confidences[i] : match.confidence;
    const valid = FiQuality.validFlow(mvs[i * 2], mvs[i * 2 + 1], Math.max(fiLumaW, fiLumaH, 1));
    data[p] = fiFloatToHalf(valid ? mvs[i * 2] : 0);
    data[p + 1] = fiFloatToHalf(valid ? mvs[i * 2 + 1] : 0);
    data[p + 2] = 0;
    data[p + 3] = fiFloatToHalf(valid && Number.isFinite(c) ? Math.max(0, Math.min(1, c)) : 0);
  }
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(
    gl.TEXTURE_2D, 0, gl.RGBA16F, gridW, gridH, 0, gl.RGBA, gl.HALF_FLOAT, data,
  );
  return texture;
}

function fiComputeDecision() {
  const fps = metricReport.videoFps || 0;
  fiSkipReason = "";

  let sceneCut = false;
  let confidence = 0.5;
  let canBlockMatch = false;
  fiLastMatch = null;
  fiLastBackwardMatch = null;

  if (fiPrevLuma && fiCurrLuma && fiPrevLuma.length === fiCurrLuma.length) {
    const score = typeof fiSceneCutScore === "function"
      ? fiSceneCutScore(fiPrevLuma, fiCurrLuma)
      : 0;
    if (settings.fiSceneCut && typeof fiIsSceneCut === "function" && fiIsSceneCut(score) &&
        fiSceneDistributionChange(fiPrevLuma, fiCurrLuma) > 0.35) {
      sceneCut = true;
      fiSceneCutHold = 3;
    } else if (fiSceneCutHold > 0) {
      sceneCut = true;
      fiSceneCutHold -= 1;
    }

    const now = performance.now();
    const budget = fiMidBudgetMs(lastVideoFrameDurationMs, fps);
    // Avoid alternating heavy matching and cheap fallback on every other frame.
    // After overload, keep the cheap path for a second before probing motion again.
    if (fiLastRealCpuMs >= budget) fiMotionRetryAt = now + 1000;
    const hasBudget = now >= fiMotionRetryAt;
    canBlockMatch = settings.fiBlockMatch && hasBudget;
    if (!canBlockMatch && settings.fiSceneCut && fiIsSceneCut(score)) {
      sceneCut = true;
      fiSceneCutHold = 3;
    }
    if (!hasBudget && !sceneCut) {
      fiSkipReason =
        "Motion estimation is cooling down after overload; using blend for now.";
    }
    if (!sceneCut && canBlockMatch &&
        typeof fiHierarchicalBlockMatch === "function") {
      // ponytail: bidirectional CPU match stays on the 160×90 sample; move this pair
      // to a WebGL pyramid only if capture p95 starts missing the frame budget.
      fiLastMatch = fiHierarchicalBlockMatch(
        fiPrevLuma, fiCurrLuma, fiLumaW, fiLumaH,
        { block: 8, coarseRange: 3, refineRange: 1, pyramid: true, subpixel: true },
      );
      fiLastBackwardMatch = fiHierarchicalBlockMatch(
        fiCurrLuma, fiPrevLuma, fiLumaW, fiLumaH,
        { block: 8, coarseRange: 3, refineRange: 1, pyramid: true, subpixel: true },
      );
      const pair = typeof fiBidirectionalConsistency === "function"
        ? fiBidirectionalConsistency(fiLastMatch, fiLastBackwardMatch)
        : null;
      if (pair) {
        fiLastMatch.confidences = pair.forward;
        fiLastBackwardMatch.confidences = pair.backward;
        confidence = pair.confidence;
      } else {
        confidence = Math.min(fiLastMatch.confidence, fiLastBackwardMatch.confidence);
      }
      // Unrelated shots may share a histogram. Reject them when neither direction
      // can explain the pixel change with reliable motion.
      if (settings.fiSceneCut && fiIsSceneCut(score) && confidence < 0.52 &&
          Math.min(fiLastMatch.meanResidual, fiLastBackwardMatch.meanResidual) > 18) {
        sceneCut = true;
        fiSceneCutHold = 3;
      }
      fiForwardMvTexture = fiUploadMvTexture(fiLastMatch, fiForwardMvTexture);
      fiBackwardMvTexture = fiUploadMvTexture(fiLastBackwardMatch, fiBackwardMvTexture);
    }
  } else if (fiSceneCutHold > 0) {
    sceneCut = true;
    fiSceneCutHold -= 1;
  }

  fiConfidence = confidence;
  fiMethod = typeof fiPickMethod === "function"
    ? fiPickMethod({
      infra: settings.fiInfra,
      sceneCutEnabled: settings.fiSceneCut,
      sceneCut,
      blockMatchEnabled: canBlockMatch,
      fallbackEnabled: settings.fiFallback,
      confidence,
    })
    : "skip";
  return fiMethod;
}

function fiRenderMidToOut(phase) {
  if (fiMethod === "analytic") {
    if (!fiHasPrev || !fiHasCurr || fiGpuReadySerial!==fiPairSerial || !fiGpuEngine ||
        !fiEnsureOut(textureWidth,textureHeight)) return false;
    return fiGpuEngine.render(fiPrevTexture,fiCurrTexture,fiOutTexture,textureWidth,textureHeight,phase,settings.fiDebug);
  }
  if (fiMethod === "ifrnet") {
    if (!fiHasPrev || !fiHasCurr || fiGpuReadySerial!==fiPairSerial || !fiGpuEngine ||
        !fiEnsureOut(textureWidth,textureHeight)) return false;
    if(!fiNeuralTarget || !fiNeuralResult || performance.now()>fiNeuralTarget.expires || Math.abs(phase-fiNeuralTarget.phase)>.001)return false;
    return fiGpuEngine.render(fiPrevTexture,fiCurrTexture,fiOutTexture,textureWidth,textureHeight,
      ["off","flow","mask","residual","off"][settings.fiDebug]);
  }
/* PERSONAL_ONLY_BEGIN */
  if (fiMethod === "neural") {
    const result = fiNeuralResult;
    if (!result || result.serial !== fiPairSerial || fiGpuReadySerial !== fiPairSerial ||
        !fiNeuralTarget || performance.now() > fiNeuralTarget.expires ||
        !fiEnsureOut(result.width, result.height)) return false;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, fiOutTexture);
    // Canvas-to-texture interop, not a CPU pixel-array readback. The browser may
    // copy between GPU APIs; this is not a claim of universal zero-copy.
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, result.canvas);
    return true;
  }
/* PERSONAL_ONLY_END */
  if (fiMethod !== "webgpu" && fiMethod !== "block") return false;
  if (fiMethod === "webgpu" && fiGpuReadySerial !== fiPairSerial) return false;
  if (!fiLastMatch || !fiLastBackwardMatch || !fiForwardMvTexture || !fiBackwardMvTexture) return false;
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

  if ((method === "block" || (method === "webgpu" && fiGpuReadySerial === fiPairSerial)) && fiLastMatch && fiLastBackwardMatch &&
      fiForwardMvTexture && fiBackwardMvTexture) {
    gl.useProgram(fiWarpProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, fiPrevTexture);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, fiCurrTexture);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, fiForwardMvTexture);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, fiBackwardMvTexture);
    // Motion stays in the small luma grid, avoiding 8-bit clipping after upscaling.
    gl.uniform2f(fiWarpTexelLoc, 1 / fiLumaW, 1 / fiLumaH);
    gl.uniform2f(fiWarpGridLoc, fiLastMatch.gridW, fiLastMatch.gridH);
    gl.uniform1f(fiWarpPhaseLoc, phase);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  } else {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return false;
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return true;
}

function fiAfterVideoUpload(video) {
  if (!settings.fiInfra || !gl ||
      (scrolling && settings.interaction !== "quality")) return false;
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) return false;
  fiEnsureFrameTextures(w, h);

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
  fiPairSerial++;
  if (!["analytic","ifrnet"].includes(fiGpuEngine?.kind)) fiUpdateLumaSample(video);
  return fiRequestGpuPair();
}

function fiScheduleMidFrame(pairSerial, metadata) {
  cancelFiMid();
  if (!canRender()) return;
  const fps = metricReport.videoFps > 0 ? metricReport.videoFps : 30;
  const rate = currentVideo && Number(currentVideo.playbackRate) > 0
    ? Number(currentVideo.playbackRate)
    : 1;
  const duration = Math.max(8, Math.min(250,
    lastVideoFrameDurationMs > 0 ? lastVideoFrameDurationMs : 1000 / (fps * rate)));
  const expected = metadata ? Number(metadata.expectedDisplayTime) : NaN;
  const anchorTime = Number.isFinite(expected) ? expected : performance.now();

  const present = (now) => {
    fiMidRaf = null;
    if (!canRender() || !settings.fiInfra) return;
    if (pairSerial !== fiPairSerial || !fiHasCurr) return;
    fiDisplayReference = now;
    if (["neural","ifrnet"].includes(fiGpuEngine?.kind)) {
      const slot = fiNeuralTarget;
      if (!slot || now > slot.expires) { fiSkipReason = "Neural presentation slot expired; keeping the anchor."; return; }
      if (now < slot.time - .5 || fiMethod === "pending") { fiMidRaf = requestAnimationFrame(present); return; }
      if (!["neural","ifrnet"].includes(fiMethod) || fiGpuReadySerial !== pairSerial || !fiNeuralResult) return;
      // Display precisely the phase that was inferred; do not relabel a cached
      // midpoint as a later phase to inflate the output frame rate.
      try { draw({ fiMid: true, fiPhase: slot.phase }); }
      catch (error) { fiUseClassicFallback(fiGpuEngine, error); }
      return;
    }
    const phase = typeof fiPresentationPhase === "function"
      ? fiPresentationPhase(now, anchorTime, duration)
      : Math.max(0, Math.min(1, (now - anchorTime) / duration));
    // ponytail: cap FI at 2x; revisit display-rate fan-out only with a GPU-native matcher.
    if (phase < 0.35) {
      fiMidRaf = requestAnimationFrame(present);
      return;
    }
    if (phase >= 1) return;
    if (fiMethod === "pending") {
      fiMidRaf = requestAnimationFrame(present);
      return;
    }
    if (!["webgpu","analytic"].includes(fiMethod) || fiGpuReadySerial !== pairSerial) return;
    const estimatedCost = Math.max(
      fiMidCpuMs,
      metricReport.gpuMs || 0,
    );
    const fits = typeof fiMidFitsDeadline === "function"
      ? fiMidFitsDeadline(phase, duration, estimatedCost, 1)
      : duration * (1 - phase) >= estimatedCost + 2;
    if (!fits) {
      fiSkipReason =
        `Late midpoint cancelled (${(duration * (1 - phase)).toFixed(1)} ms remaining).`;
      return;
    }
    try {
      draw({ fiMid: true, fiPhase: phase });
    } catch (err) {
      log("FI mid draw failed:", err);
    }
  };
  fiMidRaf = requestAnimationFrame(present);
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
  // ponytail: position:absolute inside the video container (attachCanvasTo puts
  // the canvas immediately after <video>). z-index is intentionally omitted:
  // DOM order draws it above the video while later controls remain above it.
  canvas.style.cssText =
    "position:absolute;left:0;top:0;width:0;height:0;pointer-events:none;contain:layout paint size;";
  // Parenting happens in attachCanvasTo once the video is known.
  // Keep the original video painted beneath the opaque canvas: changing its
  // opacity can suppress frame delivery and makes native recovery unreliable.

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
    lastError = "WebGL2 unavailable";
    log("WebGL2 is unavailable in this Firefox/hardware configuration");
    return false;
  }
  timerExt = gl.getExtension("EXT_disjoint_timer_query_webgl2");
  timerExtChecked = true;
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
  warmFiPrograms();
  return true;
}

function compile(type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    log("shader compilation error:", gl.getShaderInfoLog(s));
    gl.deleteShader(s);
    return null;
  }
  return s;
}

function linkProgram(vertexSource, fragmentSource) {
  const vs = compile(gl.VERTEX_SHADER, vertexSource);
  const fs = compile(gl.FRAGMENT_SHADER, fragmentSource);
  if (!vs || !fs) {
    lastError = "Shader compilation failed";
    return null;
  }
  const linked = gl.createProgram();
  gl.attachShader(linked, vs);
  gl.attachShader(linked, fs);
  gl.linkProgram(linked);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(linked, gl.LINK_STATUS)) {
    lastError = gl.getProgramInfoLog(linked) || "Shader linking failed";
    log("program linking failed:", lastError);
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
  ravuShadersPromise = fetch(ext.runtime.getURL("third_party/ravu-lite/ravu-lite-webgl2.js"))
    .then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.text();
    })
    .then((source) => {
      ravuStepProgram = linkProgram(VERT, extractRavuShader(source, "step1"));
      ravuComposeProgram = linkProgram(VERT_PLAIN, extractRavuShader(source, "compose"));
      if (!ravuStepProgram || !ravuComposeProgram) {
        throw new Error(lastError || "RAVU-lite shader compilation failed");
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
      log("failed to load RAVU-lite shaders:", error);
      return false;
    });
  return ravuShadersPromise;
}

function loadRavuLut() {
  if (ravuLutReady) return Promise.resolve(true);
  if (ravuLutPromise) return ravuLutPromise;
  ravuLutPromise = fetch(ext.runtime.getURL("third_party/ravu-lite/ravu-lite-lut3.bin"))
    .then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.arrayBuffer();
    })
    .then((buffer) => {
      if (buffer.byteLength !== 59904) {
        throw new Error(`LUT has ${buffer.byteLength} bytes; expected 59904`);
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
      log("RAVU-lite LUT loaded");
      return true;
    })
    .catch((error) => {
      ravuLutError = `RAVU-lite: ${error.message || error}`;
      lastError = ravuLutError;
      log("failed to load RAVU-lite LUT:", error);
      return false;
    });
  return ravuLutPromise;
}

function loadRavuAssets() {
  return Promise.all([loadRavuShaders(), loadRavuLut()])
    .then(([shaders, lut]) => shaders && lut);
}

function invalidateRavuRetry() {
  ravuRetryGeneration++;
  ravuPendingCaptureVideo = null;
  ravuRetryPromise = null;
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
    lastError = "Incomplete intermediate framebuffer";
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
    lastError = "Incomplete RAVU-lite framebuffer";
    return false;
  }
  ravuWidth = width;
  ravuHeight = height;
  return true;
}

function attachCanvasTo(video) {
  if (!canvas || !video.parentElement) return;
  if (canvas.parentNode !== video.parentElement) {
    // ponytail: insert immediately AFTER video => above its paint, below controls.
    video.parentElement.insertBefore(canvas, video.nextSibling);
  }
  ensureCompareLabels();
}

function deactivateRenderer() {
  fiReleaseGpu();
  cancelScheduledFrame();
  cancelFiMid();
  invalidateRavuRetry();
  resetFiPairState();
  resetVideoFrameHistory();
  detachActivePageListeners();
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
  activePipeline = "disabled";
  status = "off";
  lastError = "";
  resetMetricWindow(performance.now());
}

function activateRenderer(captureFrame = false) {
  if (!currentVideo || settings.mode === "off") return false;
  if (!canvas && !createOverlay()) return false;
  attachCanvasTo(currentVideo);
  attachActivePageListeners();
  layoutDirty = true;
  updateCanvasVisibility();
  draw({ newVideoFrame: captureFrame });
  schedule();
  return true;
}

function syncLayout() {
  if (stopped || !currentVideo || !canvas || !canvas.parentNode) return;
  if (!layoutDirty) return;
  const parent = currentVideo.parentElement;
  const vRect = currentVideo.getBoundingClientRect();
  const pRect = parent.getBoundingClientRect();
  // Coordinates relative to the positioned container (usually position:relative).
  const left = vRect.left - pRect.left;
  const top = vRect.top - pRect.top;

  // ponytail: cap at DPR 2 — resolving 4K into a 900px canvas is wasteful.
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
      log("internal scale", Math.round(cap * 100) + "% — pixel budget");
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
  const drawKind = frameDrawKind(options);
  if (drawKind === "capture" && currentVideo.readyState < 2) {
    status = "buffering";
    resetFiPairState();
    updateCanvasVisibility();
    return;
  }
  const isFiMid = drawKind === "mid";
  // Never let a pending mid fire across a new real frame (stale/janky).
  if (drawKind === "capture") cancelFiMid();
  cpuFrame = (cpuFrame + 1) % 15;
  const measureCpu = drawKind === "capture" || isFiMid || cpuFrame === 0 || !metricWindow;
  const cpuStart = measureCpu ? performance.now() : 0;
  syncLayout();
  if (canvas.width === 0 || canvas.height === 0) return;
  if (currentVideo.videoWidth === 0 || currentVideo.videoHeight === 0) return;
  if (drawKind === "redraw" && (!textureWidth || !textureHeight)) return;
  if (drawKind === "redraw" &&
      (textureWidth !== currentVideo.videoWidth || textureHeight !== currentVideo.videoHeight)) return;
  if (settings.mode === "ravu" &&
      shouldUseRavu(
        currentVideo.videoWidth, currentVideo.videoHeight, canvas.width, canvas.height,
        settings.quality,
      ) && (!ravuLutReady || !ravuStepProgram || !ravuComposeProgram)) {
    const ravuError = ravuShaderError || ravuLutError;
    activePipeline = ravuError ? "RAVU-lite unavailable" : "RAVU-lite loading";
    updateCanvasDataset(activePipeline, ravuError);
    if (ravuError) {
      invalidateRavuRetry();
      // Missing/broken assets: do not leave a black canvas covering the video.
      status = "error";
      lastError = ravuError;
      updateCanvasVisibility();
      removeCompareLabels();
      cancelScheduledFrame();
      cancelFiMid();
    } else {
      if (drawKind === "capture") ravuPendingCaptureVideo = currentVideo;
      if (!ravuRetryPromise) {
        const generation = ravuRetryGeneration;
        ravuRetryPromise = loadRavuAssets()
          .then((ready) => {
            if (generation !== ravuRetryGeneration) return;
            const captureVideo = ravuPendingCaptureVideo;
            ravuPendingCaptureVideo = null;
            if (ready && settings.mode === "ravu" && currentVideo) {
              updateCanvasVisibility();
              draw({ newVideoFrame: captureVideo === currentVideo });
            } else if (!ready && settings.mode === "ravu") {
              draw();
            }
          })
          .catch((error) => {
            if (generation !== ravuRetryGeneration) return;
            ravuShaderError = `RAVU-lite: ${error.message || error}`;
            lastError = ravuShaderError;
            log("unexpected RAVU-lite coordinator failure:", error);
          })
          .finally(() => {
            if (generation !== ravuRetryGeneration) return;
            ravuPendingCaptureVideo = null;
            ravuRetryPromise = null;
          });
      }
    }
    return;
  }

  gl.bindVertexArray(vao);
  pollGpuTimers();
  let gpuQuery = null;
  gpuFrame = (gpuFrame + 1) % 15;
  const gpuTimingNow = measureCpu ? cpuStart : performance.now();
  if (timerExt && gpuFrame === 0 && gpuQueries.length < 2 &&
      (settings.fiInfra || settings.quality === "auto" || gpuTimingNow < gpuTimingUntil)) {
    gpuQuery = gl.createQuery();
    gl.beginQuery(timerExt.TIME_ELAPSED_EXT, gpuQuery);
  }

  let sourceTex = texture;
  let fiTag = "";
  let presentingFiMid = isFiMid;
  let presentation = "current";
  let srcW = drawKind === "capture" ? currentVideo.videoWidth : textureWidth;
  let srcH = drawKind === "capture" ? currentVideo.videoHeight : textureHeight;

  if (isFiMid) {
    if (!fiRenderMidToOut(Number.isFinite(options.fiPhase) ? options.fiPhase : 0.5)) {
      if (gpuQuery) {
        gl.endQuery(timerExt.TIME_ELAPSED_EXT);
        gl.deleteQuery(gpuQuery);
      }
      return;
    }
    sourceTex = fiOutTexture;
    fiTag = ` · FI ${fiMethod}`;
    presentation = "mid";
  } else if (drawKind === "capture") {
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
        lastError = e.message || "CORS blocked the frame";
        log("CORS blocked access to the frame:", e.message);
      } else {
        status = "error";
        lastError = String(e && (e.message || e));
        log("texImage2D failed unexpectedly:", e);
      }
      // Upload failures during source changes must not permanently stop discovery.
      if (status === "tainted") blockedVideo = currentVideo;
      resetFiPairState();
      updateCanvasVisibility();
      if (blockedVideo === currentVideo) cancelScheduledFrame();
      return;
    }
    if (settings.fiInfra) {
      let gpuPairPending = false;
      try {
        const expected = Number(options.videoMetadata?.expectedDisplayTime);
        fiPairAnchorTime = Number.isFinite(expected) ? expected : performance.now();
        gpuPairPending = fiAfterVideoUpload(currentVideo);
      } catch (err) {
        log("FI pair update failed:", err);
        fiMethod = "skip";
      }
      const useLatency = fiHasPrev && fiHasCurr && !currentVideo.paused && !currentVideo.ended &&
        (fiLatencyActive || gpuPairPending);
      if (useLatency) {
        fiLatencyActive = true;
        sourceTex = fiPrevTexture;
        srcW = textureWidth;
        srcH = textureHeight;
        fiTag = " · FI anchor";
        presentation = "anchor";
        if (fiMethod === "pending" || fiShouldPresentMid()) {
          fiScheduleMidFrame(fiPairSerial, options.videoMetadata);
        }
      } else if (fiLatencyActive) {
        fiLatencyActive = false;
      }
    } else {
      cancelFiMid();
      fiMethod = "skip";
    }
  } else if (options.nativeCurrent) {
    fiLatencyActive = false;
  } else if (fiLastPresentation === "mid" && fiOutTexture && fiHasPrev && fiHasCurr) {
    sourceTex = fiOutTexture;
    fiTag = ` · FI ${fiMethod}`;
    presentation = "mid";
  } else if (fiLatencyActive && fiHasPrev && fiHasCurr) {
    sourceTex = fiPrevTexture;
    fiTag = " · FI anchor";
    presentation = "anchor";
  }

  if (!srcW || !srcH) return;
  // Optional same-context inference can bind its private VAO. Rebind the
  // upscaler VAO after all capture/synthesis paths, not only at draw entry.
  gl.bindVertexArray(vao);

  if (settings.mode === "ravu" &&
      shouldUseRavu(srcW, srcH, canvas.width, canvas.height, settings.quality)) {
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
    gl.viewport(0, 0, srcW, srcH);
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
      srcW, srcH,
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
  } else if (settings.mode === "native") {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.useProgram(program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, sourceTex);
    setDirectUniforms(
      1 / srcW, 1 / srcH,
      0, settings.compare ? 1 : 0,
    );
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    activePipeline = "Native";
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
      activePipeline = settings.mode === "ravu"
        ? "RCAS (RAVU skipped: economy profile + output ≤ source)"
        : "RCAS";
    }
  }
  if (settings.compare) {
    // Bypass the entire spatial chain on the left. For FI mids retain the
    // matching delayed source anchor, not the live video on a different clock.
    const original = presentation === "mid" && fiHasPrev ? fiPrevTexture : sourceTex;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(0, 0, Math.ceil(canvas.width / 2), canvas.height);
    gl.useProgram(program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, original);
    setDirectUniforms(1 / srcW, 1 / srcH, 0, 1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disable(gl.SCISSOR_TEST);
  }
  activePipeline += fiTag;
  if (gpuQuery) {
    gl.endQuery(timerExt.TIME_ELAPSED_EXT);
    gpuQueries.push(gpuQuery);
  }
  updateCanvasDataset(activePipeline, "");
  fiLastPresentation = presentation;
  const cpuMs = measureCpu ? performance.now() - cpuStart : null;
  if (isFiMid && cpuMs != null) fiMidCpuMs = fiMidCpuMs * .75 + cpuMs * .25;
  if (drawKind !== "redraw") recordDraw(cpuMs, presentingFiMid);
  if (drawKind === "capture") {
    if (cpuMs != null) fiLastRealCpuMs = cpuMs;
    else if (metricReport.cpuMs > 0) fiLastRealCpuMs = metricReport.cpuMs;
  }

  if (status !== "ok") {
    status = "ok";
    lastError = "";
    log("rendering", activePipeline, settings.strength + "% over <video>",
        currentVideo.clientWidth + "x" + currentVideo.clientHeight);
  }
  updateCanvasVisibility();
}

// --------------------------------------------------------------------------
// Loop de frames
// --------------------------------------------------------------------------

function onFrame(now, metadata) {
  if (frameWatchdog !== null) clearTimeout(frameWatchdog);
  frameWatchdog = null;
  rafId = null;
  scheduledKind = null;
  if (stopped) return;
  const freshFrame = recordVideoFrame(now, metadata);
  fiPairDiscontinuous = fiResumeGap;
  if (fiResumeGap) {
    fiSkipReason = "Missing frame or timing gap — holding the delayed anchor.";
  }
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
  schedule();
  if (freshFrame) draw({ newVideoFrame: true, videoMetadata: metadata });
  if (freshFrame) {
    lastFreshFrameTime = now;
  } else if (!currentVideo.paused && !currentVideo.ended && lastFreshFrameTime !== null &&
      now - lastFreshFrameTime > Math.max(500, lastVideoFrameDurationMs * 4)) {
    // rAF can keep firing even when the decoder stops delivering new frames.
    status = "buffering";
    resetFiPairState();
    updateCanvasVisibility();
  }
}

function frameSchedulerKind(fiEnabled, hasVideoFrameCallback) {
  return fiEnabled && hasVideoFrameCallback ? "video" : "animation";
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
  if (frameSchedulerKind(settings.fiInfra,
      !useAnimationFallback && typeof currentVideo.requestVideoFrameCallback === "function") === "video") {
    scheduledKind = "video";
    rafId = currentVideo.requestVideoFrameCallback(onFrame);
    const video = currentVideo;
    frameWatchdog = setTimeout(() => {
      frameWatchdog = null;
      if (video !== currentVideo || video.paused || video.ended || !canRender()) return;
      cancelScheduledFrame(video);
      useAnimationFallback = true;
      resetVideoFrameHistory();
      resetFiPairState();
      status = "buffering";
      updateCanvasVisibility();
      schedule();
    }, Math.max(500, lastVideoFrameDurationMs * 4));
  } else {
    scheduledKind = "animation";
    rafId = requestAnimationFrame(onFrame);
  }
}

function cancelScheduledFrame(video = currentVideo) {
  if (frameWatchdog !== null) clearTimeout(frameWatchdog);
  frameWatchdog = null;
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
  // Reposition the canvas while paused too (theater/resize without a new frame).
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
  if (document.hidden) {
    cancelScheduledFrame();
    resetFiPairState();
    resetVideoFrameHistory();
  }
  else {
    if (settings.fiInfra) fiMeasureDisplay();
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

function handleVideoReset(event) {
  if (!currentVideo || event.target !== currentVideo) return;
  cancelScheduledFrame();
  invalidateRavuRetry();
  resetFiPairState();
  resetVideoFrameHistory();
  useAnimationFallback = false;
  if (event.type === "emptied" || event.type === "loadedmetadata") {
    blockedVideo = null;
    textureWidth = 0;
    textureHeight = 0;
    metricReport.videoFps = 0;
  }
  status = "buffering";
  updateCanvasVisibility();
  scheduleRescan();
  schedule();
}

function handleStillFrame(event) {
  if (!currentVideo || !event || event.target !== currentVideo) return;
  resetFiPairState();
  resetVideoFrameHistory();
  if (currentVideo.readyState >= 2) draw({ newVideoFrame: true });
  schedule();
}

function attachDiscoveryListeners() {
  if (discoveryListeners) return;
  discoveryListeners = true;
  for (const type of ["emptied", "loadedmetadata", "seeking", "playing", "ratechange"]) {
    document.addEventListener(type, handleVideoReset, true);
  }
  // Native events discover new videos in SPAs without scanning the page in a loop.
  document.addEventListener("play", handleVideoDiscovery, true);
  document.addEventListener("loadedmetadata", handleVideoDiscovery, true);
  document.addEventListener("emptied", handleVideoDiscovery, true);
  // rVFC does not fire while paused: capture on pause/end/current-time changes.
  document.addEventListener("pause", handleStillFrame, true);
  document.addEventListener("ended", handleStillFrame, true);
  document.addEventListener("seeked", handleStillFrame, true);
  document.addEventListener("loadeddata", handleStillFrame, true);
}

function detachDiscoveryListeners() {
  if (!discoveryListeners) return;
  discoveryListeners = false;
  for (const type of ["emptied", "loadedmetadata", "seeking", "playing", "ratechange"]) {
    document.removeEventListener(type, handleVideoReset, true);
  }
  document.removeEventListener("play", handleVideoDiscovery, true);
  document.removeEventListener("loadedmetadata", handleVideoDiscovery, true);
  document.removeEventListener("emptied", handleVideoDiscovery, true);
  document.removeEventListener("pause", handleStillFrame, true);
  document.removeEventListener("ended", handleStillFrame, true);
  document.removeEventListener("seeked", handleStillFrame, true);
  document.removeEventListener("loadeddata", handleStillFrame, true);
}

// --------------------------------------------------------------------------
// Video selection
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
  resetFiPairState();
  resetVideoFrameHistory();
  updateCanvasVisibility();
  if (visible) {
    schedule();
    draw({ newVideoFrame: true });
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
    if (videoResizeObserver) videoResizeObserver.disconnect();
    if (videoIntersectionObserver) videoIntersectionObserver.disconnect();
    detachActivePageListeners();
    currentVideo = null;
    if (status !== "no-video") {
      status = "no-video";
      log("no <video> on the page");
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
    ravuPendingCaptureVideo = null;
    resetVideoFrameHistory();
    if (settings.quality === "auto") {
      renderScale = 1;
      stableWindows = 0;
    }
    currentVideo = next;
    blockedVideo = null;
    useAnimationFallback = false;
    status = "idle";
    textureWidth = 0;
    textureHeight = 0;
    resetFiPairState();
    metricReport.videoFps = 0;
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
    log("selected video:", next.clientWidth + "x", next.clientHeight,
        next.videoWidth ? "(src " + next.videoWidth + "x" + next.videoHeight + ")" : "");
    if (settings.mode !== "off" && !activateRenderer(true)) return;
  }
  if (currentVideo && layoutDirty) syncLayout();
  if (currentVideo && currentVideo.paused && currentVideo.readyState >= 2) draw();
  schedule();
}

function hideCanvas() {
  if (canvas) {
    canvas.style.width = "0";
    canvas.style.height = "0";
  }
}

function applySettings(value) {
  const previous = settings;
  settings = normalizeSettings(value);
  const engineChanged = settings.fiEngine !== previous.fiEngine ||
    settings.fiProfile !== previous.fiProfile || settings.fiNeuralRevision !== previous.fiNeuralRevision || settings.fiModelRevision !== previous.fiModelRevision;
  if (engineChanged) {fiAnalyticStep=0;fiAnalyticSlow=0;fiAnalyticRetryAt=0;globalThis.VENeuralClient?.clear();}
  if ((!settings.fiInfra && previous.fiInfra) || engineChanged) fiReleaseGpu();
  const modeChanged = settings.mode !== previous.mode;
  const qualityChanged = settings.quality !== previous.quality;
  const visualChanged = settings.strength !== previous.strength ||
    settings.compare !== previous.compare;
  const outlineChanged = settings.outline !== previous.outline;
  const compareChanged = settings.compare !== previous.compare;
  const interactionChanged = settings.interaction !== previous.interaction;
  const fiChanged =
    engineChanged || settings.fiDebug !== previous.fiDebug ||
    settings.fiInfra !== previous.fiInfra ||
    settings.fiSceneCut !== previous.fiSceneCut ||
    settings.fiHalfLuma !== previous.fiHalfLuma ||
    settings.fiBlockMatch !== previous.fiBlockMatch ||
    settings.fiFallback !== previous.fiFallback;

  if (previous.mode === "ravu" && settings.mode !== "ravu") invalidateRavuRetry();

  if (settings.mode === "off") {
    detachDiscoveryListeners();
    deactivateRenderer();
    return;
  }
  if (previous.mode === "off") overlayVisible = true;
  attachDiscoveryListeners();
  if (settings.quality !== "auto" && qualityChanged) {
    const scales = { high: 1, balanced: 0.75, performance: 0.5 };
    setRenderScale(scales[settings.quality]);
  } else if (settings.quality === "auto" && previous.quality !== "auto") {
    stableWindows = 0;
    setRenderScale(1, "— automatic mode reset");
  }
  if (fiChanged) {
    fiGpuSampleScale = 1;
    fiGpuSlowPairs = 0;
    resetFiPairState();
  }
  if (settings.fiInfra) { warmFiPrograms(); fiWarmGpu(); }
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
  ext.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    const next = { ...settings };
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (changes[key]) next[key] = changes[key].newValue;
    }
    applySettings(next);
  });
  return ext.storage.local.get(DEFAULT_SETTINGS)
    .then(applySettings)
    .catch((error) => {
      log("could not load preferences:", error);
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
    scheduler: currentVideo && frameSchedulerKind(
      settings.fiInfra,
      !useAnimationFallback && typeof currentVideo.requestVideoFrameCallback === "function") === "video"
      ? "video frame"
      : "display refresh",
    settings: { ...settings },
    metrics: { ...metricReport, gpuSupported: Boolean(timerExt) },
    fi: {
      presentationDelayMs: fiLatencyActive ? lastVideoFrameDurationMs : 0,
      backend: fiGpuState === "ready" ? ({neural:"Framegen compact neural (WebGPU)",ifrnet:"IFRNet-S neural (WebGL2)",analytic:"Analytic Flow (WebGL2; no neural weights)",classic:"Legacy LK (WebGPU)"}[fiGpuEngine?.kind]||"Preparing") : fiGpuState,
      requestedEngine: settings.fiEngine,
      actualEngine: fiGpuEngine?.kind || "none",
      fallbackReason: fiNeuralFailure,
      profile: settings.fiProfile,
      edition: globalThis.VE_BUILD?.flavor || "personal",
      analytic: fiGpuEngine?.kind === "analytic" ? {...fiGpuEngine.stats, late:fiAnalyticLate, step:fiAnalyticStep, cooldownMs:Math.max(0,fiAnalyticRetryAt-now)} : null,
      neural: ["neural","ifrnet"].includes(fiGpuEngine?.kind) ? { ...fiGpuEngine.stats, modelSize: fiGpuEngine.modelSize, debug: settings.fiDebug } : null,
      computeMs: fiGpuElapsedMs,
      backendError: fiGpuError,
      method: fiMethod,
      confidence: ["neural","ifrnet"].includes(fiGpuEngine?.kind) ? null : fiConfidence,
      videoFps: metricReport.videoFps || 0,
      sceneCutHold: fiSceneCutHold,
      hasPair: fiHasPrev && fiHasCurr,
      halfLuma: Boolean(settings.fiHalfLuma),
      sample: fiGpuEngine?.kind === "analytic" ? `${fiGpuEngine.dimensions.width}×${fiGpuEngine.dimensions.height} dense flow` : fiLumaW && fiLumaH ? `${fiLumaW}×${fiLumaH}` : "—",
      midPerSec: fiMidPerSec,
      realPerSec: fiRealPerSec,
      explain: fiSkipReason || fiGpuError || fiExplainStatus(),
    },
  };
}

function toggleOverlay() {
  if (settings.mode === "off") return snapshot();
  overlayVisible = !overlayVisible;
  resetMetricWindow(performance.now());
  resetFiPairState();
  resetVideoFrameHistory();
  updateCanvasVisibility();
  if (overlayVisible) {
    attachActivePageListeners();
    schedule();
    if (currentVideo) draw({ newVideoFrame: true });
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
    resetFiPairState();
    resetVideoFrameHistory();
    updateCanvasVisibility();
    schedule();
  }
  scrollResumeTimer = setTimeout(() => {
    scrollResumeTimer = null;
    scrolling = false;
    layoutDirty = true;
    resetFiPairState();
    resetVideoFrameHistory();
    resetMetricWindow(performance.now());
    updateCanvasVisibility();
    schedule();
  }, INTERACTION_PAUSE_MS);
}

function stop() {
  fiReleaseGpu();
  stopped = true;
  cancelScheduledFrame();
  cancelFiMid();
  resetFiPairState();
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

  // Avoid duplication if the extension is manually injected more than once.
  if (window.__fvEnhancerLoaded) {
    log("already loaded on this page — ignoring reinjection");
    return;
  }
  window.__fvEnhancerLoaded = true;

  ext.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message && message.type === "fv-status") sendResponse(snapshot());
    if (message && message.type === "fv-toggle") sendResponse(toggleOverlay());
    if (message && message.type === "fv-settings") {
      applySettings({ ...settings, ...message.settings });
      sendResponse(snapshot());
    }
  });

  loadSettings().finally(() => {
    if (settings.mode !== "off") attachDiscoveryListeners();
    rescan();
  });

  log("inicializado em", location.href);
}

// --------------------------------------------------------------------------
// Self-check (runs only outside the browser, e.g. `node content.js`)
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
  if (pickA !== a[1]) throw new Error("selfCheck: expected the playing 1280x720 video");

  const b = [fake(2000, 2000, true), fake(500, 500, false)];
  const pickB = pickLargestVideo(b, 3000, 3000);
  if (pickB !== b[0]) throw new Error("selfCheck: the 0.3x weight broke the expected rule");

  const c = [fake(5000, 5000, false)];
  const pickC = pickLargestVideo(c, 1920, 1080);
  if (pickC !== c[0]) throw new Error("selfCheck: clipped visible area failed");

  const d = [fake(2000, 2000, false, 4, -3000, 0), fake(320, 180, false)];
  const pickD = pickLargestVideo(d, 1920, 1080);
  if (pickD !== d[1]) throw new Error("selfCheck: an off-screen video was selected");

  const normalized = normalizeSettings({
    mode: "invalid", strength: 150.4, outline: 1, compare: 1, quality: "invalid",
    interaction: "invalid",
  });
  if (normalized.mode !== "off" || normalized.strength !== 100 ||
      normalized.outline || normalized.compare || normalized.quality !== "high" ||
      normalized.interaction !== "smooth") {
    throw new Error("selfCheck: preference normalization failed");
  }
  if (normalizeSettings({ mode: "passthrough" }).mode !== "off" ||
      normalizeSettings({ mode: "ravu" }).mode !== "ravu" ||
      normalizeSettings({ mode: "native" }).mode !== "native" ||
      normalizeSettings({ interaction: "balanced" }).interaction !== "balanced") {
    throw new Error("selfCheck: passthrough or RAVU mode migration failed");
  }

  settings = normalizeSettings({ interaction: "balanced" });
  scrolling = true;
  renderScale = 1;
  if (effectiveRenderScale() !== 0.5) {
    throw new Error("selfCheck: Balanced profile did not reduce scale during navigation");
  }
  scrolling = false;
  settings = normalizeSettings(DEFAULT_SETTINGS);
  if (settings.fiInfra !== false || settings.fiSceneCut !== true) {
    throw new Error("selfCheck: defaults FI incorretos");
  }
  const fiSample = fiLumaSampleSize(1920, 1080, true);
  const fiDetailedSample = fiLumaSampleSize(1920, 1080, false);
  if (fiSample.width > FiQuality.profile(settings.fiProfile).motionW || fiSample.height > FiQuality.profile(settings.fiProfile).motionH) {
    throw new Error("selfCheck: amostra FI grande demais");
  }
  if (fiDetailedSample.width <= fiSample.width || fiDetailedSample.height <= fiSample.height) {
    throw new Error("selfCheck: lightweight FI option must be smaller than detailed FI");
  }
  if (typeof fiSelfCheck === "function") fiSelfCheck();
  // Shipped warp shader must use ME-correct sampling (not inverted).
  if (!FI_WARP_FRAG.includes("v_uv - forwardMv * t * u_texel") ||
      !FI_WARP_FRAG.includes("v_uv - backwardMv * (1.0 - t) * u_texel") ||
      /fromPrev = v_uv \+ forwardMv \* t/.test(FI_WARP_FRAG)) {
    throw new Error("selfCheck: FI_WARP_FRAG motion sampling direction wrong");
  }
  if (EASU_FRAG.includes("settings.mode") || EASU_FRAG.includes("gl.bindFramebuffer")) {
    throw new Error("selfCheck: JS code leaked into the EASU shader");
  }
  if (FI_WARP_FRAG.includes("floor(v_uv * u_mv_grid)") ||
      !FI_WARP_FRAG.includes("packedForward.a") ||
      !FI_WARP_FRAG.includes("packedBackward.a") ||
      FI_WARP_FRAG.includes("/ 4.0) * forwardConfidence") ||
      !String(fiUploadMvTexture).includes("gl.LINEAR")) {
    throw new Error("selfCheck: FI artifact guard missing");
  }
  // Occlusion-aware selection must stay: averaging inconsistent endpoints is
  // what produced double-edge ghosting.
  if (!FI_WARP_FRAG.includes("length(forwardMv + backwardMv)") ||
      !FI_WARP_FRAG.includes("smoothstep(0.025, 0.12, length(a - b))") ||
      !FI_WARP_FRAG.includes("vec3 near = wa >= wb ? a : b") ||
      !FI_WARP_FRAG.includes("mix(warped, near, pick)")) {
    throw new Error("selfCheck: FI occlusion-aware endpoint selection missing");
  }
  // MV textures must stay half-float; 8-bit packing quantized motion to 0.25 px.
  if (!String(fiUploadMvTexture).includes("gl.RGBA16F") ||
      !String(fiUploadMvTexture).includes("gl.HALF_FLOAT") ||
      String(fiUploadMvTexture).includes("* 4 + 128")) {
    throw new Error("selfCheck: FI MV texture must be half-float, not 8-bit");
  }
  // Round-trip sanity for the float→half converter on motion-scale values.
  {
    const halfRound = (value) => {
      const half = fiFloatToHalf(value);
      const sign = half & 0x8000 ? -1 : 1;
      const exponent = (half >> 10) & 0x1f;
      const mantissa = half & 0x3ff;
      if (exponent === 0) return sign * mantissa * Math.pow(2, -24);
      if (exponent === 31) return sign * Infinity;
      return sign * (1 + mantissa / 1024) * Math.pow(2, exponent - 15);
    };
    for (const value of [0, 0.125, 0.5, 1, -3.75, 12.5, 47.9375]) {
      if (Math.abs(halfRound(value) - value) > Math.abs(value) * 0.001 + 1e-4) {
        throw new Error("selfCheck: fiFloatToHalf lost motion-scale precision: " + value);
      }
    }
    if (Number.isFinite(halfRound(1e30))) {
      throw new Error("selfCheck: fiFloatToHalf must overflow to infinity, not wrap");
    }
  }
  if (!String(fiRenderMidToOut).includes("1 / fiLumaW") ||
      String(fiComputeDecision).includes("videoWidth / fiLumaW") ||
      !String(fiComputeDecision).includes("fiBidirectionalConsistency") ||
      !String(fiRenderMidToOut).includes("fiBackwardMvTexture")) {
    throw new Error("selfCheck: FI motion must stay in luma-grid coordinates");
  }
  // FBO separation: copy binds fiCopyFb; mid path re-binds out target every time.
  const copySrc = String(fiCopyTexture);
  if (!copySrc.includes("fiCopyFb") ||
      !/bindFramebuffer\(\s*gl\.FRAMEBUFFER\s*,\s*fiCopyFb\s*\)/.test(copySrc) ||
      /bindFramebuffer\(\s*gl\.FRAMEBUFFER\s*,\s*fiOutFb\s*\)/.test(copySrc) ||
      copySrc.includes("texImage2D")) {
    throw new Error("selfCheck: fiCopyTexture must bind fiCopyFb, not fiOutFb");
  }
  if (!String(fiEnsureFrameTextures).includes("fiTextureW === w") ||
      !String(fiEnsureFrameTextures).includes("texImage2D")) {
    throw new Error("selfCheck: FI frame textures must allocate only on resize");
  }
  if (!String(fiEnsureOut).includes("fiBindOutTarget") ||
      !String(fiRenderMidToOut).includes("fiBindOutTarget")) {
    throw new Error("selfCheck: mid-out path must re-bind fiOutTexture via fiBindOutTarget");
  }
  if (String(fiShouldPresentMid).includes('settings.mode === "ravu"')) {
    throw new Error("selfCheck: FI must not block RAVU by mode");
  }
  if (!String(fiScheduleMidFrame).includes("fiMid: true") ||
      !String(fiScheduleMidFrame).includes("requestAnimationFrame") ||
      !String(fiScheduleMidFrame).includes("fiPresentationPhase") ||
      !String(fiScheduleMidFrame).includes("phase < 0.35") ||
      String(fiScheduleMidFrame).includes("if (pairSerial === fiPairSerial) fiMidRaf") ||
      !String(draw).includes("options.fiPhase") ||
      !String(draw).includes("FI anchor") ||
      String(draw).includes("fiLight")) {
    throw new Error("selfCheck: FI must use one-frame latency and the full pipeline");
  }
  if (Math.abs(fiPresentationPhase(116, 100, 40) - 0.4) > 1e-6 ||
      fiPresentationPhase(99, 100, 40) !== 0 ||
      fiPresentationPhase(140, 100, 40) !== 1) {
    throw new Error("selfCheck: FI display phase is not tied to video time");
  }
  if (Math.abs(fiFrameDurationMs(50, 1 / 24, 1) - 1000 / 24) > 1e-6 ||
      Math.abs(fiFrameDurationMs(33.4, NaN, 1) - 33.4) > 1e-6 ||
      Math.abs(fiFrameDurationMs(NaN, 0.04, 2) - 20) > 1e-6 ||
      Math.abs(fiFrameDurationMs(NaN, 0.04, 1) - 40) > 1e-6 ||
      fiMidBudgetMs(40, 50) !== 20 || fiMidBudgetMs(0, 50) !== 10 ||
      fiIsTimingGap(249, 1000 / 30) || !fiIsTimingGap(251, 1000 / 30)) {
    throw new Error("selfCheck: FI wall-clock duration/gap calculation failed");
  }
  if (frameDrawKind({}) !== "redraw" ||
      frameDrawKind({ newVideoFrame: true }) !== "capture" ||
      frameDrawKind({ newVideoFrame: true, fiMid: true }) !== "mid") {
    throw new Error("selfCheck: draw kind classification failed");
  }
  const drawSrc = String(draw);
  const ravuAssetGate = drawSrc.indexOf('if (settings.mode === "ravu" &&');
  const ravuAssetLoad = drawSrc.indexOf("loadRavuAssets()", ravuAssetGate);
  if (ravuAssetGate < 0 || ravuAssetLoad < 0 ||
      !drawSrc.slice(ravuAssetGate, ravuAssetLoad).includes("shouldUseRavu(")) {
    throw new Error("selfCheck: RAVU downscale must not load assets");
  }
  if (!String(createOverlay).includes("EXT_disjoint_timer_query_webgl2") ||
      !drawSrc.includes('settings.fiInfra || settings.quality === "auto"')) {
    throw new Error("selfCheck: FI/Auto must keep GPU sampling active");
  }
  if (drawSrc.indexOf("sourceTex = fiPrevTexture") < 0 ||
      drawSrc.indexOf("sourceTex = fiPrevTexture") > drawSrc.indexOf("fiShouldPresentMid()")) {
    throw new Error("selfCheck: FI latency must not depend on the mid-frame gate");
  }
  if (drawSrc.indexOf('else if (drawKind === "capture")') < 0 ||
      drawSrc.indexOf('else if (drawKind === "capture")') >
        drawSrc.indexOf("fiAfterVideoUpload(currentVideo)") ||
      !String(onFrame).includes("newVideoFrame: true")) {
    throw new Error("selfCheck: only fresh video callbacks may advance the FI pair");
  }
  const applySrc = String(applySettings);
  if (!drawSrc.includes('if (drawKind === "capture") ravuPendingCaptureVideo = currentVideo') ||
      !drawSrc.includes("if (!ravuRetryPromise)") ||
      !drawSrc.includes("captureVideo === currentVideo") ||
      !drawSrc.includes(".catch((error)") || !drawSrc.includes(".finally(()") ||
      !drawSrc.includes("generation !== ravuRetryGeneration") ||
      !String(deactivateRenderer).includes("invalidateRavuRetry()") ||
      !applySrc.includes('previous.mode === "ravu" && settings.mode !== "ravu"') ||
      !String(rescan).includes("ravuPendingCaptureVideo = null")) {
    throw new Error("selfCheck: RAVU loading must coalesce capture intent per video");
  }
  const reenableOverlay = 'if (previous.mode === "off") overlayVisible = true;';
  if (applySrc.indexOf(reenableOverlay) < 0 ||
      applySrc.indexOf(reenableOverlay) > applySrc.indexOf("attachDiscoveryListeners()")) {
    throw new Error("selfCheck: reactivating a mode must restore the overlay before the renderer");
  }
  const ravuErrorStart = drawSrc.indexOf("if (ravuError)");
  const ravuErrorEnd = drawSrc.indexOf("} else {", ravuErrorStart);
  if (ravuErrorStart < 0 || ravuErrorEnd < ravuErrorStart ||
      !drawSrc.slice(ravuErrorStart, ravuErrorEnd).includes("updateCanvasVisibility()")) {
    throw new Error("selfCheck: a RAVU error must restore the hidden video");
  }
  const stillSrc = String(handleStillFrame);
  const addStillSrc = String(attachDiscoveryListeners);
  const removeStillSrc = String(detachDiscoveryListeners);
  if (!stillSrc.includes("event.target !== currentVideo") ||
      !stillSrc.includes("currentVideo.readyState >= 2") ||
      stillSrc.split('draw({ newVideoFrame: true })').length !== 2 ||
      !["pause", "ended", "seeked", "loadeddata"].every((type) =>
        addStillSrc.includes(`document.addEventListener("${type}", handleStillFrame, true)`) &&
        removeStillSrc.includes(`document.removeEventListener("${type}", handleStillFrame, true)`))) {
    throw new Error("selfCheck: a paused frame must capture only the current video");
  }
  if (!String(fiShouldPresentMid).includes('fiMethod === "duplicate"') ||
      String(fiRenderMidToOut).includes('method === "duplicate"')) {
    throw new Error("selfCheck: duplicate FI must not run another pipeline");
  }
  if (String(createOverlay).includes("fiEnsurePrograms") ||
      String(createOverlay).includes("fiMakeTexture")) {
    throw new Error("selfCheck: FI resources must stay lazy while disabled");
  }

  const severe = selectAutoScale(1, 0, {
    videoFps: 60, missed: 8, missedPct: 12, latePct: 0,
    cpuMs: 1, gpuMs: 1,
  });
  if (severe.scale !== 0.7 || severe.stable !== 0) {
    throw new Error("selfCheck: Auto did not react to severe overload");
  }
  let recovery = { scale: 0.7, stable: 0 };
  for (let i = 0; i < 5; i++) {
    recovery = selectAutoScale(recovery.scale, recovery.stable, {
      videoFps: 60, missed: 0, missedPct: 0, latePct: 0,
      cpuMs: 1, gpuMs: 1,
    });
  }
  if (recovery.scale !== 0.85 || recovery.stable !== 0) {
    throw new Error("selfCheck: Auto did not recover after five stable windows");
  }
  if (autoScaleCap(1920, 1080, 60) !== 1 ||
      autoScaleCap(2560, 1440, 60) !== 0.85 ||
      autoScaleCap(3840, 2160, 60) !== 0.7) {
    throw new Error("selfCheck: megapixel budget selected the wrong scale");
  }
  if (adjustedRcasStrength(1, 1) !== 1 ||
      Math.abs(adjustedRcasStrength(1, 3) - 0.7) > 1e-6) {
    throw new Error("selfCheck: halo protection calculated the wrong strength");
  }
  if (fiOutputFps(24, true) !== 48 || fiOutputFps(30, false) !== 30 ||
      fiOutputFps(0, true) !== 0 ||
      !shouldUseRavu(1920, 1080, 1792, 1008, "high") ||
      shouldUseRavu(1920, 1080, 1792, 1008, "balanced") ||
      !shouldUseRavu(1280, 720, 1920, 1080, "balanced")) {
    throw new Error("selfCheck: incorrect FI budget or RAVU/downscale gate");
  }
  const frameLoopSrc = String(onFrame);
  const scheduleIndex = frameLoopSrc.lastIndexOf("schedule();");
  const drawIndex = frameLoopSrc.indexOf("draw({ newVideoFrame: true");
  if (scheduleIndex < 0 || drawIndex < 0 || scheduleIndex > drawIndex) {
    throw new Error("selfCheck: next rVFC must be armed before the heavy draw");
  }
  if (frameSchedulerKind(false, true) !== "animation" ||
      frameSchedulerKind(true, true) !== "video" ||
      frameSchedulerKind(true, false) !== "animation") {
    throw new Error("selfCheck: frame scheduler selected the wrong clock");
  }
  const shaderFixture = "step1: String.raw`um`,\ncompose: String.raw`dois`,";
  if (extractRavuShader(shaderFixture, "step1") !== "um" ||
      extractRavuShader(shaderFixture, "compose") !== "dois") {
    throw new Error("selfCheck: lazy RAVU parser failed");
  }

  settings = normalizeSettings({ ...DEFAULT_SETTINGS, mode: "native" });
  resetMetricWindow(0);
  resetVideoFrameHistory();
  recordVideoFrame(0, { presentedFrames: 1, mediaTime: 0, expectedDisplayTime: 5 });
  recordVideoFrame(20, { presentedFrames: 3, mediaTime: 0.04, expectedDisplayTime: 25 });
  recordDraw(2, false);
  recordDraw(3, true);
  if (metricWindow.mediaFrames !== 2 || metricWindow.missed !== 1 ||
      metricWindow.realDrawn !== 1 || metricWindow.midDrawn !== 1 ||
      metricWindow.cpuSamples !== 1 || !fiResumeGap) {
    throw new Error("selfCheck: skipped frames were not counted correctly");
  }
  recordVideoFrame(400, { presentedFrames: 4, mediaTime: 0.4, expectedDisplayTime: 405 });
  if (!fiResumeGap) throw new Error("selfCheck: a real timing gap did not reset FI");

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
    console.warn("[fv-enhancer] fi-core.js did not load in the self-check:", error.message || error);
  }
  selfCheck();
}
