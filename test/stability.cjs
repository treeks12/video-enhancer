// Run with Node and Playwright available (NODE_PATH may point to its installation).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');

(async () => {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><div style="position:relative;width:320px"><video muted autoplay style="width:320px;height:180px"></video></div>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ channel: process.env.TEST_BROWSER || 'msedge', headless: true,
      args: ['--autoplay-policy=no-user-gesture-required'] });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(() => {
      window.chrome = { runtime: { onMessage: { addListener() {} } }, storage: {
        onChanged: { addListener() {} }, local: { get: async defaults => ({ ...defaults,
          mode: 'native', fiInfra: true, fiEngine: 'analytic', interaction: 'quality' }) }
      } };
      const source = document.createElement('canvas');
      source.width = 320; source.height = 180;
      const ctx = source.getContext('2d');
      let frame = 0;
      window.paintSource = () => {
        ctx.fillStyle = '#204080'; ctx.fillRect(0, 0, 320, 180);
        ctx.fillStyle = '#ffcc00'; ctx.fillRect(30 + frame++ % 160, 40, 60, 100);
      };
      paintSource();
      window.source = source;
      window.video = document.querySelector('video');
      video.srcObject = source.captureStream(30);
      window.paintTimer = setInterval(paintSource, 1000 / 30);
      video.play();
    });
    for (const name of ['feed-session.js', 'fi-quality.js', 'fi-core.js', 'fi-analytic.js', 'fi-webgpu.js', 'content.js']) {
      await page.addScriptTag({ content: fs.readFileSync(path.join(root, name), 'utf8') });
    }
    await page.evaluate(() => {
      window.draws = { real: 0, mid: 0, changedMid: 0, block: 0 };
      let anchorPixels;
      const original = draw;
      draw = function(options = {}) {
        original(options);
        if (status !== 'ok') return;
        if (!options.fiMid && !options.newVideoFrame) return;
        const pixels = new Uint8Array(canvas.width * canvas.height * 4);
        gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        if (options.fiMid) {
          draws.mid++;
          if (fiMethod === 'webgpu') draws.block++;
          if (anchorPixels && pixels.some((v, i) => v !== anchorPixels[i])) draws.changedMid++;
        } else { draws.real++; anchorPixels = pixels; }
      };
    });
    try {
      await page.waitForFunction(() => draws.real >= 30 && draws.changedMid >= 5, null, { timeout: 15000 });
    } catch (error) {
      console.log(await page.evaluate(() => ({ draws, snapshot: snapshot() })));
      throw error;
    }
    const initial = await page.evaluate(() => ({ draws, status, opacity: video.style.opacity, fi: snapshot().fi }));
    assert.equal(initial.status, 'ok');
    assert.equal(initial.opacity, '');
    assert.ok(initial.draws.mid >= 5, JSON.stringify(initial));
    console.log('PASS: moving video produces distinct motion-compensated midpoint pixels', initial.draws);

    // A missed callback holds the delayed clock and skips only that interpolation.
    await page.evaluate(() => {
      cancelScheduledFrame();
      lastPresentedFrames = 10; lastMediaTime = 1; lastExpectedDisplayTime = performance.now();
      lastVideoFrameDurationMs = 1000 / 30;
      fiMotionRetryAt = performance.now() + 1000;
      window.expectedRetry = fiMotionRetryAt;
      onFrame(lastExpectedDisplayTime + 2000 / 30, {
        presentedFrames: 12, mediaTime: 1 + 2 / 30,
        expectedDisplayTime: lastExpectedDisplayTime + 2000 / 30,
      });
      cancelScheduledFrame();
      window.gapResult = { pair: fiHasPrev, current: fiHasCurr, presentation: fiLastPresentation,
        preservedBudget: fiMotionRetryAt === expectedRetry, midpointPending: fiMidRaf !== null };
      onFrame(lastExpectedDisplayTime + 1000 / 30, {
        presentedFrames: 13, mediaTime: 1 + 3 / 30,
        expectedDisplayTime: lastExpectedDisplayTime + 1000 / 30,
      });
      window.adjacentPair = fiHasPrev && fiHasCurr;
      cancelScheduledFrame(); resetFiPairState(); resetVideoFrameHistory(); schedule();
    });
    assert.deepEqual(await page.evaluate(() => gapResult), {
      pair: true, current: true, presentation: 'anchor', preservedBudget: true, midpointPending: false,
    });
    assert.equal(await page.evaluate(() => adjacentPair), true);
    console.log('PASS: a missing callback preserves the delayed clock and resumes on adjacent frames');

    // Simulate an rVFC implementation that accepts callbacks but never delivers them.
    await page.evaluate(() => {
      cancelScheduledFrame();
      video.requestVideoFrameCallback = () => 987654;
      schedule();
      window.beforeFallback = draws.real;
    });
    await page.waitForFunction(() => useAnimationFallback && draws.real > beforeFallback + 5);
    const beforeMids = await page.evaluate(() => draws.mid);
    await page.waitForFunction(n => draws.mid > n + 2, beforeMids);
    console.log('PASS: stalled callbacks recover automatically and fallback still interpolates');

    await page.evaluate(() => {
      delete video.requestVideoFrameCallback;
      video.srcObject = null;
      video.load();
    });
    await page.waitForFunction(() => canvas.style.visibility === 'hidden');
    await page.evaluate(() => { video.srcObject = source.captureStream(30); video.play(); });
    await page.waitForFunction(() => status === 'ok' && !useAnimationFallback && fiHasPrev);
    console.log('PASS: changing the source restores playback without toggling');

    await page.evaluate(() => video.pause());
    await page.waitForFunction(() => status === 'ok' && !fiHasPrev && fiLastPresentation === 'current');
    await page.evaluate(() => video.play());
    await page.waitForFunction(() => status === 'ok' && fiHasPrev);
    console.log('PASS: pause displays the current frame and resume rebuilds the pair');

    await page.evaluate(() => {
      applySettings({ ...settings, interaction: 'smooth' });
      suspendOverlayForInteraction();
    });
    assert.equal(await page.evaluate(() => canvas.style.visibility), 'hidden');
    await page.waitForFunction(() => !scrolling && status === 'ok' && canvas.style.visibility === 'visible');
    console.log('PASS: scrolling exposes native video instead of a frozen overlay');

    await page.evaluate(() => {
      const upload = gl.texSubImage2D.bind(gl);
      gl.texSubImage2D = () => { throw new DOMException('frame not ready', 'InvalidStateError'); };
      draw({ newVideoFrame: true });
      gl.texSubImage2D = upload;
    });
    assert.equal(await page.evaluate(() => stopped), false);
    await page.waitForFunction(() => status === 'ok');
    console.log('PASS: a transient upload failure recovers on the next frame');

    // Security errors should affect only the current source, not disable discovery forever.
    await page.evaluate(() => {
      const upload = gl.texSubImage2D.bind(gl);
      gl.texSubImage2D = () => { throw new DOMException('blocked test source', 'SecurityError'); };
      draw({ newVideoFrame: true });
      gl.texSubImage2D = upload;
    });
    assert.deepEqual(await page.evaluate(() => ({ stopped, status, discoveryListeners,
      hidden: canvas.style.visibility })),
    { stopped: false, status: 'tainted', discoveryListeners: true, hidden: 'hidden' });
    await page.evaluate(() => {
      video.srcObject = source.captureStream(30);
      video.play();
    });
    await page.waitForFunction(() => status === 'ok' && !blockedVideo);
    console.log('PASS: blocked source falls back to native and the next source recovers');
    await page.evaluate(() => {
      applySettings({ ...settings, fiInfra: false });
      window.savedQuality = video.getVideoPlaybackQuality.bind(video);
      const frozenQuality = savedQuality();
      video.getVideoPlaybackQuality = () => frozenQuality;
    });
    await page.waitForFunction(() => status === 'buffering' && canvas.style.visibility === 'hidden');
    await page.evaluate(() => { video.getVideoPlaybackQuality = savedQuality; });
    await page.waitForFunction(() => status === 'ok' && canvas.style.visibility === 'visible');
    console.log('PASS: stalled frame counters expose native video and recover with FI disabled');
    assert.equal(await page.evaluate(() => gl.getError()), 0);
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    server.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
