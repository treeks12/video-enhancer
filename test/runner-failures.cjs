// Exercise the production runner's process-result boundary without spawning.
'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, 'run.cjs'), 'utf8');
function run(result) {
  const output = [], errors = [], process = { execPath: 'node', stdout: { write: text => output.push(text) }, stderr: { write: text => errors.push(text) } };
  const context = { __dirname, process,
    console: { log: text => output.push(text), error: text => errors.push(text) },
    require(name) {
      if (name === 'node:fs') return { readdirSync: () => ['fixture.js'] };
      if (name === 'node:child_process') return { spawnSync: () => result };
      return require(name);
    },
  };
  vm.runInNewContext(source, context);
  return { code: process.exitCode || 0, output: output.join('\n'), errors: errors.join('\n') };
}
for (const result of [
  { status: 0, error: new Error('spawn EPERM'), stdout: '', stderr: '' },
  { status: null, signal: 'SIGTERM', stdout: 'partial output', stderr: '' },
  { status: null, stdout: '', stderr: '' },
  { status: 1, stdout: '', stderr: 'assertion failed' },
]) {
  const actual = run(result);
  assert.equal(actual.code, 1, 'incomplete child execution fails the suite');
  assert.doesNotMatch(actual.output, /PASS:/, 'no passing summary after a launch error/signal/failure');
  assert.match(actual.errors, /FAILED node/);
}
const success = run({ status: 0, signal: null, stdout: 'child assertions passed\n', stderr: '' });
assert.equal(success.code, 0); assert.match(success.output, /PASS:/);
assert.match(success.output, /child assertions passed/);
console.log('PASS runner: launch errors, signals, missing exit status and assertion failures cannot become successful validation.');
