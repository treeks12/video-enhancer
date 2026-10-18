// Behavioral cadence tests for the frame-interpolation clock.
// Run with: node test/cadence.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const coreSource = fs.readFileSync(path.join(root, 'fi-core.js'), 'utf8');
const contentSource = fs.readFileSync(path.join(root, 'content.js'), 'utf8');

function functionSource(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing production function ${name}`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let i = bodyStart; i < source.length; i++) {
    const char = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
    } else if (char === '{') {
      depth++;
    } else if (char === '}' && --depth === 0) {
      return source.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated production function ${name}`);
}

function loadFunctions(source, names, prelude = '') {
  const context = vm.createContext({ console });
  const declarations = names.map(name => functionSource(source, name)).join('\n');
  vm.runInContext(`${prelude}\n${declarations}`, context);
  return { context, get: name => vm.runInContext(name, context) };
}

const core = loadFunctions(coreSource, [
  'fiMidFitsDeadline',
]);
const content = loadFunctions(contentSource, [
  'fiFrameDurationMs',
  'fiMidBudgetMs',
]);
const fitsDeadline = core.get('fiMidFitsDeadline');
const frameDuration = content.get('fiFrameDurationMs');
const midBudget = content.get('fiMidBudgetMs');

function close(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < 1e-6,
    `${message}: expected ${expected}, got ${actual}`);
}

// Metadata must describe wall-clock frame duration at normal and accelerated playback.
for (const fps of [24, 30, 60]) {
  close(frameDuration(NaN, 1 / fps, 1), 1000 / fps, `${fps} fps media clock`);
  close(frameDuration(NaN, 1 / fps, 2), 500 / fps, `${fps} fps at 2x`);
  close(frameDuration(1000 / fps, NaN, 1), 1000 / fps, `${fps} fps display-clock fallback`);
}

// With neither rVFC metadata nor a valid delta, the midpoint budget has a stable 30 fps fallback.
assert.equal(frameDuration(NaN, NaN, 1), 0);
close(midBudget(0, 0), 1000 / 60, 'unknown-source midpoint budget');
close(midBudget(0, 24), 1000 / 48, '24 fps midpoint budget');
close(midBudget(1000 / 60, 24), 1000 / 120, 'observed duration wins over fps estimate');

