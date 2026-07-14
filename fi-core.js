"use strict";
/*
 * Frame interpolation — pure decision units (no DOM / WebGL).
 * Loaded before content.js in the extension; also runnable via `node fi-core.js`.
 */

/** @returns {boolean} true if source fps is in the 24/30-ish band for 2× FI */
function fiFpsAllows2x(fps) {
  const f = Number(fps);
  if (!Number.isFinite(f) || f <= 0) return false;
  // ~20–34 covers 23.976 / 24 / 25 / 29.97 / 30 with margin; excludes 48/50/60.
  return f >= 20 && f <= 34;
}

/**
 * Hysteresis helper: once in/out of band, require margin to flip.
 * @param {number} fps
 * @param {boolean} previouslyAllowed
 */
function fiFpsAllows2xSticky(fps, previouslyAllowed) {
  const f = Number(fps);
  if (!Number.isFinite(f) || f <= 0) return false;
  if (previouslyAllowed) return f >= 18 && f <= 36;
  return fiFpsAllows2x(f);
}

/**
 * Mean absolute difference of two equal-length luma buffers (0–255 scale).
 * @param {ArrayLike<number>} prev
 * @param {ArrayLike<number>} curr
 */
function fiSceneCutScore(prev, curr) {
  const n = Math.min(prev.length, curr.length);
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.abs(prev[i] - curr[i]);
  return sum / n;
}

function fiIsSceneCut(score, threshold = 28) {
  return Number(score) >= Number(threshold);
}

/**
 * Extract luma plane from RGBA Uint8ClampedArray / Uint8Array.
 * @param {ArrayLike<number>} rgba
 * @param {number} pixelCount
 */
function fiRgbaToLuma(rgba, pixelCount) {
  const out = new Float32Array(pixelCount);
  for (let i = 0, p = 0; i < pixelCount; i++, p += 4) {
    out[i] = 0.2126 * rgba[p] + 0.7152 * rgba[p + 1] + 0.0722 * rgba[p + 2];
  }
  return out;
}

function fiSampleLuma(luma, w, h, x, y) {
  const ix = Math.max(0, Math.min(w - 1, x | 0));
  const iy = Math.max(0, Math.min(h - 1, y | 0));
  return luma[iy * w + ix];
}

/**
 * Sum of absolute differences for a block.
 */
function fiBlockSad(prev, curr, w, h, bx, by, bw, bh, mx, my) {
  let sad = 0;
  let count = 0;
  for (let y = 0; y < bh; y++) {
    const sy = by + y;
    if (sy < 0 || sy >= h) continue;
    const ty = sy + my;
    if (ty < 0 || ty >= h) continue;
    for (let x = 0; x < bw; x++) {
      const sx = bx + x;
      if (sx < 0 || sx >= w) continue;
      const tx = sx + mx;
      if (tx < 0 || tx >= w) continue;
      sad += Math.abs(prev[sy * w + sx] - curr[ty * w + tx]);
      count++;
    }
  }
  return count ? sad / count : 1e9;
}

/**
 * Hierarchical block matching on luma planes (coarse then refine).
 * @returns {{ mvs: Float32Array, confidences: Float32Array, gridW: number, gridH: number, block: number, confidence: number, meanResidual: number }}
 */
