// IFRNet host tests use the real bundled checkpoint and production graph.
// Mock GL checks ownership/queueing; shader arithmetic is tested in the browser.
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const S=require('../neural/model-spec.js');require('../neural/graph.js');
const Runtime=require('../neural/runtime.js');
function mockGL(maxWait=0){
 let id=0,program=null;const allocations=[],uniforms=[];
 const make=kind=>{const obj={id:++id,kind,dead:false};allocations.push(obj);return obj;};
 const drop=obj=>{assert.ok(!obj?.dead,'double deletion');if(obj)obj.dead=true;};
 const g={allocations,uniforms,waitTimeouts:[],draws:0,hold:false,compileHold:false,stats:[0,0,0,1],
  getExtension:n=>n==='KHR_parallel_shader_compile'?{COMPLETION_STATUS_KHR:'done'}:{},
  isContextLost:()=>false,getParameter:p=>p==='MAX_CLIENT_WAIT_TIMEOUT_WEBGL'?maxWait:4096,
  createTexture:()=>make('texture'),createProgram:()=>make('program'),createShader:()=>make('shader'),
  createFramebuffer:()=>make('fbo'),createVertexArray:()=>make('vao'),fenceSync:()=>make('sync'),
  deleteTexture:drop,deleteProgram:drop,deleteShader:drop,deleteFramebuffer:drop,deleteVertexArray:drop,deleteSync:drop,
  getProgramParameter:(_,p)=>p==='done'?!g.compileHold:true,
  getUniformLocation:(p,name)=>({p,name}),useProgram:p=>{program=p;},
  uniform2f:(loc,x,y)=>uniforms.push({program:loc.p,name:loc.name,x,y}),
  uniform1i:(loc,value)=>{if(loc.name==='kernelConfig')uniforms.push({program:loc.p,name:loc.name,value});},
  uniform2i:(loc,x,y)=>{if(loc.name==='outputLayout'||loc.name==='sampleSize')uniforms.push({program:loc.p,name:loc.name,x,y});},
  uniform3i:(loc,x,y,z)=>uniforms.push({program:loc.p,name:loc.name,x,y,z}),
  drawArrays:()=>{assert.ok(!program?.dead,'draw uses released program');g.draws++;g.onDraw?.(program);},
  clientWaitSync:(sync,flags,timeout)=>{assert.ok(!sync.dead);assert.equal(flags,0);g.waitTimeouts.push(timeout);g.onWait?.();return g.hold?'TIMEOUT_EXPIRED':'CONDITION_SATISFIED';},
  checkFramebufferStatus:()=> 'FRAMEBUFFER_COMPLETE',
  readPixels:(x,y,w,h,fmt,type,data)=>data.set(g.stats),
 };
 for(const n of ['shaderSource','compileShader','attachShader','linkProgram','texParameteri','texImage2D',
  'activeTexture','bindTexture','bindFramebuffer','bindVertexArray','framebufferTexture2D','viewport','uniform1f','flush','enable','disable','scissor'])g[n]=()=>{};
 return new Proxy(g,{get:(obj,key)=>key in obj?obj[key]:String(key)});
}
const count=(g,kind)=>g.allocations.filter(t=>t.kind===kind).length;
// Deterministic scalar kernels exercise the real host's sampler/swap bindings,
// graph ordering and fences. They do not stand in for GLSL conformance tests.
function encoderHarness(RuntimeClass){
 const gl=mockGL(1e9),rt=new RuntimeClass(gl,{}, {activeW:2,activeH:2});
 const units=new Map(),samplers=new Map();let active=null,target=null;
 const events=[];
 gl.activeTexture=unit=>{active=unit;};gl.bindTexture=(_,tex)=>units.set(active,tex);
 gl.framebufferTexture2D=(_target,_attachment,_kind,tex)=>{target=tex;};
 gl.uniform1i=(loc,unit)=>{if(!samplers.has(loc.p))samplers.set(loc.p,new Map());samplers.get(loc.p).set(loc.name,unit);};
 gl.onDraw=p=>{
  if(p.kernel)target.value=p.kernel(name=>units.get(gl.TEXTURE0+samplers.get(p).get(name)).value);
  events.push({stage:p.stage,slot:p.slot,part:p.part});rt.onDispatch?.(p);
 };
 const tensor=()=>({w:2,h:2,tw:2,th:2,texture:{value:0}});
 const op=(stage,slot,part,type,inputs,kernel)=>({type,inputs,out:tensor(),
  program:{program:{dead:false,stage,slot,part,kernel},locations:new Map()}});
 rt.enc=[0,1].map(slot=>{
  const prep=op('capture',slot,0,'preprocess',[],s=>s('source'));
  const first=op('encoder',slot,1,'mock',[prep.out],s=>s('s0')*3+2);
  const last=op('encoder',slot,2,'mock',[first.out],s=>s('s0')*2-1);
  return {graph:{ops:[prep,first,last]},features:[last.out]};
 });
 const pair=op('decoder',null,1,'mock',[rt.enc[0].features[0],rt.enc[1].features[0]],s=>s('s0')*100+s('s1'));
 const output=op('decoder',null,2,'mock',[pair.out],s=>s('s0')+5);
 rt.dec={graph:{ops:[pair,output]}};
 rt.swap=new Map([[rt.enc[0].features[0],rt.enc[1].features[0]],[rt.enc[1].features[0],rt.enc[0].features[0]]]);
 rt.statsTexture={};rt.statsProgram={program:{dead:false,stage:'stats'},locations:new Map()};
 return {rt,gl,events,output:()=>output.out.texture.value};
}
(async()=>{
 for(const cap of [0,1,1e9,NaN,Infinity,-1,.5,null,'1']){
  const gpu=mockGL(cap),runtime=new Runtime(gpu,{},{}),expected=Number.isFinite(cap)&&cap>=1?1:0;
  assert.equal(runtime.waitTimeoutNs,expected);
  assert.equal(await runtime.fence(0,{deadline:Infinity,reason:''}),true);
  assert.deepEqual(gpu.waitTimeouts,[expected]);runtime.destroy();
 }
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
 assert.ok(g.uniforms.some(u=>u.name==='sampleSize'&&u.x===16&&u.y===16),'scene sampling keeps its fixed 16x16 grid through dynamic loop bounds');
 assert.equal(r.render({}, {}, {},1920,1080),true);
 await r.resize(720,1280);const warmAlloc=g.allocations.length;
 assert.equal(r.lastSerial,-1,'resizing invalidates any retained encoder');
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

 const genericGL=mockGL(),generic=await Runtime.create(genericGL,bytes,64,32,'balanced',0,null,{generic:true});
 assert.equal(generic.shaderOptions.generic,true);
 const genericOps=[...generic.enc.flatMap(encoder=>encoder.graph.ops),...generic.dec.graph.ops].filter(op=>op.type==='conv');
 assert.equal(new Set(genericOps.map(op=>op.program)).size,3,'generic GL convolutions share aligned normal/residual and misaligned normal sources');
 const graphAPI=globalThis.VENeuralGraph;
 for(const op of genericOps){
  assert.deepEqual(op.convUniforms,graphAPI.convUniforms(op));
  const beforeUniforms=genericGL.uniforms.length;
  generic.runOps([op]);
  const uniforms=genericGL.uniforms.slice(beforeUniforms),config=uniforms.find(u=>u.name==='kernelConfig'),output=uniforms.find(u=>u.name==='outputLayout');
  assert.equal(config.program,op.program.program);assert.equal(config.value,op.convUniforms.kernelConfig);
  assert.deepEqual([output.x,output.y],op.convUniforms.outputLayout);
  op.convUniforms.inputs.forEach((values,i)=>{
   const layout=uniforms.find(u=>u.name==='s'+i+'Layout');assert.deepEqual([layout.x,layout.y,layout.z],values);
  });
 }
 const genericProgramCount=generic.programs.size;await generic.resize(128,64);
 assert.equal(generic.programs.size,genericProgramCount,'generic convolution metadata stays outside the program cache key');
 assert.ok((await generic.estimate({}, {},1)).valid);generic.destroy();

 // Use a controlled clock, not timer races, to expire a real production job
 // while the mock GPU fence still owns an expensive dispatch.
 let clock=1000;
 const sandbox={module:{exports:{}},VENeuralSpec:S,VENeuralGraph:globalThis.VENeuralGraph,
  performance:{now:()=>clock},setTimeout,clearTimeout};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../neural/runtime.js'),'utf8'),sandbox);
 const gpu=mockGL(1e9),timed=await sandbox.module.exports.create(gpu,bytes,1280,720);
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
 assert.ok(gpu.waitTimeouts.length>0&&gpu.waitTimeouts.every(n=>n===1),'pending Firefox-style fences keep the supported minimal timeout');
 gpu.onWait=null;assert.equal((await timed.estimate({}, {},2,.5,{deadline:2000})).valid,true,'the next usable pair can complete');
 let valid=true;gpu.hold=true;const replaced=timed.estimate({}, {},3,.5,{valid:()=>valid});
 valid=false;await new Promise(resolve=>setTimeout(resolve,5));assert.equal(timed.busy,true);
 gpu.hold=false;assert.equal(await replaced,null);assert.equal(timed.lastRun.reason,'obsolete');
 assert.equal(timed.lastSerial,-1);timed.destroy();

 // A completed current encoder remains useful after this pair's decoder
 // expires. Exercise actual host bindings with scalar reference kernels so
 // swapped slots must produce the same result as two cold encoders.
 const encoderCases=[
  {name:'decoder deadline',stage:'decoder',part:1,keep:true},
  {name:'last encoder fence after deadline',stage:'encoder',slot:1,part:2,keep:true},
  {name:'incomplete previous encoder',stage:'encoder',slot:0,part:1,keep:true},
  {name:'incomplete current encoder',stage:'encoder',slot:1,part:1,keep:false},
  {name:'source invalidated',stage:'decoder',part:1,keep:false,source:false},
  {name:'epoch invalidated',stage:'decoder',part:1,keep:false,reset:true},
  {name:'adjacent pair replaced',stage:'decoder',part:1,keep:true,pair:false},
  {name:'default validity rejects cache',stage:'decoder',part:1,keep:false,pair:false,defaultCache:true},
 ];
 for(const scenario of encoderCases){
  clock=1000;
  const h=encoderHarness(sandbox.module.exports),rt=h.rt;let pairValid=true,sourceValid=true;
  rt.onDispatch=p=>{
   if(p.stage!==scenario.stage||p.part!==scenario.part||(scenario.slot!==undefined&&p.slot!==scenario.slot))return;
   if(scenario.reset)rt.reset();
   else if(scenario.source===false)sourceValid=false;
   else if(scenario.pair===false)pairValid=false;
   else clock=1011;
  };
  const options={deadline:1010,valid:()=>pairValid&&sourceValid};
  if(!scenario.defaultCache)options.cacheValid=()=>sourceValid;
  assert.equal(await rt.estimate({value:2},{value:4},10,.5,options),null,scenario.name);
  assert.equal(rt.lastSerial,scenario.keep?10:-1,scenario.name);
  assert.equal(rt.lastRun.completed,false,'retained encoder does not count as a completed prediction');
  assert.equal(rt.lastRun.cachedEncoder,scenario.keep,scenario.name);
  assert.equal(rt.diagnostics.cancelledPairs,1);
  rt.onDispatch=null;h.events.length=0;clock=1100;
  const next=await rt.estimate({value:4},{value:7},11,.5,{deadline:1200});
  assert.equal(next.valid,true);assert.equal(next.reusedEncoder,scenario.keep,scenario.name);
  assert.equal(h.events.filter(e=>e.stage==='encoder').length,scenario.keep?2:4,scenario.name);
  assert.equal(h.output(),(6*4+3)*100+(6*7+3)+5,scenario.name+' preserves endpoint order');
  // Alternate the slots once more: both decoder binding orientations matter.
  const following=await rt.estimate({value:7},{value:9},12);
  assert.equal(following.reusedEncoder,true);
  assert.equal(h.output(),(6*7+3)*100+(6*9+3)+5);
  rt.reset();assert.equal(rt.lastSerial,-1);rt.destroy();
 }
 const cold=encoderHarness(sandbox.module.exports);clock=1200;
 assert.equal((await cold.rt.estimate({value:4},{value:7},100)).reusedEncoder,false);
 assert.equal(cold.output(),2750,'cold scalar reference agrees with retained encoder');cold.rt.destroy();

 const fenced=encoderHarness(sandbox.module.exports);clock=1220;
 let atEncoderFence;const encoderFence=new Promise(resolve=>{atEncoderFence=resolve;});
 fenced.gl.onWait=()=>{if(fenced.gl.hold)atEncoderFence();};
 fenced.rt.onDispatch=p=>{if(p.stage==='encoder'&&p.slot===1&&p.part===2)fenced.gl.hold=true;};
 const completing=fenced.rt.estimate({value:2},{value:4},15,.5,{deadline:1230});
 await encoderFence;clock=1231;
 await new Promise(resolve=>setTimeout(resolve,5));
 assert.equal(fenced.rt.busy,true);assert.equal(fenced.rt.lastSerial,-1,'submitted encoder is not cached before its fence drains');
 fenced.gl.hold=false;assert.equal(await completing,null);
 assert.equal(fenced.rt.lastSerial,15,'a fully drained encoder can survive its expired deadline');fenced.rt.destroy();

 const partialTile=encoderHarness(sandbox.module.exports);clock=1250;
 const lastEncoderOp=partialTile.rt.enc[1].graph.ops[2];
 lastEncoderOp.out.tw=1001;lastEncoderOp.out.th=7;lastEncoderOp.layer={ci:96,k:3};
 partialTile.rt.layers.set(lastEncoderOp.layer,{value:0});
 Object.defineProperty(partialTile.rt,'dispatchWork',{get:()=>128*1024,set:()=>{}});
 partialTile.rt.onDispatch=p=>{if(p.stage==='encoder'&&p.slot===1&&p.part===2)clock=1261;};
 assert.equal(await partialTile.rt.estimate({value:2},{value:4},16,.5,{deadline:1260}),null);
 assert.equal(partialTile.rt.lastSerial,-1,'the first tile of the final encoder operation is not a completed encoder');
 assert.equal(partialTile.rt.lastRun.cachedEncoder,false);partialTile.rt.destroy();

 // Overwriting the next endpoint incompletely must not leave an earlier
 // completed encoder carrying the replacement frame's serial.
 const overwrite=encoderHarness(sandbox.module.exports);clock=1300;
 await overwrite.rt.estimate({value:2},{value:4},20);
 overwrite.rt.onDispatch=p=>{if(p.stage==='encoder'&&p.part===1)clock=1311;};
 assert.equal(await overwrite.rt.estimate({value:4},{value:7},21,.5,{deadline:1310}),null);
 assert.equal(overwrite.rt.lastSerial,-1);
 overwrite.rt.onDispatch=null;clock=1400;
 assert.equal((await overwrite.rt.estimate({value:7},{value:9},22)).reusedEncoder,false);
 assert.equal(overwrite.output(),4562);overwrite.rt.destroy();

 const skipped=encoderHarness(sandbox.module.exports);clock=1500;
 await skipped.rt.estimate({value:2},{value:4},30);
 assert.equal((await skipped.rt.estimate({value:7},{value:9},32)).reusedEncoder,false,'non-adjacent serial never reuses the encoder');
 assert.equal(skipped.output(),4562);skipped.rt.destroy();

 // An asynchronous completion cache may add a fixed 4 ms to a fence even
 // when GPU work is negligible. Exercise real estimate/runBatched policies
 // with a deterministic clock; no timer duration stands in for GPU arithmetic.
 clock=1600;
 const latency=encoderHarness(sandbox.module.exports),latencyRuntime=latency.rt;
 let pendingWork=0,workPerMs=Infinity,coldDelay=50,fenceCount=0;
 const budgets=[];
 latency.gl.onWait=()=>{
  budgets.push(latencyRuntime.dispatchWork);fenceCount++;
  clock+=4+(Number.isFinite(workPerMs)?pendingWork/workPerMs:0)+coldDelay;
  pendingWork=0;coldDelay=0;
 };
 assert.ok((await latencyRuntime.estimate({value:2},{value:4},1)).valid);
 assert.equal(latencyRuntime.completionFloorMs,null,'a cold endpoint fence over 8 ms cannot define completion overhead');
 assert.ok((await latencyRuntime.estimate({value:4},{value:7},2)).valid);
 assert.equal(latencyRuntime.completionFloorMs,4,'cheap endpoint/statistics fence measures the fixed completion floor');
 const convolution={type:'conv',inputs:[],out:{w:4096,h:64,tw:4096,th:64},layer:{ci:32,k:3},program:{warmed:true}};
 latencyRuntime.runOps=(ops,_source,_phase,_swap,tile)=>{
  for(const op of ops){const cost=op.layer?op.layer.ci*(op.deconv?4:op.layer.k*op.layer.k):4;
   pendingWork+=(tile?tile.w*tile.h:op.out.tw*op.out.th)*cost;
  }
 };
 const runQuantum=()=>latencyRuntime.runBatched([convolution],latencyRuntime.epoch,.5,false,{deadline:Infinity,reason:'',targetMs:2});
 const initialBudget=32*1024*1024,minimumBudget=128*1024;
 latencyRuntime.dispatchWork=initialBudget;
 for(let i=0;i<4;i++){assert.equal(await runQuantum(),true);assert.ok(latencyRuntime.dispatchWork>=initialBudget,'fixed completion latency must not halve persistent work down to MIN');}
 latencyRuntime.dispatchWork=minimumBudget;const recoveryStart=fenceCount;
 assert.equal(await runQuantum(),true);assert.ok(latencyRuntime.dispatchWork>=initialBudget,'an already collapsed minimum budget recovers through bounded growth');
 assert.ok(fenceCount-recoveryStart<32,'recovery cannot require hundreds of minimum-size fence roundtrips');
 // Known work adds a real execution component beyond the same 4 ms callback
 // floor. The steady target is 2 ms of observed excess, with bounded updates.
 workPerMs=4*1024*1024;latencyRuntime.dispatchWork=initialBudget;
 assert.equal(await runQuantum(),true);
 assert.ok(latencyRuntime.dispatchWork>=7*1024*1024&&latencyRuntime.dispatchWork<=9*1024*1024,'genuine work latency reduces the quantum to its 2 ms target');
 // One first-use compilation spike must not poison future persistent slices;
 // the identical warm kernel remains eligible for normal slow-work feedback.
 workPerMs=Infinity;latencyRuntime.dispatchWork=initialBudget;convolution.program.warmed=false;coldDelay=50;budgets.length=0;
 assert.equal(await runQuantum(),true);assert.equal(budgets[1],initialBudget,'cold compilation cannot shrink the following work budget');
 assert.ok(latencyRuntime.diagnostics.coldDispatchSamples>=1);
 workPerMs=4*1024*1024;latencyRuntime.dispatchWork=initialBudget;
 assert.equal(await runQuantum(),true);assert.ok(latencyRuntime.dispatchWork<initialBudget,'the warmed kernel still adapts to real slow GPU work');
 latencyRuntime.destroy();

 // Calibration may never qualify on a slow/contended context. Excluding its
 // >8 ms cheap fences must not disable all feedback for warmed neural slices.
 clock=2200;const unknownFloor=encoderHarness(sandbox.module.exports),unknownRuntime=unknownFloor.rt;
 unknownFloor.gl.onWait=()=>{clock+=40;};
 assert.ok((await unknownRuntime.estimate({value:2},{value:4},1)).valid);
 assert.ok((await unknownRuntime.estimate({value:4},{value:7},2)).valid);
 assert.equal(unknownRuntime.completionFloorMs,null,'repeated slow endpoint fences keep the completion floor unknown');
 const slowWarmOp={type:'conv',inputs:[],out:{w:128,h:1,tw:128,th:1},layer:{ci:32,k:3},program:{warmed:false}};
 unknownRuntime.runOps=()=>{};unknownRuntime.dispatchWork=initialBudget;
 const unknownQuantum=()=>unknownRuntime.runBatched([slowWarmOp],unknownRuntime.epoch,.5,false,{deadline:Infinity,reason:'',targetMs:2});
 assert.equal(await unknownQuantum(),true);assert.equal(unknownRuntime.dispatchWork,initialBudget,'unknown floor still excludes the first-use 40 ms outlier');
 for(let i=0;i<3;i++){
  const previous=unknownRuntime.dispatchWork;assert.equal(await unknownQuantum(),true);
  assert.equal(unknownRuntime.dispatchWork,previous*.5,'warm 40 ms slices reduce their budget with conservative raw timing while calibration is unavailable');
 }
 assert.equal(unknownRuntime.completionFloorMs,null);unknownRuntime.destroy();

 // A lucky cache-ready zero cannot remain the baseline for the document's
 // lifetime when subsequent endpoint fences have a stable 4 ms cadence.
 clock=2700;const lucky=encoderHarness(sandbox.module.exports),luckyRuntime=lucky.rt;
 let completionDelay=0;lucky.gl.onWait=()=>{clock+=completionDelay;};
 assert.ok((await luckyRuntime.estimate({value:2},{value:4},1)).valid);
 assert.equal(luckyRuntime.completionFloorMs,0);
 completionDelay=4;assert.ok((await luckyRuntime.estimate({value:4},{value:7},2)).valid);
 assert.equal(luckyRuntime.completionFloorMs,0,'the zero remains conservatively eligible until it leaves the bounded window');
 const luckyOps=luckyRuntime.runOps.bind(luckyRuntime);luckyRuntime.runOps=()=>{};
 const luckyQuantum=()=>luckyRuntime.runBatched([convolution],luckyRuntime.epoch,.5,false,{deadline:Infinity,reason:'',targetMs:2});
 luckyRuntime.dispatchWork=initialBudget;assert.equal(await luckyQuantum(),true);
 assert.equal(luckyRuntime.dispatchWork,minimumBudget,'regression setup reproduces collapse while the stale zero remains in the sample window');
 luckyRuntime.runOps=luckyOps;
 for(let i=0;i<7;i++)assert.ok((await luckyRuntime.estimate({value:7+i},{value:8+i},3+i)).valid);
 assert.equal(luckyRuntime.completionSamples.length,8);assert.ok(luckyRuntime.completionSamples.every(ms=>ms===4));
 assert.equal(luckyRuntime.completionFloorMs,4,'eight stable samples expire the stale zero');
 luckyRuntime.runOps=()=>{};assert.equal(await luckyQuantum(),true);
 assert.ok(luckyRuntime.dispatchWork>=initialBudget,'the minimum budget recovers after the recent completion floor stabilizes');
 luckyRuntime.destroy();

 // Exercise the browser MessageChannel path, which normal Node tests bypass.
 let browserClock=0,portBurst=0,maxPortBurst=0,browserPolls=0;
 const timerDelays=[];
 class TestChannel{
  constructor(){this.port1={};this.port2={postMessage:()=>{
   maxPortBurst=Math.max(maxPortBurst,++portBurst);queueMicrotask(()=>this.port1.onmessage());}};}
 }
 const browserSandbox={module:{exports:{}},VENeuralSpec:S,VENeuralGraph:globalThis.VENeuralGraph,
  document:{},MessageChannel:TestChannel,performance:{now:()=>browserClock},
  setTimeout:(callback,ms)=>{timerDelays.push(ms);portBurst=0;browserClock+=ms;queueMicrotask(callback);return timerDelays.length;},clearTimeout};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../neural/runtime.js'),'utf8'),browserSandbox);
 const pollingGL=mockGL(),polling=new browserSandbox.module.exports(pollingGL,{},{});
 const heldJob={deadline:.5,valid:()=>true,reason:''};pollingGL.hold=true;
 pollingGL.onWait=()=>{
  browserPolls++;
  if(browserPolls===10){assert.equal(heldJob.reason,'deadline');assert.ok([...polling.syncs].every(sync=>!sync.dead),'expired work keeps its fence until completion');}
  if(browserPolls===17)pollingGL.hold=false;
 };
 assert.equal(await polling.fence(0,heldJob),false);
 assert.equal(browserPolls,17);assert.deepEqual(timerDelays,[1,1]);assert.ok(maxPortBurst<=8,'fast polling cannot monopolize the task queue');
 assert.equal(polling.syncs.size,0);assert.ok(pollingGL.waitTimeouts.every(n=>n===0));
 const timerCount=timerDelays.length;
 assert.equal(await polling.fence(0,{deadline:Infinity,reason:''}),true);
 assert.equal(timerDelays.length,timerCount,'an already completed fence never incurs the timer backoff');
 pollingGL.hold=true;pollingGL.onWait=()=>polling.destroy();
 assert.equal(await polling.fence(0,{deadline:Infinity,reason:''}),false);
 assert.equal(polling.syncs.size,0,'destruction cancels pending browser polling without double deletion');
 console.log('PASS IFRNet: real model, shape reuse, dynamic active size, bounded LRU/memory, abort cleanup, bounded GPU batches and restart');
 console.log('PASS IFRNet: expired/replaced jobs stop dispatch, drain the GPU fence, retain ownership and recover without partial encoder reuse');
 console.log('PASS IFRNet: only fully fenced source-current encoders survive decoder cancellation; adjacent reuse preserves cold-reference bindings');
 console.log('PASS IFRNet: browser fast polling is bounded, yields timers and drains expired fences before releasing them');
 console.log('PASS IFRNet: fixed completion overhead cannot collapse the quantum; MIN recovers, real work still reduces the budget, cold outliers are excluded');
 console.log('PASS IFRNet: warm slow slices retain bounded raw-timing feedback when all cheap calibration fences exceed 8 ms');
 console.log('PASS IFRNet: a stale zero completion sample expires from the bounded window and minimum dispatch work recovers');
})().catch(e=>{console.error(e);process.exitCode=1;});
