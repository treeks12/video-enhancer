"use strict";

const params = new URLSearchParams(location.search);
const WIDTH = 640;
const HEIGHT = 360;
const PADDED_WIDTH = 640;
const PADDED_HEIGHT = 384;
const MODEL_URL = "./vendor/rife.onnx";
const warmups = Math.max(1, Number(params.get("warmup")) || 3);
const runs = Math.max(5, Number(params.get("runs")) || 20);
const requestedProvider = params.get("provider") || "auto";
const gpuOutput = params.get("gpuOutput") === "1";

const runButton = document.querySelector("#run");
const reportEl = document.querySelector("#report");
const verdictEl = document.querySelector("#verdict");
const outputCanvas = document.querySelector("#output");
outputCanvas.width = WIDTH;
outputCanvas.height = HEIGHT;
document.querySelector("#shape").textContent =
  `${WIDTH}×${HEIGHT}, padding para ${PADDED_WIDTH}×${PADDED_HEIGHT}`;

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
}

function imageReady(image) {
  if (image.complete && image.naturalWidth) return Promise.resolve();
  return new Promise((resolve, reject) => {
    image.addEventListener("load", resolve, { once: true });
    image.addEventListener("error", () => reject(new Error(`Falha ao carregar ${image.src}`)), { once: true });
  });
}

function paddedPixels(image) {
  const canvas = document.createElement("canvas");
  canvas.width = PADDED_WIDTH;
  canvas.height = PADDED_HEIGHT;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(image, 0, 0, WIDTH, HEIGHT);
  return context.getImageData(0, 0, WIDTH, PADDED_HEIGHT).data;
}

function makeInput(frameA, frameB) {
  const plane = PADDED_WIDTH * PADDED_HEIGHT;
  const input = new Float32Array(plane * 6);
  for (let p = 0, rgba = 0; p < plane; p++, rgba += 4) {
    input[p] = frameA[rgba] / 255;
    input[plane + p] = frameA[rgba + 1] / 255;
    input[plane * 2 + p] = frameA[rgba + 2] / 255;
    input[plane * 3 + p] = frameB[rgba] / 255;
    input[plane * 4 + p] = frameB[rgba + 1] / 255;
    input[plane * 5 + p] = frameB[rgba + 2] / 255;
  }
  return input;
}

function drawOutput(tensor) {
  if (!tensor || tensor.dims.length !== 4 || tensor.dims[1] !== 3) {
    throw new Error(`Saída inesperada: ${JSON.stringify(tensor && tensor.dims)}`);
  }
  const data = tensor.data;
  const plane = tensor.dims[2] * tensor.dims[3];
  const image = new ImageData(WIDTH, HEIGHT);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const p = y * tensor.dims[3] + x;
      const rgba = (y * WIDTH + x) * 4;
      image.data[rgba] = Math.round(Math.max(0, Math.min(1, data[p])) * 255);
      image.data[rgba + 1] = Math.round(Math.max(0, Math.min(1, data[plane + p])) * 255);
      image.data[rgba + 2] = Math.round(Math.max(0, Math.min(1, data[plane * 2 + p])) * 255);
      image.data[rgba + 3] = 255;
    }
  }
  outputCanvas.getContext("2d").putImageData(image, 0, 0);
}

async function gpuInfo() {
  if (!navigator.gpu) return { available: false };
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) return { available: false };
  const info = adapter.info || (adapter.requestAdapterInfo ? await adapter.requestAdapterInfo() : {});
  return {
    available: true,
    adapter: [info.vendor, info.architecture, info.device, info.description].filter(Boolean).join(" · ") || "não exposto",
  };
}

async function measureProvider(provider, inputData) {
  const options = {
    executionProviders: [provider],
    graphOptimizationLevel: "all",
  };
  if (provider === "webgpu" && gpuOutput) options.preferredOutputLocation = "gpu-buffer";
  const loadStart = performance.now();
  let session = await ort.InferenceSession.create(MODEL_URL, options);
  const loadMs = performance.now() - loadStart;
  if (session.inputNames.length !== 1 || session.outputNames.length !== 1) {
    session.release();
    throw new Error(`Modelo incompatível: inputs=${session.inputNames}, outputs=${session.outputNames}`);
  }

  try {
    const input = new ort.Tensor("float32", inputData, [1, 6, PADDED_HEIGHT, PADDED_WIDTH]);
    const feeds = { [session.inputNames[0]]: input };
    let output;
    for (let i = 0; i < warmups; i++) {
      const result = await session.run(feeds);
      result[session.outputNames[0]].dispose?.();
    }

    const samples = [];
    for (let i = 0; i < runs; i++) {
      const start = performance.now();
      const result = await session.run(feeds);
      if (provider === "webgpu" && gpuOutput) {
        await ort.env.webgpu.device.queue.onSubmittedWorkDone();
      }
      samples.push(performance.now() - start);
      output?.dispose?.();
      output = result[session.outputNames[0]];
    }
    return { session, output, loadMs, samples };
  } catch (error) {
    session.release();
    session = null;
    throw error;
  }
}

