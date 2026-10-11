'use strict';
const assert = require('node:assert/strict');
const { FeedSessionManager, sourceKey } = require('../feed-session.js');

function video(src, width = 1080, height = 1920, duration = 30) {
  return { currentSrc: src, src, videoWidth: width, videoHeight: height, duration };
}

const manager = new FeedSessionManager();
const first = video('https://cdn.example/reel-0.mp4');
const session0 = manager.ensure(first);
assert.equal(manager.isCurrent(session0, first), true);
assert.equal(manager.ensure(first), session0, 'same source keeps its session');

// TikTok/Instagram-style reuse of one DOM video element: changing currentSrc
// must retire the previous session even when dimensions stay identical.
let previous = session0;
for (let i = 1; i <= 200; i++) {
  first.currentSrc = `https://cdn.example/reel-${i}.mp4`;
  first.src = first.currentSrc;
  const next = manager.ensure(first);
  assert.equal(previous.active, false, `session ${i - 1} was retired`);
  assert.equal(manager.isCurrent(previous, first), false, 'late work cannot target a retired source');
  assert.equal(manager.isCurrent(next, first), true);
  assert.equal(next.id, i + 1);
  previous = next;
}

// A feed may replace the node while preserving the URL and dimensions. The
// explicit force transition still creates an isolated generation.
const replacement = video(first.currentSrc);
const forced = manager.ensure(replacement, { force: true, reason: 'node replaced' });
assert.equal(previous.active, false);
assert.equal(manager.isCurrent(forced, replacement), true);
assert.notEqual(forced.id, previous.id);
assert.match(sourceKey(replacement), /reel-200\.mp4/);

manager.retire('feed removed');
assert.equal(manager.active, null);
assert.equal(forced.active, false);
console.log('PASS: 200 rapid feed transitions, reused-node source changes, replacement nodes and stale-session rejection');
