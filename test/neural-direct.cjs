// Actual direct-compositor controller in a symbolic GPU environment. No GPU.
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../content.js'),'utf8');
const fixture=fs.readFileSync(path.join(__dirname,'neural-buffered.cjs'),'utf8');
const extract=name=>{const a=source.indexOf('function '+name+'('),b=source.indexOf('\nfunction ',a+1);assert.ok(a>=0&&b>a,name);return source.slice(a,b);};
const flush=()=>new Promise(resolve=>setImmediate(resolve)),plain=value=>JSON.parse(JSON.stringify(value));
const facade={...vm,runInContext(code,context,...options){
 if(code.includes('globalThis.api={')){
  const stub=/const fiScheduleMidFrame=\(\)=>\{throw new Error\('Buffered jobs use their own presentation scheduler'\);\};/;
  assert.ok(stub.test(code));code=code.replace(stub,()=>extract('fiScheduleMidFrame'));
 }
 const result=vm.runInContext(code,context,...options);
 if(code.includes('globalThis.api={'))vm.runInContext(`
  let fiDirectActive=false,fiDirectLastPrediction=null,stopped=false,cpuFrame=0,fiMidCpuMs=2;
  let status='ok',lastError='',activePipeline='',lastCanvasVisibility='';
  const canvas={width:80,height:48,parentNode:{},style:{}},compareLeftEl=null,compareRightEl=null;
  const program={},rcasProgram={};
  let metricWindow={realDrawn:0,midDrawn:0,cpuSamples:0,cpuTotal:0,cpuMax:0};
  const directCalls=[],captures=[],retentions=[],visibility=[],datasets=[],captured=new Map();let show=true,fail=false,allocations=0;
  settings.mode='ravu';settings.quality='high';settings.strength=100;settings.compare=false;
  currentVideo.readyState=4;currentVideo.parentElement={};currentVideo.token='A';
  texture.pixel='legacy source must stay untouched';
  const originalAllocate=gl.texImage2D;gl.texImage2D=(...args)=>{allocations++;originalAllocate(...args);};
  gl.texSubImage2D=()=>{throw new Error('direct rendering must not upload a WebGL image');};
  engine.compositor={ready:true,canRenderDimensions:()=>true,setVisible:value=>visibility.push(value)};
  const originalReset=engine.reset.bind(engine);engine.reset=()=>{originalReset();captured.clear();};
  engine.captureFrame=(video,serial)=>{const frame={serial,token:video.token,w:video.videoWidth,h:video.videoHeight};captures.push(frame);captured.set(serial,frame);return true;};
  engine.hasCapturedFrame=serial=>!engine.resizing&&captured.has(serial);
  engine.retainPrediction=slot=>{const prediction={serial:engine.result.serial,phase:engine.result.phase,slot};retentions.push(prediction);return prediction;};
  engine.render=()=>{throw new Error('direct prediction must not pass through WebGL canvas export');};
  engine.presentFrame=(serial,config,video)=>{if(fail)throw new Error('injected direct failure');const frame=captured.get(serial);
   if(serial!==-1&&!frame)return false;directCalls.push({kind:'source',serial,config,token:serial===-1?video.token:frame.token,shown:show});return show;};
  engine.presentPrediction=(texture,config,anchor,video)=>{if(fail)throw new Error('injected direct failure');directCalls.push({kind:'mid',texture,config,anchor,token:video.token,shown:show});return show;};
  const syncLayout=()=>{},canShowOverlayFrame=()=>canRender()&&status==='ok';
  const updateCanvasDataset=(...args)=>datasets.push(args);
  ${['frameDrawKind','adjustedRcasStrength','shouldUseRavu','fiLeaveDirectCompositor','fiDirectConfig','fiDrawDirect','recordDraw','updateCanvasVisibility','fiMidBudgetMs','fiShouldPresentMid'].map(extract).join('\n')}
  draw=(${extract('draw')});
  Object.assign(api,{
   captureDirect(token,time,w=80,h=48){now=time;currentVideo.token=token;currentVideo.videoWidth=w;currentVideo.videoHeight=h;
    canvas.width=w;canvas.height=h;draw({newVideoFrame:true,frameTime:time,videoMetadata:{expectedDisplayTime:time}});return fiPairSerial;},
   mid(pair,phase,time){now=time;draw({fiMid:true,fiBuffered:pair,fiPhase:phase});},
   redraw(options={}){draw(options);},
   tryDirect(){return fiDrawDirect({},'redraw',now);},
   config:fiDirectConfig,
   legacyCapture(){return fiAfterVideoUpload(currentVideo,false);},
   configure(values){Object.assign(settings,values);},
   output(w,h){canvas.width=w;canvas.height=h;},
   paused(value){currentVideo.paused=value;},
   visibility(value){visible=value;updateCanvasVisibility();},
   shown(value){show=value;},
   dropCaptured(serial){captured.delete(serial);},
   resizing(value){engine.resizing=value?Promise.resolve():null;},
   expireEpoch(){fiBufferedEpoch++;},
   sourceToken(token){feedSessionId++;currentVideo={...currentVideo,token};resetFiPairState();},
   direct:()=>({active:fiDirectActive,presentation:fiLastPresentation,epoch:fiBufferedEpoch,serial:fiPairSerial,
    calls:directCalls,captures,retentions,visibility,datasets,allocations,counters:{...metricWindow},
    identity:[fiPrevTexture?.pixel,fiCurrTexture?.pixel,fiHistoryTexture?.pixel],
    w:fiTextureW,h:fiTextureH,bw:fiBufferedW,bh:fiBufferedH,pipeline:activePipeline,neural:fiNeuralResult,target:fiNeuralTarget})
  });
 `,context);
 return result;
}};
const scope={__dirname,setImmediate,require:name=>name==='node:vm'?facade:require(name)};
const boundary=fixture.indexOf('(async()=>{');assert.ok(boundary>0);
vm.runInNewContext(fixture.slice(0,boundary)+'\nglobalThis.make=harness;',scope);
const harness=scope.make,D=1000/60;
(async()=>{
 const h=harness();const first=h.captureDirect('A',1000);h.captureDirect('B',1000+D);
 assert.equal(h.direct().allocations,0,'direct capture creates identity tokens without GL storage/upload');
 assert.deepEqual(plain(h.direct().identity),[null,null,null]);
 assert.deepEqual(plain(h.direct().captures.map(frame=>frame.token)),['A','B']);
 assert.equal(h.direct().calls[0].serial,first);assert.equal(h.direct().calls[1].serial,first,'second frame presents the delayed first source');
 h.time(1000+D+8);h.resolve(0);await flush();const pair=h.pair(h.jobs()[0].serial);
 assert.equal(pair.ready,true);assert.ok(pair.gpuTexture);assert.equal(h.inspect().renders.length,0,'ready neural result stays on GPU');
 h.captureDirect('C',1000+2*D);assert.equal(h.direct().calls.at(-1).serial,first,'three-anchor presentation keeps matching delayed source');
 const before=h.direct().counters.midDrawn;h.mid(pair,pair.slot.phase,pair.slot.time);
 const mid=h.direct().calls.at(-1);assert.equal(mid.kind,'mid');assert.equal(mid.anchor,pair.serial-1);assert.equal(mid.texture.phase,pair.slot.phase);
 assert.equal(h.direct().counters.midDrawn,before+1);assert.match(h.direct().pipeline,/FI ifrnet/);
 const captures=h.direct().captures.length,counters=plain(h.direct().counters);h.redraw();
 assert.equal(h.direct().calls.at(-1).texture,pair.gpuTexture,'redraw preserves the retained GPU midpoint');
 assert.equal(h.direct().captures.length,captures);assert.deepEqual(plain(h.direct().counters),counters,'redraw cannot inflate capture or midpoint counters');
 h.mid(pair,pair.slot.phase+.02,pair.slot.time);assert.deepEqual(plain(h.direct().counters),counters,'wrong inferred phase is rejected');
 h.mid(pair,pair.slot.phase,pair.slot.expires+1);assert.deepEqual(plain(h.direct().counters),counters,'expired midpoint is rejected');
 h.time(pair.slot.time);h.shown(false);h.mid(pair,pair.slot.phase,pair.slot.time);assert.deepEqual(plain(h.direct().counters),counters,'failed presentation is never counted');h.shown(true);
 h.expireEpoch();const callCount=h.direct().calls.length;h.mid(pair,pair.slot.phase,pair.slot.time);assert.equal(h.direct().calls.length,callCount,'old epoch cannot present');

 const serial=harness();serial.captureDirect('A',1000);serial.captureDirect('B',1000+D);serial.time(1000+D+8);serial.resolve(0);await flush();
 const old=serial.pair(serial.jobs()[0].serial);serial.captureDirect('C',1000+2*D);serial.captureDirect('D',old.slot.time-.1);
 const calls=serial.direct().calls.length;serial.mid(old,old.slot.phase,old.slot.time);assert.equal(serial.direct().calls.length,calls,'hard S+2 invalidation applies to retained textures');

 const single=harness();single.period(1000/30);single.captureDirect('A',1000);single.captureDirect('B',1000+1000/30);
 single.time(1042);single.resolve(0);await flush();const prediction=single.direct().neural,target=single.direct().target;
 assert.ok(prediction?.gpuTexture);single.mid(undefined,target.phase,target.time);
 assert.equal(single.direct().calls.at(-1).texture,prediction.gpuTexture,'one-frame result uses its retained GPU texture');
 const singleCount=single.direct().counters.midDrawn;single.mid(undefined,target.phase+.01,target.time);assert.equal(single.direct().counters.midDrawn,singleCount);
 single.sourceToken('next');const noStale=single.direct().calls.length;single.mid(undefined,target.phase,target.time);assert.equal(single.direct().calls.length,noStale,'source reset invalidates single-frame predictions');

  for(const rate of [60,30]){
   const delayed=harness(),duration=1000/rate;delayed.period(duration);
   delayed.captureDirect('A',1000);delayed.captureDirect('B',1000+duration);
   delayed.time(1000+duration+8);delayed.resolve(0);await flush();
   const predicted=rate===60?delayed.pair(delayed.jobs()[0].serial):delayed.direct().neural;
   const slot=rate===60?predicted.slot:delayed.direct().target;
   if(rate===60)delayed.captureDirect('C',1000+2*duration);
   const before=delayed.direct().counters.midDrawn;
   delayed.tick(slot.time-slot.leadMs,slot.expires-slot.leadMs+.25);
   assert.equal(delayed.direct().counters.midDrawn,before+1,rate+'fps direct compositor uses the same refresh time admitted by the scheduler');
   assert.equal(delayed.direct().calls.at(-1).texture.phase,slot.phase,'execution delay cannot alter the inferred phase');
   delayed.mid(rate===60?predicted:undefined,slot.phase,slot.expires-slot.leadMs+.25);
   assert.equal(delayed.direct().counters.midDrawn,before+1,'expired draws without a scheduled refresh remain rejected');
  }

 for(const rate of [60,30]){
  const queued=harness(),duration=1000/rate;queued.period(duration);
  queued.captureDirect('A',1000);queued.captureDirect('B',1000+duration);
  const job=queued.jobs()[0],slot=rate===60?queued.pair(job.serial).slot:queued.direct().target;
  const prediction={serial:job.serial,phase:job.phase,valid:true,submitted:true,gpuTexture:{serial:job.serial,phase:job.phase}};
  assert.equal(job.options.onSubmitted({...prediction,phase:job.phase+.1}),false,'publication cannot relabel another inferred phase');
  assert.equal(job.options.onSubmitted(prediction),true,'same-queue private prediction is accepted before notification');
  assert.equal(queued.inspect().busy,true,'publication does not release inference single-flight');
  assert.equal(job.options.onSubmitted(prediction),false,'a job is published once');
  if(rate===60)queued.captureDirect('C',1000+2*duration);
  const before=queued.direct().counters.midDrawn;
  queued.tick(slot.time-slot.leadMs);
  assert.equal(queued.direct().counters.midDrawn,before+1,rate+'fps presents the ordered prediction while completion notification is pending');
  assert.equal(queued.inspect().busy,true);
  queued.time(slot.deadline+1);queued.resolve(0,{elapsedMs:20});await flush();
  assert.equal(queued.direct().retentions.length,0,'completion cannot take another copy of the already published output');
 }
 const stalePublication=harness();stalePublication.captureDirect('A',1000);stalePublication.captureDirect('B',1000+D);
 const staleJob=stalePublication.jobs()[0];stalePublication.sourceToken('replacement');
 assert.equal(staleJob.options.onSubmitted({serial:staleJob.serial,phase:staleJob.phase,valid:true,gpuTexture:{}}),false,'retired source cannot publish an in-flight prediction');

 const failed=harness();failed.shown(false);failed.captureDirect('A',1000);assert.equal(failed.direct().counters.realDrawn,0,'failed source presentation is not counted');
 const paused=harness();paused.captureDirect('A',1000);paused.paused(true);const pausedSerial=paused.captureDirect('B',1000+D);
 assert.equal(paused.direct().calls.at(-1).serial,pausedSerial,'paused capture presents current source without playback delay');
 const pausedCaptures=paused.direct().captures.length;paused.redraw({nativeCurrent:true});assert.equal(paused.direct().captures.length,pausedCaptures);
 paused.visibility(false);assert.equal(paused.direct().visibility.at(-1),false);const hiddenCalls=paused.direct().calls.length;
 paused.captureDirect('hidden',1100);assert.equal(paused.direct().calls.length,hiddenCalls,'hidden draw does not capture or present');assert.equal(paused.direct().captures.length,pausedCaptures);
 paused.visibility(true);assert.equal(paused.direct().visibility.at(-1),true);

 const fallback=harness();fallback.captureDirect('A',1000);fallback.configure({mode:'rcas'});fallback.output(160,96);
 assert.equal(fallback.config(),null,'FSR enlargement retains its EASU renderer');assert.equal(fallback.tryDirect(),false);
 assert.equal(fallback.direct().active,false);assert.equal(fallback.direct().visibility.at(-1),false);
 assert.deepEqual([fallback.direct().w,fallback.direct().h,fallback.direct().bw,fallback.direct().bh],[0,0,0,0],'leaving direct mode invalidates token-only GL dimensions');
 fallback.legacyCapture();assert.ok(fallback.direct().allocations>=2,'legacy capture reallocates real GL endpoint storage');
 assert.deepEqual([fallback.direct().w,fallback.direct().h],[80,48]);
 const native=harness();native.configure({mode:'native'});assert.deepEqual(plain(native.config()),{algorithm:'native',strength:0,compare:false});
 const missing=harness(),missingFirst=missing.captureDirect(0,1000);missing.captureDirect(1,1000+D);missing.dropCaptured(missingFirst);
 missing.captureDirect(2,1000+2*D);assert.equal(missing.direct().calls.at(-1).serial,-1,'missing delayed source explicitly presents live video');
 missing.captureDirect(3,1000+3*D);missing.captureDirect(4,1000+4*D);missing.captureDirect(5,1000+5*D);
 const output=missing.direct().calls.filter(call=>call.kind==='source'&&call.shown).map(call=>call.token);
 assert.ok(output.every((value,i)=>!i||value>=output[i-1]),'capture miss resets/rebuffers instead of showing a newer source followed by old history: '+output);
 const resizing=harness();resizing.captureDirect('old-shape',1000);resizing.resizing(true);
 const oldCaptures=resizing.direct().captures.length;resizing.captureDirect('live-resize',1010,96,64);
 assert.equal(resizing.direct().captures.length,oldCaptures,'resize live presentation admits no old source-pool capture');
 assert.equal(resizing.direct().calls.at(-1).serial,-1);assert.equal(resizing.direct().calls.at(-1).token,'live-resize');
 const retired=harness();retired.captureDirect('old-A',1000);retired.captureDirect('old-B',1000+D);const oldJob=retired.jobs()[0];
 retired.sourceToken('new-source');assert.equal(oldJob.options.cacheValid(),false);retired.resolve(0);await flush();assert.equal(retired.direct().retentions.length,0,'retired completion cannot retain a GPU prediction');
 console.log('PASS direct controller: GPU-only capture/retention, source and prediction ownership, buffered/single-frame guards, actual-show counters, redraw/visibility/paused/source transitions and FSR fallback.');
})().catch(error=>{console.error(error);process.exitCode=1;});
