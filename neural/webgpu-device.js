/* One shared WebGPU device per document. Discover the adapter before decoded
 * playback when possible; device allocation requires requested interpolation. */
(function(root){
'use strict';
let device=null,pending=null,adapterTask=null,failure=null,disposed=false,leases=0,observer=null,completionMs=null,generation=0;
const calibrated=new WeakMap();
const waits=new Set(),completionWaits=new Set();
let pumpTimer=null,pumpTicks=0,pumpChannel=null,pumpChannelUnavailable=false,pumpMessagePending=false,pumpGeneration=0;
let completionPumpTickCount=0,completionPumpDelayCount=0,completionPumpDelayTotal=0,completionPumpMaxDelayMs=null,completionPumpRecentDelayMs=[];
const mark=name=>root.performance?.mark?.('ve-device-'+name);
const time=()=>root.performance?.now?.()??Date.now();
const sampleTime=()=>{try{return time();}catch{return NaN;}};
function recordPumpTick(delayMs){
 completionPumpTickCount++;
 if(!Number.isFinite(delayMs)||delayMs<0)return;
 completionPumpDelayCount++;completionPumpDelayTotal+=delayMs;
 completionPumpMaxDelayMs=completionPumpMaxDelayMs===null?delayMs:Math.max(completionPumpMaxDelayMs,delayMs);
 completionPumpRecentDelayMs.push(delayMs);if(completionPumpRecentDelayMs.length>32)completionPumpRecentDelayMs.shift();
}
function abort(){const error=new Error('Neural device preparation cancelled.');error.name='AbortError';return error;}
async function measureCompletion(created){
 let src=null,dst=null;
 try{
  src=created.createBuffer({size:16,usage:GPUBufferUsage.COPY_SRC});dst=created.createBuffer({size:16,usage:GPUBufferUsage.COPY_DST});
  const samples=[];
  for(let i=0;i<3;i++){
   if(disposed)throw abort();
   const encoder=created.createCommandEncoder();encoder.copyBufferToBuffer(src,0,dst,0,16);created.queue.submit([encoder.finish()]);
   const start=time();await created.queue.onSubmittedWorkDone();samples.push(time()-start);
  }
  // A first callback can coincide with an existing poll. The median rejects
  // that lucky phase as well as one unusually slow initialization callback.
  return samples.sort((a,b)=>a-b)[1];
 }finally{src?.destroy();dst?.destroy();}
}
function stopPump(){
 if(pumpTimer!==null){root.clearTimeout(pumpTimer);pumpTimer=null;}
 pumpMessagePending=false;pumpGeneration++;
}
function closePumpChannel(){
 const channel=pumpChannel;pumpChannel=null;
 if(!channel)return;
 channel.port1.onmessage=null;
 try{channel.port1.close();}catch{}
 try{channel.port2.close();}catch{}
}
function armPumpTimer(){
 if(pumpTimer!==null||disposed||!waits.size||pumpTicks>=1000)return;
 const armedAt=sampleTime();
 pumpTimer=root.setTimeout(()=>{
  pumpTimer=null;if(disposed||!waits.size)return;pumpTicks++;
  recordPumpTick(sampleTime()-armedAt);
  // Firefox polls completion callbacks on a coarse timer. An empty submit
  // asks the implementation to poll without adding GPU work or blocking JS.
  for(const current of new Set([...waits].map(wait=>wait.device)))try{current.queue.submit([]);}catch{}
  schedulePump();
 },2);
}
function schedulePump(){
 if(pumpTimer!==null||pumpMessagePending||disposed||!waits.size||pumpTicks>=1000)return;
 if(!pumpChannelUnavailable&&!pumpChannel){
  try{
   if(typeof root.MessageChannel!=='function')throw new Error('MessageChannel unavailable');
   pumpChannel=new root.MessageChannel();
   pumpChannel.port1.onmessage=event=>{
    if(disposed||event.data!==pumpGeneration)return;
    pumpMessagePending=false;armPumpTimer();
   };
   pumpChannel.port1.start?.();
   // Node-based hosts may expose ports as well. Idle ports need no keepalive.
   pumpChannel.port1.unref?.();pumpChannel.port2.unref?.();
  }catch{closePumpChannel();pumpChannelUnavailable=true;}
 }
 if(!pumpChannel){armPumpTimer();return;}
 // A MessagePort task resets HTML timer nesting. Rearming directly from the
 // previous timer eventually clamps a nominal 2ms delay to at least 4ms.
 pumpMessagePending=true;
 try{pumpChannel.port2.postMessage(pumpGeneration);}
 catch{stopPump();closePumpChannel();pumpChannelUnavailable=true;armPumpTimer();}
}
function waitForCompletion(current){
 const promise=current.queue.onSubmittedWorkDone();
 const latency=calibrated.get(current);
 if(disposed)return promise;
 const wait={device:current,watchdog:null};let settled=false;
 completionWaits.add(wait);
 const activate=()=>{
  if(disposed||settled)return;
  if(!waits.size)pumpTicks=0;waits.add(wait);schedulePump();
 };
 if((latency??0)>8)activate();
 else wait.watchdog=root.setTimeout(()=>{wait.watchdog=null;activate();},8);
 return promise.finally(()=>{
  settled=true;if(wait.watchdog!==null)root.clearTimeout(wait.watchdog);
  completionWaits.delete(wait);
  waits.delete(wait);if(!waits.size)stopPump();
 });
}
function prepareAdapter(){
 if(disposed)return Promise.reject(abort());
 if(!adapterTask)adapterTask=(async()=>{
  if(!root.navigator?.gpu)throw new Error('WebGPU is unavailable.');
  mark('adapter-start');const adapter=await root.navigator.gpu.requestAdapter();mark('adapter-ready');
  if(disposed)throw abort();
  if(!adapter)throw new Error('No WebGPU adapter is available.');
  return adapter;
 })();
 return adapterTask;
}
async function acquire(signal=null){
 if(disposed||signal?.aborted)throw abort();
 if(failure)throw failure;
 if(!pending){
  const token=++generation;
  pending=(async()=>{
   const adapter=await prepareAdapter();
   if(disposed)throw abort();
   // An adapter can request a device only once. After it is consumed, a later
   // device-loss recovery must discover a fresh adapter.
   adapterTask=null;
   mark('request-start');const created=await adapter.requestDevice();mark('ready');
   if(disposed){created.destroy();throw abort();}
   device=created;
   created.lost.then(()=>{if(device===created){generation++;device=null;pending=null;failure=null;completionMs=null;}});
   let measured;
   try{measured=await measureCompletion(created);}catch(error){if(device===created){device=null;created.destroy();}throw error;}
   if(disposed||token!==generation||device!==created)throw abort();
   completionMs=measured;calibrated.set(created,measured);
   return created;
  })().catch(error=>{if(token===generation){pending=null;if(!disposed)failure=error;}throw error;});
 }
 const current=await pending;
 if(disposed||signal?.aborted||current!==device)throw abort();
 leases++;let released=false;
 return {device:current,completionMs,waitForCompletion:()=>waitForCompletion(current),release(){if(!released){released=true;leases--;}}};
}
function prime(){acquire().then(lease=>lease.release()).catch(()=>{});}
function primeAdapter(){if(!disposed&&!failure&&!device&&!pending)prepareAdapter().catch(()=>{});}
function dispose(){
 if(disposed)return;disposed=true;generation++;observer?.disconnect();observer=null;stopPump();
 closePumpChannel();
 for(const wait of completionWaits)if(wait.watchdog!==null)root.clearTimeout(wait.watchdog);
 waits.clear();completionWaits.clear();
 device?.destroy();device=null;adapterTask=null;
}
const api={acquire,prime,dispose,get status(){return {ready:!!device&&completionMs!==null,pending:!!pending&&completionMs===null,failed:!!failure,completionMs,leases,disposed,
 completionPump:{tickCount:completionPumpTickCount,meanDelayMs:completionPumpDelayCount?completionPumpDelayTotal/completionPumpDelayCount:null,maxDelayMs:completionPumpMaxDelayMs,recentDelayMs:completionPumpRecentDelayMs.slice()}};}};
root.VENeuralDevice=api;if(typeof module!=='undefined')module.exports=api;
if(!root.document)return;
root.addEventListener?.('pagehide',event=>{if(!event.persisted)dispose();});
const ext=root.browser??root.chrome;
if(!ext?.storage?.local)return;
let enabled=false,started=false,allowLivePreparation=false;
const consider=()=>{
 if(!enabled||started||disposed||!document.querySelector('video'))return;
 observer?.disconnect();observer=null;
 // Spatial-only playback must not pay cold GPU discovery after motion has
 // already started. Prefer the loading/paused window; a requested FI engine
 // can still acquire the device later if no such opportunity was available.
 if(!allowLivePreparation)for(const video of document.querySelectorAll('video'))if(video.readyState>=2&&!video.paused&&!video.ended)return;
 if(allowLivePreparation){started=true;prime();}
 else primeAdapter();
};
const configure=settings=>{
 // Spatial-only pages can discover their adapter before decoded playback.
 // Device allocation and calibration still require requested interpolation.
 enabled=['native','rcas','ravu'].includes(settings.mode)&&(!settings.fiEngine||settings.fiEngine==='ifrnet');
 allowLivePreparation=Boolean(settings.fiInfra);
 consider();
 if(enabled&&!started&&!observer&&!document.querySelector('video')&&typeof MutationObserver!=='undefined'){
  observer=new MutationObserver(consider);observer.observe(document,{childList:true,subtree:true});
 }else if(!enabled){observer?.disconnect();observer=null;}
};
// Only requested FI creates a device. No model, textures or inference
// are allocated here, and no additional extension permissions are needed.
ext.storage.local.get({mode:'off',fiEngine:'ifrnet',fiInfra:false}).then(configure).catch(()=>{});
ext.storage.onChanged?.addListener((changes,area)=>{
 if(area!=='local'||(!changes.mode&&!changes.fiEngine&&!changes.fiInfra))return;
 ext.storage.local.get({mode:'off',fiEngine:'ifrnet',fiInfra:false}).then(configure).catch(()=>{});
});
})(globalThis);
