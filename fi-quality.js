/* Video Enhancer quality primitives. Pure, deterministic and DOM-free. */
(function (scope) {
  'use strict';
  const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
  function floatToHalf(value) {
    // Round-to-nearest, ties-to-even. Preserve signed zero. Nonfinite input is
    // neutralized; finite overflow follows IEEE 754. Upload validates its domain.
    f32[0] = Number.isFinite(value) ? value : 0;
    const bits = u32[0], sign = (bits >>> 16) & 0x8000;
    const e = ((bits >>> 23) & 255) - 127, mantissa = bits & 0x7fffff;
    if (e > 15) return sign | 0x7c00;
    if (e >= -14) {
      let n = mantissa >>> 13;
      const rem = mantissa & 0x1fff;
      if (rem > 0x1000 || (rem === 0x1000 && (n & 1))) n++;
      return sign | (((e + 15) << 10) + n);
    }
    if (e < -25) return sign;
    const sig = mantissa | 0x800000, shift = -e - 1;
    let n = sig >>> shift;
    const rem = sig & ((1 << shift) - 1), halfway = 1 << (shift - 1);
    if (rem > halfway || (rem === halfway && (n & 1))) n++;
    return sign | n;
  }
  function halfToFloat(bits) {
    const s = bits & 0x8000 ? -1 : 1, e = (bits >>> 10) & 31, m = bits & 1023;
    return e === 0 ? s * m * 2 ** -24 : e === 31 ? (m ? NaN : s * Infinity) : s * (1 + m / 1024) * 2 ** (e - 15);
  }
  function dimensions(w, h, maxW, maxH, step = 16) {
    if (![w,h,maxW,maxH,step].every(Number.isFinite) || Math.min(w,h,maxW,maxH,step) <= 0) throw new Error('Invalid image dimensions');
    const scale = Math.min(1, maxW/w, maxH/h);
    return {width: Math.max(step, Math.floor(w*scale/step)*step), height: Math.max(step, Math.floor(h*scale/step)*step)};
  }
  const profiles = Object.freeze({
    balanced: Object.freeze({motionW: 384, motionH: 216, neuralW: 640, neuralH: 368}),
    quality: Object.freeze({motionW: 640, motionH: 360, neuralW: 960, neuralH: 544})
  });
  function profile(name) { return profiles[name] || profiles.balanced; }
  function neuralSlot(anchor, duration, period, reference) {
    if (![anchor,duration,period,reference].every(Number.isFinite) || duration <= period * 1.45) return null;
    const first = anchor + duration * .38;
    const time = reference + Math.ceil((first - reference)/period) * period;
    const phase = (time-anchor)/duration;
    return phase >= .25 && phase <= .85 ? {time, phase, expires: Math.min(anchor+duration-1, time+period*.6)} : null;
  }
  function validFlow(x,y,limit) { return Number.isFinite(x) && Number.isFinite(y) && Math.abs(x) <= limit && Math.abs(y) <= limit; }
  // Reject isolated, low-confidence vectors only. The guide is sampled from
  // the corresponding endpoint so opposite sides of a contrast edge do not vote.
  function regularize(match, luma, width, height) {
    if (!match) return match;
    const {gridW: w,gridH: h,block} = match, n = w*h;
    const mvs = new Float32Array(match.mvs), conf = new Float32Array(match.confidences || n);
    if (!match.confidences) conf.fill(match.confidence || 0);
    const guide = (i) => luma?.[Math.min(height-1, Math.floor(Math.floor(i/w)*block+block*.5))*width + Math.min(width-1, Math.floor(i%w*block+block*.5))] || 0;
    let invalid = 0, replaced = 0;
    const ix = new Int32Array(9), weights = new Float32Array(9);
    for (let i=0;i<n;i++) {
      const valid = validFlow(mvs[i*2],mvs[i*2+1],Math.max(width,height));
      if (!valid) {mvs[i*2]=mvs[i*2+1]=0;conf[i]=0;invalid++;continue;}
      conf[i] = Number.isFinite(conf[i]) ? Math.max(0,Math.min(1,conf[i])) : 0;
      if (conf[i] >= .6) continue;
      let count=0,total=0,near=0;
      const x=i%w,y=Math.floor(i/w), center=guide(i);
      for (let dy=-1;dy<=1;dy++) for (let dx=-1;dx<=1;dx++) {
        const xx=x+dx,yy=y+dy;
        if ((dx===0&&dy===0)||xx<0||yy<0||xx>=w||yy>=h) continue;
        const j=yy*w+xx,c=match.confidences?.[j]??match.confidence??0;
        if (c<.6 || Math.abs(guide(j)-center)>12 || !validFlow(match.mvs[2*j],match.mvs[2*j+1],Math.max(width,height))) continue;
        ix[count]=j;weights[count]=c/(1+dx*dx+dy*dy);total+=weights[count++];
        if (Math.hypot(match.mvs[2*j]-mvs[2*i],match.mvs[2*j+1]-mvs[2*i+1]) < 1.5) near++;
      }
      if (count<5 || near>1) continue; // thin structures and ambiguous neighborhoods survive
      let best=-1,bestCost=Infinity;
      for (let a=0;a<count;a++) {
        let cost=0;
        for(let b=0;b<count;b++) cost+=weights[b]*Math.hypot(match.mvs[ix[a]*2]-match.mvs[ix[b]*2],match.mvs[ix[a]*2+1]-match.mvs[ix[b]*2+1]);
        if(cost<bestCost){bestCost=cost;best=ix[a];}
      }
      if (best>=0 && bestCost/total<.7) {
        mvs[2*i]=match.mvs[2*best];mvs[2*i+1]=match.mvs[2*best+1];
        // Do not manufacture a high-confidence correspondence by borrowing it.
        conf[i]=Math.min(conf[i],.45);replaced++;
      }
    }
    return {...match,mvs,confidences:conf,qualityStats:{invalid,replaced}};
  }
  const api={floatToHalf,halfToFloat,dimensions,profile,neuralSlot,validFlow,regularize};
  scope.FiQuality=api;
  if(typeof module!=='undefined'&&module.exports) module.exports=api;
})(globalThis);
