'use strict';
const assert=require('node:assert/strict'),{model}=require('./fixtures.cjs'),{mockDevice}=require('./mock-gpu.cjs');
require('../fi-quality.js');const R=require('../fi-neural-runtime.js');
(async()=>{
 for(const half of [false,true]){
  const device=mockDevice({half}),m=model();
  const rt=await R.create(device,{w:32,h:32,weightsBin:m.binary,weightsManifest:m.manifest});
  const mk=()=>device.createTexture({size:[64,48],format:'rgba8unorm',usage:12});const a=mk(),b=mk(),out=mk();
  assert.throws(()=>rt.runT(.5,out));assert.throws(()=>rt.prepPair(a,a));
  rt.prepPair(a,b);rt.runT(.5,out);
  assert.equal(device.submissions[0].stages.length,9,'prep + two convs + six trunk blocks');
  assert.equal(device.submissions[1].stages.length,10,'FiLM + two head blocks + deconv + refine + compose');
  const alloc=device.allocations.length,bindings=device.bindingCount;
  for(const t of [.25,.5,.75,0,1]){rt.prepPair(a,b);rt.runT(t,out);}
  assert.equal(device.allocations.length,alloc,'no steady-state allocations');assert.equal(device.bindingCount,bindings,'cached bind groups');
  assert.throws(()=>rt.runT(.5,a));assert.throws(()=>rt.runT(NaN,out));
  rt.destroy();rt.destroy();assert.ok(device.allocations.filter(x=>![a,b,out].includes(x)).every(x=>x.dead));assert.ok(!a.dead);assert.throws(()=>rt.prepPair(a,b));
  const failing=mockDevice({compileFailure:true});await assert.rejects(()=>R.create(failing,{w:32,h:32,weightsBin:m.binary,weightsManifest:m.manifest}),/compiler failure/);assert.ok(failing.allocations.every(x=>x.dead),'partial construction cleanup');
 }
 console.log('PASS: actual runtime host graph in FP32/FP16, 19 dispatches, resource reuse, alias rejection and failure cleanup (mock GPU, not shader execution)');
})().catch(e=>{console.error(e);process.exitCode=1;});
