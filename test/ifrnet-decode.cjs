// Exact checkpoint conversion oracle captured before the cooperative parser.
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const S=require('../neural/model-spec.js'),G=require('../neural/graph.js');
const bytes=fs.readFileSync(path.join(__dirname,'../models/ifrnet.bin'));
function hashes(model){
 const decoded=crypto.createHash('sha256'),packed=crypto.createHash('sha256');
 for(const layer of [...model.encoder,...model.decoder.flatMap(d=>Object.values(d))]){
  for(const a of [layer.weights,layer.bias,layer.slope])if(a)decoded.update(new Uint8Array(a.buffer,a.byteOffset,a.byteLength));
  const a=G.packLayer(layer).data;packed.update(new Uint8Array(a.buffer,a.byteOffset,a.byteLength));
 }
 return {decoded:decoded.digest('hex'),packed:packed.digest('hex')};
}
const expected={decoded:'ddbb0f335efc42b20142e646cb4a42437e93867595ad86c0684315a0e4c00527',
 packed:'f82fce30f198d0ea81c959875180408828b5f31489d5c4dc562a425eb108632b'};
(async()=>{
 // Both calls begin with a cold conversion table. Cancelling the first must
 // not publish a partial table to the concurrent decoder.
 const controller=new AbortController();let slices=0;
 const cancelled=S.decodeWeightsAsync(bytes,{signal:controller.signal,budgetMs:0,yieldTask:async()=>{controller.abort();}});
 const decoded=S.decodeWeightsAsync(bytes,{budgetMs:0,yieldTask:()=>{slices++;return new Promise(r=>setImmediate(r));}});
 await assert.rejects(cancelled,{name:'AbortError'});
 assert.deepEqual(hashes(await decoded),expected);assert.ok(slices>100,'parser yields inside large weight arrays');
 assert.deepEqual(hashes(S.decodeWeights(bytes)),expected,'sync and async share exact conversion');
 const bad=Uint8Array.from(bytes);bad[0]=0xff;
 await assert.rejects(S.decodeWeightsAsync(bad),/encoding/);
 const stopped=new AbortController();stopped.abort();
 await assert.rejects(S.decodeWeightsAsync(bytes,{signal:stopped.signal}),{name:'AbortError'});
 console.log('PASS: cooperative IFRNet decode/packing is bit-exact, yields within arrays, cancels and isolates concurrent preparations');
})().catch(e=>{console.error(e);process.exitCode=1;});