function fiHierarchicalBlockMatch(prev, curr, w, h, options = {}) {
  const block = options.block || 16;
  const coarseRange = options.coarseRange != null ? options.coarseRange : 4;
  const refineRange = options.refineRange != null ? options.refineRange : 2;
  const gridW = Math.max(1, Math.floor(w / block));
  const gridH = Math.max(1, Math.floor(h / block));
  const mvs = new Float32Array(gridW * gridH * 2);
  const confidences = new Float32Array(gridW * gridH);
  let residualSum = 0;
  let zeroSadSum = 0;
  let cells = 0;

  for (let gy = 0; gy < gridH; gy++) {
    for (let gx = 0; gx < gridW; gx++) {
      const bx = gx * block;
      const by = gy * block;
      const bw = Math.min(block, w - bx);
      const bh = Math.min(block, h - by);

      let bestMx = 0;
      let bestMy = 0;
      let bestSad = fiBlockSad(prev, curr, w, h, bx, by, bw, bh, 0, 0);
      const zeroSad = bestSad;

      // Coarse search (step 2)
      for (let my = -coarseRange; my <= coarseRange; my += 2) {
        for (let mx = -coarseRange; mx <= coarseRange; mx += 2) {
          if (mx === 0 && my === 0) continue;
          const sad = fiBlockSad(prev, curr, w, h, bx, by, bw, bh, mx, my);
          if (sad < bestSad) {
            bestSad = sad;
            bestMx = mx;
            bestMy = my;
          }
        }
      }
      // Refine ±refineRange step 1
      const baseMx = bestMx;
      const baseMy = bestMy;
      for (let my = baseMy - refineRange; my <= baseMy + refineRange; my++) {
        for (let mx = baseMx - refineRange; mx <= baseMx + refineRange; mx++) {
          if (mx === baseMx && my === baseMy) continue;
          if (Math.abs(mx) > coarseRange + refineRange ||
              Math.abs(my) > coarseRange + refineRange) continue;
          const sad = fiBlockSad(prev, curr, w, h, bx, by, bw, bh, mx, my);
          if (sad < bestSad) {
            bestSad = sad;
            bestMx = mx;
            bestMy = my;
          }
        }
      }

      const idx = (gy * gridW + gx) * 2;
      const ci = gy * gridW + gx;
      mvs[idx] = bestMx;
      mvs[idx + 1] = bestMy;
      const localImprove = zeroSad > 1e-3 ? (zeroSad - bestSad) / zeroSad : 0;
      const localResidualPenalty = Math.min(1, bestSad / 48);
      confidences[ci] = Math.max(0, Math.min(1, localImprove * 0.7 + (1 - localResidualPenalty) * 0.3));
      residualSum += bestSad;
      zeroSadSum += zeroSad;
      cells++;
    }
  }

  const meanResidual = cells ? residualSum / cells : 1e9;
  const meanZero = cells ? zeroSadSum / cells : 1e9;
  // Confidence: how much ME improved over zero motion, and absolute residual.
  const improve = meanZero > 1e-3 ? (meanZero - meanResidual) / meanZero : 0;
  const residualPenalty = Math.min(1, meanResidual / 40);
  const confidence = Math.max(0, Math.min(1, improve * 0.65 + (1 - residualPenalty) * 0.35));

  return { mvs, confidences, gridW, gridH, block, confidence, meanResidual, meanZero };
}

/** Local confidence after checking that forward and reverse vectors cancel. */
function fiBidirectionalConsistency(forward, backward) {
  if (!forward || !backward || forward.gridW !== backward.gridW ||
      forward.gridH !== backward.gridH || forward.block !== backward.block) return null;
  const count = forward.gridW * forward.gridH;
  const refine = (match, reverse) => {
    const confidences = new Float32Array(count);
    let sum = 0;
    for (let i = 0; i < count; i++) {
      const gx = i % match.gridW;
      const gy = Math.floor(i / match.gridW);
      const mx = match.mvs[i * 2];
      const my = match.mvs[i * 2 + 1];
      const rx = Math.floor((gx * match.block + match.block * 0.5 + mx) / match.block);
      const ry = Math.floor((gy * match.block + match.block * 0.5 + my) / match.block);
      if (rx < 0 || ry < 0 || rx >= match.gridW || ry >= match.gridH) continue;
      const ri = ry * match.gridW + rx;
      const error = Math.hypot(mx + reverse.mvs[ri * 2], my + reverse.mvs[ri * 2 + 1]);
      const tolerance = 1 + 0.5 * Math.hypot(mx, my);
      const consistency = Math.max(0, 1 - error / tolerance);
      const local = Math.min(match.confidences[i], reverse.confidences[ri]);
      confidences[i] = local * (0.2 + 0.8 * consistency);
      sum += confidences[i];
    }
    return { confidences, confidence: count ? sum / count : 0 };
  };
  const a = refine(forward, backward);
  const b = refine(backward, forward);
  return {
    forward: a.confidences,
    backward: b.confidences,
    confidence: Math.sqrt(a.confidence * b.confidence),
  };
}

