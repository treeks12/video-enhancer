"use strict";

/*
 * Dense, pyramidal Lucas-Kanade optical flow for frame interpolation.
 *
 * The CPU uploads two luma planes and reads one compact vec4 per 2x2 cell:
 * motion x/y, confidence, and residual. All pyramid construction, warping,
 * gradients, and iterative flow refinement run in WebGPU compute shaders.
 */
(function installFiWebGpu(scope) {
  const BLOCK = 2;
  const DEFAULT_MAX_WIDTH = 480;
  const DEFAULT_MAX_HEIGHT = 270;
  const ITERATIONS = 6;
  const PARAM_STRIDE = 256;
  const MAX_PARAM_SLOTS = 64;

  const DOWNSAMPLE_WGSL = /* wgsl */`
struct Params {
  srcW: u32,
  srcH: u32,
  dstW: u32,
  dstH: u32,
};

@group(0) @binding(0) var<storage, read> source: array<f32>;
@group(0) @binding(1) var<storage, read_write> destination: array<f32>;
@group(0) @binding(2) var<uniform> params: Params;

fn at(x: i32, y: i32) -> f32 {
  let sx = u32(clamp(x, 0, i32(params.srcW) - 1));
  let sy = u32(clamp(y, 0, i32(params.srcH) - 1));
  return source[sy * params.srcW + sx];
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= params.dstW || id.y >= params.dstH) { return; }
  let x = i32(id.x * 2u);
  let y = i32(id.y * 2u);
  let weights = array<f32, 4>(1.0, 3.0, 3.0, 1.0);
  var sum = 0.0;
  for (var ky = 0; ky < 4; ky = ky + 1) {
    for (var kx = 0; kx < 4; kx = kx + 1) {
      sum += at(x + kx - 1, y + ky - 1) * weights[u32(kx)] * weights[u32(ky)];
    }
  }
  destination[id.y * params.dstW + id.x] = sum * (1.0 / 64.0);
}
`;

  const FLOW_WGSL = /* wgsl */`
struct Params {
  imageW: u32,
  imageH: u32,
  gridW: u32,
  gridH: u32,
  coarseGridW: u32,
  coarseGridH: u32,
  mode: u32,
  iteration: u32,
  maxStep: f32,
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
};

@group(0) @binding(0) var<storage, read> referenceImage: array<f32>;
@group(0) @binding(1) var<storage, read> targetImage: array<f32>;
@group(0) @binding(2) var<storage, read> flowIn: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> coarseFlow: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read_write> flowOut: array<vec4<f32>>;
@group(0) @binding(5) var<uniform> params: Params;

fn sampleImage(image: ptr<storage, array<f32>, read>, point: vec2<f32>) -> f32 {
  let hi = vec2<f32>(f32(params.imageW - 1u), f32(params.imageH - 1u));
  let p = clamp(point, vec2<f32>(0.0), hi);
  let p0 = vec2<u32>(floor(p));
  let p1 = min(p0 + vec2<u32>(1u), vec2<u32>(params.imageW - 1u, params.imageH - 1u));
  let f = fract(p);
  let a = image[p0.y * params.imageW + p0.x];
  let b = image[p0.y * params.imageW + p1.x];
  let c = image[p1.y * params.imageW + p0.x];
  let d = image[p1.y * params.imageW + p1.x];
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

fn coarseAt(x: i32, y: i32) -> vec2<f32> {
  let cx = u32(clamp(x, 0, i32(params.coarseGridW) - 1));
  let cy = u32(clamp(y, 0, i32(params.coarseGridH) - 1));
  return coarseFlow[cy * params.coarseGridW + cx].xy;
}

fn initialFlow(id: vec2<u32>) -> vec2<f32> {
  // mode 0: zero; mode 1: upsample prior level; mode 2: LK iteration;
  // mode 3: the global seed produced for the coarsest level.
  if (params.mode == 0u) { return vec2<f32>(0.0); }
  if (params.mode == 2u) { return flowIn[id.y * params.gridW + id.x].xy; }
  if (params.mode == 3u) { return coarseFlow[0].xy; }

  let p = (vec2<f32>(id) + vec2<f32>(0.5)) * 0.5 - vec2<f32>(0.5);
  let base = vec2<i32>(floor(p));
  let f = fract(p);
  let a = coarseAt(base.x, base.y);
  let b = coarseAt(base.x + 1, base.y);
  let c = coarseAt(base.x, base.y + 1);
  let d = coarseAt(base.x + 1, base.y + 1);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y) * 2.0;
}

fn residual3(flow: vec2<f32>, center: vec2<f32>) -> f32 {
  var residual = 0.0;
  for (var y = -1; y <= 1; y = y + 1) {
    for (var x = -1; x <= 1; x = x + 1) {
      let offset = vec2<f32>(f32(x), f32(y));
      residual += abs(sampleImage(&targetImage, center + offset + flow) -
                      sampleImage(&referenceImage, center + offset));
    }
  }
  return residual * (1.0 / 9.0);
}

fn residual5(flow: vec2<f32>, center: vec2<f32>) -> f32 {
  var residual = 0.0;
  for (var y = -2; y <= 2; y = y + 1) {
    for (var x = -2; x <= 2; x = x + 1) {
      let offset = vec2<f32>(f32(x), f32(y));
      residual += abs(sampleImage(&targetImage, center + offset + flow) -
                      sampleImage(&referenceImage, center + offset));
    }
  }
  return residual * 0.04;
}

fn residualWide(flow: vec2<f32>, center: vec2<f32>) -> f32 {
  var residual = 0.0;
  for (var y = -2; y <= 2; y = y + 1) {
    for (var x = -2; x <= 2; x = x + 1) {
      let offset = vec2<f32>(f32(x), f32(y)) * 2.0;
      residual += abs(sampleImage(&targetImage, center + offset + flow) -
                      sampleImage(&referenceImage, center + offset));
    }
  }
  return residual * 0.04;
}

fn globalResidual(flow: vec2<f32>) -> f32 {
  var residual = 0.0;
  var count = 0.0;
  for (var y = 3; y < i32(params.imageH) - 3; y = y + 4) {
    for (var x = 3; x < i32(params.imageW) - 3; x = x + 4) {
      let point = vec2<f32>(f32(x), f32(y));
      residual += abs(sampleImage(&targetImage, point + flow) -
                      sampleImage(&referenceImage, point));
      count += 1.0;
    }
  }
  return residual / max(1.0, count);
}

fn coarseSearch() -> vec2<f32> {
  var best = vec2<f32>(0.0);
  let zeroScore = globalResidual(best);
  var bestScore = zeroScore;
  // Search a global translation once at the smallest scale. The larger support
  // disambiguates periodic local patches while providing LK a fast-motion seed.
  for (var y = -4; y <= 4; y = y + 1) {
    for (var x = -4; x <= 4; x = x + 1) {
      let candidate = vec2<f32>(f32(x), f32(y));
      let score = globalResidual(candidate) + 0.08 * length(candidate);
      if (score + 0.05 < bestScore) {
        best = candidate;
        bestScore = score;
      }
    }
  }
  return select(vec2<f32>(0.0), best, bestScore < zeroScore * 0.60);
}

@compute @workgroup_size(1)
fn globalSeed(@builtin(global_invocation_id) globalId: vec3<u32>) {
  if (globalId.x != 0u || globalId.y != 0u) { return; }
  let seed = coarseSearch();
  flowOut[0] = vec4<f32>(seed, 0.0, globalResidual(seed));
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) globalId: vec3<u32>) {
  if (globalId.x >= params.gridW || globalId.y >= params.gridH) { return; }
  let id = globalId.xy;
  let center = min(
      vec2<f32>(id * 2u) + vec2<f32>(0.5),
      vec2<f32>(f32(params.imageW - 1u), f32(params.imageH - 1u)));
  var flow = initialFlow(id);
  // Recover from coarse aliases with a bounded local search before LK refinement.
  // Wide spatial support distinguishes repeated edges; good coarse fits skip it.
  if (params.mode == 1u) {
    var bestResidual = residualWide(flow, center);
    if (bestResidual > 2.0) {
      for (var y = -3; y <= 3; y = y + 1) {
        for (var x = -3; x <= 3; x = x + 1) {
          let candidate = vec2<f32>(f32(x), f32(y));
          let score = residualWide(candidate, center);
          if (score < bestResidual * 0.92) {
            flow = candidate;
            bestResidual = score;
          }
        }
      }
    }
  }
  let residualBeforeUpdate = residual5(flow, center);

  var gxx = 0.0;
  var gxy = 0.0;
  var gyy = 0.0;
  var btx = 0.0;
  var bty = 0.0;
  for (var oy = -2; oy <= 2; oy = oy + 1) {
    for (var ox = -2; ox <= 2; ox = ox + 1) {
      let offset = vec2<f32>(f32(ox), f32(oy));
      let sourcePoint = center + offset;
      let targetPoint = sourcePoint + flow;
      let ix = (sampleImage(&targetImage, targetPoint + vec2<f32>(1.0, 0.0)) -
                sampleImage(&targetImage, targetPoint - vec2<f32>(1.0, 0.0))) * 0.5;
      let iy = (sampleImage(&targetImage, targetPoint + vec2<f32>(0.0, 1.0)) -
                sampleImage(&targetImage, targetPoint - vec2<f32>(0.0, 1.0))) * 0.5;
      let it = sampleImage(&targetImage, targetPoint) - sampleImage(&referenceImage, sourcePoint);
      // A small Gaussian-like center bias makes the estimate less likely to cross an edge.
      let weight = 1.0 / (1.0 + 0.15 * f32(ox * ox + oy * oy));
      gxx += weight * ix * ix;
      gxy += weight * ix * iy;
      gyy += weight * iy * iy;
      btx += weight * ix * it;
      bty += weight * iy * it;
    }
  }

  let determinant = gxx * gyy - gxy * gxy;
  let trace = gxx + gyy;
  let discriminant = sqrt(max(0.0, trace * trace - 4.0 * determinant));
  let minEigenvalue = max(0.0, (trace - discriminant) * 0.5);
  if (determinant > 0.0001 && minEigenvalue > 0.01) {
    var delta = vec2<f32>(
        (-gyy * btx + gxy * bty) / determinant,
        ( gxy * btx - gxx * bty) / determinant);
    delta = clamp(delta, vec2<f32>(-params.maxStep), vec2<f32>(params.maxStep));
    let proposed = flow + delta;
    let proposedResidual = residual5(proposed, center);
    if (proposedResidual <= residualBeforeUpdate + 0.02) {
      flow = proposed;
    } else {
      let halfStep = flow + delta * 0.5;
      if (residual5(halfStep, center) < residualBeforeUpdate) { flow = halfStep; }
    }
  }

  let residual = residual5(flow, center);
  let conditioning = minEigenvalue / (minEigenvalue + 24.0);
  let photometric = exp(-residual / 18.0);
  // A flat patch with a near-zero residual is safe to keep stationary even
  // though its tensor cannot identify a unique vector (the aperture problem).
  let reliableStationary = (1.0 - smoothstep(0.25, 1.25, residual)) *
                           (1.0 - smoothstep(0.15, 0.75, length(flow)));
  let confidence = max(reliableStationary, photometric * (0.12 + 0.88 * conditioning));
  flowOut[id.y * params.gridW + id.x] = vec4<f32>(flow, confidence, residual);
}
`;

  function unavailable(message) {
    return new Error(`WebGPU optical flow unavailable: ${message}`);
  }

  function describeCompilation(info) {
    return info.messages
      .filter(message => message.type === "error")
      .map(message => `${message.lineNum || "?"}:${message.linePos || "?"} ${message.message}`)
      .join("; ");
  }

  function align4(value) {
    return (value + 3) & ~3;
  }

  class FiWebGpuEstimator {
    constructor(adapter, device, downsamplePipeline, flowPipeline, flowSeedPipeline, layouts, options) {
      this.adapter = adapter;
      this.device = device;
      this.downsamplePipeline = downsamplePipeline;
      this.flowPipeline = flowPipeline;
      this.flowSeedPipeline = flowSeedPipeline;
      this.downsampleLayout = layouts.downsample;
      this.flowLayout = layouts.flow;
      this.maxWidth = options.maxWidth;
      this.maxHeight = options.maxHeight;
      this.iterations = options.iterations;
      this._resources = null;
      this._busy = false;
      this._destroyed = false;
      this._lostError = null;
      // `lost` is synchronous so the frame loop can cheaply decide whether it
      // may submit. `whenLost` carries the descriptive asynchronous reason.
      this.lost = false;
      this.whenLost = device.lost.then(info => {
        const reason = info && info.reason ? ` (${info.reason})` : "";
        const detail = info && info.message ? `: ${info.message}` : "";
        this._lostError = unavailable(`GPU device was lost${reason}${detail}`);
        this.lost = true;
        return this._lostError;
      });
    }

    _assertUsable() {
      if (this._destroyed) throw unavailable("estimator has been destroyed");
      if (this._lostError) throw this._lostError;
    }

    async _checked(label, operation) {
      this._assertUsable();
      const device = this.device;
      device.pushErrorScope("out-of-memory");
      device.pushErrorScope("internal");
      device.pushErrorScope("validation");
      let value;
      let thrown;
      try {
        value = operation();
        if (value && typeof value.then === "function") value = await value;
      } catch (error) {
        thrown = error;
      }
      const validation = await device.popErrorScope().catch(error => error);
      const internal = await device.popErrorScope().catch(error => error);
      const memory = await device.popErrorScope().catch(error => error);
      const gpuError = validation || internal || memory;
      if (thrown) throw unavailable(`${label} failed: ${thrown.message || thrown}`);
      if (gpuError) throw unavailable(`${label} failed: ${gpuError.message || gpuError}`);
      return value;
    }

    _levelDimensions(width, height) {
      const levels = [{ width, height }];
      while (levels.length < 4) {
        const previous = levels[levels.length - 1];
        if (previous.width < 32 || previous.height < 24) break;
        levels.push({
          width: Math.max(1, Math.ceil(previous.width / 2)),
          height: Math.max(1, Math.ceil(previous.height / 2)),
        });
      }
      return levels;
    }

    async _ensureResources(width, height) {
      if (this._resources && this._resources.width === width && this._resources.height === height) {
        return this._resources;
      }
      if (this._resources) {
        this._destroyResources(this._resources);
        this._resources = null;
      }

      const usage = scope.GPUBufferUsage;
      const levels = this._levelDimensions(width, height);
      const buffers = [];
      const makeBuffer = (size, bufferUsage, label) => {
        const buffer = this.device.createBuffer({ size: align4(Math.max(4, size)), usage: bufferUsage, label });
        buffers.push(buffer);
        return buffer;
      };
      const storage = usage.STORAGE | usage.COPY_DST;
      const imageLevels = [];
      const flowLevels = [];

      const resources = await this._checked("GPU buffer allocation", () => {
        for (let level = 0; level < levels.length; level++) {
          const dimensions = levels[level];
          const imageBytes = dimensions.width * dimensions.height * 4;
          imageLevels.push({
            prev: makeBuffer(imageBytes, storage, `fi-prev-l${level}`),
            curr: makeBuffer(imageBytes, storage, `fi-curr-l${level}`),
          });
          const gridW = Math.ceil(dimensions.width / BLOCK);
          const gridH = Math.ceil(dimensions.height / BLOCK);
          const flowBytes = gridW * gridH * 16;
          flowLevels.push({
            gridW,
            gridH,
            bytes: flowBytes,
            ping: makeBuffer(flowBytes, usage.STORAGE | usage.COPY_SRC, `fi-flow-a-l${level}`),
            pong: makeBuffer(flowBytes, usage.STORAGE | usage.COPY_SRC, `fi-flow-b-l${level}`),
          });
        }
        const finalBytes = flowLevels[0].bytes;
        const result = makeBuffer(finalBytes * 2, usage.COPY_DST | usage.COPY_SRC, "fi-flow-results");
        const readback = makeBuffer(finalBytes * 2, usage.COPY_DST | usage.MAP_READ, "fi-flow-readback");
        const params = makeBuffer(PARAM_STRIDE * MAX_PARAM_SLOTS, usage.UNIFORM | usage.COPY_DST, "fi-flow-params");
        const dummy = makeBuffer(16, usage.STORAGE, "fi-flow-dummy");
        return { width, height, levels, imageLevels, flowLevels, finalBytes, result, readback, params, dummy, buffers };
      });
      this._resources = resources;
      return resources;
    }

    _destroyResources(resources) {
      for (const buffer of resources.buffers) {
        try { buffer.destroy(); } catch { /* Device loss already owns cleanup. */ }
      }
    }

    _writeDownsampleParams(target, slot, source, destination) {
      const values = new Uint32Array(4);
      values[0] = source.width;
      values[1] = source.height;
      values[2] = destination.width;
      values[3] = destination.height;
      new Uint8Array(target, slot * PARAM_STRIDE, values.byteLength).set(new Uint8Array(values.buffer));
    }

    _writeFlowParams(target, slot, dimensions, flow, coarse, mode, iteration) {
      const view = new DataView(target, slot * PARAM_STRIDE, 48);
      const uints = [
        dimensions.width, dimensions.height, flow.gridW, flow.gridH,
        coarse ? coarse.gridW : 1, coarse ? coarse.gridH : 1, mode, iteration,
      ];
      for (let i = 0; i < uints.length; i++) view.setUint32(i * 4, uints[i], true);
      view.setFloat32(32, 1.5, true);
    }

    _downsamplePass(encoder, resources, imageKey, paramOffsets, slotRef) {
      for (let level = 1; level < resources.levels.length; level++) {
        const sourceDimensions = resources.levels[level - 1];
        const destinationDimensions = resources.levels[level];
        const bindGroup = this.device.createBindGroup({
          layout: this.downsampleLayout,
          entries: [
            { binding: 0, resource: { buffer: resources.imageLevels[level - 1][imageKey] } },
            { binding: 1, resource: { buffer: resources.imageLevels[level][imageKey] } },
            { binding: 2, resource: { buffer: resources.params, size: 16 } },
          ],
        });
        this._writeDownsampleParams(paramOffsets, slotRef.value, sourceDimensions, destinationDimensions);
        const pass = encoder.beginComputePass({ label: `fi-downsample-${imageKey}-${level}` });
        pass.setPipeline(this.downsamplePipeline);
        pass.setBindGroup(0, bindGroup, [slotRef.value * PARAM_STRIDE]);
        pass.dispatchWorkgroups(Math.ceil(destinationDimensions.width / 8), Math.ceil(destinationDimensions.height / 8));
        pass.end();
        slotRef.value++;
      }
    }

    _flowDirection(encoder, resources, referenceKey, targetKey, resultOffset, paramOffsets, slotRef) {
      let coarseFinal = null;
      for (let level = resources.levels.length - 1; level >= 0; level--) {
        const dimensions = resources.levels[level];
        const flow = resources.flowLevels[level];
        let input = flow.ping;
        let output = flow.pong;
        let globalSeed = null;
        if (!coarseFinal) {
          globalSeed = { buffer: flow.ping, gridW: 1, gridH: 1 };
          const seedBindGroup = this.device.createBindGroup({
            layout: this.flowLayout,
            entries: [
              { binding: 0, resource: { buffer: resources.imageLevels[level][referenceKey] } },
              { binding: 1, resource: { buffer: resources.imageLevels[level][targetKey] } },
              { binding: 2, resource: { buffer: resources.dummy } },
              { binding: 3, resource: { buffer: resources.dummy } },
              { binding: 4, resource: { buffer: flow.ping } },
              { binding: 5, resource: { buffer: resources.params, size: 48 } },
            ],
          });
          this._writeFlowParams(paramOffsets, slotRef.value, dimensions, flow, null, 0, 0);
          const seedPass = encoder.beginComputePass({ label: `fi-global-seed-${referenceKey}` });
          seedPass.setPipeline(this.flowSeedPipeline);
          seedPass.setBindGroup(0, seedBindGroup, [slotRef.value * PARAM_STRIDE]);
          seedPass.dispatchWorkgroups(1);
          seedPass.end();
          slotRef.value++;
        }
        for (let iteration = 0; iteration < this.iterations; iteration++) {
          const mode = iteration === 0 ? (coarseFinal ? 1 : 3) : 2;
          const initializer = coarseFinal || globalSeed;
          const coarseBuffer = iteration === 0 ? initializer.buffer : resources.dummy;
          const bindGroup = this.device.createBindGroup({
            layout: this.flowLayout,
            entries: [
              { binding: 0, resource: { buffer: resources.imageLevels[level][referenceKey] } },
              { binding: 1, resource: { buffer: resources.imageLevels[level][targetKey] } },
              { binding: 2, resource: { buffer: input } },
              { binding: 3, resource: { buffer: coarseBuffer } },
              { binding: 4, resource: { buffer: output } },
              { binding: 5, resource: { buffer: resources.params, size: 48 } },
            ],
          });
          this._writeFlowParams(paramOffsets, slotRef.value, dimensions, flow, iteration === 0 ? initializer : null, mode, iteration);
          const pass = encoder.beginComputePass({ label: `fi-lk-${referenceKey}-${level}-${iteration}` });
          pass.setPipeline(this.flowPipeline);
          pass.setBindGroup(0, bindGroup, [slotRef.value * PARAM_STRIDE]);
          pass.dispatchWorkgroups(Math.ceil(flow.gridW / 8), Math.ceil(flow.gridH / 8));
          pass.end();
          slotRef.value++;
          const swap = input;
          input = output;
          output = swap;
        }
        coarseFinal = { buffer: input, gridW: flow.gridW, gridH: flow.gridH };
      }
      encoder.copyBufferToBuffer(coarseFinal.buffer, 0, resources.result, resultOffset, resources.finalBytes);
    }

    _decodeMatch(data, floatOffset, resources) {
      const count = resources.flowLevels[0].gridW * resources.flowLevels[0].gridH;
      const mvs = new Float32Array(count * 2);
      const confidences = new Float32Array(count);
      let confidenceSum = 0;
      let residualSum = 0;
      for (let i = 0; i < count; i++) {
        const source = floatOffset + i * 4;
        const target = i * 2;
        const x = Number.isFinite(data[source]) ? data[source] : 0;
        const y = Number.isFinite(data[source + 1]) ? data[source + 1] : 0;
        const confidence = Number.isFinite(data[source + 2])
          ? Math.max(0, Math.min(1, data[source + 2])) : 0;
        const residual = Number.isFinite(data[source + 3]) ? Math.max(0, data[source + 3]) : 255;
        mvs[target] = x;
        mvs[target + 1] = y;
        confidences[i] = confidence;
        confidenceSum += confidence;
        residualSum += residual;
      }
      return {
        mvs,
        confidences,
        gridW: resources.flowLevels[0].gridW,
        gridH: resources.flowLevels[0].gridH,
        block: BLOCK,
        confidence: count ? confidenceSum / count : 0,
        meanResidual: count ? residualSum / count : 255,
      };
    }

    async estimate(previousLuma, currentLuma, width, height) {
      this._assertUsable();
      if (this._busy) throw unavailable("an estimate is already in flight");
      if (!Number.isInteger(width) || !Number.isInteger(height) || width < 8 || height < 8) {
        throw new TypeError("WebGPU optical flow requires integer dimensions of at least 8x8");
      }
      if (width > this.maxWidth || height > this.maxHeight) {
        throw new RangeError(`WebGPU optical flow input ${width}x${height} exceeds ${this.maxWidth}x${this.maxHeight}`);
      }
      const pixelCount = width * height;
      if (!previousLuma || !currentLuma || previousLuma.length < pixelCount || currentLuma.length < pixelCount) {
        throw new RangeError(`WebGPU optical flow needs two luma planes with ${pixelCount} samples`);
      }

      this._busy = true;
      const started = performance.now();
      try {
        const resources = await this._ensureResources(width, height);
        this._assertUsable();
        const previous = previousLuma instanceof Float32Array
          ? previousLuma.subarray(0, pixelCount) : Float32Array.from(previousLuma).subarray(0, pixelCount);
        const current = currentLuma instanceof Float32Array
          ? currentLuma.subarray(0, pixelCount) : Float32Array.from(currentLuma).subarray(0, pixelCount);
        this.device.queue.writeBuffer(resources.imageLevels[0].prev, 0, previous);
        this.device.queue.writeBuffer(resources.imageLevels[0].curr, 0, current);

        await this._checked("optical flow dispatch", () => {
          const paramData = new ArrayBuffer(PARAM_STRIDE * MAX_PARAM_SLOTS);
          const slotRef = { value: 0 };
          const encoder = this.device.createCommandEncoder({ label: "fi-optical-flow" });
          this._downsamplePass(encoder, resources, "prev", paramData, slotRef);
          this._downsamplePass(encoder, resources, "curr", paramData, slotRef);
          this._flowDirection(encoder, resources, "prev", "curr", 0, paramData, slotRef);
          this._flowDirection(encoder, resources, "curr", "prev", resources.finalBytes, paramData, slotRef);
          if (slotRef.value > MAX_PARAM_SLOTS) throw new Error("internal parameter slot overflow");
          encoder.copyBufferToBuffer(resources.result, 0, resources.readback, 0, resources.finalBytes * 2);
          this.device.queue.writeBuffer(resources.params, 0, paramData, 0, slotRef.value * PARAM_STRIDE);
          this.device.queue.submit([encoder.finish()]);
        });
        await Promise.race([
          resources.readback.mapAsync(scope.GPUMapMode.READ),
          this.whenLost.then(error => { throw error; }),
        ]);
        this._assertUsable();
        const copied = resources.readback.getMappedRange().slice(0);
        resources.readback.unmap();
        const floats = new Float32Array(copied);
        return {
          forward: this._decodeMatch(floats, 0, resources),
          backward: this._decodeMatch(floats, resources.finalBytes / 4, resources),
          elapsedMs: performance.now() - started,
        };
      } catch (error) {
        if (this._resources && this._resources.readback.mapState === "mapped") {
          try { this._resources.readback.unmap(); } catch { /* Ignore teardown errors. */ }
        }
        if (error && /WebGPU optical flow/.test(String(error.message || error))) throw error;
        throw unavailable(`estimate failed: ${error && error.message ? error.message : error}`);
      } finally {
        this._busy = false;
      }
    }

    destroy() {
      if (this._destroyed) return;
      this._destroyed = true;
      this.lost = true;
      if (this._resources) {
        this._destroyResources(this._resources);
        this._resources = null;
      }
      try { this.device.destroy(); } catch { /* Already lost. */ }
    }
  }

  async function create(options = {}) {
    if (!scope.isSecureContext) throw unavailable("a secure context is required");
    if (!scope.navigator || !scope.navigator.gpu) throw unavailable("navigator.gpu is not exposed by this browser/GPU");
    if (!scope.GPUBufferUsage || !scope.GPUShaderStage || !scope.GPUMapMode) {
      throw unavailable("required WebGPU constants are missing");
    }

    const maxWidth = Math.max(64, Math.min(960, Number(options.maxWidth) || DEFAULT_MAX_WIDTH));
    const maxHeight = Math.max(64, Math.min(540, Number(options.maxHeight) || DEFAULT_MAX_HEIGHT));
    const iterations = Math.max(3, Math.min(8, Number(options.iterations) || ITERATIONS));
    const adapter = await scope.navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) throw unavailable("no compatible GPU adapter was found");
    const neededStorage = Math.max(maxWidth * maxHeight * 4, Math.ceil(maxWidth / 2) * Math.ceil(maxHeight / 2) * 16);
    if (adapter.limits.maxStorageBufferBindingSize < neededStorage) {
      throw unavailable(`GPU storage-buffer limit is below ${neededStorage} bytes`);
    }

    let device;
    try {
      device = await adapter.requestDevice();
    } catch (error) {
      throw unavailable(`requestDevice failed: ${error.message || error}`);
    }

    try {
      device.pushErrorScope("validation");
      const downsampleModule = device.createShaderModule({ code: DOWNSAMPLE_WGSL, label: "fi-downsample-wgsl" });
      const flowModule = device.createShaderModule({ code: FLOW_WGSL, label: "fi-flow-wgsl" });
      const [downsampleInfo, flowInfo] = await Promise.all([
        downsampleModule.getCompilationInfo(),
        flowModule.getCompilationInfo(),
      ]);
      const compilationErrors = [describeCompilation(downsampleInfo), describeCompilation(flowInfo)].filter(Boolean).join("; ");
      if (compilationErrors) throw new Error(`shader compilation failed: ${compilationErrors}`);

      const downsampleLayout = device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: scope.GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
          { binding: 1, visibility: scope.GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
          { binding: 2, visibility: scope.GPUShaderStage.COMPUTE, buffer: { type: "uniform", hasDynamicOffset: true, minBindingSize: 16 } },
        ],
      });
      const flowLayout = device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: scope.GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
          { binding: 1, visibility: scope.GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
          { binding: 2, visibility: scope.GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
          { binding: 3, visibility: scope.GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
          { binding: 4, visibility: scope.GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
          { binding: 5, visibility: scope.GPUShaderStage.COMPUTE, buffer: { type: "uniform", hasDynamicOffset: true, minBindingSize: 48 } },
        ],
      });
      const [downsamplePipeline, flowPipeline, flowSeedPipeline] = await Promise.all([
        device.createComputePipelineAsync({
          layout: device.createPipelineLayout({ bindGroupLayouts: [downsampleLayout] }),
          compute: { module: downsampleModule, entryPoint: "main" },
          label: "fi-downsample-pipeline",
        }),
        device.createComputePipelineAsync({
          layout: device.createPipelineLayout({ bindGroupLayouts: [flowLayout] }),
          compute: { module: flowModule, entryPoint: "main" },
          label: "fi-flow-pipeline",
        }),
        device.createComputePipelineAsync({
          layout: device.createPipelineLayout({ bindGroupLayouts: [flowLayout] }),
          compute: { module: flowModule, entryPoint: "globalSeed" },
          label: "fi-flow-seed-pipeline",
        }),
      ]);
      const validation = await device.popErrorScope();
      if (validation) throw validation;
      return new FiWebGpuEstimator(
        adapter,
        device,
        downsamplePipeline,
        flowPipeline,
        flowSeedPipeline,
        { downsample: downsampleLayout, flow: flowLayout },
        { maxWidth, maxHeight, iterations },
      );
    } catch (error) {
      try { await device.popErrorScope(); } catch { /* Scope may already be popped. */ }
      try { device.destroy(); } catch { /* Nothing else to clean up. */ }
      throw unavailable(error.message || error);
    }
  }

  scope.FiWebGpu = Object.freeze({ create });
})(globalThis);
