'use strict';
const assert=require('node:assert/strict'),R=require('../fi-neural-runtime.js'),{model}=require('./fixtures.cjs');
const m=model();const spec=R.validateModel(m.manifest,m.binary);assert.equal(spec.c2,8);
const clone=()=>JSON.parse(JSON.stringify(m.manifest));
for(const mutation of [v=>v['block0.lastconv.bias'].offset=-1,v=>v['block0.lastconv.bias'].offset=0,v=>v['film.0.weight'].shape[0]=65536,v=>v['refine.c3.weight'].shape[0]=4,v=>v.other={shape:[1],offset:0}]){const v=clone();mutation(v);assert.throws(()=>R.validateModel(v,m.binary));}
for(const value of [NaN,Infinity,-Infinity,1e9]){const b=m.binary.slice(0);new Float32Array(b)[0]=value;assert.throws(()=>R.validateModel(m.manifest,b));}
assert.throws(()=>R.validateModel(m.manifest,new ArrayBuffer(3)));
const weights={w0:Float32Array.from([1,-1]),b0:Float32Array.from([0,1]),w2:Float32Array.from([1,2,3,4]),b2:Float32Array.from([.1,.2])};
const out=R.filmParams(weights,1,.25,new Float32Array(2),new Float32Array(2));assert.ok(Math.abs(out[0]-1.85)<1e-6);assert.ok(Math.abs(out[1]-3.95)<1e-6);assert.throws(()=>R.filmParams(weights,1,2,out,out));
// WGSL workgroup memory stays within the portable 16 KiB minimum.
for(const half of [false,true])for(const stride of [1,2]){const code=R.kernels.convCode(48,96,80,48,40,24,stride,half);const counts=[...code.matchAll(/var<workgroup> \w+:array<(f16|f32),(\d+)>/g)];assert.ok(counts.reduce((n,x)=>n+(x[1]==='f16'?2:4)*Number(x[2]),0)<=16384);}
console.log('PASS: model schema/bounds/nonfinite rejection, FiLM math, portable kernel workgroup memory');