// The animation-frame fallback only marks a frame fresh when playback-quality
// counters advance; repeated display ticks must not recapture the same video frame.
const fallbackHarness = loadFunctions(contentSource, [
  'resetMetricWindow',
  'fiIsTimingGap',
  'fiFrameDurationMs',
  'recordVideoFrame',
  'publishMetrics',
], `
  let metricWindow = null;
  let metricReport = {}, fiMidPerSec = 0, fiRealPerSec = 0, fiLastExplain = '';
  const fiExplainStatus = () => '', adaptRenderScale = () => {}, effectiveRenderScale = () => 1;
  let animationFrameClock = null;
  let fiResumeGap = false;
  let lastVideoCallbackTime = null;
  let lastVideoFrameDurationMs = 0;
  let lastPlaybackDropped = null;
  let lastPlaybackTotal = null;
  let lastPresentedFrames = null;
  let lastMediaTime = null;
  let lastExpectedDisplayTime = null;
  let scrolling = false;
  let playbackTotal = 10;
  const currentVideo = {
    playbackRate: 1,
    getVideoPlaybackQuality: () => ({
      totalVideoFrames: playbackTotal,
      droppedVideoFrames: 0,
    }),
  };
  const canRender = () => true;
`);
vm.runInContext(`
  globalThis.fallbackFresh = [
    recordVideoFrame(0, null),
    recordVideoFrame(1000 / 60, null),
  ];
  playbackTotal++;
  globalThis.fallbackFresh.push(recordVideoFrame(2000 / 60, null));
`, fallbackHarness.context);
assert.deepEqual(Array.from(fallbackHarness.context.fallbackFresh), [true, false, true]);
vm.runInContext(`
  globalThis.measureFallback = (fps, rate) => {
    resetMetricWindow(0); animationFrameClock = null;
    lastPlaybackDropped = lastPlaybackTotal = lastVideoCallbackTime = null;
    currentVideo.playbackRate = rate;
    for (let i = 0; i <= fps * rate; i++) {
      playbackTotal = i; recordVideoFrame(i * 1000 / (fps * rate), null);
    }
    publishMetrics(1000);
    return { fps: metricReport.videoFps, duration: lastVideoFrameDurationMs };
  };
`, fallbackHarness.context);
for (const [fps, rate] of [[60, 1], [24, 1], [30, 2], [24, 2]]) {
  const measured = fallbackHarness.context.measureFallback(fps, rate);
  close(measured.fps, fps, 'fallback reports source FPS without double-applying playback rate');
  close(measured.duration, 1000 / (fps * rate), 'fallback follows the current wall-clock frame period');
}
fallbackHarness.context.measureFallback(60, 1);
vm.runInContext(`
  for (let i = 1; i <= 24; i++) {
    playbackTotal = 60 + i; recordVideoFrame(1000 + i * 1000 / 24, null);
  }
  globalThis.changedPeriod = lastVideoFrameDurationMs;
`, fallbackHarness.context);
close(fallbackHarness.context.changedPeriod, 1000 / 24, 'same-source FPS changes update the fallback period');
vm.runInContext(`
  globalThis.sampleSeparateClocks = (fps, hz) => {
    resetMetricWindow(0); animationFrameClock = null;
    lastPlaybackDropped = lastPlaybackTotal = lastVideoCallbackTime = null;
    currentVideo.playbackRate = 1; const periods = [];
    for (let tick = 0; tick <= hz * 4; tick++) {
      const now = tick * 1000 / hz;
      playbackTotal = Math.floor(now * fps / 1000 + 1e-7);
      recordVideoFrame(now, null);
      if (now > 2000) periods.push(lastVideoFrameDurationMs);
    }
    return periods;
  };
`, fallbackHarness.context);
for (const [fps, hz] of [[24, 60], [24, 165], [30, 60], [60, 165]]) {
  const periods = Array.from(fallbackHarness.context.sampleSeparateClocks(fps, hz));
  assert.ok(periods.every(ms => Math.abs(ms - 1000 / fps) < .2), 'independent display/source clocks cannot alias into a false FI period');
  assert.ok(Math.max(...periods) - Math.min(...periods) < .2, 'a stable source cannot oscillate between incompatible FI deadlines');
}

