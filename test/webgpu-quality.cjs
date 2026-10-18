// Ground-truth frames are generated at t=0, 0.5, 1. Only endpoints reach FI.
// Uses the shipped WebGPU estimator, MV upload and WebGL shader, not a reimplementation.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const http = require('node:http');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const sourceRoot = process.env.FI_SOURCE_ROOT || root;

(async () => {
  const server = http.createServer((req,res)=>res.end('<!doctype html><body></body>'));
  await new Promise(resolve=>server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: process.env.TEST_BROWSER || 'msedge', headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(() => {
      window.chrome = { runtime: { onMessage: { addListener() {} } }, storage: {
        onChanged: { addListener() {} }, local: { get: async defaults => ({ ...defaults, mode: 'off' }) }
      } };
    });
    for (const file of ['fi-core.js', 'fi-webgpu.js', 'content.js']) {
      await page.addScriptTag({ content: fs.readFileSync(path.join(sourceRoot, file), 'utf8') });
    }
    const results = await page.evaluate(async () => {
      settings = normalizeSettings({ mode: 'native', fiInfra: true, interaction: 'quality' });
      if (!createOverlay()) throw new Error('WebGL unavailable');
      const engine = await FiWebGpu.create();
      const decide = async () => {
        const score = fiSceneCutScore(fiPrevLuma, fiCurrLuma);
        if (fiIsSceneCut(score) && fiSceneDistributionChange(fiPrevLuma, fiCurrLuma) > .35) {
          fiMethod = 'duplicate'; return;
        }
        const result = await engine.estimate(fiPrevLuma, fiCurrLuma, fiLumaW, fiLumaH);
        const pair = fiBidirectionalConsistency(result.forward,result.backward);
        fiConfidence = pair.confidence;
        fiLastMatch = result.forward; fiLastBackwardMatch = result.backward;
        if ((fiIsSceneCut(score) && pair.confidence < .2 && Math.min(result.forward.meanResidual,result.backward.meanResidual)>18)) { fiMethod='duplicate'; return; }
        fiLastMatch.confidences=pair.forward; fiLastBackwardMatch.confidences=pair.backward;
        gl.activeTexture(gl.TEXTURE0);
        fiForwardMvTexture=fiUploadMvTexture(fiLastMatch,fiForwardMvTexture);
        fiBackwardMvTexture=fiUploadMvTexture(fiLastBackwardMatch,fiBackwardMvTexture);
        fiGpuReadySerial=fiPairSerial; fiMethod='webgpu';
      };
      const W = 320, H = 176;
      textureWidth = W; textureHeight = H;
      fiEnsureFrameTextures(W, H);
      const pattern = (x, y) => 120 + 38 * Math.sin(x * .37 + y * .11) +
        30 * Math.cos(y * .41 - x * .07) + 20 * Math.sin(x * .73 + y * .53);
      const fixtures = [
        { name: 'static', dx: 0, dy: 0 },
        { name: 'subpixel-pan', dx: 1, dy: .5 },
        { name: 'diagonal-pan', dx: 6, dy: 4 },
        { name: 'fast-pan', dx: 16, dy: 0 },
        { name: 'opposing-motion', dx: 6, dy: 0, split: true },
        { name: 'foreground-occlusion', dx: 8, dy: 0, object: true },
        { name: 'fixed-subtitles', dx: 6, dy: 2, subtitles: true },
        { name: 'scene-cut', dx: 0, dy: 0, cut: true },
        { name: 'same-histogram-cut', dx: 0, dy: 0, textureCut: true },
        { name: 'textured-pan', dx: 4, dy: 2, varied: true },
        { name: 'textured-fast-pan', dx: 12, dy: 4, varied: true },
      ];
      const render = (fixture, t) => {
        const c = document.createElement('canvas'); c.width = W; c.height = H;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        const pixels = ctx.createImageData(W, H);
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
          const i = (y * W + x) * 4;
          const sign = fixture.split && y >= H / 2 ? -1 : 1;
          let value = pattern(x - sign * fixture.dx * t, y - fixture.dy * t);
          if (fixture.varied) {
            const px = (x - fixture.dx * t) / 4, py = (y - fixture.dy * t) / 4;
            const ix = Math.floor(px), iy = Math.floor(py), fx = px - ix, fy = py - iy;
            const noise = (nx, ny) => {
              let seed = Math.imul(nx + 97, 73856093) ^ Math.imul(ny + 71, 19349663);
              seed = Math.imul(seed ^ (seed >>> 16), 2246822519);
              return ((seed ^ (seed >>> 13)) & 255);
            };
            value = value * .35 + .65 * ((noise(ix,iy) * (1-fx) + noise(ix+1,iy) * fx) * (1-fy) +
              (noise(ix,iy+1) * (1-fx) + noise(ix+1,iy+1) * fx) * fy);
          }
          if (fixture.object) {
            value = pattern(x, y) * .5;
            const ox = x - fixture.dx * t;
            if (ox >= 80 && ox < 208 && y >= 32 && y < 144) value = pattern(ox + 23, y + 11);
          }
          if (fixture.subtitles && y >= 128 && y < 140 && x > 40 && x < 280 && x % 14 < 9) value = 245;
          if (fixture.cut) value = t < .5 ? 25 : 225;
          if (fixture.textureCut) {
            let seed = Math.imul((x >> 2) + 47, 73856093) ^ Math.imul((y >> 2) + 53, 19349663) ^ (t < .5 ? 0 : 83492791);
            seed = Math.imul(seed ^ (seed >>> 16), 2246822519);
            value = (seed ^ (seed >>> 13)) & 255;
          }
          pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = value;
          pixels.data[i + 3] = 255;
        }
        ctx.putImageData(pixels, 0, 0);
        return { canvas: c, pixels: pixels.data };
      };
      const sample = c => {
        const size = fiLumaSampleSize(W, H, true);
        const small = document.createElement('canvas'); small.width = size.width; small.height = size.height;
        const ctx = small.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(c, 0, 0, small.width, small.height);
        fiLumaW = small.width; fiLumaH = small.height;
        return fiRgbaToLuma(ctx.getImageData(0, 0, small.width, small.height).data, small.width * small.height);
      };
      const mae = (a, b) => {
        let sum = 0, n = 0;
        for (let y = 16; y < H - 16; y++) for (let x = 16; x < W - 16; x++) {
          const i = (y * W + x) * 4;
          sum += Math.abs(a[i] - b[i]); n++;
        }
        return sum / n;
      };
      const measured = [];
      for (const fixture of fixtures) {
        const prev = render(fixture, 0), truth = render(fixture, .5), curr = render(fixture, 1);
        resetFiPairState();
        fiHasPrev = fiHasCurr = true;
        fiPrevLuma = sample(prev.canvas); fiCurrLuma = sample(curr.canvas);
        gl.activeTexture(gl.TEXTURE0);
        for (const [tex, c] of [[fiPrevTexture, prev.canvas], [fiCurrTexture, curr.canvas]]) {
          gl.bindTexture(gl.TEXTURE_2D, tex);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
        }
        // Warm up JS and shaders before collecting GPU roundtrip timings.
        for (let i = 0; i < 2; i++) { fiSceneCutHold = 0; await decide(); fiRenderMidToOut(.5); }
        const times = [];
        for (let i = 0; i < 8; i++) {
          fiSceneCutHold = 0;
          const start = performance.now(); await decide(); times.push(performance.now() - start);
        }
        times.sort((a, b) => a - b);
        const method = fiMethod;
        let actual;
        if (method === 'duplicate' || method === 'skip') actual = prev.pixels;
        else {
          if (!fiRenderMidToOut(.5)) throw new Error('Interpolation render failed');
          fiBindOutTarget(); actual = new Uint8Array(W * H * 4);
          gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, actual);
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        }
        const blend = Uint8Array.from(prev.pixels, (v, i) => (v + curr.pixels[i]) / 2);
        const picture = pixels => {
          const c = document.createElement('canvas'); c.width = W; c.height = H;
          c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(pixels), W, H), 0, 0);
          return c.toDataURL();
        };
        if (gl.getError() !== gl.NO_ERROR) throw new Error('WebGL error in ' + fixture.name);
        measured.push({ name: fixture.name, method, confidence: fiConfidence,
          residual: fiLastMatch ? fiLastMatch.meanResidual : null,
          motionX: fiLastMatch ? fiLastMatch.mvs.filter((_, i) => i % 2 === 0).reduce((a, b) => a + b, 0) / fiLastMatch.confidences.length : null,
          mae: mae(actual, truth.pixels), blendMae: mae(blend, truth.pixels),
          holdMae: mae(prev.pixels, truth.pixels), roundtripMedianMs: times[4], roundtripMaxMs: times[7],
          pictures: { truth: picture(truth.pixels), blend: picture(blend), output: picture(actual) } });
      }
      engine.destroy();
      return measured;
    });
    const numbers = results.map(({ pictures, ...r }) => r);
    console.table(numbers.map(r => Object.fromEntries(Object.entries(r).map(([k,v]) => [k, typeof v === 'number' ? +v.toFixed(3) : v]))));
    assert.equal(results.find(r => r.name === 'static').mae, 0);
    assert.equal(results.find(r => r.name === 'scene-cut').method, 'duplicate');
    assert.equal(results.find(r => r.name === 'same-histogram-cut').method, 'duplicate');
    for (const r of results.filter(r => r.name.startsWith('textured-'))) {
      assert.equal(r.method, 'webgpu', `${r.name}: reliable translated texture must be interpolated`);
      assert.ok(r.mae < r.blendMae * .8, `${r.name}: output must improve on simple blending`);
    }
    if (!process.env.FI_SOURCE_ROOT) for (const r of results.filter(r => !r.name.includes('cut') && r.name !== 'static')) {
      assert.ok(Number.isFinite(r.mae), `${r.name}: invalid rendered pixels`);
      assert.ok(r.mae < r.blendMae * .9, `${r.name}: motion synthesis must improve on blending`);
    }
    if (process.env.FI_REPORT) fs.writeFileSync(process.env.FI_REPORT, JSON.stringify(numbers, null, 2) + '\n');
    if (process.env.FI_VISUAL_REPORT) {
      const baseline = JSON.parse(fs.readFileSync(path.join(__dirname, 'interpolation-current.json'), 'utf8'));
      fs.writeFileSync(process.env.FI_VISUAL_REPORT, `<!doctype html><meta charset="utf-8"><title>Interpolação — comparação</title>
        <style>body{font:16px system-ui;background:#131820;color:#eee;max-width:1100px;margin:40px auto;padding:20px}h1{color:#7ee4c5}p{line-height:1.6}section{border-top:1px solid #38414d;padding:20px 0}.frames{display:flex;gap:16px;flex-wrap:wrap}figure{margin:0}img{width:320px;max-width:100%}figcaption{margin:8px 0;color:#b9c6d7}small{color:#b9c6d7}</style>
        <h1>Interpolação: referência × resultado</h1><p>Cenas sintéticas de 320 × 176 pixels com posição intermediária conhecida. Apenas os frames anterior e seguinte são fornecidos ao algoritmo. O resultado usa o shader WebGL e o estimador da extensão. MAE: erro médio absoluto de luminância (0–255), menor é melhor; bordas externas de 16 pixels excluídas.</p>
        <p>Antes: versão 0.0.58 (CPU). Depois: WebGPU 0.0.60, com confiança local. Os tempos medem estimativa bidirecional, submissão, espera pela GPU, leitura e envio dos vetores ao WebGL no Edge local, com amostra de 320 × 176; não incluem decodificação, captura nem upscale. O benchmark de imagem aguarda o cálculo completo sem impor o prazo da reprodução; o player real descarta resultados atrasados. São 8 medições após aquecimento. Estes resultados não representam uma avaliação de filmes reais.</p>
        ${results.map(r => `<section><h2>${r.name}</h2><p>MAE antes: ${baseline.find(b => b.name === r.name)?.mae.toFixed(2) ?? '—'} · depois: ${r.mae.toFixed(2)} · mistura simples: ${r.blendMae.toFixed(2)}<br>WebGPU + transferência mediana / máximo: ${r.roundtripMedianMs.toFixed(1)} / ${r.roundtripMaxMs.toFixed(1)} ms · método: ${r.method}</p>
        ${r.name.includes('cut') ? '<p>Em cortes, a extensão mantém a âncora anterior até o próximo instante de apresentação; não mistura cenas. O erro contra um corte no meio do intervalo não mede a qualidade do fluxo óptico.</p>' : ''}
        <div class="frames">${[['truth','Referência intermediária'],['blend','Mistura simples'],['output','Resultado da extensão']].map(([key,label]) => `<figure><img src="${r.pictures[key]}" alt="${label}"><figcaption>${label}</figcaption></figure>`).join('')}</div></section>`).join('')}`);
    }
  } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
