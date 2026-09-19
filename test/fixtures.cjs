// Deterministic untrained tensors for mathematical and lifecycle tests only.
const fs = require('node:fs');
function model(c1=4,c2=8,rc=4,hidden=4) {
 const manifest={};let offset=0;const shapes=[];
 function add(name,shape){manifest[name]={shape,offset};offset+=shape.reduce((a,b)=>a*b,1);shapes.push(name);}
 for(const [base,ci,co] of [['block0.conv0.0',6,c1],['block0.conv0.1',c1,c2]]){add(base+'.0.weight',[co,ci,3,3]);add(base+'.0.bias',[co]);add(base+'.1.weight',[co]);}
 for(let i=0;i<8;i++){add(`block0.convblock.${i}.0.weight`,[c2,c2,3,3]);add(`block0.convblock.${i}.0.bias`,[c2]);add(`block0.convblock.${i}.1.weight`,[c2]);}
 add('block0.lastconv.weight',[c2,5,4,4]);add('block0.lastconv.bias',[5]);
 add('film.0.weight',[hidden,1]);add('film.0.bias',[hidden]);add('film.2.weight',[2*c2,hidden]);add('film.2.bias',[2*c2]);
 for(let i=0;i<3;i++){add(`refine.c${i}.weight`,[rc,i?rc:11,3,3]);add(`refine.c${i}.bias`,[rc]);add(`refine.a${i}.weight`,[rc]);}
 add('refine.c3.weight',[3,rc,3,3]);add('refine.c3.bias',[3]);
 const data=new Float32Array(offset);let seed=783455;
 for(const name of shapes){const m=manifest[name],n=m.shape.reduce((a,b)=>a*b,1);for(let i=0;i<n;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;data[m.offset+i]=(seed/2**32-.5)*.1;}if(/\.1\.weight$|^refine\.a/.test(name))data.fill(.2,m.offset,m.offset+n);}
 // Exercise nonzero motion and mask, not just the zero/blend case.
 data.set([.14,-.08,-.18,.10,.25],manifest['block0.lastconv.bias'].offset);
 return {manifest,binary:data.buffer};
}
if(require.main===module){const p=require('node:path');fs.mkdirSync(p.join(__dirname,'fixtures'),{recursive:true});const m=model();fs.writeFileSync(p.join(__dirname,'fixtures/model.json'),JSON.stringify(m.manifest,null,2));fs.writeFileSync(p.join(__dirname,'fixtures/model.bin'),Buffer.from(m.binary));}
module.exports={model};