const callbackHarness = loadFunctions(contentSource, ['sparseVideoCallbacks'], `
  let useAnimationFallback = false, videoCallbackHealth = null;
  const settings = { fiInfra: true }, document = { hidden: false };
  let lastVideoCallbackTime = 0, lastPresentedFrames = 0, lastMediaTime = null, fiDisplayPeriod = 1000 / 165, fiDisplayReference = 0;
  let displayLag = 0;
  const quality = { totalVideoFrames: 0, droppedVideoFrames: 0 };
  const currentVideo = { paused: false, seeking: false, playbackRate: 1, getVideoPlaybackQuality: () => quality };
  globalThis.reset = () => { videoCallbackHealth = null; lastVideoCallbackTime = lastPresentedFrames = 0;
    quality.totalVideoFrames = quality.droppedVideoFrames = 0; useAnimationFallback = false; lastMediaTime = null;
    currentVideo.paused = currentVideo.seeking = false; currentVideo.playbackRate = 1; document.hidden = false; displayLag = 0; };
  globalThis.frame = (now, frames, total, dropped = 0, mediaTime = NaN) => {
    quality.totalVideoFrames = total; quality.droppedVideoFrames = dropped;
    fiDisplayReference = Math.floor(now / fiDisplayPeriod) * fiDisplayPeriod - displayLag;
    const result = sparseVideoCallbacks(now, { presentedFrames: frames, mediaTime });
    lastVideoCallbackTime = now; lastPresentedFrames = frames; lastMediaTime = mediaTime; return result;
  };
  globalThis.sticky = () => { useAnimationFallback = true; };
  globalThis.rate = value => { currentVideo.playbackRate = value; };
  globalThis.seek = value => { currentVideo.seeking = value; };
  globalThis.display = hz => { fiDisplayPeriod = 1000 / hz; };
  globalThis.pause = value => { currentVideo.paused = value; };
  globalThis.hidden = value => { document.hidden = value; };
  globalThis.lag = value => { displayLag = value; };
`);
const callback = callbackHarness.context;
for (let i = 1; i <= 10; i++) assert.equal(callback.frame(i * 1000 / 60, i, i), false, 'adjacent callbacks retain rVFC');
callback.reset();
for (let i = 1; i < 4; i++) assert.equal(callback.frame(i * 40, i * 2, i * 2), false, 'isolated gaps cannot switch clocks');
assert.equal(callback.frame(160, 8, 8), true, 'sustained sparse callbacks with healthy decoder progress recover through rAF');
callback.sticky();assert.equal(callback.frame(200, 10, 10), false, 'the recovered session stays on its selected clock');
callback.reset();
for (let i = 1; i <= 10; i++) assert.equal(callback.frame(i * 40, i * 2, i * 2, i), false, 'decoder drops are not a callback capability failure');
callback.reset();
for (let i = 1; i <= 10; i++) assert.equal(callback.frame(i * 40, i * 2, 0), false, 'stalled decoder counters cannot authorize fallback');
callback.reset();
let mixedRecovery = false;
for (let i = 1; i <= 20; i++) {
  const frames = i + Math.floor(i / 5);
  mixedRecovery ||= callback.frame(i * 40, frames, frames);
}
assert.equal(mixedRecovery, true, 'regular sparse delivery can include adjacent callbacks, such as 30 fps source with 25 callbacks/s');
callback.reset();
for (let i = 1; i <= 20; i++) {
  const frames = i + (i >= 2 ? 1 : 0);
  assert.equal(callback.frame(i * 1000 / 60, frames, frames), false, 'one isolated missed callback cannot select a different scheduler');
}

// Adjacent frames can still arrive unevenly: mean FPS alone must not mask delivery jitter.
for (const fps of [24, 30]) {
  callback.reset(); callback.display(165);
  let recovered = false;
  for (let i=1;i<=fps*2;i++) {
    const delay=i%2 ? (fps===24 ? 20 : 16) : 0;
    recovered = callback.frame(i*1000/fps+delay,i,i,0,i/fps) || recovered;
  }
  assert.equal(recovered,true,`${fps} fps sustained callback jitter recovers despite adjacent presentation counters`);
}
for (const fps of [24,30,60]) for (const hz of [60,120,144,165]) {
  callback.reset(); callback.display(hz);
  for(let i=1;i<=fps*2;i++) {
    const displayTime=Math.ceil((i*1000/fps-1e-7)/(1000/hz))*(1000/hz);
    assert.equal(callback.frame(displayTime,i,i,0,i/fps),false,`${fps} fps normal ${hz} Hz quantization keeps rVFC`);
  }
}
callback.reset();callback.display(165);
for(let i=1;i<=60;i++)assert.equal(callback.frame(i*1000/30+(i===15?20:0),i,i,0,i/30),false,'one delayed callback with catch-up cannot switch clocks');
// Real variable frame rate follows mediaTime instead of being scheduler jitter.
callback.reset();let variableTime=0;
for(let i=1;i<=60;i++) {
  variableTime+=i%2?60:23.3333333333;
  assert.equal(callback.frame(variableTime,i,i,0,variableTime/1000),false,'VFR media cadence is not callback jitter');
}
callback.reset();let wallTime=0,mediaTime=0;
for(let i=1;i<=90;i++) {
  const rate=i<30?1:i<60?2:.75;callback.rate(rate);
  wallTime+=1000/30/rate;mediaTime+=1/30;
  assert.equal(callback.frame(wallTime,i,i,0,mediaTime),false,'playback-rate changes do not create callback failure');
}
callback.reset();callback.seek(true);
for(let i=1;i<=30;i++)assert.equal(callback.frame(i*1000/24+(i%2?20:0),i,i,0,20+i/24),false,'seeking cannot authorize jitter recovery');
callback.seek(false);
for(let i=31;i<=60;i++)assert.equal(callback.frame(i*1000/24,i,i,0,30+i/24),false,'seek discontinuity followed by regular playback stays on rVFC');
callback.reset();
for(let i=1;i<=60;i++)assert.equal(callback.frame(i*1000/30+(i%2?16:0),i,i,i,i/30),false,'decoder drops disqualify callback-jitter recovery');
callback.reset();
for(let i=1;i<=60;i++)assert.equal(callback.frame(i*1000/30+(i%2?16:0),i,0,0,i/30),false,'stalled decoder cannot authorize jitter recovery');

