'use strict';

// CPU-only lifecycle checks against the production feed-selection functions.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { FeedSessionManager, sourceKey } = require('../feed-session.js');

const source = fs.readFileSync(path.join(__dirname, '../content.js'), 'utf8');
function section(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `source section exists: ${startMarker}`);
  return source.slice(start, end);
}
const production = [
  section('function visibleArea(', 'const DEFAULT_SETTINGS'),
  section('function ensureFeedSessionManager(', 'function canRender('),
  section('function canRender(', 'function updateCanvasVisibility('),
  section('function updateCanvasVisibility(', 'function modeDisplayName('),
  section('function markDirty(', 'function observeVideoLayout('),
  section('function observeVideoLayout(', 'function scheduleRescan('),
  section('function scheduleRescan(', 'function handleVisibilityChange('),
  section('function ensureVideoIntersectionObserver(', 'function attachActivePageListeners('),
  section('function attachActivePageListeners(', 'function handleVideoReset('),
  section('function handleVideoReset(', 'function handleVideoIntersection('),
  section('function handleVideoIntersection(', 'function hideCanvas('),
  section('function hideCanvas(', 'function applySettings('),
].join('\n');

class MockMutationObserver {
  static instances = [];
  constructor(callback) {
    this.callback = callback;
    this.targets = new Map();
    this.observeCount = 0;
    this.disconnectCount = 0;
    MockMutationObserver.instances.push(this);
  }
  observe(target, options) {
    this.targets.set(target, options);
    this.observeCount++;
  }
  disconnect() {
    this.disconnectCount++;
    this.targets.clear();
  }
  deliver(record) {
    const options = this.targets.get(record.target);
    if (!options) return false;
    if (record.type === 'attributes' && (!options.attributes || !options.attributeFilter?.includes(record.attributeName))) return false;
    if (record.type === 'childList' && !options.childList) return false;
    this.callback([record]);
    return true;
  }
}

class MockIntersectionObserver {
  static instances = [];
  constructor(callback, options) {
    this.callback = callback;
    this.options = options;
    this.targets = new Set();
    this.observeCount = 0;
    this.disconnectCount = 0;
    MockIntersectionObserver.instances.push(this);
  }
  observe(target) { this.targets.add(target); this.observeCount++; }
  disconnect() { this.targets.clear(); this.disconnectCount++; }
  deliver(entries) {
    assert.ok(entries.every(entry => this.targets.has(entry.target)), 'IO delivery targets must be observed');
    this.callback(entries);
  }
}

class MockResizeObserver {
  constructor(callback) { this.callback = callback; this.targets = new Set(); }
  observe(target) { this.targets.add(target); }
  disconnect() { this.targets.clear(); }
}

function makeNode(id, parentElement = null) {
  return {
    id, parentElement,
    contains(node) {
      for (let current = node; current; current = current.parentElement) if (current === this) return true;
      return false;
    },
  };
}
function makeVideo(id, parentElement, { left = 0, top = 0, width = 600, height = 400, painted = false, src = `/media/${id}.mp4` } = {}) {
  const video = makeNode(id, parentElement);
  Object.assign(video, {
    left, top, clientWidth: width, clientHeight: height, videoWidth: 1280, videoHeight: 720,
    readyState: 4, paused: false, ended: false, currentSrc: src, src, duration: 30,
    style: { display: 'block', visibility: painted ? 'visible' : 'hidden', opacity: '1' },
    checkVisibility() { return this.painted; },
    getBoundingClientRect() { return { left: this.left, top: this.top, width: this.clientWidth, height: this.clientHeight }; },
    painted,
  });
  return video;
}

