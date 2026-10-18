// Serial native GPU comparison; run manually, never as part of the Node suite.
// TEST_BROWSER=firefox|chromium, HEADLESS=0 for headed, RAVU_ORDER=candidate-first.
// Fresh contexts do not clear browser/driver shader caches: these are observed
// first-use timings, not a promise that every driver cache is empty.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const vm = require('node:vm');
const puppeteer = require('puppeteer-core');
const root = path.resolve(__dirname, '..');
const kind = process.env.TEST_BROWSER || 'firefox';
const ref = process.env.BASELINE_REF || 'HEAD';
assert.ok(['firefox', 'chromium'].includes(kind));
assert.match(ref, /^(?:HEAD|[a-f0-9]{7,40})$/);
const vendor = 'third_party/ravu-lite/ravu-lite-webgl2.js';
const shaders = code => { const scope = {}; vm.runInNewContext(code, scope); return { ...scope.__fvRavuShaders }; };
const baselineCode = cp.execFileSync('git', ['show', ref + ':' + vendor], { cwd: root, encoding: 'utf8' });
const candidateCode = fs.readFileSync(path.join(root, vendor), 'utf8');
const versions = { baseline: shaders(baselineCode), candidate: shaders(candidateCode) };
assert.notEqual(versions.baseline.step1, versions.candidate.step1, 'baseline and candidate must contain different step shaders');
assert.equal(versions.baseline.compose, versions.candidate.compose, 'this candidate changes only step1');
const content = fs.readFileSync(path.join(root, 'content.js'), 'utf8');
const start = content.indexOf('async function linkProgramCooperatively(');
const end = content.indexOf('\nfunction ', start + 1);
assert.ok(start >= 0 && end > start);
const linkHelper = content.slice(start, end);
const vertex = name => { const match = content.match(new RegExp('const ' + name + ' = `([\\s\\S]*?)`;')); assert.ok(match); return match[1]; };
const lutBytes = fs.readFileSync(path.join(root, 'third_party/ravu-lite/ravu-lite-lut3.bin'));
assert.equal(lutBytes.length, 59904);
const lut = Array.from({ length: lutBytes.length / 4 }, (_, i) => lutBytes.readFloatLE(i * 4));
const width = Number(process.env.BENCH_WIDTH || 640), height = Number(process.env.BENCH_HEIGHT || 360);
const iterations = Number(process.env.BENCH_FRAMES || 8), samples = Number(process.env.BENCH_SAMPLES || 7);
for (const [name, value] of Object.entries({ width, height, iterations, samples })) assert.ok(Number.isInteger(value) && value > 0 && value <= 4096, name);
const order = process.env.RAVU_ORDER === 'candidate-first' ? ['candidate', 'baseline'] : ['baseline', 'candidate'];