// Native 24fps failure: delayed callbacks bracket a two-frame catch-up.
// This preserves the source mean and healthy decoding but callback delivery
// itself has repeated late/early residuals rather than merely quantized CFR.
callback.reset();callback.display(165);
let episodeRecovered=false,episodeFrame=0;
for(let i=0;i<48;i++) {
  episodeFrame+=i%12===3?2:1;
  const offset=[0,0,20,-5,0,0,20,0,0,0,0,0][i%12];
  episodeRecovered=callback.frame(episodeFrame*1000/24+offset,episodeFrame,episodeFrame,0,episodeFrame/24)||episodeRecovered;
}
assert.equal(episodeRecovered,true,'recurring delayed/catch-up callback episodes recover even when presentedFrames advances by two');
callback.reset();
for(let i=1;i<=60;i++) {
  const frame=i+(i>=15?1:0);
  assert.equal(callback.frame(frame*1000/24,frame,frame,0,frame/24),false,'an isolated two-frame catch-up with media-aligned delivery does not select fallback');
}

// A delayed callback and its catch-up are one episode; an unrelated
// skipped callback with media-aligned delivery is not a second late event.
callback.reset();let isolatedFrame=0;
for(let i=1;i<=60;i++) {
  isolatedFrame+=(i===16||i===30)?2:1;
  const delay=i===15?20:0;
  assert.equal(callback.frame(isolatedFrame*1000/24+delay,isolatedFrame,isolatedFrame,0,isolatedFrame/24),false,'isolated delay plus catch-up and an unrelated callback skip stay on rVFC');
}
// Two event-loop stalls about 292ms apart must not accumulate callback-only
// evidence: their delayed display clocks invalidate the delivery history.
callback.reset();let stalledFrame=0;
for(let i=1;i<=50;i++) {
  stalledFrame+=(i===16||i===21)?3:1;
  const stalled=i===15||i===20;
  callback.lag(stalled?100:0);
  assert.equal(callback.frame(stalledFrame*1000/24+(stalled?60:0),stalledFrame,stalledFrame,0,stalledFrame/24),false,'global stalls separated by healthy callbacks do not combine into callback-only jitter at callback '+i);
}

// Source changes and globally stalled event loops cannot authorize recovery.
for(const suppress of [()=>callback.pause(true),()=>callback.hidden(true),()=>callback.lag(100)]) {
  callback.reset();callback.display(165);suppress();
  for(let i=1;i<=60;i++)assert.equal(callback.frame(i*1000/24+(i%2?20:0),i,i,0,i/24),false,'paused, hidden or stale display clock disqualifies delivery-jitter fallback');
}
callback.reset();
for(let i=1;i<=12;i++)assert.equal(callback.frame(i*300,i,i,0,i/24),false,'long global stalls do not select a new clock');
callback.reset();
for(let i=1;i<=90;i++) {
  const index=i%15;
  assert.equal(callback.frame(i*1000/30,index,index,0,index/30),false,'source counter/media clock reset cannot select fallback');
}
callback.reset();
for(let i=1;i<=60;i++)assert.equal(callback.frame(i*1000/30,100-i,100-i,0,(100-i)/30),false,'reversed source counters cannot select fallback');

