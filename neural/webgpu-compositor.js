/* GPU-only spatial presentation for the IFRNet WebGPU path.
 * RAVU math is a port of third_party/ravu-lite/ravu-lite-webgl2.js, upstream
 * 3f24e7c53085854d122bb5d6629d1d503ba29e35, LGPL-3.0-or-later; see its LICENSE.
 * RCAS is the existing AMD FidelityFX adaptation (MIT), see THIRD_PARTY_NOTICES.
 */
(function(root){
'use strict';
const LIMIT=96*1024*1024,MAX_SHAPES=2,MAX_PENDING=4,LUT_W=13,LUT_H=288;
const U=`struct Uniforms { sourceSize:vec2<u32>, outputSize:vec2<u32>, strength:f32, compare:u32, gradientCount:u32, protectNoise:u32 };\n@group(0) @binding(0) var<uniform> u:Uniforms;\n`;
const SOURCE=`@group(0) @binding(1) var source:texture_2d<f32>;
fn loadSource(p:vec2<i32>)->vec4<f32>{let size=vec2<i32>(textureDimensions(source));return textureLoad(source,clamp(p,vec2<i32>(0),size-1),0);}
fn sampleSource(uv:vec2<f32>)->vec4<f32>{let p=uv*vec2<f32>(textureDimensions(source))-0.5;let b=vec2<i32>(floor(p));let f=fract(p);return mix(mix(loadSource(b),loadSource(b+vec2<i32>(1,0)),f.x),mix(loadSource(b+vec2<i32>(0,1)),loadSource(b+vec2<i32>(1,1)),f.x),f.y);}
fn luma(rgb:vec3<f32>)->f32{return dot(rgb,vec3<f32>(0.2126,0.7152,0.0722));}
fn loadLuma(p:vec2<i32>)->f32{return luma(loadSource(p).rgb);}
`;
const COMPARE=`@group(0) @binding(2) var comparison:texture_2d<f32>;
fn comparisonLoad(p:vec2<i32>)->vec4<f32>{let size=vec2<i32>(textureDimensions(comparison));return textureLoad(comparison,clamp(p,vec2<i32>(0),size-1),0);}
fn comparisonSample(uv:vec2<f32>)->vec3<f32>{let p=uv*vec2<f32>(textureDimensions(comparison))-0.5;let b=vec2<i32>(floor(p));let f=fract(p);return mix(mix(comparisonLoad(b),comparisonLoad(b+vec2<i32>(1,0)),f.x),mix(comparisonLoad(b+vec2<i32>(0,1)),comparisonLoad(b+vec2<i32>(1,1)),f.x),f.y).rgb;}
`;
const START=`@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) gid:vec3<u32>){if(any(gid.xy>=u.outputSize)){return;}let q=vec2<i32>(gid.xy);let uv=(vec2<f32>(gid.xy)+0.5)/vec2<f32>(u.outputSize);`;
function copyCode(external){return U+`@group(0) @binding(1) var image:${external?'texture_external':'texture_2d<f32>'};
@group(0) @binding(2) var output:texture_storage_2d<rgba8unorm,write>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) gid:vec3<u32>){if(any(gid.xy>=u.sourceSize)){return;}let p=vec2<i32>(gid.xy);let rgb=textureLoad(image,p${external?'':',0'}).rgb;textureStore(output,p,vec4<f32>(rgb,1.0));}`;}
const CLASSIFY=U+SOURCE+`@group(0) @binding(2) var output:texture_storage_2d<rgba8unorm,write>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) gid:vec3<u32>){
 if(any(gid.xy>=u.sourceSize)){return;}let base=vec2<i32>(gid.xy);var abd=vec3<f32>(0.0);
 for(var gradient=0u;gradient<u.gradientCount;gradient++){
  let offset=vec2<i32>(i32(gradient/3u)-1,i32(gradient%3u)-1);let center=base+offset;
  let gx=(loadLuma(center+vec2<i32>(1,0))-loadLuma(center-vec2<i32>(1,0)))/2.0;
  let gy=(loadLuma(center+vec2<i32>(0,1))-loadLuma(center-vec2<i32>(0,1)))/2.0;
  var weight=0.1018680644198163;if(offset.x==0||offset.y==0){weight=0.11543163961422666;}if(gradient==4u){weight=0.13080118386382833;}
  abd+=vec3<f32>(gx*gx,gx*gy,gy*gy)*weight;
 }
 let a=abd.x;let b=abd.y;let d=abd.z;let T=a+d;let D=a*d-b*b;
 let delta=sqrt(max(T*T/4.0-D,0.0));let L1=T/2.0+delta;let L2=T/2.0-delta;
 let sqrtL1=sqrt(L1);let sqrtL2=sqrt(L2);var theta=0.0;
 if(abs(b)>=1.192092896e-7){let t=atan2(L1-a,b)+3.141592653589793;theta=t-floor(t/3.141592653589793)*3.141592653589793;}
 let lambda=sqrtL1;var mu=0.0;if(sqrtL1+sqrtL2>=1.192092896e-7){mu=(sqrtL1-sqrtL2)/(sqrtL1+sqrtL2);}
 let angle=floor(theta*24.0/3.141592653589793);
 let strength=select(select(0.0,1.0,lambda>=0.004),select(2.0,3.0,lambda>=0.05),lambda>=0.016);
 let coherence=select(select(0.0,1.0,mu>=0.25),2.0,mu>=0.5);
 let row=clamp((angle*4.0+strength)*3.0+coherence,0.0,287.0);
 textureStore(output,base,vec4<f32>((row-floor(row/256.0)*256.0)/255.0,floor(row/256.0)/255.0,0.0,1.0));
}`;
const FILTER=U+SOURCE+`@group(0) @binding(2) var classification:texture_2d<f32>;
@group(0) @binding(3) var lut:texture_2d<f32>;
@group(0) @binding(4) var output:texture_storage_2d<rgba16float,write>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) gid:vec3<u32>){
 if(any(gid.xy>=u.sourceSize)){return;}
 // Preserve the existing flipped step-1 framebuffer and its subpixel ordering.
 let base=vec2<i32>(i32(gid.x),i32(u.sourceSize.y-1u-gid.y));
 var res=vec4<f32>(0.0);var lo=vec4<f32>(0.0);var hi=vec4<f32>(0.0);var lo2=vec4<f32>(0.0);var hi2=vec4<f32>(0.0);
 let bytes=round(textureLoad(classification,base,0).rg*255.0);let row=clamp(i32(bytes.r)+i32(bytes.g)*256,0,i32(textureDimensions(lut).y)-1);
 for(var tap=0u;tap<textureDimensions(lut).x;tap++){
  let offset=vec2<i32>(i32(tap/5u)-2,i32(tap%5u)-2);let nearLuma=loadLuma(base+offset);var farLuma=nearLuma;
  if(tap<12u){farLuma=loadLuma(base-offset);}let w=textureLoad(lut,vec2<i32>(i32(tap),row),0);
  if(tap==12u){res+=nearLuma*w;}else{res+=nearLuma*w+farLuma*w.wzyx;}
  if(tap==2u||tap==6u||tap==7u||tap==8u||tap==10u||tap==11u||tap==12u){
   let wg=max(vec4<f32>(0.0),w);var cg4=vec4<f32>(0.1+nearLuma,1.1-nearLuma,0.1+farLuma,1.1-farLuma);let cg4_1=cg4;
   cg4*=cg4;cg4*=cg4;cg4*=cg4;cg4*=cg4;cg4*=cg4;
   if(tap==12u){hi+=cg4.x*wg;lo+=cg4.y*wg;}else{hi+=cg4.x*wg+cg4.z*wg.wzyx;lo+=cg4.y*wg+cg4.w*wg.wzyx;}
   cg4*=cg4_1;
   if(tap==12u){hi2+=cg4.x*wg;lo2+=cg4.y*wg;}else{hi2+=cg4.x*wg+cg4.z*wg.wzyx;lo2+=cg4.y*wg+cg4.w*wg.wzyx;}
  }
 }
 lo=vec4<f32>(1.1)-lo2/lo;hi=hi2/hi-vec4<f32>(0.1);res=mix(res,clamp(res,lo,hi),0.8);
 textureStore(output,vec2<i32>(gid.xy),res);
}`;
const COMPOSE=U+SOURCE+COMPARE+`@group(0) @binding(3) var packed:texture_2d<f32>;
@group(0) @binding(4) var output:texture_storage_2d<rgba8unorm,write>;
fn fetchRavu(pixel:vec2<i32>)->f32{let p=clamp(pixel,vec2<i32>(0),vec2<i32>(u.sourceSize)*2-1);let pp=p/2;let parity=p-pp*2;return textureLoad(packed,pp,0)[u32(parity.x*2+parity.y)];}
fn sampleRavu(uv:vec2<f32>)->f32{let p=uv*vec2<f32>(u.sourceSize*2u)-0.5;let b=vec2<i32>(floor(p));let f=fract(p);return mix(mix(fetchRavu(b),fetchRavu(b+vec2<i32>(1,0)),f.x),mix(fetchRavu(b+vec2<i32>(0,1)),fetchRavu(b+vec2<i32>(1,1)),f.x),f.y);}
`+START+`
 var rgb=sampleSource(uv).rgb;
 if(u.compare!=0u&&abs(uv.x-0.5)<1.5/f32(u.outputSize.x)){rgb=vec3<f32>(0.0,1.0,0.53);}
 else if(u.compare!=0u&&uv.x<0.5){rgb=comparisonSample(uv);}
 else{let enhancedLuma=sampleRavu(vec2<f32>(uv.x,1.0-uv.y));rgb=clamp(rgb+vec3<f32>(enhancedLuma-luma(rgb)),vec3<f32>(0.0),vec3<f32>(1.0));}
 textureStore(output,q,vec4<f32>(rgb,1.0));}`;
function directCode(native=false){return U+SOURCE+COMPARE+`@group(0) @binding(3) var output:texture_storage_2d<rgba8unorm,write>;
`+START+`
 let texel=vec2<f32>(1.0)/vec2<f32>(textureDimensions(source));var rgb=sampleSource(uv).rgb;
 if(u.compare!=0u&&abs(uv.x-0.5)<1.5*texel.x){rgb=vec3<f32>(0.0,1.0,0.53);}
 else if(u.compare!=0u&&uv.x<0.5){rgb=comparisonSample(uv);}
 ${native?'':`else if(u.strength>0.0){
  let b=sampleSource(uv+vec2<f32>(0.0,-texel.y)).rgb;let d=sampleSource(uv+vec2<f32>(-texel.x,0.0)).rgb;
  let e=rgb;let f=sampleSource(uv+vec2<f32>(texel.x,0.0)).rgb;let h=sampleSource(uv+vec2<f32>(0.0,texel.y)).rgb;
  let mn4=min(min(b,d),min(f,h));let mx4=max(max(b,d),max(f,h));
  let hitMin=min(mn4,e)/max(4.0*mx4,vec3<f32>(1e-4));let hitMax=(vec3<f32>(1.0)-max(mx4,e))/min(4.0*mn4-vec3<f32>(4.0),vec3<f32>(-1e-4));
  let lobeRgb=max(-hitMin,hitMax);var lobe=max(-0.1875,min(max(lobeRgb.r,max(lobeRgb.g,lobeRgb.b)),0.0));lobe*=u.strength;
  if(u.protectNoise!=0u){
   let bL=b.b*0.5+(b.r*0.5+b.g);let dL=d.b*0.5+(d.r*0.5+d.g);let eL=e.b*0.5+(e.r*0.5+e.g);
   let fL=f.b*0.5+(f.r*0.5+f.g);let hL=h.b*0.5+(h.r*0.5+h.g);
   let highpass=0.25*bL+0.25*dL+0.25*fL+0.25*hL-eL;
   let range=max(max(max(bL,dL),eL),max(fL,hL))-min(min(min(bL,dL),eL),min(fL,hL));
   lobe*=1.0-0.5*clamp(abs(highpass)/max(range,1e-4),0.0,1.0);
  }
  rgb=(lobe*(b+d+f+h)+e)/(4.0*lobe+1.0);
 }`}
 textureStore(output,q,vec4<f32>(rgb,1.0));}`;}
const BLIT=`@group(0) @binding(0) var image:texture_2d<f32>;
@vertex fn vs(@builtin(vertex_index) i:u32)->@builtin(position) vec4<f32>{let p=array<vec2<f32>,3>(vec2<f32>(-1.0,-1.0),vec2<f32>(3.0,-1.0),vec2<f32>(-1.0,3.0));return vec4<f32>(p[i],0.0,1.0);}
@fragment fn fs(@builtin(position) p:vec4<f32>)->@location(0) vec4<f32>{return textureLoad(image,vec2<i32>(p.xy),0);}`;
const VERTEX=`struct V { @builtin(position) position:vec4<f32>, @location(0) uv:vec2<f32> };
@vertex fn vs(@builtin(vertex_index) i:u32)->V{let p=array<vec2<f32>,3>(vec2<f32>(-1.0,-1.0),vec2<f32>(3.0,-1.0),vec2<f32>(-1.0,3.0));var v:V;v.position=vec4<f32>(p[i],0.0,1.0);v.uv=vec2<f32>(p[i].x*0.5+0.5,0.5-p[i].y*0.5);return v;}
`;
function rasterCode(code,outputBinding){
 // The original compose/RCAS stages use raster interpolation, hardware LINEAR
 // sampling and RGBA8 render-target conversion. Keep those operations in the
 // raster pipeline: a one-byte compose rounding difference can be amplified
 // by maximum RCAS, and compare's strict stripe threshold is discontinuous.
 const source=SOURCE.replace(/fn sampleSource[^\n]+/,`fn sampleSource(uv:vec2<f32>)->vec4<f32>{return textureSampleLevel(source,linearSampler,uv,0.0);}`);
 const comparison=COMPARE.replace(/fn comparisonSample[^\n]+/,`fn comparisonSample(uv:vec2<f32>)->vec3<f32>{return textureSampleLevel(comparison,linearSampler,uv,0.0).rgb;}`);
 return code.replace(SOURCE,source).replace(COMPARE,comparison)
  .replace(`@group(0) @binding(${outputBinding}) var output:texture_storage_2d<rgba8unorm,write>;`, `@group(0) @binding(${outputBinding}) var linearSampler:sampler;`)
  .replace(START,VERTEX+'@fragment fn fs(v:V)->@location(0) vec4<f32>{let uv=v.uv;')
  .replace('textureStore(output,q,vec4<f32>(rgb,1.0));}','return vec4<f32>(rgb,1.0);}');
}
function halfFromBits(n){const sign=(n>>>16)&0x8000,exponent=(n>>>23)&255,mantissa=n&0x7fffff;if(exponent===255)return sign|0x7c00|(mantissa?0x200:0);let e=exponent-127+15;if(e>=31)return sign|0x7c00;if(e<=0){if(e< -10)return sign;const m=mantissa|0x800000,shift=14-e,b=m>>>shift,r=m&((1<<shift)-1),middle=1<<(shift-1);return sign|(b+(r>middle||(r===middle&&(b&1))?1:0));}let b=mantissa>>>13,r=mantissa&8191;if(r>4096||(r===4096&&(b&1))){if(++b===1024){b=0;e++;}}return sign|(e<<10)|b;}
class Compositor{
 constructor(device,base,options){
  this.device=device;this.base=base;this.options=options;this.ready=false;this.destroyed=false;this.error=null;this.visible=false;this.lastSkipReason='';this.sourceW=0;this.sourceH=0;this.memoryBytes=0;this.shapes=new Map();this.snapshots=[null,null];this.pending=new Set();this.retired=new Set();this.retirements=new Set();this.textureBytes=new WeakMap();this.slots=[];this.output=null;this.originalOpacity=base.style.opacity;this.supportedAlgorithms=Object.freeze(['native','rcas','ravu']);
  this.wait=typeof options.waitForCompletion==='function'?options.waitForCompletion:()=>device.queue.onSubmittedWorkDone();
  try{
  this.canvas=base.ownerDocument.createElement('canvas');this.canvas.id=(base.id||'fv-enhancer-canvas')+'-webgpu';this.canvas.setAttribute('aria-hidden','true');
  this.context=this.canvas.getContext('webgpu');if(!this.context)throw new Error('WebGPU compositor canvas is unavailable.');
  this.format=root.navigator.gpu.getPreferredCanvasFormat();this.context.configure({device,format:this.format,alphaMode:'premultiplied'});
  base.parentNode?.insertBefore(this.canvas,base.nextSibling);this.align();
  for(let i=0;i<MAX_PENDING;i++){this.slots.push({buffer:device.createBuffer({size:32,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),pending:false});this.memoryBytes+=32;}
  const lossTarget=this.lossTarget={current:this};
  device.lost?.then(info=>{const engine=lossTarget.current;if(engine&&!engine.destroyed){engine.error=new Error('WebGPU compositor device lost: '+(info?.message||'unknown reason'));engine.ready=false;engine.setVisible(false);}},()=>{});
  }catch(error){for(const slot of this.slots)slot.buffer.destroy();this.slots=[];try{this.context?.unconfigure();}catch{}this.canvas?.remove();this.base.style.opacity=this.originalOpacity;throw error;}
 }
 static async create(device,base,options={}){if(!device||!base?.ownerDocument)throw new Error('WebGPU compositor requires a device and attached base canvas.');let engine;try{engine=new Compositor(device,base,options);await engine.prepare();engine.ready=true;return engine;}catch(error){if(engine)await engine.destroy();throw error;}}
 async compute(label,code,kinds){const entries=kinds.map((kind,binding)=>({binding,visibility:GPUShaderStage.COMPUTE,...(kind==='uniform'?{buffer:{type:'uniform'}}:kind==='external'?{externalTexture:{}}:kind.startsWith('storage:')?{storageTexture:{access:'write-only',format:kind.slice(8)}}:{texture:{sampleType:'unfilterable-float'}})}));const layout=this.device.createBindGroupLayout({entries});const pipeline=await this.device.createComputePipelineAsync({label:'Video compositor '+label,layout:this.device.createPipelineLayout({bindGroupLayouts:[layout]}),compute:{module:this.device.createShaderModule({label:'Video compositor '+label,code}),entryPoint:'main'}});return {pipeline,layout,kinds};}
 async raster(label,code,kinds){const entries=kinds.map((kind,binding)=>({binding,visibility:GPUShaderStage.FRAGMENT,...(kind==='uniform'?{buffer:{type:'uniform'}}:kind==='sampler'?{sampler:{type:'filtering'}}:{texture:{sampleType:'float'}})}));const layout=this.device.createBindGroupLayout({entries}),module=this.device.createShaderModule({label:'Video compositor '+label,code});const pipeline=await this.device.createRenderPipelineAsync({label:'Video compositor '+label,layout:this.device.createPipelineLayout({bindGroupLayouts:[layout]}),vertex:{module,entryPoint:'vs'},fragment:{module,entryPoint:'fs',targets:[{format:'rgba8unorm'}]},primitive:{topology:'triangle-list'}});return {pipeline,layout,kinds};}
 async prepare(){
  this.programs={};this.programs.copy=await this.compute('copy RGBA',copyCode(false),['uniform','texture','storage:rgba8unorm']);
  if(this.options.captureMode==='external')this.programs.external=await this.compute('copy external',copyCode(true),['uniform','external','storage:rgba8unorm']);
  this.sampler=this.device.createSampler({magFilter:'linear',minFilter:'linear',addressModeU:'clamp-to-edge',addressModeV:'clamp-to-edge'});
  this.programs.native=await this.raster('native',rasterCode(directCode(true),3),['uniform','texture','texture','sampler']);
  this.programs.rcas=await this.raster('RCAS',rasterCode(directCode(false),3),['uniform','texture','texture','sampler']);
  if(this.options.lut){
   const values=this.options.lut;
   // In Firefox a view of a DOM-owned ArrayBuffer can inherit that buffer's
   // realm. Validate the typed-array brand across extension/DOM realms.
   if(!ArrayBuffer.isView(values)||Object.prototype.toString.call(values)!=='[object Float32Array]'||values.length!==LUT_W*LUT_H*4)throw new Error('RAVU compositor requires the bundled 13 × 288 RGBA float LUT.');
   // Read the existing float32 bits through one view. Per-value scratch views
   // would allocate almost 30,000 objects while playback is already running.
   const bits=new Uint32Array(values.buffer,values.byteOffset,values.length),data=new Uint16Array(values.length);for(let i=0;i<values.length;i++)data[i]=halfFromBits(bits[i]);
   this.lut=this.texture(LUT_W,LUT_H,'rgba16float',GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST);
   this.device.queue.writeTexture({texture:this.lut},data,{bytesPerRow:LUT_W*8,rowsPerImage:LUT_H},[LUT_W,LUT_H]);
   this.programs.classify=await this.compute('RAVU classify',CLASSIFY,['uniform','texture','storage:rgba8unorm']);
   this.programs.filter=await this.compute('RAVU filter',FILTER,['uniform','texture','texture','texture','storage:rgba16float']);
   this.programs.compose=await this.raster('RAVU compose',rasterCode(COMPOSE,4),['uniform','texture','texture','texture','sampler']);
  }else this.supportedAlgorithms=Object.freeze(['native','rcas']);
  const module=this.device.createShaderModule({label:'Video compositor canvas',code:BLIT});
  this.blit=await this.device.createRenderPipelineAsync({label:'Video compositor canvas',layout:'auto',vertex:{module,entryPoint:'vs'},fragment:{module,entryPoint:'fs',targets:[{format:this.format}]},primitive:{topology:'triangle-list'}});
  await this.wait();
 }
 check(){if(this.destroyed)throw new Error('WebGPU compositor was destroyed.');if(this.error)throw this.error;}
 align(){const parent=this.base.parentNode;if(parent&&(this.canvas.parentNode!==parent||this.base.nextSibling!==this.canvas))parent.insertBefore(this.canvas,this.base.nextSibling);const style=this.canvas.style;style.cssText=this.base.style.cssText;style.pointerEvents='none';style.opacity='1';style.visibility=this.visible?(this.base.style.visibility||'visible'):'hidden';}
 setVisible(value){this.visible=!!value&&!this.destroyed;this.base.style.opacity=this.visible?'0':this.originalOpacity;this.align();}
 texture(w,h,format,usage){const bytes=w*h*(format==='rgba16float'?8:4);if(this.memoryBytes+bytes>LIMIT)throw new Error('WebGPU compositor texture budget exceeded.');const texture=this.device.createTexture({size:[w,h],format,usage});this.textureBytes.set(texture,bytes);this.memoryBytes+=bytes;return texture;}
 release(texture){if(texture&&this.textureBytes.has(texture)){texture.destroy();this.memoryBytes-=this.textureBytes.get(texture);this.textureBytes.delete(texture);if(this.output===texture)this.output=null;}}
 freeShape(shape){for(const texture of shape.textures)this.release(texture);}
 collect(){for(const entry of this.retired)this.release(entry);this.retired.clear();}
 retire(texture){if(!texture||this.retired.has(texture))return;this.retired.add(texture);let completion;try{completion=this.wait();}catch(error){completion=Promise.reject(error);}const pending=Promise.resolve(completion).finally(()=>{this.release(texture);this.retired.delete(texture);this.retirements.delete(pending);});this.retirements.add(pending);pending.catch(error=>{this.error=error instanceof Error?error:new Error(String(error));});}
 transitionSource(w,h){if(w===this.sourceW&&h===this.sourceH)return;this.sourceW=w;this.sourceH=h;
  // A source-size transition invalidates old midpoint identities. Clear their
  // public slots now, but keep their GPU allocations alive behind a fence
  // which also covers inference/presentation submissions on the shared queue.
  for(let i=0;i<this.snapshots.length;i++){const slot=this.snapshots[i];if(slot&&(slot.w!==w||slot.h!==h)){this.snapshots[i]=null;this.retire(slot.texture);}}
 }
 trim(bytes=0,addingShape=false,protectedTextures=new Set()){for(const [key,shape]of this.shapes){if(this.shapes.size<=MAX_SHAPES-(addingShape?1:0)&&this.memoryBytes+bytes<=LIMIT)break;if(!shape.refs&&!shape.textures.some(texture=>protectedTextures.has(texture))){this.shapes.delete(key);this.freeShape(shape);}}}
 layout(sw,sh,ow,oh,{algorithm='ravu',strength=1,compare=true}={}){
  // Only reserve textures read by the selected pipeline. Native/RCAS do not
  // need RAVU features; zero sharpening needs no post-process intermediate.
  const roles=[['source',sw,sh,'rgba8unorm'],['output',ow,oh,'rgba8unorm']];
  if(compare)roles.push(['comparison',sw,sh,'rgba8unorm']);
  if(algorithm==='ravu'){
   roles.push(['classification',sw,sh,'rgba8unorm'],['packed',sw,sh,'rgba16float']);
   if(strength>0)roles.push(['composed',ow,oh,'rgba8unorm']);
  }
  return roles;
 }
 shape(sw,sh,ow,oh,protectedTextures,config){
  const key=[sw,sh,ow,oh].join('x');let shape=this.shapes.get(key);
  const missing=this.layout(sw,sh,ow,oh,config).filter(([role])=>!shape?.[role]);
  const bytes=missing.reduce((sum,[,w,h,format])=>sum+w*h*(format==='rgba16float'?8:4),0);
  // A mode/compare change may extend a cached shape. Never evict that shape
  // (or an input being copied) while making room for its additional textures.
  const protectedSet=new Set([...protectedTextures,...(shape?.textures||[])]);
  this.trim(bytes,!shape,protectedSet);
  if(shape&&!shape.refs&&this.memoryBytes+bytes>LIMIT){
   // A mode change can fit on its own yet not alongside obsolete optional
   // roles. Reclaim only drained, unused textures; queued readers and caller
   // inputs stay alive. Otherwise a temporary "busy" could become permanent.
   const needed=new Set(this.layout(sw,sh,ow,oh,config).map(([role])=>role));
   for(const role of ['comparison','classification','packed','composed']){
    const texture=shape[role];
    if(texture&&!needed.has(role)&&!protectedTextures.has(texture)){
     this.release(texture);delete shape[role];
     shape.textures=shape.textures.filter(entry=>entry!==texture);
    }
   }
  }
  if((!shape&&this.shapes.size>=MAX_SHAPES)||this.memoryBytes+bytes>LIMIT)return null;
  const usage=GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.STORAGE_BINDING|GPUTextureUsage.COPY_SRC|GPUTextureUsage.COPY_DST|GPUTextureUsage.RENDER_ATTACHMENT;
  const allocated={};
  try{
   for(const [role,w,h,format]of missing)allocated[role]=this.texture(w,h,format,usage);
  }catch(error){for(const texture of Object.values(allocated))this.release(texture);throw error;}
  // Publish additions atomically; failed additions preserve source/output
  // and queued readers. Optional drained roles may have been evicted above.
  if(!shape)shape={key,refs:0,textures:[]};
  Object.assign(shape,allocated);shape.textures.push(...Object.values(allocated));
  this.shapes.delete(key);this.shapes.set(key,shape);return shape;
 }
 dimensions(w,h){if(!Number.isInteger(w)||!Number.isInteger(h)||w<1||h<1||w>this.device.limits.maxTextureDimension2D||h>this.device.limits.maxTextureDimension2D)throw new Error('Invalid WebGPU compositor dimensions.');}
 canRenderDimensions(sw,sh,ow,oh,config){const max=this.device.limits.maxTextureDimension2D;if(![sw,sh,ow,oh].every(n=>Number.isInteger(n)&&n>0&&n<=max))return false;
  // Include both retained source-sized predictions before admitting a mode.
  // The bound is unchanged; dimensions and model quality are never reduced.
  const shapeBytes=this.layout(sw,sh,ow,oh,config).reduce((sum,[,w,h,format])=>sum+w*h*(format==='rgba16float'?8:4),0);
  return shapeBytes+sw*sh*8+(this.options.lut?LUT_W*LUT_H*8:0)+MAX_PENDING*32<=LIMIT;
 }
 group(program,resources){return this.device.createBindGroup({layout:program.layout,entries:resources.map((resource,binding)=>({binding,resource:program.kinds[binding]==='uniform'?{buffer:resource}:program.kinds[binding]==='external'||program.kinds[binding]==='sampler'?resource:resource.createView()}))});}
 dispatch(encoder,program,resources,w,h){const pass=encoder.beginComputePass({label:'Video compositor compute'});pass.setPipeline(program.pipeline);pass.setBindGroup(0,this.group(program,resources));pass.dispatchWorkgroups(Math.ceil(w/8),Math.ceil(h/8));pass.end();}
 drawSpatial(encoder,program,resources,output){const pass=encoder.beginRenderPass({colorAttachments:[{view:output.createView(),loadOp:'clear',clearValue:{r:0,g:0,b:0,a:1},storeOp:'store'}]});pass.setPipeline(program.pipeline);pass.setBindGroup(0,this.group(program,resources));pass.draw(3);pass.end();}
 copySource(encoder,descriptor,output,uniform,w,h){if(!descriptor||!!descriptor.external===!!descriptor.texture)throw new Error('A compositor source must contain exactly one external or texture resource.');const program=descriptor.external?this.programs.external:this.programs.copy;if(!program)throw new Error('External compositor capture was not prepared.');this.dispatch(encoder,program,[uniform,descriptor.external||descriptor.texture,output],w,h);}
 submit(encoder,slot=null,shape=null){const command=encoder.finish();if(slot)slot.pending=true;if(shape)shape.refs++;const record={promise:null};try{this.device.queue.submit([command]);}catch(error){if(slot)slot.pending=false;if(shape)shape.refs--;throw error;}let completion;try{completion=this.wait();}catch(error){completion=Promise.reject(error);}record.promise=Promise.resolve(completion).catch(error=>{this.error=error instanceof Error?error:new Error(String(error));throw this.error;}).finally(()=>{if(slot)slot.pending=false;if(shape)shape.refs--;this.pending.delete(record);});this.pending.add(record);record.promise.catch(()=>{});return record.promise;}
 render(source,sw,sh,{algorithm='native',strength=0,compare=false,comparisonSource=null,protectNoise=false}={}){
  this.check();this.lastSkipReason='';if(!this.ready||this.pending.size>=MAX_PENDING){this.lastSkipReason='busy';return false;}if(!this.supportedAlgorithms.includes(algorithm))throw new Error('Unsupported WebGPU compositor algorithm: '+algorithm);
  this.dimensions(sw,sh);const ow=this.base.width,oh=this.base.height;this.dimensions(ow,oh);if(!Number.isFinite(strength)||strength<0||strength>1)throw new Error('Invalid WebGPU compositor strength.');
  this.transitionSource(sw,sh);
  const config={algorithm,strength,compare};
  if(!this.canRenderDimensions(sw,sh,ow,oh,config)){this.lastSkipReason='capacity';return false;}
  const shape=this.shape(sw,sh,ow,oh,new Set([source?.texture,comparisonSource?.texture]),config);if(!shape){this.lastSkipReason='busy';return false;}const slot=this.slots.find(slot=>!slot.pending);if(!slot){this.lastSkipReason='busy';return false;}
  const data=new ArrayBuffer(32),view=new DataView(data);[sw,sh,ow,oh].forEach((v,i)=>view.setUint32(i*4,v,true));view.setFloat32(16,strength,true);view.setUint32(20,compare?1:0,true);view.setUint32(24,9,true);view.setUint32(28,protectNoise?1:0,true);this.device.queue.writeBuffer(slot.buffer,0,data);
  const encoder=this.device.createCommandEncoder({label:'Video compositor frame'});this.copySource(encoder,source,shape.source,slot.buffer,sw,sh);
  const comparison=compare&&comparisonSource?shape.comparison:shape.source;if(comparison!==shape.source)this.copySource(encoder,comparisonSource,comparison,slot.buffer,sw,sh);
  if(algorithm==='ravu'){
   this.dispatch(encoder,this.programs.classify,[slot.buffer,shape.source,shape.classification],sw,sh);
   this.dispatch(encoder,this.programs.filter,[slot.buffer,shape.source,shape.classification,this.lut,shape.packed],sw,sh);
   this.drawSpatial(encoder,this.programs.compose,[slot.buffer,shape.source,comparison,shape.packed,this.sampler],strength>0?shape.composed:shape.output);
   if(strength>0)this.drawSpatial(encoder,this.programs.rcas,[slot.buffer,shape.composed,shape.composed,this.sampler],shape.output);
  }else this.drawSpatial(encoder,this.programs[algorithm],[slot.buffer,shape.source,comparison,this.sampler],shape.output);
  if(this.canvas.width!==ow||this.canvas.height!==oh){this.canvas.width=ow;this.canvas.height=oh;}
  const current=this.context.getCurrentTexture(),pass=encoder.beginRenderPass({colorAttachments:[{view:current.createView(),loadOp:'clear',clearValue:{r:0,g:0,b:0,a:1},storeOp:'store'}]});
  pass.setPipeline(this.blit);pass.setBindGroup(0,this.device.createBindGroup({layout:this.blit.getBindGroupLayout(0),entries:[{binding:0,resource:shape.output.createView()}]}));pass.draw(3);pass.end();
  this.submit(encoder,slot,shape);this.output=shape.output;this.align();return true;
 }
 snapshot(texture,w,h,index){this.check();this.dimensions(w,h);if(index!==0&&index!==1)throw new Error('Compositor snapshot slot must be 0 or 1.');if(this.pending.size>=MAX_PENDING)return null;
  if(texture.format&&texture.format!=='rgba8unorm')throw new Error('Compositor snapshots require RGBA8 textures.');let slot=this.snapshots[index];
  if(!slot||slot.w!==w||slot.h!==h){const bytes=w*h*4;this.trim(bytes,false,new Set([texture]));if(this.memoryBytes+bytes>LIMIT)return null;const next={w,h,texture:this.texture(w,h,'rgba8unorm',GPUTextureUsage.COPY_DST|GPUTextureUsage.COPY_SRC|GPUTextureUsage.TEXTURE_BINDING)};if(slot)this.retire(slot.texture);slot=this.snapshots[index]=next;}
  const encoder=this.device.createCommandEncoder({label:'Video compositor retained snapshot'});encoder.copyTextureToTexture({texture},{texture:slot.texture},[w,h]);this.submit(encoder);return slot.texture;
 }
 async whenIdle(){this.check();const results=await Promise.allSettled([...Array.from(this.pending,record=>record.promise),...this.retirements]);const failure=results.find(result=>result.status==='rejected');if(failure)throw failure.reason;if(this.error)throw this.error;}
 async destroy(){if(this.destroying)return this.destroying;this.ready=false;this.setVisible(false);this.destroyed=true;if(this.lossTarget)this.lossTarget.current=null;return this.destroying=(async()=>{await Promise.allSettled([...Array.from(this.pending,record=>record.promise),...this.retirements]);try{await this.wait();}catch{}for(const shape of this.shapes.values())this.freeShape(shape);this.shapes.clear();for(const slot of this.snapshots)this.release(slot?.texture);this.snapshots=[null,null];this.release(this.lut);this.lut=null;for(const slot of this.slots||[])slot.buffer.destroy();this.memoryBytes-=(this.slots?.length||0)*32;this.slots=[];this.output=null;this.collect();this.programs={};this.blit=null;this.sampler=null;this.context?.unconfigure();this.canvas.remove();this.base.style.opacity=this.originalOpacity;})();}
}
const api={create:(device,base,options)=>Compositor.create(device,base,options)};root.VENeuralCompositor=api;if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(typeof globalThis!=='undefined'?globalThis:this);
