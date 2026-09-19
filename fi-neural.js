/* GPU-resident neural image path, with a bounded four-texture capture ring. */
(function(scope){
 'use strict';
 const BLIT=`
 @group(0) @binding(0) var image:texture_2d<f32>;@group(0) @binding(1) var smp:sampler;
 struct V {@builtin(position) position:vec4<f32>,@location(0) uv:vec2<f32>};
 @vertex fn vs(@builtin(vertex_index) i:u32)->V {let p=array<vec2<f32>,3>(vec2<f32>(-1.0,-1.0),vec2<f32>(3.0,-1.0),vec2<f32>(-1.0,3.0));var o:V;o.position=vec4<f32>(p[i],0.0,1.0);o.uv=vec2<f32>(p[i].x*0.5+0.5,0.5-p[i].y*0.5);return o;}
 @fragment fn fs(v:V)->@location(0) vec4<f32>{return textureSampleLevel(image,smp,v.uv,0.0);}`;
 class Engine {
  static async create({profile='balanced'}={}){
   const model=await scope.FiNeuralModel.load();
   if(!navigator.gpu)throw new Error('WebGPU is unavailable');
   const adapter=await navigator.gpu.requestAdapter({powerPreference:profile==='quality'?'high-performance':'low-power'});
   if(!adapter)throw new Error('No WebGPU adapter');
   const features=adapter.features.has('shader-f16')?['shader-f16']:[];
   const device=await adapter.requestDevice({requiredFeatures:features});
   return new Engine(device,model,profile);
  }
  constructor(device,model,profile){
   this.kind='neural';this.device=device;this.model=model;this.profile=profile;
   this.lost=false;this.destroyed=false;this.busy=false;this.last=null;this.pool=[];
   this.initializing=null;this.generation=0;this.runtime=null;this.error='';this.stats={submitted:0,completed:0,late:0,busy:0,buffering:0,skipped:0,ms:0,p95:0};this.times=[];
   device.addEventListener?.('uncapturederror', event => { this.error = event.error?.message || 'Uncaptured WebGPU error'; });
   this.whenLost=device.lost.then(info=>{this.lost=true;return new Error(info.message||'Neural device lost');});
  }
  reset(){this.last=null;this.generation++;}
  _free(){this.runtime?.destroy();this.runtime=null;for(const t of this.pool)t.texture.destroy();this.pool=[];this.output?.destroy();this.output=null;try{this.context?.unconfigure();}catch{}this.last=null;}
  _resize(width,height){
   if(this.initializing||this.busy)return;
   const generation=++this.generation;
   this._free();this.width=width;this.height=height;
   const p=scope.FiQuality.profile(this.profile),size=scope.FiQuality.dimensions(width,height,p.neuralW,p.neuralH);
   this.modelSize=size;const device=this.device;
   this.initializing=(async()=>{
    let runtime=null;
    device.pushErrorScope('validation');
    try{
     if(Math.max(width,height)>device.limits.maxTextureDimension2D || width*height>4096*2304)throw new Error('Source exceeds the neural texture budget');
     runtime=await scope.FiNeuralRuntime.create(device,{w:size.width,h:size.height,weightsBin:this.model.binary,weightsManifest:this.model.manifest});
     if(this.destroyed||generation!==this.generation){runtime.destroy();return;}
     this.runtime=runtime;
     for(let i=0;i<4;i++)this.pool.push({texture:device.createTexture({label:'neural capture '+i,size:[width,height],format:'rgba8unorm',usage:GPUTextureUsage.COPY_DST|GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.RENDER_ATTACHMENT}),locked:false});
     this.output=device.createTexture({label:'neural reconstructed RGB',size:[width,height],format:'rgba8unorm',usage:GPUTextureUsage.STORAGE_BINDING|GPUTextureUsage.TEXTURE_BINDING});
     this.stage=new OffscreenCanvas(width,height);this.context=this.stage.getContext('webgpu');if(!this.context)throw new Error('WebGPU canvas unavailable');
     const format=navigator.gpu.getPreferredCanvasFormat();this.context.configure({device,format,alphaMode:'opaque'});
     const module=device.createShaderModule({code:BLIT});this.blit=await device.createRenderPipelineAsync({layout:'auto',vertex:{module,entryPoint:'vs'},fragment:{module,entryPoint:'fs',targets:[{format}]},primitive:{topology:'triangle-list'}});
     if(this.destroyed||generation!==this.generation){this._free();return;}
     this.blitGroup=device.createBindGroup({layout:this.blit.getBindGroupLayout(0),entries:[{binding:0,resource:this.output.createView()},{binding:1,resource:device.createSampler({minFilter:'linear',magFilter:'linear'})}]});
     await device.queue.onSubmittedWorkDone();
    }catch(error){this.error=String(error.message||error);runtime?.destroy();if(!this.destroyed)this._free();}
    finally{const validation=await device.popErrorScope().catch(error=>error);if(validation){this.error=validation.message;this._free();}this.initializing=null;}
   })();
  }
  submit(video,{phase=.5,serial,skip=false,valid=()=>true,debug=0}={}){
   if(this.destroyed||this.lost)throw new Error('Neural backend closed');
   if(this.error)throw new Error(this.error);
   const w=video.videoWidth,h=video.videoHeight;
   if(w!==this.width||h!==this.height||!this.runtime){this._resize(w,h);this.stats.buffering++;return null;}
   if(this.initializing){this.stats.buffering++;return null;}
   const current=this.pool.find(p=>p!==this.last&&!p.locked);
   if(!current){this.stats.busy++;return null;}
   // copyExternalImageToTexture snapshots this callback's decoded frame. It is
   // not deferred until after an await, when HTMLVideoElement may have advanced.
   this.device.queue.copyExternalImageToTexture({source:video},{texture:current.texture,colorSpace:'srgb'},[w,h]);
   const previous=this.last;this.last=current;
   if(!previous||skip){this.stats.skipped++;return null;}
   if(this.busy){this.stats.busy++;return null;}
   this.busy=true;previous.locked=current.locked=true;this.stats.submitted++;
   const device=this.device,generation=this.generation,start=performance.now();
   return (async()=>{
    device.pushErrorScope('validation');let popped=false;
    try{
     this.runtime.prepPair(previous.texture,current.texture);this.runtime.runT(phase,this.output,debug);
     await device.queue.onSubmittedWorkDone();
     const error=await device.popErrorScope();popped=true;if(error)throw new Error(error.message);
     if(this.destroyed||generation!==this.generation||!valid(serial)){this.stats.late++;return null;}
     // GPU texture -> GPU-backed canvas. No getImageData/mapAsync pixel readback.
     device.pushErrorScope('validation');popped=false;
     const enc=device.createCommandEncoder(),pass=enc.beginRenderPass({colorAttachments:[{view:this.context.getCurrentTexture().createView(),loadOp:'clear',clearValue:{r:0,g:0,b:0,a:1},storeOp:'store'}]});
     pass.setPipeline(this.blit);pass.setBindGroup(0,this.blitGroup);pass.draw(3);pass.end();device.queue.submit([enc.finish()]);
     await device.queue.onSubmittedWorkDone();const renderError=await device.popErrorScope();popped=true;if(renderError)throw new Error(renderError.message);
     const elapsed=performance.now()-start;
     if(this.destroyed||generation!==this.generation||!valid(serial)){this.stats.late++;return null;}
     this.stats.completed++;return {canvas:this.stage,width:w,height:h,serial,phase,elapsed};
    }finally{
     const elapsed=performance.now()-start;this.times.push(elapsed);if(this.times.length>60)this.times.shift();
     this.stats.ms=elapsed;this.stats.p95=[...this.times].sort((a,b)=>a-b)[Math.floor((this.times.length-1)*.95)];
     if(!popped)await device.popErrorScope().catch(()=>{});previous.locked=current.locked=false;this.busy=false;
    }
   })();
  }
  destroy(){if(this.destroyed)return;this.destroyed=true;this.generation++;this._free();this.device.destroy();}
 }
 scope.FiNeural={create:opts=>Engine.create(opts),Engine};
 if(typeof module!=='undefined'&&module.exports)module.exports=scope.FiNeural;
})(globalThis);
