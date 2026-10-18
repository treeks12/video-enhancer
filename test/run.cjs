// Dependency-free CPU checks. GPU/browser execution is deliberately separate.
'use strict';
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const root = path.resolve(__dirname, '..');
let failed = false, executed = 0;

function runNode(args) {
  const result = cp.spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8' });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  // Some constrained runtimes return status 0 alongside a spawn error. A
  // signal/null status is also not a passing test, regardless of its output.
  if (result.error || result.signal || result.status !== 0) {
    console.error('FAILED node ' + args.join(' ') + ': ' +
      (result.error?.message || (result.signal ? 'signal ' + result.signal : 'exit ' + result.status)));
    failed = true;
    return false;
  }
  return true;
}

for (const directory of ['', 'neural']) {
  for (const name of fs.readdirSync(path.join(root, directory)).filter(n => n.endsWith('.js')).sort()) {
    runNode(['--check', path.join(directory, name)]);
  }
}
const suites = [
  "content.js",
  "fi-core.js",
  "test/feed-session.cjs",
  "test/feed-selection.cjs",
  "test/feed-selection-lifecycle.cjs",
  "test/benchmark-runner.cjs",
  "test/video-layout.cjs",
  "test/spatial-cache.cjs",
  "test/spatial-shaders.cjs",
  "test/overlay-init.cjs",
  "test/ravu-order.cjs",
  "test/cadence.cjs",
  "test/quality.cjs",
  "test/half-oracle.cjs",
  "test/model.cjs",
  "test/model-storage.cjs",
  "test/neural-runtime.cjs",
  "test/neural-lifecycle.cjs",
  "test/neural-init.cjs",
  "test/ifrnet-device.cjs",
  "test/ifrnet-api-fallback.cjs",
  "test/ifrnet-decode.cjs",
  "test/ifrnet-host.cjs",
  "test/ifrnet-channel-block.cjs",
  "test/ifrnet-wgsl.cjs",
  "test/ifrnet-webgpu-host.cjs",
  "test/ifrnet-video-capture.cjs",
  "test/webgpu-compositor.cjs",
  "test/ifrnet-controller.cjs",
  "test/neural-buffered.cjs",
  "test/neural-clock.cjs",
  "test/neural-direct.cjs",
  "test/cpu-profile.cjs",
  "test/analytic-host.cjs",
  "test/analytic-controller.cjs",
  "test/runner-failures.cjs",
  "test/block-sad.cjs",
  "test/popup-state.cjs",
  "test/rcas-noise.cjs"
];
for (const name of suites) {
  console.log('\n> node ' + name);
  if (runNode([name])) executed++;
}
if (failed) process.exitCode = 1;
else console.log('\nPASS: ' + executed + ' CPU test programs. GPU shader execution is a separate test.');