(async () => {
  let browser;
  try {
    browser = await puppeteer.launch({ browser: kind === 'firefox' ? 'firefox' : 'chrome', headless: process.env.HEADLESS !== '0',
      executablePath: kind === 'firefox' ? (process.env.FIREFOX_PATH || 'C:/Program Files/Mozilla Firefox/firefox.exe') :
        (process.env.CHROMIUM_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'),
      defaultViewport: { width: 1000, height: 750 }, timeout: 60000 });
    const page = await browser.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.bringToFront();
    await page.goto('about:blank');
    const results = {};
    for (const label of order) {
      results[label] = await page.evaluate(async ({ label, shaders, vertices, linkHelper, lut, width, height, iterations, samples }) => {
        const check = (value, message) => { if (!value) throw new Error(message); };
        const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
        const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
        const summarize = values => {
          const a = values.slice().sort((x, y) => x - y);
          return { count: a.length, minMs: a[0] ?? null, p50Ms: a[Math.floor(a.length * .5)] ?? null,
            p95Ms: a[Math.min(a.length - 1, Math.floor(a.length * .95))] ?? null, maxMs: a[a.length - 1] ?? null };
        };
        const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180; document.body.append(canvas);
        const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false });
        check(gl, 'native WebGL2 unavailable');
        check(gl.getExtension('EXT_color_buffer_float'), 'RGBA16F/32F render targets required for the numerical comparison');
        const debug = gl.getExtension('WEBGL_debug_renderer_info');
        const renderer = debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
        const maxWait = gl.getParameter(gl.MAX_CLIENT_WAIT_TIMEOUT_WEBGL), waitNs = typeof maxWait === 'number' && Number.isFinite(maxWait) && maxWait >= 1 ? 1 : 0;
        const timer = gl.getExtension('EXT_disjoint_timer_query_webgl2');
        const calls = [], objects = new WeakMap(), readyAt = new WeakMap(); let activeProgram = '', phase = 'idle', stopped = false;
        for (const method of ['createShader', 'createProgram', 'shaderSource', 'compileShader', 'attachShader', 'linkProgram', 'getProgramParameter', 'getProgramInfoLog']) {
          const original = gl[method].bind(gl);
          gl[method] = (...args) => {
            const begin = performance.now(); let result;
            try {
              result = original(...args);
              if (method === 'getProgramParameter' && args[1] === gl.LINK_STATUS && result) readyAt.set(args[0], performance.now());
              return result;
            }
            finally {
              if ((method === 'createShader' || method === 'createProgram') && result) objects.set(result, activeProgram);
              calls.push({ method, program: objects.get(args[0]) || activeProgram, ms: performance.now() - begin,
                parameter: method === 'getProgramParameter' ? args[1] : undefined });
            }
          };
        }
        const raf = []; let previous = await frame();
        function tick(now) { raf.push({ phase, ms: now - previous }); previous = now; if (!stopped) requestAnimationFrame(tick); }
        requestAnimationFrame(tick);
        await frame(); await frame();
        const link = new Function('gl', linkHelper + '\nreturn linkProgramCooperatively;')(gl);
        phase = 'compile'; const compileStart = performance.now();
        const stages = [...(shaders.classify ? [['classify', vertices.compose, shaders.classify]] : []),
          ['step1', vertices.step1, shaders.step1], ['compose', vertices.compose, shaders.compose]];
        const parallelCompile = Boolean(gl.getExtension('KHR_parallel_shader_compile'));
        const compileOne = async ([name, vert, frag]) => {
          activeProgram = name; const begin = performance.now();
          const program = await link(vert, frag);
          // Readiness is recorded at the successful LINK_STATUS return. An await
          // continuation can run after synchronous sibling work in Promise.all.
          return { name, program, elapsedMs: readyAt.get(program) - begin, promiseObservedMs: performance.now() - begin };
        };
        let linked;
        if (parallelCompile) linked = await Promise.all(stages.map(compileOne));
        else {
          linked = [];
          for (const stage of stages) { if (linked.length) await sleep(16); linked.push(await compileOne(stage)); }
        }
        const compileWallMs = performance.now() - compileStart;
        await frame(); await frame();
        const compileRaf = summarize(raf.filter(item => item.phase === 'compile').map(item => item.ms));
        phase = 'pixels';
        const classify = linked.find(item => item.name === 'classify')?.program;
        const step = linked.find(item => item.name === 'step1').program, compose = linked.find(item => item.name === 'compose').program;
        const uniform = (program, name) => gl.getUniformLocation(program, name);
        const stepSource = uniform(step, 'u_source'), stepLut = uniform(step, 'u_lut');
        const stepClassification = uniform(step, 'u_classification');
        const compSource = uniform(compose, 'u_source'), compPacked = uniform(compose, 'u_packed');
        const sourceSize = uniform(compose, 'u_source_size'), outputTexel = uniform(compose, 'u_output_texel'), compare = uniform(compose, 'u_compare');
        gl.useProgram(step); gl.uniform1i(stepSource, 0); gl.uniform1i(stepLut, 1); gl.uniform1i(stepClassification, 2);
        gl.useProgram(compose); gl.uniform1i(compSource, 0); gl.uniform1i(compPacked, 1); gl.uniform1f(compare, 0);
        if (classify) { gl.useProgram(classify); gl.uniform1i(uniform(classify, 'u_source'), 0); gl.uniform1i(uniform(classify, 'u_gradient_count'), 9); }
        const vao = gl.createVertexArray(), positions = gl.createBuffer();
        gl.bindVertexArray(vao); gl.bindBuffer(gl.ARRAY_BUFFER, positions);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        gl.disable(gl.BLEND); gl.disable(gl.DITHER); gl.disable(gl.DEPTH_TEST); gl.disable(gl.SCISSOR_TEST);
        gl.pixelStorei(gl.PACK_ALIGNMENT, 1); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        function texture(w, h, format, data, linear = false) {
          const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, linear ? gl.LINEAR : gl.NEAREST);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, linear ? gl.LINEAR : gl.NEAREST);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl[format.toUpperCase()], w, h, 0, gl.RGBA, format === 'rgba8' ? gl.UNSIGNED_BYTE : gl.FLOAT, data);
          return tex;
        }
        function target(w, h, format) {
          const tex = texture(w, h, format, null), fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
          gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
          check(gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE, format + ' framebuffer complete');
          return { tex, fb, w, h, format };
        }
        const destroyTarget = target => { gl.deleteFramebuffer(target.fb); gl.deleteTexture(target.tex); };
        const lutTex = texture(13, 288, 'rgba16f', new Float32Array(lut));
        async function drain() {
          const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0); check(sync, 'GPU fence allocation'); gl.flush();
          const start = performance.now(); let polls = 0;
          try {
            while (true) {
              const status = gl.clientWaitSync(sync, 0, waitNs); polls++;
              check(status !== gl.WAIT_FAILED, 'GPU fence failure');
              if (status === gl.ALREADY_SIGNALED || status === gl.CONDITION_SATISFIED) return { ms: performance.now() - start, polls };
              check(performance.now() - start < 30000, 'GPU fence timeout'); await sleep(1);
            }
          } finally { gl.deleteSync(sync); }
        }
        function drawClassification(source, classification) {
          if (!classify) return;
          gl.bindFramebuffer(gl.FRAMEBUFFER, classification.fb); gl.viewport(0, 0, classification.w, classification.h); gl.useProgram(classify);
          gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, source); gl.drawArrays(gl.TRIANGLES, 0, 3);
        }
        function drawStep(source, packed, classification) {
          gl.bindFramebuffer(gl.FRAMEBUFFER, packed.fb); gl.viewport(0, 0, packed.w, packed.h); gl.useProgram(step);
          gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, source);
          gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, lutTex);
          if (classify) { gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, classification.tex); }
          gl.drawArrays(gl.TRIANGLES, 0, 3);
        }
        function drawCompose(source, packed, output) {
          gl.bindFramebuffer(gl.FRAMEBUFFER, output.fb); gl.viewport(0, 0, output.w, output.h); gl.useProgram(compose);
          gl.uniform2f(sourceSize, packed.w, packed.h); gl.uniform2f(outputTexel, 1 / output.w, 1 / output.h);
          gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, source);
          gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, packed.tex); gl.drawArrays(gl.TRIANGLES, 0, 3);
        }
        function read(target) {
          gl.bindFramebuffer(gl.FRAMEBUFFER, target.fb);
          const data = target.format === 'rgba8' ? new Uint8Array(target.w * target.h * 4) : new Float32Array(target.w * target.h * 4);
          gl.readPixels(0, 0, target.w, target.h, gl.RGBA, target.format === 'rgba8' ? gl.UNSIGNED_BYTE : gl.FLOAT, data);
          check(gl.getError() === gl.NO_ERROR, 'float/eight-bit pixel readback supported');
          check(data.every(Number.isFinite), 'finite shader pixels'); return data;
        }
        // Spatially independent tiles exercise constants, impulses, hard edges,
        // texture, angle boundaries, and tiny gradients around lambda thresholds.
        const patterns = [
          ['black', () => 0], ['gray', () => .5], ['white', () => 1], ['impulse', (x, y) => x === 8 && y === 8 ? 1 : 0],
          ['vertical', x => x < 8 ? .1 : .9], ['horizontal', (x, y) => y < 8 ? .1 : .9],
          ['diagonal', (x, y) => x < y ? .1 : .9], ['checker', (x, y) => (x + y) % 2],
          ['texture', (x, y) => .5 + .18 * Math.sin(x * 1.17) + .18 * Math.cos(y * .93)],
          ['flat-epsilon', (x, y) => .5 + (x - 8) * 1e-7 + (y - 8) * 1e-7]
        ];
        for (const lambda of [.004, .016, .05]) for (const side of [-1, 1]) for (const angle of [0, Math.PI / 24, Math.PI / 4]) {
          const slope = lambda * (1 + side * .001), theta = angle + side * 1e-5;
          patterns.push(['gradient-' + lambda + '-' + side + '-' + angle, (x, y) => .5 + slope * ((x - 8) * Math.cos(theta) + (y - 8) * Math.sin(theta))]);
        }
        for (const mu of [.2499, .2501, .4999, .5001]) patterns.push(['coherence-' + mu,
          (x, y) => .5 + .1 * Math.sin(x * Math.PI / 2) + .1 * (1 - mu) / (1 + mu) * Math.sin(y * Math.PI / 2)]);
        patterns.push(['color-texture', (x, y) => [.5 + .4 * Math.sin(x), .5 + .4 * Math.cos(y), (x * 7 + y * 11) % 17 / 16]]);
        const tile = 16, columns = 8, fixtureW = columns * tile, fixtureH = Math.ceil(patterns.length / columns) * tile;
        function pixels(w, h, format, atlas = true) {
          const data = format === 'rgba8' ? new Uint8Array(w * h * 4) : new Float32Array(w * h * 4);
          for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            const index = atlas ? Math.floor(y / tile) * columns + Math.floor(x / tile) : 8;
            const value = patterns[index % patterns.length][1](x % tile, y % tile), rgb = Array.isArray(value) ? value : [value, value, value];
            for (let c = 0; c < 4; c++) { const value = c === 3 ? 1 : Math.max(0, Math.min(1, rgb[c])); data[(y * w + x) * 4 + c] = format === 'rgba8' ? Math.round(value * 255) : value; }
          }
          return data;
        }
        const captures = {}, classificationRows = {}, classificationStats = []; let firstDrawMs = null, firstDrawCompletionMs = null;
        for (const sourceFormat of ['rgba8', 'rgba16f']) {
          const source = texture(fixtureW, fixtureH, sourceFormat, pixels(fixtureW, fixtureH, sourceFormat), true);
          for (const packedFormat of ['rgba8', 'rgba16f']) {
            for (const classificationFormat of ['rgba8', 'rgba16f']) {
              const packed = target(fixtureW, fixtureH, packedFormat), classification = classify ? target(fixtureW, fixtureH, classificationFormat) : null;
              const key = sourceFormat + '/' + packedFormat + '/class-' + classificationFormat;
              const begin = performance.now(); drawClassification(source, classification); drawStep(source, packed, classification); const submittedMs = performance.now() - begin;
              const completion = await drain();
              if (firstDrawMs === null) { firstDrawMs = submittedMs; firstDrawCompletionMs = submittedMs + completion.ms; }
              captures[key + '/packed'] = read(packed);
              if (classify) {
                const data = read(classification), rows = [];
                for (let i = 0; i < data.length; i += 4) {
                  const r = Math.round(data[i] * (classificationFormat === 'rgba8' ? 1 : 255));
                  const g = Math.round(data[i + 1] * (classificationFormat === 'rgba8' ? 1 : 255)), row = r + g * 256;
                  check(Number.isInteger(row) && row >= 0 && row < 288, 'classification row is valid'); rows.push(row);
                }
                const prior = classificationRows[sourceFormat];
                if (prior) check(rows.every((row, i) => row === prior[i]), 'RGBA8 and RGBA16F classification preserve every row');
                else classificationRows[sourceFormat] = rows;
                classificationStats.push({ sourceFormat, packedFormat, classificationFormat, pixels: rows.length,
                  minRow: Math.min(...rows), maxRow: Math.max(...rows), distinctRows: new Set(rows).size });
              }
              for (const outputFormat of ['rgba8', 'rgba32f']) {
                const output = target(fixtureW * 2, fixtureH * 2, outputFormat);
                drawCompose(source, packed, output); await drain(); captures[key + '/composed-' + outputFormat] = read(output); destroyTarget(output);
              }
              destroyTarget(packed); if (classification) destroyTarget(classification);
            }
          }
          gl.deleteTexture(source);
        }
        window.ravuCaptures ||= {}; window.ravuCaptures[label] = captures;
        phase = 'throughput';
        const source = texture(width, height, 'rgba8', pixels(width, height, 'rgba8', false), true);
        const packed = target(width, height, 'rgba16f'), classification = classify ? target(width, height, 'rgba8') : null;
        const output = target(width * 2, height * 2, 'rgba8');
        for (let i = 0; i < 3; i++) { drawClassification(source, classification); drawStep(source, packed, classification); drawCompose(source, packed, output); await drain(); }
        const batches = [];
        for (let sample = 0; sample < samples; sample++) {
          const query = timer ? gl.createQuery() : null, start = performance.now();
          if (query) gl.beginQuery(timer.TIME_ELAPSED_EXT, query);
          for (let i = 0; i < iterations; i++) { drawClassification(source, classification); drawStep(source, packed, classification); drawCompose(source, packed, output); }
          if (query) gl.endQuery(timer.TIME_ELAPSED_EXT);
          const submitMs = performance.now() - start, fence = await drain();
          let gpuMs = null;
          if (query) {
            const queryStart = performance.now();
            while (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) { check(performance.now() - queryStart < 30000, 'GPU timer availability'); await sleep(1); }
            if (!gl.getParameter(timer.GPU_DISJOINT_EXT)) gpuMs = gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6;
            gl.deleteQuery(query);
          }
          batches.push({ submitMs, fenceMs: fence.ms, fencePolls: fence.polls, completionMs: submitMs + fence.ms, gpuMs });
          await frame();
        }
        check(gl.getError() === gl.NO_ERROR, 'no WebGL error'); check(!gl.isContextLost(), 'context remains valid');
        phase = 'done'; await frame(); stopped = true;
        const throughputRaf = summarize(raf.filter(item => item.phase === 'throughput').map(item => item.ms));
        const result = { renderer, parallelCompile, maxClientWaitNs: maxWait, fenceWaitNs: waitNs,
          compile: { wallMs: compileWallMs, serialGapMs: parallelCompile ? 0 : 16,
            programs: linked.map(({ name, elapsedMs, promiseObservedMs }) => {
              const ownCalls = calls.filter(call => call.program === name);
              return { name, elapsedMs, promiseObservedMs, cpuCallsMs: ownCalls.reduce((sum, call) => sum + call.ms, 0),
                linkStatusMs: ownCalls.filter(call => call.method === 'getProgramParameter' && call.parameter === gl.LINK_STATUS).reduce((sum, call) => sum + call.ms, 0),
                maxCallMs: Math.max(0, ...ownCalls.map(call => call.ms)) };
            }), raf: compileRaf, calls }, firstDrawMs, firstDrawCompletionMs,
          pixelFixture: { width: fixtureW, height: fixtureH, patterns: patterns.map(item => item[0]), captures: Object.keys(captures).length, classificationStats },
          throughput: { source: { width, height }, output: { width: width * 2, height: height * 2 }, iterations, batches,
            observedCompletionPerFrame: summarize(batches.map(item => item.completionMs / iterations)),
            gpuPerFrame: summarize(batches.filter(item => item.gpuMs !== null).map(item => item.gpuMs / iterations)), raf: throughputRaf } };
        destroyTarget(packed); destroyTarget(output); if (classification) destroyTarget(classification); gl.deleteTexture(source); gl.deleteTexture(lutTex);
        gl.deleteBuffer(positions); gl.deleteVertexArray(vao); gl.deleteProgram(step); gl.deleteProgram(compose);
        if (classify) gl.deleteProgram(classify);
        gl.getExtension('WEBGL_lose_context')?.loseContext(); canvas.remove(); return result;
      }, { label, shaders: versions[label], vertices: { step1: vertex('VERT'), compose: vertex('VERT_PLAIN') }, linkHelper, lut, width, height, iterations, samples });
    }
    const comparison = await page.evaluate(() => {
      const before = window.ravuCaptures.baseline, after = window.ravuCaptures.candidate;
      if (!before || !after) throw new Error('both shader versions rendered');
      const result = [];
      for (const key of Object.keys(before)) {
        const a = before[key], b = after[key]; if (!b || a.length !== b.length || a.constructor !== b.constructor) throw new Error('matching pixel capture ' + key);
        let changed = 0, changedPixels = 0, totalAbsDelta = 0, rgbAbsDelta = 0, maxAbsDelta = 0, maxUlpDelta = 0, firstDifference = null;
        const ua = a instanceof Float32Array ? new Uint32Array(a.buffer) : null, ub = ua ? new Uint32Array(b.buffer) : null;
        const ordered = bits => bits & 0x80000000 ? 0x80000000 - (bits & 0x7fffffff) : 0x80000000 + bits;
        for (let i = 0; i < a.length; i += 4) if (Array.from({ length: 4 }, (_, c) => c).some(c => a[i + c] !== b[i + c])) changedPixels++;
        for (let i = 0; i < a.length; i++) {
          if (a[i] !== b[i]) { changed++; firstDifference ||= { index: i, baseline: a[i], candidate: b[i] }; }
          maxAbsDelta = Math.max(maxAbsDelta, Math.abs(a[i] - b[i]));
          totalAbsDelta += Math.abs(a[i] - b[i]);
          if (i % 4 < 3) rgbAbsDelta += Math.abs(a[i] - b[i]);
          if (ua) maxUlpDelta = Math.max(maxUlpDelta, Math.abs(ordered(ua[i]) - ordered(ub[i])));
        }
        result.push({ key, components: a.length, changed, changedComponentFraction: changed / a.length,
          changedPixels, changedPixelFraction: changedPixels / (a.length / 4), meanAbsDelta: totalAbsDelta / a.length,
          rgbMeanAbsDelta: key.endsWith('/packed') ? null : rgbAbsDelta / (a.length * .75),
          maxAbsDelta, maxUlpDelta: ua ? maxUlpDelta : null, firstDifference });
      }
      return result;
    });
    console.log(JSON.stringify({ browser: await browser.version(), ref, order, note: 'Fresh contexts; driver caches uncontrolled. Throughput is measured, not a universal FPS guarantee.', results, comparison, errors }, null, 2));
    assert.deepEqual(errors, []);
    assert.equal(comparison.length, 24);
    // The independent CPU oracle requires exact source-level operation order.
    // Native output is allowed at most one eight-bit output quantization step,
    // with a separate tight mean bound. This is a visual regression budget,
    // not a claim of bit identity or a proven cause for compiler differences.
    for (const item of comparison) {
      const maximum = item.maxUlpDelta === null ? 1 : 1 / 255, mean = item.maxUlpDelta === null ? .002 : 1e-5;
      const observedMean = item.rgbMeanAbsDelta ?? item.meanAbsDelta;
      assert.ok(item.maxAbsDelta <= maximum && observedMean <= mean, 'native GPU pixels: ' + item.key +
        ' (max delta ' + item.maxAbsDelta + '/' + maximum + ', mean ' + observedMean + '/' + mean + ')');
    }
    console.log('PASS: baseline/candidate native pixels stay within explicit quantization and mean bounds; compile and steady queue costs reported.');
  } finally { if (browser) await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
