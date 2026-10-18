/* Local IFRNet-S WebGPU inference. Uses the same model and fixed graph as runtime.js. */
(function(root){
'use strict';
const G=root.VENeuralGraph,S=root.VENeuralSpec,W=root.VENeuralWebGPUShaders||root.VENeuralWGSL;
const MEMORY_LIMIT=256*1024*1024,SHAPE_LIMIT=2,SOURCE_LIMIT=4;
const MIN_WORK=128*1024,MAX_WORK=1024*1024*1024,INITIAL_WORK=32*1024*1024,TARGET_MS=2;
const UNIFORM_BYTES=48,UNIFORM_SLOTS=256,IN_FLIGHT_LIMIT=4;
const DEBUG={off:0,flow:1,mask:2,residual:3};
let channel=null,tasks=[];
const now=()=>performance.now();
// Chromium reports an undecoded element as OperationError. Keep this narrow:
// other device/operation failures still follow the normal error path.
const videoSourceUnavailable=error=>error?.name==='InvalidStateError'||
 (error?.name==='OperationError'&&String(error.message).includes("video element that doesn't have back resource"));
// Import, encode and submit in one task: HTMLVideoElement external textures
// expire at a task boundary. Later inference reads the owned RGBA snapshot.
const CAPTURE=`
@group(0) @binding(0) var source:texture_external;
@group(0) @binding(1) var imageSampler:sampler;
@group(0) @binding(2) var output:texture_storage_2d<rgba8unorm,write>;
@compute @workgroup_size(8,8)
fn main(@builtin(global_invocation_id) gid:vec3<u32>) {
 let size=textureDimensions(output);
 if(any(gid.xy>=size)) { return; }
 let uv=(vec2<f32>(gid.xy)+vec2<f32>(0.5))/vec2<f32>(size);
 textureStore(output,vec2<i32>(gid.xy),vec4<f32>(textureSampleBaseClampToEdge(source,imageSampler,uv).rgb,1.0));
}`;
function yieldTask(){
 if(typeof document==='undefined'||typeof MessageChannel==='undefined')return new Promise(r=>setTimeout(r,0));
 if(!channel){channel=new MessageChannel();channel.port1.onmessage=()=>tasks.shift()?.();channel.port1.unref?.();channel.port2.unref?.();}
 return new Promise(r=>{tasks.push(r);channel.port2.postMessage(0);});
}
function cancelled(){const e=new Error('Neural preparation cancelled.');e.name='AbortError';return e;}
function debugValue(value='off'){if(!Object.prototype.hasOwnProperty.call(DEBUG,value))throw new Error('Unsupported IFRNet debug view: '+value);return DEBUG[value];}
const BLIT=`
@group(0) @binding(0) var image:texture_2d<f32>;
struct V { @builtin(position) position:vec4<f32>, @location(0) uv:vec2<f32> };
@vertex fn vs(@builtin(vertex_index) i:u32)->V {
 let p=array<vec2<f32>,3>(vec2<f32>(-1.0,-1.0),vec2<f32>(3.0,-1.0),vec2<f32>(-1.0,3.0));
 var o:V;o.position=vec4<f32>(p[i],0.0,1.0);o.uv=vec2<f32>(p[i].x*0.5+0.5,0.5-p[i].y*0.5);return o;
}
@fragment fn fs(v:V)->@location(0) vec4<f32> {
 let size=vec2<i32>(textureDimensions(image));let p=clamp(vec2<i32>(v.uv*vec2<f32>(size)),vec2<i32>(0),size-vec2<i32>(1));
 return textureLoad(image,p,0);
}`;
class Runtime {
 constructor(gl,device,model,width,height,dimensions,options={}){
  this.kind='ifrnet';this.backend='webgpu';this.gl=gl;this.device=device;this.model=model;
  this.lease=options.lease||null;this.ownsDevice=!this.lease;
  const externalAvailable=typeof root.VideoFrame==='function'&&typeof device.importExternalTexture==='function';
  if(options.captureMode==='external'&&!externalAvailable)throw new Error('Immutable VideoFrame external-texture capture is unavailable.');
  if(options.captureMode==='snapshot'&&!externalAvailable)throw new Error('GPU video snapshot capture is unavailable.');
  this.videoSnapshot=options.captureMode==='snapshot';this.videoImportFailed=false;
  this.externalSource=externalAvailable&&options.captureMode!=='rgba'&&!this.videoSnapshot;
  this.captureMode=this.videoSnapshot?'snapshot':this.externalSource?'external':'rgba';
  this.canvasCopy=options.canvasCopy===true;
  this.shaderOptions={externalSource:this.externalSource,compact:options.compact===true||options.generic===true,
   tiled:options.storageTiles===true||options.tiled!==false&&options.generic!==true,generic:options.generic===true,genericStorage:options.genericStorage===true,stagedStorage:options.stagedStorage===true,storageTiles:options.storageTiles===true,filteredSources:options.filteredSources===true,genericConcat:options.genericConcat===true,genericFlow:options.genericFlow===true};this.sourceBytes=0;
  this.sourceW=width;this.sourceH=height;this.dimensions=dimensions;this.busy=false;this.destroyed=false;this.lost=false;
  this.epoch=0;this.lastSerial=-1;this.lastSlot=0;this.lastRun=null;this.lastResult=null;
  this.resources=new Map();this.memoryBytes=0;this.layers=new Map();this.pipelines=new Map();this.shapes=new Map();this.state=null;
  this.scratch=null;this.scratchBytes=0;
  this.resourceIds=new WeakMap();this.nextResourceId=0;
  this.imageSampler=this.externalSource||this.videoSnapshot||this.shaderOptions.filteredSources?device.createSampler({label:'IFRNet source image bilinear',magFilter:'linear',minFilter:'linear',mipmapFilter:'nearest',addressModeU:'clamp-to-edge',addressModeV:'clamp-to-edge'}):null;
  if(this.imageSampler)this.resourceIds.set(this.imageSampler,++this.nextResourceId);
  this.sources=[];this.idle=Promise.resolve();this.pending=Promise.resolve();this.resizing=null;this.disposeTask=null;
  this.compositor=null;this.presentationJobs=new Set();
  this.inFlight=[];this.wave=null;this.nextUniformSlot=0;
  this.dispatchWork=INITIAL_WORK;this.dispatchTargetMs=TARGET_MS;
  this.dispatchWorkFloor=MIN_WORK;this.completionFloorMs=0;
  this.diagnostics={shapeBuilds:0,shapeHits:0,resizes:0,stagedConvolutions:0,cancelledPairs:0,deadlinePairs:0,maxDispatchMs:0,maxInFlight:0,captureMisses:0,submittedPairs:0,videoSnapshots:0,videoSnapshotFallbacks:0};
  this.stats={completed:0,late:0,ms:0};
  this.uniformStride=Math.max(UNIFORM_BYTES,device.limits.minUniformBufferOffsetAlignment||256);
  try{
   this.uniformSlots=Array.from({length:IN_FLIGHT_LIMIT},(_,i)=>({
    buffer:this.buffer(this.uniformStride*UNIFORM_SLOTS,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST,'IFRNet tile uniforms '+i),
    data:new ArrayBuffer(this.uniformStride*UNIFORM_SLOTS),pending:null,
   }));
   this.scene=this.buffer(16,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC,'IFRNet scene statistics');
   this.sceneRead=this.buffer(16,GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST,'IFRNet 16-byte statistics readback');
  }catch(error){for(const resource of [...this.resources.keys()])this.release(resource);throw error;}
  this.onGPUError=event=>{this.error??=new Error('IFRNet WebGPU: '+(event.error?.message||'GPU validation error'));};
  device.addEventListener?.('uncapturederror',this.onGPUError);
  const lossTarget={current:this};this.lossTarget=lossTarget;
  this.whenLost=device.lost.then(info=>{
   const error=new Error('IFRNet WebGPU device lost: '+(info?.message||info?.reason||'unknown reason')),engine=lossTarget.current;
   if(engine){engine.lost=true;engine.reset();engine.error=error;engine.destroy();}return error;
  });
 }
 get modelSize(){return {width:this.dimensions.activeW,height:this.dimensions.activeH};}
 static async create(gl,bytes,width,height,profile='balanced',step=0,signal=null,options={}){
  if(signal?.aborted)throw cancelled();
  if(!gl||gl.isContextLost())throw new Error('WebGL context unavailable for IFRNet presentation.');
  if(!root.navigator?.gpu)throw new Error('WebGPU is unavailable; IFRNet requires a supported browser and GPU adapter.');
  if(!G||!S||!W)throw new Error('IFRNet WebGPU modules unavailable. Reload the extension and page.');
  let device=null,lease=null,engine=null;
  try{
   if(root.VENeuralDevice?.acquire){lease=await root.VENeuralDevice.acquire(signal);device=lease.device;}
   else{
    const adapter=await root.navigator.gpu.requestAdapter();if(signal?.aborted)throw cancelled();
    if(!adapter)throw new Error('No WebGPU adapter is available for IFRNet.');
    // Core rgba16float storage and FP32 arithmetic need no optional features.
    device=await adapter.requestDevice();
   }
   if(signal?.aborted)throw cancelled();
   const model=await S.decodeWeightsAsync(bytes,{signal,yieldTask});
   if(signal?.aborted)throw cancelled();
   // Coarse completion implementations also pay a high cold cost for the
   // driver's large workgroup-array initialization. Keep the same tiled math
   // in a bounded, reusable storage buffer on that measured device path.
   const storageTiles=options.storageTiles??(lease?.completionMs>8&&options.generic!==true&&options.compact!==true&&options.tiled!==false);
   // Quality shares convolution programs on the storage-tile path. Balanced
   // also shares them when input staging is enabled; the combined storage
   // kernel retains its specialized Balanced path.
   // Fast completion paths retain their existing workgroup kernels.
   const genericStorage=options.genericStorage??((profile==='quality'||profile==='balanced'&&options.stagedStorage===true)&&storageTiles&&options.compact!==false&&options.generic!==true);
   const compact=options.compact??genericStorage;
   engine=new Runtime(gl,device,model,width,height,S.dimensions(width,height,profile,step),{...options,storageTiles,compact,genericStorage,lease});
   if(engine.videoSnapshot)engine.capturePipeline=await engine.pipeline({label:'video source snapshot',code:CAPTURE,bindings:[
    {binding:0,name:'source',kind:'external-texture'},{binding:1,name:'imageSampler',kind:'sampler'},
    {binding:2,name:'output',kind:'storage-texture',format:'rgba8unorm'}]},null,signal);
   await engine.prepare(engine.dimensions,signal);await engine.preparePresentation(width,height,signal);
   engine.check(signal);return engine;
  }catch(error){if(engine)await engine.destroy();else if(lease)lease.release();else device?.destroy();throw error;}
 }
 check(signal=null){
  if(this.destroyed||signal?.aborted)throw cancelled();
  if(this.lost)throw this.error||new Error('IFRNet WebGPU device lost.');
  if(this.error)throw this.error;
  if(this.gl.isContextLost())throw new Error('WebGL presentation context lost.');
 }
 closeSource(source){
  if(source.refs)throw new Error('Cannot close an IFRNet source still owned by GPU work.');
  source.frame?.close();source.frame=null;source.external=null;source.serial=-1;source.epoch=-1;
 }
 reset(){
  this.epoch++;this.lastSerial=-1;this.lastResult=null;
  if(this.externalSource)for(const source of this.sources)if(!source.refs)this.closeSource(source);
 }
 reserve(bytes){
  while(this.memoryBytes+bytes>MEMORY_LIMIT){
   const evict=[...this.shapes.values()].find(state=>state!==this.state||this.preparing);
   if(!evict)break;this.dropShape(evict);
  }
  if(this.memoryBytes+bytes>MEMORY_LIMIT)throw new Error('IFRNet WebGPU memory budget exceeded (256 MiB).');
 }
 buffer(size,usage,label){
  size=Math.max(4,Math.ceil(size/4)*4);this.reserve(size);
  const buffer=this.device.createBuffer({size,usage,label});this.resourceIds.set(buffer,++this.nextResourceId);this.resources.set(buffer,size);this.memoryBytes+=size;return buffer;
 }
 ensureScratch(bytes){
  if(bytes<=this.scratchBytes)return;
  const limit=Math.min(this.device.limits.maxStorageBufferBindingSize||128*1024*1024,this.device.limits.maxBufferSize||256*1024*1024);
  if(bytes>limit)throw new Error('IFRNet storage tile scratch exceeds the device buffer limit.');
  const previous=this.scratch;
  this.scratch=this.buffer(bytes,GPUBufferUsage.STORAGE,'IFRNet reusable storage tiles');this.scratchBytes=bytes;
  // Shape construction runs after inference drains. Invalidate groups before
  // releasing an older allocation, even when the pipeline source is reused.
  for(const program of this.pipelines.values())program.groups.clear();
  if(previous)this.release(previous);
 }
 texture(w,h,format='rgba16float',state=null,label='IFRNet tensor',usage=null){
  this.check();if(w>this.device.limits.maxTextureDimension2D||h>this.device.limits.maxTextureDimension2D)throw new Error('IFRNet texture exceeds the WebGPU device limit.');
  const bytes=w*h*({rgba32float:16,rgba16float:8}[format]||4);this.reserve(bytes);
  const texture=this.device.createTexture({label,size:[w,h],format,usage:usage??(GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.STORAGE_BINDING|GPUTextureUsage.COPY_DST)});
  this.resourceIds.set(texture,++this.nextResourceId);this.resources.set(texture,bytes);this.memoryBytes+=bytes;if(state){state.textures.add(texture);state.bytes+=bytes;}return texture;
 }
 release(resource){const bytes=this.resources.get(resource);if(bytes===undefined)return;resource.destroy();this.resources.delete(resource);this.memoryBytes-=bytes;}
 dropShape(state){
  if(!state)return;for(const texture of state.textures)this.release(texture);state.textures.clear();state.bytes=0;
  for(const program of this.pipelines.values())program.groups?.clear();
  this.shapes.delete(state.key);if(this.state===state)this.state=null;
 }
 trimPipelines(building=null){
  const used=new Set(building?.programs||[]);for(const state of this.shapes.values())for(const code of state.programs)used.add(code);
  if(this.statsPipeline)used.add(this.statsPipeline.code);
  if(this.capturePipeline)used.add(this.capturePipeline.code);
  for(const code of this.pipelines.keys())if(!used.has(code))this.pipelines.delete(code);
 }
 async pipeline(descriptor,state=null,signal=null){
  this.check(signal);if(state)state.programs.add(descriptor.code);
  if(this.pipelines.has(descriptor.code))return this.pipelines.get(descriptor.code);
  const device=this.device,entries=descriptor.bindings.map(binding=>{
   const entry={binding:binding.binding,visibility:GPUShaderStage.COMPUTE};
   if(binding.kind==='uniform')entry.buffer={type:'uniform',hasDynamicOffset:true,minBindingSize:UNIFORM_BYTES};
   else if(binding.kind==='texture')entry.texture={sampleType:'unfilterable-float',viewDimension:'2d',multisampled:false};
   else if(binding.kind==='filterable-texture')entry.texture={sampleType:'float',viewDimension:'2d',multisampled:false};
   else if(binding.kind==='external-texture')entry.externalTexture={};
   else if(binding.kind==='sampler')entry.sampler={type:'filtering'};
   else if(binding.kind==='storage-texture')entry.storageTexture={access:'write-only',format:binding.format,viewDimension:'2d'};
   else if(binding.kind==='storage-buffer')entry.buffer={type:'storage',minBindingSize:16};
   else throw new Error('Unknown IFRNet WebGPU binding: '+binding.kind);
   return entry;
  });
  const layout=device.createBindGroupLayout({entries}),module=device.createShaderModule({label:'IFRNet '+(descriptor.label||'compute'),code:descriptor.code});
  const pipeline=await device.createComputePipelineAsync({label:'IFRNet '+(descriptor.label||'compute'),layout:device.createPipelineLayout({bindGroupLayouts:[layout]}),compute:{module,entryPoint:'main'}});
  this.check(signal);const result={pipeline,layout,code:descriptor.code,bindings:descriptor.bindings,label:descriptor.label||descriptor.bindings.map(binding=>binding.name).join('/'),groups:new Map()};this.pipelines.set(descriptor.code,result);return result;
 }
 bind(program,resources,uniformBuffer){
  // External handles must not be retained by cached groups after VideoFrame.close().
  const cacheable=!program.bindings.some(binding=>binding.kind==='external-texture');
  const key=cacheable?this.resourceIds.get(uniformBuffer)+':'+program.bindings.filter(binding=>binding.kind!=='uniform').map(binding=>this.resourceIds.get(binding.kind==='sampler'?this.imageSampler:resources[binding.name])).join(','):null;
  if(cacheable&&program.groups.has(key))return program.groups.get(key);
  const group=this.device.createBindGroup({label:'IFRNet '+program.label,layout:program.layout,entries:program.bindings.map(binding=>{
   let resource=binding.kind==='sampler'?this.imageSampler:resources[binding.name];
   if(binding.kind==='uniform')resource={buffer:uniformBuffer,offset:0,size:UNIFORM_BYTES};
   else if(binding.kind==='storage-buffer')resource={buffer:resource};
   else if(binding.kind==='external-texture'){if(!resource)throw new Error('Missing IFRNet external source: '+binding.name);}
   else if(binding.kind==='sampler'){if(!resource)throw new Error('Missing IFRNet external image sampler.');}
   else {if(!resource)throw new Error('Missing IFRNet resource: '+binding.name);resource=resource.createView();}
   return {binding:binding.binding,resource};
  })});if(cacheable)program.groups.set(key,group);return group;
 }
 async attach(graph,state,signal){
  const uses=new Map(),pool=new Map(),owned=new Set(graph.tensors);let sliceStart=now();
  for(const op of graph.ops)for(const t of op.inputs){const b=G.baseOf(t);uses.set(b,(uses.get(b)||0)+1);}
  for(const op of graph.ops){
   this.check(signal);const o=op.out,key=o.tw+'x'+o.th,available=pool.get(key)||[];
   o.texture=available.pop()||this.texture(o.tw,o.th,'rgba16float',state);pool.set(key,available);
   const descriptor=W.operation(op,this.shaderOptions);op.tiled=descriptor.tiled===true;op.config=descriptor.config||0;
   op.scratchBytes=descriptor.scratchBytes||0;if(op.scratchBytes)this.ensureScratch(op.scratchBytes);
   op.convLayout=descriptor.convLayout||null;
   op.concatLayout=descriptor.concatLayout||null;
   op.readerLayout=descriptor.readerLayout||null;
   op.stageProgram=descriptor.stage?await this.pipeline(descriptor.stage,state,signal):null;
   op.stageGroups=descriptor.stageGroups||1;
   if(op.stageProgram)this.diagnostics.stagedConvolutions++;
   op.program=await this.pipeline(descriptor,state,signal);
   if(op.layer&&!this.layers.has(op.layer)){
    const packed=G.packLayer(op.layer),texture=this.texture(packed.width,packed.height,'rgba32float',null,'IFRNet packed FP32 weights',GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST);
    // writeTexture has no bytesPerRow alignment requirement, unlike buffer copies.
    this.device.queue.writeTexture({texture},packed.data,{bytesPerRow:packed.width*16,rowsPerImage:packed.height},[packed.width,packed.height]);
    this.layers.set(op.layer,texture);op.layer.weights=null;
   }
   for(const input of op.inputs){const b=G.baseOf(input),remaining=uses.get(b)-1;uses.set(b,remaining);
    if(remaining===0&&owned.has(b)&&!graph.outputs.has(b)){const k=b.tw+'x'+b.th;if(!pool.has(k))pool.set(k,[]);pool.get(k).push(b.texture);}
   }
   if(now()-sliceStart>=2){await yieldTask();this.check(signal);sliceStart=now();}
  }
 }
 activate(state,dimensions){
  this.state=state;this.dimensions=dimensions;this.enc=state.enc;this.dec=state.dec;this.swap=state.swap;
  this.shapes.delete(state.key);this.shapes.set(state.key,state);this.reset();
 }
 async prepare(dimensions=this.dimensions,signal=null){
  this.check(signal);const key=dimensions.w+'x'+dimensions.h;
  if(this.shapes.has(key)){this.diagnostics.shapeHits++;this.activate(this.shapes.get(key),dimensions);return;}
  while(this.shapes.size>=SHAPE_LIMIT)this.dropShape(this.shapes.values().next().value);
  const state={key,textures:new Set(),programs:new Set(),bytes:0};
  this.preparing=state;
  try{
   const max=this.device.limits.maxTextureDimension2D;
   state.enc=[G.encoder(this.model,dimensions,max),G.encoder(this.model,dimensions,max)];
   await this.attach(state.enc[0].graph,state,signal);await this.attach(state.enc[1].graph,state,signal);
   state.dec=G.decoder(this.model,state.enc[0].features,state.enc[1].features,max);await this.attach(state.dec.graph,state,signal);
   state.swap=new Map();for(let i=0;i<4;i++){state.swap.set(state.enc[0].features[i],state.enc[1].features[i]);state.swap.set(state.enc[1].features[i],state.enc[0].features[i]);}
   state.synth=await this.pipeline(W.synth(state.dec.flow,state.dec.raw,this.shaderOptions),state,signal);
   if(!this.statsPipeline)this.statsPipeline=await this.pipeline(W.stats(this.shaderOptions),null,signal);
   this.check(signal);this.shapes.set(key,state);this.activate(state,dimensions);this.diagnostics.shapeBuilds++;this.trimPipelines();
  }catch(error){this.dropShape(state);this.trimPipelines();throw error;}finally{this.preparing=null;}
 }
 async preparePresentation(width,height,signal=null){
  await Promise.allSettled([...this.presentationJobs]);await this.compositor?.whenIdle();this.check(signal);
  this.check(signal);if(this.output&&width===this.sourceW&&height===this.sourceH)return;
  if(!(Number.isInteger(width)&&Number.isInteger(height)&&width>0&&height>0))throw new Error('Invalid IFRNet source dimensions.');
  for(const source of this.sources){this.closeSource(source);this.release(source.texture);}this.sources=[];
  this.memoryBytes-=this.sourceBytes;this.sourceBytes=0;this.release(this.output);this.output=null;
  for(const program of this.pipelines.values())program.groups.clear();
  if(this.canvasBytes){this.memoryBytes-=this.canvasBytes;this.canvasBytes=0;}
  this.context?.unconfigure();this.context=null;this.stage=null;this.sourceW=width;this.sourceH=height;
  if(this.externalSource){
   // Reserve a conservative full-RGBA equivalent for four retained frames.
   this.reserve(width*height*4*SOURCE_LIMIT);this.sourceBytes=width*height*4*SOURCE_LIMIT;this.memoryBytes+=this.sourceBytes;
  }
  for(let i=0;i<SOURCE_LIMIT;i++)this.sources.push({texture:this.externalSource?null:this.texture(width,height,'rgba8unorm',null,'IFRNet source snapshot '+i,GPUTextureUsage.COPY_DST|GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.RENDER_ATTACHMENT|(this.videoSnapshot?GPUTextureUsage.STORAGE_BINDING:0)),frame:null,external:null,serial:-1,epoch:-1,refs:0});
  this.output=this.texture(width,height,'rgba8unorm',null,'IFRNet reconstructed RGB',GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.STORAGE_BINDING|GPUTextureUsage.COPY_SRC);
  this.reserve(width*height*4);this.canvasBytes=width*height*4;this.memoryBytes+=this.canvasBytes;
  if(typeof OffscreenCanvas==='undefined')throw new Error('A GPU-backed OffscreenCanvas is unavailable for IFRNet presentation.');
  this.stage=new OffscreenCanvas(width,height);this.context=this.stage.getContext('webgpu');
  if(!this.context)throw new Error('WebGPU OffscreenCanvas presentation is unavailable.');
  const format=this.canvasCopy?'rgba8unorm':root.navigator.gpu.getPreferredCanvasFormat();
  // Synthesis writes alpha 1 and the blit preserves it, so premultiplication is
  // identical. Chromium's opaque snapshot path adds a lazy browser-copy pipeline.
  this.context.configure({device:this.device,format,alphaMode:'premultiplied',...(this.canvasCopy?{usage:GPUTextureUsage.COPY_DST|GPUTextureUsage.RENDER_ATTACHMENT}:{})});
  if(this.canvasCopy){this.blit=null;this.blitGroup=null;this.blitFormat=null;}
  else{
   if(!this.blit||this.blitFormat!==format){
    const module=this.device.createShaderModule({label:'IFRNet canvas blit',code:BLIT});
    this.blit=await this.device.createRenderPipelineAsync({label:'IFRNet canvas blit',layout:'auto',vertex:{module,entryPoint:'vs'},fragment:{module,entryPoint:'fs',targets:[{format}]},primitive:{topology:'triangle-list'}});this.blitFormat=format;
   }
   this.blitGroup=this.device.createBindGroup({layout:this.blit.getBindGroupLayout(0),entries:[{binding:0,resource:this.output.createView()}]});
  }
  this.check(signal);
  await this.drain(true,true);this.check(signal);
 }
 resize(width,height,profile='balanced',signal=null){
  const dimensions=S.dimensions(width,height,profile);this.reset();this.diagnostics.resizes++;
  const task=(this.resizing||this.idle).catch(()=>{}).then(async()=>{
   await this.idle;this.check(signal);await this.prepare(dimensions,signal);await this.preparePresentation(width,height,signal);this.check(signal);return this;
  });
  this.resizing=task;return task.finally(()=>{if(this.resizing===task)this.resizing=null;});
 }
 captureFrame(video,serial){
  if(this.destroyed||this.lost||this.resizing)return false;this.check();
  if(video.videoWidth!==this.sourceW||video.videoHeight!==this.sourceH||!Number.isSafeInteger(serial)||serial<0)return false;
  if(this.sources.some(source=>source.serial===serial&&source.epoch===this.epoch))return true;
  const available=this.sources.filter(source=>source.refs===0).sort((a,b)=>(a.epoch===this.epoch?1:0)-(b.epoch===this.epoch?1:0)||a.serial-b.serial);
  if(!available.length){this.diagnostics.captureMisses++;return false;}
  const source=available[0];this.closeSource(source);
  // Snapshot synchronously in the decoded frame callback, before any await.
  if(this.externalSource){
   let frame=null;
   try{
    const seconds=Number.isFinite(video.currentTime)?video.currentTime:serial/60;
    frame=new root.VideoFrame(video,{timestamp:Math.round(seconds*1e6)});
    const external=this.device.importExternalTexture({source:frame,colorSpace:'srgb'});
    source.frame=frame;source.external=external;
   }catch(error){frame?.close();throw new Error('IFRNet immutable VideoFrame capture failed: '+(error.message||error));}
  }else if(this.videoSnapshot){
   if(!this.captureVideoSnapshot(video,source)){this.diagnostics.captureMisses++;return false;}
  }
  else this.device.queue.copyExternalImageToTexture({source:video},{texture:source.texture,colorSpace:'srgb'},[this.sourceW,this.sourceH]);
  source.serial=serial;source.epoch=this.epoch;return true;
 }
 captureVideoSnapshot(video,source){
  let external,frame=null,submitted=false;
  try{
   try{
    if(!this.videoImportFailed){
     try{external=this.device.importExternalTexture({source:video,colorSpace:'srgb'});}
     catch(error){if(error?.name!=='TypeError')throw error;this.videoImportFailed=true;}
    }
    if(!external){
     frame=new root.VideoFrame(video,{timestamp:Math.round((video.currentTime||0)*1e6)});
     external=this.device.importExternalTexture({source:frame,colorSpace:'srgb'});
     this.diagnostics.videoSnapshotFallbacks++;
    }
   }catch(error){
    // Wait for the next decoded frame without retiring a healthy device.
    if(videoSourceUnavailable(error))return false;throw error;
   }
   const encoder=this.device.createCommandEncoder({label:'IFRNet immutable GPU video snapshot'});
   const pass=encoder.beginComputePass({label:'IFRNet video capture'});
   pass.setPipeline(this.capturePipeline.pipeline);
   pass.setBindGroup(0,this.bind(this.capturePipeline,{source:external,output:source.texture}));
   pass.dispatchWorkgroups(Math.ceil(this.sourceW/8),Math.ceil(this.sourceH/8));pass.end();
   this.device.queue.submit([encoder.finish()]);submitted=true;
   this.diagnostics.videoSnapshots++;
   return true;
  }finally{
   if(submitted){
    // Capture has its own pool ownership, even if no presentation/inference
    // consumes this frame. Four source slots bound uploads under GPU pressure.
    source.refs++;
    this.holdPresentation([{release:()=>{frame?.close();this.releaseSource(source);}}]);
   }else frame?.close();
  }
 }
 sourceResource(source){
  // Import immediately before encoding. A VideoFrame keeps its pixels owned;
  // an external-texture handle may still expire across browser tasks or a
  // decoder/source transition and must not serve as a persistent snapshot.
  return this.externalSource?this.device.importExternalTexture({source:source.frame,colorSpace:'srgb'}):source.texture;
 }
 async prepareCompositor(canvas,lut,signal=null){
  if(!root.VENeuralCompositor||!(this.externalSource||this.videoSnapshot))return false;
  this.check(signal);
  const compositor=await root.VENeuralCompositor.create(this.device,canvas,{captureMode:'external',lut,waitForCompletion:()=>this.waitForCompletion()});
  try{this.check(signal);}catch(error){await compositor.destroy();throw error;}
  this.compositor=compositor;return true;
 }
 presentationSource(serial,video=null){
  // Resizing closes the old pool after its admitted readers drain. Live
  // frames during that interval have independent ownership and no pool refs.
  const source=!this.resizing&&this.sources.find(item=>item.serial===serial&&item.epoch===this.epoch);
  if(source){
   source.refs++;
   try{return {input:this.externalSource?{external:this.sourceResource(source)}:{texture:source.texture},width:this.sourceW,height:this.sourceH,release:()=>this.releaseSource(source)};}
   catch(error){this.releaseSource(source);throw error;}
  }
  if(serial!==-1||!video?.videoWidth||!video?.videoHeight||typeof root.VideoFrame!=='function')return null;
  if(this.videoSnapshot&&!this.videoImportFailed){
   try{return {input:{external:this.device.importExternalTexture({source:video,colorSpace:'srgb'})},width:video.videoWidth,height:video.videoHeight,release(){}};}
   catch(error){if(videoSourceUnavailable(error))return null;if(error?.name!=='TypeError')throw error;this.videoImportFailed=true;}
  }
  let frame;
  try{frame=new root.VideoFrame(video,{timestamp:Math.round((video.currentTime||0)*1e6)});}
  catch(error){if(videoSourceUnavailable(error))return null;throw error;}
  try{return {input:{external:this.device.importExternalTexture({source:frame,colorSpace:'srgb'})},width:video.videoWidth,height:video.videoHeight,release:()=>frame.close()};}
  catch(error){frame.close();if(videoSourceUnavailable(error))return null;throw error;}
 }
 queuePresentation(input,width,height,config,locks=[]){
  try{if(!this.compositor.render(input,width,height,config)){for(const lock of locks)lock.release();return false;}}
  catch(error){this.holdPresentation(locks);throw error;}
  this.holdPresentation(locks);return true;
 }
 holdPresentation(locks){
  // Track the queue directly: an errored compositor can reject whenIdle
  // before commands that still read these immutable frames have drained.
  let fence;try{fence=this.waitForCompletion();}catch(error){fence=Promise.reject(error);}
  const pending=Promise.resolve(fence).finally(()=>{for(const lock of locks)lock.release();this.presentationJobs.delete(pending);});
  this.presentationJobs.add(pending);pending.catch(()=>{});return true;
 }
 releaseSource(source){
  source.refs--;
  if(this.externalSource&&!source.refs&&(this.destroyed||this.lost||source.epoch!==this.epoch))this.closeSource(source);
 }
 presentFrame(serial,config,video=null){
  if(!this.compositor||this.destroyed||this.lost)return false;
  const source=this.presentationSource(serial,video);if(!source)return false;
  return this.queuePresentation(source.input,source.width,source.height,config,[source]);
 }
 hasCapturedFrame(serial){return !this.resizing&&this.sources.some(source=>source.serial===serial&&source.epoch===this.epoch);}
 retainPrediction(slot){
  if(!this.compositor||!this.lastResult||this.lastResult.epoch!==this.epoch)return null;
  return this.compositor.snapshot(this.output,this.sourceW,this.sourceH,slot);
 }
 presentPrediction(texture,config,anchorSerial,video=null){
  if(!this.compositor||this.destroyed||this.lost||this.resizing||!texture)return false;
  const anchor=config.compare?this.presentationSource(anchorSerial):null;
  if(config.compare&&!anchor)return false;
  return this.queuePresentation({texture},this.sourceW,this.sourceH,anchor?{...config,comparisonSource:anchor.input}:config,anchor?[anchor]:[]);
 }
 waitForCompletion(){
  return typeof this.lease?.waitForCompletion==='function'?this.lease.waitForCompletion():this.device.queue.onSubmittedWorkDone();
 }
 continueRun(epoch,job,checkDeadline=true){
  if(job.reason)return false;
  if(this.destroyed||this.lost||epoch!==this.epoch)job.reason='obsolete';
  else if(checkDeadline&&now()>=job.deadline)job.reason='deadline';
  else if(job.valid&&!job.valid())job.reason='obsolete';
  return !job.reason;
 }
 retireSubmissions(){
  for(const record of this.inFlight)if(record.done&&record.slot.pending===record)record.slot.pending=null;
  this.inFlight=this.inFlight.filter(record=>!record.done);
 }
 async batch(){
  this.retireSubmissions();
  if(this.inFlight.length>=IN_FLIGHT_LIMIT){
   const start=now();await this.inFlight[0].promise.catch(()=>{});
   if(this.activeJob){const elapsed=now()-start;this.activeJob.waitMs+=elapsed;this.activeJob.backpressureMs+=elapsed;}this.retireSubmissions();this.check();
  }
  let slot;
  for(let i=0;i<IN_FLIGHT_LIMIT;i++){
   const index=(this.nextUniformSlot+i)%IN_FLIGHT_LIMIT;
   if(!this.uniformSlots[index].pending){slot=this.uniformSlots[index];this.nextUniformSlot=(index+1)%IN_FLIGHT_LIMIT;break;}
  }
  if(!slot)throw new Error('IFRNet WebGPU submission ring overflow.');
  return {encoder:this.device.createCommandEncoder({label:'IFRNet bounded slice'}),slot,pass:null,count:0,data:slot.data,work:0,hasConv:false,render:false};
 }
 encode(batch,program,resources,tile,phase,debug=0,size=[1,1],one=false,depth=1,convLayout=null){
  if(batch.count>=UNIFORM_SLOTS)throw new Error('IFRNet uniform slice overflow.');
  const offset=batch.count++*this.uniformStride,view=new DataView(batch.data,offset,UNIFORM_BYTES);
  [size[0],size[1],this.dimensions.activeW,this.dimensions.activeH,tile.x,tile.y,tile.w,tile.h].forEach((n,i)=>view.setUint32(i*4,n,true));
  view.setFloat32(32,phase,true);view.setUint32(36,debug,true);view.setUint32(40,one?1:this.sourceW,true);view.setUint32(44,one?1:this.sourceH,true);
  if(convLayout){
   view.setUint32(8,convLayout.active[0],true);view.setUint32(12,convLayout.active[1],true);
   view.setUint32(40,convLayout.outputSize[0],true);view.setUint32(44,convLayout.outputSize[1],true);
  }
  if(!batch.pass)batch.pass=batch.encoder.beginComputePass({label:'IFRNet compute'});
  batch.pass.setPipeline(program.pipeline);batch.pass.setBindGroup(0,this.bind(program,resources,batch.slot.buffer),[offset]);
  batch.pass.dispatchWorkgroups(one?1:Math.ceil(tile.w/8),one?1:Math.ceil(tile.h/8),depth);
 }
 resourcesFor(op,source=null,swap=false){
  const resources={output:op.out.texture,source};op.inputs.forEach((input,i)=>{const base=G.baseOf(input);resources['s'+i]=(swap?(this.swap.get(base)||base):base).texture;});
  // The uniform-driven storage kernel keeps one binding layout for both
  // residual and plain convolutions. Its inactive residual input is read-only.
  if(op.tiled&&op.convLayout&&!op.residual)resources.s1=resources.s0;
  if(op.concatLayout)for(let i=op.inputs.length;i<5;i++)resources['s'+i]=resources.s0;
  if(op.layer)resources.weights=this.layers.get(op.layer);if(op.scratchBytes)resources.scratch=this.scratch;return resources;
 }
 async drain(check=true,uploads=false){
  const start=now(),records=this.inFlight.slice(),wave=this.wave;
  // allSettled drains every submitted command even when one fence rejects.
  // Preparation also calls this with no submissions to finish weight uploads.
  const pending=records.length?Promise.allSettled(records.map(record=>record.promise)):
   uploads?Promise.allSettled([this.waitForCompletion()]):Promise.resolve([]);
  this.pending=pending;const settled=await pending;
  if(this.activeJob){const elapsed=now()-start;this.activeJob.waitMs+=elapsed;this.activeJob.drainMs+=elapsed;}this.retireSubmissions();
  if(wave&&wave===this.wave){
   this.wave=null;const elapsed=now()-wave.start,executionMs=elapsed-this.completionFloorMs;
   // Adapt from a fully drained wave. A single queued batch's fence includes
   // earlier batches, so using its wall time would collapse the work quantum.
   if(wave.conv&&executionMs>.05){const target=wave.targetMs||TARGET_MS,measured=wave.work*target/executionMs;
    const previous=this.dispatchWork;
    this.dispatchWork=Math.max(this.dispatchWorkFloor,Math.min(MAX_WORK,Math.max(this.dispatchWork*.5,Math.min(this.dispatchWork*2,measured))));
    if(this.activeJob)this.activeJob.tuning.push({work:wave.work,elapsedMs:elapsed,executionMs,previous,next:this.dispatchWork});
   }
  }
  if(check){const failure=settled.find(result=>result.status==='rejected');if(failure)throw failure.reason;this.check();}
 }
 submit(batch){
  if(!batch.count&&!batch.render)return;batch.pass?.end();batch.pass=null;
  if(batch.slot.pending)throw new Error('IFRNet uniform slot is still in flight.');
  // Four disjoint buffers and immutable aligned tile ranges prevent a later
  // CPU submission overwriting uniforms still referenced by GPU commands.
  if(batch.count)this.device.queue.writeBuffer(batch.slot.buffer,0,batch.data,0,batch.count*this.uniformStride);
  const start=now(),job=this.activeJob;
  this.device.queue.submit([batch.encoder.finish()]);
  const record={slot:batch.slot,start,promise:this.waitForCompletion(),done:false};
  batch.slot.pending=record;this.inFlight.push(record);
  this.diagnostics.maxInFlight=Math.max(this.diagnostics.maxInFlight,this.inFlight.length);
  if(this.inFlight.length>IN_FLIGHT_LIMIT)throw new Error('IFRNet WebGPU submission limit exceeded.');
  if(!this.wave)this.wave={start,work:0,conv:false,targetMs:job?.targetMs||TARGET_MS};
  this.wave.work+=batch.work;this.wave.conv||=batch.hasConv;
  if(job){job.batches++;job.dispatches+=batch.count;}
  record.promise.then(()=>{
   record.done=true;const elapsed=now()-start;
   this.diagnostics.maxDispatchMs=Math.max(this.diagnostics.maxDispatchMs,elapsed);
   // The earliest cheap preprocessing/statistics completion bounds callback
   // latency. Exclude cold driver compilation and other large outliers.
   if(!batch.hasConv&&job&&elapsed>0&&elapsed<=Math.max(8,job.targetMs*2))
    this.completionFloorMs=this.completionFloorMs?Math.min(this.completionFloorMs,elapsed):elapsed;
  },error=>{record.done=true;this.error=error instanceof Error?error:new Error(String(error));});
  this.pending=Promise.allSettled(this.inFlight.map(item=>item.promise));return record;
 }
 async runBatched(ops,epoch,phase,swap,job,onComplete=null,source=null){
  let batch=await this.batch(),start=now(),taskStart=start,limit=this.dispatchWork,allSubmitted=false,notified=false;
  const complete=()=>{if(allSubmitted&&!notified&&!this.destroyed&&!this.lost&&epoch===this.epoch){notified=true;onComplete?.();}};
  const flush=async()=>{
   if(!batch?.count)return this.continueRun(epoch,job);
   const record=this.submit(batch);batch=null;
   if(allSubmitted){
    // Queue order makes features available to later graph commands without a
    // CPU roundtrip. Publish the encoder cache only after its final fence.
    if(onComplete)record.promise.then(complete,()=>{});
    return this.continueRun(epoch,job);
   }
   // GPU slice size and CPU task duration are separate budgets. Small command
   // submissions need not pay a MessagePort turn each; backpressure below
   // still caps queued GPU work, and busy CPU encoding yields every 2 ms.
   if(now()-taskStart>=TARGET_MS){const yielded=now();await yieldTask();job.taskYieldMs+=now()-yielded;job.taskYields++;taskStart=now();}
   if(!this.continueRun(epoch,job))return false;
   const waiting=now();batch=await this.batch();taskStart+=now()-waiting;
   start=now();limit=this.dispatchWork;return this.continueRun(epoch,job);
  };
  for(let index=0;index<ops.length;index++){
   const op=ops[index],resources=this.resourcesFor(op,source,swap),cost=op.layer?op.layer.ci*(op.deconv?4:op.layer.k*op.layer.k)*(op.tiled?op.out.groups:1):op.type==='warp'?16:4;
   const width=op.tiled?op.out.w:op.out.tw,height=op.tiled?op.out.h:op.out.th;
   let x=0,y=0;
   while(y<height){
    if(!this.continueRun(epoch,job)){await this.drain();return false;}
    let w,h;
    if(op.tiled){
     // Shared-memory convolutions require tile origins on workgroup boundaries.
     // Region extents may be partial only at the physical tensor edge.
     const groups=Math.max(1,Math.floor((limit-batch.work)/(cost*64))),columns=Math.min(Math.ceil((width-x)/8),groups);
     w=Math.min(width-x,columns*8);h=x===0&&w===width?Math.min(height-y,Math.max(1,Math.floor(groups/columns))*8):Math.min(8,height-y);
    }else{
     const pixels=Math.max(1,Math.floor((limit-batch.work)/cost));w=Math.min(width-x,pixels);h=x===0&&w===width?Math.min(height-y,Math.max(1,Math.floor(pixels/w))):1;
    }
    if(op.stageProgram){
     // The pair must retain separate immutable uniforms in the same bounded
     // submission. No other region may overwrite its staged input in between.
     if(batch.count>UNIFORM_SLOTS-2){if(!await flush())return false;}
     this.encode(batch,op.stageProgram,resources,{x,y,w,h},phase,op.config,[op.out.w,op.out.h],false,op.stageGroups,op.convLayout);
    }
    this.encode(batch,op.program,resources,{x,y,w,h},phase,op.config,[op.out.w,op.out.h],false,op.tiled?op.out.groups:1,op.convLayout||op.concatLayout||op.readerLayout);batch.work+=w*h*cost;batch.hasConv||=!!op.layer;
    x+=w;if(x===width){x=0;y+=h;}allSubmitted=index===ops.length-1&&y===height;
    if(batch.work>=limit*.95||batch.count>=UNIFORM_SLOTS||now()-start>=TARGET_MS){if(!await flush())return false;}
   }
  }
  return flush();
 }
 async synthesize(prev,curr,phase,debug,epoch,job){
  let y=0,taskStart=now();const rows=Math.max(1,Math.floor(this.dispatchWork/(this.sourceW*8)));
  while(y<this.sourceH){
   if(!this.continueRun(epoch,job))return false;
   const h=Math.min(rows,this.sourceH-y),waiting=now(),batch=await this.batch();taskStart+=now()-waiting;
   if(!this.continueRun(epoch,job))return false;
   this.encode(batch,this.state.synth,{flow:G.baseOf(this.dec.flow).texture,raw:G.baseOf(this.dec.raw).texture,prev:this.sourceResource(prev),curr:this.sourceResource(curr),output:this.output},{x:0,y,w:this.sourceW,h},phase,debug,[this.dec.flow.w,this.dec.flow.h]);
   this.submit(batch);y+=h;if(!this.continueRun(epoch,job))return false;
   if(y<this.sourceH&&now()-taskStart>=TARGET_MS){const yielded=now();await yieldTask();job.taskYieldMs+=now()-yielded;job.taskYields++;taskStart=now();}
  }
  if(this.compositor&&this.directPresentation){
   // The copy and compositor draw use this same ordered GPU queue. Hand the
   // controller a private prediction as soon as synthesis is submitted; a CPU
   // completion notification is not needed to order its later presentation.
   job.publish?.();
   await this.drain();
   // Once accepted for presentation, a late notification cannot unsubmit it.
   // Epoch/source validity and resource ownership still wait for this fence.
   return this.continueRun(epoch,job,!job.published);
  }
  const batch=await this.batch();if(!this.continueRun(epoch,job))return false;
  // Obtain and consume the canvas texture in this same synchronous task.
  const current=this.context.getCurrentTexture();
  if(this.canvasCopy)batch.encoder.copyTextureToTexture({texture:this.output},{texture:current},[this.sourceW,this.sourceH]);
  else{
   const pass=batch.encoder.beginRenderPass({colorAttachments:[{view:current.createView(),loadOp:'clear',clearValue:{r:0,g:0,b:0,a:1},storeOp:'store'}]});
   pass.setPipeline(this.blit);pass.setBindGroup(0,this.blitGroup);pass.draw(3);pass.end();
  }
  batch.render=true;this.submit(batch);await this.drain();
  return this.continueRun(epoch,job);
 }
 async readStats(){
  await this.sceneRead.mapAsync(GPUMapMode.READ,0,16);
  try{const stats=Array.from(new Float32Array(this.sceneRead.getMappedRange(0,16)));
   if(!stats.every(Number.isFinite)||Math.abs(stats[3]-1)>.001)throw new Error('Invalid IFRNet scene statistics.');return stats;
  }finally{this.sceneRead.unmap();}
 }
 async estimate(prevGL,currGL,serial,phase=.5,options={}){
  if(this.busy||this.resizing)return null;this.check();
  if(!Number.isFinite(phase)||phase<0||phase>1)throw new Error('Invalid IFRNet interpolation phase.');
  const debug=debugValue(options.debug||'off'),epoch=this.epoch;
  const previous=this.sources.find(source=>source.serial===serial-1&&source.epoch===epoch),current=this.sources.find(source=>source.serial===serial&&source.epoch===epoch);
  if(!previous||!current){this.diagnostics.captureMisses++;this.lastResult=null;return null;}
  this.busy=true;let done;this.idle=new Promise(resolve=>{done=resolve;});previous.refs++;current.refs++;
  const start=now();let completed=false,currentEncoded=false,reuse=false,submitMs=0,statsPromise=null;
  const job={deadline:Number.isFinite(options.deadline)?options.deadline:Infinity,valid:typeof options.valid==='function'?options.valid:null,reason:'',targetMs:Number.isFinite(options.quantumMs)?Math.max(.5,Math.min(4,options.quantumMs)):TARGET_MS,
   stage:'preprocess',stageMs:{},batches:0,dispatches:0,waitMs:0,taskYieldMs:0,taskYields:0,backpressureMs:0,drainMs:0,tuning:[]};
  let stageStart=start;
  const stage=name=>{job.stageMs[job.stage]=(job.stageMs[job.stage]||0)+now()-stageStart;job.stage=name;stageStart=now();};
  this.activeJob=job;
  const cacheValid=typeof options.cacheValid==='function'?options.cacheValid:job.valid;
  const canCache=()=>{if(this.destroyed||this.lost||this.error||epoch!==this.epoch||this.gl.isContextLost())return false;try{return !cacheValid||cacheValid();}catch{return false;}};
  this.lastResult=null;
  try{
   if(!this.continueRun(epoch,job))return null;
   this.dispatchWork=Math.max(this.dispatchWorkFloor,Math.min(MAX_WORK,this.dispatchWork*job.targetMs/this.dispatchTargetMs));this.dispatchTargetMs=job.targetMs;
   reuse=this.lastSerial===serial-1;const prevSlot=reuse?this.lastSlot:0,currSlot=1-prevSlot;this.lastSerial=-1;
   const batch=await this.batch();if(!this.continueRun(epoch,job))return null;
   if(!reuse){const op=this.enc[prevSlot].graph.ops[0];this.encode(batch,op.program,this.resourcesFor(op,this.sourceResource(previous)),{x:0,y:0,w:op.out.tw,h:op.out.th},phase,0,[op.out.w,op.out.h]);}
   {const op=this.enc[currSlot].graph.ops[0];this.encode(batch,op.program,this.resourcesFor(op,this.sourceResource(current)),{x:0,y:0,w:op.out.tw,h:op.out.th},phase,0,[op.out.w,op.out.h]);}
   this.encode(batch,this.statsPipeline,{prev:this.sourceResource(previous),curr:this.sourceResource(current),output:this.scene},{x:0,y:0,w:1,h:1},phase,0,[16,16],true);
   batch.pass.end();batch.pass=null;batch.encoder.copyBufferToBuffer(this.scene,0,this.sceneRead,0,16);
   this.submit(batch);submitMs=now()-start;
   // This buffer is independent of all subsequent graph commands. Mapping
   // its 16 bytes can overlap the encoders/decoder instead of adding a final
   // completion callback. Every exit waits for mapping and unmapping below.
   statsPromise=this.readStats();statsPromise.catch(()=>{});
   {const yielded=now();await yieldTask();job.taskYieldMs+=now()-yielded;job.taskYields++;}if(!this.continueRun(epoch,job))return null;
   stage('encodeCurrent');
   if(!await this.runBatched(this.enc[currSlot].graph.ops.slice(1),epoch,phase,false,job,()=>{currentEncoded=true;if(canCache()){this.lastSerial=serial;this.lastSlot=currSlot;}}))return null;
   stage('encodePrevious');
   if(!reuse&&!await this.runBatched(this.enc[prevSlot].graph.ops.slice(1),epoch,phase,false,job))return null;
   stage('decoder');
   if(!await this.runBatched(this.dec.graph.ops,epoch,phase,prevSlot===1,job))return null;
   if(!this.continueRun(epoch,job))return null;
   stage('statistics');
   const stats=await statsPromise;if(!this.continueRun(epoch,job))return null;
   if(this.compositor&&this.directPresentation&&typeof options.onSubmitted==='function')job.publish=()=>{
    if(job.published||!this.continueRun(epoch,job))return;
    const gpuTexture=this.compositor.snapshot(this.output,this.sourceW,this.sourceH,serial%2);
    if(!gpuTexture)return;
    job.published=options.onSubmitted({serial,epoch,phase,valid:true,submitted:true,gpuTexture,
     sceneCut:stats[0]>.11&&stats[1]>.35,stats})===true;
    if(job.published)this.diagnostics.submittedPairs++;
   };
   stage('synthesis');
   if(!await this.synthesize(previous,current,phase,debug,epoch,job))return null;
   if(canCache()){this.lastSerial=serial;this.lastSlot=currSlot;}else this.lastSerial=-1;
   const result={serial,epoch,phase,elapsedMs:now()-start,submitMs,reusedEncoder:reuse,sceneCut:stats[0]>.11&&stats[1]>.35,stats,valid:true};
   this.lastResult={...result,prevGL,currGL,debug,width:this.sourceW,height:this.sourceH,valid:job.valid,canvas:this.stage};completed=true;return result;
  }finally{
   // A cancellation cannot release busy or snapshot locks before submitted
   // GPU commands drain. In particular a partial encoder must never be reused.
   await this.drain(false);
   if(statsPromise)await statsPromise.catch(()=>{});
   if(!completed){if(!currentEncoded||!job.reason||!canCache())this.lastSerial=-1;this.diagnostics.cancelledPairs++;}
   if(job.reason==='deadline'){this.diagnostics.deadlinePairs++;this.diagnostics.lastDeadlineAt=now();}
   job.stageMs[job.stage]=(job.stageMs[job.stage]||0)+now()-stageStart;
   this.lastRun={reason:job.reason,elapsedMs:now()-start,finishedAt:now(),completed,reusedEncoder:reuse,cachedEncoder:this.lastSerial===serial,
    stage:job.stage,stageMs:job.stageMs,batches:job.batches,dispatches:job.dispatches,waitMs:job.waitMs,taskYieldMs:job.taskYieldMs,taskYields:job.taskYields,
    backpressureMs:job.backpressureMs,drainMs:job.drainMs,tuning:job.tuning,submittedPrediction:!!job.published,
    dispatchWork:this.dispatchWork,completionFloorMs:this.completionFloorMs};
   this.activeJob=null;
   this.releaseSource(previous);this.releaseSource(current);
   this.busy=false;done();
  }
 }
 render(prev,curr,target,width,height,debug='off'){
  if(this.destroyed||this.lost||this.busy||this.resizing)return false;this.check();const result=this.lastResult;
  if(!result||result.epoch!==this.epoch||result.prevGL!==prev||result.currGL!==curr||result.canvas!==this.stage||width!==result.width||height!==result.height)return false;
  if(result.valid&&!result.valid())return false;
  if(debugValue(debug)!==result.debug)throw new Error('IFRNet debug view changed after inference; a new pair must be estimated with the requested debug view.');
  const gl=this.gl;gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,target);
  try{gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,gl.RGBA,gl.UNSIGNED_BYTE,result.canvas);}catch(error){throw new Error('WebGPU canvas to WebGL presentation is unavailable: '+error.message);}
  return true;
 }
 destroy(){
  if(this.disposeTask)return this.disposeTask;this.destroyed=true;this.reset();this.lossTarget.current=null;
  this.device.removeEventListener?.('uncapturederror',this.onGPUError);
  this.disposeTask=(async()=>{
   await this.idle.catch(()=>{});await this.pending.catch(()=>{});
   await Promise.allSettled([...this.presentationJobs]);try{await this.compositor?.destroy();}catch{}this.compositor=null;
   try{await this.waitForCompletion();}catch{}
   try{this.context?.unconfigure();}catch{}
   for(const source of this.sources)this.closeSource(source);
   for(const resource of [...this.resources.keys()])this.release(resource);
   this.memoryBytes=0;this.canvasBytes=0;this.sourceBytes=0;this.sources=[];this.shapes.clear();this.pipelines.clear();this.layers.clear();this.state=null;this.stage=null;this.context=null;
   this.enc=null;this.dec=null;this.swap=null;this.model=null;this.blit=null;this.blitGroup=null;this.uniformSlots=[];this.inFlight=[];
   if(this.lease){this.lease.release();this.lease=null;}else if(this.ownsDevice)this.device.destroy();
  })();return this.disposeTask;
 }
}
root.VENeuralWebGPU=Runtime;if(typeof module!=='undefined')module.exports=Runtime;
})(globalThis);
