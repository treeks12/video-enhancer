// IFRNet host tests use the real bundled checkpoint and production graph.
// Mock GL checks ownership/queueing; shader arithmetic is tested in the browser.
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const S=require('../neural/model-spec.js');require('../neural/graph.js');
const Runtime=require('../neural/runtime.js');
function mockGL(){
 let id=0,program=null;const allocations=[],uniforms=[];
 const make=kind=>{const obj={id:++id,kind,dead:false};allocations.push(obj);return obj;};
 const drop=obj=>{assert.ok(!obj?.dead,'double deletion');if(obj)obj.dead=true;};
 const g={allocations,uniforms,draws:0,hold:false,compileHold:false,stats:[0,0,0,1],
  getExtension:n=>n==='KHR_parallel_shader_compile'?{COMPLETION_STATUS_KHR:'done'}:{},
  isContextLost:()=>false,getParameter:()=>4096,
  createTexture:()=>make('texture'),createProgram:()=>make('program'),createShader:()=>make('shader'),
  createFramebuffer:()=>make('fbo'),createVertexArray:()=>make('vao'),fenceSync:()=>make('sync'),
  deleteTexture:drop,deleteProgram:drop,deleteShader:drop,deleteFramebuffer:drop,deleteVertexArray:drop,deleteSync:drop,
  getProgramParameter:(_,p)=>p==='done'?!g.compileHold:true,
  getUniformLocation:(p,name)=>({p,name}),useProgram:p=>{program=p;},
  uniform2f:(loc,x,y)=>uniforms.push({program:loc.p,name:loc.name,x,y}),
  drawArrays:()=>{assert.ok(!program?.dead,'draw uses released program');g.draws++;},
  clientWaitSync:sync=>{assert.ok(!sync.dead);g.onWait?.();return g.hold?'TIMEOUT_EXPIRED':'CONDITION_SATISFIED';},
  checkFramebufferStatus:()=> 'FRAMEBUFFER_COMPLETE',
  readPixels:(x,y,w,h,fmt,type,data)=>data.set(g.stats),
 };
 for(const n of ['shaderSource','compileShader','attachShader','linkProgram','texParameteri','texImage2D',
  'activeTexture','bindTexture','bindFramebuffer','bindVertexArray','framebufferTexture2D','viewport','uniform1i','uniform1f','uniform2i','flush','enable','disable','scissor'])g[n]=()=>{};
 return new Proxy(g,{get:(obj,key)=>key in obj?obj[key]:String(key)});
}
const count=(g,kind)=>g.allocations.filter(t=>t.kind===kind).length;
(async()=>{
 const bytes=fs.readFileSync(path.join(__dirname,'../models/ifrnet.bin'));
 const g=mockGL(),r=await Runtime.create(g,bytes,1280,720);
 const weights=[...r.layers.values()],alloc=g.allocations.length,programs=count(g,'program');
 const first=r.state;
 for(const [w,h]of [[1920,1080],[1280,736],[2560,1440],[1280,720]]){
  await r.resize(w,h);assert.equal(r.state,first);
  assert.equal(g.allocations.length,alloc,'same padded shape needs no allocations or compilation');
 }
 assert.equal(r.model.encoder[0].weights,null,'weights are uploaded only once');
 assert.equal((await r.estimate({}, {}, 1)).valid,true);
 assert.ok(g.uniforms.some(u=>u.name==='activeSize'&&u.x===320&&u.y===180));
 assert.equal(r.render({}, {}, {},1920,1080),true);
 await r.resize(720,1280);const warmAlloc=g.allocations.length;
 assert.equal(count(g,'program'),programs,'even the first portrait shape shares compiled kernels');
 for(let i=0;i<20;i++)await r.resize(...(i%2?[720,1280]:[1920,1080]));
 assert.equal(g.allocations.length,warmAlloc,'alternating warm portrait/landscape shapes does not rebuild');
 assert.deepEqual([...r.layers.values()],weights,'all shapes share the uploaded weights');
 assert.equal(r.shapes.size,2);
 await r.resize(1000,1000);assert.equal(r.shapes.size,2,'LRU cache has a fixed shape count');
 assert.ok(r.memoryBytes<=256*1024*1024,'cached shapes share the memory cap');

 // Cancel during shader compilation, keep the existing model usable and free
 // every temporary graph allocation instead of turning cancellation into failure.
 const stateBefore=r.state,c=new AbortController(),originalProgram=r.program;
 let enter;const entered=new Promise(resolve=>{enter=resolve;});
 r.program=async function(...args){enter();await new Promise(resolve=>c.signal.addEventListener('abort',resolve,{once:true}));return originalProgram.apply(this,args);};
 const prepare=r.resize(100,300,'balanced',c.signal);await entered;c.abort();
 await assert.rejects(prepare,{name:'AbortError'});r.program=originalProgram;
 await r.resize(1000,1000);assert.equal(r.state,stateBefore);

 // Only endpoint capture is submitted synchronously. A cancelled inference
 // cannot leave the rest of the network queued ahead of a new feed item.
 const before=g.draws;g.hold=true;
 const pending=r.estimate({}, {},20);assert.equal(g.draws-before,3,'capture only before compositor yields');
 await new Promise(resolve=>setTimeout(resolve,5));const submitted=g.draws;r.reset();
 await new Promise(resolve=>setTimeout(resolve,5));assert.equal(r.busy,true,'cancelled submitted work still owns the GPU fence');
 assert.equal(await r.estimate({}, {},21),null,'a second job cannot queue ahead of cancelled GPU work');
 assert.equal(g.draws,submitted,'no further batch after cancellation');
 g.hold=false;
 assert.equal(await pending,null);assert.ok(submitted-before<=4,'at most one bounded dispatch can be outstanding');
 assert.equal((await r.estimate({}, {},21)).valid,true,'inference resumes without recreating the model');
 r.destroy();r.destroy();assert.ok(g.allocations.every(t=>t.dead),'all shared and cached resources are released');

 // Use a controlled clock, not timer races, to expire a real production job
 // while the mock GPU fence still owns an expensive dispatch.
 let clock=1000;
 const sandbox={module:{exports:{}},VENeuralSpec:S,VENeuralGraph:globalThis.VENeuralGraph,
  performance:{now:()=>clock},setTimeout,clearTimeout};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../neural/runtime.js'),'utf8'),sandbox);
 const gpu=mockGL(),timed=await sandbox.module.exports.create(gpu,bytes,1280,720);
 let enterDeadline;const waiting=new Promise(resolve=>{enterDeadline=resolve;});
 // The first fence drains the endpoint snapshots. Hold the next neural tile.
 let fences=0;const originalFence=gpu.fenceSync;
 gpu.fenceSync=()=>{if(++fences===2)gpu.hold=true;return originalFence();};
 gpu.onWait=()=>{if(gpu.hold)enterDeadline();};
 const work=timed.estimate({}, {},1,.5,{deadline:1010});await waiting;
 const countBeforeDeadline=gpu.draws;clock=1011;
 await new Promise(resolve=>setTimeout(resolve,5));
 assert.equal(timed.busy,true);assert.equal(gpu.draws,countBeforeDeadline);
 assert.equal(await timed.estimate({}, {},2),null,'expired work drains before a new attempt can submit');
 gpu.hold=false;assert.equal(await work,null);assert.equal(timed.lastRun.reason,'deadline');
 assert.equal(timed.diagnostics.deadlinePairs,1);assert.equal(timed.lastSerial,-1,'partial encoders are never reused');
 assert.equal(timed.busy,false);
 gpu.onWait=null;assert.equal((await timed.estimate({}, {},2,.5,{deadline:2000})).valid,true,'the next usable pair can complete');
 let valid=true;gpu.hold=true;const replaced=timed.estimate({}, {},3,.5,{valid:()=>valid});
 valid=false;await new Promise(resolve=>setTimeout(resolve,5));assert.equal(timed.busy,true);
 gpu.hold=false;assert.equal(await replaced,null);assert.equal(timed.lastRun.reason,'obsolete');
 assert.equal(timed.lastSerial,-1);timed.destroy();
 console.log('PASS IFRNet: real model, shape reuse, dynamic active size, bounded LRU/memory, abort cleanup, bounded GPU batches and restart');
 console.log('PASS IFRNet: expired/replaced jobs stop dispatch, drain the GPU fence, retain ownership and recover without partial encoder reuse');
})().catch(e=>{console.error(e);process.exitCode=1;});
