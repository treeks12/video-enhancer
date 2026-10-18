'use strict';

// CPU-only contract checks for the real overlay shader preparation functions.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../content.js'), 'utf8');
function extract(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `production section exists: ${startMarker}`);
  return source.slice(start, end);
}
const production = [
  extract('function createOverlay()', 'async function prepareOverlayPrograms('),
  extract('async function prepareOverlayPrograms(', 'function ensureEasuProgram('),
  extract('async function linkProgramCooperatively(', 'function extractRavuShader('),
  extract('function activateRenderer(', 'function videoObjectPosition('),
].join('\n');

const turn = () => new Promise(resolve => setImmediate(resolve));
async function drain() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
  await turn();
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

function mockGL({ parallel = true, failProgram = -1, failGeometry = '' } = {}) {
  const events = [], shaders = [], programs = [], buffers = [], vaos = [];
  let id = 0;
  const gl = {
    VERTEX_SHADER: 'vertex', FRAGMENT_SHADER: 'fragment', LINK_STATUS: 'link', COMPILE_STATUS: 'compile',
    COMPLETION_STATUS_KHR: 'complete', ARRAY_BUFFER: 'array-buffer', STATIC_DRAW: 'static-draw', FLOAT: 'float',
    lost: false,
    getExtension(name) {
      events.push(['extension', name]);
      if (name === 'KHR_parallel_shader_compile') return parallel ? { COMPLETION_STATUS_KHR: 'complete' } : null;
      return null;
    },
    createShader(type) { const value = { owner: gl, id: ++id, type, deleted: 0 }; shaders.push(value); return value; },
    createProgram() { const value = { owner: gl, id: ++id, index: programs.length, complete: !parallel, deleted: 0, attached: [] }; programs.push(value); return value; },
    shaderSource(shader, text) { shader.text = text; },
    compileShader(shader) { events.push(['compile', shader.id]); },
    attachShader(program, shader) { program.attached.push(shader); },
    linkProgram(program) { events.push(['link', program.index]); },
    getShaderParameter() { throw new Error('COMPILE_STATUS must not be queried during cooperative preparation'); },
    getProgramParameter(program, name) {
      assert.equal(program.owner, gl);
      assert.equal(program.deleted, 0);
      events.push(['query', name, program.index]);
      if (name === 'complete') return program.complete;
      assert.equal(name, 'link');
      assert.ok(program.complete, 'LINK_STATUS queried before COMPLETION_STATUS_KHR');
      return program.index !== failProgram;
    },
    getProgramInfoLog(program) { assert.ok(program.complete); return 'mock link failure'; },
    deleteShader(shader) { assert.equal(shader.owner, gl); assert.equal(shader.deleted++, 0); events.push(['delete-shader', shader.id]); },
    deleteProgram(program) { assert.equal(program.owner, gl); assert.equal(program.deleted++, 0); events.push(['delete-program', program.index]); },
    isContextLost() { return gl.lost; },
    getUniformLocation(program, name) { assert.equal(program.owner, gl); return { program, name }; },
    useProgram(program) { assert.equal(program.owner, gl); assert.equal(program.deleted, 0); },
    uniform1i() {},
    createBuffer() {
      if (failGeometry === 'buffer') return null;
      const value = { owner: gl, deleted: 0 }; buffers.push(value); return value;
    },
    deleteBuffer(buffer) { assert.equal(buffer.owner, gl); assert.equal(buffer.deleted++, 0); },
    createVertexArray() {
      if (failGeometry === 'vao') return null;
      const value = { owner: gl, deleted: 0 }; vaos.push(value); return value;
    },
    deleteVertexArray(vao) { assert.equal(vao.owner, gl); assert.equal(vao.deleted++, 0); },
    bindBuffer() {}, bufferData() {}, bindVertexArray() {}, getAttribLocation() { return 0; },
    enableVertexAttribArray() {}, vertexAttribPointer() {},
  };
  return {
    gl, events, shaders, programs, buffers, vaos,
    complete(index) { assert.ok(programs[index]); programs[index].complete = true; },
  };
}

