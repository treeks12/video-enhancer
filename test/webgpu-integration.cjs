// Production orchestration with controlled async estimator outcomes. Real WGSL is
// exercised separately by webgpu-core.cjs and webgpu-quality.cjs.
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const context = vm.createContext({ console, performance: { now: () => 100 },
  setTimeout, clearTimeout, requestAnimationFrame: () => 1, cancelAnimationFrame() {} });
vm.runInContext(fs.readFileSync(path.join(root,'fi-core.js'),'utf8'),context);
let content = fs.readFileSync(path.join(root,'content.js'),'utf8');
content = content.slice(0,content.lastIndexOf('if (typeof window !== "undefined" && window.document)'));
vm.runInContext(content,context);
const run = code => vm.runInContext(code,context);
const flush = () => new Promise(resolve=>setImmediate(resolve));
(async()=>{
  run(`
    let submitted=0, resolveEstimate, rejectEstimate;
    let uploadCount=0, draws=[];
    draw=options=>draws.push(options);
    fiUploadMvTexture=()=>{uploadCount++;return {};};
    fiWarmGpu=()=>{};
    gl={TEXTURE0:0,activeTexture(){}};
    const match=()=>({gridW:8,gridH:8,block:2,mvs:new Float32Array(128),
      confidences:new Float32Array(64).fill(1),confidence:1,meanResidual:0});
    const result=()=>({forward:match(),backward:match(),elapsedMs:1});
    const configure=()=>{
      resetFiPairState();
      settings=normalizeSettings({mode:'native',fiInfra:true});
      fiHasPrev=fiHasCurr=true;fiPrevLuma=new Float32Array(256).fill(50);
      fiCurrLuma=new Float32Array(256).fill(51);fiLumaW=fiLumaH=16;
      currentVideo={playbackRate:1};fiGpuState='ready';fiGpuError='';fiGpuBusy=false;
      lastVideoFrameDurationMs=1000/30;fiDisplayPeriod=1000/60;
      fiGpuSlowPairs=0;fiGpuSampleScale=1;
      fiGpuEngine={lost:false,destroy(){this.lost=true},estimate(){submitted++;
        return new Promise((resolve,reject)=>{resolveEstimate=resolve;rejectEstimate=reject;});}};
      submitted=0;uploadCount=0;draws=[];
    };
    configure();
  `);
  assert.equal(run('fiRequestGpuPair()'),true);
  assert.equal(run('fiMethod'),'pending');
  run('resolveEstimate(result())'); await flush();
  assert.equal(run('fiMethod'),'webgpu');
  assert.equal(run('uploadCount'),2);
  assert.equal(run('fiGpuReadySerial === fiPairSerial'),true);

  run('configure(); fiRequestGpuPair(); resetFiPairState(); resolveEstimate(result());'); await flush();
  assert.equal(run('uploadCount'),0,'old source result must never upload');
  assert.equal(run('fiMethod'),'skip');

  run('configure(); lastVideoFrameDurationMs=1000/60;');
  assert.equal(run('fiRequestGpuPair()'),false);
  assert.equal(run('submitted'),0,'60fps on60Hz must not dispatch compute');

  run('configure(); fiRequestGpuPair();');
  assert.equal(run('fiRequestGpuPair()'),false);
  assert.equal(run('submitted'),1,'never build a GPU queue backlog');
  run('resetFiPairState();resolveEstimate(result());');await flush();

  run('configure(); fiRequestGpuPair(); const uncertain=result(); uncertain.forward.confidences.fill(0);resolveEstimate(uncertain);');await flush();
  assert.equal(run('fiMethod'),'webgpu','local confidence must not disable an entire frame');
  assert.equal(run('uploadCount'),2);
  assert.equal(run('draws.length'),0,'confidence must not trigger an asynchronous jump to the current frame');

  run('configure(); fiRequestGpuPair(); rejectEstimate(new Error("GPU lost test"));');await flush();
  assert.equal(run('fiGpuState'),'unavailable');
  assert.equal(run('draws.length'),0,'GPU failure must not jump the presentation clock');
  assert.equal(run('fiGpuEngine.lost'),true);

  run('configure(); fiRequestGpuPair(); performance.now=()=>200;resolveEstimate(result());');await flush();
  assert.equal(run('fiMethod'),'skip');
  assert.equal(run('fiMotionRetryAt'),0,'a late result must not disable motion for a whole second');
  assert.equal(run('fiGpuSampleScale'),1,'one slow frame must not resize the sample');
  assert.equal(run('draws.length'),0,'late completion must not show the current frame early');
  run('fiRequestGpuPair();performance.now=()=>300;resolveEstimate(result());');await flush();
  assert.equal(run('fiGpuSampleScale'),1,'two slow samples must not resize yet');
  run('fiRequestGpuPair();performance.now=()=>400;resolveEstimate(result());');await flush();
  assert.equal(run('fiGpuSampleScale'),.75,'sustained overload should reduce work without a one-second pause');
  assert.equal(run('fiMotionRetryAt'),0);
  console.log('PASS: async pair identity, GPU failure, no blend, deadlines, single flight and display capacity');
})().catch(error=>{console.error(error);process.exitCode=1;});