/**
 * Warp sample offsets in UV space for a motion vector (source pixels → UV via texel).
 * ME finds mv such that curr[p+mv] ≈ prev[p]. Mid phase t∈[0,1]:
 *   fromPrev = p - mv*t, fromCurr = p + mv*(1-t).
 * @returns {{ fromPrevX: number, fromPrevY: number, fromCurrX: number, fromCurrY: number }}
 */
function fiWarpSampleOffsets(uvX, uvY, mvX, mvY, texelX, texelY, phase) {
  const t = Math.max(0, Math.min(1, Number(phase) || 0));
  return {
    fromPrevX: uvX - mvX * t * texelX,
    fromPrevY: uvY - mvY * t * texelY,
    fromCurrX: uvX + mvX * (1 - t) * texelX,
    fromCurrY: uvY + mvY * (1 - t) * texelY,
  };
}

/** Phase of the delayed anchor pair at the display callback time. */
function fiPresentationPhase(now, anchorTime, frameDurationMs) {
  const elapsed = Number(now) - Number(anchorTime);
  const duration = Number(frameDurationMs);
  if (!Number.isFinite(elapsed) || !Number.isFinite(duration) || duration <= 0) return -1;
  return Math.max(0, Math.min(1, elapsed / duration));
}

function fiMidFitsDeadline(phase, frameDurationMs, estimatedCostMs, marginMs = 2) {
  const t = Number(phase);
  const duration = Number(frameDurationMs);
  const cost = Math.max(0, Number(estimatedCostMs) || 0);
  const margin = Math.max(0, Number(marginMs) || 0);
  if (!Number.isFinite(t) || !Number.isFinite(duration) || duration <= 0 || t <= 0 || t >= 1) {
    return false;
  }
  return duration * (1 - t) >= cost + margin;
}

/**
 * Pick presentation method for the mid frame.
 * @returns {"skip"|"duplicate"|"blend"|"block"}
 */
function fiPickMethod(ctx) {
  if (!ctx || !ctx.infra) return "skip";
  if (ctx.fpsGate && !ctx.fpsOk) return "skip";
  if (ctx.sceneCutEnabled && ctx.sceneCut) return "duplicate";
  if (!ctx.blockMatchEnabled) {
    return ctx.fallbackEnabled ? "blend" : "blend";
  }
  const conf = Number(ctx.confidence);
  if (!ctx.fallbackEnabled) return "block";
  if (!Number.isFinite(conf) || conf < 0.32) return "duplicate";
  if (conf < 0.52) return "blend";
  return "block";
}

function fiDefaultSettings() {
  return {
    fiInfra: false,
    fiSceneCut: true,
    fiFpsGate: true,
    fiHalfLuma: true,
    fiBlockMatch: true,
    fiFallback: true,
  };
}

function fiNormalizeSettings(value = {}) {
  const flag = (v, defaultTrue) => {
    if (v === true) return true;
    if (v === false) return false;
    return defaultTrue;
  };
  return {
    fiInfra: flag(value.fiInfra, false),
    fiSceneCut: flag(value.fiSceneCut, true),
    fiFpsGate: flag(value.fiFpsGate, true),
    fiHalfLuma: flag(value.fiHalfLuma, true),
    fiBlockMatch: flag(value.fiBlockMatch, true),
    fiFallback: flag(value.fiFallback, true),
  };
}

