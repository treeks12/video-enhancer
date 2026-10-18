'use strict';
// Host contract checks only. Real WGSL compilation and arithmetic need WebGPU.
const assert=require('node:assert/strict');
const G=require('../neural/graph.js'),S=require('../neural/webgpu-shaders.js');
const layer=(ci,co,k=3,slope=true)=>({ci,co,k,slope:slope?{}:null});
const model={
 encoder:[[3,24],[24,24],[24,36],[36,36],[36,54],[54,54],[54,72],[72,72]].map(([ci,co])=>layer(ci,co)),
 decoder:[[145,144,58],[166,162,40],[112,108,28],[76,72,8]].map(([ci,c,co])=>({
  entry:layer(ci,c),r1:layer(c,c),s1:layer(24,24),r2:layer(c,c),s2:layer(24,24),r3:layer(c,c),up:layer(c,co,4,false),
 })),
};
function graph(w,h){
 const enc=G.encoder(model,{w,h}),dec=G.decoder(model,enc.features,enc.features);
 return {...dec,ops:[...enc.graph.ops,...dec.graph.ops]};
}
function contract(desc){
 assert.equal(typeof desc.code,'string');assert.ok(desc.code.includes('fn main('));
 assert.deepEqual(desc.bindings.map(b=>b.binding),desc.bindings.map((_,i)=>i),'contiguous binding numbers');
 const declared=[...desc.code.matchAll(/@binding\((\d+)\)/g)].map(m=>Number(m[1])).sort((a,b)=>a-b);
 assert.deepEqual(declared,desc.bindings.map(b=>b.binding),'descriptor matches every WGSL resource');
 assert.deepEqual(desc.bindings[0],{binding:0,name:'uniforms',kind:'uniform'});
 // `active` is reserved even for structure members; the packed field is activeSize.
 assert.doesNotMatch(desc.code,/\bactive\b/);
 if(desc.bindings.some(binding=>binding.kind==='external-texture')){
  assert.equal(desc.bindings.filter(binding=>binding.kind==='sampler').length,1,'external images share one filtering sampler');
  assert.match(desc.code,/textureSampleBaseClampToEdge/);
 }else if(desc.bindings.some(binding=>binding.kind==='filterable-texture')){
  assert.equal(desc.bindings.filter(binding=>binding.kind==='sampler').length,1,'filtered RGBA sources share one filtering sampler');
  assert.match(desc.code,/textureSampleLevel\(/);
 }else assert.doesNotMatch(desc.code,/textureSample|sampler/,'manual interpolation supports unfilterable f32 weights');
}
const a=graph(64,48),b=graph(128,96);
assert.equal(a.ops.length,b.ops.length);
const types=new Set(),genericSources=new Set(),genericStorageSources=new Set(),genericStorageInputChannels=new Set(),genericStorageFallbackSources=new Set(),genericStorageByFlags=new Map(),genericStorageBindingSignatures=new Set(),genericConcatSources=new Set(),genericConcatBindingSignatures=new Set(),genericWarpSources=new Set(),genericWarpBindingSignatures=new Set(),genericRefineSources=new Set(),genericRefineBindingSignatures=new Set(),genericWarpOffsets=new Set();
let genericConcatCount=0,genericWarpCount=0,genericRefineCount=0,sawGenericWarp54=false;
let sawGenericStorageOffset138=false,sawGenericStorageResidual162=false;
for(let i=0;i<a.ops.length;i++){
 const op=a.ops[i],desc=S.operation(op);types.add(op.type);contract(desc);
 assert.equal(desc.code,S.operation(b.ops[i]).code,'spatial resize reuses the same shader source');
 assert.deepEqual(desc.bindings.at(-1),{binding:desc.bindings.length-1,name:'output',kind:'storage-texture',format:'rgba16float'});
 assert.match(desc.code,/@workgroup_size\(8,8\)/);
 const expectedReaders=[];
 op.inputs.forEach((input,index)=>{
  const mode=op.type==='concat'?'C':op.type==='warp'&&index===0||op.type==='refine'&&index===1?'B':'V';
  if(mode==='C')expectedReaders.push('s'+index+'C');
  if(mode!=='C')expectedReaders.push('s'+index+'V');
  if(mode==='B')expectedReaders.push('s'+index+'B');
 });
 assert.deepEqual([...desc.code.matchAll(/fn (s\d+[CVB])\(/g)].map(match=>match[1]).sort(),expectedReaders.sort(),'operation source contains only its required reader dependency closure');
 if(op.type==='concat'){
  assert.equal(desc.config,4);assert.match(desc.code,/lane<u.debug/);
  assert.equal((desc.code.match(/pick\(p,c\+i32\(lane\)\)/g)||[]).length,1,'concat emits one call site inside a uniform-bound lane loop');
  assert.deepEqual(S.operation(op,{genericConcat:false}),desc,'the opt-in flag leaves default concat byte-identical');
  const genericConcat=S.operation(op,{genericConcat:true});contract(genericConcat);
  genericConcatCount++;genericConcatSources.add(genericConcat.code);genericConcatBindingSignatures.add(JSON.stringify(genericConcat.bindings));
  assert.deepEqual(genericConcat.bindings.map(item=>item.name),['uniforms','s0','s1','s2','s3','s4','output']);
  assert.deepEqual(genericConcat.bindings.map(item=>item.kind),['uniform','texture','texture','texture','texture','texture','storage-texture']);
  assert.deepEqual(genericConcat.bindings.at(-1),{binding:6,name:'output',kind:'storage-texture',format:'rgba16float'});
  const packed=op.inputs.map(input=>((input.c|((input.offset||0)<<16))>>>0));
  assert.equal(genericConcat.config,packed[0]);
  assert.deepEqual(genericConcat.concatLayout,{active:[packed[1]||0,packed[2]||0],outputSize:[packed[3]||0,packed[4]||0]});
  assert.deepEqual(genericConcat,S.operation(b.ops[i],{genericConcat:true}),'generic concat separates spatial metadata from reusable WGSL');
  assert.doesNotMatch(genericConcat.code,/u\.phase/,'concat metadata does not use the phase uniform');
  assert.doesNotMatch(genericConcat.code,/\}\n,@group/,'generic reader declarations are concatenated as valid WGSL');
  assert.match(genericConcat.code,/textureDimensions\(output\)\.x\/u\.size\.x/);
  assert.match(genericConcat.code,/let channels=i32\(u\.debug&65535u\)\+i32\(u\.activeSize\.x&65535u\)\+i32\(u\.activeSize\.y&65535u\)\+i32\(u\.outputSize\.x&65535u\)\+i32\(u\.outputSize\.y&65535u\)/);
  assert.match(genericConcat.code,/let channel=c\+i32\(info>>16u\)/);
  assert.match(genericConcat.code,/if\(c<0 \|\| c>=channels\) \{ return 0\.0; \}/);
  assert.match(genericConcat.code,/textureLoad\(s0,[^;]+\)\[u32\(channel%4\)\]/);
  assert.match(genericConcat.code,/if\(c\+i32\(lane\)<channels\)/);
  assert.match(genericConcat.code,/var color=vec4<f32>\(0\.0\)/,'padded output lanes begin as zero');
 }
 if(op.type==='warp'){
  assert.deepEqual(S.operation(op,{genericFlow:false}),desc,'genericFlow disabled keeps the existing warp shader');
  const genericFlow=S.operation(op,{genericFlow:true});contract(genericFlow);
  genericWarpCount++;genericWarpSources.add(genericFlow.code);genericWarpBindingSignatures.add(JSON.stringify(genericFlow.bindings));
  const flowOffset=op.inputs[1].offset??0;genericWarpOffsets.add(flowOffset);
  assert.equal(genericFlow.config,op.out.c);
  assert.deepEqual(genericFlow.readerLayout,{active:[0,0],outputSize:[flowOffset,0]});
  assert.deepEqual(genericFlow.bindings.map(item=>item.name),['uniforms','s0','s1','output']);
  assert.deepEqual(genericFlow.bindings.map(item=>item.kind),['uniform','texture','texture','storage-texture']);
  assert.deepEqual(genericFlow.bindings.at(-1),{binding:3,name:'output',kind:'storage-texture',format:'rgba16float'});
  assert.equal(genericFlow.code,S.operation(b.ops[i],{genericFlow:true}).code,'generic warp source is reused across spatial resize');
  assert.match(genericFlow.code,/textureDimensions\(s0\)\.x\/u\.size\.x/);
  assert.match(genericFlow.code,/textureDimensions\(output\)\.x\/u\.size\.x/);
  assert.match(genericFlow.code,/let sampled=textureLoad\(s1,flowP,0\)/);
  assert.match(genericFlow.code,/if\(u\.outputSize\.x==2u\) \{ flow=sampled\.zw; \}/);
  assert.match(genericFlow.code,/fn s0B\(position:vec2<f32>,g:i32\)/);
  assert.match(genericFlow.code,/s0V\(q\+vec2<i32>\(1,0\),g\)/);
  assert.match(genericFlow.code,/s0V\(q\+vec2<i32>\(0,1\),g\)/);
  assert.match(genericFlow.code,/s0V\(q\+vec2<i32>\(1,1\),g\)/);
  assert.match(genericFlow.code,/let channels=i32\(u\.debug\)/);
  assert.match(genericFlow.code,/if\(first\+4>channels\)/,'the vector reader masks the last partial output group');
  assert.match(genericFlow.code,/if\(g>=\(channels\+3\)\/4\)/,'unused output atlas groups are zeroed');
  if(op.out.c===54){sawGenericWarp54=true;assert.match(genericFlow.code,/vec4<i32>\(channels\)/,'54-channel warp masks its two padded lanes');}
 }
 if(op.type==='refine'){
  assert.deepEqual(S.operation(op,{genericFlow:false}),desc,'genericFlow disabled keeps the existing refine shader');
  const genericFlow=S.operation(op,{genericFlow:true});contract(genericFlow);
  genericRefineCount++;genericRefineSources.add(genericFlow.code);genericRefineBindingSignatures.add(JSON.stringify(genericFlow.bindings));
  assert.equal(genericFlow.config,0);assert.equal(genericFlow.readerLayout,undefined);
  assert.deepEqual(genericFlow.bindings.map(item=>item.name),['uniforms','s0','s1','output']);
  assert.deepEqual(genericFlow.bindings.map(item=>item.kind),['uniform','texture','texture','storage-texture']);
  assert.deepEqual(genericFlow.bindings.at(-1),{binding:3,name:'output',kind:'storage-texture',format:'rgba16float'});
  assert.equal(genericFlow.code,S.operation(b.ops[i],{genericFlow:true}).code,'generic refine source is reused across spatial resize');
  assert.match(genericFlow.code,/let full=textureLoad\(s0,p,0\)/);
  assert.match(genericFlow.code,/size=vec2<i32>\(u\.size\)\/2/);
  assert.match(genericFlow.code,/textureLoad\(s1,q,0\)/);assert.match(genericFlow.code,/textureLoad\(s1,vec2<i32>\(hi\.x,q\.y\),0\)/);
  assert.match(genericFlow.code,/textureLoad\(s1,vec2<i32>\(q\.x,hi\.y\),0\)/);assert.match(genericFlow.code,/textureLoad\(s1,hi,0\)/);
  assert.match(genericFlow.code,/\(vec2<f32>\(p\)\+vec2<f32>\(0\.5\)\)\*0\.5-vec2<f32>\(0\.5\)/);
 }
 if(op.type==='conv'){
  assert.equal(desc.tiled,true);
  assert.match(desc.code,/let ci=\(i32\(textureDimensions\(weights\)\.x\)-2\)/,'dynamic loop bounds avoid huge compiler expansion');
  assert.match(desc.code,/ic<ci/);
  const scalar=S.operation(op,{tiled:false});contract(scalar);
  assert.equal(scalar.tiled,false);assert.doesNotMatch(scalar.code,/var<workgroup>|workgroupBarrier/);
  assert.match(scalar.code,/ic<ci/);assert.equal(scalar.code,S.operation(b.ops[i],{tiled:false}).code);
  const compact=S.operation(op,{compact:true});contract(compact);
  assert.equal(compact.tiled,true);
  assert.equal(compact.config,op.layer.k|((op.stride||1)<<4)|(op.deconv?256:0));
  assert.equal(compact.code,S.operation(b.ops[i],{compact:true}).code);
  assert.match(compact.code,/let kernel=i32\(u.debug&15u\)/);
  assert.match(compact.code,/y<taps/);assert.match(compact.code,/x<taps/);
  assert.match(compact.code,/i<u32\(tile\*tile\)/);assert.match(compact.code,/i<u32\(area\*4\)/);
  assert.match(compact.code,/inputTile:array<vec4<f32>,324>/);
  assert.match(compact.code,/weightTile:array<vec4<f32>,64>/);
  assert.ok((324+64+2)*16<=16384,'compact workgroup arrays fit the portable memory minimum');
  const scalarCompact=S.operation(op,{tiled:false,compact:true});contract(scalarCompact);
  assert.equal(scalarCompact.tiled,false);assert.equal(scalarCompact.config,compact.config);
  assert.doesNotMatch(scalarCompact.code,/var<workgroup>|workgroupBarrier/);
  assert.match(scalarCompact.code,/let kernel=i32\(u.debug&15u\)/);
  assert.match(scalarCompact.code,/y<taps/);assert.match(scalarCompact.code,/x<taps/);
  assert.equal(scalarCompact.code,S.operation(b.ops[i],{tiled:false,compact:true}).code);
  const generic=S.operation(op,{tiled:false,compact:true,generic:true});contract(generic);genericSources.add(generic.code);
  const inputBase=G.baseOf(op.inputs[0]);
  if((op.inputs[0].offset||0)%4===0){
   assert.deepEqual(generic.convLayout,{active:[inputBase.cols,Math.ceil(inputBase.groups/inputBase.cols)],outputSize:[op.inputs[0].offset||0,op.out.c]});
   assert.equal(generic.config,compact.config|(op.layer.slope?512:0));
   assert.doesNotMatch(generic.code,/fn s0C|offset%4/,'aligned generic source has one vector load and no misaligned branch');
  }else{
   assert.equal(op.inputs[0].offset,138,'two trained side convolutions use a misaligned 162-channel base view');
   assert.equal(generic.convLayout,undefined);assert.equal(generic.code,scalarCompact.code);
  }
  assert.equal(generic.tiled,false);
  assert.doesNotMatch(generic.code,/var<workgroup>|workgroupBarrier/);
  assert.equal(generic.code,S.operation(b.ops[i],{tiled:false,compact:true,generic:true}).code);
  const storage=S.operation(op,{storageTiles:true});contract(storage);
  const tile=op.deconv?6:8*(op.stride||1)+2,groupStride=tile*tile+4*op.layer.k*op.layer.k;
  assert.equal(storage.tiled,true);assert.equal(storage.scratchBytes,Math.ceil(op.out.w/8)*Math.ceil(op.out.h/8)*op.out.groups*groupStride*16);
  assert.equal(storage.bindings.at(-2).name,'scratch');assert.equal(storage.bindings.at(-2).kind,'storage-buffer');
  assert.doesNotMatch(storage.code,/var<workgroup>|workgroupBarrier/,'storage tile kernels have no workgroup arrays to initialize');
  assert.match(storage.code,/storageBarrier\(\)/);assert.match(storage.code,/var total=textureLoad\(weights/);
  assert.match(storage.code,/wid.z\*blocks.y\+wid.y\)\*blocks.x\+wid.x/);
  assert.equal(storage.code,S.operation(b.ops[i],{storageTiles:true}).code,'scratch capacity belongs to each operation rather than source');
  const compactStorage=S.operation(op,{storageTiles:true,compact:true});contract(compactStorage);
  const compactTile=op.deconv?6:8*(op.stride||1)+2,compactStride=compactTile*compactTile+4*op.layer.k*op.layer.k;
  assert.equal(compactStorage.tiled,true);
  assert.equal(compactStorage.config,op.layer.k|((op.stride||1)<<4)|(op.deconv?256:0));
  assert.equal(compactStorage.scratchBytes,Math.ceil(op.out.w/8)*Math.ceil(op.out.h/8)*op.out.groups*compactStride*16);
  assert.equal(compactStorage.bindings.at(-3).name,'weights');
  assert.equal(compactStorage.bindings.at(-2).name,'scratch');assert.equal(compactStorage.bindings.at(-2).kind,'storage-buffer');
  assert.deepEqual(compactStorage.bindings.at(-1),{binding:compactStorage.bindings.length-1,name:'output',kind:'storage-texture',format:'rgba16float'});
  assert.doesNotMatch(compactStorage.code,/var<workgroup>|workgroupBarrier/,'compact storage kernels avoid workgroup initialization arrays');
  assert.equal((compactStorage.code.match(/storageBarrier\(\)/g)||[]).length,2,'each dynamic channel tile has before/after reuse barriers');
  assert.match(compactStorage.code,/let kernel=i32\(u.debug&15u\); let stride=i32\(\(u.debug>>4u\)&15u\)/);
  assert.match(compactStorage.code,/let deconv=\(u.debug&256u\)!=0u; let area=kernel\*kernel/);
  assert.match(compactStorage.code,/let tile=select\(8\*stride\+2,6,deconv\); let taps=select\(kernel,2,deconv\)/);
  assert.match(compactStorage.code,/for\(var y:i32=0;y<taps;y\+\+\).*for\(var x:i32=0;x<taps;x\+\+\)/s);
  assert.match(compactStorage.code,/for\(var i=lane;i<u32\(tile\*tile\);i\+=64u\)/);
  assert.match(compactStorage.code,/for\(var i=lane;i<u32\(area\*4\);i\+=64u\)/);
  assert.match(compactStorage.code,/if\(all\(ip>=vec2<i32>\(0\)\) && all\(ip<inputSize\)\)/);
  assert.match(compactStorage.code,/if\(ic\+i32\(i\)\/area<ci\)/);
  assert.match(compactStorage.code,/let blocks=\(u.region.zw\+vec2<u32>\(7u\)\)\/8u/);
  assert.match(compactStorage.code,/let inputBase=\(\(wid.z\*blocks.y\+wid.y\)\*blocks.x\+wid.x\)\*u32\(tile\*tile\+area\*4\)/);
  assert.match(compactStorage.code,/let weightBase=inputBase\+u32\(tile\*tile\)/);
  const scratchIndices=[...compactStorage.code.matchAll(/scratch\[([^\]]+)\]/g)].map(match=>match[1]);
  assert.equal(scratchIndices.length,7);
  assert.ok(scratchIndices.every(index=>(index.startsWith('inputBase+')||index.startsWith('weightBase+'))&&!index.includes('i32(')),
   'scratch bases and offsets remain u32');
  assert.match(compactStorage.code,/var total=textureLoad\(weights,vec2<i32>\(0,g\),0\)/);
  if(op.residual)assert.match(compactStorage.code,/total\+=s1V\(p,g\)/);
  else assert.doesNotMatch(compactStorage.code,/total\+=s1V\(p,g\)/);
  if(op.layer.slope)assert.match(compactStorage.code,/total=max\(total,vec4<f32>\(0\.0\)\)\+min\(total,vec4<f32>\(0\.0\)\)\*slope/);
  else assert.doesNotMatch(compactStorage.code,/\*slope/);
  assert.equal(compactStorage.code,S.operation(b.ops[i],{storageTiles:true,compact:true}).code,'compact storage source is reused across spatial resize');
  const genericStorage=S.operation(op,{storageTiles:true,compact:true,genericStorage:true});contract(genericStorage);
  const input=op.inputs[0],genericInputBase=G.baseOf(input),inputOffset=input.offset||0,r=op.inputs[1],rBase=r&&G.baseOf(r);
  const residualCompatible=!op.residual||(r.offset||0)===0&&r.c===op.out.c&&rBase.c===op.out.c&&rBase.w===op.out.w&&rBase.h===op.out.h;
  const genericStorageEligible=residualCompatible;
  if(inputOffset===138)sawGenericStorageOffset138=true;
  if(genericStorageEligible){
   genericStorageSources.add(genericStorage.code);genericStorageInputChannels.add(input.c);
   genericStorageBindingSignatures.add(JSON.stringify(genericStorage.bindings));
   const flagKey=`${!!op.residual}:${!!op.layer.slope}`;
   if(!genericStorageByFlags.has(flagKey))genericStorageByFlags.set(flagKey,new Set());
   genericStorageByFlags.get(flagKey).add(genericStorage.code);
   assert.deepEqual(genericStorage.convLayout,{active:[genericInputBase.cols,Math.ceil(genericInputBase.groups/genericInputBase.cols)],outputSize:[inputOffset,op.out.c]});
   assert.equal(genericStorage.config,compactStorage.config|(op.layer.slope?512:0)|(op.residual?1024:0));
   assert.equal(genericStorage.scratchBytes,compactStorage.scratchBytes);
   assert.deepEqual(genericStorage.bindings.map(item=>item.name),['uniforms','s0','s1','weights','scratch','output']);
   assert.deepEqual(genericStorage.bindings.slice(1,3).map(item=>item.kind),['texture','texture']);
   assert.match(genericStorage.code,/let k=g\+i32\(u.outputSize.x\/4u\); let shift=u.outputSize.x%4u/);
   assert.match(genericStorage.code,/if\(shift==0u\) \{ return a; \}/);
   assert.match(genericStorage.code,/let b=textureLoad\(s0,q\+vec2<i32>\(\(k\+1\)%columns,\(k\+1\)\/columns\)\*size,0\)/);
   assert.match(genericStorage.code,/switch shift \{/);
   assert.match(genericStorage.code,/case 1u: \{ return vec4<f32>\(a\.yzw,b\.x\); \}/);
   assert.match(genericStorage.code,/case 2u: \{ return vec4<f32>\(a\.zw,b\.xy\); \}/);
   assert.match(genericStorage.code,/default: \{ return vec4<f32>\(a\.w,b\.xyz\); \}/);
   assert.match(genericStorage.code,/let columns=i32\(u.activeSize.x\)/);
   assert.match(genericStorage.code,/let outputCols=i32\(textureDimensions\(output\)\.x\/u.size.x\)/);
   assert.match(genericStorage.code,/g<i32\(textureDimensions\(weights\)\.y\)/);
   assert.match(genericStorage.code,/if\(\(u.debug&1024u\)!=0u\)\{total\+=s1V\(p,g\);\}/);
   assert.match(genericStorage.code,/if\(\(u.debug&512u\)!=0u\)\{total=max\(total,vec4<f32>\(0\.0\)\)\+min\(total,vec4<f32>\(0\.0\)\)\*slope;\}/);
   assert.match(genericStorage.code,/let slope=textureLoad\(weights,vec2<i32>\(1,g\),0\)/);
   const inputReaderStart=genericStorage.code.indexOf('fn s0V'),inputReaderEnd=genericStorage.code.indexOf('\n}\n',inputReaderStart)+3;
   const inputReader=genericStorage.code.slice(inputReaderStart,inputReaderEnd);
   assert.doesNotMatch(inputReader,/s0Pick|\b(?:a|b)\s*\[[^\]]+\]/,'unaligned channel shuffle uses fixed swizzles, without dynamic lane indexing');
   assert.doesNotMatch(inputReader,/first\+4>channels|first\+4/,
    'generic input lanes rely on ci guards instead of a static tail mask');
   assert.doesNotMatch(genericStorage.code,/g<\d+\b/,'generic output group bounds are dynamic');
   assert.match(genericStorage.code,/if\(ic\+1<ci\)/);assert.match(genericStorage.code,/if\(ic\+2<ci\)/);assert.match(genericStorage.code,/if\(ic\+3<ci\)/);
   if(op.residual&&op.out.c===162){
    sawGenericStorageResidual162=true;
    assert.match(genericStorage.code,/let first=group\*4; let channels=i32\(u.outputSize.y\)/);
    assert.match(genericStorage.code,/if\(first\+4>channels\) \{ v\*=select\(vec4<f32>\(0\.0\),vec4<f32>\(1\.0\),vec4<i32>\(first\)\+vec4<i32>\(0,1,2,3\)<vec4<i32>\(channels\)\); \}/,
     'the generic residual reader zeroes padded lanes using the dynamic channel count');
   }
   if(inputOffset===138)assert.equal(genericStorage.convLayout.outputSize[0],138,'offset 138 is handled by the generic storage reader');
   assert.equal(genericStorage.code,S.operation(b.ops[i],{storageTiles:true,compact:true,genericStorage:true}).code,
    'generic storage source is reused across spatial resize');
  }else{
   genericStorageFallbackSources.add(genericStorage.code);
   assert.ok(op.residual&&!residualCompatible,'only incompatible residual views use the specialized fallback');
   assert.equal(genericStorage.code,compactStorage.code,'unaligned inputs and residual views keep the specialized storage source');
   assert.equal(genericStorage.convLayout,undefined);
  }
 }
}
assert.equal(genericStorageSources.size,1,`generic storage emits one source variant (got ${genericStorageSources.size})`);
assert.equal(genericStorageBindingSignatures.size,1,'every generic convolution shares the same binding names and layout');
for(const [flags,sources] of genericStorageByFlags)assert.equal(sources.size,1,`generic storage source is shared across channels for residual/slope ${flags}`);
assert.ok(genericStorageInputChannels.has(3),'generic storage exercises the ci=3 tail guard');
assert.ok(genericStorageInputChannels.has(145),'generic storage exercises the ci=145 tail guard');
assert.ok(sawGenericStorageOffset138,'the real graph includes the offset-138 generic reader');
assert.ok(sawGenericStorageResidual162,'the real graph covers the 162-channel residual padding mask');
assert.equal(genericStorageFallbackSources.size,0,'the fixed graph has no incompatible residual-view fallback');
assert.equal(genericConcatCount,12,'the fixed graph has twelve concat operations');
assert.equal(genericConcatSources.size,1,`generic concat emits one source variant (got ${genericConcatSources.size})`);
assert.equal(genericConcatBindingSignatures.size,1,'all generic concat operations share one fixed binding signature');
for(let count=1;count<=5;count++){
 const fixture=new G.Graph(),inputs=[];
 for(let i=0;i<count;i++){
  const channels=i%2?2:1,offset=i%2?4:2,base=fixture.tensor(9,6,offset+channels+3);
  inputs.push(G.view(base,offset,channels));
 }
 fixture.concat(inputs);
 const op=fixture.ops[0],desc=S.operation(op,{genericConcat:true});contract(desc);
 const packed=inputs.map(input=>((input.c|((input.offset||0)<<16))>>>0));
 assert.equal(desc.config,packed[0]);
 assert.deepEqual(desc.concatLayout,{active:[packed[1]||0,packed[2]||0],outputSize:[packed[3]||0,packed[4]||0]});
 assert.ok(genericConcatSources.has(desc.code),'1-5 input counts share the model generic concat source');
 assert.deepEqual(desc.bindings.map(item=>item.name),['uniforms','s0','s1','s2','s3','s4','output']);
 assert.ok(desc.code.includes('if(c+i32(lane)<channels)'),'output channels are checked before sampling each packed lane');
}
function assertGenericConcatFallback(fixture,inputs,w,h,c,label){
 fixture.op('concat',inputs,w,h,c);const op=fixture.ops.at(-1),normal=S.operation(op),requested=S.operation(op,{genericConcat:true});
 assert.deepEqual(requested,normal,`${label} keeps the existing specialized concat path`);
 assert.equal(requested.concatLayout,undefined);
}
const manyInputsGraph=new G.Graph(),manyInputs=Array.from({length:6},()=>manyInputsGraph.tensor(8,4,1));
assertGenericConcatFallback(manyInputsGraph,manyInputs,8,4,6,'more than five inputs');
const largeChannelGraph=new G.Graph(),largeChannel=largeChannelGraph.tensor(8,4,65536);
assertGenericConcatFallback(largeChannelGraph,[largeChannel],8,4,65536,'channel count above 16 bits');
const largeOffsetGraph=new G.Graph(),largeOffsetBase=largeOffsetGraph.tensor(8,4,65537),largeOffset=G.view(largeOffsetBase,65536,1);
assertGenericConcatFallback(largeOffsetGraph,[largeOffset],8,4,1,'offset above 16 bits');
const invalidOffsetGraph=new G.Graph(),invalidOffsetBase=invalidOffsetGraph.tensor(8,4,4),invalidOffset={...G.view(invalidOffsetBase,0,2),offset:NaN};
assertGenericConcatFallback(invalidOffsetGraph,[invalidOffset],8,4,2,'non-integer offset');
const mismatchedSpatialGraph=new G.Graph(),spatialA=mismatchedSpatialGraph.tensor(8,4,2),spatialB=mismatchedSpatialGraph.tensor(9,4,2);
assertGenericConcatFallback(mismatchedSpatialGraph,[spatialA,spatialB],8,4,4,'input spatial dimensions differ from output');
const badViewGraph=new G.Graph(),badViewBase=badViewGraph.tensor(8,4,4),badView={...G.view(badViewBase,0,2),offset:3};
assertGenericConcatFallback(badViewGraph,[badView],8,4,2,'input view exceeds base channels');
const wrongOutputGraph=new G.Graph(),wrongOutput=wrongOutputGraph.tensor(8,4,2);
assertGenericConcatFallback(wrongOutputGraph,[wrongOutput],8,4,3,'output channels do not equal the input sum');
assert.equal(genericWarpCount,6,'the fixed graph has six eligible warps');
assert.equal(genericWarpSources.size,1,`generic warp emits one source variant (got ${genericWarpSources.size})`);
assert.equal(genericWarpBindingSignatures.size,1,'all generic warps share one fixed binding signature');
assert.deepEqual([...genericWarpOffsets].sort((x,y)=>x-y),[0,2],'generic warp covers both packed flow halves');
assert.ok(sawGenericWarp54,'the generic warp reader covers the 54-channel padded output');
assert.equal(genericRefineCount,3,'the fixed graph has three eligible refinements');
assert.equal(genericRefineSources.size,1,`generic refine emits one source variant (got ${genericRefineSources.size})`);
assert.equal(genericRefineBindingSignatures.size,1,'all generic refinements share one fixed binding signature');
function assertGenericFlowFallback(fixture,type,inputs,w,h,c,label){
 fixture.op(type,inputs,w,h,c);const op=fixture.ops.at(-1),normal=S.operation(op),requested=S.operation(op,{genericFlow:true});
 assert.deepEqual(requested,normal,`${label} keeps the existing specialized shader`);
 assert.equal(requested.readerLayout,undefined);
}
const sourceViewGraph=new G.Graph(),sourceViewBase=sourceViewGraph.tensor(8,4,8),sourceView=G.view(sourceViewBase,4,4),sourceViewFlowBase=sourceViewGraph.tensor(8,4,4),sourceViewFlow=G.view(sourceViewFlowBase,0,2);
assertGenericFlowFallback(sourceViewGraph,'warp',[sourceView,sourceViewFlow],8,4,4,'warp source view');
const flowOffsetGraph=new G.Graph(),flowOffsetSource=flowOffsetGraph.tensor(8,4,4),flowOffsetBase=flowOffsetGraph.tensor(8,4,4),flowOffset=G.view(flowOffsetBase,1,2);
assertGenericFlowFallback(flowOffsetGraph,'warp',[flowOffsetSource,flowOffset],8,4,4,'flow offset other than zero or two');
const flowSpatialGraph=new G.Graph(),flowSpatialSource=flowSpatialGraph.tensor(8,4,4),flowSpatialBase=flowSpatialGraph.tensor(8,5,4),flowSpatial=G.view(flowSpatialBase,0,2);
assertGenericFlowFallback(flowSpatialGraph,'warp',[flowSpatialSource,flowSpatial],8,4,4,'warp input spatial mismatch');
const refineViewGraph=new G.Graph(),refineViewBase=refineViewGraph.tensor(8,4,8),refineView=G.view(refineViewBase,4,4),refinePrior=refineViewGraph.tensor(4,2,4);
assertGenericFlowFallback(refineViewGraph,'refine',[refineView,refinePrior],8,4,4,'refine input offset other than zero');
const refineScaleGraph=new G.Graph(),refineScaleFull=refineScaleGraph.tensor(8,4,4),refineScalePrior=refineScaleGraph.tensor(3,2,4);
assertGenericFlowFallback(refineScaleGraph,'refine',[refineScaleFull,refineScalePrior],8,4,4,'refine scale other than two');
assert.deepEqual([...types].sort(),['concat','conv','head','phase','preprocess','refine','warp']);
assert.equal(genericSources.size,3,'trained convolutions share aligned normal/residual sources and one offset-138 fallback');
const preprocess=S.operation(a.ops[0]);
assert.equal(a.ops[0].type,'preprocess');
const manualPreprocess=S.operation(a.ops[0],{filteredSources:false});
assert.equal(preprocess.code,manualPreprocess.code);assert.deepEqual(preprocess.bindings,manualPreprocess.bindings);
const filteredPreprocess=S.operation(a.ops[0],{filteredSources:true});contract(filteredPreprocess);
assert.deepEqual(filteredPreprocess.bindings.map(x=>x.name),['uniforms','source','imageSampler','output']);
assert.deepEqual(filteredPreprocess.bindings.map(x=>x.kind),['uniform','filterable-texture','sampler','storage-texture']);
assert.match(filteredPreprocess.code,/@binding\(1\) var source: texture_2d<f32>/);
assert.match(filteredPreprocess.code,/textureSampleLevel\(source,imageSampler,uv,0\.0\)/);
assert.equal((filteredPreprocess.code.match(/var imageSampler: sampler/g)||[]).length,1);
assert.doesNotMatch(filteredPreprocess.code,/textureLoad\(source,/);
const externalPreprocess=S.operation(a.ops[0],{externalSource:true});
assert.deepEqual(S.operation(a.ops[0],{externalSource:true,filteredSources:true}),externalPreprocess,
 'external source sampling takes precedence over filteredSources');
for(const op of a.ops.slice(1)){
 const manual=S.operation(op),filteredOption=S.operation(op,{filteredSources:true});
 assert.equal(filteredOption.code,manual.code,`${op.type} keeps its manual tensor readers`);
 assert.deepEqual(filteredOption.bindings,manual.bindings,`${op.type} tensor descriptors stay unfilterable`);
 assert.ok(filteredOption.bindings.filter(x=>x.name==='weights'||x.name.startsWith('s')).every(x=>x.kind==='texture'));
}
const composition=S.synth(a.flow,a.raw);contract(composition);
assert.equal(composition.code,S.synth(b.flow,b.raw).code);
assert.deepEqual(composition.bindings.map(x=>x.name),['uniforms','flow','raw','prev','curr','output']);
assert.equal(composition.bindings.at(-1).format,'rgba8unorm');
const manualComposition=S.synth(a.flow,a.raw,{filteredSources:false});
assert.equal(composition.code,manualComposition.code);assert.deepEqual(composition.bindings,manualComposition.bindings);
const filteredComposition=S.synth(a.flow,a.raw,{filteredSources:true});contract(filteredComposition);
assert.deepEqual(filteredComposition.bindings.map(x=>x.name),['uniforms','flow','raw','prev','curr','imageSampler','output']);
assert.deepEqual(filteredComposition.bindings.map(x=>x.kind),['uniform','texture','texture','filterable-texture','filterable-texture','sampler','storage-texture']);
assert.match(filteredComposition.code,/textureSampleLevel\(prev,imageSampler,uv,0\.0\)/);
assert.match(filteredComposition.code,/textureSampleLevel\(curr,imageSampler,uv,0\.0\)/);
assert.equal((filteredComposition.code.match(/var imageSampler: sampler/g)||[]).length,1,'prev and curr share one sampler declaration');
assert.ok(filteredComposition.bindings.filter(x=>x.name==='flow'||x.name==='raw').every(x=>x.kind==='texture'));
assert.match(filteredComposition.code,/fn flowV\([\s\S]*?textureLoad\(flow,/);
assert.match(filteredComposition.code,/fn rawV\([\s\S]*?textureLoad\(raw,/);
assert.doesNotMatch(filteredComposition.code,/textureSampleLevel\((?:flow|raw),/);
const externalComposition=S.synth(a.flow,a.raw,{externalSource:true});
assert.deepEqual(S.synth(a.flow,a.raw,{externalSource:true,filteredSources:true}),externalComposition,
 'external synthesis bindings and sampling remain unchanged');
const statistics=S.stats();contract(statistics);
assert.deepEqual(statistics.bindings.at(-1),{binding:3,name:'output',kind:'storage-buffer'});
assert.match(statistics.code,/@workgroup_size\(32\)/);
assert.match(statistics.code,/histogram:array<atomic<u32>,32>/);
assert.match(statistics.code,/totals:array<vec2<f32>,32>/);
assert.match(statistics.code,/stride:u32=16u;stride>0u;stride\/=2u/);
assert.match(statistics.code,/i=lane;i<samples;i\+=32u/);
assert.match(statistics.code,/vec2<f32>\(f32\(i%16u\),f32\(i\/16u\)\)\+vec2<f32>\(0.5\)\)\/16.0/);
assert.equal(32*4+32*8,384,'parallel statistics use only 384 bytes of workgroup memory');
assert.ok(32<=256,'parallel statistics fit the portable invocation minimum');
assert.doesNotMatch(statistics.code.slice(statistics.code.indexOf('workgroupBarrier();')),/return;/,'every sample and reduction lane reaches every barrier');
assert.doesNotMatch(composition.code,/fn (?:flow|raw)C\(/,'aligned synthesis readers need no scalar channel helper');
const manualStatistics=S.stats({filteredSources:false});
assert.equal(statistics.code,manualStatistics.code);assert.deepEqual(statistics.bindings,manualStatistics.bindings);
const filteredStatistics=S.stats({filteredSources:true});contract(filteredStatistics);
assert.deepEqual(filteredStatistics.bindings.map(x=>x.name),['uniforms','prev','curr','imageSampler','output']);
assert.deepEqual(filteredStatistics.bindings.map(x=>x.kind),['uniform','filterable-texture','filterable-texture','sampler','storage-buffer']);
assert.deepEqual(filteredStatistics.bindings.at(-1),{binding:4,name:'output',kind:'storage-buffer'});
assert.match(filteredStatistics.code,/textureSampleLevel\(prev,imageSampler,uv,0\.0\)/);
assert.match(filteredStatistics.code,/textureSampleLevel\(curr,imageSampler,uv,0\.0\)/);
assert.equal((filteredStatistics.code.match(/var imageSampler: sampler/g)||[]).length,1,'stats prev and curr share one sampler declaration');
const externalStatistics=S.stats({externalSource:true});
assert.deepEqual(S.stats({externalSource:true,filteredSources:true}),externalStatistics,
 'external stats bindings and sampling remain unchanged');
for(const desc of [S.operation(a.ops[0],{externalSource:true}),S.synth(a.flow,a.raw,{externalSource:true}),S.stats({externalSource:true})]){
 contract(desc);
 const images=desc.bindings.filter(b=>['source','prev','curr'].includes(b.name));
 assert.ok(images.length>0);assert.ok(images.every(b=>b.kind==='external-texture'));
 assert.match(desc.code,/texture_external/);
 assert.deepEqual(desc.bindings.find(binding=>binding.kind==='sampler').name,'imageSampler');
 assert.equal((desc.code.match(/var imageSampler: sampler/g)||[]).length,1);
 for(const image of images)assert.doesNotMatch(desc.code,new RegExp(`textureLoad\\(${image.name},`),'external filtering performs one browser color conversion per sample');
 for(const image of images)assert.doesNotMatch(desc.code,new RegExp(`textureLoad\\(${image.name},[^;]*,0\\)`));
 assert.ok(desc.bindings.filter(b=>b.name==='flow'||b.name==='raw').every(b=>b.kind==='texture'));
}
// Unaligned slices must retain the base tensor's atlas geometry, including its
// partial last row. Otherwise decoder side branches sample another channel tile.
const base=G.layout(16,8,54),slice=G.view(base,29,24),nested=G.view(slice,3,9);
const text=S.reader(nested,'probe',1);
assert.match(text,/fn probeC\(/);assert.match(text,/fn probeV\(/);assert.match(text,/fn probeB\(/,'public reader default retains all helpers');
assert.match(text,/let k=c\+32/);
assert.match(text,/vec2<i32>\(4,4\)/);
assert.match(text,/c>=9/);
const oddSlice=S.reader(slice,'probe',1);
assert.match(oddSlice,/var v=vec4<f32>\(a.y,a.z,a.w,b.x\)/);
assert.equal((S.reader(slice,'probe',1,'V').match(/textureLoad\(/g)||[]).length,2,'misaligned vector mode needs only two aligned loads');
const rgbaReader=S.imageReader('rgbaImage',1),externalReader=S.imageReader('videoImage',1,true);
assert.doesNotMatch(rgbaReader,/sampler|textureSample/);assert.equal((rgbaReader.match(/textureLoad\(/g)||[]).length,4);
assert.match(externalReader,/@binding\(2\) var videoImageSampler: sampler/);assert.match(externalReader,/textureSampleBaseClampToEdge\(videoImage,videoImageSampler,uv\)/);
const filteredReader=S.imageReader('filteredImage',1,false,null,true);
assert.match(filteredReader,/@binding\(1\) var filteredImage: texture_2d<f32>/);
assert.match(filteredReader,/@binding\(2\) var filteredImageSampler: sampler/);
assert.match(filteredReader,/textureSampleLevel\(filteredImage,filteredImageSampler,uv,0\.0\)/);
assert.doesNotMatch(filteredReader,/textureLoad\(/);
const filteredSharedReader=S.imageReader('filteredImage',1,false,{name:'sharedSampler',binding:7,declare:false},true);
assert.doesNotMatch(filteredSharedReader,/@binding\(7\) var sharedSampler: sampler/,'declare:false reuses the caller\'s sampler');
assert.match(filteredSharedReader,/textureSampleLevel\(filteredImage,sharedSampler,uv,0\.0\)/);
assert.deepEqual(S.imageReader('videoImage',1,true,null,true),externalReader,'external reader is unchanged when filtered is also requested');
assert.throws(()=>S.operation({type:'unknown',out:base,inputs:[]}),/Unknown fixed graph operation/);
assert.equal(globalThis.VENeuralWebGPUShaders,S);assert.equal(globalThis.VENeuralWGSL,S);
// Kernel geometry is per operation rather than part of the program-cache key.
// Equal channel layouts can share compact source across strides and kernel sizes.
const generic=new G.Graph(),input=generic.tensor(16,8,24);
generic.conv(input,layer(24,24,3,false),1);generic.conv(input,layer(24,24,3,false),2);generic.conv(input,layer(24,24,4,false),2,null,true);
const variants=generic.ops.map(op=>S.operation(op,{compact:true}));
assert.equal(variants[0].code,variants[1].code);assert.equal(variants[0].code,variants[2].code);
assert.deepEqual(variants.map(v=>v.config),[19,35,292]);
const scalarVariants=generic.ops.map(op=>S.operation(op,{tiled:false,compact:true}));
assert.equal(scalarVariants[0].code,scalarVariants[1].code);assert.equal(scalarVariants[0].code,scalarVariants[2].code);
assert.deepEqual(scalarVariants.map(v=>v.config),[19,35,292]);
const residualViews=new G.Graph(),residualBase=residualViews.tensor(8,4,16),residualSlice=G.view(residualBase,4,8);
residualViews.conv(residualViews.tensor(8,4,8),layer(8,8),1,residualSlice);
const preserved=S.operation(residualViews.ops[0],{tiled:false,compact:true,generic:true});
assert.equal(preserved.convLayout,undefined,'unusual residual slices retain their exact specialized reader');
assert.match(preserved.code,/let k=g\+1/);
const preservedStorage=S.operation(residualViews.ops[0],{storageTiles:true,compact:true,genericStorage:true});
assert.equal(preservedStorage.code,S.operation(residualViews.ops[0],{storageTiles:true,compact:true}).code,'residual views keep specialized compact storage readers');
assert.equal(preservedStorage.convLayout,undefined);
const misalignedViews=new G.Graph(),misalignedBase=misalignedViews.tensor(8,4,54),misalignedNested=G.view(G.view(misalignedBase,29,24),2,9);
misalignedViews.conv(misalignedNested,layer(9,4));
const unaligned=S.operation(misalignedViews.ops[0],{tiled:false,compact:true,generic:true});
assert.equal(unaligned.convLayout,undefined,'a mutated unaligned input retains its complete scalar channel reader');
assert.match(unaligned.code,/var v=vec4<f32>\(a.w,b.x,b.y,b.z\)/);assert.doesNotMatch(unaligned.code,/fn s0C\(/);
const unalignedStorage=S.operation(misalignedViews.ops[0],{storageTiles:true,compact:true,genericStorage:true});
assert.equal(unalignedStorage.convLayout.outputSize[0],31,'unaligned channel views use the generic storage reader');
assert.match(unalignedStorage.code,/let shift=u.outputSize.x%4u/);
assert.doesNotMatch(unalignedStorage.code,/fn s0C\(/);
const alignedViews=new G.Graph(),alignedBase=alignedViews.tensor(8,4,54);
alignedViews.conv(G.view(alignedBase,32,9),layer(9,4));
const aligned=S.operation(alignedViews.ops[0],{tiled:false,compact:true,generic:true});
assert.equal(aligned.convLayout.outputSize[0],32);assert.doesNotMatch(aligned.code,/fn s0C|offset%4/);
const alignedStorage=S.operation(alignedViews.ops[0],{storageTiles:true,compact:true,genericStorage:true});contract(alignedStorage);
assert.deepEqual(alignedStorage.convLayout,{active:[alignedBase.cols,Math.ceil(alignedBase.groups/alignedBase.cols)],outputSize:[32,4]});
assert.match(alignedStorage.code,/let k=g\+i32\(u.outputSize.x\/4u\); let shift=u.outputSize.x%4u/);
assert.match(alignedStorage.code,/if\(ic\+2<ci\)/,'the tail guard protects a 9-channel aligned view');
// Oracle for the sole permitted arithmetic difference: parallel MAD reduction.
// Atomic histogram counts and the integer-valued changed sum must remain exact.
function reduceStats(samples,parallel){
 const histogram=new Uint32Array(32),mad=new Float32Array(32),changed=new Float32Array(32);let serialMAD=0,serialChanged=0;
 samples.forEach(([a,b,flag],i)=>{
  histogram[Math.min(15,Math.trunc(a*16))]++;histogram[16+Math.min(15,Math.trunc(b*16))]++;
  const value=Math.fround(Math.abs(a-b)),lane=i%32;
  mad[lane]=Math.fround(mad[lane]+value);changed[lane]=Math.fround(changed[lane]+flag);
  serialMAD=Math.fround(serialMAD+value);serialChanged=Math.fround(serialChanged+flag);
 });
 for(let stride=16;stride;stride>>=1)for(let i=0;i<stride;i++){
  mad[i]=Math.fround(mad[i]+mad[i+stride]);changed[i]=Math.fround(changed[i]+changed[i+stride]);
 }
 let hist=0;for(let i=0;i<16;i++)hist+=Math.abs(histogram[i]-histogram[i+16]);
 return [(parallel?mad[0]:serialMAD)/256,hist/512,(parallel?changed[0]:serialChanged)/256,1];
}
let seed=0x5a173;const random=()=>{seed=Math.imul(seed^seed>>>15,2246822519);seed^=seed>>>13;return (seed>>>0)/4294967296;};
const statisticCases=[Array.from({length:256},()=>[0,0,0]),Array.from({length:256},()=>[0,1,1]),
 ...Array.from({length:64},()=>Array.from({length:256},()=>[Math.fround(random()),Math.fround(random()),Number(random()>=.5)]))];
let maxReductionDifference=0;
for(const samples of statisticCases){
 const serial=reduceStats(samples,false),parallel=reduceStats(samples,true);
 maxReductionDifference=Math.max(maxReductionDifference,Math.abs(serial[0]-parallel[0]));
 assert.ok(Math.abs(serial[0]-parallel[0])<1e-6,'FP32 tree rounding remains far inside native MAD conformance bounds');
 assert.deepEqual(parallel.slice(1),serial.slice(1),'histogram, changed fraction, and alpha are exact');
}
assert.ok(maxReductionDifference>0,'oracle exercises a real change in float summation order');
// A static shuffle and explicit tail selection must reproduce scalar channel
// reads, including partial last groups and NaN-filled unused atlas lanes.
for(const offset of [1,2,3,29,30,31,138])for(const channels of [1,2,3,4,5,7,9,24]){
 const baseChannels=offset+channels,data=Array.from({length:Math.ceil(baseChannels/4)*4+4},(_,i)=>i<baseChannels?i+.25:NaN);
 for(let group=-1;group<=Math.ceil(channels/4);group++){
  const expected=Array.from({length:4},(_,lane)=>group*4+lane<0||group*4+lane>=channels?0:data[offset+group*4+lane]);
  let shuffled=[0,0,0,0];
  if(group>=0&&group*4<channels){
   const start=(group+Math.floor(offset/4))*4,loaded=data.slice(start,start+8),shift=offset%4;
   shuffled=Array.from({length:4},(_,lane)=>group*4+lane<channels?loaded[shift+lane]:0);
  }
  assert.deepEqual(shuffled,expected,'two aligned loads and static shuffle preserve every guarded channel');
 }
}
// Per-dispatch scratch coordinates cover each workgroup exactly once and never
// overlap, including spatial edge groups and the Z output-channel dimension.
for(const [width,height,groups]of [[1,1,1],[9,5,2],[17,19,5],[32,16,6]])for(const stride of [100+36,324+36,36+64]){
 const bx=Math.ceil(width/8),by=Math.ceil(height/8),occupied=new Set();
 for(let z=0;z<groups;z++)for(let y=0;y<by;y++)for(let x=0;x<bx;x++){
  const start=((z*by+y)*bx+x)*stride;
  for(let i=0;i<stride;i++){assert.equal(occupied.has(start+i),false);occupied.add(start+i);}
 }
 assert.equal(occupied.size,bx*by*groups*stride);
 assert.equal(Math.max(...occupied),bx*by*groups*stride-1);
}
// Staged generic storage is an additional, strictly gated opt-in. Keep the
// legacy descriptor byte-for-byte stable unless all three prerequisite modes
// are active.
const stagedViewGraph=new G.Graph(),stagedViewBase=stagedViewGraph.tensor(16,8,150),stagedResidual=stagedViewGraph.tensor(16,8,3);
const stagedDescriptors=[];
for(const offset of [138,139,140,141]){
 const view=G.view(stagedViewBase,offset,3);
 stagedViewGraph.conv(view,layer(3,3,3,true),1,stagedResidual);
 const op=stagedViewGraph.ops.at(-1),options={storageTiles:true,compact:true,genericStorage:true,stagedStorage:true};
 const staged=S.operation(op,options),legacy=S.operation(op,{...options,stagedStorage:false});
 contract(staged);contract(staged.stage);stagedDescriptors.push(staged);
 assert.notDeepEqual(staged,legacy,'full staged opt-in selects a separate stage/main descriptor pair');
 assert.equal(staged.stageGroups,1,'three input channels stage into one padded vec4 group');
 assert.equal(staged.scratchBytes,Math.ceil(op.out.w/8)*Math.ceil(op.out.h/8)*(8*(op.stride||1)+2)**2*Math.ceil(op.layer.ci/4)*16);
 assert.deepEqual(staged.convLayout,{active:[stagedViewBase.cols,Math.ceil(stagedViewBase.groups/stagedViewBase.cols)],outputSize:[offset,3]});
 assert.deepEqual(staged.stage.bindings.map(x=>x.name),['uniforms','s0','weights','scratch']);
 assert.deepEqual(staged.stage.bindings.map(x=>x.kind),['uniform','texture','texture','storage-buffer']);
 assert.deepEqual(staged.bindings.map(x=>x.name),['uniforms','s0','s1','weights','scratch','output']);
 assert.deepEqual(staged.bindings.map(x=>x.kind),['uniform','texture','texture','texture','storage-buffer','storage-texture']);
 assert.match(staged.stage.code,/scratch\[base\+wid\.z\*u32\(tile\*tile\)\+i\]=value/);
 assert.doesNotMatch(staged.stage.code,/workgroupBarrier|storageBarrier/);
 assert.doesNotMatch(staged.code,/workgroupBarrier|storageBarrier/,'separate dispatches replace inter-kernel barriers');
 assert.doesNotMatch(staged.code,/scratch\[[^\]]+\]\s*=/,'the convolution stage only reads the staged scratch tiles');
 for(const missing of [{storageTiles:false},{compact:false},{genericStorage:false}]){
  const disabled=S.operation(op,{...options,...missing});
  assert.deepEqual(disabled,S.operation(op,{...options,...missing,stagedStorage:false}),`stagedStorage is inert when ${Object.keys(missing)[0]} is disabled`);
 }
}
assert.equal(new Set(stagedDescriptors.map(x=>x.code)).size,1,'channel-view offsets stay in uniforms and share the staged main program');
assert.equal(new Set(stagedDescriptors.map(x=>x.stage.code)).size,1,'channel-view offsets stay in uniforms and share the staged input program');
const stagedDepthGraph=new G.Graph(),stagedDepthInput=stagedDepthGraph.tensor(17,9,9);
stagedDepthGraph.conv(stagedDepthInput,layer(9,5,3,false));
const stagedDepth=S.operation(stagedDepthGraph.ops[0],{storageTiles:true,compact:true,genericStorage:true,stagedStorage:true});
assert.equal(stagedDepth.stageGroups,3,'nine input channels dispatch three stage groups, including the one-lane tail');
assert.equal(stagedDepth.scratchBytes,Math.ceil(stagedDepthGraph.ops[0].out.w/8)*Math.ceil(stagedDepthGraph.ops[0].out.h/8)*10**2*3*16);
const stagedDeconvGraph=new G.Graph(),stagedDeconvInput=stagedDeconvGraph.tensor(9,5,3);
stagedDeconvGraph.conv(stagedDeconvInput,layer(3,4,4,false),2,null,true);
const stagedDeconvOp=stagedDeconvGraph.ops[0],stagedDeconv=S.operation(stagedDeconvOp,{storageTiles:true,compact:true,genericStorage:true,stagedStorage:true});
assert.equal(stagedDeconv.scratchBytes,Math.ceil(stagedDeconvOp.out.w/8)*Math.ceil(stagedDeconvOp.out.h/8)*6**2*Math.ceil(stagedDeconvOp.layer.ci/4)*16,'deconvolution uses its six-pixel staged tile');
console.log(`PASS: IFRNet WGSL binding contracts for ${a.ops.length} graph operations, synthesis/statistics, spatial pipeline reuse, nested channel views, and staged-storage descriptor opt-ins (no GPU execution)`);
