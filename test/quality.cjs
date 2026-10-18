'use strict';
const assert=require('node:assert/strict'),Q=require('../fi-quality.js');
let finite=0;for(let h=0;h<65536;h++){if(((h>>>10)&31)===31)continue;assert.equal(Q.floatToHalf(Q.halfToFloat(h)),h,'half pattern '+h);finite++;}
for(const v of [1e-5,3e-5,6e-5,2**-24,-(2**-24)])assert.ok(Math.abs(Q.halfToFloat(Q.floatToHalf(v))-v)<3e-8);
assert.equal(Q.floatToHalf(NaN),0);assert.equal(Q.floatToHalf(Infinity),0);assert.equal(Q.floatToHalf(-0),0x8000);
assert.equal(Q.floatToHalf(2**-25),0);assert.equal(Q.floatToHalf(1+2**-11),0x3c00);
for(const fps of [24,25,30,50,60])for(const hz of [60,90,120,144,165]){
 const d=1000/fps,p=1000/hz;
 for(let off=0;off<p;off+=.5){const slot=Q.neuralSlot(1000+off,d,p,1000);if(d>=2*p)assert.ok(slot,'a usable display tick must not be skipped');if(slot){assert.ok(slot.phase>=.25&&slot.phase<=.95);assert.ok(slot.expires<1000+off+d);assert.ok(Math.abs((slot.time-1000)/p-Math.round((slot.time-1000)/p))<1e-6);}}
}
for(let i=0;i<120;i++)assert.ok(Q.neuralSlot(1000+i*1000/30,1000/30,1000/60,995.5),'fixed phase offset must not starve interpolation');
const early=Q.neuralSlot(1000,1000/24,1000/120,1000,1001);
const later=Q.neuralSlot(1000,1000/24,1000/120,1000,1026);
const cold=Q.neuralSlot(1000,1000/24,1000/120,1000,1052);
assert.ok(later.time>early.time&&later.time>=1026,'slow-enough inference uses a later feasible tick');
assert.ok(cold&&cold.phase<=.95,'cold cost beyond deadline still permits a fresh attempt');
assert.deepEqual(Q.neuralSlot(1000,1000/24,1000/120,1000,NaN),early,'invalid history does not poison slots');
assert.equal(Q.neuralSlot(1000,1000/24,1000/120,1000,1001).time,early.time,'fast result restores midpoint preference');
assert.equal(Q.neuralSlot(1000,1000/60,1000/60,1000),null);
// 36fps playback on a 165Hz display: the next reachable tick falls beyond
// the old .85 cap, but is still before the next original frame.
const fractional=Q.neuralSlot(10533.6,27.849443478260874,1000/165,10551.78,10554);
assert.ok(fractional.time>=10554&&fractional.phase>.85,'keep the reachable late refresh');
assert.ok(fractional.time<10533.6+27.849443478260874-1,'late target still precedes the next original');
assert.ok(Math.abs(fractional.phase-(fractional.time-10533.6)/27.849443478260874)<1e-9,'infer the exact target phase');
assert.throws(()=>Q.dimensions(0,1,10,10));
assert.deepEqual(Q.dimensions(1920,1080,640,368),{width:640,height:352});
const size=9,n=size*size,block=2,width=size*block,luma=new Float32Array(width*width).fill(100);
const m={gridW:size,gridH:size,block,mvs:new Float32Array(n*2),confidences:new Float32Array(n).fill(.9),confidence:.9};
for(let i=0;i<n;i++)m.mvs[2*i]=1;
const center=40;m.mvs[2*center]=9;m.confidences[center]=.2;
const fixed=Q.regularize(m,luma,width,width);assert.equal(fixed.mvs[2*center],1);assert.equal(m.mvs[2*center],9);assert.equal(fixed.qualityStats.replaced,1);
m.confidences[center]=.9;assert.equal(Q.regularize(m,luma,width,width).mvs[2*center],9,'high confidence must not be smoothed blindly');
m.mvs[2*center]=Infinity;const invalid=Q.regularize(m,luma,width,width);assert.equal(invalid.mvs[2*center],0);assert.equal(invalid.confidences[center],0);
// Guide excludes the other side of a thin contrast stripe.
m.mvs[2*center]=9;m.confidences[center]=.2;for(let y=0;y<width;y++)for(let x=8;x<10;x++)luma[y*width+x]=240;
assert.equal(Q.regularize(m,luma,width,width).mvs[2*center],9);
console.log(`PASS: ${finite} half patterns, subnormal regressions, phases, dimensions, isolated outliers and thin guide edges`);