function fiSelfCheck() {
  if (fiFpsAllows2x(24) !== true || fiFpsAllows2x(30) !== true) {
    throw new Error("fiSelfCheck: 24/30 must allow 2x");
  }
  if (fiFpsAllows2x(60) !== false || fiFpsAllows2x(50) !== false) {
    throw new Error("fiSelfCheck: 50/60 must not allow 2x");
  }
  if (fiFpsAllows2x(0) || fiFpsAllows2x(NaN)) {
    throw new Error("fiSelfCheck: invalid fps must reject");
  }
  if (!fiFpsAllows2xSticky(35, true) || fiFpsAllows2xSticky(35, false)) {
    throw new Error("fiSelfCheck: hysteresis sticky failed");
  }

  const quiet = new Float32Array(64).fill(40);
  const quiet2 = new Float32Array(64).fill(42);
  const cut = new Float32Array(64).fill(200);
  const quietScore = fiSceneCutScore(quiet, quiet2);
  const cutScore = fiSceneCutScore(quiet, cut);
  if (!(quietScore < 5) || !fiIsSceneCut(cutScore, 28) || fiIsSceneCut(quietScore, 28)) {
    throw new Error("fiSelfCheck: scene-cut scoring failed");
  }

  // Synthetic shift: prev block left, curr shifted +2 px
  const w = 32;
  const h = 32;
  const prev = new Float32Array(w * h);
  const curr = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      prev[y * w + x] = (x >= 8 && x < 16 && y >= 8 && y < 16) ? 200 : 20;
      const sx = x - 2;
      curr[y * w + x] = (sx >= 8 && sx < 16 && y >= 8 && y < 16) ? 200 : 20;
    }
  }
  const match = fiHierarchicalBlockMatch(prev, curr, w, h, {
    block: 8, coarseRange: 4, refineRange: 2,
  });
  if (!(match.confidence > 0.15)) {
    throw new Error("fiSelfCheck: block match confidence too low: " + match.confidence);
  }
  if (!(match.confidences && match.confidences.length === match.gridW * match.gridH)) {
    throw new Error("fiSelfCheck: block match local confidences missing");
  }
  // At least one MV should lean positive x (object moved right in curr → search finds +2)
  let maxAbs = 0;
  for (let i = 0; i < match.mvs.length; i += 2) {
    maxAbs = Math.max(maxAbs, Math.abs(match.mvs[i]) + Math.abs(match.mvs[i + 1]));
  }
  if (maxAbs < 1) {
    throw new Error("fiSelfCheck: expected non-zero motion vectors");
  }
  const reverseMatch = fiHierarchicalBlockMatch(curr, prev, w, h, {
    block: 8, coarseRange: 4, refineRange: 2,
  });
  const pair = fiBidirectionalConsistency(match, reverseMatch);
  const brokenReverse = { ...reverseMatch, mvs: reverseMatch.mvs.slice() };
  brokenReverse.mvs.fill(6);
  const brokenPair = fiBidirectionalConsistency(match, brokenReverse);
  if (!pair || !brokenPair || pair.confidence <= brokenPair.confidence ||
      pair.forward.length !== match.confidences.length) {
    throw new Error("fiSelfCheck: bidirectional consistency failed");
  }

  if (fiPickMethod({ infra: false, fpsOk: true }) !== "skip") {
    throw new Error("fiSelfCheck: infra off must skip");
  }
  if (fiPickMethod({
    infra: true, fpsGate: true, fpsOk: false, sceneCutEnabled: true, sceneCut: false,
    blockMatchEnabled: true, fallbackEnabled: true, confidence: 0.9,
  }) !== "skip") {
    throw new Error("fiSelfCheck: fps gate must skip");
  }
  if (fiPickMethod({
    infra: true, fpsGate: true, fpsOk: true, sceneCutEnabled: true, sceneCut: true,
    blockMatchEnabled: true, fallbackEnabled: true, confidence: 0.9,
  }) !== "duplicate") {
    throw new Error("fiSelfCheck: scene cut must duplicate");
  }
  if (fiPickMethod({
    infra: true, fpsGate: false, fpsOk: false, sceneCutEnabled: false, sceneCut: false,
    blockMatchEnabled: true, fallbackEnabled: true, confidence: 0.1,
  }) !== "duplicate") {
    throw new Error("fiSelfCheck: low confidence must duplicate");
  }
  if (fiPickMethod({
    infra: true, fpsGate: false, fpsOk: false, sceneCutEnabled: false, sceneCut: false,
    blockMatchEnabled: true, fallbackEnabled: true, confidence: 0.4,
  }) !== "blend") {
    throw new Error("fiSelfCheck: mid confidence must blend");
  }
  if (fiPickMethod({
    infra: true, fpsGate: false, fpsOk: false, sceneCutEnabled: false, sceneCut: false,
    blockMatchEnabled: true, fallbackEnabled: true, confidence: 0.8,
  }) !== "block") {
    throw new Error("fiSelfCheck: high confidence must block");
  }

  const n = fiNormalizeSettings({});
  if (n.fiInfra !== false || n.fiSceneCut !== true || n.fiBlockMatch !== true) {
    throw new Error("fiSelfCheck: normalize defaults failed");
  }
  if (fiNormalizeSettings({ fiInfra: true, fiSceneCut: false }).fiSceneCut !== false) {
    throw new Error("fiSelfCheck: normalize explicit false failed");
  }

  // Feature at prev uv=0.5 moves +8px on a 32px-wide image (texel=1/32).
  // At t=0.5, prev sample should look left (−), curr sample right (+).
  const warp = fiWarpSampleOffsets(0.5, 0.5, 8, 0, 1 / 32, 1 / 32, 0.5);
  if (!(warp.fromPrevX < 0.5 && warp.fromCurrX > 0.5)) {
    throw new Error(
      "fiSelfCheck: warp offsets inverted " +
      JSON.stringify(warp),
    );
  }
  const at0 = fiWarpSampleOffsets(0.5, 0.5, 8, 0, 1 / 32, 1 / 32, 0);
  if (Math.abs(at0.fromPrevX - 0.5) > 1e-9 || Math.abs(at0.fromCurrX - 0.5 - 8 / 32) > 1e-9) {
    throw new Error("fiSelfCheck: warp phase 0 wrong " + JSON.stringify(at0));
  }
  if (Math.abs(fiPresentationPhase(116, 100, 40) - 0.4) > 1e-9 ||
      fiPresentationPhase(90, 100, 40) !== 0 ||
      fiPresentationPhase(140, 100, 40) !== 1 ||
      fiPresentationPhase(100, 100, 0) !== -1) {
    throw new Error("fiSelfCheck: display phase calculation failed");
  }
  if (!fiMidFitsDeadline(0.4, 1000 / 24, 8) ||
      fiMidFitsDeadline(0.8, 1000 / 24, 8) ||
      !fiMidFitsDeadline(0.5, 1000 / 30, 10) ||
      fiMidFitsDeadline(1, 1000 / 30, 0)) {
    throw new Error("fiSelfCheck: mid-frame deadline gate failed");
  }
  const phasesAt60Hz = (sourceFps) => {
    const duration = 1000 / sourceFps;
    const phases = [];
    for (let now = 1000 / 60; now < duration; now += 1000 / 60) {
      phases.push(fiPresentationPhase(now, 0, duration));
    }
    return phases;
  };
  const phases24 = phasesAt60Hz(24);
  const phases30 = phasesAt60Hz(30);
  if (phases24.length !== 2 || Math.abs(phases24[0] - 0.4) > 1e-9 ||
      Math.abs(phases24[1] - 0.8) > 1e-9 ||
      phases30.length !== 1 || Math.abs(phases30[0] - 0.5) > 1e-9) {
    throw new Error("fiSelfCheck: display-rate cadence failed");
  }
  // Shader source must match pure helper (shipped string in content.js when co-loaded).
  if (typeof FI_WARP_FRAG === "string") {
    if (!FI_WARP_FRAG.includes("v_uv - forwardMv * t * u_texel") ||
        !FI_WARP_FRAG.includes("v_uv - backwardMv * (1.0 - t) * u_texel")) {
      throw new Error("fiSelfCheck: FI_WARP_FRAG sampling direction mismatch");
    }
    if (FI_WARP_FRAG.includes("v_uv + forwardMv * t * u_texel")) {
      throw new Error("fiSelfCheck: FI_WARP_FRAG still has inverted fromPrev");
    }
  }
  // FBO helpers: pure contract for separate copy vs out (names must exist when content loaded)
  if (typeof fiCopyTexture === "function" && typeof fiBindOutTarget === "function") {
    // When content.js is loaded, structural check only — cannot allocate GL in node.
    if (typeof fiCopyFb === "undefined" && typeof fiOutFb === "undefined") {
      // state vars are lets in content scope when co-run; optional
    }
  }

  console.log("[fv-fi] fiSelfCheck OK");
  return true;
}

// Node entry: `node fi-core.js`
if (typeof process !== "undefined" && process.argv && process.argv[1] &&
    /fi-core\.js$/i.test(String(process.argv[1]).replace(/\\/g, "/"))) {
  fiSelfCheck();
}