// Exercise the shipped scheduler with a deterministic display clock. Anchors use
// non-zero timestamps because performance.now() is never zero in real extension use.
const schedulerHarness = loadFunctions(`${coreSource}\n${contentSource}`, [
  'fiPresentationPhase',
  'fiMidFitsDeadline',
  'cancelFiMid',
  'fiScheduleMidFrame',
], `
  let clockNow = 1000;
  let nextRaf = 0;
  const rafQueue = new Map();
  const performance = { now: () => clockNow };
  const requestAnimationFrame = callback => {
    const id = ++nextRaf;
    rafQueue.set(id, callback);
    return id;
  };
  const cancelAnimationFrame = id => rafQueue.delete(id);
  const canRender = () => true;
  const settings = { fiInfra: true, mode: 'native' };
  const currentVideo = { playbackRate: 1 };
  const metricReport = { videoFps: 0, gpuMs: 0 };
  let lastVideoFrameDurationMs = 0;
  let fiLastRealCpuMs = 0;
  let fiMidCpuMs = 2;
  let fiMidRaf = null;
  let fiPairSerial = 1;
  let fiMethod = 'webgpu';
  let fiGpuEngine = {kind: 'classic'};
  let feedSessionId = 0;
  const isCurrentFeedSession = () => true;
  let fiNeuralTarget = null, fiNeuralResult = null, fiDisplayReference = 0;
  let fiGpuReadySerial = 1;
  let fiHasCurr = true;
  let fiSkipReason = '';
  let draws = [];
  const draw = options => draws.push(options);
  const log = () => {};

  globalThis.configureScheduler = ({ now, sourceFps, costMs, serial = 1 }) => {
    if (fiMidRaf !== null) cancelAnimationFrame(fiMidRaf);
    rafQueue.clear();
    clockNow = now;
    metricReport.videoFps = sourceFps;
    metricReport.gpuMs = 0;
    lastVideoFrameDurationMs = 1000 / sourceFps;
    fiLastRealCpuMs = costMs;
    fiMidCpuMs = costMs;
    fiMidRaf = null;
    fiPairSerial = serial;
    fiMethod = 'webgpu';
    fiGpuReadySerial = serial;
    fiHasCurr = true;
    fiSkipReason = '';
    draws = [];
  };
  globalThis.scheduleMid = (serial, metadata) => fiScheduleMidFrame(serial, metadata);
  globalThis.runDisplayTick = now => {
    clockNow = now;
    const callbacks = Array.from(rafQueue.values());
    rafQueue.clear();
    callbacks.forEach(callback => callback(now));
  };
  globalThis.changePair = serial => { fiPairSerial = serial; };
  globalThis.schedulerResult = () => ({
    draws: draws.map(value => ({ ...value })),
    pending: rafQueue.size,
    skipReason: fiSkipReason,
  });
`);

function scheduledMid({ sourceFps, displayHz, costMs, metadata = true }) {
  const anchor = 1000;
  schedulerHarness.context.configureScheduler({
    now: anchor, sourceFps, costMs,
  });
  schedulerHarness.context.scheduleMid(1,
    metadata ? { expectedDisplayTime: anchor } : null);
  schedulerHarness.context.runDisplayTick(anchor + 1000 / displayHz);
  return schedulerHarness.context.schedulerResult();
}

// A 60 Hz presentation clock has usable slots for 24/30 fps sources.
let scheduled = scheduledMid({ sourceFps: 24, displayHz: 60, costMs: 8 });
assert.equal(scheduled.draws.length, 1);
close(scheduled.draws[0].fiPhase, 0.4, '24 fps source on 60 Hz');
scheduled = scheduledMid({ sourceFps: 30, displayHz: 60, costMs: 10 });
assert.equal(scheduled.draws.length, 1);
close(scheduled.draws[0].fiPhase, 0.5, '30 fps source on 60 Hz');

