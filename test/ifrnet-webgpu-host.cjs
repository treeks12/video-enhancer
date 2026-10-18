// Host/lifecycle contract only. Does not execute WGSL or establish GPU quality/timing.
'use strict';
const assert=require('node:assert/strict');
global.GPUBufferUsage={MAP_READ:1,COPY_SRC:4,COPY_DST:8,UNIFORM:64,STORAGE:128};
global.GPUTextureUsage={COPY_SRC:1,COPY_DST:2,TEXTURE_BINDING:4,STORAGE_BINDING:8,RENDER_ATTACHMENT:16};
global.GPUShaderStage={VERTEX:1,FRAGMENT:2,COMPUTE:4};global.GPUMapMode={READ:1};
global.VENeuralGraph=require('../neural/graph.js');global.VENeuralWebGPUShaders=require('../neural/webgpu-shaders.js');
const spec=require('../neural/model-spec.js');
const layer=(ci,co,k=3)=>({ci,co,k,weights:new Float32Array(ci*co*k*k),bias:new Float32Array(co),slope:new Float32Array(co)});
function model(){return {encoder:spec.ENCODER.map(shape=>layer(...shape)),decoder:spec.DECODER.map(([ci,c,co])=>({entry:layer(ci,c),r1:layer(c,c),s1:layer(24,24),r2:layer(c,c),s2:layer(24,24),r3:layer(c,c),up:layer(c,co,4)}))};}
global.VENeuralSpec={...spec,decodeWeightsAsync:async()=>model()};
let device;
Object.defineProperty(global,'navigator',{configurable:true,value:{gpu:{requestAdapter:async()=>({requestDevice:async options=>{assert.equal(options,undefined,'no mandatory optional features');return device;}}),getPreferredCanvasFormat:()=> 'bgra8unorm'}}});
global.OffscreenCanvas=class {
 constructor(width,height){this.width=width;this.height=height;}
 getContext(name){assert.equal(name,'webgpu');const canvas=this;return this.context={configurations:[],textures:[],configure(config){assert.equal(config.alphaMode,'premultiplied','avoid Chromium opaque-canvas snapshot browser-copy pipeline on every configuration');this.configuration=config;this.configurations.push(config);},unconfigure(){},getCurrentTexture(){const texture={canvas,width:canvas.width,height:canvas.height,format:this.configuration.format,usage:this.configuration.usage??GPUTextureUsage.RENDER_ATTACHMENT,createView:()=>({canvas:true})};this.textures.push(texture);return texture;}};}
};
function mock({external=false,aliasExternal=false}={}){
 const allocations=[],submissions=[],writes=[],copies=[],gates=[],mapGates=[];let submitted=0,completed=0;
 const d={limits:{maxTextureDimension2D:8192,minUniformBufferOffsetAlignment:256},lost:new Promise(()=>{}),holdNext:false,modules:[],samplers:[],renderPipelines:0,renderPasses:0,
  createSampler(descriptor){const sampler={...descriptor,sampler:true};d.samplers.push(sampler);return sampler;},
  createBuffer(descriptor){const buffer={...descriptor,data:new ArrayBuffer(descriptor.size),dead:false,destroy(){this.dead=true;},async mapAsync(mode,offset,size){assert.equal(size,16,'only scene statistics may be mapped');assert.ok(!this.dead);this.unmapped=false;if(d.holdMap)await new Promise(resolve=>mapGates.push(resolve));},getMappedRange(offset,size){return this.data.slice(offset,offset+size);},unmap(){this.unmapped=true;}};allocations.push(buffer);return buffer;},
  createTexture(descriptor){const texture={...descriptor,dead:false,destroy(){this.dead=true;},createView(){assert.ok(!this.dead);return {texture:this};}};allocations.push(texture);return texture;},
  createBindGroupLayout:descriptor=>descriptor,createPipelineLayout:descriptor=>descriptor,
  createShaderModule(descriptor){d.modules.push(descriptor);return descriptor;},
  async createComputePipelineAsync(descriptor){return {...descriptor,getBindGroupLayout(index){return descriptor.layout.bindGroupLayouts[index];}};},
  async createRenderPipelineAsync(descriptor){d.renderPipelines++;return {...descriptor,getBindGroupLayout(){return {render:true};}};},
  createBindGroup(descriptor){for(const entry of descriptor.entries){const resource=entry.resource.texture||entry.resource.buffer;assert.ok(!resource?.dead);if(entry.resource.external){assert.equal(entry.resource.source.closed,false);assert.notEqual(entry.resource.expired,true,'a closed alias wrapper expired this external texture');}}
   if(descriptor.layout.entries)assert.deepEqual(descriptor.entries.map(entry=>entry.binding),descriptor.layout.entries.map(entry=>entry.binding));return descriptor;},
  createCommandEncoder(){const stages=[],bufferCopies=[],textureCopies=[];let finished=false;return {
   beginComputePass(){let pipeline,group,offsets;return {setPipeline(p){pipeline=p;},setBindGroup(i,g,off){group=g;offsets=off;},dispatchWorkgroups(...dims){assert.ok(dims.every(value=>Number.isInteger(value)&&value>0));stages.push({pipeline,group,offset:offsets[0],dims});},end(){}};},
   beginRenderPass(){d.renderPasses++;return {setPipeline(){},setBindGroup(){},draw(){},end(){}};},
   copyTextureToTexture(source,destination,size){assert.equal(finished,false);assert.ok(!source.texture.dead);assert.ok(source.texture.usage&GPUTextureUsage.COPY_SRC);assert.ok(destination.texture.usage&GPUTextureUsage.COPY_DST);assert.equal(source.texture.format,destination.texture.format);assert.deepEqual(size,[destination.texture.width,destination.texture.height]);textureCopies.push({source,destination,size});},
   copyBufferToBuffer(...args){assert.equal(finished,false);bufferCopies.push(args);},finish(){assert.equal(finished,false,'command encoder may only finish once');finished=true;return {stages,bufferCopies,textureCopies};}
  };},
  addEventListener(){},destroy(){this.dead=true;},
  queue:{
   writeBuffer(buffer,offset,data,dataOffset=0,size=data.byteLength){assert.ok(!buffer.dead);assert.ok((buffer.lockedUntil||0)<=completed,'uniform buffer overwritten before its submitted GPU work drained');new Uint8Array(buffer.data,offset,size).set(new Uint8Array(data.buffer||data,data.byteOffset+dataOffset||dataOffset,size));writes.push({buffer,offset,size});},
   writeTexture(){},
   copyExternalImageToTexture(source,destination){assert.ok(!destination.texture.dead);copies.push({source,destination});},
   submit(commands){submitted++;submissions.push(...commands);for(const command of commands){
    assert.equal(new Set(command.stages.map(stage=>stage.offset)).size,command.stages.length,'each dispatch gets immutable uniforms');
    for(const stage of command.stages){const uniform=stage.group.entries.find(entry=>entry.binding===0).resource.buffer;uniform.lockedUntil=submitted;
     const view=new DataView(uniform.data,stage.offset,48);stage.region=[16,20,24,28].map(offset=>view.getUint32(offset,true));stage.debug=view.getUint32(36,true);
     stage.logicalSize=[0,4].map(offset=>view.getUint32(offset,true));stage.active=[8,12].map(offset=>view.getUint32(offset,true));stage.outputSize=[40,44].map(offset=>view.getUint32(offset,true));
     if(stage.dims[2]>1){const [x,y,w,h]=stage.region;assert.equal(x%8,0,'shared tile x origin');assert.equal(y%8,0,'shared tile y origin');
      assert.ok(x+w<=view.getUint32(0,true),'tiled convolution uses logical width');assert.ok(y+h<=view.getUint32(4,true),'tiled convolution uses logical height');
      assert.equal(stage.dims[0],Math.ceil(w/8));assert.equal(stage.dims[1],Math.ceil(h/8));
     }
    }
    for(const [source,offset,target,targetOffset,size]of command.bufferCopies){assert.equal(size,16);new Float32Array(target.data,targetOffset,4).set([0,0,0,1]);}
   }},
   onSubmittedWorkDone(){const target=submitted;if((d.holdNext||d.holding)&&target>completed){d.holdNext=false;d.holding=true;return new Promise(resolve=>gates.push(()=>{completed=Math.max(completed,target);if(!gates.length)d.holding=false;d.onDone?.();resolve();}));}completed=target;d.onDone?.();return Promise.resolve();}
  },allocations,submissions,writes,copies,gates,mapGates
 };if(external){const cache=new Map();d.importExternalTexture=({source})=>{if(d.failImport)throw new Error('injected external import failure');assert.equal(source.closed,false);if(!aliasExternal)return {external:true,source};let resource=cache.get(source.imageId);if(!resource||resource.expired){resource={external:true,source,expired:false};cache.set(source.imageId,resource);}const imported=resource;source.closeListeners.push(()=>{imported.expired=true;});return imported;};}return d;
}
const gl={NO_ERROR:0,FRAMEBUFFER:1,TEXTURE0:2,TEXTURE_2D:3,RGBA:4,UNSIGNED_BYTE:5,isContextLost:()=>false,bindFramebuffer(){},activeTexture(){},bindTexture(){},texSubImage2D(...args){this.upload=args.at(-1);},getError(){throw new Error('render must not synchronously poll WebGL errors');}};
const Runtime=require('../neural/webgpu-runtime.js');
const video={videoWidth:64,videoHeight:32};
async function create(){device=mock();return Runtime.create(gl,new Uint8Array(),64,32);}
async function tickUntil(predicate){for(let i=0;i<100&&!predicate();i++)await new Promise(resolve=>setTimeout(resolve,1));assert.ok(predicate(),'expected async state reached');}
async function withPerformanceClock(run){
 const descriptor=Object.getOwnPropertyDescriptor(global,'performance');let time=0;
 Object.defineProperty(global,'performance',{configurable:true,enumerable:descriptor?.enumerable??true,writable:true,value:{now:()=>time}});
 try{return await run({now:()=>time,set:value=>{time=value;}});}
 finally{if(descriptor)Object.defineProperty(global,'performance',descriptor);else delete global.performance;}
}
(async()=>{
 let engine=await create();assert.equal(engine.backend,'webgpu');assert.equal(engine.sources.length,4);assert.equal(engine.shapes.size,1);
 // Premultiplied canvas export is equivalent only while every synthesis path
 // writes alpha 1 (including non-finite fallback and every debug view), and the
 // fullscreen blit forwards that RGBA unchanged. Native integration checks the
 // resulting alpha bytes exactly; these assertions guard the source contract.
 assert.equal((engine.state.synth.code.match(/textureStore\(output,q,/g)||[]).length,2);
 assert.ok(engine.state.synth.code.includes('textureStore(output,q,vec4<f32>(prevB(uv).rgb,1.0))'));
 assert.ok(engine.state.synth.code.includes('textureStore(output,q,vec4<f32>(clamp(v,vec3<f32>(0.0),vec3<f32>(1.0)),1.0))'));
 assert.ok(device.modules.find(module=>module.label==='IFRNet canvas blit').code.includes('return textureLoad(image,p,0);'),'canvas blit preserves opaque synthesis alpha');
 assert.equal(await engine.estimate({}, {},1),null,'uncaptured pairs never use current video/stale GL endpoints');
 engine.captureFrame(video,0);engine.captureFrame(video,1);assert.equal(device.copies.length,2);
 const prev={},curr={},target={},result=await engine.estimate(prev,curr,1,.5,{debug:'flow'});
 assert.ok(result.valid);assert.deepEqual(result.stats,[0,0,0,1]);assert.equal(engine.lastRun.cachedEncoder,true);
 assert.ok(device.submissions.some(command=>command.stages.some(stage=>stage.dims[2]>1)),'shared convolutions dispatch output groups along Z');
 assert.equal(engine.render(prev,curr,target,64,32,'flow'),true);assert.equal(gl.upload,engine.stage);
 assert.throws(()=>engine.render(prev,curr,target,64,32,'mask'),/debug view changed/);
 assert.equal(engine.render({},curr,target,64,32,'flow'),false,'reject unrelated texture ownership');
 engine.captureFrame(video,2);const second=await engine.estimate(curr,{},2,.5);assert.equal(second.reusedEncoder,true);
 const pipelines=engine.pipelines.size,weightTextures=engine.layers.size;
 await engine.resize(128,64);assert.equal(engine.pipelines.size,pipelines,'dynamic dimensions share pipelines');assert.equal(engine.layers.size,weightTextures,'resizes share model weights');
 await engine.resize(256,128);assert.equal(engine.shapes.size,2,'retain at most two tensor shapes');assert.ok(engine.memoryBytes<256*1024*1024);
 assert.equal(await engine.estimate(prev,curr,2),null,'reset/resize invalidates snapshot epoch');
 await engine.destroy();assert.ok(device.allocations.every(resource=>resource.dead));

 engine=await create();engine.captureFrame(video,0);engine.captureFrame(video,1);
 let valid=true;device.holdNext=true;
 const cancelled=engine.estimate(prev,curr,1,.5,{valid:()=>valid,cacheValid:()=>true});
 await tickUntil(()=>device.gates.length===1);valid=false;
 assert.equal(engine.busy,true);assert.equal(engine.sources.filter(source=>source.refs===1).length,2);
 engine.captureFrame(video,2);engine.captureFrame(video,3);engine.captureFrame(video,4);
 assert.ok(engine.sources.some(source=>source.serial===0),'locked previous snapshot was not overwritten');
 device.gates.shift()();assert.equal(await cancelled,null);assert.equal(engine.busy,false);assert.equal(engine.lastRun.cachedEncoder,false);
 assert.equal(engine.sources.reduce((sum,source)=>sum+source.refs,0),0);await engine.destroy();

 engine=await create();engine.captureFrame(video,0);engine.captureFrame(video,1);engine.captureFrame(video,2);
 valid=true;const original=engine.runBatched.bind(engine);let graphRuns=0;
 engine.runBatched=async(...args)=>{const result=await original(...args);if(++graphRuns===2)valid=false;return result;};
 assert.equal(await engine.estimate(prev,curr,1,.5,{valid:()=>valid,cacheValid:()=>true}),null);
 assert.equal(engine.lastRun.cachedEncoder,true,'complete current encoder survives later decoder cancellation');
 engine.runBatched=original;const reused=await engine.estimate(curr,{},2,.5);assert.equal(reused.reusedEncoder,true);await engine.destroy();

 engine=await create();engine.captureFrame(video,0);engine.captureFrame(video,1);engine.dispatchWork=128*1024;
 valid=true;let drains=0;device.onDone=()=>{if(++drains===2)valid=false;};
 assert.equal(await engine.estimate(prev,curr,1,.5,{valid:()=>valid,cacheValid:()=>true}),null);
 assert.equal(engine.lastRun.cachedEncoder,false,'a partially submitted current encoder must not become reusable');
 assert.equal(engine.lastRun.stage,'encodeCurrent');device.onDone=null;engine.captureFrame(video,2);
 const afterPartial=await engine.estimate(curr,{},2,.5,{cacheValid:()=>true});
 assert.ok(afterPartial.valid);assert.equal(afterPartial.reusedEncoder,false,'the adjacent pair cannot reuse a partially submitted encoder');await engine.destroy();

 engine=await create();engine.captureFrame(video,0);engine.captureFrame(video,1);engine.dispatchWork=128*1024;
 valid=true;device.holdNext=true;
 const bounded=engine.estimate(prev,curr,1,.5,{valid:()=>valid,cacheValid:()=>true});
 await tickUntil(()=>device.gates.length===4);
 assert.equal(engine.diagnostics.maxInFlight,4);assert.equal(engine.inFlight.length,4);
 assert.equal(new Set(engine.inFlight.map(record=>record.slot.buffer)).size,4,'in-flight slices own disjoint uniform buffers');
 const submissionCount=device.submissions.length;await new Promise(resolve=>setTimeout(resolve,5));
 assert.equal(device.submissions.length,submissionCount,'no fifth submission before the oldest completion');
 const recycled=engine.inFlight[0].slot.buffer;device.gates.shift()();
 await tickUntil(()=>device.submissions.length===submissionCount+1);
 assert.equal(engine.inFlight.at(-1).slot.buffer,recycled,'only the completed uniform buffer is recycled while three others remain in flight');
 assert.equal(engine.inFlight.length,4);assert.equal(engine.diagnostics.maxInFlight,4);
 valid=false;device.gates.shift()();await tickUntil(()=>engine.inFlight.filter(record=>!record.done).length===3);
 assert.equal(engine.busy,true,'cancellation keeps busy while three other submissions drain');
 while(device.gates.length)device.gates.shift()();assert.equal(await bounded,null);
 assert.equal(engine.busy,false);assert.equal(engine.sources.reduce((sum,source)=>sum+source.refs,0),0);await engine.destroy();

 engine=await create();engine.captureFrame(video,0);engine.captureFrame(video,1);engine.dispatchWork=1024*1024*1024;
 valid=true;device.holdNext=true;
 const fullEncoder=engine.estimate(prev,curr,1,.5,{valid:()=>valid,cacheValid:()=>true});
 await tickUntil(()=>device.gates.length===4);valid=false;
 assert.equal(engine.lastSerial,-1,'submitted encoder is not cached before GPU completion');
 device.gates.shift()();await tickUntil(()=>engine.inFlight.filter(record=>!record.done).length===3);
 assert.equal(engine.lastSerial,-1,'earlier preprocess completion cannot validate encoder features');
 device.gates.shift()();await tickUntil(()=>engine.lastSerial===1);
 assert.equal(engine.busy,true,'later decoder work remains owned after the encoder fence completes');
 while(device.gates.length)device.gates.shift()();assert.equal(await fullEncoder,null);
 assert.equal(engine.lastRun.cachedEncoder,true,'fully submitted encoder may be retained only after its final fence drains');
 await engine.destroy();

 await withPerformanceClock(async clock=>{
  engine=await create();engine.captureFrame(video,0);engine.captureFrame(video,1);engine.dispatchWork=1024*1024*1024;
  device.holdNext=true;let currentEncoderSubmitted=false;const runBatched=engine.runBatched.bind(engine);
  engine.runBatched=async(...args)=>{const result=await runBatched(...args);if(!currentEncoderSubmitted&&engine.activeJob?.stage==='encodeCurrent'){
   currentEncoderSubmitted=true;clock.set(10);
  }return result;};
  const deadlineRun=engine.estimate(prev,curr,1,.5,{deadline:10,cacheValid:()=>true});
  await tickUntil(()=>currentEncoderSubmitted&&engine.activeJob?.reason==='deadline');
  assert.equal(device.gates.length,2,'preprocess and complete current encoder are submitted while both fences remain held');
  assert.equal(engine.lastSerial,-1,'a fully submitted encoder stays uncached before its final fence');
  device.gates.shift()();assert.equal(engine.lastSerial,-1,'preprocess completion alone cannot cache the encoder');
  device.gates.shift()();await tickUntil(()=>engine.lastSerial===1);
  assert.equal(await deadlineRun,null);
  assert.equal(engine.lastRun.reason,'deadline');assert.equal(engine.lastRun.cachedEncoder,true,'deadline cancellation keeps the complete encoder after its final fence drains');
  engine.runBatched=runBatched;engine.captureFrame(video,2);
  const adjacent=await engine.estimate(curr,{},2,.5,{cacheValid:()=>true});
  assert.ok(adjacent.valid);assert.equal(adjacent.reusedEncoder,true,'the next adjacent pair reuses the drained encoder');
  await engine.destroy();
 });

 await withPerformanceClock(async clock=>{
  engine=await create();engine.captureFrame(video,0);engine.captureFrame(video,1);engine.dispatchWork=1024*1024*1024;
  device.holdNext=true;let cacheAllowed=true,currentEncoderSubmitted=false;const runBatched=engine.runBatched.bind(engine);
  engine.runBatched=async(...args)=>{const result=await runBatched(...args);if(!currentEncoderSubmitted&&engine.activeJob?.stage==='encodeCurrent'){
   currentEncoderSubmitted=true;cacheAllowed=false;clock.set(10);
  }return result;};
  const deadlineRun=engine.estimate(prev,curr,1,.5,{deadline:10,cacheValid:()=>cacheAllowed});
  await tickUntil(()=>currentEncoderSubmitted&&engine.activeJob?.reason==='deadline');
  assert.equal(engine.lastSerial,-1,'cache invalidation during the held final fence cannot publish the encoder');
  while(device.gates.length)device.gates.shift()();assert.equal(await deadlineRun,null);
  assert.equal(engine.lastSerial,-1);assert.equal(engine.lastRun.reason,'deadline');assert.equal(engine.lastRun.cachedEncoder,false);
  await engine.destroy();
 });

 await withPerformanceClock(async clock=>{
  engine=await create();engine.captureFrame(video,0);engine.captureFrame(video,1);engine.dispatchWork=1024*1024*1024;
  device.holdNext=true;let currentEncoderSubmitted=false;const runBatched=engine.runBatched.bind(engine);
  engine.runBatched=async(...args)=>{const result=await runBatched(...args);if(!currentEncoderSubmitted&&engine.activeJob?.stage==='encodeCurrent'){
   currentEncoderSubmitted=true;engine.reset();
  }return result;};
  const obsoleteRun=engine.estimate(prev,curr,1,.5,{cacheValid:()=>true});
  await tickUntil(()=>currentEncoderSubmitted&&engine.activeJob?.reason==='obsolete');
  assert.equal(engine.lastSerial,-1,'epoch change while the final fence is held invalidates the pending encoder');
  while(device.gates.length)device.gates.shift()();assert.equal(await obsoleteRun,null);
  assert.equal(engine.lastSerial,-1);assert.equal(engine.lastRun.reason,'obsolete');assert.equal(engine.lastRun.cachedEncoder,false);
  engine.runBatched=runBatched;engine.captureFrame(video,0);engine.captureFrame(video,1);
  const restarted=await engine.estimate(prev,curr,1,.5,{cacheValid:()=>true});
  assert.ok(restarted.valid);assert.equal(restarted.reusedEncoder,false,'a new source epoch cannot reuse features from the obsolete pair');
  await engine.destroy();
 });

 await withPerformanceClock(async clock=>{
  engine=await create();engine.captureFrame(video,0);engine.captureFrame(video,1);engine.dispatchWork=128*1024;
  const encode=engine.encode.bind(engine),submit=engine.submit.bind(engine);
  engine.encode=(...args)=>{const result=encode(...args);clock.set(clock.now()+.05);return result;};
  engine.submit=(...args)=>{const result=submit(...args);clock.set(clock.now()+.05);return result;};
  const result=await engine.estimate(prev,curr,1,.5,{cacheValid:()=>true});
  assert.ok(result?.valid,'many small encode/submit slices complete successfully');
  assert.ok(engine.lastRun.batches>8,'the small-command fixture spans many submitted batches');
  assert.ok(engine.lastRun.taskYields<engine.lastRun.batches,'small batches do not each force a MessagePort yield');
  await engine.destroy();
 });

 await withPerformanceClock(async clock=>{
  engine=await create();engine.captureFrame(video,0);engine.captureFrame(video,1);engine.dispatchWork=128*1024;
  const encode=engine.encode.bind(engine);
  engine.encode=(...args)=>{const result=encode(...args);clock.set(clock.now()+2.1);return result;};
  const result=await engine.estimate(prev,curr,1,.5,{cacheValid:()=>true});
  assert.ok(result?.valid,'costly CPU encoding still completes when the task yields');
  assert.ok(engine.lastRun.taskYields>1,'sustained costly encoding yields repeatedly for event-loop fairness');
  await engine.destroy();
 });

 engine=await create();engine.captureFrame(video,0);engine.captureFrame(video,1);device.holdMap=true;valid=true;
 const mapped=engine.estimate(prev,curr,1,.5,{valid:()=>valid});await tickUntil(()=>device.mapGates.length===1);valid=false;
 await new Promise(resolve=>setTimeout(resolve,5));assert.equal(engine.busy,true,'cancellation waits for asynchronous statistics unmapping');
 const mappedDisposal=engine.destroy();assert.ok(!engine.sceneRead.dead);
 device.mapGates.shift()();assert.equal(await mapped,null);await mappedDisposal;assert.equal(engine.sceneRead.unmapped,true);assert.equal(engine.sceneRead.dead,true);

 engine=await create();engine.captureFrame(video,0);engine.captureFrame(video,1);device.holdNext=true;
 const work=engine.estimate(prev,curr,1);await tickUntil(()=>device.gates.length===1);
 const disposal=engine.destroy();assert.equal(engine.busy,true);assert.ok(device.allocations.every(resource=>!resource.dead),'destroy waits for submitted work');
 device.gates.shift()();assert.equal(await work,null);await disposal;
 assert.ok(device.allocations.every(resource=>resource.dead));assert.equal(engine.memoryBytes,0);

 const frames=[];global.VideoFrame=class {constructor(source,options){this.token=source.token;this.imageId=source.imageId??source.token;this.timestamp=options.timestamp;this.closed=false;this.closeListeners=[];frames.push(this);}close(){assert.equal(this.closed,false,'a VideoFrame closes exactly once');this.closed=true;for(const listener of this.closeListeners)listener();}};
 device=mock({external:true});engine=await Runtime.create(gl,new Uint8Array(),64,32);
 assert.equal(engine.captureMode,'external');assert.ok(engine.sources.every(source=>source.texture===null));assert.equal(engine.sourceBytes,64*32*4*4);
 assert.equal(device.samplers.length,1);assert.equal(engine.imageSampler,device.samplers[0]);
 assert.equal(engine.imageSampler.minFilter,'linear');assert.equal(engine.imageSampler.magFilter,'linear');
 assert.equal(engine.imageSampler.addressModeU,'clamp-to-edge');assert.equal(engine.imageSampler.addressModeV,'clamp-to-edge');
 assert.ok(engine.resourceIds.has(engine.imageSampler),'the shared sampler has a stable resource identity');
 for(const program of engine.pipelines.values())if(program.bindings.some(binding=>binding.kind==='external-texture')){
  assert.equal(program.bindings.filter(binding=>binding.kind==='sampler').length,1);
  assert.deepEqual(program.layout.entries.find(entry=>entry.sampler)?.sampler,{type:'filtering'});
 }
 for(let serial=0;serial<5;serial++){video.token=serial;engine.captureFrame(video,serial);}
 assert.equal(frames.filter(frame=>!frame.closed).length,4);assert.equal(frames[0].closed,true);assert.equal(device.copies.length,0);
 device.holdNext=true;const externalWork=engine.estimate(prev,curr,4);await tickUntil(()=>device.gates.length===1);
 const locked=engine.sources.filter(source=>source.refs).map(source=>source.frame);engine.reset();
 assert.ok(locked.every(frame=>!frame.closed),'reset preserves frames referenced by in-flight GPU commands');
 assert.equal(frames.filter(frame=>!frame.closed).length,2);device.gates.shift()();assert.equal(await externalWork,null);
 assert.ok(frames.every(frame=>frame.closed),'obsolete frames close only after the complete submitted queue drains');
 engine.captureFrame(video,10);engine.captureFrame(video,11);assert.ok((await engine.estimate(prev,curr,11,.5,{debug:'mask'})).valid);
 const samplerEntries=device.submissions.flatMap(command=>command.stages).flatMap(stage=>stage.group.entries).filter(entry=>entry.resource.sampler);
 assert.ok(samplerEntries.length>0);assert.ok(samplerEntries.every(entry=>entry.resource===engine.imageSampler),'all external-image programs bind the same sampler object');
 for(const program of engine.pipelines.values())if(program.bindings.some(binding=>binding.kind==='external-texture'))assert.equal(program.groups.size,0,'closed frames cannot be retained by cached bind groups');
 assert.equal(engine.render(prev,curr,target,64,32,'mask'),true);await engine.destroy();assert.ok(frames.every(frame=>frame.closed));

 device=mock({external:true});engine=await Runtime.create(gl,new Uint8Array(),64,32,'balanced',0,null,{captureMode:'rgba'});
 assert.equal(engine.captureMode,'rgba');engine.captureFrame(video,0);assert.equal(device.copies.length,1);await engine.destroy();
 device=mock({external:true});engine=await Runtime.create(gl,new Uint8Array(),64,32,'balanced',0,null,{captureMode:'rgba',filteredSources:true});
 assert.equal(engine.shaderOptions.filteredSources,true);assert.equal(device.samplers.length,1);
 assert.equal(engine.imageSampler.addressModeU,'clamp-to-edge');assert.equal(engine.imageSampler.addressModeV,'clamp-to-edge');
 const filteredPrograms=[...engine.pipelines.values()].filter(program=>program.bindings.some(binding=>binding.kind==='filterable-texture'));
 assert.ok(filteredPrograms.length>=3,'preprocess, synthesis and statistics use filterable source images');
 for(const program of filteredPrograms){
  for(const binding of program.bindings){
   const layout=program.layout.entries.find(entry=>entry.binding===binding.binding);
   if(binding.kind==='filterable-texture')assert.equal(layout.texture.sampleType,'float');
   if(binding.kind==='texture')assert.equal(layout.texture.sampleType,'unfilterable-float','model tensors retain their original sample type');
  }
 }
 engine.captureFrame(video,0);engine.captureFrame(video,1);assert.ok((await engine.estimate(prev,curr,1)).valid,'filtered RGBA images bind through a complete inference');
 assert.ok(filteredPrograms.every(program=>program.groups.size>0),'RGBA bind groups remain cacheable');await engine.destroy();
 device=mock({external:true});engine=await Runtime.create(gl,new Uint8Array(),64,32);device.failImport=true;
 assert.throws(()=>engine.captureFrame(video,0),/immutable VideoFrame capture failed/);assert.equal(frames.at(-1).closed,true);assert.equal(device.copies.length,0);await engine.destroy();

 // Direct compositor completion owns immutable source/compare frames until
 // its submitted queue drains, independently of inference single-flight.
 const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
 const compositorFactory=()=>({ready:true,dead:false,renders:[],snapshots:[],renderResult:true,renderError:false,idleError:false,idleGate:null,
  render(input,width,height,config){this.renders.push({input,width,height,config});if(!this.renderResult)return false;
   assert.notEqual(input.external?.expired,true,'compositor must bind a refreshed external texture');assert.notEqual(config.comparisonSource?.external?.expired,true,'comparison must bind a refreshed external texture');
   device.holdNext=true;device.queue.submit([{stages:[],bufferCopies:[],textureCopies:[]}]);
   if(this.renderError)throw new Error('injected compositor render');return true;},
  whenIdle(){if(this.idleError)throw new Error('injected compositor idle');return this.idleGate?.promise||Promise.resolve();},
  snapshot(texture,width,height,slot){const saved={texture,width,height,slot};this.snapshots.push(saved);return saved;},
  async destroy(){this.dead=true;}
 });
 let compositor;
 global.VENeuralCompositor={async create(received,canvas,options){assert.equal(received,device);assert.equal(options.captureMode,'external');assert.equal(options.lut,'test-lut');assert.equal(typeof options.waitForCompletion,'function');compositor=compositorFactory();return compositor;}};
 async function submittedEngine(direct=true){
  device=mock({external:true});engine=await Runtime.create(gl,new Uint8Array(),64,32);
  assert.equal(await engine.prepareCompositor({},'test-lut'),true);engine.directPresentation=direct;
  engine.captureFrame(video,0);engine.captureFrame(video,1);return engine;
 }
 function holdSynthesisFence(){const synthesize=engine.synthesize.bind(engine);engine.synthesize=async(...args)=>{device.holdNext=true;return synthesize(...args);};}
 device=mock({external:true});engine=await Runtime.create(gl,new Uint8Array(),64,32);
 assert.equal(await engine.prepareCompositor({},'test-lut'),true);
 video.token='held-source';engine.captureFrame(video,0);const ownedSource=engine.sources.find(source=>source.serial===0),ownedFrame=ownedSource.frame;
 assert.equal(engine.presentFrame(0,{algorithm:'native'},video),true);assert.equal(ownedSource.refs,1);assert.equal(engine.presentationJobs.size,1);
 for(let serial=1;serial<7;serial++){video.token=serial;engine.captureFrame(video,serial);}
 assert.equal(ownedFrame.closed,false,'capture cannot recycle a frame submitted by the compositor');assert.equal(ownedSource.serial,0);
 device.gates.shift()();await tickUntil(()=>engine.presentationJobs.size===0);assert.equal(ownedSource.refs,0);
 engine.captureFrame(video,7);assert.equal(ownedFrame.closed,true,'released oldest frame becomes recyclable');

 engine.captureFrame(video,8);const anchor=engine.sources.find(source=>source.serial===8);
 compositor.renderResult=false;assert.equal(engine.presentFrame(8,{},video),false);assert.equal(anchor.refs,0);assert.equal(engine.presentationJobs.size,0);
 compositor.renderResult=true;compositor.renderError=true;
 assert.throws(()=>engine.presentFrame(8,{},video),/compositor render/);assert.equal(anchor.refs,1,'throw after submission still owns its frame');
 device.gates.shift()();await tickUntil(()=>engine.presentationJobs.size===0);assert.equal(anchor.refs,0);compositor.renderError=false;
 assert.equal(engine.presentPrediction({prediction:true},{compare:true},8,video),true);assert.equal(anchor.refs,1);
 assert.equal(compositor.renders.at(-1).config.comparisonSource.external.source,anchor.frame,'comparison is bound to its matching immutable source');
 device.gates.shift()();await tickUntil(()=>engine.presentationJobs.size===0);assert.equal(anchor.refs,0);
 const rawDone=device.queue.onSubmittedWorkDone,queueFailure=deferred();device.queue.onSubmittedWorkDone=()=>queueFailure.promise;
 assert.equal(engine.presentPrediction({prediction:true},{compare:true},8,video),true);assert.equal(anchor.refs,1);
 queueFailure.reject(new Error('injected queue completion failure'));await tickUntil(()=>engine.presentationJobs.size===0);
 assert.equal(anchor.refs,0,'rejected actual queue completion releases comparison ownership');device.queue.onSubmittedWorkDone=rawDone;
 // Consume the mock queue's current target before the next held submission.
 const repair=device.queue.onSubmittedWorkDone();while(device.gates.length)device.gates.shift()();await repair;
 const fallbackCount=frames.length;
 assert.equal(engine.hasCapturedFrame(8),true);assert.equal(engine.hasCapturedFrame(999),false);
 assert.equal(engine.presentFrame(999,{},video),false,'missing history cannot silently substitute current video');
 assert.equal(engine.presentPrediction({prediction:true},{compare:true},999,video),false,'missing comparison anchor rejects the prediction');
 assert.equal(frames.length,fallbackCount,'only the explicit live sentinel allocates a fallback VideoFrame');
 assert.equal(engine.presentFrame(-1,{},video),true);const fallbackFrame=frames.at(-1);assert.equal(frames.length,fallbackCount+1);assert.equal(fallbackFrame.closed,false);
 device.gates.shift()();await tickUntil(()=>engine.presentationJobs.size===0);assert.equal(fallbackFrame.closed,true,'temporary current-video snapshot lasts through queue completion');
 compositor.renderResult=false;assert.equal(engine.presentFrame(-1,{},video),false);assert.equal(frames.at(-1).closed,true,'unused fallback snapshot closes on false');
 compositor.renderResult=true;compositor.renderError=true;
 assert.throws(()=>engine.presentFrame(-1,{},video),/compositor render/);const thrownFrame=frames.at(-1);assert.equal(thrownFrame.closed,false,'partially submitted fallback survives render throw');
 device.gates.shift()();await tickUntil(()=>engine.presentationJobs.size===0);assert.equal(thrownFrame.closed,true);compositor.renderError=false;
 compositor.idleError=true;
 assert.equal(engine.presentFrame(8,{},video),true);assert.equal(anchor.refs,1,'an errored compositor idle helper cannot release submitted frame ownership');
 device.gates.shift()();await tickUntil(()=>engine.presentationJobs.size===0);assert.equal(anchor.refs,0);compositor.idleError=false;

 engine.captureFrame(video,9);engine.captureFrame(video,10);engine.directPresentation=true;
 assert.equal(engine.retainPrediction(0),null,'no prediction can be retained before complete inference');
 assert.ok((await engine.estimate(prev,curr,10)).valid);const saved=engine.retainPrediction(1);
 assert.equal(saved.texture,engine.output);assert.equal(saved.width,64);assert.equal(saved.height,32);assert.equal(saved.slot,1);
 const frameCount=frames.length;assert.equal(engine.presentPrediction(saved,{compare:false},9,video),true);assert.equal(frames.length,frameCount,'comparison disabled acquires no extra video frame');
 device.gates.shift()();await tickUntil(()=>engine.presentationJobs.size===0);
 engine.reset();assert.equal(engine.retainPrediction(1),null,'source epoch reset invalidates old retained output');

 engine.captureFrame(video,11);const resizedSource=engine.sources.find(source=>source.serial===11),resizedFrame=resizedSource.frame;
 engine.presentFrame(11,{},video);let resized=false;const heldResize=engine.resize(128,64).then(()=>{resized=true;});
 await new Promise(resolve=>setTimeout(resolve,5));assert.equal(resized,false);assert.equal(resizedFrame.closed,false,'resize keeps submitted external source alive');assert.equal(resizedSource.refs,1);
 assert.equal(engine.presentPrediction(saved,{},11,video),false,'resizing rejects predictions with old output dimensions');
 const during=engine.presentationSource(-1,{videoWidth:128,videoHeight:64,token:'live-resize'}),duringFrame=frames.at(-1);
 assert.equal(resizedSource.refs,1,'live resize capture does not increment a draining old pool source');assert.equal(during.width,128);during.release();assert.equal(duringFrame.closed,true);
 device.gates.shift()();await heldResize;assert.equal(resizedFrame.closed,true);assert.equal(engine.sourceW,128);assert.equal(engine.presentationJobs.size,0);
 const largerDirect={videoWidth:128,videoHeight:64,token:'new-shape'};engine.captureFrame(largerDirect,12);
 const destroyedSource=engine.sources.find(source=>source.serial===12),destroyedFrame=destroyedSource.frame;
 engine.presentFrame(12,{},largerDirect);let directDestroyed=false;const heldDestroy=engine.destroy().then(()=>{directDestroyed=true;});
 await new Promise(resolve=>setTimeout(resolve,5));assert.equal(directDestroyed,false);assert.equal(destroyedFrame.closed,false);assert.equal(compositor.dead,false);
 device.gates.shift()();await heldDestroy;assert.equal(destroyedFrame.closed,true);assert.equal(compositor.dead,true);assert.ok(device.allocations.every(resource=>resource.dead));

 await withPerformanceClock(async clock=>{
  await submittedEngine();holdSynthesisFence();
  const snapshotsBefore=compositor.snapshots.length,notifications=[];
  const inference=engine.estimate(prev,curr,1,.375,{deadline:10,onSubmitted(info){notifications.push(info);return true;}});
  await tickUntil(()=>notifications.length===1);
  const notification=notifications[0],snapshotCalls=compositor.snapshots.slice(snapshotsBefore);
  assert.equal(snapshotCalls.length,1,'accepted submission enqueues exactly one private snapshot copy');
  assert.equal(snapshotCalls[0].texture,engine.output);assert.equal(snapshotCalls[0].width,64);assert.equal(snapshotCalls[0].height,32);assert.equal(snapshotCalls[0].slot,1);
  assert.equal(notification.valid,true);assert.equal(notification.serial,1);assert.equal(notification.epoch,engine.epoch);assert.equal(notification.phase,.375);
  assert.deepEqual(notification.stats,[0,0,0,1]);assert.equal(notification.sceneCut,false);assert.equal(notification.gpuTexture,snapshotCalls[0]);assert.equal(notification.submitted,true);
  const synthesisDispatches=device.submissions.flatMap(command=>command.stages).filter(stage=>stage.pipeline===engine.state.synth.pipeline);
  assert.equal(synthesisDispatches.length,1,'the synthesis dispatch is submitted before the private snapshot is published');
  assert.ok(device.gates.length>0,'final GPU fence remains held after publication');assert.equal(engine.busy,true);
  const sources=engine.sources.filter(source=>source.serial===0||source.serial===1);assert.equal(sources.length,2);assert.ok(sources.every(source=>source.refs===1),'both source frames remain locked until the fence drains');
  clock.set(10);while(device.gates.length)device.gates.shift()();
  const result=await inference;assert.ok(result?.valid,'accepted publication survives deadline expiry while its final fence drains');
  assert.equal(result.serial,1);assert.equal(result.epoch,notification.epoch);assert.equal(result.phase,.375);
  assert.equal(notifications.length,1);assert.equal(compositor.snapshots.length-snapshotsBefore,1);assert.equal(engine.busy,false);assert.ok(sources.every(source=>source.refs===0));
  await engine.destroy();
 });

 await withPerformanceClock(async clock=>{
  await submittedEngine();holdSynthesisFence();
  const snapshotsBefore=compositor.snapshots.length,notifications=[];
  const inference=engine.estimate(prev,curr,1,.625,{deadline:10,onSubmitted(info){notifications.push(info);return false;}});
  await tickUntil(()=>notifications.length===1);assert.ok(device.gates.length>0);assert.equal(engine.busy,true);
  assert.equal(compositor.snapshots.length-snapshotsBefore,1,'declining delivery still consumes only its one private snapshot');
  clock.set(10);while(device.gates.length)device.gates.shift()();
  assert.equal(await inference,null,'a declined publication does not suppress deadline cancellation');
  assert.equal(engine.lastRun.reason,'deadline');assert.equal(engine.lastRun.completed,false);assert.equal(notifications.length,1);assert.equal(engine.busy,false);
  await engine.destroy();
 });

 await withPerformanceClock(async()=>{
  await submittedEngine();holdSynthesisFence();const notifications=[];
  const inference=engine.estimate(prev,curr,1,.5,{deadline:100,onSubmitted(info){notifications.push(info);return true;}});
  await tickUntil(()=>notifications.length===1);
  const sources=engine.sources.filter(source=>source.serial===0||source.serial===1),sourceFrames=sources.map(source=>source.frame);assert.ok(sources.every(source=>source.refs===1));
  engine.reset();assert.equal(engine.busy,true,'epoch invalidation cannot release sources before the final fence');
  assert.ok(sources.every(source=>source.refs===1));assert.ok(sourceFrames.every(frame=>!frame.closed));
  while(device.gates.length)device.gates.shift()();assert.equal(await inference,null);
  assert.equal(engine.lastRun.reason,'obsolete');assert.equal(engine.busy,false);assert.ok(sources.every(source=>source.refs===0));assert.ok(sourceFrames.every(frame=>frame.closed),'obsolete source frames close after queue drain');
  await engine.destroy();
 });

 await withPerformanceClock(async()=>{
  await submittedEngine(false);const snapshotsBefore=compositor.snapshots.length;let callbacks=0;
  const result=await engine.estimate(prev,curr,1,.5,{onSubmitted(){callbacks++;return true;}});
  assert.ok(result.valid);assert.equal(callbacks,0,'canvas synthesis does not publish a direct-presentation callback');
  assert.equal(compositor.snapshots.length,snapshotsBefore,'the old canvas path does not enqueue a retained snapshot');
  await engine.destroy();
 });

 device=mock({external:true});engine=await Runtime.create(gl,new Uint8Array(),64,32);await engine.prepareCompositor({},'test-lut');
 engine.captureFrame(video,0);engine.captureFrame(video,1);device.holdNext=true;
 const overlapping=engine.estimate(prev,curr,1);await tickUntil(()=>device.gates.length>0);
 const sharedSource=engine.sources.find(source=>source.serial===0),sharedFrame=sharedSource.frame;
 engine.presentFrame(0,{},video);const presentationFence=device.gates.at(-1);assert.equal(sharedSource.refs,2);
 engine.reset();
 for(let turns=0;engine.busy&&turns<100;turns++){
  const index=device.gates.findIndex(gate=>gate!==presentationFence);
  if(index>=0)device.gates.splice(index,1)[0]();await new Promise(resolve=>setTimeout(resolve,1));
 }
 assert.equal(await overlapping,null);assert.equal(engine.busy,false,'inference can drain before direct presentation');
 assert.equal(sharedSource.refs,1);assert.equal(sharedFrame.closed,false,'epoch reset does not close the remaining presentation reader');
 device.gates.splice(device.gates.indexOf(presentationFence),1)[0]();await tickUntil(()=>engine.presentationJobs.size===0);
 assert.equal(sharedFrame.closed,true,'last presentation reader closes an obsolete VideoFrame');await engine.destroy();

 device=mock({external:true});engine=await Runtime.create(gl,new Uint8Array(),64,32);await engine.prepareCompositor({},'test-lut');
 const oldPredictionOutput=engine.output;compositor.idleGate=deferred();let snapshotResized=false;
 const waitingSnapshotResize=engine.resize(128,64).then(()=>{snapshotResized=true;});await new Promise(resolve=>setTimeout(resolve,5));
 assert.equal(snapshotResized,false);assert.equal(oldPredictionOutput.dead,false,'pending compositor snapshot copy retains old output during resize');
 compositor.idleGate.resolve();await waitingSnapshotResize;assert.equal(oldPredictionOutput.dead,true);await engine.destroy();

 device=mock({external:true});engine=await Runtime.create(gl,new Uint8Array(),64,32);const preparation=deferred(),orphan=compositorFactory();
 global.VENeuralCompositor.create=async()=>preparation.promise;
 const abortCompositor=new AbortController(),preparing=engine.prepareCompositor({},'test-lut',abortCompositor.signal);abortCompositor.abort();preparation.resolve(orphan);
 await assert.rejects(preparing,{name:'AbortError'});assert.equal(orphan.dead,true,'cancelled compositor preparation releases the unpublished compositor');assert.equal(engine.compositor,null);await engine.destroy();
 delete global.VENeuralCompositor;
 // Firefox caches externals by decoded-image identity, so distinct VideoFrame
 // wrappers can share a handle. Closing a transient wrapper expires that
 // handle even while the captured wrapper remains open. Per-wrapper refs alone
 // cannot protect later binds; presentation and inference must import on use.
 global.VENeuralCompositor={async create(){compositor=compositorFactory();return compositor;}};
 device=mock({external:true,aliasExternal:true});engine=await Runtime.create(gl,new Uint8Array(),64,32);await engine.prepareCompositor({},'test-lut');
 const aliasedVideo={videoWidth:64,videoHeight:32,currentTime:0,imageId:'one-decoded-image'};
 engine.captureFrame(aliasedVideo,0);engine.captureFrame(aliasedVideo,1);
 const aliasSources=[0,1].map(serial=>engine.sources.find(source=>source.serial===serial));
 assert.equal(aliasSources[0].external,aliasSources[1].external,'distinct captured wrappers share the cached image handle');assert.notEqual(aliasSources[0].frame,aliasSources[1].frame);
 const staleExternal=aliasSources[0].external;
 assert.equal(engine.presentFrame(-1,{},aliasedVideo),true);device.gates.shift()();await tickUntil(()=>engine.presentationJobs.size===0);
 assert.equal(staleExternal.expired,true,'closing the completed transient wrapper expires the shared handle');assert.ok(aliasSources.every(source=>!source.frame.closed),'captured source ownership remains intact');
 assert.equal(engine.presentFrame(0,{},aliasedVideo),true,'presentation refreshes the surviving frame before binding');assert.notEqual(compositor.renders.at(-1).input.external,staleExternal);device.gates.shift()();await tickUntil(()=>engine.presentationJobs.size===0);
 assert.equal(engine.presentFrame(-1,{},aliasedVideo),true);device.gates.shift()();await tickUntil(()=>engine.presentationJobs.size===0);
 let expiredAfterPreprocess=false;
 device.onDone=()=>{if(expiredAfterPreprocess)return;const command=device.submissions.at(-1);if(!command?.stages.some(stage=>stage.group.entries.some(entry=>entry.resource.external)))return;expiredAfterPreprocess=true;const wrapper=new VideoFrame(aliasedVideo,{timestamp:0}),handle=device.importExternalTexture({source:wrapper});wrapper.close();assert.equal(handle.expired,true);};
 assert.ok((await engine.estimate(prev,curr,1)).valid,'preprocess/stats and later synthesis refresh the still-open captured frames');assert.equal(expiredAfterPreprocess,true,'fixture also expires an alias between preprocess completion and synthesis');device.onDone=null;
 assert.ok(aliasSources.every(source=>!source.frame.closed));for(const program of engine.pipelines.values())if(program.bindings.some(binding=>binding.kind==='external-texture'))assert.equal(program.groups.size,0,'expired handles cannot survive in an external bind-group cache');await engine.destroy();
 delete global.VENeuralCompositor;delete global.VideoFrame;

 let released=0;device=mock();const rawCompletion=device.queue.onSubmittedWorkDone.bind(device.queue);
 let leaseWaits=0,holdCleanup=false,cleanupGate=null;
 const completionLease={device,waitForCompletion(){leaseWaits++;const done=rawCompletion();return holdCleanup?done.then(()=>new Promise(resolve=>{cleanupGate=resolve;})):done;},release(){released++;}};
 device.queue.onSubmittedWorkDone=()=>{throw new Error('borrowed runtime must route every completion wait through its lease');};
 global.VENeuralDevice={acquire:async()=>completionLease};
 engine=await Runtime.create(gl,new Uint8Array(),64,32);assert.equal(leaseWaits,1,'preparation waits through the lease helper');
 engine.captureFrame(video,0);engine.captureFrame(video,1);assert.ok((await engine.estimate(prev,curr,1)).valid);
 assert.equal(leaseWaits,1+engine.lastRun.batches,'every submitted inference/render batch waits through the lease helper');
 holdCleanup=true;const leasedDisposal=engine.destroy();await tickUntil(()=>cleanupGate!==null);
 assert.equal(released,0,'lease stays owned while its cleanup completion helper is pending');assert.ok(device.allocations.every(resource=>!resource.dead));
 cleanupGate();await leasedDisposal;assert.equal(leaseWaits,2+engine.lastRun.batches,'destruction waits through the lease helper');
 assert.equal(released,1);assert.ok(!device.dead,'borrowed document device stays alive');assert.ok(device.allocations.every(resource=>resource.dead));
 const aborted=new AbortController();global.VENeuralDevice.acquire=async()=>{aborted.abort();return {device,release(){released++;}};};
 await assert.rejects(Runtime.create(gl,new Uint8Array(),64,32,'balanced',0,aborted.signal),{name:'AbortError'});assert.equal(released,2,'failed creation releases the acquired lease');delete global.VENeuralDevice;
 device=mock();const allocateBuffer=device.createBuffer.bind(device);let bufferCount=0;
 device.createBuffer=descriptor=>{if(++bufferCount===3)throw new Error('injected constructor allocation failure');return allocateBuffer(descriptor);};
 global.VENeuralDevice={acquire:async()=>({device,release(){released++;}})};
 await assert.rejects(Runtime.create(gl,new Uint8Array(),64,32),/constructor allocation failure/);
 assert.ok(device.allocations.every(resource=>resource.dead),'constructor failure releases partial resources on a borrowed device');assert.ok(!device.dead);assert.equal(released,3);delete global.VENeuralDevice;

 const selectionCases=[
  {name:'slow lease',completionMs:100,options:{},storage:true,tiled:true,shared:true},
  {name:'balanced keeps specialized kernels',profile:'balanced',completionMs:100,options:{},storage:true,tiled:true,shared:false},
  {name:'balanced staged controller opts in',profile:'balanced',completionMs:100,options:{stagedStorage:true},storage:true,tiled:true,shared:true,staged:true},
  {name:'fast balanced staged keeps workgroup kernels',profile:'balanced',completionMs:3,options:{stagedStorage:true},storage:false,tiled:true,shared:false},
  {name:'balanced shared opt-in',profile:'balanced',completionMs:100,options:{genericStorage:true},storage:true,tiled:true,shared:true},
  {name:'fast lease',completionMs:3,options:{},storage:false,tiled:true,shared:false},
  {name:'threshold lease',completionMs:8,options:{},storage:false,tiled:true,shared:false},
  {name:'above threshold lease',completionMs:8.01,options:{},storage:true,tiled:true,shared:true},
  {name:'unknown completion',options:{},storage:false,tiled:true,shared:false},
  {name:'explicit false on slow lease',completionMs:100,options:{storageTiles:false},storage:false,tiled:true,shared:false},
  {name:'explicit true on fast lease',completionMs:3,options:{storageTiles:true},storage:true,tiled:true,shared:true},
  {name:'storage compact opt-in',completionMs:100,options:{storageTiles:true,compact:true,genericStorage:false},storage:true,tiled:true,shared:false},
  {name:'generic storage opt-in',completionMs:100,options:{storageTiles:true,compact:true,genericStorage:true},storage:true,tiled:true,shared:true},
  {name:'specialized storage opt-in',completionMs:100,options:{genericStorage:false},storage:true,tiled:true,shared:false},
  {name:'compact false opt-in',completionMs:100,options:{compact:false},storage:true,tiled:true,shared:false},
  {name:'generic overrides auto selection',completionMs:100,options:{generic:true},storage:false,tiled:false,shared:false},
  {name:'compact overrides auto selection',completionMs:100,options:{compact:true},storage:false,tiled:true,shared:false},
  {name:'scalar overrides auto selection',completionMs:100,options:{tiled:false},storage:false,tiled:false,shared:false},
  {name:'explicit storage wins over experimental generic',completionMs:100,options:{generic:true,storageTiles:true},storage:true,tiled:true,shared:false},
 ];
 for(const scenario of selectionCases){
  const selectedDevice=mock();device=selectedDevice;let selectionReleases=0;
  const lease={device:selectedDevice,completionMs:scenario.completionMs,waitForCompletion:()=>selectedDevice.queue.onSubmittedWorkDone(),release(){selectionReleases++;}};
  global.VENeuralDevice={acquire:async()=>lease};
  try{
   engine=await Runtime.create(gl,new Uint8Array(),64,32,scenario.profile||'quality',0,null,scenario.options);
   assert.equal(engine.shaderOptions.storageTiles,scenario.storage,scenario.name);assert.equal(engine.shaderOptions.tiled,scenario.tiled,scenario.name);
   assert.equal(engine.shaderOptions.genericStorage,scenario.shared,scenario.name);
   assert.equal(engine.enc[0].graph.ops.some(op=>op.stageProgram),scenario.staged===true,scenario.name+' selects staged input programs only on the eligible path');
   assert.equal(engine.lease,lease);
   const operations=[...engine.enc.flatMap(encoder=>encoder.graph.ops),...engine.dec.graph.ops].filter(op=>op.layer);
   if(scenario.shared){
    assert.equal(new Set(operations.map(op=>op.program.code)).size,1,'uniform-driven convolutions share exactly one pipeline');
    for(const op of operations){const resources=engine.resourcesFor(op);assert.equal(resources.s1,op.residual?VENeuralGraph.baseOf(op.inputs[1]).texture:resources.s0,'unused residual binding aliases a valid read-only input');}
   }
   if(scenario.storage){
    const maximum=Math.max(...operations.map(op=>op.scratchBytes));
    assert.ok(maximum>0);assert.equal(engine.scratchBytes,maximum,scenario.name+' allocates the exact largest full grid');
    assert.equal(engine.scratch.size,maximum);assert.ok(maximum<=128*1024*1024);
    assert.ok(engine.memoryBytes<=256*1024*1024);
    for(const op of operations){
     const tile=op.deconv?6:8*(op.stride||1)+2;
     const tileVectors=op.stageProgram?tile*tile*Math.ceil(op.layer.ci/4):op.out.groups*(tile*tile+4*op.layer.k*op.layer.k);
     const required=Math.ceil(op.out.w/8)*Math.ceil(op.out.h/8)*tileVectors*16;
     assert.equal(op.scratchBytes,required);assert.ok(required<=engine.scratch.size,'every shader grid fits the shared buffer');
     assert.equal(engine.resourcesFor(op).scratch,engine.scratch);
    }
   }else{
    assert.equal(engine.scratch,null);assert.equal(engine.scratchBytes,0);assert.ok(operations.every(op=>op.scratchBytes===0));
   }
   await engine.destroy();assert.equal(selectionReleases,1);assert.equal(selectedDevice.dead,undefined,'auto selection preserves borrowed-device ownership');
   assert.ok(selectedDevice.allocations.every(resource=>resource.dead));
  }finally{delete global.VENeuralDevice;}
 }
 device=mock();device.limits.maxStorageBufferBindingSize=64*1024;let limitedReleases=0;
 global.VENeuralDevice={acquire:async()=>({device,completionMs:100,waitForCompletion:()=>device.queue.onSubmittedWorkDone(),release(){limitedReleases++;}})};
 try{
  await assert.rejects(Runtime.create(gl,new Uint8Array(),64,32),/device buffer limit/,'automatic storage selection still obeys the advertised binding limit');
  assert.equal(limitedReleases,1);assert.ok(device.allocations.every(resource=>resource.dead),'failed auto allocation cleans up the partially prepared runtime');
 }finally{delete global.VENeuralDevice;}

 device=mock();engine=await Runtime.create(gl,new Uint8Array(),64,32,'balanced',0,null,{compact:true});
 assert.equal(engine.shaderOptions.compact,true);
 const G=global.VENeuralGraph,graph=new G.Graph(8192),owned={key:'host-config',textures:new Set(),programs:new Set(),bytes:0};
 const input=graph.tensor(16,16,4);input.texture=engine.texture(input.tw,input.th,'rgba16float',owned);
 const k3=layer(4,4),k4=layer(4,4,4),a=graph.conv(input,k3),b=graph.conv(a,k3,2),c=graph.conv(b,k4,2,null,true);graph.keep(graph.concat([c]));
 await engine.attach(graph,owned);
 assert.deepEqual(graph.ops.map(op=>op.config),[19,35,292,4],'kernel geometry and concat lane count belong to each operation');
 assert.equal(graph.ops[0].program,graph.ops[1].program);assert.equal(graph.ops[1].program,graph.ops[2].program,'different compact operation configs share one cached pipeline');
 assert.ok(engine.enc.every(encoder=>encoder.graph.ops[0].config===0),'preprocessing config stays zero');
 const commandStart=device.submissions.length;
 assert.equal(await engine.runBatched(graph.ops,engine.epoch,.5,false,{deadline:Infinity,valid:null,reason:'',targetMs:2}),true);await engine.drain();
 assert.deepEqual(device.submissions.slice(commandStart).flatMap(command=>command.stages).map(stage=>stage.debug),[19,35,292,4],'every dispatch receives its own operation config through the debug uniform');
 engine.dropShape(owned);await engine.destroy();

 device=mock();engine=await Runtime.create(gl,new Uint8Array(),64,32,'balanced',0,null,{generic:true});
 assert.equal(engine.shaderOptions.generic,true);assert.equal(engine.shaderOptions.compact,true);assert.equal(engine.shaderOptions.tiled,false);
 const genericOps=[...engine.enc.flatMap(encoder=>encoder.graph.ops),...engine.dec.graph.ops].filter(op=>op.type==='conv');
 assert.equal(new Set(genericOps.map(op=>op.program)).size,3,'generic scalar convolutions share aligned normal/residual pipelines plus the offset-138 fallback');
 const expectedLayouts=new Set();
 for(const op of genericOps){
  const base=G.baseOf(op.inputs[0]);
  const geometry=op.layer.k|((op.stride||1)<<4)|(op.deconv?256:0);
  if((op.inputs[0].offset||0)%4===0){
   assert.deepEqual(op.convLayout,{active:[base.cols,Math.ceil(base.groups/base.cols)],outputSize:[op.inputs[0].offset||0,op.out.c]});
   assert.equal(op.config,geometry|(op.layer.slope?512:0));
   expectedLayouts.add(JSON.stringify([op.config,op.convLayout.active,op.convLayout.outputSize,[op.out.w,op.out.h]]));
  }else{
   assert.equal(op.inputs[0].offset,138);assert.equal(op.convLayout,null,'misaligned views retain their specialized scalar reader');assert.equal(op.config,geometry);
  }
 }
 engine.captureFrame(video,0);engine.captureFrame(video,1);assert.ok((await engine.estimate(prev,curr,1)).valid);
 const genericStages=device.submissions.flatMap(command=>command.stages).filter(stage=>stage.pipeline.compute.module.code.includes('// Generic scalar IFRNet convolution.'));
 assert.ok(genericStages.length>0);
 for(const stage of genericStages){
  assert.equal(stage.dims[2],1,'generic scalar dispatch retains atlas XY addressing');
  assert.ok(expectedLayouts.has(JSON.stringify([stage.debug,stage.active,stage.outputSize,stage.logicalSize])),'each shared-pipeline dispatch receives its own channel/view/activation metadata');
 }
 const genericPipelines=engine.pipelines.size;await engine.resize(128,64);assert.equal(engine.pipelines.size,genericPipelines,'generic metadata never enters the source-cache key');
 await engine.destroy();

 device=mock();engine=await Runtime.create(gl,new Uint8Array(),64,32,'balanced',0,null,{genericConcat:true});
 const concatOps=engine.dec.graph.ops.filter(op=>op.type==='concat'),concatLayouts=new Set();
 assert.equal(new Set(concatOps.map(op=>op.program)).size,1,'all concatenations share one compiled program');
 for(const op of concatOps){
  const packed=Array.from({length:5},(_,i)=>{const input=op.inputs[i];return input?(input.c|((input.offset||0)<<16))>>>0:0;});
  assert.equal(op.config,packed[0]);assert.deepEqual(op.concatLayout,{active:packed.slice(1,3),outputSize:packed.slice(3,5)});
  const resources=engine.resourcesFor(op);
  for(let i=0;i<5;i++)assert.equal(resources['s'+i],i<op.inputs.length?G.baseOf(op.inputs[i]).texture:resources.s0,'unused concatenation inputs alias a live read-only texture');
  concatLayouts.add(JSON.stringify([op.config,op.concatLayout.active,op.concatLayout.outputSize,[op.out.w,op.out.h]]));
 }
 engine.captureFrame(video,0);engine.captureFrame(video,1);assert.ok((await engine.estimate(prev,curr,1)).valid);
 const concatProgram=concatOps[0].program.pipeline;
 const concatStages=device.submissions.flatMap(command=>command.stages).filter(stage=>stage.pipeline===concatProgram);
 assert.equal(concatStages.length,concatOps.length);
 for(const stage of concatStages)assert.ok(concatLayouts.has(JSON.stringify([stage.debug,stage.active,stage.outputSize,stage.logicalSize])),'shared concat dispatches retain their own channel counts and view offsets');
 const concatPipelineCount=engine.pipelines.size;await engine.resize(128,64);assert.equal(engine.pipelines.size,concatPipelineCount);await engine.destroy();

 device=mock();engine=await Runtime.create(gl,new Uint8Array(),64,32,'balanced',0,null,{genericFlow:true});
 const warpOps=engine.dec.graph.ops.filter(op=>op.type==='warp'),refineOps=engine.dec.graph.ops.filter(op=>op.type==='refine'),warpLayouts=new Set();
 assert.equal(warpOps.length,6);assert.equal(refineOps.length,3);
 assert.equal(new Set(warpOps.map(op=>op.program)).size,1,'both directions and all scales share the warp pipeline');
 assert.equal(new Set(refineOps.map(op=>op.program)).size,1,'all flow refinement scales share their pipeline');
 for(const op of warpOps){
  assert.equal(op.config,op.out.c);assert.deepEqual(op.readerLayout,{active:[0,0],outputSize:[op.inputs[1].offset||0,0]});
  warpLayouts.add(JSON.stringify([op.config,op.readerLayout.active,op.readerLayout.outputSize,[op.out.w,op.out.h]]));
 }
 engine.captureFrame(video,0);engine.captureFrame(video,1);assert.ok((await engine.estimate(prev,curr,1)).valid);
 const warpStages=device.submissions.flatMap(command=>command.stages).filter(stage=>stage.pipeline===warpOps[0].program.pipeline);
 assert.equal(warpStages.length,warpOps.length);
 for(const stage of warpStages)assert.ok(warpLayouts.has(JSON.stringify([stage.debug,stage.active,stage.outputSize,stage.logicalSize])),'warp dispatches keep their direction and channel mask');
 const flowPipelineCount=engine.pipelines.size;await engine.resize(128,64);assert.equal(engine.pipelines.size,flowPipelineCount);await engine.destroy();

 device=mock();engine=await Runtime.create(gl,new Uint8Array(),64,32,'balanced',0,null,{storageTiles:true});
 assert.equal(engine.shaderOptions.storageTiles,true);assert.equal(engine.shaderOptions.tiled,true);
 const storageOps=[...engine.enc.flatMap(encoder=>encoder.graph.ops),...engine.dec.graph.ops].filter(op=>op.type==='conv');
 assert.ok(storageOps.every(op=>op.tiled&&op.scratchBytes>0));
 assert.equal(engine.scratchBytes,Math.max(...storageOps.map(op=>op.scratchBytes)),'one allocation covers the largest full convolution grid');
 assert.equal(engine.resources.get(engine.scratch),engine.scratchBytes);assert.ok(engine.memoryBytes<256*1024*1024);
 assert.equal(device.allocations.filter(resource=>resource.label==='IFRNet reusable storage tiles'&&!resource.dead).length,1);
 for(const op of storageOps){
  assert.ok(op.program.bindings.some(binding=>binding.name==='scratch'&&binding.kind==='storage-buffer'));
  assert.doesNotMatch(op.program.code,/var<workgroup>|workgroupBarrier/);
 }
 engine.captureFrame(video,0);engine.captureFrame(video,1);assert.ok((await engine.estimate(prev,curr,1)).valid);
 const storageStages=device.submissions.flatMap(command=>command.stages).filter(stage=>stage.pipeline.compute.module.code.includes('scratch:array<vec4<f32>>'));
 assert.ok(storageStages.length>0);assert.ok(storageStages.every(stage=>stage.group.entries.some(entry=>entry.resource.buffer===engine.scratch)),'all convolution dispatches share the owned storage allocation');
 const oldScratch=engine.scratch,oldScratchBytes=engine.scratchBytes;await engine.resize(128,64);
 assert.ok(engine.scratchBytes>oldScratchBytes);assert.notEqual(engine.scratch,oldScratch);assert.equal(oldScratch.dead,true,'growth releases the drained older scratch and invalidates cached groups');
 const scratchAfterGrowth=engine.scratch;assert.throws(()=>engine.ensureScratch(129*1024*1024),/device buffer limit/);assert.equal(engine.scratch,scratchAfterGrowth);
 const largerStorage={videoWidth:128,videoHeight:64};engine.captureFrame(largerStorage,0);engine.captureFrame(largerStorage,1);assert.ok((await engine.estimate(prev,curr,1)).valid);
 await engine.destroy();assert.ok(device.allocations.every(resource=>resource.dead));

 await withPerformanceClock(async()=>{
  device=mock();engine=await Runtime.create(gl,new Uint8Array(),64,32,'quality',0,null,{storageTiles:true,compact:true,genericStorage:true,stagedStorage:true});
  const operations=[...engine.enc.flatMap(encoder=>encoder.graph.ops),...engine.dec.graph.ops].filter(op=>op.layer);
  assert.ok(operations.every(op=>op.stageProgram),'every eligible convolution has both input and output programs');
  assert.equal(new Set(operations.map(op=>op.stageProgram)).size,1);
  assert.equal(new Set(operations.map(op=>op.program)).size,1);
  assert.equal(engine.diagnostics.stagedConvolutions,operations.length);
  const stagedScratch=Math.max(...operations.map(op=>op.scratchBytes));
  assert.equal(engine.scratchBytes,stagedScratch);
  for(const op of operations){
   const tile=op.deconv?6:8*(op.stride||1)+2;
   assert.equal(op.stageGroups,Math.ceil(op.layer.ci/4));
   assert.equal(op.scratchBytes,Math.ceil(op.out.w/8)*Math.ceil(op.out.h/8)*tile*tile*op.stageGroups*16);
  }
  const inputPipeline=operations[0].stageProgram.pipeline,outputPipeline=operations[0].program.pipeline;
  const channels=new Map(operations.map(op=>[engine.layers.get(op.layer),op.layer.ci]));
  const verifyPairs=commands=>{
   let count=0;
   for(const command of commands){
    assert.ok(command.stages.length<=256,'staged pairs stay within immutable uniform capacity');
    for(let i=0;i<command.stages.length;i++)if(command.stages[i].pipeline===inputPipeline){
     const input=command.stages[i],output=command.stages[++i];assert.ok(output,'a stage is never left without its consumer');
     assert.equal(output.pipeline,outputPipeline);assert.deepEqual(input.region,output.region);
     assert.deepEqual(input.logicalSize,output.logicalSize);assert.deepEqual(input.active,output.active);
     assert.deepEqual(input.outputSize,output.outputSize);assert.equal(input.debug,output.debug);
     const sourceUniform=input.group.entries.find(e=>e.binding===0).resource.buffer;
     assert.equal(sourceUniform,output.group.entries.find(e=>e.binding===0).resource.buffer);
     assert.notEqual(input.offset,output.offset,'paired dispatches retain distinct immutable uniform ranges');
     const weights=input.group.entries.find(e=>e.binding===2).resource.texture;
     assert.equal(weights,output.group.entries.find(e=>e.binding===3).resource.texture);
     assert.equal(input.dims[2],Math.ceil(channels.get(weights)/4));
     assert.equal(input.group.entries.find(e=>e.binding===3).resource.buffer,output.group.entries.find(e=>e.binding===4).resource.buffer);
     count++;
    }
   }
   return count;
  };
  // A leading single dispatch leaves an odd slot count. The following 130
  // pairs cross the exact boundary that previously could overflow slot 256.
  engine.dispatchWork=1024*1024*1024;
  const ops=[engine.enc[0].graph.ops[0],...Array(130).fill(operations[0])];
  assert.equal(await engine.runBatched(ops,engine.epoch,.5,false,{deadline:Infinity,reason:'',targetMs:2},null,engine.sources[0].texture),true);await engine.drain();
  assert.equal(verifyPairs(device.submissions),130);
  assert.ok(device.submissions.some(command=>command.stages.length===255),'odd-slot boundary flushes before admitting the next pair');
  const before=device.submissions.length;
  assert.equal(await engine.runBatched(ops,engine.epoch,.5,false,{deadline:Infinity,reason:'',targetMs:2,valid:()=>false}),false);
  assert.equal(device.submissions.length,before,'cancelled pairs submit neither stage nor consumer');
  const oldScratch=engine.scratch,programs=engine.pipelines.size;await engine.resize(128,64);
  assert.equal(engine.pipelines.size,programs,'resizing retains both shared programs');assert.ok(oldScratch.dead,'resizing releases drained undersized scratch');
  const larger={videoWidth:128,videoHeight:64};engine.captureFrame(larger,0);engine.captureFrame(larger,1);
  assert.ok((await engine.estimate(prev,curr,1,.5)).valid);verifyPairs(device.submissions.slice(before));
  engine.captureFrame(larger,2);let stagedValid=true;device.holdNext=true;
  const pending=engine.estimate(curr,{},2,.5,{valid:()=>stagedValid,cacheValid:()=>false});
  await tickUntil(()=>device.gates.length>0);stagedValid=false;
  for(let i=0;i<30&&engine.busy;i++){
   while(device.gates.length)device.gates.shift()();
   await new Promise(resolve=>setTimeout(resolve,1));
  }
  assert.equal(engine.busy,false,'cancellation drains every admitted staged dispatch');assert.equal(await pending,null);
  assert.ok(engine.sources.every(source=>source.refs===0),'cancelled staged inference releases its source locks');
  verifyPairs(device.submissions.slice(before));
  await engine.destroy();assert.ok(device.allocations.every(resource=>resource.dead));
 });

 device=mock();engine=await Runtime.create(gl,new Uint8Array(),64,32,'balanced',0,null,{canvasCopy:true});
 assert.equal(engine.canvasCopy,true);assert.equal(engine.stage.context.configuration.format,'rgba8unorm');
 assert.equal(engine.stage.context.configuration.usage,GPUTextureUsage.COPY_DST|GPUTextureUsage.RENDER_ATTACHMENT);
 assert.ok(engine.output.usage&GPUTextureUsage.COPY_SRC);assert.equal(device.renderPipelines,0);assert.equal(engine.blit,null);assert.equal(engine.blitGroup,null);
 assert.ok(!device.modules.some(module=>module.label==='IFRNet canvas blit'),'copy mode never creates the blit shader/module');
 engine.captureFrame(video,0);engine.captureFrame(video,1);assert.ok((await engine.estimate(prev,curr,1)).valid);
 let canvasCopies=device.submissions.flatMap(command=>command.textureCopies);assert.equal(canvasCopies.length,1);
 assert.equal(canvasCopies[0].source.texture,engine.output);assert.equal(canvasCopies[0].destination.texture.canvas,engine.stage);
 assert.equal(device.renderPasses,0);assert.equal(engine.render(prev,curr,target,64,32),true);
 const oldOutput=engine.output,oldStage=engine.stage;await engine.resize(128,64);
 assert.equal(oldOutput.dead,true);assert.notEqual(engine.stage,oldStage);assert.equal(engine.stage.context.configuration.format,'rgba8unorm');
 assert.equal(engine.stage.context.configuration.usage,GPUTextureUsage.COPY_DST|GPUTextureUsage.RENDER_ATTACHMENT);assert.ok(engine.output.usage&GPUTextureUsage.COPY_SRC);
 assert.equal(engine.render(prev,curr,target,64,32),false,'resize invalidates the previous copied canvas result');
 const larger={videoWidth:128,videoHeight:64};engine.captureFrame(larger,0);engine.captureFrame(larger,1);assert.ok((await engine.estimate(prev,curr,1)).valid);
 canvasCopies=device.submissions.flatMap(command=>command.textureCopies);assert.equal(canvasCopies.length,2);
 assert.equal(canvasCopies.at(-1).source.texture,engine.output);assert.notEqual(canvasCopies.at(-1).source.texture,oldOutput);
 assert.equal(canvasCopies.at(-1).destination.texture.canvas,engine.stage);assert.deepEqual(canvasCopies.at(-1).size,[128,64]);
 assert.equal(device.renderPipelines,0);assert.equal(device.renderPasses,0);await engine.destroy();
 engine=await create();assert.equal(engine.canvasCopy,false);assert.equal(engine.stage.context.configuration.format,'bgra8unorm');
 assert.equal(engine.stage.context.configuration.usage,undefined,'default presentation keeps preferred-format configure behavior');
 assert.ok(engine.output.usage&GPUTextureUsage.COPY_SRC,'RGB predictions support GPU-only retention');assert.equal(device.renderPipelines,1);assert.ok(engine.blitGroup);await engine.destroy();
 console.log('IFRNet WebGPU host lifecycle checks passed (mock GPU; no arithmetic or timing claim).');
})().catch(error=>{console.error(error);process.exitCode=1;});
