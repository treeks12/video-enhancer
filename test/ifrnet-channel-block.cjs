'use strict';
// Host checks for the opt-in GLSL channel-block compilation experiment.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const G=require('../neural/graph.js'),S=require('../neural/model-spec.js');
const model=S.decodeWeights(fs.readFileSync(path.join(__dirname,'../models/ifrnet.bin')));
function graph(w,h){
 const encoder=G.encoder(model,{w,h}),decoder=G.decoder(model,encoder.features,encoder.features);
 return [...encoder.graph.ops,...decoder.graph.ops];
}
function order(ci,blockSize){
 const groups=[];
 if(blockSize){
  for(let block=0;block<ci;block+=blockSize)for(let lane=0;lane<blockSize;lane+=4){
   const ic=block+lane;if(ic>=ci)break;groups.push(ic);
  }
 }else for(let ic=0;ic<ci;ic+=4)groups.push(ic);
 // Each group's x/y/z/w multiplies run in this order after each spatial tap.
 return groups.map(ic=>Array.from({length:Math.min(4,ci-ic)},(_,lane)=>ic+lane));
}
for(const ci of [...Array.from({length:70},(_,i)=>i+1),72,76,108,112,144,145,162,166]){
 assert.deepEqual(order(ci,16),order(ci,0),'blocked channel groups and partial vec4 tails must preserve order');
}
const a=graph(64,32),b=graph(128,64),genericSources=new Set();let convolutions=0;
for(let i=0;i<a.length;i++){
 const op=a[i],canonical=G.makeShader(op),blocked=G.makeShader(op,{channelBlock:16});
 assert.equal(canonical,G.makeShader(op,{channelBlock:0}),'the default remains canonical');
 assert.equal(blocked,G.makeShader(b[i],{channelBlock:16}),'spatial resize reuses blocked program source');
 if(op.type!=='conv'){assert.equal(blocked,canonical);continue;}
 convolutions++;
 const layer=op.layer,area=layer.k*layer.k,packed=G.packLayer(layer);
 assert.equal((packed.width-2)/area,layer.ci,'dynamic ci is exact for the trained packed layer');
 const declaration=`int ci=(textureSize(weights,0).x-2)/${area};\n`;
 const blockLoop='for(int block=0;block<ci;block+=16){for(int lane=0;lane<16;lane+=4){int ic=block+lane;if(ic>=ci)break;';
 assert.ok(blocked.includes(declaration));assert.ok(blocked.includes(blockLoop));
 // Only replace the loop wrapper. Everything below the ic assignment, including
 // all taps, padding, scalar multiplies, residual, and activation, stays exact.
 const restored=blocked.replace(declaration,'').replace(blockLoop,`for(int ic=0;ic<${layer.ci};ic+=4){`).replace('  }}}}\n','  }}}\n');
 assert.equal(restored,canonical,'the original convolution body must be byte-identical');
 const generic=G.makeShader(op,{generic:true}),uniforms=G.convUniforms(op);genericSources.add(generic);
 assert.equal(generic,G.makeShader(b[i],{generic:true}),'generic source has no resolution constants');
 assert.equal(uniforms.kernelConfig,layer.k|((op.stride||1)<<4)|(op.deconv?256:0)|(layer.slope?512:0));
 assert.deepEqual(uniforms.outputLayout,[op.out.cols,op.out.groups]);
 assert.deepEqual(uniforms.inputs,op.inputs.map(t=>[G.baseOf(t).cols,t.offset||0,t.c]));
 assert.match(generic,/ic<ci/);assert.match(generic,/y<taps/);assert.match(generic,/x<taps/);
 const additions=['total+=v.x*','total+=v.y*','total+=v.z*','total+=v.w*'].map(text=>generic.indexOf(text));
 assert.ok(additions.every((position,i)=>position>=0&&(i===0||position>additions[i-1])),'scalar accumulation lane order stays x/y/z/w');
 if(op.residual)assert.ok(generic.indexOf('total+=s1V(p,g);')<generic.indexOf('if(activation)'),'residual precedes PReLU');
}
assert.equal(convolutions,36);
assert.equal(genericSources.size,3,'the trained generic graph needs only aligned normal/residual and misaligned normal convolution sources');
const variants=new G.Graph(),input=variants.tensor(8,4,24);
const fake=(k,slope)=>({ci:24,co:24,k,slope});
variants.conv(input,fake(3,{}),1);variants.conv(input,fake(3,null),2);variants.conv(input,fake(4,null),2,null,true);
assert.equal(G.makeShader(variants.ops[0],{generic:true}),G.makeShader(variants.ops[1],{generic:true}));
assert.equal(G.makeShader(variants.ops[0],{generic:true}),G.makeShader(variants.ops[2],{generic:true}),'generic source shares kernel geometry and activation differences');
assert.deepEqual(variants.ops.map(op=>G.convUniforms(op).kernelConfig),[531,35,292]);
assert.match(G.STATS,/uniform ivec2 sampleSize/);assert.match(G.STATS,/y<sampleSize.y/);assert.match(G.STATS,/x<sampleSize.x/);
assert.match(G.STATS,/vec2\(x,y\)\+0.5\)\/16.0/);assert.match(G.STATS,/mad\/256.0,hist\/512.0,changed\/256.0/);
for(const channelBlock of [-1,2,3,NaN,Infinity,1.5])assert.throws(()=>G.makeShader(a.find(op=>op.type==='conv'),{channelBlock}),/channel block/);
console.log(`PASS: optional GLSL block16 preserves channel/tail order and all ${convolutions} trained convolution bodies; canonical default and ${a.length}-operation spatial source reuse unchanged (no GPU execution)`);
