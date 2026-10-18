// GPU ownership/task ordering only; native performance and pixels are separate.
'use strict';
const assert=require('node:assert/strict');
const Runtime=require('../neural/webgpu-runtime.js');
const originalFrame=global.VideoFrame;
function harness({rejectVideo=false,failSubmit=false,slots=1,importError=null,frameError=null,frameImportError=null}={}){
 const events=[],frames=[],fences=[];
 const video={videoWidth:64,videoHeight:32,currentTime:.5};
 global.VideoFrame=class {
  constructor(input){assert.equal(input,video);if(frameError)throw frameError;this.closed=false;frames.push(this);events.push('frame');}
  close(){assert.equal(this.closed,false);this.closed=true;events.push('close');}
 };
 const sources=Array.from({length:slots},()=>{const texture={snapshot:true};texture.createView=()=>({texture});return {texture,refs:0,serial:-1,epoch:-1,frame:null};});
 const texture=sources[0].texture;
 const engine=Object.assign(Object.create(Runtime.prototype),{
  destroyed:false,lost:false,resizing:null,epoch:0,sourceW:64,sourceH:32,externalSource:false,videoSnapshot:true,videoImportFailed:false,
  sources,diagnostics:{videoSnapshots:0,videoSnapshotFallbacks:0,captureMisses:0},
  gl:{isContextLost:()=>false},presentationJobs:new Set(),imageSampler:{},
  capturePipeline:{pipeline:{},layout:{},bindings:[{binding:0,name:'source',kind:'external-texture'},{binding:1,name:'sampler',kind:'sampler'},{binding:2,name:'output',kind:'storage-texture'}]},
 });
 engine.device={
  importExternalTexture({source}){events.push(source===video?'import-video':'import-frame');if(importError&&source===video)throw importError;if(rejectVideo&&source===video)throw new TypeError('unsupported video');if(frameImportError&&source!==video)throw frameImportError;return {source};},
  createBindGroup({entries}){assert.equal(entries[1].resource,engine.imageSampler);assert.ok(sources.some(s=>s.texture===entries[2].resource.texture));return {entries};},
  createCommandEncoder(){events.push('encoder');return {
   beginComputePass(){return {setPipeline(){},setBindGroup(i,group){assert.equal(i,0);assert.notEqual(group.entries[0].resource.source.closed,true);},
    dispatchWorkgroups(...size){assert.deepEqual(size,[8,4]);events.push('dispatch');},end(){}};},
   finish(){events.push('finish');return {};},
  };},
  queue:{submit(){events.push('submit');if(failSubmit)throw new Error('submit failure');},onSubmittedWorkDone(){events.push('fence');return new Promise(resolve=>fences.push(resolve));}},
 };
 // These methods are real production methods; the fake GPU keeps only handles.
 return {engine,video,texture,events,frames,fences};
}
(async()=>{
 try{
  const h=harness();assert.equal(h.engine.captureFrame(h.video,1),true);
  assert.deepEqual(h.events,['import-video','encoder','dispatch','finish','submit','fence'],'import through submission finishes synchronously');
  assert.equal(h.frames.length,0,'native video path creates no VideoFrame');
  assert.equal(h.engine.sources[0].serial,1);assert.equal(h.engine.sourceResource(h.engine.sources[0]),h.texture);
  assert.equal(h.engine.captureFrame(h.video,1),true);assert.equal(h.engine.diagnostics.videoSnapshots,1,'duplicate identity does not recapture');
  assert.equal(h.engine.sources[0].refs,1,'capture owns its destination until the GPU copy drains');
  assert.equal(h.engine.captureFrame(h.video,2),false,'in-flight destination cannot be overwritten');
  assert.equal(h.engine.diagnostics.captureMisses,1);
  h.fences.shift()();await Promise.allSettled([...h.engine.presentationJobs]);assert.equal(h.engine.sources[0].refs,0);
  h.engine.resizing=Promise.resolve();const live=h.engine.presentationSource(-1,h.video);
  assert.equal(live.input.external.source,h.video);live.release();assert.equal(h.frames.length,0,'resizing live presentation also avoids VideoFrame materialization');

  const ring=harness({slots:4});for(let i=0;i<4;i++)assert.equal(ring.engine.captureFrame(ring.video,i),true);
  assert.equal(ring.engine.captureFrame(ring.video,4),false,'a slow GPU cannot enqueue a fifth copy');
  assert.equal(ring.engine.diagnostics.videoSnapshots,4);ring.fences.splice(0).forEach(resolve=>resolve());
  await Promise.allSettled([...ring.engine.presentationJobs]);assert.ok(ring.engine.sources.every(s=>s.refs===0));

  const fallback=harness({rejectVideo:true});assert.equal(fallback.engine.captureFrame(fallback.video,1),true);
  assert.equal(fallback.engine.videoImportFailed,true);assert.equal(fallback.frames[0].closed,false,'fallback frame stays alive until copy drains');
  assert.equal(fallback.engine.diagnostics.videoSnapshotFallbacks,1);fallback.fences.shift()();
  await Promise.allSettled([...fallback.engine.presentationJobs]);assert.equal(fallback.frames[0].closed,true);
  const imports=fallback.events.filter(e=>e==='import-video').length;
  fallback.engine.captureFrame(fallback.video,2);assert.equal(fallback.events.filter(e=>e==='import-video').length,imports,'unsupported API is not retried every frame');
  fallback.fences.shift()();await Promise.allSettled([...fallback.engine.presentationJobs]);

  const failure=harness({rejectVideo:true,failSubmit:true});assert.throws(()=>failure.engine.captureFrame(failure.video,1),/submit failure/);
  assert.equal(failure.frames[0].closed,true);assert.equal(failure.engine.sources[0].serial,-1,'failed copy does not publish a snapshot');
  const transientError=Object.assign(new Error('source not ready'),{name:'InvalidStateError'}),transient=harness({importError:transientError});
  assert.equal(transient.engine.captureFrame(transient.video,1),false,'a temporarily missing decoded image waits for the next frame');
  assert.equal(transient.engine.videoImportFailed,false,'a transient source error does not blacklist direct import');
  assert.equal(transient.frames.length,0);assert.equal(transient.engine.sources[0].refs,0);
  assert.equal(transient.engine.sources[0].serial,-1,'a transient failure publishes no stale source identity');
  assert.equal(transient.engine.presentationSource(-1,transient.video),null,'live presentation also tolerates a temporarily unavailable image');
  transient.engine.device.importExternalTexture=({source})=>({source});
  assert.equal(transient.engine.captureFrame(transient.video,2),true,'the same device recovers on the next decoded frame');
  transient.fences.shift()();await Promise.allSettled([...transient.engine.presentationJobs]);
  for(const options of [{frameError:transientError},{frameImportError:transientError}]){
   const unavailable=harness({rejectVideo:true,...options});
   assert.equal(unavailable.engine.captureFrame(unavailable.video,1),false,'fallback capture also waits for an available decoded frame');
   assert.equal(unavailable.engine.presentationSource(-1,unavailable.video),null,'fallback presentation also waits for an available decoded frame');
   assert.ok(unavailable.frames.every(frame=>frame.closed),'failed fallback imports close every temporary VideoFrame');
   assert.equal(unavailable.engine.sources[0].refs,0);assert.equal(unavailable.engine.sources[0].serial,-1);
   assert.equal(unavailable.fences.length,0,'missing pixels submit no GPU work');
  }
  const deviceFailure=harness({importError:Object.assign(new Error('lost device'),{name:'OperationError'})});
  assert.throws(()=>deviceFailure.engine.captureFrame(deviceFailure.video,1),/lost device/,'device errors still propagate');
  const chromiumEmpty=harness({importError:Object.assign(new Error("Failed to execute 'importExternalTexture' on 'GPUDevice': Failed to import texture from video element that doesn't have back resource."),{name:'OperationError'})});
  assert.equal(chromiumEmpty.engine.captureFrame(chromiumEmpty.video,1),false,'native Chromium missing-backing error waits for decoded pixels');
  assert.equal(chromiumEmpty.engine.presentationSource(-1,chromiumEmpty.video),null);
  assert.equal(chromiumEmpty.engine.videoImportFailed,false,'a temporary missing backing does not blacklist native capture');
  console.log('PASS GPU video capture: synchronous submission, snapshot identity, locked pool and fallback lifetime (mock GPU).');
 }finally{if(originalFrame===undefined)delete global.VideoFrame;else global.VideoFrame=originalFrame;}
})().catch(error=>{console.error(error);process.exitCode=1;});
