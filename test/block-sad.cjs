'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {createHash} = require('node:crypto');
const source = fs.readFileSync(path.join(__dirname, '../fi-core.js'), 'utf8');

// Independent scalar oracle: inspect each requested source and destination
// sample before accumulating. It deliberately does not precompute overlap.
function referenceSad(prev, curr, w, h, bx, by, bw, bh, mx, my) {
  let sad = 0, count = 0;
  for (let y = 0; y < bh; y++) {
    const sy = by + y, ty = sy + my;
    if (sy < 0 || sy >= h || ty < 0 || ty >= h) continue;
    for (let x = 0; x < bw; x++) {
      const sx = bx + x, tx = sx + mx;
      if (sx < 0 || sx >= w || tx < 0 || tx >= w) continue;
      sad += Math.abs(prev[sy * w + sx] - curr[ty * w + tx]);
      count++;
    }
  }
  return count >= Math.ceil(bw * bh / 2) ? sad / count : 1e9;
}
function core(oracle) {
  return new Function('oracle', source + '\nif (oracle) fiBlockSad=oracle;\nreturn {sad:fiBlockSad,match:fiHierarchicalBlockMatch};')(oracle);
}
function random(seed) {
  return () => {
    seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
    return (seed >>> 8) / 16777216;
  };
}
function fixture(w, h, kind) {
  const rng = random(12345);
  const prev = Float32Array.from({length:w*h}, (_, i) => kind === 'stationary' ? 90 :
    kind === 'periodic' ? ((i % w >> 2) & 1) * 120 + Math.floor(i / w) % 9 : kind === 'local' ? 100 : rng() * 255);
  if (kind === 'local') for (let y=20; y<Math.min(h,60); y++) for (let x=20; x<Math.min(w,60); x++) prev[y*w+x]=rng()*255;
  const curr = new Float32Array(prev.length);
  const dx = kind === 'stationary' ? 0 : kind === 'fractional' ? 1.5 : kind === 'wide' ? 9 : 2;
  const dy = kind === 'fractional' ? .5 : kind === 'wide' ? -5 : 0;
  const sample = (x,y) => prev[Math.max(0,Math.min(h-1,y))*w+Math.max(0,Math.min(w-1,x))];
  for (let y=0; y<h; y++) for (let x=0; x<w; x++) {
    const xx=x-dx, yy=y-dy, ix=Math.floor(xx), iy=Math.floor(yy), fx=xx-ix, fy=yy-iy;
    curr[y*w+x]=kind === 'cut' ? rng()*255 :
      (sample(ix,iy)*(1-fx)+sample(ix+1,iy)*fx)*(1-fy)+(sample(ix,iy+1)*(1-fx)+sample(ix+1,iy+1)*fx)*fy;
  }
  return {prev,curr,w,h,kind};
}
const current = core(), reference = core(referenceSad), rng = random(27491);
let checked = 0;
for (const [w,h] of [[1,1],[3,2],[17,13],[160,90]]) {
  const prev=Float32Array.from({length:w*h},()=>rng()*255), curr=Float32Array.from({length:w*h},()=>rng()*255);
  for (let i=0; i<1500; i++) {
    const bx=Math.floor(rng()*(w+8))-4, by=Math.floor(rng()*(h+8))-4;
    const bw=1+Math.floor(rng()*17), bh=1+Math.floor(rng()*17);
    const mx=Math.floor(rng()*41)-20, my=Math.floor(rng()*41)-20;
    const args=[prev,curr,w,h,bx,by,bw,bh,mx,my];
    assert.equal(current.sad(...args),referenceSad(...args),'SAD must exactly match the scalar overlap oracle');checked++;
  }
}
const borderPrev = new Float32Array(64).fill(20), borderCurr = new Float32Array(64).fill(200);
for (let y=0; y<8; y++) borderCurr[y*8+7]=20;
assert.equal(current.sad(borderPrev,borderCurr,8,8,0,0,8,8,7,0),1e9,'one matching column is not reliable evidence');
assert.equal(current.sad(borderPrev,borderPrev,8,8,0,0,8,8,4,0),0,'exactly half the block remains admissible');

const kinds=['stationary','pan','fractional','local','periodic','wide','cut'];
const production={block:8,coarseRange:3,refineRange:1,pyramid:true,subpixel:true};
let matched = 0;
for (const [w,h] of [[32,32],[160,90],[90,160]]) for (const kind of kinds) {
  const f=fixture(w,h,kind);
  for (const options of [{},production]) {
    const args=[f.prev,f.curr,w,h,options];
    assert.deepEqual(current.match(...args),reference.match(...args),'motion, confidence and residuals must remain bit-exact');matched++;
  }
}
console.log(`Block SAD checks passed: ${checked} integer overlap cases and ${matched} complete matcher results exactly match the scalar oracle.`);

// Optional direct CPU benchmark. It does not execute shaders or measure browser
// playback, GPU speed or visual quality. Alternating order limits warmup bias.
if (process.argv.includes('--benchmark')) {
  const cases=kinds.map(kind=>fixture(160,90,kind)), rounds=7, iterations=12;
  const call=(impl,f)=>impl.match(f.prev,f.curr,f.w,f.h,production);
  for (let i=0; i<6; i++) for (const f of cases) {call(reference,f);call(current,f);}
  const median=xs=>xs.slice().sort((a,b)=>a-b)[Math.floor(xs.length/2)], results=[];
  for (const f of cases) {
    const times={reference:[],current:[]};
    for (let round=0; round<rounds; round++) {
      const order=round%2 ? [['current',current],['reference',reference]] : [['reference',reference],['current',current]];
      for (const [label,impl] of order) {
        const start=performance.now();
        for (let i=0; i<iterations; i++) call(impl,f);
        times[label].push((performance.now()-start)/iterations);
      }
    }
    results.push({fixture:f.kind,referenceMs:median(times.reference),currentMs:median(times.current),ratio:median(times.current)/median(times.reference)});
  }
  console.log(JSON.stringify({scope:'CPU JavaScript only; no browser/GPU timing',node:process.version,
    cpu:os.cpus()[0]?.model,platform:process.platform,sourceSha256:createHash('sha256').update(source).digest('hex'),
    size:[160,90],options:production,rounds,iterations,results},null,2));
}
