// IFRNet host tests use the real bundled checkpoint and production graph.
// Mock GL checks ownership/queueing; shader arithmetic is tested in the browser.
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
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
  clientWaitSync:sync=>{assert.ok(!sync.dead);return g.hold?'TIMEOUT_EXPIRED':'CONDITION_SATISFIED';},
  checkFramebufferStatus:()=> 'FRAMEBUFFER_COMPLETE',
  readPixels:(x,y,w,h,fmt,type,data)=>data.set(g.stats),
 };
 for(const n of ['shaderSource','compileShader','attachShader','linkProgram','texParameteri','texImage2D',
  'activeTexture','bindTexture','bindFramebuffer','bindVertexArray','framebufferTexture2D','viewport','uniform1i','uniform1f','uniform2i','flush'])g[n]=()=>{};
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
 const stateBefore=r.state,c=new AbortController();g.compileHold=true;
 const prepare=r.resize(100,300,'balanced',c.signal);setTimeout(()=>c.abort(),15);
 await assert.rejects(prepare,{name:'AbortError'});g.compileHold=false;
 await r.resize(1000,1000);assert.equal(r.state,stateBefore);

 // Only endpoint capture is submitted synchronously. A cancelled inference
 // cannot leave the rest of the network queued ahead of a new feed item.
 const before=g.draws;g.hold=true;
 const pending=r.estimate({}, {},20);assert.equal(g.draws-before,3,'capture only before compositor yields');
 await new Promise(resolve=>setTimeout(resolve,5));const submitted=g.draws;r.reset();
 assert.equal(await pending,null);assert.equal(g.draws,submitted,'no further batch after cancellation');
 assert.ok(submitted-before<=11,'at most one eight-op batch can be outstanding');
 g.hold=false;
 assert.equal((await r.estimate({}, {},21)).valid,true,'inference resumes without recreating the model');
 r.destroy();r.destroy();assert.ok(g.allocations.every(t=>t.dead),'all shared and cached resources are released');
 console.log('PASS IFRNet: real model, shape reuse, dynamic active size, bounded LRU/memory, abort cleanup, bounded GPU batches and restart');
})().catch(e=>{console.error(e);process.exitCode=1;});
