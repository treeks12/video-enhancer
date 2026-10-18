// Device preparation owns no video/model resources and never destroys a
// borrowed live device when a single model preparation is cancelled.
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../neural/webgpu-device.js'),'utf8');
const defer=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const tick=()=>new Promise(r=>setImmediate(r));
const usage={COPY_SRC:4,COPY_DST:8};
// Model the HTML timer-nesting floor. MessagePort delivery is a distinct task
// source, so timers armed there start with zero nesting rather than inheriting
// a long setTimeout chain. No real sleeps or GPU notifications are required.
function eventLoop({channels=true,postThrows=false}={}){
 let now=0,next=0,current=null;const events=new Map(),timers=[],ports=[];
 const enqueue=(kind,at,callback,nesting=0)=>{const id=++next;events.set(id,{id,kind,at,callback,nesting});return id;};
 const environment={
  setTimeout(callback,delay){
   const nesting=current?.kind==='timer'?current.nesting:0;
   const actual=nesting>5&&delay<4?4:delay;
   timers.push({at:now,requested:delay,actual,nesting});
   return enqueue('timer',now+actual,callback,nesting+1);
  },
  clearTimeout:id=>events.delete(id)
 };
 if(channels)environment.MessageChannel=class {
  constructor(){
   const channel={closed:[0,0],started:0,unrefs:0,posts:0};ports.push(channel);
   this.port1={onmessage:null,start(){channel.started++;},unref(){channel.unrefs++;},close(){channel.closed[0]++;}};
   this.port2={unref(){channel.unrefs++;},close(){channel.closed[1]++;},postMessage:data=>{
    if(postThrows)throw new Error('MessagePort disabled by host');
    channel.posts++;
    // Capture the handler to exercise disposal races even if a host has
    // already queued delivery when the channel closes.
    const handler=this.port1.onmessage;enqueue('message',now,()=>handler?.({data}));
   }};
  }
 };
 const nextEvent=()=>[...events.values()].sort((a,b)=>a.at-b.at||a.id-b.id)[0];
 async function runNext(){
  const event=nextEvent();if(!event)return false;
  events.delete(event.id);now=event.at;current=event;
  try{event.callback();}finally{current=null;}
  await tick();return true;
 }
 return {environment,ports,timers,now:()=>now,pending:()=>events.size,runNext,
  async advance(duration){const until=now+duration;let turns=0;while(nextEvent()?.at<=until){assert.ok(++turns<10000,'bounded fake task loop');await runNext();}now=until;}
 };
}
function probeDevice(d,options={},timing={value:0}){
 d.buffers=[];d.submits=0;d.waits=[];
 d.createBuffer=()=>{const b={destroyed:false,destroy(){this.destroyed=true;}};d.buffers.push(b);return b;};
 d.createCommandEncoder=()=>({copyBufferToBuffer(){},finish:()=>({})});
 d.queue={submit(commands){d.submits++;if(!commands.length&&options.pumpResolve)while(d.waits.length)d.waits.shift()();},
  onSubmittedWorkDone:()=>{if(d.hold)return new Promise(resolve=>d.waits.push(resolve));timing.value+=options.latencies?.shift()??options.latency??0;return Promise.resolve();}};
 return d;
}
function harness(options={}){
 const devices=[],adapterGate=defer(),deviceGate=defer(),timing={value:0};let adapters=0,requests=0;
 function makeDevice(){const lost=defer(),d=probeDevice({lost:lost.promise,dead:0,destroy(){this.dead++;},lose(){lost.resolve({reason:'unknown'});}},options,timing);devices.push(d);return d;}
 const performanceNow=options.performanceNow||(sample=>sample.value);
 const adapter={requestDevice:async()=>{requests++;return options.holdDevice?deviceGate.promise:makeDevice();}};
 const context=vm.createContext({GPUBufferUsage:usage,setTimeout,clearTimeout,performance:{now:()=>performanceNow(timing)},navigator:{gpu:{requestAdapter:async()=>{adapters++;return options.unavailable?null:options.holdAdapter?adapterGate.promise:adapter;}}},...options.environment});
 vm.runInContext(source,context);
 return {pool:context.VENeuralDevice,devices,adapterGate,deviceGate,adapter,makeDevice,counts:()=>({adapters,requests})};
}
(async()=>{
 const h=harness(),first=h.pool.acquire(),second=h.pool.acquire();h.pool.prime();
 const [a,b]=await Promise.all([first,second]);await tick();
 assert.equal(a.device,b.device);assert.deepEqual(h.counts(),{adapters:1,requests:1});assert.equal(h.pool.status.leases,2);
 const emptyPump=h.pool.status.completionPump;assert.equal(emptyPump.tickCount,0);assert.equal(emptyPump.meanDelayMs,null);assert.equal(emptyPump.maxDelayMs,null);assert.deepEqual(Array.from(emptyPump.recentDelayMs),[]);
 assert.ok(a.device.buffers.every(buffer=>buffer.destroyed),'tiny calibration resources are released');
 const slow=harness({latency:100,pumpResolve:true}),slowLease=await slow.pool.acquire();
 assert.equal(slowLease.completionMs,100);slowLease.device.hold=true;
 const slowBefore=slowLease.device.submits;await Promise.all([slowLease.waitForCompletion(),slowLease.waitForCompletion()]);
 assert.equal(slowLease.device.submits,slowBefore+1,'one coalesced empty submit refreshes both pending completions');
 await new Promise(r=>setTimeout(r,10));assert.equal(slowLease.device.submits,slowBefore+1,'idle completion pump stops');slowLease.release();slow.pool.dispose();
 const unlucky=harness({latencies:[2,100,100]});const unluckyLease=await unlucky.pool.acquire();
 assert.equal(unluckyLease.completionMs,100,'one lucky polling phase cannot hide a coarse completion timer');unluckyLease.release();unlucky.pool.dispose();
 const changing=harness({pumpResolve:true}),changingLease=await changing.pool.acquire();changingLease.device.hold=true;
 const changingBefore=changingLease.device.submits;await changingLease.waitForCompletion();
 assert.equal(changingLease.device.submits,changingBefore+1,'watchdog detects coarse polling after a fast calibration');
 changingLease.release();changing.pool.dispose();

 const clock=eventLoop(),cooperative=harness({latency:100,environment:clock.environment}),cooperativeLease=await cooperative.pool.acquire();
 assert.equal(clock.ports.length,0,'calibration creates no idle completion channel');
 cooperativeLease.device.hold=true;const cooperativeBefore=cooperativeLease.device.submits;
 const cooperativeWaits=[cooperativeLease.waitForCompletion(),cooperativeLease.waitForCompletion()];
 const heartbeat=[];clock.environment.setTimeout(()=>heartbeat.push(clock.now()),3);
 await clock.advance(24);
 assert.equal(clock.ports.length,1,'all waits share one channel');
 assert.equal(cooperativeLease.device.submits-cooperativeBefore,12,'one coalesced refresh every two milliseconds');
 assert.deepEqual(heartbeat,[3],'unrelated timer gets a turn while notifications are pending');
 assert.ok(clock.timers.filter(timer=>timer.requested===2).every(timer=>timer.actual===2&&timer.nesting===0),
  'MessagePort task resets nesting without bypassing the two-millisecond delay');
 while(cooperativeLease.device.waits.length)cooperativeLease.device.waits.shift()();await Promise.all(cooperativeWaits);
 const stoppedAt=cooperativeLease.device.submits;await clock.advance(20);
 assert.equal(cooperativeLease.device.submits,stoppedAt);assert.equal(clock.pending(),0,'idle pump has no scheduled work');
 cooperativeLease.release();cooperative.pool.dispose();assert.deepEqual(clock.ports[0].closed,[1,1],'both shared ports close once');
 cooperative.pool.dispose();assert.deepEqual(clock.ports[0].closed,[1,1],'disposal remains idempotent');

 const metricClock=eventLoop(),metricPump=harness({latency:100,performanceNow:timing=>timing.value+metricClock.now(),environment:metricClock.environment});
 const metricLease=await metricPump.pool.acquire();assert.equal(metricLease.completionMs,100);metricLease.device.hold=true;
 const metricBefore=metricLease.device.submits,metricWaits=[metricLease.waitForCompletion(),metricLease.waitForCompletion()];
 await metricClock.advance(70);
 const pumpStatus=metricPump.pool.status.completionPump;
 assert.equal(pumpStatus.tickCount,35,'tick count includes each timer callback that actually refreshes pending work');
 assert.equal(metricLease.device.submits-metricBefore,35,'two pending waits still share one empty submit per two-millisecond tick');
 assert.equal(pumpStatus.meanDelayMs,2);assert.equal(pumpStatus.maxDelayMs,2);
 assert.deepEqual(Array.from(pumpStatus.recentDelayMs),Array(32).fill(2),'only the latest 32 real timer delays are retained');
 pumpStatus.recentDelayMs[0]=-100;assert.equal(metricPump.pool.status.completionPump.recentDelayMs[0],2,'status returns a copy of recent delays');
 assert.ok(metricClock.timers.filter(timer=>timer.requested===2).every(timer=>timer.actual===2&&timer.nesting===0));
 while(metricLease.device.waits.length)metricLease.device.waits.shift()();await Promise.all(metricWaits);
 assert.equal(metricClock.pending(),0);metricLease.release();metricPump.pool.dispose();

 const invalidClock=eventLoop();let invalidNow=null;
 const invalidPump=harness({latency:100,performanceNow:timing=>invalidNow===null?timing.value+invalidClock.now():invalidNow,environment:invalidClock.environment});
 const invalidLease=await invalidPump.pool.acquire();invalidLease.device.hold=true;const invalidWait=invalidLease.waitForCompletion();
 await invalidClock.runNext();invalidNow=NaN;await invalidClock.runNext();
 invalidNow=null;await invalidClock.runNext();invalidNow=-1;await invalidClock.runNext();
 const invalidStatus=invalidPump.pool.status.completionPump;
 assert.equal(invalidStatus.tickCount,2,'non-finite and negative timer samples still count as executed ticks');
 assert.equal(invalidStatus.meanDelayMs,null);assert.equal(invalidStatus.maxDelayMs,null);assert.deepEqual(Array.from(invalidStatus.recentDelayMs),[],'invalid delay samples do not enter the statistics');
 while(invalidLease.device.waits.length)invalidLease.device.waits.shift()();await invalidWait;await invalidClock.advance(10);
 assert.equal(invalidClock.pending(),0);invalidLease.release();invalidPump.pool.dispose();

 const fallbackClock=eventLoop({channels:false}),fallback=harness({latency:100,environment:fallbackClock.environment}),fallbackLease=await fallback.pool.acquire();
 fallbackLease.device.hold=true;const fallbackBefore=fallbackLease.device.submits,fallbackWait=fallbackLease.waitForCompletion();
 await fallbackClock.advance(24);
 assert.ok(fallbackClock.timers.some(timer=>timer.requested===2&&timer.actual===4),'fake host exposes the nested-timer floor in the fallback');
 assert.ok(fallbackLease.device.submits-fallbackBefore<12,'timer-only host retains safe fallback behavior');
 fallback.pool.dispose();while(fallbackLease.device.waits.length)fallbackLease.device.waits.shift()();await fallbackWait;
 assert.equal(fallbackClock.pending(),0);fallbackLease.release();

 const watchdogClock=eventLoop(),watchdog=harness({pumpResolve:true,environment:watchdogClock.environment}),watchdogLease=await watchdog.pool.acquire();
 watchdogLease.device.hold=true;const watchdogBefore=watchdogLease.device.submits,watchdogWait=watchdogLease.waitForCompletion();
 await watchdogClock.advance(7);assert.equal(watchdogClock.ports.length,0);assert.equal(watchdogLease.device.submits,watchdogBefore);
 await watchdogClock.advance(3);await watchdogWait;
 assert.equal(watchdogLease.device.submits,watchdogBefore+1,'eight-millisecond watchdog then delayed pump resolves changing notification latency');
 assert.equal(watchdogClock.ports.length,1);assert.equal(watchdogClock.pending(),0);watchdogLease.release();watchdog.pool.dispose();

 const staleClock=eventLoop(),stalePump=harness({latency:100,environment:staleClock.environment}),staleLease=await stalePump.pool.acquire();
 staleLease.device.hold=true;const staleBefore=staleLease.device.submits,oldWait=staleLease.waitForCompletion();
 while(staleLease.device.waits.length)staleLease.device.waits.shift()();await oldWait;
 const nextWait=staleLease.waitForCompletion();await staleClock.runNext();
 assert.equal(staleClock.timers.length,0,'old queued message cannot arm the new wait generation');
 await staleClock.runNext();await staleClock.advance(2);
 assert.equal(staleLease.device.submits,staleBefore+1,'new wait retains one correctly scheduled pump');
 while(staleLease.device.waits.length)staleLease.device.waits.shift()();await nextWait;
 await staleClock.advance(10);assert.equal(staleClock.pending(),0);assert.equal(staleClock.ports.length,1,'idle/reactivation reuses the channel');
 staleLease.release();stalePump.pool.dispose();

 const closedClock=eventLoop(),closedPump=harness({latency:100,environment:closedClock.environment}),closedLease=await closedPump.pool.acquire();
 closedLease.device.hold=true;const closedBefore=closedLease.device.submits,closedWait=closedLease.waitForCompletion();
 closedPump.pool.dispose();await closedClock.advance(100);
 assert.equal(closedLease.device.submits,closedBefore,'queued messages cannot submit after disposal');assert.equal(closedClock.timers.length,0);
 assert.deepEqual(closedClock.ports[0].closed,[1,1]);
 while(closedLease.device.waits.length)closedLease.device.waits.shift()();await closedWait;closedLease.release();
 const cancelledClock=eventLoop(),cancelledPump=harness({environment:cancelledClock.environment}),cancelledLease=await cancelledPump.pool.acquire();
 cancelledLease.device.hold=true;const cancelledWait=cancelledLease.waitForCompletion();assert.equal(cancelledClock.pending(),1);
 cancelledPump.pool.dispose();assert.equal(cancelledClock.pending(),0,'disposal cancels unactivated completion watchdogs');
 while(cancelledLease.device.waits.length)cancelledLease.device.waits.shift()();await cancelledWait;cancelledLease.release();

 const brokenClock=eventLoop({postThrows:true}),broken=harness({latency:100,pumpResolve:true,environment:brokenClock.environment}),brokenLease=await broken.pool.acquire();
 brokenLease.device.hold=true;const brokenWait=brokenLease.waitForCompletion();await brokenClock.advance(2);await brokenWait;
 assert.deepEqual(brokenClock.ports[0].closed,[1,1],'unavailable MessagePort delivery closes ports and falls back to timers');
 assert.equal(brokenClock.ports.length,1);brokenLease.release();broken.pool.dispose();

 const boundedClock=eventLoop(),bounded=harness({latency:100,environment:boundedClock.environment}),boundedLease=await bounded.pool.acquire();
 boundedLease.device.hold=true;const boundedBefore=boundedLease.device.submits,boundedWait=boundedLease.waitForCompletion();
 await boundedClock.advance(2200);
 assert.equal(boundedLease.device.submits-boundedBefore,1000,'completion pumping stops at its existing tick bound');
 assert.equal(boundedClock.pending(),0,'tick bound does not leave a message or timer loop running');
 bounded.pool.dispose();while(boundedLease.device.waits.length)boundedLease.device.waits.shift()();await boundedWait;boundedLease.release();
 a.release();a.release();b.release();assert.equal(h.pool.status.leases,0);assert.equal(a.device.dead,0,'idle shared device survives model teardown');
 a.device.lose();await tick();const fresh=await h.pool.acquire();assert.notEqual(fresh.device,a.device);assert.deepEqual(h.counts(),{adapters:2,requests:2},'device-loss recovery discovers a fresh adapter before requesting another device');fresh.release();h.pool.dispose();assert.equal(fresh.device.dead,1);
 await assert.rejects(h.pool.acquire(),{name:'AbortError'});

 const interrupted=harness({holdAdapter:true}),controller=new AbortController();
 const cancelled=interrupted.pool.acquire(controller.signal),active=interrupted.pool.acquire();controller.abort();interrupted.adapterGate.resolve(interrupted.adapter);
 await assert.rejects(cancelled,{name:'AbortError'});const good=await active;
 assert.equal(good.device.dead,0);assert.equal(interrupted.pool.status.leases,1);good.release();interrupted.pool.dispose();

 const closed=harness({holdDevice:true}),pending=closed.pool.acquire();await tick();closed.pool.dispose();
 const late=closed.makeDevice();closed.deviceGate.resolve(late);await assert.rejects(pending,{name:'AbortError'});assert.equal(late.dead,1,'late device after page teardown is released');

 const losing=harness({holdDevice:true,latency:100}),staleDevice=losing.makeDevice();staleDevice.hold=true;
 const staleAcquire=losing.pool.acquire();losing.deviceGate.resolve(staleDevice);await tick();staleDevice.lose();await tick();
 // The next adapter/device request is independent while the old calibration
 // still owns a callback. Its eventual success cannot publish old timing.
 const freshDevice=losing.makeDevice();losing.adapter.requestDevice=async()=>freshDevice;
 const replacement=await losing.pool.acquire();assert.equal(replacement.completionMs,100);
 staleDevice.hold=false;while(staleDevice.waits.length)staleDevice.waits.shift()();
 await assert.rejects(staleAcquire,{name:'AbortError'});assert.equal(losing.pool.status.completionMs,100);
 assert.equal(replacement.device,freshDevice);replacement.release();losing.pool.dispose();

 const noAdapter=harness({unavailable:true});await assert.rejects(noAdapter.pool.acquire(),/adapter/);
 await assert.rejects(noAdapter.pool.acquire(),/adapter/);assert.equal(noAdapter.counts().adapters,1,'unsupported pages do not retry capabilities on each frame');
 noAdapter.pool.dispose();

 // document_start may cache only the adapter during spatial-only playback;
 // requesting FI later consumes it to create and calibrate the shared device.
 let settings={mode:'off',fiEngine:'ifrnet',fiInfra:false},videos=[{readyState:4,paused:true,ended:false}],storageChange,mutation,pagehide,autoAdapters=0,autoRequests=0,disconnects=0,observes=0;
 const autoDevice=probeDevice({lost:new Promise(()=>{}),destroy(){this.dead=true;}});
 const document={querySelector:()=>videos[0]||null,querySelectorAll:()=>videos};
 const auto=vm.createContext({document,GPUBufferUsage:usage,setTimeout,clearTimeout,navigator:{gpu:{requestAdapter:async()=>{autoAdapters++;return {requestDevice:async()=>{autoRequests++;return autoDevice;}};}}},
  MutationObserver:class {constructor(fn){mutation=fn;}observe(){observes++;}disconnect(){disconnects++;}},
  browser:{storage:{local:{get:async()=>settings},onChanged:{addListener:fn=>{storageChange=fn;}}}},
  addEventListener:(name,fn)=>{if(name==='pagehide')pagehide=fn;}});
 vm.runInContext(source,auto);await tick();assert.equal(autoAdapters,0,'Disabled mode never prepares a device even when video is present');assert.equal(autoRequests,0);
 videos=[];
 settings={mode:'ravu',fiEngine:'ifrnet',fiInfra:false};storageChange({mode:{}},'local');await tick();
 assert.equal(autoAdapters,0,'spatial-only mode waits until a video element exists');assert.equal(autoRequests,0);
 assert.equal(typeof mutation,'function','spatial-only mode observes for a video element without requiring FI');
 videos=[{readyState:4,paused:true,ended:false}];mutation();await tick();assert.equal(autoAdapters,1);assert.equal(autoRequests,0);assert.ok(disconnects>0);
 assert.deepEqual(autoDevice.buffers,[],'adapter prewarm creates no calibration buffers');
 assert.equal(auto.VENeuralDevice.status.ready,false);assert.equal(auto.VENeuralDevice.status.leases,0,'adapter prewarm has no ready device or model lease');
 mutation();settings.mode='ravu';storageChange({mode:{}},'local');await tick();
 assert.equal(autoAdapters,1);assert.equal(autoRequests,0,'repeated video and settings checks reuse one adapter prewarm');
 settings.fiInfra=true;storageChange({fiInfra:{}},'local');await tick();
 assert.equal(autoAdapters,1);assert.equal(autoRequests,1,'enabling FI consumes the cached adapter instead of requesting another');
 assert.ok(autoDevice.buffers.length>0&&autoDevice.buffers.every(buffer=>buffer.destroyed),'FI activation releases calibration buffers');
 assert.equal(auto.VENeuralDevice.status.ready,true);assert.equal(auto.VENeuralDevice.status.leases,0);
 settings.fiInfra=false;storageChange({fiInfra:{}},'local');await tick();settings.fiInfra=true;storageChange({fiInfra:{}},'local');await tick();
 assert.equal(autoAdapters,1);assert.equal(autoRequests,1,'subsequent FI toggles reuse the prepared device');
 settings.mode='off';storageChange({mode:{}},'local');await tick();
 assert.equal(autoAdapters,1);assert.equal(autoRequests,1,'turning mode off does not start duplicate preparation');
 pagehide({persisted:true});assert.equal(autoDevice.dead,undefined);pagehide({persisted:false});assert.equal(autoDevice.dead,true);
 let engineSettings={mode:'native',fiEngine:'classic',fiInfra:true},engineVideos=[{readyState:4,paused:true,ended:false}],engineStorageChange,engineMutation,enginePagehide,engineAdapters=0,engineRequests=0;
 const engineDevice=probeDevice({lost:new Promise(()=>{}),destroy(){this.dead=true;}});
 const engineContext=vm.createContext({document:{querySelector:()=>engineVideos[0]||null,querySelectorAll:()=>engineVideos},GPUBufferUsage:usage,setTimeout,clearTimeout,
  navigator:{gpu:{requestAdapter:async()=>{engineAdapters++;return {requestDevice:async()=>{engineRequests++;return engineDevice;}};}}},
  MutationObserver:class {constructor(fn){engineMutation=fn;}observe(){}disconnect(){}},
  browser:{storage:{local:{get:async()=>engineSettings},onChanged:{addListener:fn=>{engineStorageChange=fn;}}}},
  addEventListener:(name,fn)=>{if(name==='pagehide')enginePagehide=fn;}});
 vm.runInContext(source,engineContext);await tick();
 assert.equal(engineAdapters,0,'classic engine does not prewarm even in supported mode with video');assert.equal(engineRequests,0);assert.equal(engineDevice.buffers.length,0);
 engineSettings.fiEngine='analytic';engineStorageChange({fiEngine:{}},'local');await tick();
 assert.equal(engineAdapters,0,'analytic engine does not prewarm');assert.equal(engineRequests,0);assert.equal(engineDevice.buffers.length,0);
 engineSettings.fiEngine='ifrnet';engineStorageChange({fiEngine:{}},'local');await tick();
 assert.equal(engineAdapters,1);assert.equal(engineRequests,1,'switching to IFRNet with video starts one preparation');
 assert.ok(engineDevice.buffers.length>0&&engineDevice.buffers.every(buffer=>buffer.destroyed));
 assert.equal(engineContext.VENeuralDevice.status.leases,0);
 enginePagehide({persisted:false});assert.equal(engineDevice.dead,true);
 let liveSettings={mode:'rcas',fiEngine:'ifrnet',fiInfra:false},liveStorageChange,livePagehide,liveAdapters=0,liveRequests=0,liveObserves=0,liveDisconnects=0;
 const liveVideos=[{readyState:4,paused:true,ended:false},{readyState:4,paused:false,ended:false}],liveDevice=probeDevice({lost:new Promise(()=>{}),destroy(){this.dead=true;}});
 const liveContext=vm.createContext({document:{querySelector:()=>liveVideos[0]||null,querySelectorAll:()=>liveVideos},GPUBufferUsage:usage,setTimeout,clearTimeout,
  navigator:{gpu:{requestAdapter:async()=>{liveAdapters++;return {requestDevice:async()=>{liveRequests++;return liveDevice;}};}}},
  MutationObserver:class {constructor(){}observe(){liveObserves++;}disconnect(){liveDisconnects++;}},
  browser:{storage:{local:{get:async()=>liveSettings},onChanged:{addListener:fn=>{liveStorageChange=fn;}}}},
  addEventListener:(name,fn)=>{if(name==='pagehide')livePagehide=fn;}});
 vm.runInContext(source,liveContext);await tick();
 assert.equal(liveAdapters,0,'a second actively playing video blocks unrequested spatial-mode preparation');
 assert.equal(liveRequests,0,'active playback does not request a GPU device before FI is requested');
 assert.equal(liveObserves,0,'an already populated live video DOM leaves no mutation observer running');
 liveSettings.fiInfra=true;liveStorageChange({fiInfra:{}},'local');await tick();
 assert.equal(liveAdapters,1);assert.equal(liveRequests,1,'requested FI may prepare during playback');
 assert.ok(liveDevice.buffers.length>0&&liveDevice.buffers.every(buffer=>buffer.destroyed));
 assert.equal(liveContext.VENeuralDevice.status.leases,0);
 liveSettings.fiInfra=false;liveStorageChange({fiInfra:{}},'local');await tick();
 liveSettings.fiInfra=true;liveStorageChange({fiInfra:{}},'local');await tick();
 assert.equal(liveAdapters,1);assert.equal(liveRequests,1,'subsequent FI toggles reuse the prepared device');
 livePagehide({persisted:true});assert.equal(liveDevice.dead,undefined);livePagehide({persisted:false});assert.equal(liveDevice.dead,true);
 let delayedAdapters=0,delayedRequests=0,delayedObserves=0,releaseDelayedSettings;
 const delayedSettings=new Promise(resolve=>{releaseDelayedSettings=resolve;}),delayedVideos=[{readyState:4,paused:false,ended:false}],delayedDevice=probeDevice({lost:new Promise(()=>{}),destroy(){this.dead=true;}});
 const delayedContext=vm.createContext({document:{querySelector:()=>delayedVideos[0]||null,querySelectorAll:()=>delayedVideos},GPUBufferUsage:usage,setTimeout,clearTimeout,
  navigator:{gpu:{requestAdapter:async()=>{delayedAdapters++;return {requestDevice:async()=>{delayedRequests++;return delayedDevice;}};}}},
  MutationObserver:class {observe(){delayedObserves++;}disconnect(){}},
  browser:{storage:{local:{get:()=>delayedSettings},onChanged:{addListener(){}}}},addEventListener(){}});
 vm.runInContext(source,delayedContext);await tick();releaseDelayedSettings({mode:'native',fiEngine:'ifrnet',fiInfra:false});await tick();
 assert.equal(delayedAdapters,0,'late settings read does not start GPU work over an active unrequested video');
 assert.equal(delayedRequests,0);assert.equal(delayedObserves,0,'late settings do not attach an observer to a populated live DOM');
 let loadingAdapters=0,loadingRequests=0,loadingPagehide;
 const loadingDevice=probeDevice({lost:new Promise(()=>{}),destroy(){this.dead=true;}}),loadingVideo={readyState:0,paused:false,ended:false};
 const loadingContext=vm.createContext({document:{querySelector:()=>loadingVideo,querySelectorAll:()=>[loadingVideo]},GPUBufferUsage:usage,setTimeout,clearTimeout,
  navigator:{gpu:{requestAdapter:async()=>{loadingAdapters++;return {requestDevice:async()=>{loadingRequests++;return loadingDevice;}};}}},
  browser:{storage:{local:{get:async()=>({mode:'native',fiEngine:'ifrnet',fiInfra:false})}}},addEventListener:(name,fn)=>{if(name==='pagehide')loadingPagehide=fn;}});
 vm.runInContext(source,loadingContext);await tick();
 assert.equal(loadingAdapters,1,'a video without decoded frames still permits prewarming before FI');
 assert.equal(loadingRequests,0);assert.deepEqual(loadingDevice.buffers,[]);assert.equal(loadingContext.VENeuralDevice.status.ready,false);
 assert.equal(loadingContext.VENeuralDevice.status.leases,0,'loading video adapter prewarm has no device lease');
 loadingPagehide({persisted:false});
 let heldAdapters=0,heldRequests=0,heldPagehide,releaseHeldAdapter;
 const heldAdapterResult=new Promise(resolve=>{releaseHeldAdapter=resolve;}),heldVideo={readyState:0,paused:false,ended:false};
 const heldDevice=probeDevice({lost:new Promise(()=>{}),destroy(){this.dead=true;}});
 const heldContext=vm.createContext({document:{querySelector:()=>heldVideo,querySelectorAll:()=>[heldVideo]},GPUBufferUsage:usage,setTimeout,clearTimeout,
  navigator:{gpu:{requestAdapter:async()=>{heldAdapters++;return heldAdapterResult;}}},
  browser:{storage:{local:{get:async()=>({mode:'native',fiEngine:'ifrnet',fiInfra:false})}}},
  addEventListener:(name,fn)=>{if(name==='pagehide')heldPagehide=fn;}});
 vm.runInContext(source,heldContext);await tick();assert.equal(heldAdapters,1);assert.equal(heldRequests,0);
 heldPagehide({persisted:false});releaseHeldAdapter({requestDevice:async()=>{heldRequests++;return heldDevice;}});await tick();
 assert.equal(heldRequests,0,'disposing during adapter prewarm never requests a device after the adapter arrives');
 assert.deepEqual(heldDevice.buffers,[]);assert.equal(heldContext.VENeuralDevice.status.disposed,true);
 let manualPagehide;
 const manualDocument=vm.createContext({document:{},GPUBufferUsage:usage,setTimeout,clearTimeout,
  navigator:{gpu:{requestAdapter:async()=>({requestDevice:async()=>probeDevice({lost:new Promise(()=>{}),destroy(){this.dead=true;}})})}},
  addEventListener:(name,fn)=>{if(name==='pagehide')manualPagehide=fn;}});
 vm.runInContext(source,manualDocument);const manualLease=await manualDocument.VENeuralDevice.acquire();
 assert.equal(typeof manualPagehide,'function','manual API pages register teardown even without extension storage');
 manualPagehide({persisted:false});assert.equal(manualLease.device.dead,true);manualLease.release();
 console.log('PASS: spatial adapter prewarm, lazy FI device calibration, shared leases, abort/loss/teardown and unsupported-capability bounds');
 console.log('PASS: cooperative completion pump preserves 2ms cadence, coalescing, watchdog, fairness, timer fallback, stale-task/disposal safety and tick bound');
})().catch(error=>{console.error(error);process.exitCode=1;});
