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
