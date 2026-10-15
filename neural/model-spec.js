/* Model architecture and binary provenance. No executable code is fetched. */
(function(root) {
  'use strict';
  const MODEL = Object.freeze({
    id: 'ifrnet-s-gopro-ncnn-v1', name: 'IFRNet-S (GoPro)',
    bytes: 5921992, gitBlob: 'cae4a9270b508eb0fc51c9570b3fa0c8d7d3c773',
    // jsDelivr's GitHub mirror of the pinned revision: byte-identical to the
    // raw.githubusercontent blob (git SHA-1 cae4a927…), still verified at install.
    url: 'https://cdn.jsdelivr.net/gh/nihui/ifrnet-ncnn-vulkan@7e54b1caa8c9f94a052a7148a56a2f57b685609e/models/IFRNet_S_GoPro/ifrnet.bin',
    origin: 'https://cdn.jsdelivr.net/*',
    upstream: 'https://github.com/nihui/ifrnet-ncnn-vulkan/tree/master/models/IFRNet_S_GoPro',
  });
  const ENCODER = [[3,24],[24,24],[24,36],[36,36],[36,54],[54,54],[54,72],[72,72]];
  const DECODER = [[145,144,58],[166,162,40],[112,108,28],[76,72,8]];
  const clamp = (x,a,b) => Math.min(b,Math.max(a,x));
  function halfToFloat(h) {
    const s = h & 0x8000 ? -1 : 1, e = (h >>> 10) & 31, m = h & 1023;
    return e === 31 ? (m ? NaN : s * Infinity) : e ? s * (1+m/1024)*2**(e-15) : s*m*2**-24;
  }
  let halfLookup=null;
  function* halfTable() {
    if(halfLookup)return halfLookup;
    const table=new Float32Array(65536);
    for(let i=0;i<table.length;i++){
      table[i]=halfToFloat(i);
      if((i&4095)===4095)yield;
    }
    // Publish only the complete table: concurrent or cancelled preparations
    // must never read another decoder's partially initialized values.
    halfLookup=table;return table;
  }
  function* decodeSteps(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (bytes.byteLength !== MODEL.bytes) throw new Error('Invalid IFRNet-S file size. Use the GoPro small model.');
    const view = new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength); let at=0;
    let lookup=null;
    const take = function*(n,tagged=false) {
      let fp16=false;
      if (tagged) { const tag=view.getUint32(at,true);at+=4;
        if(tag===0x01306b47) fp16=true;
        else if(tag!==0) throw new Error('Unsupported ncnn weight encoding.');
      }
      if(at+n*(fp16?2:4)>bytes.length) throw new Error('Truncated weights.');
      if(fp16&&!lookup)lookup=yield* halfTable();
      const a=new Float32Array(n);
      for(let i=0;i<n;i++){
        a[i]=fp16?lookup[view.getUint16(at+i*2,true)]:view.getFloat32(at+i*4,true);
        if(!Number.isFinite(a[i])) throw new Error('Non-finite model weight.');
        if((i&4095)===4095)yield;
      }
      at+=n*(fp16?2:4); if(fp16) at=(at+3)&~3;
      return a;
    };
    const conv=function*(ci,co,k=3,activation=true){
      const weights=yield* take(ci*co*k*k,true),bias=yield* take(co);
      const l={ci,co,k,weights,bias,slope:null};
      if(activation)l.slope=yield* take(co);return l;
    };
    const enc0=[],enc1=[];
    for(let i=0;i<ENCODER.length;i++)enc0.push(yield* conv(...ENCODER[i],3,i!==7));
    for(const shape of ENCODER)enc1.push(yield* conv(...shape));
    // ncnn serializes this slope after the second encoder branch, not beside conv_14.
    enc0[7].slope=yield* take(72);
    let sharedEncoder=true;
    for(let i=0;i<8;i++)for(const key of ['weights','bias','slope']){
      const a=enc0[i][key],b=enc1[i][key];
      for(let j=0;j<a.length;j++){
        if(a[j]!==b[j]){sharedEncoder=false;break;}
        if((j&4095)===4095)yield;
      }
    }
    if(!sharedEncoder)throw new Error('Encoder branches differ; cached features would be invalid.');
    const dec=[];
    for(const [ci,c,co]of DECODER){
      const entry=yield* conv(ci,c),r1=yield* conv(c,c),s1=yield* conv(24,24);
      const r2=yield* conv(c,c),s2=yield* conv(24,24),r3=yield* conv(c,c,3,false);
      r3.slope=yield* take(c); // PReLU after the residual sum, not before it.
      const up=yield* conv(c,co,4,false);
      dec.push({entry,r1,s1,r2,s2,r3,up});
    }
    if(at!==bytes.length)throw new Error(`Weight layout mismatch: consumed ${at}, expected ${bytes.length}.`);
    return {encoder:enc0,decoder:dec,sharedEncoder,bytesConsumed:at};
  }
  function decodeWeights(input) {
    const steps=decodeSteps(input);let result;
    do{result=steps.next();}while(!result.done);
    return result.value;
  }
  async function decodeWeightsAsync(input,{signal=null,yieldTask=()=>new Promise(r=>setTimeout(r,0)),budgetMs=2}={}) {
    const check=()=>{if(signal?.aborted){const e=new Error('Neural preparation cancelled.');e.name='AbortError';throw e;}};
    check();const steps=decodeSteps(input);let start=performance.now();
    try{
      while(true){
        check();const result=steps.next();if(result.done)return result.value;
        if(performance.now()-start>=budgetMs){await yieldTask();check();start=performance.now();}
      }
    }finally{steps.return();}
  }
  async function verifyBytes(input) {
    const bytes=input instanceof Uint8Array?input:new Uint8Array(input);
    if(bytes.length!==MODEL.bytes)throw new Error(`Expected ${MODEL.bytes} bytes, received ${bytes.length}.`);
    const header=new TextEncoder().encode(`blob ${bytes.length}\0`), all=new Uint8Array(header.length+bytes.length);
    all.set(header);all.set(bytes,header.length);
    const digest=await root.crypto.subtle.digest('SHA-1',all);
    const hex=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
    if(hex!==MODEL.gitBlob)throw new Error('Model checksum mismatch. The downloaded file was not installed.');
    return bytes;
  }
  function dimensions(w,h,profile='balanced',step=0) {
    if(!(w>0&&h>0))throw new Error('Invalid video dimensions.');
    // Inference size is independent of source reconstruction and canvas resolution.
    const cap=(profile==='quality'?[512,448,384,320]:[320,288,256])[clamp(step,0,profile==='quality'?3:2)];
    const scale=Math.min(1,cap/Math.max(w,h));
    const activeW=Math.max(1,Math.round(w*scale)),activeH=Math.max(1,Math.round(h*scale));
    return {w:Math.max(32,Math.ceil(activeW/32)*32),h:Math.max(32,Math.ceil(activeH/32)*32),activeW,activeH,cap};
  }
  // Fixed-time predictions must not be stretched to arbitrary presentation phases.
  function targetPhase(displayMs,sourceMs) {
    if(!(displayMs>0&&sourceMs>0))return .5;
    const slots=Math.max(1,Math.round(.5*sourceMs/displayMs));
    return clamp(slots*displayMs/sourceMs,.35,.75);
  }
  function phaseFits(nowPhase,predictedPhase,displayMs,sourceMs) {
    return nowPhase>=predictedPhase-.08 && nowPhase<.92 &&
      nowPhase-predictedPhase<=Math.min(.22,Math.max(.10,.6*displayMs/sourceMs));
  }
  const api={MODEL,ENCODER,DECODER,halfToFloat,decodeWeights,decodeWeightsAsync,verifyBytes,dimensions,targetPhase,phaseFits};
  root.VENeuralSpec=api;if(typeof module!=='undefined')module.exports=api;
})(globalThis);
