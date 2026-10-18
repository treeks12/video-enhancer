// Install the real Store package in a disposable native browser profile.
// Unlike page-script fixtures this exercises extension isolation, document_start,
// real storage/messaging, bundled model URLs and VideoFrame/WebGPU permissions.
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const cp=require('node:child_process'),puppeteer=require('puppeteer-core');
const root=path.resolve(__dirname,'..'),kind=process.env.TEST_BROWSER||'firefox';
assert.ok(['firefox','chromium'].includes(kind));
const uuid='7217abf0-9c45-4626-893d-d590ce32b605';
const feeds=process.env.ADDON_FEED==='1';
const mixedFeed=process.env.ADDON_MIXED_FEED==='1';
const feedFixtures=feeds||mixedFeed;
const phasedInit=process.env.ADDON_INIT_PHASED==='1';
const pausedStart=process.env.ADDON_PAUSED_START==='1';
const profile=process.env.ADDON_FI_PROFILE||'quality';
const interaction=process.env.ADDON_INTERACTION||'quality';
assert.ok(['balanced','quality'].includes(profile),'supported installed add-on FI profile');
assert.ok(['smooth','balanced','quality'].includes(interaction),'supported interaction profile');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(action,predicate,timeout=60000){
 const start=Date.now();let last;
 while(Date.now()-start<timeout){try{last=await action();if(predicate(last))return last;}catch(error){last={error:error.message};}await wait(250);}
 throw new Error('Native add-on state timed out: '+JSON.stringify(last));
}
(async()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'video-enhancer-addon-'));
 let browser,server;
 try{
  const build=cp.spawnSync('python',['tools/package.py','--flavor','store','--output',path.join(temp,'build')],{cwd:root,encoding:'utf8'});
  assert.equal(build.status,0,build.stderr);
  const version=JSON.parse(fs.readFileSync(path.join(root,'manifest.json'))).version;
  const zip=path.join(temp,'build',`video-enhancer-${version}-store-${kind==='firefox'?'firefox':'chromium'}.zip`);
  const addon=path.join(temp,'addon');
  const unpack=cp.spawnSync('python',['-c','import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])',zip,addon],{encoding:'utf8'});
  assert.equal(unpack.status,0,unpack.stderr);
  const movies=new Map();
  const movieFixtures=[['motion','1280x720'],...(feedFixtures?[['portrait','720x1280'],['small','640x360']]:[]),
   ...(mixedFeed?[['square','720x720'],['wide','1280x540']]:[])];
  for(const [name,size] of movieFixtures){
   const movie=path.join(temp,name+'.mp4');
   const encode=cp.spawnSync(process.env.FFMPEG_PATH||'ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i',`testsrc2=size=${size}:rate=60`,
    '-t','35','-c:v','libx264','-threads','2','-preset','ultrafast','-crf','28','-pix_fmt','yuv420p','-movflags','+faststart','-an',movie],{encoding:'utf8'});
   assert.equal(encode.status,0,encode.stderr);movies.set('/'+name+'.mp4',fs.readFileSync(movie));
  }
  server=http.createServer((req,res)=>{
   const bytes=movies.get(new URL(req.url,'http://localhost').pathname);
   if(bytes){
    res.setHeader('Content-Type','video/mp4');res.setHeader('Accept-Ranges','bytes');
    const range=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range||'');
    if(range){const start=Number(range[1]),end=range[2]?Math.min(Number(range[2]),bytes.length-1):bytes.length-1;
     res.writeHead(206,{'Content-Range':`bytes ${start}-${end}/${bytes.length}`,'Content-Length':end-start+1});res.end(bytes.subarray(start,end+1));
    }else{res.setHeader('Content-Length',bytes.length);res.end(bytes);}return;
   }
   res.setHeader('Content-Type','text/html');
   if(mixedFeed){
    res.end(`<!doctype html><meta charset="utf-8"><title>Native Store mixed feed</title><style>
     *{box-sizing:border-box}html,body{margin:0;background:#20242b;color:#eee;font:16px sans-serif}
     body{width:100%;padding:12px}.article{width:600px;margin:0 auto 20px;background:#303640}
     .article h2{margin:0;padding:8px}.article video{display:block;width:600px;object-fit:contain;background:#111}
     #video-motion{height:338px}#video-portrait{height:500px}#video-square{height:500px}#video-wide{height:250px}
     .separator{display:block;width:600px;height:140px;margin:12px auto;background:#ddd}
     #video-trap-wrapper{position:fixed;inset:0;width:1000px;height:700px;visibility:hidden}
    </style><article class="article" id="article-motion"><h2>motion</h2><video id="video-motion" src="/motion.mp4" muted ${pausedStart?'preload="auto"':'autoplay'} loop playsinline></video></article>
     <svg class="separator" viewBox="0 0 600 140" aria-hidden="true"><rect width="600" height="140" fill="#d9c5a0"/><circle cx="120" cy="70" r="42" fill="#b55"/></svg>
     <article class="article" id="article-portrait"><h2>portrait</h2><video id="video-portrait" src="/portrait.mp4" muted preload="metadata" playsinline></video></article>
     <svg class="separator" viewBox="0 0 600 140" aria-hidden="true"><rect width="600" height="140" fill="#a8c8bb"/><rect x="260" y="25" width="80" height="90" fill="#467"/></svg>
     <article class="article" id="article-square"><h2>square</h2><video id="video-square" src="/square.mp4" muted preload="metadata" playsinline></video></article>
     <svg class="separator" viewBox="0 0 600 140" aria-hidden="true"><rect width="600" height="140" fill="#c5b5d8"/><path d="M0 120L180 20 340 130 480 30 600 120" fill="none" stroke="#536" stroke-width="12"/></svg>
     <article class="article" id="article-wide"><h2>wide</h2><video id="video-wide" src="/wide.mp4" muted preload="metadata" playsinline></video></article>
     <div id="video-trap-wrapper"><video id="video-trap" src="/small.mp4" muted autoplay loop playsinline style="width:100%;height:100%"></video></div>
     <script>window.mixedActiveId='motion';</script>`);
   }else res.end(`<!doctype html><title>Native Store add-on playback</title><div style="position:relative;width:960px"><video src="/motion.mp4" muted ${pausedStart?'preload="auto"':'autoplay'} loop style="width:960px;height:540px"></video></div>`);
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const origin=`http://127.0.0.1:${server.address().port}`;
  const manifest=JSON.parse(fs.readFileSync(path.join(addon,'manifest.json')));
  const prefs=kind==='firefox'?{'extensions.webextensions.uuids':JSON.stringify({[manifest.browser_specific_settings.gecko.id]:uuid})}:undefined;
  browser=await puppeteer.launch({browser:kind==='firefox'?'firefox':'chrome',headless:process.env.HEADLESS==='1',enableExtensions:true,
   userDataDir:path.join(temp,'profile'),extraPrefsFirefox:prefs,
   // Firefox 153+ requires an explicit Remote Agent opt-in to automate its
   // extension-origin popup. This applies only to this disposable profile;
   // the installed Store ZIP and extension permissions remain unchanged.
   // https://bugzilla.mozilla.org/show_bug.cgi?id=2048451
   args:kind==='chromium'?['--enable-unsafe-extension-debugging']:['--remote-allow-system-access'],
   executablePath:kind==='firefox'?(process.env.FIREFOX_PATH||'C:/Program Files/Mozilla Firefox/firefox.exe'):
    (process.env.CHROMIUM_PATH||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'),
   defaultViewport:{width:1100,height:750},timeout:60000});
  let extensionPath=addon;
  if(kind==='firefox'){extensionPath=path.join(temp,'store.xpi');fs.copyFileSync(zip,extensionPath);}
  const id=await browser.installExtension(extensionPath);
  const helper=await browser.newPage();
  const popupUrl=(kind==='firefox'?`moz-extension://${uuid}`:`chrome-extension://${id}`)+'/popup.html';
  console.error('Installed real Store package; opening extension popup.');
  try{await helper.goto(popupUrl,{waitUntil:'domcontentloaded',timeout:5000});}
  catch(error){
   // Some BiDi versions omit the privileged document's navigation event. A
   // real loaded extension realm is required; about:blank or a mocked API is
   // never accepted as a successful navigation.
   const loaded=await helper.evaluate(()=>({url:location.href,ready:document.readyState,storage:!!(globalThis.browser??globalThis.chrome)?.storage?.local}));
   if(error.name!=='TimeoutError'||loaded.url!==popupUrl||loaded.ready==='loading'||!loaded.storage)throw error;
   console.error('BiDi popup navigation event timed out; verified real loaded extension realm:',JSON.stringify(loaded));
  }
  await helper.evaluate(async({phasedInit,profile,interaction})=>{
   const api=globalThis.browser??globalThis.chrome;
   await api.storage.local.set({mode:'ravu',strength:100,quality:'high',fiInfra:!phasedInit,fiEngine:'ifrnet',fiProfile:profile,interaction});
  },{phasedInit,profile,interaction});
  console.error('Real extension storage configured; opening decoded-video fixture.');
  const page=await browser.newPage(),pageErrors=[];page.on('pageerror',error=>pageErrors.push(error.message));
  page.on('console',message=>{if(message.text().startsWith('Native device validation:'))console.error(message.text());});
  await page.evaluateOnNewDocument(()=>{
   window.health={phase:'startup',raf:[],gpu:[],pending:[],webgpuPending:0,gpuErrors:[]};let previous=performance.now(),previousObserved=previous,context=null,lastCanvas=null;
   document.addEventListener('playing',event=>{
    if(event.target?.tagName!=='VIDEO'||health.firstPlayingAt!==undefined)return;
    health.firstPlayingAt=performance.now();
    event.target.requestVideoFrameCallback?.((now,metadata)=>{health.firstVideoFrame={now,observedAt:performance.now(),expectedDisplayTime:metadata.expectedDisplayTime,mediaTime:metadata.mediaTime,presentedFrames:metadata.presentedFrames};});
   },true);
   const observedDevices=new WeakSet();
   requestAnimationFrame(function tick(now){
    const observedAt=performance.now();health.raf.push({phase:health.phase,time:now,ms:now-previous,observedAt,callbackGapMs:observedAt-previousObserved});previous=now;previousObserved=observedAt;
    const canvas=document.querySelector('#fv-enhancer-canvas');
    if(canvas&&canvas!==lastCanvas){context=canvas.getContext('webgl2');lastCanvas=canvas;}
    while(health.pending.length){
     const p=health.pending[0],state=p.context.clientWaitSync(p.sync,0,0);
     if(state===p.context.TIMEOUT_EXPIRED)break;
     health.pending.shift();p.context.deleteSync(p.sync);health.gpu.push({phase:p.phase,ms:performance.now()-p.time,failed:state===p.context.WAIT_FAILED});
    }
    const gpuCanvas=document.querySelector('#fv-enhancer-canvas-webgpu');
    const gpuContext=gpuCanvas&&gpuCanvas.style.visibility!=='hidden'?gpuCanvas.getContext('webgpu'):null;
    const device=gpuContext?.getConfiguration?.()?.device;
    if(gpuContext&&!device)health.unsupportedGpuProbe=true;
    if(device&&!observedDevices.has(device)){
     observedDevices.add(device);device.addEventListener('uncapturederror',event=>{
      const error={phase:health.phase,message:event.error.message};health.gpuErrors.push(error);
      console.error('Native device validation: '+JSON.stringify(error));
     });
    }
    if(device&&health.webgpuPending<12){
     const phase=health.phase,time=performance.now();health.webgpuPending++;
     device.queue.onSubmittedWorkDone().then(()=>health.gpu.push({phase,ms:performance.now()-time}),()=>health.gpu.push({phase,ms:performance.now()-time,failed:true})).finally(()=>health.webgpuPending--);
    }else if(!gpuContext&&context&&!context.isContextLost()&&health.pending.length<12){
     const sync=context.fenceSync(context.SYNC_GPU_COMMANDS_COMPLETE,0);context.flush();
     health.pending.push({sync,context,time:performance.now(),phase:health.phase});
    }
    requestAnimationFrame(tick);
   });
  });
  await page.goto(origin,{waitUntil:'domcontentloaded'});await page.bringToFront();
  const tabId=await until(()=>helper.evaluate(async()=>{
   const api=globalThis.browser??globalThis.chrome,tabs=await api.tabs.query({active:true,currentWindow:true});return tabs[0]?.id;
  }),id=>typeof id==='number');
  const read=async()=>{
   const state=await helper.evaluate(async tabId=>{const api=globalThis.browser??globalThis.chrome;return api.tabs.sendMessage(tabId,{type:'fv-status'});},tabId);
   if(mixedFeed)state.fixture=await page.evaluate(()=>({activeId:window.mixedActiveId,scrollY,viewport:{width:innerWidth,height:innerHeight},phase:health.phase,
    videos:[...document.querySelectorAll('video')].map(video=>{const r=video.getBoundingClientRect();return {
     id:video.id,time:video.currentTime,duration:video.duration,paused:video.paused,ended:video.ended,ready:video.readyState,
     decoded:video.getVideoPlaybackQuality().totalVideoFrames,painted:video.checkVisibility?.({visibilityProperty:true,opacityProperty:true}),
     rect:{x:r.x,y:r.y,w:r.width,h:r.height}};})}));
   return state;
  };
  let pausedStartup=null;
  if(pausedStart){
   const state=await until(read,value=>value?.status==='ok'&&value.pipeline?.startsWith('RAVU')&&value.canvasWidth>0&&value.canvasHeight>0,15000);
   const native=await page.evaluate(()=>{const video=document.getElementById('video-motion')||document.querySelector('video');
    return {paused:video.paused,ready:video.readyState,width:video.videoWidth,height:video.videoHeight};});
   assert.equal(native.paused,true,'a decoded paused video must be enhanced before playback starts');
   assert.ok(native.ready>=2);assert.equal(state.lastError,'');
   pausedStartup={...native,pipeline:state.pipeline,canvasWidth:state.canvasWidth,canvasHeight:state.canvasHeight};
   await page.evaluate(async()=>{await (document.getElementById('video-motion')||document.querySelector('video')).play();});
  }
  if(phasedInit){
   await until(read,state=>state?.status==='ok'&&state.pipeline?.startsWith('RAVU'));
   await wait(2000);await page.evaluate(()=>{health.phase='loading';});
   await helper.evaluate(async()=>{await (globalThis.browser??globalThis.chrome).storage.local.set({fiInfra:true});});
   console.error('Loading IFRNet while the real installed RAVU pipeline is already playing.');
  }
  const ready=await until(read,state=>state?.status==='ok'&&state.fi?.actualEngine==='ifrnet'&&(state.fi.apiFallbackReason||state.fi.midPerSec>0));
  if(mixedFeed)assert.ok(ready.feed?.key?.includes('/motion.mp4|'),'mixed-feed initial selection must be the visible motion video');
  console.error('Actual content script reports active neural interpolation:',JSON.stringify({backend:ready.fi.backend,presentation:ready.fi.presentationBackend,source:ready.fi.realPerSec,mid:ready.fi.midPerSec}));
  if(!ready.fi.backend.includes('WebGPU'))console.error('Real installed content-script diagnostic:',JSON.stringify(ready));
  assert.match(ready.fi.backend,/WebGPU/,'the actual content-script world must support the preferred backend');
  assert.equal(ready.fi.presentationBackend,'webgpu','the real add-on must use continuous GPU presentation');
  assert.equal(ready.fi.neural.captureMode,'snapshot','the installed package uses GPU-owned video snapshots');
  assert.equal(ready.fi.profile,profile,'the installed package uses the requested FI profile');
  assert.equal(ready.fi.apiFallbackReason,'');assert.equal(ready.fi.fallbackReason,'');
  await wait(1500);await page.evaluate(()=>{health.phase='steady';});const samples=[];
  for(let i=0;i<5;i++){await wait(1050);const state=await read();samples.push({source:state.fi.realPerSec,mid:state.fi.midPerSec,
   modelMs:state.fi.computeMs,backend:state.fi.backend,error:state.fi.backendError,method:state.fi.method,explain:state.fi.explain,
   captureMode:state.fi.neural?.captureMode,stagedConvolutions:state.fi.neural?.stagedConvolutions,videoSnapshots:state.fi.neural?.videoSnapshots,videoSnapshotFallbacks:state.fi.neural?.videoSnapshotFallbacks});}
  const transitions=[],mixedCases=[];
  if(mixedFeed){
   const names=['portrait','square','wide','motion','square'];
   const partialVisibility=()=>page.evaluate(()=>{
    const videos=[...document.querySelectorAll('video')],visible=videos.filter(video=>{
     const r=video.getBoundingClientRect(),s=getComputedStyle(video);
     return s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity||1)>0&&r.width>0&&r.height>0&&
      r.right>0&&r.bottom>0&&r.left<innerWidth&&r.top<innerHeight;
    });
    const partiallyVisible=visible.filter(video=>{
     const r=video.getBoundingClientRect();return r.left<0||r.top<0||r.right>innerWidth||r.bottom>innerHeight;
    });
    return {videoCount:videos.length,partiallyVisibleVideoCount:partiallyVisible.length};
   });
   const pauseOtherPlayers=activeId=>page.evaluate(activeId=>{
    for(const video of document.querySelectorAll('video')){
     if(video.id===`video-${activeId}`||video.id==='video-trap')continue;
     if(!video.paused)video.pause();
    }
   },activeId);
   for(const [index,name]of names.entries()){
    await page.evaluate(index=>{health.phase='mixed-feed-'+index;},index);
    const start=Date.now();
    await page.evaluate(async name=>{
     const video=document.getElementById('video-'+name);video.scrollIntoView({behavior:'instant',block:'center'});
     window.mixedActiveId=name;video.muted=true;await video.play();
    },name);
    await page.mouse.wheel({deltaY:40});
    await wait(250);
    await pauseOtherPlayers(name);
    const selected=await until(read,state=>state?.feed?.key?.includes('/'+name+'.mp4|')&&state.fi?.actualEngine==='ifrnet',15000);
    const selectionMs=Date.now()-start;
    await wait(1500);
    const readinessStart=Date.now();
    const state=await until(read,value=>value?.feed?.key?.includes('/'+name+'.mp4|')&&value.fi?.actualEngine==='ifrnet'&&
     value.fi.realPerSec>=57&&value.fi.midPerSec>0,15000);
    transitions.push({name,selectionMs,settleWaitMs:1500,readinessWaitMs:Date.now()-readinessStart,recoveryMs:Date.now()-start,
     feed:state.feed,source:state.fi.realPerSec,mid:state.fi.midPerSec,backend:state.fi.backend,error:state.fi.backendError,
     fallback:state.fi.fallbackReason,apiFallback:state.fi.apiFallbackReason,...await partialVisibility()});
    if(index===names.length-1){
     await page.evaluate(()=>{health.phase='mixed-css-resize';});
     const before=await read();
     const resizeStart=Date.now();
     const beforeSrc=await page.evaluate(()=>{
      const video=document.getElementById('video-square');return {src:video.currentSrc||video.src,width:video.videoWidth,height:video.videoHeight};
     });
     await page.evaluate(()=>{const video=document.getElementById('video-square');video.style.width='540px';video.style.height='340px';video.style.objectFit='contain';});
     await wait(500);
     const after=await read();
     const afterSrc=await page.evaluate(()=>{
      const video=document.getElementById('video-square');return {src:video.currentSrc||video.src,width:video.videoWidth,height:video.videoHeight};
     });
     assert.equal(after.feed?.id,before.feed?.id,'CSS-only square resize must preserve feed session id');
     assert.equal(afterSrc.src,beforeSrc.src,'CSS-only square resize must preserve src');
     assert.equal(afterSrc.width,720);assert.equal(afterSrc.height,720);
     assert.ok(after.feed?.key?.includes('/square.mp4|720x720'),'square source dimensions remain 720x720');
     assert.equal(after.fi?.actualEngine,'ifrnet','CSS-only square resize must preserve IFRNet');
     mixedCases.push({name:'square-css-resize',elapsedMs:Date.now()-resizeStart,feedIdBefore:before.feed?.id,feedIdAfter:after.feed?.id,
      sourceDimensions:`${afterSrc.width}x${afterSrc.height}`,srcPreserved:afterSrc.src===beforeSrc.src,actualEngine:after.fi.actualEngine});
    }
   }
   const rapidNames=['portrait','square','wide','motion'];
   await page.evaluate(()=>{health.phase='mixed-rapid-feed';});
   let lastRapidName='';
   for(let i=0;i<12;i++){
    lastRapidName=rapidNames[i%rapidNames.length];
    await page.evaluate(async({name,index})=>{
     const video=document.getElementById('video-'+name);video.scrollIntoView({behavior:'instant',block:'center'});
     window.mixedActiveId=name;video.muted=true;await video.play();
    },{name:lastRapidName,index:i});
    await page.mouse.wheel({deltaY:40});await wait(120);
   }
   await wait(250);await pauseOtherPlayers(lastRapidName);await wait(1500);
   const recovered=await until(read,state=>state?.feed?.key?.includes('/'+lastRapidName+'.mp4|')&&state.status==='ok'&&
    state.fi?.actualEngine==='ifrnet'&&state.fi.realPerSec>=57&&state.fi.midPerSec>0,15000);
   transitions.push({name:'rapid final',destination:lastRapidName,source:recovered.fi.realPerSec,mid:recovered.fi.midPerSec,
    backend:recovered.fi.backend,error:recovered.fi.backendError,fallback:recovered.fi.fallbackReason,
    apiFallback:recovered.fi.apiFallbackReason,...await partialVisibility()});
  }else if(feeds){
   const change=async(name,replace)=>page.evaluate(async({name,replace})=>{
    let video=document.querySelector('video');if(replace){const next=document.createElement('video');next.muted=true;next.autoplay=true;next.loop=true;video.pause();video.replaceWith(next);video=next;}
    video.style.cssText=name==='portrait'?'width:324px;height:576px':'width:960px;height:540px';
    video.parentElement.style.width=name==='portrait'?'324px':'960px';video.src='/'+name+'.mp4';await video.play();
   },{name,replace});
   for(const [index,[name,replace]] of [['portrait',false],['small',true],['motion',false],['portrait',true],['motion',true]].entries()){
    const old=(await read()).feed?.id;await page.evaluate(index=>{health.phase='feed-'+index;},index);const start=Date.now();await change(name,replace);
    await until(read,state=>state.status==='ok'&&state.feed?.id>old&&state.feed?.key.includes('/'+name+'.mp4|')&&state.fi.actualEngine==='ifrnet');
    await wait(1500);const state=await until(read,state=>state.fi.midPerSec>0&&state.fi.realPerSec>=57);
    transitions.push({name,replace,recoveryMs:Date.now()-start,feed:state.feed,source:state.fi.realPerSec,mid:state.fi.midPerSec,
     backend:state.fi.backend,error:state.fi.backendError,fallback:state.fi.fallbackReason,apiFallback:state.fi.apiFallbackReason});
   }
   await page.evaluate(()=>{health.phase='rapid-feed';});
   for(let i=0;i<12;i++){await change(i%2?'motion':'portrait',i%3===0);await wait(120);}
   await wait(1500);const recovered=await until(read,state=>state.status==='ok'&&state.fi.midPerSec>0&&state.fi.realPerSec>=57);
   transitions.push({name:'rapid final',source:recovered.fi.realPerSec,mid:recovered.fi.midPerSec,backend:recovered.fi.backend,error:recovered.fi.backendError,
    fallback:recovered.fi.fallbackReason,apiFallback:recovered.fi.apiFallbackReason});
  }
  const native=await page.evaluate(mixed=>{const v=mixed?document.getElementById('video-'+window.mixedActiveId):document.querySelector('video'),q=v.getVideoPlaybackQuality();return {paused:v.paused,time:v.currentTime,
   quality:{total:q.totalVideoFrames,dropped:q.droppedVideoFrames},
   videoCount:document.querySelectorAll('video').length,activeId:window.mixedActiveId||null,
   canvas:!!document.querySelector('#fv-enhancer-canvas'),canvases:[...document.querySelectorAll('canvas')].map(c=>({id:c.id,width:c.width,height:c.height,visibility:c.style.visibility}))};},mixedFeed);
  if(mixedFeed)assert.ok(native.videoCount>=4,'mixed feed must retain four or more video elements in the DOM');
  assert.equal(await page.evaluate(()=>!!health.unsupportedGpuProbe),false,'direct GPU presentation must have a working GPU completion probe');
  const responsiveness=await page.evaluate(()=>Object.fromEntries([...new Set(health.raf.map(x=>x.phase))].map(phase=>{
   const refresh=health.raf.filter(x=>x.phase===phase),raf=refresh.map(x=>x.ms),gpu=health.gpu.filter(x=>x.phase===phase).map(x=>x.ms);
   return [phase,{maxRafMs:Math.max(0,...raf),maxCallbackGapMs:Math.max(0,...refresh.map(x=>x.callbackGapMs)),over33ms:raf.filter(t=>t>33).length,maxGpuMs:Math.max(0,...gpu),failedGpu:health.gpu.filter(x=>x.phase===phase&&x.failed).length}];
  })));
  const gpuErrors=await page.evaluate(()=>health.gpuErrors);
  const startupTrace=process.env.ADDON_STARTUP_TRACE==='1'?await page.evaluate(()=>({firstPlayingAt:health.firstPlayingAt,firstVideoFrame:health.firstVideoFrame,refresh:health.raf.filter(row=>['startup','loading'].includes(row.phase)),marks:performance.getEntriesByType('mark').filter(entry=>entry.name.startsWith('ve-device-')).map(entry=>({name:entry.name,time:entry.startTime}))})):undefined;
  console.log(JSON.stringify({browser:await browser.version(),version,fixture:'real Store package; no mocked extension API',profile,interaction,phasedInit,pausedStartup,mixedFeed,mixedCases,samples,transitions,responsiveness,native,startupTrace,pageErrors,gpuErrors},null,2));
  assert.deepEqual(pageErrors,[]);assert.equal(native.paused,false);
  assert.deepEqual(gpuErrors,[],'the actual add-on device must have no uncaptured validation errors');
  assert.ok(samples.every(s=>s.source>=57),'preserve 60 fps source in the actual add-on');
  assert.ok(samples.filter(s=>s.mid>=12).length>=4,'sustained actual IFRNet midpoints in the actual add-on');
  assert.ok(samples.every(s=>!s.error&&s.backend.includes('WebGPU')));
  assert.ok(samples.every(s=>s.captureMode==='snapshot'&&s.videoSnapshots>0&&s.videoSnapshotFallbacks===0),'native video import must work in the real extension realm');
  assert.ok(transitions.every(s=>!s.error&&!s.fallback&&!s.apiFallback&&s.backend.includes('WebGPU')),'feed changes retain the selected model/API');
  for(const [phase,timing] of Object.entries(responsiveness))if(phase!=='startup'){
   assert.ok(timing.maxRafMs<50,phase+' browser refresh must not stop for 50 ms');
   // This measures queue completion notification latency. It includes every
   // earlier submission and the browser's notification scheduling; it does not
   // by itself measure the interval between visible compositor presentations.
   assert.ok(timing.maxGpuMs<50,phase+' GPU queue completion notification must stay below 50 ms');
   assert.equal(timing.failedGpu,0,phase+' GPU fences');
  }
 }finally{try{await browser?.close();}finally{if(server?.listening)await new Promise(resolve=>server.close(resolve));
  const resolved=fs.realpathSync(temp),parent=fs.realpathSync(os.tmpdir());assert.equal(path.dirname(resolved),parent);
  assert.ok(path.basename(resolved).startsWith('video-enhancer-addon-'));fs.rmSync(resolved,{recursive:true,force:true});}}
})().catch(error=>{console.error(error);process.exitCode=1;});
