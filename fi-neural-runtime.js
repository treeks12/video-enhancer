/*
 * Compact t-factored IFNet inference for Video Enhancer.
 * Graph/layout and selected kernel equations adapted from Framegen (MIT),
 * pinned at 83a3e338cb3b9391b05c4d85a5fd8534a8aafa32. See third_party/framegen/.
 * This is a separate, dense WebGPU implementation, NOT upstream's tuned runtime.
 * Images/features stay on the GPU. The small FiLM time-MLP runs once per phase.
 */
(function(scope) {
  'use strict';
  const product = shape => shape.reduce((a,b)=>a*b,1);
  function validateModel(manifest, binary, limits = {}) {
    if (!manifest || Object.getPrototypeOf(manifest) !== Object.prototype || !(binary instanceof ArrayBuffer)) throw new Error('Invalid neural model');
    if (binary.byteLength < 4 || binary.byteLength > 8*1024*1024 || binary.byteLength%4) throw new Error('Invalid model byte length');
    const tensor = (key,shape) => {
      const m=manifest[key];
      if(!m || !Array.isArray(m.shape) || m.shape.length !== shape.length || !m.shape.every((v,i)=>Number.isInteger(v)&&v>0&&v<=512&&(shape[i]===null||v===shape[i])) || !Number.isSafeInteger(m.offset) || m.offset<0 || (m.offset+product(m.shape))*4>binary.byteLength) throw new Error('Invalid tensor: '+key);
      return m;
    };
    const c1=tensor('block0.conv0.0.0.weight',[null,6,3,3]).shape[0];
    const c2=tensor('block0.conv0.1.0.weight',[null,c1,3,3]).shape[0];
    if(c1>64 || c2>128 || c1%4 || c2%4) throw new Error('Unsupported compact network width');
    const expected=new Set();
    const expect=(key,shape)=>{expected.add(key);return tensor(key,shape);};
    for(const [base,ci,co] of [['block0.conv0.0',6,c1],['block0.conv0.1',c1,c2]]) {
      expect(base+'.0.weight',[co,ci,3,3]);expect(base+'.0.bias',[co]);expect(base+'.1.weight',[co]);
    }
    for(let i=0;i<8;i++) {
      const base='block0.convblock.'+i;
      expect(base+'.0.weight',[c2,c2,3,3]);expect(base+'.0.bias',[c2]);expect(base+'.1.weight',[c2]);
    }
    expect('block0.lastconv.weight',[c2,5,4,4]);expect('block0.lastconv.bias',[5]);
    const hidden=expect('film.0.weight',[null,1]).shape[0];
    expect('film.0.bias',[hidden]);expect('film.2.weight',[2*c2,hidden]);expect('film.2.bias',[2*c2]);
    const rc=expect('refine.c0.weight',[null,11,3,3]).shape[0];
    if(rc>64 || rc%4) throw new Error('Unsupported refinement width');
    expect('refine.c0.bias',[rc]);expect('refine.a0.weight',[rc]);
    for(let i=1;i<3;i++) {expect(`refine.c${i}.weight`,[rc,rc,3,3]);expect(`refine.c${i}.bias`,[rc]);expect(`refine.a${i}.weight`,[rc]);}
    expect('refine.c3.weight',[3,rc,3,3]);expect('refine.c3.bias',[3]);
    if(Object.keys(manifest).some(k=>!expected.has(k))) throw new Error('Unexpected model tensors');
    const ranges=[...expected].map(k=>[manifest[k].offset,manifest[k].offset+product(manifest[k].shape)]).sort((a,b)=>a[0]-b[0]);
    for(let i=1;i<ranges.length;i++) if(ranges[i][0]<ranges[i-1][1]) throw new Error('Overlapping model tensors');
    const values=new Float32Array(binary);
    for(const v of values) if(!Number.isFinite(v) || Math.abs(v)>65504) throw new Error('Nonfinite or out-of-range neural weight');
    return {c1,c2,hidden,rc,parameters:ranges.reduce((n,r)=>n+r[1]-r[0],0),bytes:binary.byteLength};
  }
  function filmParams(weights, c, t, out, scratch) {
    if (!Number.isFinite(t) || t<0 || t>1) throw new Error('Invalid interpolation phase');
    const {w0,b0,w2,b2}=weights,h=b0.length;
    for(let j=0;j<h;j++) scratch[j]=Math.max(0,w0[j]*t+b0[j]);
    for(let k=0;k<2*c;k++){let v=b2[k];for(let j=0;j<h;j++)v+=w2[k*h+j]*scratch[j];out[k]=v;}
    return out;
  }
  function convCode(ci,co,iw,ih,ow,oh,stride,half,residual=false) {
    const T=half?'f16':'f32',S=(stride===2&&!half?8:16),TS=8*stride+2;
    return `${half?'enable f16;':''}
@group(0) @binding(0) var<storage,read> src:array<${T}>;
@group(0) @binding(1) var<storage,read> wt:array<${T}>;
@group(0) @binding(2) var<storage,read> bias:array<f32>;
@group(0) @binding(3) var<storage,read> alpha:array<f32>;
@group(0) @binding(4) var<storage,read_write> dst:array<${T}>;
${residual?'@group(0) @binding(5) var<storage,read> skip:array<'+T+'>;':''}
var<workgroup> tile:array<${T},${S*TS*TS}>;
var<workgroup> slab:array<${T},${4*S*9}>;
@compute @workgroup_size(8,8,1)
fn main(@builtin(global_invocation_id) g:vec3<u32>,@builtin(local_invocation_id) l:vec3<u32>,@builtin(workgroup_id) wg:vec3<u32>,@builtin(local_invocation_index) li:u32) {
 let x=i32(g.x);let y=i32(g.y);let oc=i32(g.z)*4;
 let inside=x<${ow} && y<${oh}; var acc:array<f32,4>;
 for(var c=0;c<4;c++){acc[c]=bias[oc+c];}
 for(var base=0;base<${ci};base+=${S}) {
   let n=min(${S},${ci}-base); workgroupBarrier();
   for(var i=i32(li);i<n*${TS*TS};i+=64){
     let ch=i/${TS*TS};let pos=i%${TS*TS};
     let xx=i32(wg.x)*${8*stride}+pos%${TS}-1;let yy=i32(wg.y)*${8*stride}+pos/${TS}-1;
     var v=${T}(0.0);if(xx>=0&&yy>=0&&xx<${iw}&&yy<${ih}){v=src[(base+ch)*${iw*ih}+yy*${iw}+xx];}tile[i]=v;
   }
   for(var i=i32(li);i<4*n*9;i+=64){let c=i/(n*9);let rem=i%(n*9);slab[i]=wt[(oc+c)*${ci*9}+(base+rem/9)*9+rem%9];}
   workgroupBarrier();
   if(inside){for(var ch=0;ch<n;ch++){for(var ky=0;ky<3;ky++){for(var kx=0;kx<3;kx++){
     let v=f32(tile[ch*${TS*TS}+(i32(l.y)*${stride}+ky)*${TS}+i32(l.x)*${stride}+kx]);
     for(var c=0;c<4;c++){acc[c]+=v*f32(slab[c*n*9+ch*9+ky*3+kx]);}
   }}}}
 }
 if(inside){for(var c=0;c<4;c++){let idx=(oc+c)*${ow*oh}+y*${ow}+x;let a=acc[c];var v=select(a*alpha[oc+c],a,a>=0.0);${residual?'v+=f32(skip[idx]);':''}dst[idx]=${T}(v);}}
}`;
  }
  function prepCode(w,h,half) {
    const T=half?'f16':'f32',W=w/4,H=h/4,P=W*H;
    return `${half?'enable f16;':''}
@group(0) @binding(0) var a:texture_2d<f32>;@group(0) @binding(1) var b:texture_2d<f32>;
@group(0) @binding(2) var s:sampler;@group(0) @binding(3) var<storage,read_write> dst:array<${T}>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) g:vec3<u32>){
 if(g.x>=${W}u||g.y>=${H}u){return;}let uv=(vec2<f32>(g.xy)+0.5)/vec2<f32>(${W}.0,${H}.0);
 let aa=textureSampleLevel(a,s,uv,0.0).bgr;let bb=textureSampleLevel(b,s,uv,0.0).bgr;let p=g.y*${W}u+g.x;
 for(var c=0u;c<3u;c++){dst[c*${P}u+p]=${T}(aa[c]);dst[(c+3u)*${P}u+p]=${T}(bb[c]);}
}`;
  }
  function filmCode(c,n,half) {
    const T=half?'f16':'f32';return `${half?'enable f16;':''}
@group(0) @binding(0) var<storage,read> src:array<${T}>;@group(0) @binding(1) var<storage,read> prm:array<f32>;
@group(0) @binding(2) var<storage,read_write> dst:array<${T}>;
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) g:vec3<u32>){if(g.x>=${c*n}u){return;}let c=g.x/${n}u;dst[g.x]=${T}(f32(src[g.x])*(1.0+prm[c])+prm[${c}u+c]);}`;
  }
  function deconvCode(c,iw,ih,half) {
    const T=half?'f16':'f32',W=iw*2,H=ih*2;
    return `${half?'enable f16;':''}
@group(0) @binding(0) var<storage,read> src:array<${T}>;@group(0) @binding(1) var<storage,read> wt:array<${T}>;
@group(0) @binding(2) var<storage,read> bias:array<f32>;@group(0) @binding(3) var fl:texture_storage_2d<rgba16float,write>;
@group(0) @binding(4) var mask:texture_storage_2d<rgba16float,write>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) g:vec3<u32>){
 let x=i32(g.x);let y=i32(g.y);if(x>=${W}||y>=${H}){return;}var acc:array<f32,5>;
 for(var co=0;co<5;co++){acc[co]=bias[co];}
 for(var ky=(y+1)&1;ky<4;ky+=2){let yy=y+1-ky;let iy=yy/2;if(yy<0||iy>=${ih}){continue;}
 for(var kx=(x+1)&1;kx<4;kx+=2){let xx=x+1-kx;let ix=xx/2;if(xx<0||ix>=${iw}){continue;}
 for(var ci=0;ci<${c};ci++){let v=f32(src[ci*${iw*ih}+iy*${iw}+ix]);for(var co=0;co<5;co++){acc[co]+=v*f32(wt[(ci*5+co)*16+ky*4+kx]);}}}}
 textureStore(fl,vec2<i32>(x,y),vec4<f32>(acc[0],acc[1],acc[2],acc[3]));textureStore(mask,vec2<i32>(x,y),vec4<f32>(acc[4],0.0,0.0,0.0));
}`;
  }
  function refinePrepCode(w,h,half) {
    const T=half?'f16':'f32',W=w/4,H=h/4,P=W*H;
    return `${half?'enable f16;':''}
@group(0) @binding(0) var fl:texture_2d<f32>;@group(0) @binding(1) var mask:texture_2d<f32>;
@group(0) @binding(2) var a:texture_2d<f32>;@group(0) @binding(3) var b:texture_2d<f32>;
@group(0) @binding(4) var s:sampler;@group(0) @binding(5) var<storage,read_write> dst:array<${T}>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) g:vec3<u32>){
 if(g.x>=${W}u||g.y>=${H}u){return;}var aa=vec3<f32>(0.0);var bb=vec3<f32>(0.0);var f=vec4<f32>(0.0);var m=0.0;
 for(var dy=1u;dy<=2u;dy++){for(var dx=1u;dx<=2u;dx++){
  let uv=(vec2<f32>(g.xy*4u+vec2<u32>(dx,dy))+0.5)/vec2<f32>(${w}.0,${h}.0);
  let flow=textureSampleLevel(fl,s,uv,0.0)*8.0;
  aa+=textureSampleLevel(a,s,uv+flow.xy/vec2<f32>(${w}.0,${h}.0),0.0).bgr;
  bb+=textureSampleLevel(b,s,uv+flow.zw/vec2<f32>(${w}.0,${h}.0),0.0).bgr;
  f+=flow;m+=1.0/(1.0+exp(-textureSampleLevel(mask,s,uv,0.0).x));
 }}let p=g.y*${W}u+g.x;
 for(var c=0u;c<3u;c++){dst[c*${P}u+p]=${T}(aa[c]*0.25);dst[(c+3u)*${P}u+p]=${T}(bb[c]*0.25);}
 dst[6u*${P}u+p]=${T}(m*0.25);for(var c=0u;c<4u;c++){dst[(7u+c)*${P}u+p]=${T}(f[c]*(0.25*0.25/20.0));}
}`;
  }
  function refineOutCode(c,w,h,half) {
    const T=half?'f16':'f32';return `${half?'enable f16;':''}
@group(0) @binding(0) var<storage,read> src:array<${T}>;@group(0) @binding(1) var<storage,read> wt:array<f32>;
@group(0) @binding(2) var<storage,read> bias:array<f32>;@group(0) @binding(3) var outp:texture_storage_2d<rgba16float,write>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) g:vec3<u32>){
 let x=i32(g.x);let y=i32(g.y);if(x>=${w}||y>=${h}){return;}var acc=vec3<f32>(bias[0],bias[1],bias[2]);
 for(var ci=0;ci<${c};ci++){for(var ky=0;ky<3;ky++){for(var kx=0;kx<3;kx++){
 let yy=clamp(y+ky-1,0,${h-1});let xx=clamp(x+kx-1,0,${w-1});let v=f32(src[ci*${w*h}+yy*${w}+xx]);let k=ci*9+ky*3+kx;
 acc+=v*vec3<f32>(wt[k],wt[${c*9}+k],wt[${2*c*9}+k]);}}}
 textureStore(outp,vec2<i32>(x,y),vec4<f32>(2.0/(vec3<f32>(1.0)+exp(-acc))-1.0,0.0));
}`;
  }
  function composeCode(w,h) {
    return `
@group(0) @binding(0) var fl:texture_2d<f32>;@group(0) @binding(1) var mask:texture_2d<f32>;
@group(0) @binding(2) var residual:texture_2d<f32>;@group(0) @binding(3) var a:texture_2d<f32>;
@group(0) @binding(4) var b:texture_2d<f32>;@group(0) @binding(5) var s:sampler;
@group(0) @binding(6) var outp:texture_storage_2d<rgba8unorm,write>;
@group(0) @binding(7) var<uniform> options:vec4<f32>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) g:vec3<u32>){
 let dims=textureDimensions(outp);if(any(g.xy>=dims)){return;}let uv=(vec2<f32>(g.xy)+0.5)/vec2<f32>(dims);
 let f=textureSampleLevel(fl,s,uv,0.0)*8.0;let logit=textureSampleLevel(mask,s,uv,0.0).x;
 let r=textureSampleLevel(residual,s,uv,0.0).xyz;
 // NaNs fail these comparisons. Never feed nonfinite coordinates to a sampler.
 if(!all(abs(f)<vec4<f32>(${Math.max(w,h)*4}.0)) || !(abs(logit)<65504.0) || !all(abs(r)<vec3<f32>(2.0))){
   textureStore(outp,vec2<i32>(g.xy),vec4<f32>(textureSampleLevel(a,s,uv,0.0).rgb,1.0));return;
 }
 let m=1.0/(1.0+exp(-logit));
 let aa=textureSampleLevel(a,s,uv+f.xy/vec2<f32>(${w}.0,${h}.0),0.0).bgr;
 let bb=textureSampleLevel(b,s,uv+f.zw/vec2<f32>(${w}.0,${h}.0),0.0).bgr;
 var rgb=clamp(aa*m+bb*(1.0-m)+r,vec3<f32>(0.0),vec3<f32>(1.0)).bgr;
 if(options.y>0.5&&options.y<1.5){rgb=vec3<f32>(0.5+f.x/32.0,0.5+f.y/32.0,0.5);}
 else if(options.y>=1.5&&options.y<2.5){rgb=vec3<f32>(m);}
 else if(options.y>=2.5&&options.y<3.5){rgb=abs(aa-bb).bgr;}
 else if(options.y>=3.5){rgb=clamp(abs(r.bgr)*4.0,vec3<f32>(0.0),vec3<f32>(1.0));}
 // Exact endpoints do not pass through a learned approximation.
 if(options.x<=0.0){rgb=textureSampleLevel(a,s,uv,0.0).rgb;}else if(options.x>=1.0){rgb=textureSampleLevel(b,s,uv,0.0).rgb;}
 textureStore(outp,vec2<i32>(g.xy),vec4<f32>(rgb,1.0));
}`;
  }
  async function create(device,{w,h,weightsBin,weightsManifest,useF16=device.features.has('shader-f16')}) {
    if(!Number.isInteger(w)||!Number.isInteger(h)||w<16||h<16||w%16||h%16||w>1920||h>1920) throw new Error('Model dimensions must be positive multiples of 16, at most 1920');
    if(useF16&&!device.features.has('shader-f16')) throw new Error('shader-f16 is unavailable');
    const spec=validateModel(weightsManifest,weightsBin),{c1,c2,hidden,rc}=spec;
    const resources=[],pipelineCache=new Map(),weightCache=new Map();let destroyed=false,prepared=null;
    const W=w/4,H=h/4,W8=w/8,H8=h/8,W16=w/16,H16=h/16,N=W16*H16;
    let allocatedBytes=0;
    function buffer(bytes,usage=GPUBufferUsage.STORAGE){const size=Math.max(4,Math.ceil(bytes/4)*4);if(size>device.limits.maxStorageBufferBindingSize)throw new Error('Neural buffer exceeds device limit');const b=device.createBuffer({size,usage:usage|GPUBufferUsage.COPY_DST});resources.push(b);allocatedBytes+=size;return b;}
    const activation=n=>buffer(n*(useF16?2:4));
    function texture(width,height,format='rgba16float'){const t=device.createTexture({size:[width,height],format,usage:GPUTextureUsage.STORAGE_BINDING|GPUTextureUsage.TEXTURE_BINDING});resources.push(t);allocatedBytes+=width*height*8;return t;}
    function destroy(){if(destroyed)return;destroyed=true;prepared=null;for(const r of resources){try{r.destroy();}catch{}}resources.length=0;weightCache.clear();pipelineCache.clear();}
    function values(name){const m=weightsManifest[name];return new Float32Array(weightsBin,m.offset*4,product(m.shape));}
    function weight(name,half=false){const key=name+':'+half;if(weightCache.has(key))return weightCache.get(key);const v=values(name),b=buffer(v.length*(half?2:4));if(half){const packed=new Uint16Array(Math.ceil(v.length/2)*2);for(let i=0;i<v.length;i++)packed[i]=scope.FiQuality.floatToHalf(v[i]);device.queue.writeBuffer(b,0,packed);}else device.queue.writeBuffer(b,0,v);weightCache.set(key,b);return b;}
    async function pipeline(code,label){if(pipelineCache.has(code))return pipelineCache.get(code);const promise=(async()=>{const module=device.createShaderModule({code,label});const info=await module.getCompilationInfo();const errors=info.messages.filter(m=>m.type==='error');if(errors.length)throw new Error(label+': '+errors.map(m=>m.message).join('; '));return device.createComputePipelineAsync({label,layout:'auto',compute:{module,entryPoint:'main'}});})();pipelineCache.set(code,promise);return promise;}
    const view=r=>typeof r.createView==='function'?r.createView():{buffer:r};
    const bind=(p,entries)=>device.createBindGroup({layout:p.getBindGroupLayout(0),entries:entries.map((r,i)=>({binding:i,resource:r?.__sampler?r.sampler:view(r)}))});
    const sampler=device.createSampler({minFilter:'linear',magFilter:'linear',addressModeU:'clamp-to-edge',addressModeV:'clamp-to-edge'}),S={__sampler:true,sampler};
    const stage=(p,g,d)=>({p,g,d});
    const dispatch=(pass,steps)=>{for(const step of steps){pass.setPipeline(step.p);pass.setBindGroup(0,step.g);pass.dispatchWorkgroups(...step.d);}};
    try {
      const x=activation(6*W*H),f8=activation(c1*W8*H8),skip=activation(c2*N),a=activation(c2*N),b=activation(c2*N),trunk=activation(c2*N),conditioned=activation(c2*N);
      const film=buffer(c2*2*4),options=buffer(16,GPUBufferUsage.UNIFORM),flow=texture(W8,H8),mask=texture(W8,H8),residual=texture(W,H);
      const rin=activation(11*W*H),ra=activation(rc*W*H),rb=activation(rc*W*H);
      const [pPrep,p0,p1,pBlock,pLast,pFilm,pDec,pRPrep,pR0,pR1,pROut,pOut]=await Promise.all([
        pipeline(prepCode(w,h,useF16),'neural prep'),pipeline(convCode(6,c1,W,H,W8,H8,2,useF16),'conv0a'),pipeline(convCode(c1,c2,W8,H8,W16,H16,2,useF16),'conv0b'),
        pipeline(convCode(c2,c2,W16,H16,W16,H16,1,useF16),'convblock'),pipeline(convCode(c2,c2,W16,H16,W16,H16,1,useF16,true),'convblock residual'),
        pipeline(filmCode(c2,N,useF16),'FiLM'),pipeline(deconvCode(c2,W16,H16,useF16),'deconv'),pipeline(refinePrepCode(w,h,useF16),'refine prep'),
        pipeline(convCode(11,rc,W,H,W,H,1,useF16),'refine 0'),pipeline(convCode(rc,rc,W,H,W,H,1,useF16),'refine 1/2'),pipeline(refineOutCode(rc,W,H,useF16),'refine output'),pipeline(composeCode(w,h),'neural compose')
      ]);
      if(destroyed)throw new Error('Neural runtime closed during compilation');
      const conv=(p,base,src,dst,width,height,co,extra=[])=>stage(p,bind(p,[src,weight(base+'.0.weight',useF16),weight(base+'.0.bias'),weight(base+'.1.weight'),dst,...extra]),[Math.ceil(width/8),Math.ceil(height/8),co/4]);
      const trunkSteps=[conv(p0,'block0.conv0.0',x,f8,W8,H8,c1),conv(p1,'block0.conv0.1',f8,skip,W16,H16,c2)];
      let source=skip;
      for(let i=0;i<6;i++){const dst=i===5?trunk:(i%2===0?a:b);trunkSteps.push(conv(pBlock,'block0.convblock.'+i,source,dst,W16,H16,c2));source=dst;}
      const headSteps=[stage(pFilm,bind(pFilm,[trunk,film,conditioned]),[Math.ceil(c2*N/256)]),conv(pBlock,'block0.convblock.6',conditioned,a,W16,H16,c2),conv(pLast,'block0.convblock.7',a,b,W16,H16,c2,[skip]),stage(pDec,bind(pDec,[b,weight('block0.lastconv.weight',useF16),weight('block0.lastconv.bias'),flow,mask]),[Math.ceil(W8/8),Math.ceil(H8/8)])];
      const refine=(p,i,src,dst)=>stage(p,bind(p,[src,weight(`refine.c${i}.weight`,useF16),weight(`refine.c${i}.bias`),weight(`refine.a${i}.weight`),dst]),[Math.ceil(W/8),Math.ceil(H/8),rc/4]);
      const refineSteps=[refine(pR0,0,rin,ra),refine(pR1,1,ra,rb),refine(pR1,2,rb,ra),stage(pROut,bind(pROut,[ra,weight('refine.c3.weight'),weight('refine.c3.bias'),residual]),[Math.ceil(W/8),Math.ceil(H/8)])];
      const fw={w0:values('film.0.weight'),b0:values('film.0.bias'),w2:values('film.2.weight'),b2:values('film.2.bias')},fo=new Float32Array(2*c2),fh=new Float32Array(hidden),opts=new Float32Array(4);
      // Caller maintains a small fixed texture pool. Weak keys never retain a
      // destroyed pool after resize, unlike label-based bind-group caches.
      const pairs=new WeakMap();
      function bindings(texA,texB){let map=pairs.get(texA);if(!map){map=new WeakMap();pairs.set(texA,map);}let pair=map.get(texB);if(!pair){pair={prep:bind(pPrep,[texA,texB,S,x]),refine:bind(pRPrep,[flow,mask,texA,texB,S,rin]),outputs:new WeakMap(),a:texA,b:texB};map.set(texB,pair);}return pair;}
      function prepPair(texA,texB){if(destroyed)throw new Error('Neural runtime destroyed');if(texA===texB)throw new Error('Endpoints must be distinct textures');prepared=bindings(texA,texB);const enc=device.createCommandEncoder({label:'neural trunk'}),pass=enc.beginComputePass();dispatch(pass,[stage(pPrep,prepared.prep,[Math.ceil(W/8),Math.ceil(H/8)]),...trunkSteps]);pass.end();device.queue.submit([enc.finish()]);}
      function runT(t,out,debug=0){if(destroyed||!prepared)throw new Error('No prepared neural pair');if(out===prepared.a||out===prepared.b)throw new Error('Output aliases an endpoint');if(out.format!=='rgba8unorm')throw new Error('Neural output must be rgba8unorm');
        device.queue.writeBuffer(film,0,filmParams(fw,c2,t,fo,fh));opts[0]=t;opts[1]=debug;device.queue.writeBuffer(options,0,opts);
        let final=prepared.outputs.get(out);if(!final){final=bind(pOut,[flow,mask,residual,prepared.a,prepared.b,S,out,options]);prepared.outputs.set(out,final);}
        const enc=device.createCommandEncoder({label:'neural timestep'}),pass=enc.beginComputePass();dispatch(pass,[...headSteps,stage(pRPrep,prepared.refine,[Math.ceil(W/8),Math.ceil(H/8)]),...refineSteps,stage(pOut,final,[Math.ceil(out.width/8),Math.ceil(out.height/8)])]);pass.end();device.queue.submit([enc.finish()]);
      }
      return {prepPair,runT,destroy,spec:{...spec,w,h,useF16,allocatedBytes},debugTextures:{flow,mask,residual}};
    } catch(error){destroy();throw error;}
  }
  const api={create,validateModel,filmParams,kernels:{convCode,prepCode,filmCode,deconvCode,refinePrepCode,refineOutCode,composeCode}};
  scope.FiNeuralRuntime=api;if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(globalThis);
