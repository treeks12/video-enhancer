"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, "..");
const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

(async () => {
  const server = http.createServer((request, response) => {
    if (request.url === "/fi-webgpu.js" || request.url === "/fi-core.js") {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      fs.createReadStream(path.join(root, request.url.slice(1))).pipe(response);
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><script src='/fi-core.js'></script><script src='/fi-webgpu.js'></script>");
  });
  const port = await listen(server);
  const browser = await chromium.launch({
    executablePath: edge,
    headless: true,
  });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/`);
    const available = await page.evaluate(() => ({ secure: isSecureContext, gpu: !!navigator.gpu }));
    assert.equal(available.secure, true, "localhost should be a secure context");
    assert.equal(available.gpu, true, "Edge did not expose navigator.gpu");

    const results = await page.evaluate(async () => {
      const width = 128;
      const height = 96;
      let seed = 0x12345678;
      const random = () => {
        seed = (1664525 * seed + 1013904223) >>> 0;
        return seed / 0x100000000;
      };
      const source = new Float32Array(width * height);
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        source[y * width + x] =
          80 + 55 * Math.sin(x * 0.31) + 45 * Math.cos(y * 0.27) +
          30 * Math.sin((x + y) * 0.19) + (random() - 0.5) * 22;
      }
      const sample = (image, x, y) => {
        x = Math.max(0, Math.min(width - 1, x));
        y = Math.max(0, Math.min(height - 1, y));
        const x0 = Math.floor(x), y0 = Math.floor(y);
        const x1 = Math.min(width - 1, x0 + 1), y1 = Math.min(height - 1, y0 + 1);
        const fx = x - x0, fy = y - y0;
        const a = image[y0 * width + x0] * (1 - fx) + image[y0 * width + x1] * fx;
        const b = image[y1 * width + x0] * (1 - fx) + image[y1 * width + x1] * fx;
        return a * (1 - fy) + b * fy;
      };
      const shifted = (dx, dy) => {
        const out = new Float32Array(width * height);
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
          out[y * width + x] = sample(source, x - dx, y - dy);
        }
        return out;
      };
      const summarize = (match, expectedX, expectedY) => {
        const errors = [];
        const xs = [], ys = [];
        for (let gy = 8; gy < match.gridH - 8; gy++) for (let gx = 8; gx < match.gridW - 8; gx++) {
          const i = gy * match.gridW + gx;
          if (match.confidences[i] < 0.12) continue;
          const x = match.mvs[i * 2], y = match.mvs[i * 2 + 1];
          xs.push(x); ys.push(y);
          errors.push(Math.hypot(x - expectedX, y - expectedY));
        }
        errors.sort((a, b) => a - b);
        xs.sort((a, b) => a - b);
        ys.sort((a, b) => a - b);
        return {
          samples: errors.length,
          medianError: errors[Math.floor(errors.length / 2)],
          medianX: xs[Math.floor(xs.length / 2)],
          medianY: ys[Math.floor(ys.length / 2)],
          confidence: match.confidence,
          residual: match.meanResidual,
        };
      };

      const estimator = await FiWebGpu.create({ maxWidth: 480, maxHeight: 270 });
      const cases = [];
      for (const [name, dx, dy] of [
        ["horizontal", 4, 0],
        ["vertical", 0, -3],
        ["subpixel", 1.5, -0.75],
      ]) {
        const estimate = await estimator.estimate(source, shifted(dx, dy), width, height);
        const consistency = fiBidirectionalConsistency(estimate.forward, estimate.backward);
        cases.push({
          name,
          forward: summarize(estimate.forward, dx, dy),
          backward: summarize(estimate.backward, -dx, -dy),
          elapsedMs: estimate.elapsedMs,
          pairConfidence: consistency.confidence,
          shape: [estimate.forward.gridW, estimate.forward.gridH, estimate.forward.block],
        });
      }

      const first = estimator.estimate(source, shifted(1, 1), width, height);
      let concurrentError = "";
      try { await estimator.estimate(source, source, width, height); } catch (error) { concurrentError = error.message; }
      await first;
      const benchmark = [];
      for (const [benchmarkWidth, benchmarkHeight] of [[320, 176], [480, 264]]) {
        const plane = new Float32Array(benchmarkWidth * benchmarkHeight);
        const moved = new Float32Array(benchmarkWidth * benchmarkHeight);
        for (let y = 0; y < benchmarkHeight; y++) for (let x = 0; x < benchmarkWidth; x++) {
          plane[y * benchmarkWidth + x] = 110 + 55 * Math.sin(x * 0.23) + 45 * Math.cos(y * 0.29) + 25 * Math.sin((x + y) * 0.17);
        }
        for (let y = 0; y < benchmarkHeight; y++) for (let x = 0; x < benchmarkWidth; x++) {
          moved[y * benchmarkWidth + x] = plane[y * benchmarkWidth + Math.max(0, x - 3)];
        }
        const estimate = await estimator.estimate(plane, moved, benchmarkWidth, benchmarkHeight);
        benchmark.push({
          size: `${benchmarkWidth}x${benchmarkHeight}`,
          elapsedMs: estimate.elapsedMs,
          confidence: estimate.forward.confidence,
          residual: estimate.forward.meanResidual,
          grid: [estimate.forward.gridW, estimate.forward.gridH],
        });
      }
      let oversizedError = "";
      try { await estimator.estimate(source, source, 481, 96); } catch (error) { oversizedError = error.message; }
      estimator.destroy();
      let destroyedError = "";
      try { await estimator.estimate(source, source, width, height); } catch (error) { destroyedError = error.message; }
      const lost = await estimator.whenLost;
      return { cases, benchmark, concurrentError, oversizedError, destroyedError, lost: lost.message };
    });

    for (const result of results.cases) {
      assert.deepEqual(result.shape, [64, 48, 2]);
      assert.ok(result.forward.samples > 500, `${result.name}: insufficient confident samples`);
      assert.ok(result.forward.medianError < 0.8, `${result.name}: forward median error ${result.forward.medianError}`);
      assert.ok(result.backward.medianError < 0.9, `${result.name}: backward median error ${result.backward.medianError}`);
      assert.ok(result.pairConfidence > 0.52, `${result.name}: pair confidence ${result.pairConfidence}`);
    }
    assert.match(results.concurrentError, /already in flight/);
    assert.deepEqual(results.benchmark.map(item => item.grid), [[160, 88], [240, 132]]);
    assert.ok(results.benchmark.every(item => Number.isFinite(item.elapsedMs) && item.confidence > 0.5));
    assert.match(results.oversizedError, /exceeds 480x270/);
    assert.match(results.destroyedError, /destroyed/);
    assert.match(results.lost, /lost|destroyed/);
    console.log(JSON.stringify(results, null, 2));
    console.log("WebGPU optical-flow tests passed.");
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