function harness(options = {}) {
  const gpu = mockGL(options), timers = [], calls = { draw: 0, schedule: 0, warm: 0, rescan: [], attach: 0, observe: 0, visible: 0 };
  const context = vm.createContext({
    document: {
      getElementById() { return null; },
      createElement(tag) {
        assert.equal(tag, 'canvas');
        return { style: {}, parentNode: null, remove() { this.removed = true; }, getContext(type) { assert.equal(type, 'webgl2'); return gpu.gl; } };
      },
    },
    performance: { now: () => 0 },
    setTimeout(callback, delay) { timers.push({ callback, delay, ran: false }); return timers.length; },
    Float32Array,
    initialGL: gpu.gl,
    initialCalls: calls,
  });
  vm.runInContext(`
    let gl=initialGL, canvas=null, program=null, rcasProgram=null, vao=null, easuProgram=null;
    let uTexLoc=null,uTexelLoc=null,uStrengthLoc=null,uCompareLoc=null;
    let rcasTexLoc=null,rcasTexelLoc=null,rcasStrengthLoc=null,rcasCompareLoc=null;
    let easuTexLoc=null, overlayInitPromise=null, overlayNeedsFirstFrame=false, timerExt=null, timerExtChecked=false;
    let lastCanvasVisibility='',lastDatasetPipeline='',lastDatasetError='',lastError='',status='idle';
    let stopped=false,settings={mode:'ravu'},currentVideo=null,activeFeedSession=null;
    const CANVAS_ID='ve-overlay',VERT='vertex',VERT_PLAIN='vertex-plain',FRAG='fragment';
    const calls=initialCalls, log=()=>{};
    const applyCanvasOutline=()=>{};
    function updateCanvasVisibility(){calls.visible++;}
    function warmFiPrograms(){calls.warm++;}
    function scheduleRescan(){calls.rescan.push({video:currentVideo,session:activeFeedSession});}
    function attachCanvasTo(){calls.attach++;}
    function attachActivePageListeners(){}
    function observeVideoLayout(){}
    function draw(){calls.draw++;}
    function schedule(){calls.schedule++;}
    ${production}
    globalThis.api={
      createOverlay,prepareOverlayPrograms,activateRenderer,linkProgramCooperatively,
      state:()=>({gl,canvas,program,rcasProgram,vao,easuProgram,overlayInitPromise,overlayNeedsFirstFrame,status,lastError,stopped,mode:settings.mode,currentVideo,activeFeedSession}),
      setStopped(value){stopped=value;},setMode(value){settings.mode=value;},setVideo(video,session){currentVideo=video;activeFeedSession=session;},
      replaceGL(value){gl=value;},calls,
    };
  `, context);
  return {
    ...gpu, context, api: context.api, timers, calls,
    async runTimer(index = 0) {
      assert.ok(index >= 0, 'timer index exists');
      const timer = timers.splice(index, 1)[0];
      assert.ok(timer, 'expected queued timer task');
      timer.ran = true;
      timer.callback();
      await drain();
      return timer.delay;
    },
    async completeAndPoll(programIndex) {
      this.complete(programIndex);
      const i = timers.findIndex(timer => timer.delay === 8);
      assert.ok(i >= 0, `poll timer for program ${programIndex} exists`);
      await this.runTimer(i);
    },
  };
}

function track(promise) {
  const state = { settled: false };
  state.done = promise.then(value => { state.settled = true; state.value = value; }, error => { state.settled = true; state.error = error; });
  return state;
}
function noLeaks(h) {
  assert.ok(h.shaders.every(shader => shader.deleted === 1), 'allocated shader objects are released');
  assert.ok(h.programs.every(program => program.deleted === 1 || program === h.api.state().program || program === h.api.state().rcasProgram), 'program objects are either published or released');
  assert.ok(h.buffers.every(buffer => buffer.deleted === 0 || buffer.deleted === 1), 'buffer cleanup state is recorded');
  assert.ok(h.vaos.every(vao => vao.deleted === 0 || vao.deleted === 1), 'VAO cleanup state is recorded');
}

async function finishSuccessfulPreparation(h) {
  const first = h.api.state().overlayInitPromise;
  assert.ok(first, 'overlay initialization promise is installed');
  assert.equal(h.programs.length, 1, 'first shader starts synchronously');
  await h.completeAndPoll(0);
  assert.equal(h.programs.length, 1, 'second shader waits for the zero-delay task');
  const task = h.timers.findIndex(timer => timer.delay === 0);
  assert.ok(task >= 0, 'task boundary queued between links');
  await h.runTimer(task);
  assert.equal(h.programs.length, 2);
  await h.completeAndPoll(1);
  await first;
  await drain();
}

