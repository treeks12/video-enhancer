// Real controller functions: slot failures, in-flight ownership and late accounting.
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../content.js'),'utf8'),start=source.indexOf('function fiRequestIfrPair('),end=source.indexOf('\nfunction ',start+1);
const ctx=vm.createContext({FiQuality:require('../fi-quality.js')});
vm.runInContext(`
 let now=1000;const performance={now:()=>now};
 let currentVideo={playbackRate:1},feedSessionId=1,fiPairSerial=1,fiPairAnchorTime=1000;
 let fiHasPrev=true,fiPairDiscontinuous=false,fiGpuBusy=false,fiDisplayPeriod=1000/60,fiDisplayReference=1000,fiDisplayLeadMs=0,fiDisplayCallbackDelayMs=0;
 let fiNeuralResult=null,fiNeuralTarget=null,fiMethod='skip',fiGpuElapsedMs=0,fiGpuReadySerial=-1,fiSkipReason='';
 let fiLatencyActive=true;const scheduled=[];
 let fiBufferedMode=false,fiBufferedEpoch=0;const fiBufferedPairs=new Map(),fiBufferedTextures=[];
 const fiScheduleMidFrame=(serial,metadata)=>scheduled.push({serial,anchor:metadata.expectedDisplayTime});
 let lastVideoFrameDurationMs=1000/24,metricReport={videoFps:24},settings={fiInfra:true,fiBlockMatch:true,fiSceneCut:true};
 const fiPrevTexture={},fiCurrTexture={},jobs=[];
 let lastOptions;
 const fiGpuEngine={stats:{ms:0,completed:0,late:0},estimate:(a,b,serial,phase,options)=>{lastOptions=options;return new Promise(resolve=>jobs.push(resolve));}};
 const isCurrentFeedSession=(v,id)=>v===currentVideo&&id===feedSessionId,canRender=()=>true;
 const fiUseClassicFallback=()=>{throw new Error('Unexpected fallback');};
 ${source.slice(start,end)}
 globalThis.request=fiRequestIfrPair;
 globalThis.resolveJob=(i,result)=>jobs[i](result);
 globalThis.advance=()=>{fiPairSerial++;fiPairAnchorTime+=1000/24;fiMethod='skip';};
 globalThis.setNow=t=>{now=t;};
 globalThis.noSlot=()=>{fiDisplayPeriod=1000/24;};
 globalThis.restoreSlot=()=>{fiDisplayPeriod=1000/60;};
 globalThis.inspect=()=>({busy:fiGpuBusy,method:fiMethod,reason:fiSkipReason,ready:fiGpuReadySerial,...fiGpuEngine.stats});
 globalThis.options=()=>lastOptions;
 globalThis.configureRecovery=(latency=true)=>{jobs.length=scheduled.length=0;now=1000;fiPairSerial=10;fiPairAnchorTime=1000;
  fiGpuBusy=false;fiLatencyActive=latency;fiGpuEngine.lastRun={cachedEncoder:true};fiGpuEngine.stats.ms=3;
  feedSessionId=1;fiDisplayPeriod=1000/60;fiDisplayReference=1000;};
 globalThis.recovery=()=>({jobs:jobs.length,scheduled:scheduled.slice(),busy:fiGpuBusy});
 globalThis.changeSource=()=>{feedSessionId++;};
`,ctx);
const tick=()=>new Promise(r=>setImmediate(r));
(async()=>{
 assert.equal(ctx.request(),true);assert.ok(ctx.options().deadline>1000);assert.equal(ctx.options().valid(),true);
 assert.ok(ctx.options().deadline>1035,'cold inference targets the latest usable tick before learning its full cost');
 ctx.advance();assert.equal(ctx.options().valid(),false,'the runtime sees pair replacement before dispatching more work');assert.equal(ctx.request(),false);
 assert.match(ctx.inspect().reason,/bounded GPU slice/);assert.equal(ctx.inspect().busy,true);
 ctx.setNow(1052);ctx.resolveJob(0,{valid:true,elapsedMs:52});await tick();
 assert.equal(ctx.inspect().completed,1,'completed inference is counted even after source pair advanced');
 assert.equal(ctx.inspect().late,1);assert.equal(ctx.inspect().busy,false);
 ctx.noSlot();assert.equal(ctx.request(),false);assert.match(ctx.inspect().reason,/No extra display slot/);
 ctx.restoreSlot();assert.equal(ctx.request(),true);ctx.setNow(1053);ctx.resolveJob(1,{valid:true,elapsedMs:3});await tick();
 assert.equal(ctx.inspect().method,'ifrnet');assert.equal(ctx.inspect().ready,2,'next pair recovers without toggling');
 ctx.advance();assert.equal(ctx.request(),true);ctx.setNow(1200);ctx.resolveJob(2,{valid:true,elapsedMs:60});await tick();
 assert.equal(ctx.inspect().method,'skip');assert.match(ctx.inspect().reason,/after its display slot/);
 for(const latency of [true,false]){
  ctx.configureRecovery(latency);assert.equal(ctx.request(),true);ctx.advance();ctx.setNow(1042);
  ctx.resolveJob(0,null);await tick();
  assert.equal(ctx.recovery().jobs,2,'the adjacent pair rejected while busy gets one bounded retry after draining');
  assert.equal(ctx.recovery().busy,true);assert.equal(ctx.options().valid(),true);
  assert.equal(ctx.recovery().scheduled.length,latency?1:0,'midpoints require an already delayed anchor to preserve temporal order');
  if(latency){assert.equal(ctx.recovery().scheduled[0].serial,11);assert.equal(ctx.recovery().scheduled[0].anchor,1000+1000/24);}
  ctx.changeSource();assert.equal(ctx.options().cacheValid(),false,'a source change invalidates encoder retention independently of pair serial');
  ctx.resolveJob(1,null);await tick();assert.equal(ctx.recovery().busy,false);
 }
 ctx.configureRecovery();ctx.request();ctx.resolveJob(0,null);await tick();
 assert.equal(ctx.recovery().jobs,1,'an expired pair cannot retry itself');
 ctx.configureRecovery();ctx.request();ctx.advance();ctx.advance();ctx.resolveJob(0,null);await tick();
 assert.equal(ctx.recovery().jobs,1,'nonadjacent cached endpoints cannot start a recovery loop');
 ctx.configureRecovery();ctx.request();ctx.advance();ctx.changeSource();ctx.resolveJob(0,null);await tick();
 assert.equal(ctx.recovery().jobs,1,'a retired video session cannot retry');
 const extract=name=>{const a=source.indexOf('function '+name+'('),b=source.indexOf('\nfunction ',a+1);return source.slice(a,b);};
 const prep=vm.createContext({queueMicrotask:fn=>fn()});
 vm.runInContext(`
  let settings={fiInfra:true,fiEngine:'ifrnet',interaction:'quality'},gl={},scrolling=false,fiGpuEngine=null,fiGpuState='ready';
  let fiBlendProgram=null,fiWarpProgram=null,fiHasCurr=false,fiHasPrev=false,fiHasHistory=false,fiLatencyActive=false,fiPairSerial=0;
  let fiBufferedMode=false,fiBufferedEpoch=0;const fiBufferedPairs=new Map();
  const lastVideoFrameDurationMs=1000/24,metricReport={videoFps:24},fiDisplayPeriod=1000/60;
  let fiPrevTexture={},fiCurrTexture={},texture={},reads=0,shaders=0;
  const fiEnsureFrameTextures=()=>{},fiCopyTexture=()=>{},fiRequestGpuPair=()=>false,fiWarmGpu=()=>{};
  const fiUpdateLumaSample=()=>{reads++;},fiEnsurePrograms=()=>{shaders++;return true;};
  ${extract('warmFiPrograms')}
  ${extract('fiAfterVideoUpload')}
  globalThis.prepare=(requested,kind)=>{settings.fiEngine=requested;fiGpuEngine=kind?{kind}:null;
   warmFiPrograms();fiAfterVideoUpload({videoWidth:1280,videoHeight:720});return {reads,shaders};};
 `,prep);
 for(const kind of [null,'ifrnet','analytic']){
  const state=prep.prepare('ifrnet',kind);assert.equal(state.reads,0);assert.equal(state.shaders,0);
 }
 assert.equal(prep.prepare('neural',null).reads,0,'unready Personal backend performs no CPU analysis');
 const personal=prep.prepare('neural','neural');assert.equal(personal.reads,1,'ready Personal backend preserves its scene checks');assert.equal(personal.shaders,0);
 const classic=prep.prepare('classic','classic');assert.equal(classic.reads,2);assert.equal(classic.shaders,1,'legacy engine keeps its required preparation');

 const guard=vm.createContext({});
 vm.runInContext(`
  let settings={fiInfra:true,fiEngine:'ifrnet',fiBlockMatch:true,fiSceneCut:true,interaction:'quality'};
  let currentVideo={videoWidth:1280,videoHeight:720,playbackRate:1},scrolling=false,gl={};
  let fiGpuEngine=null,fiGpuState='preparing',fiGpuError='',fiPairSerial=40,fiBufferedEpoch=3;
  let fiHasPrev=true,fiHasCurr=true,fiPairDiscontinuous=true,fiHasHistory=true,fiBufferedMode=true,fiLatencyActive=true;
  let fiGpuReadySerial=39,fiNeuralResult={stale:true},fiNeuralTarget={stale:true},fiPresentedAnchor={stale:true};
  let fiPrevTexture={stale:true},fiCurrTexture={stale:true},fiHistoryTexture={stale:true},fiPrevLuma={stale:true},fiCurrLuma={stale:true};
  let fiLumaW=80,fiLumaH=48,fiMethod='ifrnet',fiConfidence=1,fiSceneCutHold=1,fiLastMatch={stale:true},fiLastBackwardMatch={stale:true};
  let fiLastRealCpuMs=7,fiMotionRetryAt=99,fiSkipReason='stale',fiLastPresentation='mid',fiMidRaf=7;
  let fiDisplayPeriod=1000/60,lastVideoFrameDurationMs=1000/24,metricReport={videoFps:24},texture={};
  const fiBufferedPairs=new Map([[39,{stale:true}]]),counts={ensure:0,copy:0,read:0,capture:0,warm:0,pair:0,cancel:0,engineReset:0};
  let requestedResult='requested-pair';
  const cancelAnimationFrame=()=>{counts.cancel++;};
  const fiWarmGpu=()=>{counts.warm++;};
  const fiEnsureFrameTextures=(w,h)=>{counts.ensure++;fiPrevTexture||={};fiCurrTexture||={};};
  const fiCopyTexture=()=>{counts.copy++;};
  const fiUpdateLumaSample=()=>{counts.read++;};
  const fiRequestGpuPair=()=>{counts.pair++;return requestedResult;};
  const fiMakeTexture=()=>({});
  ${extract('cancelFiMid')}
  ${extract('resetFiPairState')}
  ${extract('fiAfterVideoUpload')}
  function seedStale(){
   fiHasPrev=fiHasCurr=fiHasHistory=fiLatencyActive=fiPairDiscontinuous=true;fiBufferedMode=true;
   fiMidRaf=7;
   fiBufferedPairs.set(fiPairSerial-1,{stale:true});fiNeuralResult={stale:true};fiNeuralTarget={stale:true};
   fiGpuReadySerial=fiPairSerial-1;fiPresentedAnchor={stale:true};fiMethod='ifrnet';fiLastPresentation='mid';
  }
  function clearCounts(){for(const key of Object.keys(counts))counts[key]=0;}
  globalThis.guardApi={
   stage(kind){
    clearCounts();seedStale();currentVideo.videoWidth=kind==='resize'?1920:1280;currentVideo.videoHeight=kind==='resize'?1080:720;
    if(kind==='cold'){fiGpuEngine=null;fiGpuState='preparing';}
    else if(kind==='resize'){fiGpuEngine={kind:'ifrnet',lost:false,reset(){counts.engineReset++;}};fiGpuState='preparing';}
    else{fiGpuEngine={kind:'ifrnet',lost:true,reset(){counts.engineReset++;}};fiGpuState='ready';}
    requestedResult='request-'+kind;const oldEpoch=fiBufferedEpoch,ret=fiAfterVideoUpload(currentVideo);
    return {ret,counts:{...counts},epochDelta:fiBufferedEpoch-oldEpoch,hasPrev:fiHasPrev,hasCurr:fiHasCurr,hasHistory:fiHasHistory,
     latency:fiLatencyActive,buffered:fiBufferedMode,pairs:fiBufferedPairs.size,neural:fiNeuralResult,target:fiNeuralTarget,method:fiMethod};
   },
   readyAgain(){
    clearCounts();fiGpuState='ready';fiGpuEngine={kind:'ifrnet',lost:false,reset(){counts.engineReset++;},captureFrame(){counts.capture++;}};
    requestedResult='request-ready-'+(counts.pair+1);
    const first=fiAfterVideoUpload(currentVideo),firstPrev=fiHasPrev,firstCurr=fiHasCurr;
    requestedResult='request-ready-'+(counts.pair+1);
    const second=fiAfterVideoUpload(currentVideo);
    return {first,second,firstPrev,firstCurr,hasPrev:fiHasPrev,hasCurr:fiHasCurr,counts:{...counts}};
   }
  };
 `,guard);
 for(const kind of ['cold','resize','loss']){
  const state=guard.guardApi.stage(kind);
  assert.equal(state.ret,'request-'+kind,kind+' preparation must return the GPU-pair request result');
  assert.deepEqual(JSON.parse(JSON.stringify(state.counts)),{ensure:0,copy:0,read:0,capture:0,warm:1,pair:1,cancel:1,engineReset:kind==='cold'?0:1},
   kind+' preparation warms the backend and requests a pair without allocating, copying, reading, or capturing');
  assert.equal(state.epochDelta,1,kind+' preparation invalidates the old pair epoch');
  assert.equal(state.hasPrev,false);assert.equal(state.hasCurr,false);assert.equal(state.hasHistory,false);assert.equal(state.latency,false);
  assert.equal(state.buffered,false);assert.equal(state.pairs,0);assert.equal(state.neural,null);assert.equal(state.target,null);
 }
 const afterReady=guard.guardApi.readyAgain();
 assert.deepEqual(JSON.parse(JSON.stringify(afterReady.counts)),{ensure:2,copy:2,read:0,capture:2,warm:2,pair:2,cancel:0,engineReset:0},
  'once ready, ordinary IFRNet uploads allocate/copy/capture each source and request adjacent pairs');
 assert.deepEqual([afterReady.first,afterReady.second],['request-ready-1','request-ready-2']);
 assert.deepEqual([afterReady.firstPrev,afterReady.firstCurr,afterReady.hasPrev,afterReady.hasCurr],[false,true,true,true],
  'normal adjacent pair seeding resumes after GPU preparation completes');
 console.log('PASS: IFRNet controller reports slot/busy/late states and resumes with correct single-flight ownership');
 console.log('PASS: IFRNet startup avoids unused CPU analysis/shaders; classic and Personal paths preserve required checks');
 console.log('PASS: IFRNet cold/resize/loss preparation skips uploads, resets stale buffered state, then seeds pairs when ready');
})().catch(e=>{console.error(e);process.exitCode=1;});
