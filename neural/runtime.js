/* Local IFRNet-S inference on WebGL2. Shares the renderer's context: no image readback. */
(function(root){
'use strict';
const G=root.VENeuralGraph,S=root.VENeuralSpec;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
class Runtime {
 constructor(gl,model,dimensions){
  this.gl=gl;this.model=model;this.dimensions=dimensions;this.busy=false;this.destroyed=false;
  this.lastSerial=-1;this.lastSlot=0;this.epoch=0;
  this.textures=new Set();this.programs=new Map();this.layers=new Map();this.memoryBytes=0;
  this.fbo=gl.createFramebuffer();this.vao=gl.createVertexArray();this.sync=null;
  this.khr=gl.getExtension('KHR_parallel_shader_compile');
 }
 static async create(gl,bytes,width,height,profile='balanced',step=0,signal=null){
  if(!gl||gl.isContextLost())throw new Error('WebGL context unavailable.');
  if(!gl.getExtension('EXT_color_buffer_float'))throw new Error('Neural interpolation requires floating-point render targets.');
  const engine=new Runtime(gl,S.decodeWeights(bytes),S.dimensions(width,height,profile,step));
  const abort=()=>engine.destroy();signal?.addEventListener('abort',abort,{once:true});
  try{if(signal?.aborted)throw new Error('Neural initialization cancelled.');await engine.prepare();return engine;}catch(e){engine.destroy();throw e;}finally{signal?.removeEventListener('abort',abort);}
 }
 reset(){this.epoch++;this.lastSerial=-1;}
 texture(w,h,data=null,fp32=false){
  if(this.destroyed)throw new Error('Neural initialization cancelled.');
  const gl=this.gl,tex=gl.createTexture();if(!tex)throw new Error('Texture allocation failed.');
  this.textures.add(tex);this.memoryBytes+=w*h*(fp32?16:8);
  if(this.memoryBytes>256*1024*1024){this.destroy();throw new Error('Neural memory budget exceeded (256 MiB).');}
  gl.bindTexture(gl.TEXTURE_2D,tex);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D,0,fp32?gl.RGBA32F:gl.RGBA16F,w,h,0,gl.RGBA,gl.FLOAT,data);
  return tex;
 }
 async program(fragment){
  if(this.destroyed)throw new Error('Neural initialization cancelled.');
  if(this.programs.has(fragment))return this.programs.get(fragment);
  const gl=this.gl;
  const make=(type,src)=>{const s=gl.createShader(type);gl.shaderSource(s,src);gl.compileShader(s);return s;};
  const v=make(gl.VERTEX_SHADER,G.VERT),f=make(gl.FRAGMENT_SHADER,fragment),p=gl.createProgram();
  gl.attachShader(p,v);gl.attachShader(p,f);gl.linkProgram(p);
  // Let normal playback continue while a driver compiles the kernels.
  try{
   if(this.khr){const start=performance.now();while(!gl.getProgramParameter(p,this.khr.COMPLETION_STATUS_KHR)){
    if(this.destroyed||gl.isContextLost()||performance.now()-start>30000)throw new Error('Neural shader compilation interrupted.');await sleep(8);
   }}
   if(this.destroyed||gl.isContextLost())throw new Error('Neural initialization cancelled.');
   if(!gl.getProgramParameter(p,gl.LINK_STATUS))throw new Error('Neural shader: '+(gl.getShaderInfoLog(f)||gl.getProgramInfoLog(p)));
  }catch(e){gl.deleteProgram(p);throw e;}finally{gl.deleteShader(v);gl.deleteShader(f);}
  const result={program:p,locations:new Map()};this.programs.set(fragment,result);return result;
 }
 location(p,name){if(!p.locations.has(name))p.locations.set(name,this.gl.getUniformLocation(p.program,name));return p.locations.get(name);}
 bind(p,name,tex,unit){const gl=this.gl;gl.activeTexture(gl.TEXTURE0+unit);gl.bindTexture(gl.TEXTURE_2D,tex);gl.uniform1i(this.location(p,name),unit);}
 async attach(graph){
  const uses=new Map(),pool=new Map();
  for(const op of graph.ops)for(const t of op.inputs){const b=G.baseOf(t);uses.set(b,(uses.get(b)||0)+1);}
  const owned=new Set(graph.tensors);
  for(let i=0;i<graph.ops.length;i++){
   if(this.destroyed)throw new Error('Neural initialization cancelled.');
   const op=graph.ops[i],o=op.out,key=o.tw+'x'+o.th;
   const available=pool.get(key)||[];o.texture=available.pop()||this.texture(o.tw,o.th);pool.set(key,available);
   op.program=await this.program(G.makeShader(op));
   if(this.destroyed)throw new Error('Neural initialization cancelled.');
   if(op.layer&&!this.layers.has(op.layer)){
    const packed=G.packLayer(op.layer);this.layers.set(op.layer,this.texture(packed.width,packed.height,packed.data,true));
   }
   for(const t of op.inputs){const b=G.baseOf(t),n=uses.get(b)-1;uses.set(b,n);
    if(n===0&&owned.has(b)&&!graph.outputs.has(b)){
      const k=b.tw+'x'+b.th;if(!pool.has(k))pool.set(k,[]);pool.get(k).push(b.texture);
    }
   }
   if(i%4===0)await sleep(0);
  }
 }
 async prepare(){
  const gl=this.gl,max=gl.getParameter(gl.MAX_TEXTURE_SIZE);
  this.enc=[G.encoder(this.model,this.dimensions,max),G.encoder(this.model,this.dimensions,max)];
  await this.attach(this.enc[0].graph);await this.attach(this.enc[1].graph);
  this.dec=G.decoder(this.model,this.enc[0].features,this.enc[1].features,max);await this.attach(this.dec.graph);
  this.swap=new Map();for(let i=0;i<4;i++){
    this.swap.set(this.enc[0].features[i],this.enc[1].features[i]);this.swap.set(this.enc[1].features[i],this.enc[0].features[i]);
  }
  this.synth=await this.program(G.synthShader(this.dec.flow,this.dec.raw,this.dimensions));
  this.statsProgram=await this.program(G.STATS);this.statsTexture=this.texture(1,1,null,true);
  gl.bindFramebuffer(gl.FRAMEBUFFER,this.fbo);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,this.statsTexture,0);
  if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw new Error('Floating-point framebuffer incomplete.');
  gl.bindFramebuffer(gl.FRAMEBUFFER,null);
  // Only shapes and slope-presence are needed once weights are packed on the GPU.
  for(const layer of this.layers.keys())layer.weights=null;
 }
 run(graph,source=null,phase=.5,swap=false){
  const gl=this.gl;gl.bindVertexArray(this.vao);gl.bindFramebuffer(gl.FRAMEBUFFER,this.fbo);
  for(const op of graph.ops){
   const p=op.program;gl.useProgram(p.program);
   gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,op.out.texture,0);gl.viewport(0,0,op.out.tw,op.out.th);
   let unit=0;
   op.inputs.forEach((t,i)=>{const b=G.baseOf(t),actual=swap?(this.swap.get(b)||b):b;this.bind(p,'s'+i,actual.texture,unit++);});
   if(op.layer)this.bind(p,'weights',this.layers.get(op.layer),unit++);
   if(op.type==='preprocess')this.bind(p,'source',source,unit++);
   if(op.type==='phase')gl.uniform1f(this.location(p,'phase'),phase);
   gl.drawArrays(gl.TRIANGLES,0,3);
  }
 }
 async estimate(prev,curr,serial,phase=.5){
  if(this.busy)return null;
  if(this.destroyed||this.gl.isContextLost())throw new Error('Neural context lost.');
  this.busy=true;const gl=this.gl,start=performance.now(),epoch=this.epoch;
  try{
   const reuse=this.lastSerial===serial-1,prevSlot=reuse?this.lastSlot:0,currSlot=1-prevSlot;
   if(!reuse)this.run(this.enc[prevSlot].graph,prev);
   this.run(this.enc[currSlot].graph,curr);
   this.run(this.dec.graph,null,phase,prevSlot===1);
   gl.bindFramebuffer(gl.FRAMEBUFFER,this.fbo);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,this.statsTexture,0);
   gl.viewport(0,0,1,1);gl.useProgram(this.statsProgram.program);
   this.bind(this.statsProgram,'prev',prev,0);this.bind(this.statsProgram,'curr',curr,1);gl.drawArrays(gl.TRIANGLES,0,3);
   this.lastSerial=serial;this.lastSlot=currSlot;
   const submitMs=performance.now()-start;
   this.sync=gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE,0);if(!this.sync)throw new Error('GPU fence creation failed.');
   gl.flush();gl.bindFramebuffer(gl.FRAMEBUFFER,null);
   while(true){
    if(this.destroyed||gl.isContextLost())throw new Error('Neural inference cancelled.');
    const wait=gl.clientWaitSync(this.sync,0,0);
    if(wait===gl.WAIT_FAILED)throw new Error('Neural GPU fence failed.');
    if(wait!==gl.TIMEOUT_EXPIRED)break;
    if(performance.now()-start>4000)throw new Error('Neural inference exceeded the safety timeout.');
    await sleep(1);
   }
   // Four scene statistics, only after the fence. No frames/features/flow leave the GPU.
   const stats=new Float32Array(4);
   gl.bindFramebuffer(gl.FRAMEBUFFER,this.fbo);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,this.statsTexture,0);
   gl.readPixels(0,0,1,1,gl.RGBA,gl.FLOAT,stats);gl.bindFramebuffer(gl.FRAMEBUFFER,null);
   if(!stats.every(Number.isFinite)||Math.abs(stats[3]-1)>.001)throw new Error('Invalid neural scene statistics.');
   return {serial,epoch,phase,elapsedMs:performance.now()-start,submitMs,reusedEncoder:reuse,
    sceneCut:stats[0]>.11&&stats[1]>.35,stats:Array.from(stats),valid:epoch===this.epoch};
  }finally{
   if(this.sync){gl.deleteSync(this.sync);this.sync=null;}this.busy=false;
  }
 }
 render(prev,curr,target,w,h,debug='off'){
  if(this.destroyed||this.busy)return false;
  const gl=this.gl,p=this.synth;gl.bindVertexArray(this.vao);gl.useProgram(p.program);
  gl.bindFramebuffer(gl.FRAMEBUFFER,this.fbo);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,target,0);
  gl.viewport(0,0,w,h);
  this.bind(p,'flow',G.baseOf(this.dec.flow).texture,0);this.bind(p,'raw',G.baseOf(this.dec.raw).texture,1);
  this.bind(p,'prev',prev,2);this.bind(p,'curr',curr,3);
  gl.uniform2f(this.location(p,'outputSize'),w,h);gl.uniform1i(this.location(p,'debugMode'),{off:0,flow:1,mask:2,residual:3}[debug]||0);
  gl.drawArrays(gl.TRIANGLES,0,3);gl.bindFramebuffer(gl.FRAMEBUFFER,null);return true;
 }
 destroy(){
  if(this.destroyed)return;this.destroyed=true;this.reset();const gl=this.gl;
  if(this.sync){gl.deleteSync(this.sync);this.sync=null;}
  for(const t of this.textures)gl.deleteTexture(t);for(const p of this.programs.values())gl.deleteProgram(p.program);
  gl.deleteFramebuffer(this.fbo);gl.deleteVertexArray(this.vao);this.textures.clear();this.programs.clear();this.layers.clear();
 }
}
root.VENeuralRuntime=Runtime;if(typeof module!=='undefined')module.exports=Runtime;
})(globalThis);