async function benchmark() {
  if (!globalThis.ort) throw new Error("ORT local ausente. Execute vendor.ps1.");
  if (!['auto', 'webgpu', 'wasm'].includes(requestedProvider)) {
    throw new Error("provider deve ser auto, webgpu ou wasm");
  }

  ort.env.wasm.wasmPaths = {
    mjs: new URL("./vendor/ort-wasm-simd-threaded.asyncify.mjs?v=1.27.0", location.href).href,
    wasm: new URL("./vendor/ort-wasm-simd-threaded.asyncify.wasm?v=1.27.0", location.href).href,
  };
  ort.env.wasm.numThreads = crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
  ort.env.logLevel = "warning";

  const gpu = await gpuInfo();
  const prepStart = performance.now();
  const [frameAEl, frameBEl] = [document.querySelector("#frameA"), document.querySelector("#frameB")];
  await Promise.all([imageReady(frameAEl), imageReady(frameBEl)]);
  const inputData = makeInput(paddedPixels(frameAEl), paddedPixels(frameBEl));
  const prepMs = performance.now() - prepStart;

  const attempts = requestedProvider === "auto"
    ? ["webgpu", "wasm"]
    : [requestedProvider];
  const failures = [];
  let measured;
  let provider;
  for (const candidate of attempts) {
    if (candidate === "webgpu" && !gpu.available) {
      failures.push("WebGPU: navigator.gpu/adapter indisponível");
      continue;
    }
    try {
      measured = await measureProvider(candidate, inputData);
      provider = candidate;
      break;
    } catch (error) {
      failures.push(`${candidate}: ${error.message || error}`);
    }
  }
  if (!measured) throw new Error(failures.join("\n"));

  if (measured.output.location === "gpu-buffer") await measured.output.getData();
  const renderStart = performance.now();
  drawOutput(measured.output);
  const renderMs = performance.now() - renderStart;
  const p50 = percentile(measured.samples, 0.5);
  const p95 = percentile(measured.samples, 0.95);
  const timingPassed = provider === "webgpu" && p50 <= 12 && p95 <= 15;
  // ORT Web does not expose per-operator partitioning, so timing alone cannot
  // prove the product requirement that every operator stayed on WebGPU.
  const productGatePassed = false;
  verdictEl.textContent = provider === "webgpu"
    ? (timingPassed ? "PASS tempo; gate de fallback inconclusivo" : "FAIL orçamento")
    : "WASM fallback (diagnóstico)";
  verdictEl.className = productGatePassed ? "pass" : "fail";

  const result = {
    provider,
    requestedProvider,
    webgpu: gpu,
    shape: [1, 6, PADDED_HEIGHT, PADDED_WIDTH],
    warmups,
    runs,
    gpuOutput,
    loadMs: Number(measured.loadMs.toFixed(2)),
    preparationMs: Number(prepMs.toFixed(2)),
    inferenceP50Ms: Number(p50.toFixed(2)),
    inferenceP95Ms: Number(p95.toFixed(2)),
    inferenceMinMs: Number(Math.min(...measured.samples).toFixed(2)),
    inferenceMaxMs: Number(Math.max(...measured.samples).toFixed(2)),
    outputRenderMs: Number(renderMs.toFixed(2)),
    copies: provider === "webgpu" ? {
      input: "CPU Float32Array -> upload GPU em cada session.run (incluído na amostra)",
      output: gpuOutput
        ? "permanece em GPU durante a amostra; um readback final ocorre fora da medição"
        : "GPU -> tensor CPU em cada session.run (incluído na amostra)",
      canvas: "tensor CPU -> ImageData, medido separadamente",
    } : {
      input: "tensor CPU/WASM; sem upload WebGPU",
      output: "tensor CPU/WASM",
      canvas: "tensor CPU -> ImageData, medido separadamente",
    },
    operatorFallback: provider === "webgpu"
      ? "A API pública confirma a sessão WebGPU, mas não expõe por operador eventual partição para WASM."
      : "sessão WASM explícita",
    budget: { p50Ms: 12, p95Ms: 15, timingPassed, productGatePassed },
    fallbackReasons: failures,
  };
  reportEl.textContent = JSON.stringify(result, null, 2);
  measured.output.dispose?.();
  measured.session.release();
}

runButton.addEventListener("click", async () => {
  runButton.disabled = true;
  verdictEl.textContent = "medindo…";
  verdictEl.className = "";
  reportEl.textContent = "Carregando modelo e compilando kernels…";
  try {
    await benchmark();
  } catch (error) {
    verdictEl.textContent = "FAIL";
    verdictEl.className = "fail";
    reportEl.textContent = error.stack || String(error);
  } finally {
    runButton.disabled = false;
  }
});