const rafQueue = new Map();
let rafSequence = 0;
let cancelFrameCalls = 0, cancelMidCalls = 0, pairResetCalls = 0, historyResetCalls = 0;
let layoutSyncRequests = 0, drawCalls = 0, scheduleCalls = 0, activationCalls = [];
let releaseCalls = 0, modelVisible = false, modelResetCalls = 0;
let rescanCalls = 0;
const body = makeNode('body');
const article1 = makeNode('article-1', body), article2 = makeNode('article-2', body);
const article3 = makeNode('article-3', body), article4 = makeNode('article-4', body);
const first = makeVideo('video-1', article1, { painted: false, width: 600, height: 400 });
const second = makeVideo('video-2', article2, { painted: false, left: 50, width: 550, height: 500 });
const third = makeVideo('video-3', article3, { painted: false, left: 100, width: 500, height: 350 });
const fourth = makeVideo('video-4', article4, { painted: false, left: 150, width: 450, height: 300 });
const documentListeners = new Map();
const mockDocument = {
  hidden: false,
  videos: [first, second],
  querySelectorAll(selector) { return selector === 'video' ? this.videos : []; },
  addEventListener(type, listener) {
    if (!documentListeners.has(type)) documentListeners.set(type, new Set());
    documentListeners.get(type).add(listener);
  },
  removeEventListener(type, listener) { documentListeners.get(type)?.delete(listener); },
  dispatch(type, target) { for (const listener of documentListeners.get(type) || []) listener({type, target}); },
};
const mockWindow = {
  innerWidth: 1000, innerHeight: 800, devicePixelRatio: 1,
  addEventListener() {}, removeEventListener() {},
};
const fiGpuEngine = {
  compositor: { setVisible(value) { modelVisible = value; } },
  reset() { modelResetCalls++; },
};
const context = vm.createContext({
  console,
  document: mockDocument,
  window: mockWindow,
  MutationObserver: MockMutationObserver,
  IntersectionObserver: MockIntersectionObserver,
  ResizeObserver: MockResizeObserver,
  FeedSessionManager,
  VEFeedSessionManager: FeedSessionManager,
  VEFeedSourceKey: sourceKey,
  getComputedStyle(video) { return video.style; },
  performance: { now: () => 1000 },
  requestAnimationFrame(callback) { const id = ++rafSequence; rafQueue.set(id, callback); return id; },
  cancelAnimationFrame(id) { rafQueue.delete(id); },
  clearTimeout() {},
  settings: { mode: 'ravu', quality: 'high', interaction: 'quality', fiInfra: true },
  settingsLoaded: true,
  currentVideo: null,
  feedSessionManager: new FeedSessionManager(),
  activeFeedSession: null,
  feedSessionId: 0,
  blockedVideo: null,
  stopped: false,
  overlayVisible: true,
  scrolling: false,
  videoInViewport: true,
  hasVisibleVideo: true,
  status: 'ok',
  layoutDirty: true,
  layoutRafScheduled: false,
  rescanRafScheduled: false,
  activePageListeners: false,
  discoveryListeners: false,
  videoResizeObserver: null,
  videoIntersectionObserver: null,
  videoLayoutObserver: null,
  layoutObservedVideo: null,
  layoutObservedParent: null,
  layoutObservedCandidates: [],
  fiDisplayLeadMs: 0,
  fiDisplayCallbackDelayMs: 0,
  fiDisplayLeads: [],
  fiDisplayCallbackDelays: [],
  ravuPendingCaptureVideo: null,
  renderScale: 1,
  stableWindows: 0,
  textureWidth: 0,
  textureHeight: 0,
  metricReport: { videoFps: 60 },
  fiDirectActive: false,
  fiGpuEngine,
  canvas: null,
  compareLeftEl: null,
  compareRightEl: null,
  lastCanvasVisibility: '',
  scheduleLayoutSync() { layoutSyncRequests++; },
  cancelScheduledFrame() { cancelFrameCalls++; context.pendingFrame = false; },
  cancelFiMid() { cancelMidCalls++; },
  resetFiPairState() { pairResetCalls++; },
  resetVideoFrameHistory() { historyResetCalls++; },
  fiReleaseGpu() { releaseCalls++; },
  resetMetricWindow() {},
  suspendOverlayForInteraction() {},
  suspendOverlayForNavigationKey() {},
  handleVisibilityChange() {},
  log() {},
  pendingFrame: false,
  overlayNeedsFirstFrame: false,
  program: {}, rcasProgram: {},
  activateRenderer() {
    activationCalls.push(context.currentVideo?.id || null);
    if (!context.canvas) context.canvas = { width: 1, height: 1, parentNode: context.currentVideo?.parentElement,
      style: { display: '', visibility: 'visible', width: '1px', height: '1px' } };
    context.status = 'ok';
    context.attachActivePageListeners();
    context.updateCanvasVisibility();
    context.draw({ newVideoFrame: true });
    context.overlayNeedsFirstFrame = false;
    context.schedule();
    return true;
  },
  draw() { drawCalls++; },
  schedule() {
    scheduleCalls++;
    if (context.canRender()) {
      context.pendingFrame = true;
      if (context.status === 'no-video') context.status = 'ok';
    }
  },
  syncLayout() {
    if (!context.canvas || !context.currentVideo) return;
    context.canvas.style.width = `${context.currentVideo.clientWidth}px`;
    context.canvas.style.height = `${context.currentVideo.clientHeight}px`;
    context.canvas.parentNode = context.currentVideo.parentElement;
    context.layoutDirty = false;
  },
});

