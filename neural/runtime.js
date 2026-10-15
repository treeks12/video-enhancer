/* Local IFRNet-S inference. Weights/kernels persist across bounded shape changes. */
(function(root){
'use strict';
const G=root.VENeuralGraph,S=root.VENeuralSpec;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
// MessageChannel avoids the nested setTimeout(0) clamp in browser inference
// batches. It yields a task without adding 4 ms per network stage.
let channel=null,queued=[];
function yieldTask(){
 if(typeof document==='undefined'||typeof MessageChannel==='undefined')return sleep(0);
 if(!channel){channel=new MessageChannel();channel.port1.onmessage=()=>queued.shift()?.();channel.port1.unref?.();channel.port2.unref?.();}
 return new Promise(resolve=>{queued.push(resolve);channel.port2.postMessage(0);});
}
async function yieldPreparation(signal){
 // Preparation has no presentation deadline. Give the compositor a frame
 // before the next CPU slice; inference keeps the faster task-only yield.
 if(typeof document!=='undefined'&&!document.hidden&&typeof requestAnimationFrame==='function'){
  await new Promise(resolve=>{
   let frame=null,timer=null,finished=false;
   const done=()=>{if(finished)return;finished=true;
    if(frame!==null)cancelAnimationFrame(frame);if(timer!==null)clearTimeout(timer);
    signal?.removeEventListener('abort',done);resolve();};
   frame=requestAnimationFrame(done);timer=setTimeout(done,50);
   signal?.addEventListener('abort',done,{once:true});if(signal?.aborted)done();
  });
 }
 await yieldTask();
}
const MEMORY_LIMIT=256*1024*1024,SHAPE_LIMIT=2;
const INITIAL_DISPATCH_WORK=32*1024*1024,MIN_DISPATCH_WORK=128*1024,MAX_DISPATCH_WORK=1024*1024*1024;
const DISPATCH_TARGET_MS=2;
function cancelled(){const e=new Error('Neural preparation cancelled.');e.name='AbortError';return e;}
class Runtime {
 constructor(gl,model,dimensions){
  this.gl=gl;this.model=model;this.dimensions=dimensions;this.busy=false;this.destroyed=false;
  this.lastSerial=-1;this.lastSlot=0;this.epoch=0;
  this.textures=new Set();this.programs=new Map();this.layers=new Map();this.memoryBytes=0;
  this.shapes=new Map();this.state=null;this.idle=Promise.resolve();this.resizing=null;
  this.diagnostics={shapeBuilds:0,shapeHits:0,resizes:0,cancelledPairs:0,deadlinePairs:0,maxDispatchMs:0};
  this.dispatchWork=INITIAL_DISPATCH_WORK;this.dispatchTargetMs=DISPATCH_TARGET_MS;this.lastRun=null;
  this.fbo=gl.createFramebuffer();this.vao=gl.createVertexArray();this.syncs=new Set();
  this.khr=gl.getExtension('KHR_parallel_shader_compile');
 }
 static async create(gl,bytes,width,height,profile='balanced',step=0,signal=null){
  if(signal?.aborted)throw cancelled();
  if(!gl||gl.isContextLost())throw new Error('WebGL context unavailable.');
  if(!gl.getExtension('EXT_color_buffer_float'))throw new Error('Neural interpolation requires floating-point render targets.');
  const model=await S.decodeWeightsAsync(bytes,{signal,yieldTask:()=>yieldPreparation(signal)});
  if(signal?.aborted)throw cancelled();
  if(gl.isContextLost())throw new Error('Neural context lost.');
  const engine=new Runtime(gl,model,S.dimensions(width,height,profile,step));
  try{await engine.prepare(engine.dimensions,signal);return engine;}catch(e){engine.destroy();throw e;}
 }
 reset(){this.epoch++;this.lastSerial=-1;}
 check(signal){
  if(this.destroyed||signal?.aborted)throw cancelled();
  if(this.gl.isContextLost())throw new Error('Neural context lost.');
 }
 dropShape(state){
  if(!state)return;
  for(const t of state.textures){this.gl.deleteTexture(t);this.textures.delete(t);}
  this.memoryBytes-=state.bytes;state.textures.clear();state.bytes=0;
  this.shapes.delete(state.key);
  if(this.state===state)this.state=null;
 }
 trimPrograms(building=null){
  const used=new Set(building?.programs||[]);
  for(const state of this.shapes.values())for(const src of state.programs)used.add(src);
  for(const [src,p]of this.programs)if(!used.has(src)){this.gl.deleteProgram(p.program);this.programs.delete(src);}
 }
 texture(w,h,data=null,fp32=false,state=null){
  this.check();const bytes=w*h*(fp32?16:8);
  // Budget includes cached shapes and shared weights. No model per feed item.
  while(this.memoryBytes+bytes>MEMORY_LIMIT&&this.shapes.size)this.dropShape(this.shapes.values().next().value);
  if(this.memoryBytes+bytes>MEMORY_LIMIT)throw new Error('Neural memory budget exceeded (256 MiB).');
  const gl=this.gl,tex=gl.createTexture();if(!tex)throw new Error('Texture allocation failed.');
  this.textures.add(tex);this.memoryBytes+=bytes;
  if(state){state.textures.add(tex);state.bytes+=bytes;}
  gl.bindTexture(gl.TEXTURE_2D,tex);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D,0,fp32?gl.RGBA32F:gl.RGBA16F,w,h,0,gl.RGBA,gl.FLOAT,data);
  return tex;
 }
 async program(fragment,state,signal){
  this.check(signal);state.programs.add(fragment);
  if(this.programs.has(fragment))return this.programs.get(fragment);
  const gl=this.gl;
  const make=(type,src)=>{const s=gl.createShader(type);gl.shaderSource(s,src);gl.compileShader(s);return s;};
  const v=make(gl.VERTEX_SHADER,G.VERT),f=make(gl.FRAGMENT_SHADER,fragment),p=gl.createProgram();
  gl.attachShader(p,v);gl.attachShader(p,f);gl.linkProgram(p);
  try{
   if(this.khr){const start=performance.now();while(!gl.getProgramParameter(p,this.khr.COMPLETION_STATUS_KHR)){
    this.check(signal);if(performance.now()-start>30000)throw new Error('Neural shader compilation timed out.');await sleep(8);
   }}
   this.check(signal);
   if(!gl.getProgramParameter(p,gl.LINK_STATUS))throw new Error('Neural shader: '+(gl.getShaderInfoLog(f)||gl.getProgramInfoLog(p)));
  }catch(e){gl.deleteProgram(p);throw e;}finally{gl.deleteShader(v);gl.deleteShader(f);}
  const result={program:p,locations:new Map()};this.programs.set(fragment,result);return result;
 }
 location(p,name){if(!p.locations.has(name))p.locations.set(name,this.gl.getUniformLocation(p.program,name));return p.locations.get(name);}
 bind(p,name,tex,unit){const gl=this.gl;gl.activeTexture(gl.TEXTURE0+unit);gl.bindTexture(gl.TEXTURE_2D,tex);gl.uniform1i(this.location(p,name),unit);}
 async attach(graph,state,signal){
  let taskStart=performance.now();
  const uses=new Map(),pool=new Map();
  for(const op of graph.ops)for(const t of op.inputs){const b=G.baseOf(t);uses.set(b,(uses.get(b)||0)+1);}
  const owned=new Set(graph.tensors);
  for(let i=0;i<graph.ops.length;i++){
   this.check(signal);
   const op=graph.ops[i],o=op.out,key=o.tw+'x'+o.th;
   const available=pool.get(key)||[];o.texture=available.pop()||this.texture(o.tw,o.th,null,false,state);pool.set(key,available);
   op.program=await this.program(G.makeShader(op),state,signal);this.check(signal);
   if(op.layer&&!this.layers.has(op.layer)){
    const packed=G.packLayer(op.layer);this.layers.set(op.layer,this.texture(packed.width,packed.height,packed.data,true));
    op.layer.weights=null;
   }
   for(const t of op.inputs){const b=G.baseOf(t),n=uses.get(b)-1;uses.set(b,n);
    if(n===0&&owned.has(b)&&!graph.outputs.has(b)){
      const k=b.tw+'x'+b.th;if(!pool.has(k))pool.set(k,[]);pool.get(k).push(b.texture);
    }
   }
   if(performance.now()-taskStart>=2){await yieldPreparation(signal);this.check(signal);taskStart=performance.now();}
  }
 }
 activate(state,d){
  this.state=state;this.dimensions=d;
  for(const name of ['enc','dec','swap','synth'])this[name]=state[name];
  this.shapes.delete(state.key);this.shapes.set(state.key,state);this.reset();
 }
 async prepare(d=this.dimensions,signal=null){
  this.check(signal);const key=d.w+'x'+d.h;
  if(this.shapes.has(key)){this.diagnostics.shapeHits++;this.activate(this.shapes.get(key),d);return;}
  while(this.shapes.size>=SHAPE_LIMIT)this.dropShape(this.shapes.values().next().value);
  const state={key,textures:new Set(),programs:new Set(),bytes:0};
  try{
   const gl=this.gl,max=gl.getParameter(gl.MAX_TEXTURE_SIZE);
   state.enc=[G.encoder(this.model,d,max),G.encoder(this.model,d,max)];
   await this.attach(state.enc[0].graph,state,signal);await this.attach(state.enc[1].graph,state,signal);
   state.dec=G.decoder(this.model,state.enc[0].features,state.enc[1].features,max);await this.attach(state.dec.graph,state,signal);
   state.swap=new Map();for(let i=0;i<4;i++){
    state.swap.set(state.enc[0].features[i],state.enc[1].features[i]);state.swap.set(state.enc[1].features[i],state.enc[0].features[i]);
   }
   state.synth=await this.program(G.synthShader(state.dec.flow,state.dec.raw,d),state,signal);
   this.statsProgram=await this.program(G.STATS,state,signal);
   if(!this.statsTexture)this.statsTexture=this.texture(1,1,null,true);
   this.check(signal);
   gl.bindFramebuffer(gl.FRAMEBUFFER,this.fbo);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,this.statsTexture,0);
   if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw new Error('Floating-point framebuffer incomplete.');
   gl.bindFramebuffer(gl.FRAMEBUFFER,null);
   this.shapes.set(key,state);this.activate(state,d);this.diagnostics.shapeBuilds++;this.trimPrograms();
  }catch(e){this.dropShape(state);this.trimPrograms();throw e;}
 }
 resize(width,height,profile='balanced',signal=null){
  const d=S.dimensions(width,height,profile);
  this.reset();this.diagnostics.resizes++;
  const task=(this.resizing||this.idle).catch(()=>{}).then(async()=>{
   await this.idle;this.check(signal);await this.prepare(d,signal);return this;
  });
  this.resizing=task;return task.finally(()=>{if(this.resizing===task)this.resizing=null;});
 }
 runOps(ops,source=null,phase=.5,swap=false,tile=null){
  const gl=this.gl;gl.bindVertexArray(this.vao);gl.bindFramebuffer(gl.FRAMEBUFFER,this.fbo);
  // The compositor shares this context. Keep the full atlas viewport and
  // restore scissor before yielding so its draws are never clipped by a tile.
  gl.disable(gl.SCISSOR_TEST);
  if(tile){gl.enable(gl.SCISSOR_TEST);gl.scissor(tile.x,tile.y,tile.w,tile.h);}
  try{
  for(const op of ops){
   const p=op.program;gl.useProgram(p.program);
   gl.uniform2i(this.location(p,'tensorSize'),op.out.w,op.out.h);
   gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,op.out.texture,0);gl.viewport(0,0,op.out.tw,op.out.th);
   let unit=0;
   op.inputs.forEach((t,i)=>{const b=G.baseOf(t),actual=swap?(this.swap.get(b)||b):b;
    this.bind(p,'s'+i,actual.texture,unit++);gl.uniform2i(this.location(p,'s'+i+'Size'),t.w,t.h);});
   if(op.layer)this.bind(p,'weights',this.layers.get(op.layer),unit++);
   if(op.type==='preprocess'){
    this.bind(p,'source',source,unit++);gl.uniform2f(this.location(p,'activeSize'),this.dimensions.activeW,this.dimensions.activeH);
   }
   if(op.type==='phase')gl.uniform1f(this.location(p,'phase'),phase);
   gl.drawArrays(gl.TRIANGLES,0,3);
  }
  }finally{gl.disable(gl.SCISSOR_TEST);gl.bindFramebuffer(gl.FRAMEBUFFER,null);}
 }
 continueRun(epoch,job){
  if(job.reason)return false;
  if(this.destroyed||epoch!==this.epoch)job.reason='obsolete';
  else if(performance.now()>=job.deadline)job.reason='deadline';
  else if(job.valid&&!job.valid())job.reason='obsolete';
  return !job.reason;
 }
 async fence(epoch,job){
  const gl=this.gl,sync=gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE,0);if(!sync)throw new Error('GPU fence creation failed.');
  this.syncs.add(sync);gl.flush();const start=performance.now();
  try{
   while(true){
    if(this.destroyed)return false;
    if(gl.isContextLost())throw new Error('Neural context lost.');
    // A cancelled job still owns its submitted GPU work. Drain this fence
    // before releasing busy/idle; otherwise the next source frame can queue
    // another job ahead of work which the deadline could not actually cancel.
    this.continueRun(epoch,job);
    const wait=gl.clientWaitSync(sync,0,0);
    if(wait===gl.WAIT_FAILED)throw new Error('Neural GPU fence failed.');
    if(wait!==gl.TIMEOUT_EXPIRED)return this.continueRun(epoch,job);
    if(performance.now()-start>4000)throw new Error('Neural inference exceeded the safety timeout.');
    await yieldTask();
   }
  }finally{if(this.syncs.delete(sync))gl.deleteSync(sync);}
 }
 async runBatched(ops,epoch,phase,swap,job){
  let work=0,hasConv=false,start=performance.now(),limit=this.dispatchWork;
  const drain=async()=>{
   if(!work)return this.continueRun(epoch,job);
   const active=await this.fence(epoch,job),ms=performance.now()-start;
   this.diagnostics.maxDispatchMs=Math.max(this.diagnostics.maxDispatchMs,ms);
   if(hasConv&&ms>.05){
    const measured=work*job.targetMs/ms;
    this.dispatchWork=Math.max(MIN_DISPATCH_WORK,Math.min(MAX_DISPATCH_WORK,
      Math.max(this.dispatchWork*.5,Math.min(this.dispatchWork*2,measured))));
   }
   work=0;hasConv=false;
   if(!active)return false;
   await yieldTask();start=performance.now();limit=this.dispatchWork;
   return this.continueRun(epoch,job);
  };
  for(const op of ops){
   // Eight network ops can occupy several source intervals on a slower GPU.
   // Split expensive ops by their arithmetic work, without changing shaders,
   // weights or tensor resolution. Finish an op before reusing its inputs.
   const cost=op.layer?op.layer.ci*(op.deconv?4:op.layer.k*op.layer.k):op.type==='warp'?16:4;
   let x=0,y=0;
   while(y<op.out.th){
    if(!this.continueRun(epoch,job)){await drain();return false;}
    const pixels=Math.max(1,Math.floor((limit-work)/cost));
    const w=Math.min(op.out.tw-x,pixels),h=x===0&&w===op.out.tw?
      Math.min(op.out.th-y,Math.max(1,Math.floor(pixels/w))):1;
    this.runOps([op],null,phase,swap,{x,y,w,h});
    work+=w*h*cost;hasConv||=!!op.layer;
    x+=w;if(x===op.out.tw){x=0;y+=h;}
    // Aggregate cheap dependent operations within the same work quantum;
    // fencing every concat/phase op would add needless browser task latency.
    if(work>=limit*.95||performance.now()-start>=2){if(!await drain())return false;}
   }
  }
  return drain();
 }
 async estimate(prev,curr,serial,phase=.5,options={}){
  if(this.busy||this.resizing)return null;
  this.check();this.busy=true;let done;this.idle=new Promise(r=>{done=r;});
  const gl=this.gl,start=performance.now(),epoch=this.epoch;let completed=false;
  const job={deadline:Number.isFinite(options.deadline)?options.deadline:Infinity,
    valid:typeof options.valid==='function'?options.valid:null,reason:'',
    targetMs:Number.isFinite(options.quantumMs)?Math.max(.5,Math.min(4,options.quantumMs)):DISPATCH_TARGET_MS};
  try{
   if(!this.continueRun(epoch,job))return null;
   this.dispatchWork=Math.max(MIN_DISPATCH_WORK,Math.min(MAX_DISPATCH_WORK,this.dispatchWork*job.targetMs/this.dispatchTargetMs));
   this.dispatchTargetMs=job.targetMs;
   const reuse=this.lastSerial===serial-1,prevSlot=reuse?this.lastSlot:0,currSlot=1-prevSlot;
   // Snapshot endpoint RGB before yielding: renderer pair textures can advance.
   if(!reuse)this.runOps(this.enc[prevSlot].graph.ops.slice(0,1),prev);
   this.runOps(this.enc[currSlot].graph.ops.slice(0,1),curr);
   gl.bindFramebuffer(gl.FRAMEBUFFER,this.fbo);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,this.statsTexture,0);
   gl.viewport(0,0,1,1);gl.bindVertexArray(this.vao);gl.useProgram(this.statsProgram.program);
   this.bind(this.statsProgram,'prev',prev,0);this.bind(this.statsProgram,'curr',curr,1);gl.drawArrays(gl.TRIANGLES,0,3);
   gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.flush();const submitMs=performance.now()-start;
   // draw() gets to present the source before expensive convolutions.
   await yieldTask();
   if(!await this.fence(epoch,job))return null;
   if(!reuse&&!await this.runBatched(this.enc[prevSlot].graph.ops.slice(1),epoch,phase,false,job))return null;
   if(!await this.runBatched(this.enc[currSlot].graph.ops.slice(1),epoch,phase,false,job))return null;
   if(!await this.runBatched(this.dec.graph.ops,epoch,phase,prevSlot===1,job))return null;
   if(!this.continueRun(epoch,job))return null;
   const stats=new Float32Array(4);
   gl.bindFramebuffer(gl.FRAMEBUFFER,this.fbo);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,this.statsTexture,0);
   gl.readPixels(0,0,1,1,gl.RGBA,gl.FLOAT,stats);gl.bindFramebuffer(gl.FRAMEBUFFER,null);
   if(!stats.every(Number.isFinite)||Math.abs(stats[3]-1)>.001)throw new Error('Invalid neural scene statistics.');
   this.lastSerial=serial;this.lastSlot=currSlot;completed=true;
   return {serial,epoch,phase,elapsedMs:performance.now()-start,submitMs,reusedEncoder:reuse,
    sceneCut:stats[0]>.11&&stats[1]>.35,stats:Array.from(stats),valid:true};
  }finally{
   if(!completed){this.lastSerial=-1;this.diagnostics.cancelledPairs++;}
   if(job.reason==='deadline'){this.diagnostics.deadlinePairs++;this.diagnostics.lastDeadlineAt=performance.now();}
   this.lastRun={reason:job.reason,elapsedMs:performance.now()-start,finishedAt:performance.now(),completed};
   this.busy=false;done();
  }
 }
 render(prev,curr,target,w,h,debug='off'){
  if(this.destroyed||this.busy||this.resizing||!this.state)return false;
  const gl=this.gl,p=this.synth;gl.bindVertexArray(this.vao);gl.useProgram(p.program);
  gl.bindFramebuffer(gl.FRAMEBUFFER,this.fbo);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,target,0);
  gl.viewport(0,0,w,h);
  this.bind(p,'flow',G.baseOf(this.dec.flow).texture,0);this.bind(p,'raw',G.baseOf(this.dec.raw).texture,1);
  gl.uniform2i(this.location(p,'flowSize'),this.dec.flow.w,this.dec.flow.h);
  gl.uniform2i(this.location(p,'rawSize'),this.dec.raw.w,this.dec.raw.h);
  this.bind(p,'prev',prev,2);this.bind(p,'curr',curr,3);
  gl.uniform2f(this.location(p,'outputSize'),w,h);gl.uniform2f(this.location(p,'activeSize'),this.dimensions.activeW,this.dimensions.activeH);
  gl.uniform1i(this.location(p,'debugMode'),{off:0,flow:1,mask:2,residual:3}[debug]||0);
  gl.drawArrays(gl.TRIANGLES,0,3);gl.bindFramebuffer(gl.FRAMEBUFFER,null);return true;
 }
 destroy(){
  if(this.destroyed)return;this.destroyed=true;this.reset();const gl=this.gl;
  for(const sync of this.syncs)gl.deleteSync(sync);this.syncs.clear();
  for(const t of this.textures)gl.deleteTexture(t);for(const p of this.programs.values())gl.deleteProgram(p.program);
  gl.deleteFramebuffer(this.fbo);gl.deleteVertexArray(this.vao);
  this.textures.clear();this.programs.clear();this.layers.clear();this.shapes.clear();this.state=null;this.memoryBytes=0;
 }
}
root.VENeuralRuntime=Runtime;if(typeof module!=='undefined')module.exports=Runtime;
})(globalThis);