// 60 -> 120 fps needs a 120 Hz presentation clock; 60 Hz reaches the next anchor.
scheduled = scheduledMid({ sourceFps: 60, displayHz: 120, costMs: 4 });
assert.equal(scheduled.draws.length, 1);
close(scheduled.draws[0].fiPhase, 0.5, '60 fps source on 120 Hz');
scheduled = scheduledMid({ sourceFps: 60, displayHz: 60, costMs: 0 });
assert.equal(scheduled.draws.length, 0);

// Null metadata anchors to performance.now(); an early display tick reschedules,
// then the next tick presents using the same original anchor.
schedulerHarness.context.configureScheduler({ now: 2000, sourceFps: 24, costMs: 4 });
schedulerHarness.context.scheduleMid(1, null);
schedulerHarness.context.runDisplayTick(2000 + 1000 / 120);
assert.equal(schedulerHarness.context.schedulerResult().draws.length, 0);
assert.equal(schedulerHarness.context.schedulerResult().pending, 1);
schedulerHarness.context.runDisplayTick(2000 + 2000 / 120);
scheduled = schedulerHarness.context.schedulerResult();
assert.equal(scheduled.draws.length, 1);
close(scheduled.draws[0].fiPhase, 0.4, 'metadata-free performance.now anchor');

// A callback belonging to an obsolete pair must never draw.
schedulerHarness.context.configureScheduler({ now: 3000, sourceFps: 30, costMs: 2 });
schedulerHarness.context.scheduleMid(1, { expectedDisplayTime: 3000 });
schedulerHarness.context.changePair(2);
schedulerHarness.context.runDisplayTick(3000 + 1000 / 60);
assert.equal(schedulerHarness.context.schedulerResult().draws.length, 0);

// A midpoint whose measured cost no longer fits is dropped and reports why.
scheduled = scheduledMid({ sourceFps: 30, displayHz: 60, costMs: 16 });
assert.equal(scheduled.draws.length, 0);
assert.match(scheduled.skipReason, /Late midpoint cancelled/);

// Deadline comparison is inclusive at the exact cost + safety-margin boundary.
assert.equal(fitsDeadline(0.5, 1000 / 30, 1000 / 60 - 2, 2), true);
assert.equal(fitsDeadline(0.5, 1000 / 30, 1000 / 60 - 2 + 0.001, 2), false);
assert.equal(fitsDeadline(0, 1000 / 30, 0, 2), false);
assert.equal(fitsDeadline(1, 1000 / 30, 0, 2), false);

// If rVFC reports two presented frames in one callback, normalize the elapsed
// media interval per frame. Otherwise one missed callback doubles the next FI delay.
const recordHarness = loadFunctions(contentSource, [
  'resetMetricWindow',
  'fiIsTimingGap',
  'fiFrameDurationMs',
  'recordVideoFrame',
], `
  let metricWindow = null;
  let fiResumeGap = false;
  let lastVideoCallbackTime = null;
  let lastVideoFrameDurationMs = 0;
  let lastPlaybackDropped = null;
  let lastPlaybackTotal = null;
  let lastPresentedFrames = null;
  let lastMediaTime = null;
  let lastExpectedDisplayTime = null;
  let scrolling = false;
  const currentVideo = { playbackRate: 1 };
  const canRender = () => true;
`);
vm.runInContext(`
  recordVideoFrame(0, {
    presentedFrames: 1, mediaTime: 0, expectedDisplayTime: 0
  });
  recordVideoFrame(1000 / 12, {
    presentedFrames: 3, mediaTime: 2 / 24, expectedDisplayTime: 1000 / 12
  });
  globalThis.observedDuration = lastVideoFrameDurationMs;
`, recordHarness.context);
close(recordHarness.context.observedDuration, 1000 / 24,
  'skipped rVFC callback keeps per-frame duration');
assert.equal(vm.runInContext('fiResumeGap', recordHarness.context), true,
  'non-adjacent frames must invalidate the interpolation pair');