vm.runInContext(production, context, { filename: 'content.js#feed-selection-lifecycle' });
const actualRescan = context.rescan;
context.rescan = function trackedRescan() { rescanCalls++; return actualRescan(); };

function flushRaf() {
  let rounds = 0;
  while (rafQueue.size) {
    assert.ok(++rounds <= 12, 'rescan/layout callbacks must settle without a loop');
    const callbacks = [...rafQueue.values()];
    rafQueue.clear();
    for (const callback of callbacks) callback(1000 + rounds);
  }
}
function deliverStyle(target) {
  assert.equal(context.videoLayoutObserver.deliver({ type: 'attributes', target, attributeName: 'style' }), true,
    `${target.id} style mutation is delivered only while observed`);
  flushRaf();
}
function assertIoTargets(expected) {
  const observed = context.videoIntersectionObserver.targets;
  assert.equal(observed.size, expected.length);
  for (const video of expected) assert.ok(observed.has(video), `IO observes ${video.id}`);
}

// 1. CSS-hidden players with intersecting rectangles are not eligible.
context.rescan();
assert.equal(activationCalls.length, 0, 'hidden candidates do not activate rendering');
assert.equal(context.hasVisibleVideo, false);
assert.equal(context.canRender(), false);
assert.ok(context.videoLayoutObserver.targets.has(first));
assert.ok(context.videoLayoutObserver.targets.has(second));
assertIoTargets([first, second]);

// 2. A genuine initial IO=true notification schedules one rescan; stable candidates do not reconnect.
const io = context.videoIntersectionObserver;
const observesBeforeInitial = io.observeCount, disconnectsBeforeInitial = io.disconnectCount, rescansBeforeInitial = rescanCalls;
io.deliver([{ target: first, isIntersecting: true, intersectionRatio: 1 }]);
flushRaf();
assert.equal(rescanCalls, rescansBeforeInitial + 1);
assert.equal(io.observeCount, observesBeforeInitial, 'stable initial intersection must not re-observe');
assert.equal(io.disconnectCount, disconnectsBeforeInitial, 'stable initial intersection must not disconnect');
assert.equal(rafQueue.size, 0, 'initial intersection does not produce a rescan loop');

// 3. A watched style mutation reveals video 1 and the real selector activates it.
first.painted = true;
first.style.visibility = 'visible';
deliverStyle(first);
assert.equal(context.currentVideo, first);
assert.deepEqual(activationCalls, ['video-1']);
assert.equal(context.canRender(), true);
assert.equal(context.feedSessionId, 1);
assert.equal(context.status, 'ok');

// 4. Hiding the active video with no alternative cancels scheduled work and hides the canvas, retaining the model.
const retainedModel = context.fiGpuEngine;
first.painted = false;
first.style.visibility = 'hidden';
second.painted = false;
second.style.visibility = 'hidden';
deliverStyle(first);
assert.equal(context.hasVisibleVideo, false);
assert.equal(context.canRender(), false);
assert.equal(context.pendingFrame, false);
assert.ok(cancelFrameCalls > 0);
assert.ok(cancelMidCalls > 0);
assert.equal(context.canvas.style.width, '0');
assert.equal(context.canvas.style.height, '0');
assert.equal(modelVisible, false);
assert.equal(context.fiGpuEngine, retainedModel);
assert.equal(releaseCalls, 0, 'idle visibility does not destroy the model');
assertIoTargets([first, second]);

