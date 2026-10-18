// Behavioral tests of the shipped two-frame IFRNet controller. Symbolic GPU
// textures expose endpoint/target ownership; no browser or shader execution.
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../content.js'),'utf8');
const names=['cancelFiMid','resetFiPairState','fiEnsureFrameTextures','fiEnsureBufferedTextures',
 'fiAfterVideoUpload','fiRequestGpuPair','fiRequestIfrPair','fiRenderMidToOut','fiScheduleBufferedMidFrame'];
const extract=name=>{
 const start=source.indexOf('function '+name+'('),end=source.indexOf('\nfunction ',start+1);
 assert.ok(start>=0&&end>start,'production function '+name);return source.slice(start,end);
};
const duration=1000/60,tick=()=>new Promise(resolve=>setImmediate(resolve));
const plain=value=>JSON.parse(JSON.stringify(value));
function harness(){
 const context=vm.createContext({FiQuality:require('../fi-quality.js'),assert});
 vm.runInContext(`
  let now=1000,nextTexture=0,nextRaf=0,bound=null;
  const performance={now:()=>now},rafs=new Map(),jobs=[],renders=[],presented=[];
  const requestAnimationFrame=cb=>{const id=++nextRaf;rafs.set(id,cb);return id;};
  const cancelAnimationFrame=id=>rafs.delete(id);
  let settings={fiInfra:true,fiEngine:'ifrnet',fiBlockMatch:true,fiSceneCut:true,fiDebug:0,interaction:'quality'};
  let currentVideo={videoWidth:80,videoHeight:48,playbackRate:1,paused:false,ended:false},feedSessionId=1;
  const isCurrentFeedSession=(video,session)=>video===currentVideo&&session===feedSessionId;
  let visible=true;const canRender=()=>visible;
  let gl={TEXTURE_2D:1,RGBA:2,UNSIGNED_BYTE:3,
   bindTexture:(_kind,tex)=>{bound=tex;},
   texImage2D:(_a,_b,_c,w,h)=>{bound.width=w;bound.height=h;bound.pixel=null;}};
  const fiMakeTexture=()=>({id:++nextTexture,pixel:null});
  let texture={pixel:null},textureWidth=80,textureHeight=48;
  let fiPrevTexture=null,fiCurrTexture=null,fiTextureW=0,fiTextureH=0,fiOutTexture=fiMakeTexture();
  let fiHasPrev=false,fiHasCurr=false,fiBufferedMode=false,fiBufferedEpoch=0,fiHasHistory=false;
  let fiHistoryTexture=null,fiBufferedW=0,fiBufferedH=0,fiPresentedAnchor=null;
  const fiBufferedTextures=[],fiBufferedPairs=new Map();
  let fiPairSerial=0,fiPairDiscontinuous=false,fiPairAnchorTime=1000;
  let fiNeuralResult=null,fiNeuralTarget=null,fiMethod='skip',fiConfidence=0,fiSkipReason='';
  let fiGpuReadySerial=-1,fiGpuElapsedMs=0,fiGpuBusy=false,fiGpuState='ready';
  let fiLatencyActive=false,fiLastPresentation='current',fiMidRaf=null;
  let fiPrevLuma=null,fiCurrLuma=null,fiLumaW=0,fiLumaH=0,fiSceneCutHold=0;
  let fiLastMatch=null,fiLastBackwardMatch=null,fiLastRealCpuMs=0,fiMotionRetryAt=0;
  let scrolling=false,lastVideoFrameDurationMs=1000/60,metricReport={videoFps:60};
  let fiDisplayPeriod=1000/165,fiDisplayReference=1000,fiDisplayLeadMs=0,fiDisplayCallbackDelayMs=0;
  const fiDisplayCallbackDelays=[];
  const fiWarmGpu=()=>{},fiUpdateLumaSample=()=>{throw new Error('IFRNet must not read CPU luma');};
  const fiScheduleMidFrame=()=>{throw new Error('Buffered jobs use their own presentation scheduler');};
  const fiUseClassicFallback=(_engine,error)=>{throw error;};
  const fiEnsureOut=(w,h)=>{fiOutTexture.width=w;fiOutTexture.height=h;return w>0&&h>0;};
  const fiCopyTexture=(src,dst,w,h)=>{dst.pixel=src.pixel;dst.width=w;dst.height=h;};
  const engine={kind:'ifrnet',busy:false,stats:{ms:0,completed:0,late:0},lastRun:null,
   reset(){this.resets=(this.resets||0)+1;},
   estimate(prev,curr,serial,phase,options){
    assert.equal(this.busy,false,'only one estimate may own the engine');this.busy=true;
    return new Promise(resolve=>jobs.push({prev,curr,serial,phase,options,resolve,settled:false,
     pixels:{prev:prev.pixel,curr:curr.pixel}}));
   },
   render(prev,curr,target,width,height){
    assert.equal(this.busy,false,'flow must be synthesized before the next estimate starts');
    const result=this.result;
    assert.equal(prev.pixel,result.pixels.prev,'frozen previous RGB endpoint');
    assert.equal(curr.pixel,result.pixels.curr,'frozen current RGB endpoint');
    target.pixel={kind:'mid',prev:prev.pixel,curr:curr.pixel,phase:result.phase};
    renders.push({serial:result.serial,target:target.id,width,height,pixel:target.pixel});return true;
   }};
  let fiGpuEngine=engine;
  ${names.map(extract).join('\n')}
  function draw(options){
   if(fiRenderMidToOut(options.fiPhase,options.fiBuffered,options.fiPresentationTime))presented.push({
    at:now,serial:options.fiBuffered.serial,phase:options.fiPhase,pixel:fiOutTexture.pixel,
    compare:fiPresentedAnchor.pixel,busy:engine.busy});
  }
  globalThis.api={
   capture(pixel,time,expected=time,w=80,h=48){now=time;currentVideo.videoWidth=w;currentVideo.videoHeight=h;
    textureWidth=w;textureHeight=h;texture.pixel=pixel;fiPairAnchorTime=expected;
    const requested=fiAfterVideoUpload(currentVideo);return {serial:fiPairSerial,requested};},
   latency(value=true){fiLatencyActive=value;},schedule:fiScheduleBufferedMidFrame,
   tick(time,executedAt=time){now=executedAt;const callbacks=[...rafs.values()];rafs.clear();for(const cb of callbacks)cb(time);},
   time(time){now=time;},period(value){lastVideoFrameDurationMs=value;metricReport.videoFps=1000/value;},
   gap(){fiPairDiscontinuous=true;},reset:resetFiPairState,
   motion(value){settings.fiBlockMatch=value;},display(hz){fiDisplayPeriod=1000/hz;},
   source(){feedSessionId++;resetFiPairState();},
   pair:serial=>fiBufferedPairs.get(serial),render:(pair,phase)=>fiRenderMidToOut(phase,pair),
   resolve(index,{sceneCut=false,elapsedMs=8,valid=true,cachedEncoder=true,reason=valid?undefined:"cancelled"}={}){
    const job=jobs[index];assert.ok(job&&!job.settled);job.settled=true;
    engine.busy=false;engine.result=job;engine.lastRun={cachedEncoder,reason};
    job.resolve(valid?{valid:true,serial:job.serial,phase:job.phase,sceneCut,elapsedMs}:null);
   },
   jobs:()=>jobs,history:()=>({history:fiHistoryTexture?.pixel,prev:fiPrevTexture?.pixel,curr:fiCurrTexture?.pixel}),
   inspect:()=>({serial:fiPairSerial,epoch:fiBufferedEpoch,buffered:fiBufferedMode,hasHistory:fiHasHistory,
    hasPrev:fiHasPrev,hasCurr:fiHasCurr,pairs:[...fiBufferedPairs.keys()],
    targets:fiBufferedTextures.map(t=>t.id),renders,presented,pendingRafs:rafs.size,
    busy:fiGpuBusy,method:fiMethod,reason:fiSkipReason,stats:engine.stats,compare:fiPresentedAnchor?.pixel})
  };
 `,context);
 return context.api;
}
function twoFrames(h){
 h.capture('A',1000);return h.capture('B',1000+duration).serial;
}
(async()=>{
 // Playback rate affects the available inference window, not just source FPS.
 // At 40–60 fps retain the third RGB anchor; slower video keeps one-frame
 // latency. A display with no room for an extra frame must not add buffering.
 for(const [fps,hz,buffered] of [[24,165,false],[30,165,false],[40,165,true],
   [45,165,true],[50,165,true],[60,165,true],[45,60,false],[60,60,false]]){
  const h=harness(),period=1000/fps;h.period(period);h.display(hz);
  for(let frame=0;frame<3;frame++)h.capture(String(frame),1000+frame*period);
  assert.equal(h.inspect().buffered,buffered,`${fps} fps on ${hz} Hz chooses its history depth`);
  assert.equal(h.inspect().hasHistory,buffered,`${fps} fps seeds the required RGB history`);
  assert.deepEqual(plain(h.history()),{...(buffered?{history:'0'}:{}),prev:'1',curr:'2'});
 }
 const rate=harness(),ratePeriod=1000/45;rate.period(ratePeriod);
 rate.capture('A',1000);const rateSerial=rate.capture('B',1000+ratePeriod).serial;
 rate.resolve(0);await tick();rate.latency();rate.capture('C',1000+2*ratePeriod);rate.schedule();
 const ratePair=rate.pair(rateSerial);rate.tick(ratePair.slot.time);
 assert.equal(rate.inspect().presented.length,1,'45 fps displays the stored adjacent midpoint');
 assert.deepEqual(plain(rate.inspect().presented[0].pixel),
  {kind:'mid',prev:'A',curr:'B',phase:ratePair.slot.phase});
 rate.capture('D',1000+3*ratePeriod);
 assert.equal(rate.render(ratePair,ratePair.slot.phase),false,'45 fps cannot reuse an overwritten anchor');
 const hysteresis=harness();hysteresis.period(1000/45);hysteresis.capture('A',1000);
 const entered=hysteresis.inspect().epoch;
 hysteresis.period(27);hysteresis.capture('B',1027);
 assert.equal(hysteresis.inspect().buffered,true);assert.equal(hysteresis.inspect().epoch,entered);
 hysteresis.period(31);hysteresis.capture('C',1058);
 assert.equal(hysteresis.inspect().buffered,false);assert.ok(hysteresis.inspect().epoch>entered);
 assert.equal(hysteresis.inspect().hasPrev,false,'leaving buffered mode seeds a fresh source pair');
 hysteresis.period(27);hysteresis.capture('D',1085);
 assert.equal(hysteresis.inspect().buffered,false,'small timing changes cannot immediately reenter buffering');
 hysteresis.period(25);hysteresis.capture('E',1110);
 assert.equal(hysteresis.inspect().buffered,true);assert.equal(hysteresis.inspect().hasPrev,false);

 // Early completion stores RGB. It cannot show a midpoint before the third
 // capture establishes the two-frame history anchor.
 const eager=harness(),serial=twoFrames(eager),job=eager.jobs()[0];
 assert.equal(job.serial,serial);assert.equal(job.options.valid(),true);
 eager.latency();eager.resolve(0);await tick();
 const pair=eager.pair(serial);assert.equal(pair.ready,true);
 assert.equal(eager.inspect().renders.length,1);assert.equal(eager.inspect().presented.length,0);
 eager.schedule();eager.tick(1000+duration+1);
 assert.equal(eager.inspect().pendingRafs,0,'a stored result cannot schedule itself before its history anchor');
 assert.equal(eager.inspect().presented.length,0,'no midpoint before the matching history anchor exists');
 eager.capture('C',1000+2*duration);eager.schedule();
 assert.deepEqual(plain(eager.history()),{history:'A',prev:'B',curr:'C'});
 assert.equal(eager.jobs()[1].serial,serial+1);assert.equal(eager.inspect().busy,true);
 eager.tick(pair.slot.time);
 const shown=eager.inspect().presented[0];
 assert.equal(shown.serial,serial);assert.equal(shown.phase,job.phase,'inferred phase is never relabelled');
 assert.deepEqual(plain(shown.pixel),{kind:'mid',prev:'A',curr:'B',phase:job.phase});
 assert.equal(shown.busy,true,'stored midpoint remains displayable during the next estimate');
 assert.equal(shown.compare,'A','comparison uses the stored midpoint previous anchor, not the global previous B');
 assert.equal(eager.render(pair,pair.slot.phase+.01),false,'a cached prediction cannot claim another phase');

 // Completing after the next capture must synthesize the frozen A/B pair,
 // before an adjacent B/C estimate starts and overwrites the engine flow.
 const late=harness(),lateSerial=twoFrames(late),lateJob=late.jobs()[0];late.latency();
 late.capture('C',1000+2*duration);late.schedule();
 assert.equal(late.jobs().length,1,'capture cannot overlap the unfinished estimate');
 late.time(1000+2*duration+1);late.resolve(0);await tick();
 assert.equal(late.jobs().length,2,'the adjacent pair starts after the old result is stored');
 assert.equal(late.inspect().busy,true);
 assert.deepEqual(plain(late.inspect().renders[0].pixel),{kind:'mid',prev:'A',curr:'B',phase:lateJob.phase});
 const latePair=late.pair(lateSerial);late.tick(latePair.slot.time);
 assert.equal(late.inspect().presented.length,1);

 // An early rVFC for S+2 rotates RGB before the old wall-clock deadline.
 // The hard serial gate and map pruning must still reject the old result.
 const early=harness(),earlySerial=twoFrames(early),earlyJob=early.jobs()[0];early.latency();
 early.capture('C',1000+2*duration);early.schedule();
 const beforeExpiry=earlyJob.options.deadline-.25;
 early.capture('D',beforeExpiry,1000+3*duration);
 assert.ok(beforeExpiry<earlyJob.options.deadline);assert.equal(earlyJob.options.valid(),false);
 assert.deepEqual(plain(early.history()),{history:'B',prev:'C',curr:'D'});
 early.resolve(0);await tick();
 assert.equal(early.inspect().renders.length,0,'overwritten RGB endpoints are never synthesized');
 assert.equal(early.inspect().presented.length,0);
 assert.equal(early.pair(earlySerial),undefined);

 // A ready stored target is equally invalid once S+2 arrives, even if its
 // slot is numerically unexpired. Its parity slot can then be safely reused.
 const parity=harness(),pSerial=twoFrames(parity);parity.latency();parity.resolve(0);await tick();
 const oldPair=parity.pair(pSerial),oldTarget=oldPair.texture.id;
 parity.capture('C',1000+2*duration);parity.resolve(1);await tick();
 parity.capture('D',oldPair.slot.expires-.25,1000+3*duration);
 assert.equal(parity.render(oldPair,oldPair.slot.phase),false);
 parity.resolve(2);await tick();
 const reused=parity.pair(pSerial+2);
 assert.equal(reused.texture.id,oldTarget,'only two parity targets are allocated');
 assert.equal(parity.inspect().targets.length,2);assert.ok(parity.inspect().pairs.length<=2);
 assert.deepEqual(plain(reused.texture.pixel),{kind:'mid',prev:'C',curr:'D',phase:reused.slot.phase});
 assert.equal(parity.render(oldPair,oldPair.slot.phase),false,'old map identity cannot expose newly overwritten parity pixels');

 const expired=harness(),expiredSerial=twoFrames(expired),expiredJob=expired.jobs()[0];
 expired.capture('C',1000+2*duration);expired.latency();expired.schedule();
 expired.time(expiredJob.options.deadline+1);expired.resolve(0);await tick();
 assert.equal(expired.inspect().renders.length,0);assert.equal(expired.pair(expiredSerial).ready,false);
 expired.tick(expiredJob.options.deadline+1);assert.equal(expired.inspect().presented.length,0);
 const readyExpired=harness(),readySerial=twoFrames(readyExpired);readyExpired.resolve(0);await tick();
 readyExpired.capture('C',1000+2*duration);readyExpired.latency();readyExpired.schedule();
 const readyPair=readyExpired.pair(readySerial);readyExpired.tick(readyPair.slot.expires+1);
 assert.equal(readyExpired.inspect().presented.length,0);assert.equal(readyExpired.render(readyPair,readyPair.slot.phase),false);

 const cut=harness(),cutSerial=twoFrames(cut);cut.resolve(0,{sceneCut:true});await tick();
 cut.capture('C',1000+2*duration);cut.latency();cut.schedule();
 const cutPair=cut.pair(cutSerial);cut.tick(cutPair.slot.time);cut.tick(cutPair.slot.expires+1);
 assert.equal(cut.inspect().renders.length,0);assert.equal(cut.inspect().presented.length,0,'no learned warp across a scene cut');

 for(const reason of ['reset','source','size','gap','mode','disabled','display']){
  const h=harness(),s=twoFrames(h),pending=h.jobs()[0],epoch=h.inspect().epoch;
  if(reason==='reset')h.reset();
  else if(reason==='source')h.source();
  else if(reason==='size')h.capture('C',1000+2*duration,1000+2*duration,96,64);
  else if(reason==='gap'){h.gap();h.capture('C',1000+2*duration);}
  else if(reason==='disabled'){h.motion(false);h.capture('C',1000+2*duration);}
  else if(reason==='display'){h.display(60);h.capture('C',1000+2*duration);}
  else {h.period(1000/30);h.capture('C',1000+2*duration);}
  assert.ok(h.inspect().epoch>epoch,reason+' invalidates the prediction epoch');
  assert.equal(pending.options.cacheValid(),false,reason+' invalidates old source/shape cache ownership');
  assert.equal(h.pair(s),undefined,reason+' clears old pair references');
  h.resolve(0);await tick();
  assert.equal(h.inspect().renders.length,0,reason+' rejects stale completion');
 }
 console.log('PASS buffered IFRNet: rotating RGB anchors, frozen endpoints, eager private synthesis and rendering while the next estimate is busy');
 console.log('PASS buffered IFRNet: fixed phase, serial/deadline/scene-cut guards, parity ownership, comparison anchor and reset/source/shape invalidation');
})().catch(error=>{console.error(error);process.exitCode=1;});
