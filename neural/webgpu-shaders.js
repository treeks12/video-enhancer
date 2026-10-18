/* WGSL implementation of the fixed IFRNet-S graph in graph.js. */
(function(root){
'use strict';
// Byte offsets: size 0, active 8, region 16, phase 32, debug 36, outputSize 40.
const UNIFORMS=`struct Uniforms {
 size: vec2<u32>, activeSize: vec2<u32>, region: vec4<u32>,
 phase: f32, debug: u32, outputSize: vec2<u32>,
};
@group(0) @binding(0) var<uniform> u: Uniforms;
`;
const binding=(index,name,kind,format)=>({binding:index,name,kind,...(format?{format}:{})});
function reader(t,name,index,mode='all'){
 const b=t.base||t,off=t.offset||0,rows=Math.ceil(Math.ceil(b.c/4)/b.cols);
 const bilinear=mode==='all'||mode==='B',vector=bilinear||mode==='V',channel=mode==='all'||mode==='C';
 const shuffle=[0,1,2,3].map(lane=>{const index=off%4+lane;return (index<4?'a.':'b.')+'xyzw'[index%4];}).join(',');
 let code=`@group(0) @binding(${index}) var ${name}: texture_2d<f32>;
fn ${name}Size() -> vec2<i32> { return vec2<i32>(textureDimensions(${name}))/vec2<i32>(${b.cols},${rows}); }
`;
 if(channel)code+=`fn ${name}C(p:vec2<i32>, c:i32) -> f32 {
 if(c<0 || c>=${t.c}) { return 0.0; }
 let k=c+${off}; let g=k/4;
 let size=${name}Size(); let q=clamp(p,vec2<i32>(0),size-vec2<i32>(1));
 return textureLoad(${name},q+vec2<i32>(g%${b.cols},g/${b.cols})*size,0)[u32(k%4)];
}
`;
 if(vector)code+=`fn ${name}V(p:vec2<i32>, g:i32) -> vec4<f32> {
 ${off%4===0?`let k=g+${off/4}; let size=${name}Size(); let q=clamp(p,vec2<i32>(0),size-vec2<i32>(1));
 var v=textureLoad(${name},q+vec2<i32>(k%${b.cols},k/${b.cols})*size,0);
 ${t.c%4?`if(g==${Math.floor(t.c/4)}) { v*=vec4<f32>(${[0,1,2,3].map(i=>i<t.c%4?'1.0':'0.0').join(',')}); }`:''}
 return v;`:`if(g<0 || g*4>=${t.c}) { return vec4<f32>(0.0); }
 let k=g+${Math.floor(off/4)}; let size=${name}Size(); let q=clamp(p,vec2<i32>(0),size-vec2<i32>(1));
 let a=textureLoad(${name},q+vec2<i32>(k%${b.cols},k/${b.cols})*size,0);
 let b=textureLoad(${name},q+vec2<i32>((k+1)%${b.cols},(k+1)/${b.cols})*size,0);
 var v=vec4<f32>(${shuffle});
 ${t.c%4?`if(g==${Math.floor(t.c/4)}) { v=select(vec4<f32>(0.0),v,vec4<bool>(${[0,1,2,3].map(i=>String(i<t.c%4)).join(',')})); }`:''}
 return v;`}
}
`;
 if(bilinear)code+=`fn ${name}B(position:vec2<f32>, g:i32) -> vec4<f32> {
 let p=clamp(position,vec2<f32>(0.0),vec2<f32>(${name}Size()-vec2<i32>(1)));
 let q=vec2<i32>(floor(p)); let f=fract(p);
 return mix(mix(${name}V(q,g),${name}V(q+vec2<i32>(1,0),g),f.x),mix(${name}V(q+vec2<i32>(0,1),g),${name}V(q+vec2<i32>(1,1),g),f.x),f.y);
}
`;
 return code;
}
// Match GL LINEAR + CLAMP_TO_EDGE without requiring a filterable texture format.
function imageReader(name,index,external=false,sampler=null,filtered=false){
 if(external){
  const imageSampler=sampler||{name:name+'Sampler',binding:index+1};
  return `@group(0) @binding(${index}) var ${name}: texture_external;
${imageSampler.declare===false?'':`@group(0) @binding(${imageSampler.binding}) var ${imageSampler.name}: sampler;`}
fn ${name}B(uv:vec2<f32>) -> vec4<f32> {
 return textureSampleBaseClampToEdge(${name},${imageSampler.name},uv);
}
`;
 }
 if(filtered){
  const imageSampler=sampler||{name:name+'Sampler',binding:index+1};
  return `@group(0) @binding(${index}) var ${name}: texture_2d<f32>;
${imageSampler.declare===false?'':`@group(0) @binding(${imageSampler.binding}) var ${imageSampler.name}: sampler;`}
fn ${name}B(uv:vec2<f32>) -> vec4<f32> {
 return textureSampleLevel(${name},${imageSampler.name},uv,0.0);
}
`;
 }
 const load=q=>`textureLoad(${name},${q}${external?'':',0'})`;
 return `@group(0) @binding(${index}) var ${name}: ${external?'texture_external':'texture_2d<f32>'};
fn ${name}B(uv:vec2<f32>) -> vec4<f32> {
 let size=vec2<i32>(textureDimensions(${name}));
 let p=clamp(uv*vec2<f32>(size)-vec2<f32>(0.5),vec2<f32>(0.0),vec2<f32>(size-vec2<i32>(1)));
 let q=vec2<i32>(floor(p)); let hi=min(q+vec2<i32>(1),size-vec2<i32>(1)); let f=fract(p);
 return mix(mix(${load('q')},${load('vec2<i32>(hi.x,q.y)')},f.x),mix(${load('vec2<i32>(q.x,hi.y)')},${load('hi')},f.x),f.y);
}
`;}
function tiledConvolution(op,code,bindings,next,storageTiles=false){
 const {out:o,layer:l,stride=1,deconv=false,residual=false}=op;
 const area=l.k*l.k,tile=deconv?6:8*stride+2;
 const input=where=>storageTiles?`scratch[inputBase+${where}]`:`inputTile[${where}]`;
 const weight=where=>storageTiles?`scratch[weightBase+${where}]`:`weightTile[${where}]`;
 code+=`@group(0) @binding(${next}) var weights: texture_2d<f32>;
@group(0) @binding(${next+(storageTiles?2:1)}) var output: texture_storage_2d<rgba16float,write>;
${storageTiles?`@group(0) @binding(${next+1}) var<storage,read_write> scratch:array<vec4<f32>>;`:`var<workgroup> inputTile:array<vec4<f32>,${tile*tile}>;
var<workgroup> weightTile:array<vec4<f32>,${area*4}>;
var<workgroup> bias:vec4<f32>;
${l.slope?'var<workgroup> slope:vec4<f32>;':''}`}
@compute @workgroup_size(8,8)
fn main(@builtin(global_invocation_id) gid:vec3<u32>,
        @builtin(workgroup_id) wid:vec3<u32>,
        @builtin(local_invocation_index) lane:u32) {
 let p=vec2<i32>(gid.xy+u.region.xy); let g=i32(wid.z);
 let origin=vec2<i32>(u.region.xy+wid.xy*8u);
 let inputOrigin=${deconv?'origin/2-vec2<i32>(1)':`origin*${stride}-vec2<i32>(1)`};
 let inputSize=s0Size();
 let valid=all(gid.xy<u.region.zw) && all(p<vec2<i32>(u.size)) && g<${o.groups};
 ${storageTiles?`let blocks=(u.region.zw+vec2<u32>(7u))/8u;
 let inputBase=((wid.z*blocks.y+wid.y)*blocks.x+wid.x)*${tile*tile+area*4}u;
 let weightBase=inputBase+${tile*tile}u;`:''}
 // Dynamic bounds keep native drivers from unrolling every model channel.
 let ci=(i32(textureDimensions(weights).x)-2)/${area};
 ${storageTiles?`var total=textureLoad(weights,vec2<i32>(0,g),0);
 ${l.slope?'let slope=textureLoad(weights,vec2<i32>(1,g),0);':''}`:`if(lane==0u) {
  bias=textureLoad(weights,vec2<i32>(0,g),0);
  ${l.slope?'slope=textureLoad(weights,vec2<i32>(1,g),0);':''}
 }
 workgroupBarrier();
 var total=bias;`}
 for(var ic:i32=0;ic<ci;ic+=4) {
  // Every invocation participates, including the partial spatial edge. This
  // barrier prevents a fast invocation overwriting the previous channel tile.
  ${storageTiles?'storageBarrier':'workgroupBarrier'}();
  for(var i=lane;i<${tile*tile}u;i+=64u) {
   let ip=inputOrigin+vec2<i32>(i32(i%${tile}u),i32(i/${tile}u));
   var value=vec4<f32>(0.0);
   if(all(ip>=vec2<i32>(0)) && all(ip<inputSize)) { value=s0V(ip,ic/4); }
   ${input('i')}=value;
  }
  for(var i=lane;i<${area*4}u;i+=64u) {
   var value=vec4<f32>(0.0);
   if(ic+i32(i/${area}u)<ci) { value=textureLoad(weights,vec2<i32>(2+ic*${area}+i32(i),g),0); }
   ${weight('i')}=value;
  }
  ${storageTiles?'storageBarrier':'workgroupBarrier'}();
  if(valid) { for(var y:i32=0;y<${deconv?2:l.k};y++) { for(var x:i32=0;x<${deconv?2:l.k};x++) {
   ${deconv?`let ky=(p.y+1)%2+2*y; let kx=(p.x+1)%2+2*x; let ip=vec2<i32>((p.x+1-kx)/2,(p.y+1-ky)/2);`:
    `let ky=y; let kx=x; let ip=p*${stride}+vec2<i32>(x-1,y-1);`}
   if(any(ip<vec2<i32>(0)) || any(ip>=inputSize)) { continue; }
   let local=ip-inputOrigin; let v=${input(`u32(local.y*${tile}+local.x)`)}; let k=u32(ky*${l.k}+kx);
   total+=v.x*${weight('k')};
   if(ic+1<ci) { total+=v.y*${weight(`k+${area}u`)}; }
   if(ic+2<ci) { total+=v.z*${weight(`k+${area*2}u`)}; }
   if(ic+3<ci) { total+=v.w*${weight(`k+${area*3}u`)}; }
  }}}
 }
 if(valid) {
  ${residual?'total+=s1V(p,g);':''}
  ${l.slope?'total=max(total,vec4<f32>(0.0))+min(total,vec4<f32>(0.0))*slope;':''}
  let q=p+vec2<i32>(g%${o.cols},g/${o.cols})*vec2<i32>(u.size);
  textureStore(output,q,total);
 }
}
`;
 bindings.push(binding(next,'weights','texture'));
 if(storageTiles)bindings.push(binding(next+1,'scratch','storage-buffer'));
 bindings.push(binding(next+(storageTiles?2:1),'output','storage-texture','rgba16float'));
 return {code,bindings,tiled:true,...(storageTiles?{scratchBytes:Math.ceil(o.w/8)*Math.ceil(o.h/8)*o.groups*(tile*tile+area*4)*16}:{})};
}
// Experimental uniform-driven convolution for native compilers that expand the
// small constant tap/tile loops inside the dynamic channel loop. Kernel geometry
// is per operation, even when the program source is shared across kernel shapes.
function compactConvolution(op,code,bindings,next,storageTiles=false,genericLayout=false){
 const {out:o,layer:l,stride=1,deconv=false,residual=false}=op;
 if(storageTiles){
  const area=l.k*l.k,tile=deconv?6:8*stride+2;
  code+=`@group(0) @binding(${next}) var weights: texture_2d<f32>;
@group(0) @binding(${next+1}) var<storage,read_write> scratch:array<vec4<f32>>;
@group(0) @binding(${next+2}) var output: texture_storage_2d<rgba16float,write>;
@compute @workgroup_size(8,8)
fn main(@builtin(global_invocation_id) gid:vec3<u32>,
        @builtin(workgroup_id) wid:vec3<u32>,
        @builtin(local_invocation_index) lane:u32) {
 let kernel=i32(u.debug&15u); let stride=i32((u.debug>>4u)&15u);
 let deconv=(u.debug&256u)!=0u; let area=kernel*kernel;
 let tile=select(8*stride+2,6,deconv); let taps=select(kernel,2,deconv);
 let p=vec2<i32>(gid.xy+u.region.xy); let g=i32(wid.z);
 let origin=vec2<i32>(u.region.xy+wid.xy*8u);
 let inputOrigin=select(origin*stride-vec2<i32>(1),origin/2-vec2<i32>(1),deconv);
 let inputSize=s0Size();
 let valid=all(gid.xy<u.region.zw) && all(p<vec2<i32>(u.size)) && ${genericLayout?'g<i32(textureDimensions(weights).y)':`g<${o.groups}`};
 let blocks=(u.region.zw+vec2<u32>(7u))/8u;
 let inputBase=((wid.z*blocks.y+wid.y)*blocks.x+wid.x)*u32(tile*tile+area*4);
 let weightBase=inputBase+u32(tile*tile);
 let ci=(i32(textureDimensions(weights).x)-2)/area;
 var total=textureLoad(weights,vec2<i32>(0,g),0);
 ${genericLayout?'let slope=textureLoad(weights,vec2<i32>(1,g),0);':l.slope?'let slope=textureLoad(weights,vec2<i32>(1,g),0);':''}
 for(var ic:i32=0;ic<ci;ic+=4) {
  // All invocations, including spatial-edge lanes, protect reuse of this tile.
  storageBarrier();
  for(var i=lane;i<u32(tile*tile);i+=64u) {
   let ip=inputOrigin+vec2<i32>(i32(i)%tile,i32(i)/tile);
   var value=vec4<f32>(0.0);
   if(all(ip>=vec2<i32>(0)) && all(ip<inputSize)) { value=s0V(ip,ic/4); }
   scratch[inputBase+i]=value;
  }
  for(var i=lane;i<u32(area*4);i+=64u) {
   var value=vec4<f32>(0.0);
   if(ic+i32(i)/area<ci) { value=textureLoad(weights,vec2<i32>(2+ic*area+i32(i),g),0); }
   scratch[weightBase+i]=value;
  }
  storageBarrier();
  if(valid) { for(var y:i32=0;y<taps;y++) { for(var x:i32=0;x<taps;x++) {
   var ky=y; var kx=x; var ip=p*stride+vec2<i32>(x-1,y-1);
   if(deconv) {
    ky=(p.y+1)%2+2*y; kx=(p.x+1)%2+2*x;
    ip=vec2<i32>((p.x+1-kx)/2,(p.y+1-ky)/2);
   }
   if(any(ip<vec2<i32>(0)) || any(ip>=inputSize)) { continue; }
   let local=ip-inputOrigin; let v=scratch[inputBase+u32(local.y*tile+local.x)]; let k=u32(ky*kernel+kx);
   total+=v.x*scratch[weightBase+k];
   if(ic+1<ci) { total+=v.y*scratch[weightBase+k+u32(area)]; }
   if(ic+2<ci) { total+=v.z*scratch[weightBase+k+u32(area*2)]; }
   if(ic+3<ci) { total+=v.w*scratch[weightBase+k+u32(area*3)]; }
  }}}
 }
 if(valid) {
  ${genericLayout?'if((u.debug&1024u)!=0u){total+=s1V(p,g);}':residual?'total+=s1V(p,g);':''}
  ${genericLayout?'if((u.debug&512u)!=0u){total=max(total,vec4<f32>(0.0))+min(total,vec4<f32>(0.0))*slope;}':l.slope?'total=max(total,vec4<f32>(0.0))+min(total,vec4<f32>(0.0))*slope;':''}
  ${genericLayout?'let outputCols=i32(textureDimensions(output).x/u.size.x);\n  let q=p+vec2<i32>(g%outputCols,g/outputCols)*vec2<i32>(u.size);':`let q=p+vec2<i32>(g%${o.cols},g/${o.cols})*vec2<i32>(u.size);`}
  textureStore(output,q,total);
 }
}
`;
  bindings.push(binding(next,'weights','texture'),binding(next+1,'scratch','storage-buffer'),binding(next+2,'output','storage-texture','rgba16float'));
  return {code,bindings,tiled:true,config:l.k|(stride<<4)|(deconv?256:0)|(genericLayout?(l.slope?512:0)|(residual?1024:0):0),
   scratchBytes:Math.ceil(o.w/8)*Math.ceil(o.h/8)*o.groups*(tile*tile+area*4)*16};
 }
 code+=`@group(0) @binding(${next}) var weights: texture_2d<f32>;
@group(0) @binding(${next+1}) var output: texture_storage_2d<rgba16float,write>;
var<workgroup> inputTile:array<vec4<f32>,324>;
var<workgroup> weightTile:array<vec4<f32>,64>;
var<workgroup> bias:vec4<f32>;
${l.slope?'var<workgroup> slope:vec4<f32>;':''}
@compute @workgroup_size(8,8)
fn main(@builtin(global_invocation_id) gid:vec3<u32>,
        @builtin(workgroup_id) wid:vec3<u32>,
        @builtin(local_invocation_index) lane:u32) {
 let kernel=i32(u.debug&15u); let stride=i32((u.debug>>4u)&15u);
 let deconv=(u.debug&256u)!=0u; let area=kernel*kernel;
 let tile=select(8*stride+2,6,deconv); let taps=select(kernel,2,deconv);
 let p=vec2<i32>(gid.xy+u.region.xy); let g=i32(wid.z);
 let origin=vec2<i32>(u.region.xy+wid.xy*8u);
 let inputOrigin=select(origin*stride-vec2<i32>(1),origin/2-vec2<i32>(1),deconv);
 let inputSize=s0Size();
 let valid=all(gid.xy<u.region.zw) && all(p<vec2<i32>(u.size)) && g<${o.groups};
 let ci=(i32(textureDimensions(weights).x)-2)/area;
 if(lane==0u) {
  bias=textureLoad(weights,vec2<i32>(0,g),0);
  ${l.slope?'slope=textureLoad(weights,vec2<i32>(1,g),0);':''}
 }
 workgroupBarrier();
 var total=bias;
 for(var ic:i32=0;ic<ci;ic+=4) {
  workgroupBarrier();
  for(var i=lane;i<u32(tile*tile);i+=64u) {
   let ip=inputOrigin+vec2<i32>(i32(i)%tile,i32(i)/tile);
   var value=vec4<f32>(0.0);
   if(all(ip>=vec2<i32>(0)) && all(ip<inputSize)) { value=s0V(ip,ic/4); }
   inputTile[i]=value;
  }
  for(var i=lane;i<u32(area*4);i+=64u) {
   var value=vec4<f32>(0.0);
   if(ic+i32(i)/area<ci) { value=textureLoad(weights,vec2<i32>(2+ic*area+i32(i),g),0); }
   weightTile[i]=value;
  }
  workgroupBarrier();
  if(valid) { for(var y:i32=0;y<taps;y++) { for(var x:i32=0;x<taps;x++) {
   var ky=y; var kx=x; var ip=p*stride+vec2<i32>(x-1,y-1);
   if(deconv) {
    ky=(p.y+1)%2+2*y; kx=(p.x+1)%2+2*x;
    ip=vec2<i32>((p.x+1-kx)/2,(p.y+1-ky)/2);
   }
   if(any(ip<vec2<i32>(0)) || any(ip>=inputSize)) { continue; }
   let local=ip-inputOrigin; let v=inputTile[u32(local.y*tile+local.x)]; let k=u32(ky*kernel+kx);
   total+=v.x*weightTile[k];
   if(ic+1<ci) { total+=v.y*weightTile[k+u32(area)]; }
   if(ic+2<ci) { total+=v.z*weightTile[k+u32(area*2)]; }
   if(ic+3<ci) { total+=v.w*weightTile[k+u32(area*3)]; }
  }}}
 }
 if(valid) {
  ${residual?'total+=s1V(p,g);':''}
  ${l.slope?'total=max(total,vec4<f32>(0.0))+min(total,vec4<f32>(0.0))*slope;':''}
  let q=p+vec2<i32>(g%${o.cols},g/${o.cols})*vec2<i32>(u.size);
  textureStore(output,q,total);
 }
}
`;
 bindings.push(binding(next,'weights','texture'),binding(next+1,'output','storage-texture','rgba16float'));
 return {code,bindings,tiled:true,config:l.k|(stride<<4)|(deconv?256:0)};
}
const STORAGE_INPUT_READER=`@group(0) @binding(1) var s0: texture_2d<f32>;
fn s0Size() -> vec2<i32> { return vec2<i32>(textureDimensions(s0))/vec2<i32>(u.activeSize); }
fn s0V(p:vec2<i32>,g:i32) -> vec4<f32> {
 let k=g+i32(u.outputSize.x/4u); let shift=u.outputSize.x%4u;
 let columns=i32(u.activeSize.x); let size=s0Size();
 let q=clamp(p,vec2<i32>(0),size-vec2<i32>(1));
 let a=textureLoad(s0,q+vec2<i32>(k%columns,k/columns)*size,0);
 if(shift==0u) { return a; }
 let b=textureLoad(s0,q+vec2<i32>((k+1)%columns,(k+1)/columns)*size,0);
 switch shift {
  case 1u: { return vec4<f32>(a.yzw,b.x); }
  case 2u: { return vec4<f32>(a.zw,b.xy); }
  default: { return vec4<f32>(a.w,b.xyz); }
 }
}
`;
const STORAGE_RESIDUAL_READER=`@group(0) @binding(2) var s1: texture_2d<f32>;
fn s1V(p:vec2<i32>,group:i32) -> vec4<f32> {
 let size=vec2<i32>(u.size); let columns=i32(textureDimensions(s1).x/u.size.x);
 let q=clamp(p,vec2<i32>(0),size-vec2<i32>(1));
 var v=textureLoad(s1,q+vec2<i32>(group%columns,group/columns)*size,0);
 let first=group*4; let channels=i32(u.outputSize.y);
 if(first+4>channels) { v*=select(vec4<f32>(0.0),vec4<f32>(1.0),vec4<i32>(first)+vec4<i32>(0,1,2,3)<vec4<i32>(channels)); }
 return v;
}
`;
function genericStorageConvolution(op){
 const {out:o,inputs:ins}=op,base=ins[0].base||ins[0];
 const bindings=[binding(0,'uniforms','uniform'),binding(1,'s0','texture'),binding(2,'s1','texture')];
 const code=UNIFORMS+STORAGE_INPUT_READER+STORAGE_RESIDUAL_READER;
 const desc=compactConvolution(op,code,bindings,bindings.length,true,true);
 return {...desc,convLayout:{active:[base.cols,Math.ceil(base.groups/base.cols)],outputSize:[ins[0].offset||0,o.c]}};
}
// Stage the input once per spatial tile, shared by every output channel group.
// Two smaller programs avoid the channel-loop barriers and weight staging in
// the combined kernel. Dispatch order protects scratch reuse between regions.
function stagedStorageConvolution(op){
 const {out:o,inputs:ins,layer:l}=op,base=ins[0].base||ins[0];
 const geometry=`let kernel=i32(u.debug&15u); let stride=i32((u.debug>>4u)&15u);
 let deconv=(u.debug&256u)!=0u; let area=kernel*kernel; let tile=select(8*stride+2,6,deconv);
 let ci=(i32(textureDimensions(weights).x)-2)/area; let groups=u32((ci+3)/4);
 let blocks=(u.region.zw+vec2<u32>(7u))/8u;
 let base=(wid.y*blocks.x+wid.x)*u32(tile*tile)*groups;
`;
 const stageCode=UNIFORMS+STORAGE_INPUT_READER+`@group(0) @binding(2) var weights:texture_2d<f32>;
@group(0) @binding(3) var<storage,read_write> scratch:array<vec4<f32>>;
@compute @workgroup_size(8,8)
fn main(@builtin(workgroup_id) wid:vec3<u32>,@builtin(local_invocation_index) lane:u32) {
 ${geometry}
 let origin=vec2<i32>(u.region.xy+wid.xy*8u);
 let inputOrigin=select(origin*stride-vec2<i32>(1),origin/2-vec2<i32>(1),deconv);
 let inputSize=s0Size();
 for(var i=lane;i<u32(tile*tile);i+=64u) {
  let ip=inputOrigin+vec2<i32>(i32(i)%tile,i32(i)/tile);
  var value=vec4<f32>(0.0);
  if(all(ip>=vec2<i32>(0))&&all(ip<inputSize)) { value=s0V(ip,i32(wid.z)); }
  scratch[base+wid.z*u32(tile*tile)+i]=value;
 }
}
`;
 const code=UNIFORMS+`@group(0) @binding(1) var s0:texture_2d<f32>;
`+STORAGE_RESIDUAL_READER+`@group(0) @binding(3) var weights:texture_2d<f32>;
@group(0) @binding(4) var<storage,read_write> scratch:array<vec4<f32>>;
@group(0) @binding(5) var output:texture_storage_2d<rgba16float,write>;
@compute @workgroup_size(8,8)
fn main(@builtin(global_invocation_id) gid:vec3<u32>,@builtin(workgroup_id) wid:vec3<u32>) {
 ${geometry}
 let p=vec2<i32>(gid.xy+u.region.xy); let g=i32(wid.z);
 if(any(gid.xy>=u.region.zw)||any(p>=vec2<i32>(u.size))||g>=i32(textureDimensions(weights).y)) { return; }
 let inputSize=vec2<i32>(textureDimensions(s0))/vec2<i32>(u.activeSize);
 let origin=vec2<i32>(u.region.xy+wid.xy*8u);
 let inputOrigin=select(origin*stride-vec2<i32>(1),origin/2-vec2<i32>(1),deconv);
 let taps=select(kernel,2,deconv); var total=textureLoad(weights,vec2<i32>(0,g),0);
 for(var ic:i32=0;ic<ci;ic+=4) { for(var y:i32=0;y<taps;y++) { for(var x:i32=0;x<taps;x++) {
  var ky=y; var kx=x; var ip=p*stride+vec2<i32>(x-1,y-1);
  if(deconv) {
   ky=(p.y+1)%2+2*y; kx=(p.x+1)%2+2*x;
   ip=vec2<i32>((p.x+1-kx)/2,(p.y+1-ky)/2);
  }
  if(any(ip<vec2<i32>(0))||any(ip>=inputSize)) { continue; }
  let local=ip-inputOrigin;
  let v=scratch[base+u32(ic/4*tile*tile+local.y*tile+local.x)]; let ix=2+ic*area+ky*kernel+kx;
  total+=v.x*textureLoad(weights,vec2<i32>(ix,g),0);
  if(ic+1<ci) { total+=v.y*textureLoad(weights,vec2<i32>(ix+area,g),0); }
  if(ic+2<ci) { total+=v.z*textureLoad(weights,vec2<i32>(ix+2*area,g),0); }
  if(ic+3<ci) { total+=v.w*textureLoad(weights,vec2<i32>(ix+3*area,g),0); }
 }}}
 if((u.debug&1024u)!=0u) { total+=s1V(p,g); }
 if((u.debug&512u)!=0u) { total=max(total,vec4<f32>(0.0))+min(total,vec4<f32>(0.0))*textureLoad(weights,vec2<i32>(1,g),0); }
 let cols=i32(textureDimensions(output).x/u.size.x);
 textureStore(output,p+vec2<i32>(g%cols,g/cols)*vec2<i32>(u.size),total);
}
`;
 const tile=op.deconv?6:8*(op.stride||1)+2;
 return {code,bindings:[binding(0,'uniforms','uniform'),binding(1,'s0','texture'),binding(2,'s1','texture'),binding(3,'weights','texture'),binding(4,'scratch','storage-buffer'),binding(5,'output','storage-texture','rgba16float')],tiled:true,
  config:l.k|((op.stride||1)<<4)|(op.deconv?256:0)|(l.slope?512:0)|(op.residual?1024:0),
  convLayout:{active:[base.cols,Math.ceil(base.groups/base.cols)],outputSize:[ins[0].offset||0,o.c]},
  scratchBytes:Math.ceil(o.w/8)*Math.ceil(o.h/8)*tile*tile*Math.ceil(l.ci/4)*16,
  stage:{code:stageCode,bindings:[binding(0,'uniforms','uniform'),binding(1,'s0','texture'),binding(2,'weights','texture'),binding(3,'scratch','storage-buffer')],label:'staged convolution input'},stageGroups:Math.ceil(l.ci/4)};
}
// Aligned generic scalar convolution has two program sources: with/without the
// residual input. Conv-only uniform fields describe each input atlas/view.
function genericConvolution(op){
 const {out:o,inputs:ins,layer:l,stride=1,deconv=false,residual=false}=op,b=ins[0].base||ins[0];
 const rows=Math.ceil(Math.ceil(b.c/4)/b.cols),weightBinding=residual?3:2,outputBinding=weightBinding+1;
 const bindings=[binding(0,'uniforms','uniform'),binding(1,'s0','texture')];
 if(residual)bindings.push(binding(2,'s1','texture'));
 bindings.push(binding(weightBinding,'weights','texture'),binding(outputBinding,'output','storage-texture','rgba16float'));
 const code=UNIFORMS+`// Generic scalar IFRNet convolution.
@group(0) @binding(1) var s0:texture_2d<f32>;
${residual?'@group(0) @binding(2) var s1:texture_2d<f32>;':''}
@group(0) @binding(${weightBinding}) var weights:texture_2d<f32>;
@group(0) @binding(${outputBinding}) var output:texture_storage_2d<rgba16float,write>;
fn s0Size() -> vec2<i32> { return vec2<i32>(textureDimensions(s0))/vec2<i32>(u.activeSize); }
fn s0V(p:vec2<i32>, group:i32, channels:i32) -> vec4<f32> {
 let first=group*4; let offset=i32(u.outputSize.x);
 let k=group+offset/4; let columns=i32(u.activeSize.x); let size=s0Size();
 let q=clamp(p,vec2<i32>(0),size-vec2<i32>(1));
 var v=textureLoad(s0,q+vec2<i32>(k%columns,k/columns)*size,0);
 if(first+4>channels) { v*=select(vec4<f32>(0.0),vec4<f32>(1.0),vec4<i32>(first)+vec4<i32>(0,1,2,3)<vec4<i32>(channels)); }
 return v;
}
${residual?`fn s1V(p:vec2<i32>, group:i32) -> vec4<f32> {
 let size=vec2<i32>(u.size); let columns=i32(textureDimensions(s1).x/u.size.x);
 let q=clamp(p,vec2<i32>(0),size-vec2<i32>(1));
 var v=textureLoad(s1,q+vec2<i32>(group%columns,group/columns)*size,0);
 let first=group*4; let channels=i32(u.outputSize.y);
 if(first+4>channels) { v*=select(vec4<f32>(0.0),vec4<f32>(1.0),vec4<i32>(first)+vec4<i32>(0,1,2,3)<vec4<i32>(channels)); }
 return v;
}`:''}
@compute @workgroup_size(8,8)
fn main(@builtin(global_invocation_id) gid:vec3<u32>) {
 if(any(gid.xy>=u.region.zw)) { return; }
 let atlas=gid.xy+u.region.xy;
 if(any(atlas>=textureDimensions(output))) { return; }
 let q=vec2<i32>(atlas); let p=q%vec2<i32>(u.size);
 let columns=i32(textureDimensions(output).x/u.size.x);
 let g=q.x/i32(u.size.x)+q.y/i32(u.size.y)*columns;
 if(g>=i32(textureDimensions(weights).y)) { textureStore(output,q,vec4<f32>(0.0)); return; }
 let kernel=i32(u.debug&15u); let stride=i32((u.debug>>4u)&15u);
 let deconv=(u.debug&256u)!=0u; let activation=(u.debug&512u)!=0u;
 let area=kernel*kernel; let taps=select(kernel,2,deconv);
 let ci=(i32(textureDimensions(weights).x)-2)/area;
 var total=textureLoad(weights,vec2<i32>(0,g),0);
 for(var ic:i32=0;ic<ci;ic+=4) { for(var y:i32=0;y<taps;y++) { for(var x:i32=0;x<taps;x++) {
  var ky=y; var kx=x; var ip=p*stride+vec2<i32>(x-1,y-1);
  if(deconv) { ky=(p.y+1)%2+2*y; kx=(p.x+1)%2+2*x; ip=vec2<i32>((p.x+1-kx)/2,(p.y+1-ky)/2); }
  if(any(ip<vec2<i32>(0)) || any(ip>=s0Size())) { continue; }
  let v=s0V(ip,ic/4,ci); let k=ky*kernel+kx; let ix=2+ic*area+k;
  total+=v.x*textureLoad(weights,vec2<i32>(ix,g),0);
  if(ic+1<ci) { total+=v.y*textureLoad(weights,vec2<i32>(ix+area,g),0); }
  if(ic+2<ci) { total+=v.z*textureLoad(weights,vec2<i32>(ix+area*2,g),0); }
  if(ic+3<ci) { total+=v.w*textureLoad(weights,vec2<i32>(ix+area*3,g),0); }
 }}}
 ${residual?'total+=s1V(p,g);':''}
 if(activation) { total=max(total,vec4<f32>(0.0))+min(total,vec4<f32>(0.0))*textureLoad(weights,vec2<i32>(1,g),0); }
 textureStore(output,q,total);
}
`;
 return {code,bindings,tiled:false,config:l.k|(stride<<4)|(deconv?256:0)|(l.slope?512:0),
  convLayout:{active:[b.cols,rows],outputSize:[ins[0].offset||0,o.c]}};
}
function genericConcatEligible(op){
 const {inputs:ins,out}=op;
 return ins.length>=1&&ins.length<=5&&Number.isInteger(out.c)&&out.c===ins.reduce((channels,input)=>channels+input.c,0)&&ins.every(input=>{
  const base=input.base||input,offset=input.offset??0;
  return Number.isInteger(input.c)&&input.c>=1&&input.c<=65535&&Number.isInteger(offset)&&offset>=0&&offset<=65535&&
   input.w===out.w&&input.h===out.h&&base.w===out.w&&base.h===out.h&&offset+input.c<=base.c;
 });
}
function genericConcatShader(op){
 const info=['u.debug','u.activeSize.x','u.activeSize.y','u.outputSize.x','u.outputSize.y'];
 const packed=Array.from({length:5},(_,i)=>{
  const input=op.inputs[i];
  return input?((input.c|((input.offset??0)<<16))>>>0):0;
 });
 const bindings=[binding(0,'uniforms','uniform'),...Array.from({length:5},(_,i)=>binding(i+1,'s'+i,'texture')),
  binding(6,'output','storage-texture','rgba16float')];
 let code=UNIFORMS+Array.from({length:5},(_,i)=>`@group(0) @binding(${i+1}) var s${i}: texture_2d<f32>;
fn s${i}C(p:vec2<i32>,c:i32)->f32 {
 let info=${info[i]}; let channels=i32(info&65535u);
 if(c<0 || c>=channels) { return 0.0; }
 let channel=c+i32(info>>16u); let group=channel/4;
 let size=vec2<i32>(u.size); let cols=i32(textureDimensions(s${i}).x/u.size.x);
 let q=clamp(p,vec2<i32>(0),size-vec2<i32>(1));
 return textureLoad(s${i},q+vec2<i32>(group%cols,group/cols)*size,0)[u32(channel%4)];
}
`).join('')+`fn pick(p:vec2<i32>,c:i32)->f32 {
 var ch=c;
`;
 for(let i=0;i<5;i++)code+=` let count${i}=i32(${info[i]}&65535u); if(ch<count${i}) { return s${i}C(p,ch); } ch-=count${i};
`;
 code+=` return 0.0;
}
@group(0) @binding(6) var output: texture_storage_2d<rgba16float,write>;
@compute @workgroup_size(8,8)
fn main(@builtin(global_invocation_id) gid:vec3<u32>) {
 if(any(gid.xy>=u.region.zw)) { return; }
 let atlas=gid.xy+u.region.xy;
 if(any(atlas>=textureDimensions(output))) { return; }
 let q=vec2<i32>(atlas); let p=q%vec2<i32>(u.size);
 let channels=i32(u.debug&65535u)+i32(u.activeSize.x&65535u)+i32(u.activeSize.y&65535u)+i32(u.outputSize.x&65535u)+i32(u.outputSize.y&65535u);
 let outputCols=i32(textureDimensions(output).x/u.size.x);
 let g=q.x/i32(u.size.x)+q.y/i32(u.size.y)*outputCols;
 if(g>=(channels+3)/4) { textureStore(output,q,vec4<f32>(0.0)); return; }
 var color=vec4<f32>(0.0); let c=g*4;
 for(var lane:u32=0u;lane<4u;lane++) { if(c+i32(lane)<channels) { color[lane]=pick(p,c+i32(lane)); } }
 textureStore(output,q,color);
}
`;
 return {code,bindings,config:packed[0],concatLayout:{active:[packed[1],packed[2]],outputSize:[packed[3],packed[4]]}};
}
function genericWarpEligible(op){
 const {inputs:ins,out}=op;
 if(ins.length!==2||!Number.isInteger(out.c)||out.c<=0)return false;
 const source=ins[0],flow=ins[1],sourceBase=source.base||source,flowBase=flow.base||flow;
 const sourceOffset=source.offset??0,flowOffset=flow.offset??0;
 return sourceOffset===0&&sourceBase.c===source.c&&source.c===out.c&&flow.c===2&&(flowOffset===0||flowOffset===2)&&
  source.w===out.w&&source.h===out.h&&sourceBase.w===out.w&&sourceBase.h===out.h&&
  flow.w===out.w&&flow.h===out.h&&flowBase.w===out.w&&flowBase.h===out.h&&flowOffset+2<=flowBase.c;
}
function genericRefineEligible(op){
 const {inputs:ins,out}=op;
 if(ins.length!==2||out.c!==4||out.w%2!==0||out.h%2!==0)return false;
 const full=ins[0],prior=ins[1],fullBase=full.base||full,priorBase=prior.base||prior;
 return full.c===4&&prior.c===4&&(full.offset??0)===0&&(prior.offset??0)===0&&
  full.w===out.w&&full.h===out.h&&fullBase.w===out.w&&fullBase.h===out.h&&fullBase.c>=4&&
  prior.w*2===out.w&&prior.h*2===out.h&&priorBase.w*2===out.w&&priorBase.h*2===out.h&&priorBase.c>=4;
}
function genericWarpShader(op){
 const flowOffset=op.inputs[1].offset??0;
 const bindings=[binding(0,'uniforms','uniform'),binding(1,'s0','texture'),binding(2,'s1','texture'),binding(3,'output','storage-texture','rgba16float')];
 const code=UNIFORMS+`@group(0) @binding(1) var s0:texture_2d<f32>;
@group(0) @binding(2) var s1:texture_2d<f32>;
@group(0) @binding(3) var output:texture_storage_2d<rgba16float,write>;
fn s0V(p:vec2<i32>,g:i32)->vec4<f32> {
 let channels=i32(u.debug); let first=g*4;
 if(g<0 || first>=channels) { return vec4<f32>(0.0); }
 let size=vec2<i32>(u.size); let cols=i32(textureDimensions(s0).x/u.size.x);
 let q=clamp(p,vec2<i32>(0),size-vec2<i32>(1));
 var v=textureLoad(s0,q+vec2<i32>(g%cols,g/cols)*size,0);
 if(first+4>channels) { v*=select(vec4<f32>(0.0),vec4<f32>(1.0),vec4<i32>(first)+vec4<i32>(0,1,2,3)<vec4<i32>(channels)); }
 return v;
}
fn s0B(position:vec2<f32>,g:i32)->vec4<f32> {
 let size=vec2<i32>(u.size);
 let p=clamp(position,vec2<f32>(0.0),vec2<f32>(size-vec2<i32>(1)));
 let q=vec2<i32>(floor(p)); let f=fract(p);
 return mix(mix(s0V(q,g),s0V(q+vec2<i32>(1,0),g),f.x),mix(s0V(q+vec2<i32>(0,1),g),s0V(q+vec2<i32>(1,1),g),f.x),f.y);
}
@compute @workgroup_size(8,8)
fn main(@builtin(global_invocation_id) gid:vec3<u32>) {
 if(any(gid.xy>=u.region.zw)) { return; }
 let atlas=gid.xy+u.region.xy;
 if(any(atlas>=textureDimensions(output))) { return; }
 let q=vec2<i32>(atlas); let p=q%vec2<i32>(u.size);
 let outputCols=i32(textureDimensions(output).x/u.size.x);
 let g=q.x/i32(u.size.x)+q.y/i32(u.size.y)*outputCols;
 let channels=i32(u.debug);
 if(g>=(channels+3)/4) { textureStore(output,q,vec4<f32>(0.0)); return; }
 let flowP=clamp(p,vec2<i32>(0),vec2<i32>(u.size)-vec2<i32>(1));
 let sampled=textureLoad(s1,flowP,0);
 var flow=sampled.xy;
 if(u.outputSize.x==2u) { flow=sampled.zw; }
 let color=s0B(vec2<f32>(p)+flow,g);
 textureStore(output,q,color);
}
`;
 return {code,bindings,config:op.out.c,readerLayout:{active:[0,0],outputSize:[flowOffset,0]}};
}
function genericRefineShader(){
 const bindings=[binding(0,'uniforms','uniform'),binding(1,'s0','texture'),binding(2,'s1','texture'),binding(3,'output','storage-texture','rgba16float')];
 const code=UNIFORMS+`@group(0) @binding(1) var s0:texture_2d<f32>;
@group(0) @binding(2) var s1:texture_2d<f32>;
@group(0) @binding(3) var output:texture_storage_2d<rgba16float,write>;
fn s1B(position:vec2<f32>)->vec4<f32> {
 let size=vec2<i32>(u.size)/2;
 let p=clamp(position,vec2<f32>(0.0),vec2<f32>(size-vec2<i32>(1)));
 let q=vec2<i32>(floor(p)); let hi=min(q+vec2<i32>(1),size-vec2<i32>(1)); let f=fract(p);
 let a=textureLoad(s1,q,0); let b=textureLoad(s1,vec2<i32>(hi.x,q.y),0);
 let c=textureLoad(s1,vec2<i32>(q.x,hi.y),0); let d=textureLoad(s1,hi,0);
 return mix(mix(a,b,f.x),mix(c,d,f.x),f.y);
}
@compute @workgroup_size(8,8)
fn main(@builtin(global_invocation_id) gid:vec3<u32>) {
 if(any(gid.xy>=u.region.zw)) { return; }
 let atlas=gid.xy+u.region.xy;
 if(any(atlas>=textureDimensions(output))) { return; }
 let q=vec2<i32>(atlas); let p=q%vec2<i32>(u.size);
 let full=textureLoad(s0,p,0);
 let color=full+2.0*s1B((vec2<f32>(p)+vec2<f32>(0.5))*0.5-vec2<f32>(0.5));
 textureStore(output,q,color);
}
`;
 return {code,bindings,config:0};
}
function operation(op,{externalSource=false,tiled=true,compact=false,generic=false,storageTiles=false,genericStorage=false,stagedStorage=false,filteredSources=false,genericConcat=false,genericFlow=false}={}){
 const {type,out:o,inputs:ins}=op;
 if(type==='warp'&&genericFlow&&genericWarpEligible(op))return genericWarpShader(op);
 if(type==='refine'&&genericFlow&&genericRefineEligible(op))return genericRefineShader();
 if(type==='concat'&&genericConcat&&genericConcatEligible(op))return genericConcatShader(op);
 if(type==='conv'&&tiled&&compact&&storageTiles&&genericStorage){
  const r=ins[1],base=r&&(r.base||r);
  if(!op.residual||(r.offset||0)===0&&r.c===o.c&&base.c===o.c&&base.w===o.w&&base.h===o.h)return stagedStorage?stagedStorageConvolution(op):genericStorageConvolution(op);
 }
 if(type==='conv'&&!tiled&&compact&&generic&&(ins[0].offset||0)%4===0){
  // All fixed-model residuals are complete entry tensors. Preserve arbitrary
  // residual views through the existing specialized reader when needed.
  const r=ins[1],base=r&&(r.base||r);
  if(!op.residual||(r.offset||0)===0&&r.c===o.c&&base.c===o.c&&base.w===o.w&&base.h===o.h)return genericConvolution(op);
 }
 const bindings=[binding(0,'uniforms','uniform'),...ins.map((_,i)=>binding(i+1,'s'+i,'texture'))];
 let next=ins.length+1,code=UNIFORMS+ins.map((t,i)=>reader(t,'s'+i,i+1,
  type==='concat'?'C':type==='warp'&&i===0||type==='refine'&&i===1?'B':'V')).join(''),body='',config;
 if(type==='conv'){
  if(tiled)return compact?compactConvolution(op,code,bindings,next,storageTiles):tiledConvolution(op,code,bindings,next,storageTiles);
  const {layer:l,stride=1,deconv=false,residual=false}=op;
  const area=compact?'area':String(l.k*l.k),kernel=compact?'kernel':String(l.k),taps=compact?'taps':String(deconv?2:l.k);
  code+=`@group(0) @binding(${next}) var weights: texture_2d<f32>;\n`;
  bindings.push(binding(next++,'weights','texture'));
  // Scalar texture gathers are an alternative for drivers with expensive
  // workgroup-array lowering. Keep ci dynamic to prevent whole-model unrolling.
  if(compact){
   config=l.k|(stride<<4)|(deconv?256:0);
   body+=`let kernel=i32(u.debug&15u); let stride=i32((u.debug>>4u)&15u);
 let deconv=(u.debug&256u)!=0u; let area=kernel*kernel; let taps=select(kernel,2,deconv);
 `;
  }
  body+=`var total=textureLoad(weights,vec2<i32>(0,g),0);
 let ci=(i32(textureDimensions(weights).x)-2)/${area};
 for(var ic:i32=0;ic<ci;ic+=4) { for(var y:i32=0;y<${taps};y++) { for(var x:i32=0;x<${taps};x++) {
  ${compact?`var ky=y; var kx=x; var ip=p*stride+vec2<i32>(x-1,y-1);
  if(deconv) { ky=(p.y+1)%2+2*y; kx=(p.x+1)%2+2*x; ip=vec2<i32>((p.x+1-kx)/2,(p.y+1-ky)/2); }`:
   deconv?`let ky=(p.y+1)%2+2*y; let kx=(p.x+1)%2+2*x; let ip=vec2<i32>((p.x+1-kx)/2,(p.y+1-ky)/2);`:
   `let ky=y; let kx=x; let ip=p*${stride}+vec2<i32>(x-1,y-1);`}
  if(any(ip<vec2<i32>(0)) || any(ip>=s0Size())) { continue; }
  let v=s0V(ip,ic/4); let k=ky*${kernel}+kx; let ix=2+ic*${area}+k;
  total+=v.x*textureLoad(weights,vec2<i32>(ix,g),0);
  if(ic+1<ci) { total+=v.y*textureLoad(weights,vec2<i32>(ix+${area},g),0); }
  if(ic+2<ci) { total+=v.z*textureLoad(weights,vec2<i32>(ix+${compact?'area*2':2*l.k*l.k},g),0); }
  if(ic+3<ci) { total+=v.w*textureLoad(weights,vec2<i32>(ix+${compact?'area*3':3*l.k*l.k},g),0); }
 }}}
 `;
  if(residual)body+='total+=s1V(p,g);\n';
  if(l.slope)body+='total=max(total,vec4<f32>(0.0))+min(total,vec4<f32>(0.0))*textureLoad(weights,vec2<i32>(1,g),0);\n';
  body+='color=total;';
 }else if(type==='concat'){
  config=4;
  let offset=0;code+='fn pick(p:vec2<i32>, c:i32) -> f32 {\n';
  ins.forEach((t,i)=>{code+=`if(c<${offset+t.c}) { return s${i}C(p,c-${offset}); }\n`;offset+=t.c;});
  code+='return 0.0; }\n';body+='let c=g*4; for(var lane:u32=0u;lane<u.debug;lane++) { color[lane]=pick(p,c+i32(lane)); }';
 }else if(type==='warp'){
  body+='let f=s1V(p,0).xy; color=s0B(vec2<f32>(p)+f,g);';
 }else if(type==='refine'){
  body+='color=s0V(p,g)+2.0*s1B((vec2<f32>(p)+vec2<f32>(0.5))*0.5-vec2<f32>(0.5),g);';
 }else if(type==='head'){
  body+='let r=s0V(p,g); color=vec4<f32>(1.0/(1.0+exp(-clamp(r.x,-20.0,20.0))),r.yzw);';
 }else if(type==='phase'){
  body+='color=vec4<f32>(u.phase,0.0,0.0,0.0);';
 }else if(type==='preprocess'){
  const sourceFiltered=filteredSources&&!externalSource,usesSampler=externalSource||sourceFiltered;
  const sourceBinding=next++,samplerBinding=usesSampler?next++:null;
  code+=imageReader('source',sourceBinding,externalSource,usesSampler?{name:'imageSampler',binding:samplerBinding}:null,sourceFiltered);
  bindings.push(binding(sourceBinding,'source',externalSource?'external-texture':sourceFiltered?'filterable-texture':'texture'));
  if(usesSampler)bindings.push(binding(samplerBinding,'imageSampler','sampler'));
  body+=`if(any(vec2<u32>(p)>=u.activeSize)) { textureStore(output,q,vec4<f32>(0.0)); return; }
 let v=sourceB((vec2<f32>(p)+vec2<f32>(0.5))/vec2<f32>(u.activeSize)).rgb;
 color=vec4<f32>(v-vec3<f32>(0.5),0.0);`;
 }else throw new Error('Unknown fixed graph operation: '+type);
 bindings.push(binding(next,'output','storage-texture','rgba16float'));
 code+=`@group(0) @binding(${next}) var output: texture_storage_2d<rgba16float,write>;
@compute @workgroup_size(8,8)
fn main(@builtin(global_invocation_id) gid:vec3<u32>) {
 if(any(gid.xy>=u.region.zw)) { return; }
 let atlas=gid.xy+u.region.xy;
 if(any(atlas>=textureDimensions(output))) { return; }
 let q=vec2<i32>(atlas); let p=q%vec2<i32>(u.size);
 let g=q.x/i32(u.size.x)+q.y/i32(u.size.y)*${o.cols};
 if(g>=${o.groups}) { textureStore(output,q,vec4<f32>(0.0)); return; }
 var color=vec4<f32>(0.0);
 ${body}
 textureStore(output,q,color);
}
`;
 return {code,bindings,...(type==='conv'?{tiled:false}:{}),...(config===undefined?{}:{config})};
}
function synth(flow,raw,{externalSource=false,filteredSources=false}={}){
 const sourceFiltered=filteredSources&&!externalSource,usesSampler=externalSource||sourceFiltered;
 const imageKind=externalSource?'external-texture':sourceFiltered?'filterable-texture':'texture',outputBinding=usesSampler?6:5;
 const bindings=[binding(0,'uniforms','uniform'),binding(1,'flow','texture'),binding(2,'raw','texture'),binding(3,'prev',imageKind),binding(4,'curr',imageKind)];
 if(usesSampler)bindings.push(binding(5,'imageSampler','sampler'));
 bindings.push(binding(outputBinding,'output','storage-texture','rgba8unorm'));
 const sampler=usesSampler?{name:'imageSampler',binding:5}:null;
 const code=UNIFORMS+reader(flow,'flow',1,'B')+reader(raw,'raw',2,'B')+imageReader('prev',3,externalSource,sampler,sourceFiltered)+imageReader('curr',4,externalSource,sampler?{...sampler,declare:false}:null,sourceFiltered)+`
@group(0) @binding(${outputBinding}) var output: texture_storage_2d<rgba8unorm,write>;
fn finite(v:vec4<f32>) -> bool { return all((bitcast<vec4<u32>>(v)&vec4<u32>(0x7f800000u))!=vec4<u32>(0x7f800000u)); }
@compute @workgroup_size(8,8)
fn main(@builtin(global_invocation_id) gid:vec3<u32>) {
 if(any(gid.xy>=u.region.zw)) { return; }
 let atlas=gid.xy+u.region.xy;
 if(any(atlas>=u.outputSize) || any(atlas>=textureDimensions(output))) { return; }
 let q=vec2<i32>(atlas); let uv=(vec2<f32>(atlas)+vec2<f32>(0.5))/vec2<f32>(u.outputSize);
 let p=uv*vec2<f32>(u.activeSize)-vec2<f32>(0.5);
 let f=flowB(p,0); let r=rawB(p,0);
 if(!finite(f) || !finite(r)) { textureStore(output,q,vec4<f32>(prevB(uv).rgb,1.0)); return; }
 let mask=clamp(r.x,0.0,1.0);
 let a=uv+f.xy/vec2<f32>(u.activeSize); let b=uv+f.zw/vec2<f32>(u.activeSize);
 var v=prevB(clamp(a,vec2<f32>(0.0),vec2<f32>(1.0))).rgb*mask+currB(clamp(b,vec2<f32>(0.0),vec2<f32>(1.0))).rgb*(1.0-mask)+r.yzw;
 if(u.debug==1u) { v=vec3<f32>(clamp(vec2<f32>(0.5)+f.xy/24.0,vec2<f32>(0.0),vec2<f32>(1.0)),0.5); }
 if(u.debug==2u) { v=vec3<f32>(mask); }
 if(u.debug==3u) { v=clamp(vec3<f32>(0.5)+r.yzw*4.0,vec3<f32>(0.0),vec3<f32>(1.0)); }
 textureStore(output,q,vec4<f32>(clamp(v,vec3<f32>(0.0),vec3<f32>(1.0)),1.0));
}
`;
 return {code,bindings};
}
// One workgroup samples the exact 16x16 GLSL grid. Integer histograms are exact;
// the FP32 MAD sum uses a bounded tree reduction and only 16-byte readback.
function stats({externalSource=false,filteredSources=false}={}){
 const sourceFiltered=filteredSources&&!externalSource,usesSampler=externalSource||sourceFiltered;
 const imageKind=externalSource?'external-texture':sourceFiltered?'filterable-texture':'texture',outputBinding=usesSampler?4:3;
 const bindings=[binding(0,'uniforms','uniform'),binding(1,'prev',imageKind),binding(2,'curr',imageKind)];
 if(usesSampler)bindings.push(binding(3,'imageSampler','sampler'));
 bindings.push(binding(outputBinding,'output','storage-buffer'));
 const sampler=usesSampler?{name:'imageSampler',binding:3}:null;
 const code=UNIFORMS+imageReader('prev',1,externalSource,sampler,sourceFiltered)+imageReader('curr',2,externalSource,sampler?{...sampler,declare:false}:null,sourceFiltered)+`
@group(0) @binding(${outputBinding}) var<storage,read_write> output:vec4<f32>;
var<workgroup> histogram:array<atomic<u32>,32>;
var<workgroup> totals:array<vec2<f32>,32>;
@compute @workgroup_size(32)
fn main(@builtin(workgroup_id) wid:vec3<u32>,
        @builtin(local_invocation_index) lane:u32) {
 if(any(wid!=vec3<u32>(0u)) || any(u.outputSize==vec2<u32>(0u))) { return; }
 atomicStore(&histogram[lane],0u);
 workgroupBarrier();
 var sum=vec2<f32>(0.0); let samples=u.size.x*u.size.y;
 for(var i=lane;i<samples;i+=32u) {
  let uv=(vec2<f32>(f32(i%16u),f32(i/16u))+vec2<f32>(0.5))/16.0;
  let a=prevB(uv).rgb; let b=currB(uv).rgb;
  let la=dot(a,vec3<f32>(0.2126,0.7152,0.0722)); let lb=dot(b,vec3<f32>(0.2126,0.7152,0.0722));
  atomicAdd(&histogram[u32(min(15,i32(la*16.0)))],1u);
  atomicAdd(&histogram[16u+u32(min(15,i32(lb*16.0)))],1u);
  sum+=vec2<f32>(abs(la-lb),step(0.12,length(a-b)));
 }
 totals[lane]=sum;
 workgroupBarrier();
 for(var stride:u32=16u;stride>0u;stride/=2u) {
  if(lane<stride) { totals[lane]+=totals[lane+stride]; }
  workgroupBarrier();
 }
 if(lane==0u) {
  var hist=0.0;
  for(var i:u32=0u;i<16u;i++) { hist+=abs(f32(atomicLoad(&histogram[i]))-f32(atomicLoad(&histogram[i+16u]))); }
  output=vec4<f32>(totals[0].x/256.0,hist/512.0,totals[0].y/256.0,1.0);
 }
}
`;
 return {code,bindings};
}
const api={UNIFORMS,reader,imageReader,operation,synth,stats};
root.VENeuralWebGPUShaders=api;root.VENeuralWGSL=api;if(typeof module!=='undefined')module.exports=api;
})(globalThis);