(async () => {
  // 1-4: asynchronous publication, no blocking status queries or early draw.
  const h = harness();
  h.api.setVideo({ id: 'before' }, { id: 'session-old' });
  assert.equal(h.api.createOverlay(), true);
  const initial = h.api.state();
  assert.equal(initial.status, 'preparing');
  assert.equal(h.programs.length, 1);
  assert.equal(initial.program, null); assert.equal(initial.rcasProgram, null); assert.equal(initial.vao, null);
  assert.equal(initial.overlayNeedsFirstFrame, true);
  assert.equal(h.events.filter(e => e[0] === 'query' && e[1] === 'link').length, 0);
  assert.equal(h.events.filter(e => e[0] === 'query' && e[1] === 'complete').length, 1);
  assert.equal(h.api.activateRenderer(), false);
  assert.equal(h.calls.draw, 0);
  assert.equal(h.api.state().overlayNeedsFirstFrame, true, 'pending activation keeps the first-upload obligation');
  const currentVideo = { id: 'current' }, currentSession = { id: 'session-new' };
  h.api.setVideo(currentVideo, currentSession);
  await h.completeAndPoll(0);
  assert.equal(h.api.state().program, null, 'first completed program is not published alone');
  assert.equal(h.api.state().rcasProgram, null);
  assert.equal(h.api.state().vao, null);
  assert.equal(h.calls.draw, 0);
  assert.equal(h.programs.length, 1, 'second link has not begun before a separate task');
  const zeroTask = h.timers.findIndex(timer => timer.delay === 0);
  assert.ok(zeroTask >= 0);
  await h.runTimer(zeroTask);
  assert.equal(h.programs.length, 2);
  assert.deepEqual(h.events.filter(e => e[0] === 'link').map(e => e[1]), [0, 1]);
  await h.completeAndPoll(1);
  await h.api.state().overlayInitPromise;
  await drain();
  const ready = h.api.state();
  assert.equal(ready.program, h.programs[0]); assert.equal(ready.rcasProgram, h.programs[1]); assert.ok(ready.vao);
  assert.equal(h.calls.rescan.length, 1);
  assert.equal(h.calls.rescan[0].video, currentVideo, 'resume discovers current video, not the captured old one');
  assert.equal(h.calls.rescan[0].session, currentSession, 'resume discovers current session, not the captured old one');
  assert.equal(h.calls.warm, 1);
  assert.equal(h.events.filter(e => e[0] === 'query' && e[1] === 'link').length, 2);
  assert.ok(h.events.filter(e => e[0] === 'query' && e[1] === 'link').every(e => h.programs[e[2]].complete));
  assert.equal(h.events.some(e => e[0] === 'query' && e[1] === 'compile'), false);
  assert.equal(h.api.activateRenderer(), true);
  assert.equal(h.calls.draw, 1);
  assert.equal(h.api.state().overlayNeedsFirstFrame, false, 'completed activation consumes the first-upload obligation');
  assert.ok(h.buffers.every(buffer => buffer.deleted === 0));
  assert.ok(h.vaos.every(vao => vao.deleted === 0));
  noLeaks(h);

  // 5: disabling during preparation does not warm FI or schedule a rescan; ready cache remains reusable.
  const off = harness();
  off.api.setVideo({ id: 'off-retained' }, { id: 'off-session' });
  assert.equal(off.api.createOverlay(), true);
  off.api.setMode('off');
  await finishSuccessfulPreparation(off);
  assert.equal(off.calls.warm, 0); assert.equal(off.calls.rescan.length, 0);
  assert.equal(off.api.state().program, off.programs[0]); assert.equal(off.api.state().rcasProgram, off.programs[1]); assert.ok(off.api.state().vao);
  off.api.setMode('ravu');
  assert.equal(off.api.activateRenderer(), true);
  assert.equal(off.calls.draw, 1);
  noLeaks(off);

  // 6: cancellation, context replacement and loss during the between-program wait clean completed work.
  for (const reason of ['stopped', 'replaced', 'lost']) {
    const cancelled = harness();
    assert.equal(cancelled.api.createOverlay(), true);
    await cancelled.completeAndPoll(0);
    assert.equal(cancelled.programs.length, 1);
    const zero = cancelled.timers.findIndex(timer => timer.delay === 0);
    assert.ok(zero >= 0);
    if (reason === 'stopped') cancelled.api.setStopped(true);
    if (reason === 'replaced') cancelled.api.replaceGL(mockGL().gl);
    if (reason === 'lost') cancelled.gl.lost = true;
    await cancelled.runTimer(zero);
    await cancelled.api.state().overlayInitPromise;
    await drain();
    const state = cancelled.api.state();
    assert.equal(state.program, null); assert.equal(state.rcasProgram, null); assert.equal(state.vao, null);
    assert.equal(cancelled.programs.length, 1, `${reason} prevents second link`);
    assert.equal(cancelled.programs[0].deleted, 1, `${reason} releases first completed program`);
    assert.equal(cancelled.calls.rescan.length, 0);
    noLeaks(cancelled);
  }

  // 7a: a failed second link never publishes the first program.
  const secondFails = harness({ failProgram: 1 });
  assert.equal(secondFails.api.createOverlay(), true);
  await secondFails.completeAndPoll(0);
  await secondFails.runTimer(secondFails.timers.findIndex(timer => timer.delay === 0));
  await secondFails.completeAndPoll(1);
  await secondFails.api.state().overlayInitPromise;
  await drain();
  assert.equal(secondFails.api.state().program, null); assert.equal(secondFails.api.state().rcasProgram, null); assert.equal(secondFails.api.state().vao, null);
  assert.equal(secondFails.programs[0].deleted, 1); assert.equal(secondFails.programs[1].deleted, 1);
  assert.equal(secondFails.calls.warm, 0); assert.equal(secondFails.calls.rescan.length, 0);
  noLeaks(secondFails);

  // 7b: buffer and VAO allocation errors clean the complete shader pair and geometry without partial publication.
  for (const failGeometry of ['buffer', 'vao']) {
    const geometryFails = harness({ failGeometry });
    assert.equal(geometryFails.api.createOverlay(), true);
    await finishSuccessfulPreparation(geometryFails);
    assert.equal(geometryFails.api.state().program, null); assert.equal(geometryFails.api.state().rcasProgram, null); assert.equal(geometryFails.api.state().vao, null);
    assert.equal(geometryFails.programs[0].deleted, 1); assert.equal(geometryFails.programs[1].deleted, 1);
    assert.ok(geometryFails.buffers.every(buffer => buffer.deleted === 1));
    assert.ok(geometryFails.vaos.every(vao => vao.deleted === 1));
    assert.equal(geometryFails.calls.warm, 0); assert.equal(geometryFails.calls.rescan.length, 0);
    noLeaks(geometryFails);
  }

  // 8: without KHR, synchronous links still have a task boundary between them.
  const serial = harness({ parallel: false });
  assert.equal(serial.api.createOverlay(), true);
  assert.equal(serial.programs.length, 1);
  await drain();
  assert.equal(serial.programs.length, 1, 'second no-KHR link waits for queued task');
  const boundary = serial.timers.findIndex(timer => timer.delay === 0);
  assert.ok(boundary >= 0);
  await serial.runTimer(boundary);
  assert.equal(serial.programs.length, 2);
  assert.deepEqual(serial.events.filter(e => e[0] === 'link').map(e => e[1]), [0, 1]);
  assert.equal(serial.events.filter(e => e[0] === 'query' && e[1] === 'complete').length, 0);
  await serial.api.state().overlayInitPromise;
  await drain();
  assert.equal(serial.api.state().program, serial.programs[0]);
  assert.equal(serial.api.state().rcasProgram, serial.programs[1]);
  assert.ok(serial.api.state().vao);
  assert.ok(serial.buffers.every(buffer => buffer.deleted === 0));
  assert.ok(serial.vaos.every(vao => vao.deleted === 0));
  noLeaks(serial);

  console.log('PASS overlay init: cooperative completion, atomic publication, current-feed rescan, cancellation cleanup, and no-KHR task boundary');
})().catch(error => { console.error(error); process.exitCode = 1; });