// 5. Candidate additions/removals refresh only current observer targets while idle.
mockDocument.videos = [first, second, third];
context.rescan();
assertIoTargets([first, second, third]);
assert.ok(context.videoLayoutObserver.targets.has(third));
assert.ok(context.videoLayoutObserver.targets.size <= 7, 'candidate ancestor observation is bounded');
mockDocument.videos = [second, third, fourth];
context.rescan();
assertIoTargets([second, third, fourth]);
assert.ok(!context.videoLayoutObserver.targets.has(first), 'removed candidate is no longer observed');
assert.ok(context.videoLayoutObserver.targets.has(fourth), 'added candidate is observed');
assert.ok(context.videoLayoutObserver.targets.size <= 9, 'candidate ancestor observation remains bounded');

// 6. A retained candidate can become visible while idle and restore rendering without a toggle.
second.painted = true;
second.style.visibility = 'visible';
deliverStyle(second);
assert.equal(context.currentVideo, second);
assert.deepEqual(activationCalls, ['video-1', 'video-2']);
assert.equal(context.hasVisibleVideo, true);
assert.equal(context.canRender(), true);
assert.equal(context.status, 'ok');
assert.equal(context.fiGpuEngine, retainedModel);
assert.equal(releaseCalls, 0);
assertIoTargets([second]);

// 7. CSS hide/show on the same source preserves the feed session identity.
mockDocument.videos = [second];
second.painted = false;
second.style.visibility = 'hidden';
const sameSourceKey = sourceKey(second), sameSessionId = context.feedSessionId, activationsBeforeHide = activationCalls.length;
deliverStyle(second);
assert.equal(context.hasVisibleVideo, false);
assert.equal(context.canRender(), false);
second.painted = true;
second.style.visibility = 'visible';
deliverStyle(second);
assert.equal(context.currentVideo, second);
assert.equal(context.feedSessionId, sameSessionId);
assert.equal(sourceKey(second), sameSourceKey);
assert.equal(activationCalls.length, activationsBeforeHide, 'same element/source resumes without renderer reactivation');
assert.equal(context.canRender(), true);
assert.equal(context.status, 'ok');
assert.ok(scheduleCalls > 2, 'rescan schedules the resumed current video');
assert.equal(context.fiGpuEngine, retainedModel);
assert.equal(releaseCalls, 0);



// A feed pauses the previous player after scrolling has stopped. Its old
// playing-area score must not keep owning the renderer until another scroll.
context.attachDiscoveryListeners();
mockDocument.videos = [second, third];
third.painted = true;
third.style.visibility = 'visible';
context.rescan();
assert.equal(context.currentVideo, second, 'the larger playing candidate initially owns rendering');
second.paused = true;
mockDocument.dispatch('pause', second);
flushRaf();
assert.equal(context.currentVideo, third, 'pausing the previous player selects the playing neighbour without another scroll');
third.ended = true;
second.paused = false;
mockDocument.dispatch('ended', third);
flushRaf();
assert.equal(context.currentVideo, second, 'an ended current player relinquishes selection');
second.paused = true;
third.ended = false;
third.readyState = 1;
context.rescan();
assert.equal(context.currentVideo, second, 'an unready neighbour does not take priority');
third.readyState = 4;
mockDocument.dispatch('playing', third);
flushRaf();
assert.equal(context.currentVideo, third, 'a newly ready playing neighbour triggers selection');
context.detachDiscoveryListeners();
for (const type of ['play', 'playing', 'pause', 'ended'])
  assert.equal(documentListeners.get(type)?.size, 0, `disabling removes ${type} discovery listeners`);

console.log('PASS: production feed selection rejects CSS-hidden videos, keeps observers stable, and resumes the same feed session.');