vm.runInContext(`
  lastPresentedFrames = 10;
  lastMediaTime = null;
  lastExpectedDisplayTime = 1000;
  lastVideoFrameDurationMs = 1000 / 30;
  recordVideoFrame(1000 + 2000 / 30, {
    presentedFrames: 12, mediaTime: undefined,
    expectedDisplayTime: 1000 + 2000 / 30
  });
  globalThis.expectedOnlyDuration = lastVideoFrameDurationMs;
`, recordHarness.context);
close(recordHarness.context.expectedOnlyDuration, 1000 / 30,
  'skipped callback normalizes expected-display delta without media time');

console.log('PASS: interpolation cadence covers 24/30/60 fps, fallbacks, skips, and deadlines');

// Neural output has a fixed inferred phase and must never be relabelled after
// arriving at a different display tick. Exercise the actual production branch.
vm.runInContext(`
 globalThis.configureNeural = (target, method='neural') => {
   fiGpuEngine = {kind:'neural'}; fiNeuralTarget=target;
   fiNeuralResult={phase:target.phase}; fiMethod=method;
 };
 globalThis.neuralReady = () => {fiMethod='neural';};
`, schedulerHarness.context);
schedulerHarness.context.configureScheduler({now:5000,sourceFps:30,costMs:1});
schedulerHarness.context.configureNeural({time:5016.667,phase:.5,expires:5026.667});
schedulerHarness.context.scheduleMid(1,{expectedDisplayTime:5000});
schedulerHarness.context.runDisplayTick(5008);assert.equal(schedulerHarness.context.schedulerResult().draws.length,0);
schedulerHarness.context.runDisplayTick(5016.667);assert.equal(schedulerHarness.context.schedulerResult().draws.length,1);assert.equal(schedulerHarness.context.schedulerResult().draws[0].fiPhase,.5);
schedulerHarness.context.configureScheduler({now:6000,sourceFps:30,costMs:1});
schedulerHarness.context.configureNeural({time:6016.667,phase:.5,expires:6026.667},'pending');
schedulerHarness.context.scheduleMid(1,{expectedDisplayTime:6000});schedulerHarness.context.runDisplayTick(6016.667);schedulerHarness.context.neuralReady();schedulerHarness.context.runDisplayTick(6033.334);
assert.equal(schedulerHarness.context.schedulerResult().draws.length,0,'late neural frame must not be displayed');
assert.equal(schedulerHarness.context.schedulerResult().pending,0);
console.log('PASS: neural scheduler preserves inferred phase and drops expired output');

// Congestion during startup must not permanently become the display refresh
// rate. The retained engine must also follow a later display-rate change.
const clock=loadFunctions(contentSource,['fiObserveDisplayCallback','fiMeasureDisplay'],`
 let fiDisplayRaf=null,fiDisplayPeriod=1000/60,fiDisplayReference=0,stopped=false;
 let now=0,fiDisplayCallbackDelayMs=0;const fiDisplayCallbackDelays=[];
 const performance={now:()=>now};
 let settings={fiInfra:true},currentVideo={},document={hidden:false};
 const canRender=()=>true;let next=null,id=0;
 const requestAnimationFrame=cb=>{next=cb;return ++id;};
 globalThis.tickClock=t=>{now=t;const cb=next;next=null;if(cb)cb(t);};
 globalThis.clockState=()=>({period:fiDisplayPeriod,pending:!!next});
 globalThis.disableClock=()=>{settings.fiInfra=false;};
`);
clock.get('fiMeasureDisplay')();let tick=1000;
for(let i=0;i<13;i++)clock.context.tickClock(tick+=1000/30);
close(clock.context.clockState().period,1000/30,'initial congested estimate');
for(let i=0;i<60;i++)clock.context.tickClock(tick+=1000/60);
close(clock.context.clockState().period,1000/60,'healthy display recovers without toggling');
for(let i=0;i<40;i++)clock.context.tickClock(tick+=1000/120);
close(clock.context.clockState().period,1000/120,'retained engine follows display-rate change');
clock.context.disableClock();clock.context.tickClock(tick+1000/120);
assert.equal(clock.context.clockState().pending,false,'disabled interpolation stops its display sampler');
console.log('PASS: rolling display clock recovers after startup congestion and display changes');
