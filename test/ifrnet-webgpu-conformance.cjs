// Real shader arithmetic against the shipping WebGL graph. Development only.
// TEST_BROWSER=firefox (headed by default) or chromium (Edge, headless by default).
// IFRNET_TILED=0 exercises the optional scalar dynamic-channel convolution path.
// IFRNET_COMPACT=1 makes kernel geometry uniform-driven for either convolution path.
// IFRNET_GENERIC=1 selects the generic scalar kernel with per-operation layouts.
// IFRNET_STORAGE_TILES=1 selects tiled convolutions backed by a storage scratch buffer.
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),os=require('node:os');
const puppeteer=require('puppeteer-core');
const root=path.resolve(__dirname,'..');
const kind=process.env.TEST_BROWSER||'firefox';
assert.ok(['firefox','chromium'].includes(kind),'TEST_BROWSER must be firefox or chromium');

async function conformance({tiled=true,compact=false,generic=false,storageTiles=false,genericStorage=false,stagedStorage=false,filteredSources=false,genericConcat=false,genericFlow=false}={}){
 const G=VENeuralGraph,S=VENeuralWebGPUShaders;
 const response=await fetch('/models/ifrnet.bin');
 if(!response.ok)throw new Error('Bundled IFRNet checkpoint unavailable: '+response.status);
 const model=await VENeuralSpec.decodeWeightsAsync(await response.arrayBuffer());
 const adapter=await navigator.gpu?.requestAdapter({powerPreference:'high-performance'});
 if(!adapter)throw new Error('Native WebGPU adapter unavailable; conformance was not run');
 const device=await adapter.requestDevice();
 const imageSampler=device.createSampler({magFilter:'linear',minFilter:'linear',mipmapFilter:'nearest',addressModeU:'clamp-to-edge',addressModeV:'clamp-to-edge'});
 const gpuErrors=[];device.addEventListener('uncapturederror',e=>gpuErrors.push(e.error.message));
 const canvas=document.createElement('canvas');canvas.width=64;canvas.height=32;
 const gl=canvas.getContext('webgl2',{antialias:false,preserveDrawingBuffer:true});
 if(!gl||!gl.getExtension('EXT_color_buffer_float'))throw new Error('WebGL2 floating point reference unavailable');
 gl.disable(gl.DITHER);gl.bindVertexArray(gl.createVertexArray());
 const fbo=gl.createFramebuffer(),results=[],failures=[];
 const align=n=>Math.ceil(n/256)*256;
 const sleep=()=>new Promise(r=>setTimeout(r,0));
 const floatBits=new Float32Array(1),uintBits=new Uint32Array(floatBits.buffer);
 function toHalf(value){
  floatBits[0]=value;
  const bits=uintBits[0],sign=(bits>>>16)&0x8000,exp=((bits>>>23)&255)-127+15,m=bits&0x7fffff;
  if(exp>=31)return sign|0x7c00|(m?0x200:0);
  if(exp<=0){
   if(exp< -10)return sign;
   const mant=m|0x800000,shift=14-exp,base=mant>>>shift,remainder=mant&((1<<shift)-1),mid=1<<(shift-1);
   return sign|(base+(remainder>mid||(remainder===mid&&(base&1))?1:0));
  }
  const base=(exp<<10)|(m>>>13),remainder=m&8191;
  return sign|(base+(remainder>4096||(remainder===4096&&(base&1))?1:0));
 }
 function unpackHalf(data){return Float32Array.from(data,x=>VENeuralSpec.halfToFloat(x));}
 function pattern(w,h,seed=0){
  const a=new Uint8Array(w*h*4);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
   const i=(y*w+x)*4;
   a[i]=Math.round(125+54*Math.sin(x*.071+seed*.7)+22*Math.cos(y*.09));
   a[i+1]=Math.round(120+48*Math.cos(x*.043+y*.061+seed*.4));
   a[i+2]=Math.round(125+51*Math.sin(y*.057-x*.035+seed*.5));a[i+3]=255;
  }
  return a;
 }
 function tensorData(t,seed){
  let state=(seed+1)*0x123457;const a=new Uint16Array(t.tw*t.th*4);
  for(let i=0;i<a.length;i++){
   state=Math.imul(state^state>>>15,2246822519);state^=state>>>13;
   a[i]=toHalf(((state>>>0)/4294967296-.5)*.35);
  }
  return a;
 }
 function putChannel(data,t,x,y,c,value){
  const group=Math.floor(c/4),px=x+(group%t.cols)*t.w,py=y+Math.floor(group/t.cols)*t.h;
  data[(py*t.tw+px)*4+c%4]=toHalf(value);
 }
 function glTexture(w,h,format,data){
  const texture=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,texture);
  const image=format==='rgba8unorm',fp32=format==='rgba32float';
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,image?gl.LINEAR:gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,image?gl.LINEAR:gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D,0,image?gl.RGBA8:fp32?gl.RGBA32F:gl.RGBA16F,w,h,0,gl.RGBA,image?gl.UNSIGNED_BYTE:fp32?gl.FLOAT:gl.HALF_FLOAT,data);
  return texture;
 }
 function gpuTexture(w,h,format,data){
  const texture=device.createTexture({size:[w,h],format,usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.STORAGE_BINDING|GPUTextureUsage.COPY_SRC|GPUTextureUsage.COPY_DST});
  if(data){
   const row=w*4*data.BYTES_PER_ELEMENT,pitch=align(row),bytes=new Uint8Array(pitch*h);
   const source=new Uint8Array(data.buffer,data.byteOffset,data.byteLength);
   for(let y=0;y<h;y++)bytes.set(source.subarray(y*row,(y+1)*row),y*pitch);
   device.queue.writeTexture({texture},bytes,{bytesPerRow:pitch,rowsPerImage:h},[w,h]);
  }
  return texture;
 }
 function pair(w,h,format,data){return {w,h,format,gl:glTexture(w,h,format,data),gpu:gpuTexture(w,h,format,data)};}
 function externalPair(w,h,data){
  const source=document.createElement('canvas');source.width=w;source.height=h;
  const context=source.getContext('2d');
  context.putImageData(new ImageData(new Uint8ClampedArray(data),w,h),0,0);
  const frame=new VideoFrame(source,{timestamp:0});
  try{
   const gpu=device.importExternalTexture({source:frame,colorSpace:'srgb'});
   // Alter the originating canvas after taking the immutable frame snapshot.
   // The retained frame must keep the original pixels through asynchronous work.
   context.fillStyle='#ff00ff';context.fillRect(0,0,w,h);
   return {w,h,format:'rgba8unorm',gl:glTexture(w,h,'rgba8unorm',data),gpu,frame};
  }catch(error){frame.close();throw error;}
 }
 function release(resource){gl.deleteTexture(resource.gl);resource.gpu.destroy?.();resource.frame?.close();}
 function compileGL(source){
  const shaders=[];let program;
  try{
   for(const [type,code]of [[gl.VERTEX_SHADER,G.VERT],[gl.FRAGMENT_SHADER,source]]){
    const shader=gl.createShader(type);shaders.push(shader);gl.shaderSource(shader,code);gl.compileShader(shader);
    if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS))throw new Error('GL reference compile: '+gl.getShaderInfoLog(shader));
   }
   program=gl.createProgram();for(const shader of shaders)gl.attachShader(program,shader);gl.linkProgram(program);
   if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error('GL reference link: '+gl.getProgramInfoLog(program));
   return program;
  }catch(error){if(program)gl.deleteProgram(program);throw error;}
  finally{for(const shader of shaders)gl.deleteShader(shader);}
 }
 async function runGL(source,resources,uniforms,width,height,format){
  const output=glTexture(width,height,format,null),program=compileGL(source);
  try{
   gl.useProgram(program);let unit=0;
   for(const [name,resource]of Object.entries(resources)){
    gl.activeTexture(gl.TEXTURE0+unit);gl.bindTexture(gl.TEXTURE_2D,resource.gl);
    gl.uniform1i(gl.getUniformLocation(program,name),unit++);
   }
   for(const [name,{type,value}]of Object.entries(uniforms)){
    const location=gl.getUniformLocation(program,name);
    if(type==='2i')gl.uniform2i(location,...value);else if(type==='2f')gl.uniform2f(location,...value);
    else if(type==='1i')gl.uniform1i(location,value);else gl.uniform1f(location,value);
   }
   gl.bindFramebuffer(gl.FRAMEBUFFER,fbo);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,output,0);
   if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw new Error('GL reference framebuffer incomplete');
   gl.viewport(0,0,width,height);gl.drawArrays(gl.TRIANGLES,0,3);
   const bytes=format==='rgba8unorm',out=bytes?new Uint8Array(width*height*4):new Float32Array(width*height*4);
   gl.readPixels(0,0,width,height,gl.RGBA,bytes?gl.UNSIGNED_BYTE:gl.FLOAT,out);
   const error=gl.getError();if(error!==gl.NO_ERROR)throw new Error('GL reference error '+error);
   return bytes?Float32Array.from(out,x=>x/255):out;
  }finally{gl.deleteProgram(program);gl.deleteTexture(output);}
 }
 function packedUniforms(size,active,width,height,debug=0){
  const data=new ArrayBuffer(48),u32=new Uint32Array(data),f32=new Float32Array(data);
  u32.set([...size,...active,0,0,width,height]);f32[8]=.375;u32[9]=debug;u32.set([width,height],10);
  return data;
 }
 async function runGPU(desc,resources,data,width,height,format,dispatch={}){
  const bufferOutput=format==='buffer',output=bufferOutput?device.createBuffer({size:16,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC}):gpuTexture(width,height,format,null);
  const values=new Uint32Array(data),regions=dispatch.regions||[{x:0,y:0,w:desc.tiled?values[0]:width,h:desc.tiled?values[1]:height}];
  if(desc.config!==undefined)values[9]=desc.config;
  if(desc.convLayout){values.set(desc.convLayout.active,2);values.set(desc.convLayout.outputSize,10);}
  if(desc.concatLayout){values.set(desc.concatLayout.active,2);values.set(desc.concatLayout.outputSize,10);}
  if(desc.readerLayout){values.set(desc.readerLayout.active,2);values.set(desc.readerLayout.outputSize,10);}
  if(desc.tiled&&!dispatch.groups)throw new Error('Tiled convolution requires its exact output channel-group count');
  const uniform=device.createBuffer({size:regions.length*256,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
  const scratch=desc.scratchBytes?device.createBuffer({size:desc.scratchBytes,usage:GPUBufferUsage.STORAGE}):null;
  let readback;device.pushErrorScope('validation');
  try{
   for(let i=0;i<regions.length;i++){
    const packed=data.slice(0),view=new Uint32Array(packed),region=regions[i];
    view.set([region.x,region.y,region.w,region.h],4);device.queue.writeBuffer(uniform,i*256,packed);
   }
   const descriptors=desc.stage?[desc.stage,desc]:[desc];
   if(desc.stage&&(!Number.isInteger(desc.stageGroups)||desc.stageGroups<1))throw new Error('Staged convolution requires its exact input channel-group count');
   const modules=descriptors.map(descriptor=>device.createShaderModule({code:descriptor.code,label:descriptor.label||'conformance shader'}));
   const infos=await Promise.all(modules.map(module=>module.getCompilationInfo()));
   const compilationErrors=infos.flatMap((info,index)=>info.messages.filter(message=>message.type==='error').map(message=>
    `${descriptors[index].label|| (index===0&&desc.stage?'stage':'main')}:${message.lineNum}:${message.linePos} ${message.message}`));
   if(compilationErrors.length)throw new Error(compilationErrors.join('\n'));
   const programs=await Promise.all(descriptors.map(async(descriptor,index)=>{
    const entries=descriptor.bindings.map(b=>({binding:b.binding,visibility:GPUShaderStage.COMPUTE,
     ...(b.kind==='uniform'?{buffer:{type:'uniform',minBindingSize:48}}:
      b.kind==='texture'?{texture:{sampleType:'unfilterable-float'}}:
      b.kind==='filterable-texture'?{texture:{sampleType:'float'}}:
       b.kind==='external-texture'?{externalTexture:{}}:
        b.kind==='sampler'?{sampler:{type:'filtering'}}:
         b.kind==='storage-buffer'?{buffer:{type:'storage'}}:{storageTexture:{access:'write-only',format:b.format}})}));
    const layout=device.createBindGroupLayout({entries});
    const pipeline=await device.createComputePipelineAsync({layout:device.createPipelineLayout({bindGroupLayouts:[layout]}),compute:{module:modules[index],entryPoint:'main'}});
    return {descriptor,layout,pipeline};
   }));
   const stageProgram=desc.stage?programs[0]:null,mainProgram=programs.at(-1);
   const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();
   for(let i=0;i<regions.length;i++){
    const region=regions[i];
    const bind=program=>device.createBindGroup({layout:program.layout,entries:program.descriptor.bindings.map(b=>({binding:b.binding,
     resource:b.kind==='uniform'?{buffer:uniform,offset:i*256,size:48}:b.name==='output'?(bufferOutput?{buffer:output}:output.createView()):
      b.name==='scratch'?{buffer:scratch}:b.kind==='sampler'?imageSampler:b.kind==='external-texture'?resources[b.name].gpu:resources[b.name].gpu.createView()}))});
    if(stageProgram){pass.setPipeline(stageProgram.pipeline);pass.setBindGroup(0,bind(stageProgram));
     pass.dispatchWorkgroups(Math.ceil(region.w/8),Math.ceil(region.h/8),desc.stageGroups);}
    pass.setPipeline(mainProgram.pipeline);pass.setBindGroup(0,bind(mainProgram));
    pass.dispatchWorkgroups(bufferOutput?1:Math.ceil(region.w/8),bufferOutput?1:Math.ceil(region.h/8),desc.tiled?dispatch.groups:1);
   }
   pass.end();
   const row=width*(format==='rgba8unorm'?4:8),pitch=align(row),readSize=bufferOutput?16:pitch*height;
   readback=device.createBuffer({size:readSize,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
   if(bufferOutput)encoder.copyBufferToBuffer(output,0,readback,0,16);
   else encoder.copyTextureToBuffer({texture:output},{buffer:readback,bytesPerRow:pitch,rowsPerImage:height},[width,height]);
   device.queue.submit([encoder.finish()]);await readback.mapAsync(GPUMapMode.READ);
   const copied=readback.getMappedRange().slice(0);readback.unmap();
   if(bufferOutput)return new Float32Array(copied);
   const packed=new Uint8Array(row*height),bytes=new Uint8Array(copied);
   for(let y=0;y<height;y++)packed.set(bytes.subarray(y*pitch,y*pitch+row),y*row);
   return format==='rgba8unorm'?Float32Array.from(packed,x=>x/255):unpackHalf(new Uint16Array(packed.buffer));
  }finally{
   const validation=await device.popErrorScope();
   readback?.destroy();scratch?.destroy();uniform.destroy();output.destroy();
   if(validation)throw new Error('WebGPU validation: '+validation.message);
  }
 }
 function compare(name,actual,expected,kind='half'){
  if(actual.length!==expected.length)throw new Error(name+': readback lengths differ');
  let max=0,sum=0,square=0,meanReference=0,maxReference=0,violations=0,peakNormalized=0,nonfinite=0,worst=-1;
  for(let i=0;i<actual.length;i++){
   if(!Number.isFinite(actual[i])||!Number.isFinite(expected[i])){nonfinite++;continue;}
   const error=Math.abs(actual[i]-expected[i]),magnitude=Math.abs(expected[i]);
   const allowance=kind==='byte'?2/255:kind==='stats'?[.0002,1/256,1/256,0][i]:.0015+.002*magnitude;
   const normalized=error/(allowance||Number.EPSILON);
   if(error>max){max=error;worst=i;}if(error>allowance+1e-8)violations++;
   peakNormalized=Math.max(peakNormalized,normalized);sum+=error;square+=error*error;
   meanReference+=magnitude;maxReference=Math.max(maxReference,magnitude);
  }
  const mean=sum/actual.length,meanAllowance=kind==='byte'?.25/255:kind==='stats'?1:.0003+.0005*meanReference/actual.length;
  const result={name,values:actual.length,max,mean,rms:Math.sqrt(square/actual.length),maxReference,violations,nonfinite,peakNormalized,worst,
   ...(worst>=0?{expected:expected[worst],actual:actual[worst]}:{}),passed:!nonfinite&&!violations&&mean<=meanAllowance};
  results.push(result);if(!result.passed)failures.push(name);return result;
 }
 async function check(name,task){
  try{await task();}catch(error){results.push({name,passed:false,error:String(error?.stack||error)});failures.push(name);}
  console.log('conformance '+name+': '+(results.at(-1)?.passed?'PASS':'FAIL'));await sleep();
 }
 async function operation(name,op,index,{externalSource=false}={}){
  const resources={},owned=[],bases=new Map();
  try{
   op.inputs.forEach((t,i)=>{
    const base=G.baseOf(t);let resource=bases.get(base);
    if(!resource){
     const data=tensorData(base,index*19+i);
     // Wide fractional flows exercise interpolation and both clamped borders.
     if(op.type==='warp'&&i===1)for(let y=0;y<base.h;y++)for(let x=0;x<base.w;x++){
      putChannel(data,base,x,y,t.offset||0,((x%7)-3)*1.31);
      putChannel(data,base,x,y,(t.offset||0)+1,((y%5)-2)*1.17);
     }
     if(op.type==='head')for(let y=0;y<base.h;y++)for(let x=0;x<base.w;x++){
      putChannel(data,base,x,y,t.offset||0,[-30,-20,-1,0,1,20,30][(x+y)%7]);
     }
     resource=pair(base.tw,base.th,'rgba16float',data);owned.push(resource);bases.set(base,resource);
    }
    resources['s'+i]=resource;
   });
   if(op.layer){const packed=G.packLayer(op.layer);resources.weights=pair(packed.width,packed.height,'rgba32float',packed.data);owned.push(resources.weights);}
   if(op.type==='preprocess'){
    resources.source=externalSource?externalPair(83,47,pattern(83,47)):pair(83,47,'rgba8unorm',pattern(83,47));owned.push(resources.source);
   }
   if(externalSource)await new Promise(resolve=>setTimeout(resolve,40));
   const uniforms={tensorSize:{type:'2i',value:[op.out.w,op.out.h]},phase:{type:'1f',value:.375},activeSize:{type:'2f',value:[53,25]}};
   op.inputs.forEach((t,i)=>{const b=G.baseOf(t);uniforms['s'+i+'Size']={type:'2i',value:[b.w,b.h]};});
   // Same taps and accumulation order; only the loop bound is runtime-derived
   // to avoid excessive native GL compilation in this development reference.
   let source=G.makeShader(op);
   if(op.layer)source=source.replace(`ic<${op.layer.ci};ic+=4`,`ic<(textureSize(weights,0).x-2)/${op.layer.k*op.layer.k};ic+=4`);
   const expected=await runGL(source,resources,uniforms,op.out.tw,op.out.th,'rgba16float');
   const desc=S.operation(op,{externalSource,tiled,compact,generic,storageTiles,genericStorage,stagedStorage,filteredSources,genericConcat,genericFlow}),dispatch=desc.tiled?{groups:op.out.groups}:{};
   if(desc.tiled&&desc.convLayout&&!op.residual)resources.s1=resources.s0;
   if(desc.concatLayout)for(let i=op.inputs.length;i<5;i++)resources['s'+i]=resources.s0;
   // Use multiple dispatches with aligned nonzero origins. Final workgroups
   // include partial edges, whose inactive threads must still reach barriers.
   if(desc.tiled&&op.out.w>8)dispatch.regions=[{x:0,y:0,w:8,h:op.out.h},{x:8,y:0,w:op.out.w-8,h:op.out.h}];
   const actual=await runGPU(desc,resources,packedUniforms([op.out.w,op.out.h],[53,25],op.out.tw,op.out.th),op.out.tw,op.out.th,'rgba16float',dispatch);
   compare(name,actual,expected);
  }finally{for(const resource of owned)release(resource);}
 }
 try{
  const encoded=G.encoder(model,{w:64,h:32}),decoded=G.decoder(model,encoded.features,encoded.features);
  const ops=[...encoded.graph.ops,...decoded.graph.ops];
  for(let i=0;i<ops.length;i++)await check(`graph-${String(i).padStart(2,'0')}-${ops[i].type}`,()=>operation(`graph-${String(i).padStart(2,'0')}-${ops[i].type}`,ops[i],i));
  await check('external-preprocess',()=>operation('external-preprocess',ops[0],0,{externalSource:true}));
  const odd=new G.Graph();odd.conv(odd.tensor(7,5,3),model.encoder[0],2);
  odd.conv(odd.tensor(5,3,72),model.decoder[3].up,2,null,true);
  odd.conv(odd.tensor(9,5,24),model.encoder[1]);
  // Exercise each unaligned convolution shuffle across an atlas row boundary.
  for(const shift of [1,2,3])odd.conv(G.view(odd.tensor(7,5,27),8+shift,3),model.encoder[0],2);
  const base=odd.tensor(9,5,54),nested=G.view(G.view(base,29,24),2,9);
  odd.concat([nested,G.view(base,1,7),G.view(base,50,4)]);
  // Shared concat also handles one/four inputs and every output lane tail.
  for(let count=1;count<=5;count++)odd.concat(Array.from({length:count},(_,i)=>G.view(odd.tensor(9,5,12),4+i%4,i===4?5:1)));
  // Misaligned vector readers must shuffle across atlas columns and preserve
  // partial channel tails; the trained graph already covers remainder two.
  odd.warp(G.view(odd.tensor(9,5,12),1,7),odd.tensor(9,5,2));
  odd.warp(G.view(odd.tensor(9,5,12),3,5),G.view(odd.tensor(9,5,6),3,2));
  for(let i=0;i<odd.ops.length;i++)await check('edge-'+i+'-'+odd.ops[i].type,()=>operation('edge-'+i+'-'+odd.ops[i].type,odd.ops[i],100+i));
  const flow=G.layout(64,32,4),raw=G.layout(64,32,4),flowData=tensorData(flow,71),rawData=tensorData(raw,72);
  for(let y=0;y<32;y++)for(let x=0;x<64;x++)for(let c=0;c<4;c++){
   putChannel(flowData,flow,x,y,c,(Math.sin((x+c*7)*.17+y*.13))*4.3);
   putChannel(rawData,raw,x,y,c,c===0?1/(1+Math.exp(-(x-32)*.13)):Math.sin(x*.1+y*.2+c)*.035);
  }
  const shared={flow:pair(flow.tw,flow.th,'rgba16float',flowData),raw:pair(raw.tw,raw.th,'rgba16float',rawData),
   prev:pair(83,47,'rgba8unorm',pattern(83,47,0)),curr:pair(83,47,'rgba8unorm',pattern(83,47,1))};
  try{
   for(let debug=0;debug<4;debug++)await check('synth-debug-'+debug,async()=>{
    const expected=await runGL(G.synthShader(flow,raw),shared,{flowSize:{type:'2i',value:[64,32]},rawSize:{type:'2i',value:[64,32]},
     outputSize:{type:'2f',value:[79,43]},activeSize:{type:'2f',value:[53,25]},debugMode:{type:'1i',value:debug}},79,43,'rgba8unorm');
    const actual=await runGPU(S.synth(flow,raw,{filteredSources}),shared,packedUniforms([64,32],[53,25],79,43,debug),79,43,'rgba8unorm');
    compare('synth-debug-'+debug,actual,expected,'byte');
   });
   for(const [name,curr]of [['same',shared.prev],['changed',shared.curr]])await check('stats-'+name,async()=>{
    const resources={prev:shared.prev,curr};
    const expected=await runGL(G.STATS,resources,{sampleSize:{type:'2i',value:[16,16]}},1,1,'rgba32float');
    const actual=await runGPU(S.stats({filteredSources}),resources,packedUniforms([16,16],[83,47],1,1),1,1,'buffer');
    compare('stats-'+name,actual,expected,'stats');
   });
   await check('stats-cut',async()=>{
    const white=new Uint8Array(83*47*4);white.fill(255);
    const black=new Uint8Array(83*47*4);for(let i=3;i<black.length;i+=4)black[i]=255;
    const resources={prev:pair(83,47,'rgba8unorm',black),curr:pair(83,47,'rgba8unorm',white)};
    try{
     const expected=await runGL(G.STATS,resources,{sampleSize:{type:'2i',value:[16,16]}},1,1,'rgba32float');
     const actual=await runGPU(S.stats({filteredSources}),resources,packedUniforms([16,16],[83,47],1,1),1,1,'buffer');
     compare('stats-cut',actual,expected,'stats');
    }finally{Object.values(resources).forEach(release);}
   });
   async function withExternalImages(task){
    const images={};
    try{
     images.prev=externalPair(83,47,pattern(83,47,0));images.curr=externalPair(83,47,pattern(83,47,1));
     await new Promise(resolve=>setTimeout(resolve,40));await task(images);
    }finally{Object.values(images).forEach(release);}
   }
   await check('external-synth',()=>withExternalImages(async externalImages=>{
     const resources={flow:shared.flow,raw:shared.raw,...externalImages};
     const expected=await runGL(G.synthShader(flow,raw),resources,{flowSize:{type:'2i',value:[64,32]},rawSize:{type:'2i',value:[64,32]},
      outputSize:{type:'2f',value:[79,43]},activeSize:{type:'2f',value:[53,25]},debugMode:{type:'1i',value:0}},79,43,'rgba8unorm');
     const actual=await runGPU(S.synth(flow,raw,{externalSource:true}),resources,packedUniforms([64,32],[53,25],79,43),79,43,'rgba8unorm');
     compare('external-synth',actual,expected,'byte');
   }));
   await check('external-stats',()=>withExternalImages(async externalImages=>{
     const expected=await runGL(G.STATS,externalImages,{sampleSize:{type:'2i',value:[16,16]}},1,1,'rgba32float');
     const actual=await runGPU(S.stats({externalSource:true}),externalImages,packedUniforms([16,16],[83,47],1,1),1,1,'buffer');
     compare('external-stats',actual,expected,'stats');
   }));
  }finally{Object.values(shared).forEach(release);}
  if(gpuErrors.length)failures.push('uncaptured WebGPU errors');
  return {adapter:adapter.info?{vendor:adapter.info.vendor,architecture:adapter.info.architecture,device:adapter.info.device,description:adapter.info.description}:null,
   fixture:'trained bundled IFRNet-S, padded64x32, deterministic identical half inputs',convolution:stagedStorage?'storage-staged':storageTiles?(genericStorage?'storage-generic':compact?'storage-compact':'storage-tiled'):generic?'scalar-generic':tiled?(compact?'shared-compact':'shared-tiled'):(compact?'scalar-compact':'scalar-dynamic'),tolerances:{half:'max <= .0015 + .002*abs(reference); mean <= .0003 + .0005*mean(abs(reference))',byte:'max <= 2/255; mean <= .25/255',stats:'MAD <= .0002; histogram/changed <= 1/256; alpha exact'},
   shaderOptions:{externalSource:false,tiled,compact,generic,storageTiles,genericStorage,stagedStorage,filteredSources,genericConcat,genericFlow},results,failures,gpuErrors,passed:!failures.length};
 }finally{gl.deleteFramebuffer(fbo);gl.getExtension('WEBGL_lose_context')?.loseContext();device.destroy();}
}

(async()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'ifrnet-conformance-'));
 let browser,server;
 try{
  const allowed=new Set(['models/ifrnet.bin','neural/model-spec.js','neural/graph.js','neural/webgpu-shaders.js']);
  server=http.createServer((req,res)=>{
   const name=req.url?.slice(1);
   if(allowed.has(name)){res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':'application/octet-stream');res.end(fs.readFileSync(path.join(root,name)));}
   else if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>IFRNet WebGPU conformance</title><body>GPU conformance test</body>');}
   else{res.statusCode=404;res.end();}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  browser=await puppeteer.launch({browser:kind==='firefox'?'firefox':'chrome',
   headless:process.env.HEADLESS?process.env.HEADLESS!=='0':kind!=='firefox',userDataDir:temp,
   executablePath:kind==='firefox'?(process.env.FIREFOX_PATH||'C:/Program Files/Mozilla Firefox/firefox.exe'):
    (process.env.CHROMIUM_PATH||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'),
   defaultViewport:{width:800,height:450},timeout:60000,protocolTimeout:300000});
  const page=await browser.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(message.text().startsWith('conformance '))console.log(message.text());});
  await page.bringToFront();await page.goto(`http://127.0.0.1:${server.address().port}/`);
  for(const file of ['neural/model-spec.js','neural/graph.js','neural/webgpu-shaders.js'])await page.addScriptTag({url:'/'+file});
  const stagedStorage=process.env.IFRNET_STAGED_STORAGE==='1',genericStorage=stagedStorage||process.env.IFRNET_GENERIC_STORAGE==='1',storageTiles=genericStorage||process.env.IFRNET_STORAGE_TILES==='1',generic=!storageTiles&&process.env.IFRNET_GENERIC==='1';
  const result=await page.evaluate(conformance,{tiled:storageTiles||!generic&&process.env.IFRNET_TILED!=='0',compact:genericStorage||generic||process.env.IFRNET_COMPACT==='1',generic,storageTiles,genericStorage,stagedStorage,filteredSources:process.env.IFRNET_FILTERED_SOURCES==='1',genericConcat:process.env.IFRNET_GENERIC_CONCAT==='1',genericFlow:process.env.IFRNET_GENERIC_FLOW==='1'});
  console.log(JSON.stringify({browser:await browser.version(),...result,pageErrors:errors},null,2));
  assert.deepEqual(errors,[],'browser page errors');assert.ok(result.passed,'Shader conformance failures: '+result.failures.join(', '));
 }finally{
  try{await browser?.close();}finally{
   if(server?.listening)await new Promise(resolve=>server.close(resolve));
   const target=fs.realpathSync(temp),parent=fs.realpathSync(os.tmpdir());
   assert.equal(path.dirname(target),parent);assert.ok(path.basename(target).startsWith('ifrnet-conformance-'));
   fs.rmSync(target,{recursive:true,force:true});
  }
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
