// Native Firefox/Chromium series, not a single popup snapshot. Puppeteer Core
// uses a temporary isolated browser profile; no add-on or user profile changes.
// Matrix inputs: SOURCE_SIZE, SOURCE_FPS, PLAYBACK_RATE, SPATIAL_MODE, CPU_PROFILE,
// FI_ENABLED, STEADY_MS, WARM_MS, LOAD_PATTERN. SOURCE_FILE reuses an MP4.
// BENCH_RESULT_FILE receives schemaVersion 1 even when setup/assertions fail.
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),os=require('node:os');
const cp=require('node:child_process');
const root=path.resolve(__dirname,'..'),ref=process.env.BASELINE_REF||'',kind=process.env.TEST_BROWSER||'firefox';
const sourceSnapshotDir=process.env.BENCH_SOURCE_DIR?path.resolve(process.env.BENCH_SOURCE_DIR):null;
const fps=Number(process.env.SOURCE_FPS||24),profile=process.env.FI_PROFILE||'quality';
const timingMode=process.env.FI_TIMING||'history';
const callbackJitterMs=Number(process.env.CALLBACK_JITTER_MS||0);
const cpuProfileEnabled=process.env.CPU_PROFILE==='1';
const gpuProbeEnabled=process.env.GPU_PROBE!=='0';
const cpuProfileHelperPath=path.join(__dirname,'cpu-profile-helper.cjs');
const cpuProfileFactory=cpuProfileEnabled?require(cpuProfileHelperPath):null;
const instrumentationHashes={neuralBrowserSha256:require('node:crypto').createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'),
 ...(cpuProfileEnabled?{cpuProfileHelperSha256:require('node:crypto').createHash('sha256').update(fs.readFileSync(cpuProfileHelperPath)).digest('hex')}:{})};
const sourceSize=process.env.SOURCE_SIZE||'1280x720',[sourceWidth,sourceHeight]=sourceSize.split('x').map(Number);
const playbackRate=Number(process.env.PLAYBACK_RATE||1),effectiveFps=fps*playbackRate;
const spatialMode=process.env.SPATIAL_MODE||'ravu',mode=spatialMode==='fsr'?'rcas':spatialMode;
const fiEnabled=process.env.FI_ENABLED!=='0',steadyMs=Number(process.env.STEADY_MS||5000),warmMs=Number(process.env.WARM_MS??1500);
const loadPattern=process.env.LOAD_PATTERN||'none',resultFile=process.env.BENCH_RESULT_FILE||'';
const sourceFile=process.env.SOURCE_FILE?path.resolve(process.env.SOURCE_FILE):null;
const config={browser:kind,sourceSize,sourceWidth,sourceHeight,sourceFps:fps,effectiveFps,playbackRate,spatialMode,fiEnabled,steadyMs,warmMs,
 loadPattern,syntheticStress:loadPattern!=='none'||callbackJitterMs>0,profile,timingMode,headless:process.env.HEADLESS!=='0',ref:ref||null,
 experiments:{callbackJitterMs,callbackTimeline:process.env.CALLBACK_TIMELINE==='1',neuralTimeline:process.env.NEURAL_TIMELINE==='1',
  kernel:process.env.FI_KERNEL||null,capture:process.env.FI_CAPTURE||null,quantumMs:Number(process.env.FI_QUANTUM||0),api:process.env.FI_API||null,canvasCopy:process.env.FI_CANVAS_COPY==='1',cpuProfile:cpuProfileEnabled,gpuProbe:gpuProbeEnabled,
  filteredSources:process.env.FI_FILTERED_SOURCES===undefined?null:process.env.FI_FILTERED_SOURCES==='1',genericConcat:process.env.FI_GENERIC_CONCAT===undefined?null:process.env.FI_GENERIC_CONCAT==='1',genericFlow:process.env.FI_GENERIC_FLOW===undefined?null:process.env.FI_GENERIC_FLOW==='1'},
 sourceFile,sourcePattern:process.env.SOURCE_PATTERN||'testsrc2',sourceSnapshotDir,testArgs:process.argv.slice(2)};
const identity={caseId:process.env.BENCH_CASE_ID||null,runId:process.env.BENCH_RUN_ID||null,
 sourceHash:process.env.BENCH_SOURCE_HASH||null,fixtureHash:process.env.SOURCE_HASH||null};
function validate(){
 if(ref&&sourceSnapshotDir)throw new Error('BASELINE_REF and BENCH_SOURCE_DIR cannot be used together');
 if(ref&&!/^[a-f0-9]{7,40}$/.test(ref))throw new Error('BASELINE_REF must be a commit hash');
 assert.ok(['firefox','chromium'].includes(kind));assert.ok([24,30,60].includes(fps));
 assert.ok(['640x360','1280x720','1920x1080'].includes(sourceSize),'supported SOURCE_SIZE');
 assert.ok([.75,1,4/3,1.5].includes(playbackRate),'supported PLAYBACK_RATE');assert.ok(['native','ravu','fsr'].includes(spatialMode));
 assert.ok(process.env.FI_ENABLED===undefined||['0','1'].includes(process.env.FI_ENABLED));
 assert.ok(process.env.FI_CAPTURE===undefined||['rgba','external','snapshot'].includes(process.env.FI_CAPTURE));
 for(const name of ['FI_FILTERED_SOURCES','FI_GENERIC_CONCAT','FI_GENERIC_FLOW','GPU_PROBE'])assert.ok(process.env[name]===undefined||['0','1'].includes(process.env[name]),name+' must be 0 or 1');
 assert.ok(Number.isFinite(steadyMs)&&steadyMs>=250&&steadyMs<=3600000);assert.ok(Number.isFinite(warmMs)&&warmMs>=0&&warmMs<=60000);
 assert.ok(['none','periodic-main-thread'].includes(loadPattern));assert.ok(['history','last'].includes(timingMode));
 assert.ok(Number.isFinite(callbackJitterMs)&&callbackJitterMs>=0&&callbackJitterMs<=100);
}
const sourceSnapshot=new Map();
const scriptHashes={};
const code=name=>{
 const content=ref?cp.execFileSync('git',['show',ref+':'+name],{cwd:root,encoding:'utf8'}):
  sourceSnapshot.get(name)??fs.readFileSync(path.join(sourceSnapshotDir||root,name),'utf8');
 scriptHashes[name]=require('node:crypto').createHash('sha256').update(content).digest('hex');
 return content;
};
(async()=>{
 const hostStart=performance.now(),bench={schemaVersion:1,test:'neural-browser',identity,startedAt:new Date().toISOString(),finishedAt:null,status:'failed',config,
  environment:null,phasesMs:{},result:null,pageErrors:[],failures:[],exitCode:1,
  measurementNotes:['GPU responsiveness is observed submission-to-completion wall time, including queue and notification latency; it is not a physical GPU timestamp.',
   'Source and midpoint rates count submitted presentations; displayHz is an estimator, not a physical monitor measurement.',
   'BENCH_SOURCE_DIR snapshots JavaScript scripts only; model weights and video fixtures continue to come from the current repository or SOURCE_FILE.'],scriptHashes,instrumentationHashes};
 if(cpuProfileEnabled)bench.measurementNotes.push('CPU profiling times only the synchronous body of selected calls with performance.now; asynchronous waits are excluded, nested durations are inclusive, and p95 uses the upper bound of a fixed histogram bucket.');
 if(!gpuProbeEnabled)bench.measurementNotes.push('GPU completion probes are disabled for an instrumentation A/B experiment. The mandatory GPU coverage assertion remains enabled; this run cannot establish full responsiveness conformance.');
 let browser,server,page,temp,failure;const recorded=new Set();
 const record=(error,name='harness')=>{if(recorded.has(error))return;recorded.add(error);bench.failures.push({name,type:error.name||'Error',message:String(error.message||error),
  stack:error.stack||null,operator:error.operator||null,actual:error.actual??null,expected:error.expected??null});};
 const check=(name,fn)=>{try{fn();}catch(error){record(error,name);}};
 const writeBench=()=>{if(!resultFile)return;fs.mkdirSync(path.dirname(path.resolve(resultFile)),{recursive:true});fs.writeFileSync(resultFile,JSON.stringify(bench,null,2)+'\n');};
 try{
 validate();const puppeteer=require('puppeteer-core');temp=fs.mkdtempSync(path.join(os.tmpdir(),'video-enhancer-browser-'));
 if(!ref){const scriptRoot=sourceSnapshotDir||root;
  for(const name of JSON.parse(fs.readFileSync(path.join(scriptRoot,'manifest.json'),'utf8')).content_scripts.flatMap(group=>group.js))
   sourceSnapshot.set(name,fs.readFileSync(path.join(scriptRoot,name),'utf8'));
 }
 const encodeStart=performance.now();
 const movie=path.join(temp,'motion.mp4');
 if(sourceFile){assert.ok(/\.mp4$/i.test(sourceFile),'SOURCE_FILE must be an MP4');assert.ok(fs.statSync(sourceFile).isFile(),'SOURCE_FILE must be a regular file');}
 else{const encoded=cp.spawnSync(process.env.FFMPEG_PATH||'ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i',`testsrc2=size=${sourceSize}:rate=${fps}`,
   '-t','30','-c:v','libx264','-threads','2','-preset','ultrafast','-crf','28','-pix_fmt','yuv420p','-movflags','+faststart','-an',movie],{encoding:'utf8'});
  if(encoded.status!==0)throw new Error('FFmpeg test fixture failed: '+(encoded.error?.message||encoded.stderr));}
 bench.phasesMs.fixtureEncode=sourceFile?0:performance.now()-encodeStart;
 if(sourceFile)bench.phasesMs.fixtureValidation=performance.now()-encodeStart;
 const movieBytes=fs.readFileSync(sourceFile||movie);assert.ok(movieBytes.length>0,'video fixture cannot be empty');
 bench.fixture={source:sourceFile?'provided':'generated',path:sourceFile||movie,bytes:movieBytes.length,
  sha256:require('node:crypto').createHash('sha256').update(movieBytes).digest('hex')};
 if(identity.fixtureHash)assert.equal(bench.fixture.sha256,identity.fixtureHash.toLowerCase(),'SOURCE_HASH must match the actual fixture bytes');
 server=http.createServer((req,res)=>{
  if(req.url==='/motion.mp4'){
   res.setHeader('Content-Type','video/mp4');res.setHeader('Accept-Ranges','bytes');
   const range=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range||'');
   if(range){const start=Number(range[1]),end=range[2]?Math.min(Number(range[2]),movieBytes.length-1):movieBytes.length-1;
    res.statusCode=206;res.setHeader('Content-Range',`bytes ${start}-${end}/${movieBytes.length}`);
    res.setHeader('Content-Length',end-start+1);res.end(movieBytes.subarray(start,end+1));
   }else{res.setHeader('Content-Length',movieBytes.length);res.end(movieBytes);}return;
  }
  const name=req.url.slice(1);
  if(['models/ifrnet.bin','third_party/ravu-lite/ravu-lite-webgl2.js','third_party/ravu-lite/ravu-lite-lut3.bin'].includes(name)){
   res.end(fs.readFileSync(path.join(root,name)));return;}
  res.setHeader('Content-Type','text/html');res.end('<!doctype html><div style="position:relative;width:960px"><video muted autoplay style="width:960px;height:540px"></video></div>');
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const launchStart=performance.now();browser=await puppeteer.launch({browser:kind==='firefox'?'firefox':'chrome',headless:process.env.HEADLESS!=='0',
   executablePath:kind==='firefox'?(process.env.FIREFOX_PATH||'C:/Program Files/Mozilla Firefox/firefox.exe'):
    (process.env.CHROMIUM_PATH||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'),
   defaultViewport:{width:1100,height:750},timeout:60000});
  bench.phasesMs.browserLaunch=performance.now()-launchStart;
  bench.environment={browserVersion:await browser.version()};
  page=await browser.newPage();const errors=bench.pageErrors;page.on('pageerror',e=>errors.push(e.message));await page.bringToFront();
  if(process.env.NEURAL_TRACE&&kind==='chromium')await page.tracing.start({path:process.env.NEURAL_TRACE,
   categories:['devtools.timeline','v8','blink.user_timing','gpu','toplevel','disabled-by-default-gpu.dawn','disabled-by-default-v8.gc','disabled-by-default-devtools.timeline.frame']});
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const baselineStart=performance.now();await page.evaluate(({fps,profile,timeline,callbackTimeline,callbackJitterMs,fiEnabled,mode,playbackRate,gpuProbeEnabled,caseId})=>{
   const api={runtime:{getURL:p=>location.origin+'/'+p,sendMessage:async()=>({ok:true,installed:false}),onMessage:{addListener(){}}},
    storage:{onChanged:{addListener(){}},local:{get:async d=>({...d,mode,strength:mode==='native'?0:100,quality:'high',fiProfile:profile,fiEngine:'ifrnet',fiInfra:window.fixtureFiEnabled,interaction:'quality'})}}};
   window.fixtureFiEnabled=fiEnabled;
   window.browser=api;window.chrome=api;
   // A real decoder is required: Firefox's canvas capture stream does not
   // advance playback-quality counters reliably in this headless fixture.
   window.video=document.querySelector('video');video.loop=true;video.playbackRate=playbackRate;
   window.series={sourcePresentationEvents:[],presentationEvents:[],phaseStarts:{},real:[],mid:[],otherMids:0,complete:[],attempts:0,reusedAttempts:0,cachedAttempts:0,
    schedules:0,found:0,readyOnSchedule:0,midCalls:0,callbackTimeline,videoCallbacks:[],callbackJitterMs,jitterCount:0,callbackSelectors:[],
    phase:'device',raf:[],slowCalls:[],glPeaks:{},pipelines:[],tasks:[],gpuProbeEnabled,gpu:[],gpuPending:[],gpuNativePending:new Set(),measurementCutoff:null,
    attemptEvents:[],waitCalls:0,maxWaitCallMs:0,waitHistogram:new Uint32Array(2001),timeline,pairs:[],rows:new Map(),adapterObservations:[],outcomes:{},syntheticSlices:0};
   // Identify visible test windows and their phase without changing the video
   // layout. Update once per phase, outside the per-refresh measurement path.
   const label=document.createElement('div'),name=caseId||`${fps}fps ${profile} ${playbackRate}x`;
   label.style.cssText='position:fixed;top:8px;right:8px;z-index:2147483647;background:#102747;color:white;padding:7px 10px;font:12px monospace;pointer-events:none';
   document.body.appendChild(label);document.title=name;
   let phase='device';const phaseLabel={device:'Native baseline',spatial:'Upscaling setup',model:'Neural preparation',warm:'Warm-up',steady:'Playback measurement'};
   Object.defineProperty(series,'phase',{enumerable:true,get:()=>phase,set:value=>{phase=value;label.textContent=name+' | '+(phaseLabel[value]||value);}});series.phase=phase;
   if(navigator.gpu){const request=navigator.gpu.requestAdapter.bind(navigator.gpu);
    navigator.gpu.requestAdapter=async(...args)=>{try{const adapter=await request(...args),info=adapter?.info;
     series.adapterObservations.push({available:!!adapter,info:info?{vendor:info.vendor,architecture:info.architecture,device:info.device,description:info.description}:null,
      isFallbackAdapter:adapter?.isFallbackAdapter??null,features:adapter?Array.from(adapter.features):[],
      limits:adapter?{maxTextureDimension2D:adapter.limits.maxTextureDimension2D,maxBufferSize:adapter.limits.maxBufferSize,maxStorageBufferBindingSize:adapter.limits.maxStorageBufferBindingSize}:null});return adapter;
    }catch(error){series.adapterObservations.push({available:false,error:String(error.message||error)});throw error;}};
   }
   let previous=performance.now(),previousObserved=previous;requestAnimationFrame(function tick(now){const observedAt=performance.now();series.raf.push({time:now,ms:now-previous,observedAt,callbackGapMs:observedAt-previousObserved,phase:series.phase});
    previousObserved=observedAt;
    previous=now;
    if(callbackJitterMs&&window.fixtureCallbackSelector){
     const selector=fixtureCallbackSelector(),previousSelector=series.callbackSelectors.at(-1);
     if(!previousSelector||previousSelector.fallback!==selector.fallback)series.callbackSelectors.push({time:now,phase:series.phase,...selector});
    }
    const ctx=series.context;
    while(ctx&&series.gpuPending.length){
     const pending=series.gpuPending[0],state=ctx.clientWaitSync(pending.sync,0,0);
     if(state===ctx.TIMEOUT_EXPIRED)break;
     series.gpuPending.shift();ctx.deleteSync(pending.sync);
     series.gpu.push({phase:pending.phase,kind:pending.kind,submittedAt:pending.time,completedAt:performance.now(),ms:performance.now()-pending.time,failed:state===ctx.WAIT_FAILED});
    }
    requestAnimationFrame(tick);});
   if((callbackTimeline||callbackJitterMs)&&typeof video.requestVideoFrameCallback==='function'){
    const request=video.requestVideoFrameCallback.bind(video),cancel=video.cancelVideoFrameCallback.bind(video),pending=new Map();let sequence=0;
    video.requestVideoFrameCallback=fn=>{
     const id=request((now,metadata)=>{
      const simulate=callbackJitterMs&&['model','warm','steady'].includes(series.phase);
      const delay=simulate&&++sequence%2===1?callbackJitterMs:0;
      const invoke=()=>{
       pending.delete(id);const deliveredNow=delay?performance.now():now;
       if(callbackTimeline){const quality=video.getVideoPlaybackQuality();
        if(series.videoCallbacks.length<10000)series.videoCallbacks.push({phase:series.phase,now:deliveredNow,originalNow:now,
         injectedDelayMs:delay,observedAt:performance.now(),expectedDisplayTime:metadata.expectedDisplayTime,mediaTime:metadata.mediaTime,
         presentedFrames:metadata.presentedFrames,totalVideoFrames:quality.totalVideoFrames,droppedVideoFrames:quality.droppedVideoFrames});}
       return fn(deliveredNow,metadata);
      };
      if(delay){series.jitterCount++;pending.set(id,setTimeout(invoke,delay));}else invoke();
     });
     return id;
    };
    // Preserve the browser's callback identifier and cancel its deferred
    // delivery as well, so source/session cancellation remains meaningful.
    video.cancelVideoFrameCallback=id=>{if(pending.has(id)){clearTimeout(pending.get(id));pending.delete(id);}return cancel(id);};
   }
   for(const name of ['compileShader','linkProgram','getShaderParameter','getProgramParameter','drawArrays','texImage2D','texSubImage2D','copyTexSubImage2D',
    'getUniformLocation','getParameter','getError','checkFramebufferStatus','readPixels']){
    const fn=WebGL2RenderingContext.prototype[name];WebGL2RenderingContext.prototype[name]=function(...args){const start=performance.now();
     try{return fn.apply(this,args);}finally{if(series.measurementCutoff===null){const ms=performance.now()-start,key=series.phase+':'+name;
      series.glPeaks[key]=Math.max(series.glPeaks[key]||0,ms);if(ms>8&&series.slowCalls.length<30)series.slowCalls.push({name,ms,phase:series.phase,source:name==='texSubImage2D'?args.at(-1)?.constructor.name:undefined});}}};
   }
   if(PerformanceObserver.supportedEntryTypes.includes('longtask'))new PerformanceObserver(list=>{
    for(const e of list.getEntries())series.tasks.push({time:e.startTime,ms:e.duration,phase:series.phase});}).observe({type:'longtask'});
  },{fps,profile,timeline:process.env.NEURAL_TIMELINE==='1',callbackTimeline:process.env.CALLBACK_TIMELINE==='1',callbackJitterMs,fiEnabled,mode,playbackRate,gpuProbeEnabled,caseId:identity.caseId});
  if(cpuProfileEnabled){
   await page.evaluate(factorySource=>{
    const factory=(0,eval)('('+factorySource+')');
    window.__veCpuProfile=factory({phase:()=>window.series?.phase||'setup'});
   },cpuProfileFactory.toString());
  }
  // The manifest's small document_start script sees the video before decoded
  // frames are available. Do not await device preparation to start playback.
  if(!ref)await page.addScriptTag({content:code('neural/webgpu-device.js')});
  // The independent spatial baseline starts after the document_start script
  // has read the saved enabled-FI setting. Playback never awaits preparation.
  await page.evaluate(rate=>{window.fixtureFiEnabled=false;video.src=location.origin+'/motion.mp4';video.playbackRate=rate;video.play();},playbackRate);
  await page.waitForFunction(()=>!video.paused&&video.currentTime>.1);
  const decodedSize=await page.evaluate(()=>({width:video.videoWidth,height:video.videoHeight,playbackRate:video.playbackRate}));
  assert.equal(decodedSize.width,sourceWidth,'fixture source width must match SOURCE_SIZE');assert.equal(decodedSize.height,sourceHeight,'fixture source height must match SOURCE_SIZE');
  assert.equal(decodedSize.playbackRate,playbackRate,'requested playbackRate must actually be active');
  await page.evaluate(()=>{series.phase='baseline';});
  const native=await page.evaluate(()=>new Promise(resolve=>{
   const start=performance.now(),quality=video.getVideoPlaybackQuality();let callbacks=0,last=null,maxGapMs=0;
   const frame=now=>{callbacks++;if(last!==null)maxGapMs=Math.max(maxGapMs,now-last);last=now;
    if(now-start<2000){video.requestVideoFrameCallback(frame);return;}
    const elapsed=now-start,end=video.getVideoPlaybackQuality();resolve({fps:callbacks*1000/elapsed,maxGapMs,
     decodedFps:(end.totalVideoFrames-quality.totalVideoFrames)*1000/elapsed,dropped:end.droppedVideoFrames-quality.droppedVideoFrames});};
   video.requestVideoFrameCallback(frame);
  }));
  const pixels=await page.evaluate(()=>new Promise(resolve=>{
   const surface=document.createElement('canvas');surface.width=32;surface.height=18;
   const ctx=surface.getContext('2d',{willReadFrequently:true}),start=performance.now();let last=null,changed=0;
   const sample=now=>{ctx.drawImage(video,0,0,32,18);const data=ctx.getImageData(0,0,32,18).data;let hash=2166136261;
    for(const byte of data)hash=Math.imul(hash^byte,16777619);if(last!==null&&last!==hash)changed++;last=hash;
    if(now-start<2000){requestAnimationFrame(sample);return;}resolve({changedFps:changed*1000/(now-start)});};
   requestAnimationFrame(sample);
  }));
  bench.phasesMs.nativeBaseline=performance.now()-baselineStart;
  const scripts=['feed-session.js','fi-quality.js','fi-core.js','fi-analytic.js','fi-webgpu.js','neural/model-spec.js','neural/graph.js','neural/runtime.js'];
  if(!ref)scripts.push('neural/webgpu-shaders.js','neural/webgpu-compositor.js','neural/webgpu-runtime.js');
  scripts.push('neural/client.js');
  for(const name of scripts)await page.addScriptTag({content:code(name)});
  if(['untiled','scalar-compact'].includes(process.env.FI_KERNEL))await page.evaluate(()=>{
   const operation=VENeuralWebGPUShaders.operation;
   VENeuralWebGPUShaders.operation=(op,options)=>operation(op,{...options,tiled:false});
  });
  if(['compact','scalar-compact'].includes(process.env.FI_KERNEL))await page.evaluate(()=>{
   const create=VENeuralWebGPU.create.bind(VENeuralWebGPU);
   VENeuralWebGPU.create=(...args)=>{args[7]={...args[7],compact:true};return create(...args);};
  });
  if(process.env.FI_KERNEL==='generic')await page.evaluate(()=>{
   const create=VENeuralWebGPU.create.bind(VENeuralWebGPU);
   VENeuralWebGPU.create=(...args)=>{args[7]={...args[7],generic:true};return create(...args);};
  });
  if(process.env.FI_KERNEL==='storage')await page.evaluate(()=>{
   const create=VENeuralWebGPU.create.bind(VENeuralWebGPU);
   VENeuralWebGPU.create=(...args)=>{args[7]={...args[7],storageTiles:true};return create(...args);};
  });
  if(process.env.FI_KERNEL==='gl-generic')await page.evaluate(()=>{
   const create=VENeuralRuntime.create.bind(VENeuralRuntime);
   VENeuralRuntime.create=(...args)=>{args[7]={...args[7],generic:true};return create(...args);};
  });
  if(process.env.FI_KERNEL==='blocked')await page.evaluate(()=>{
   const makeShader=VENeuralGraph.makeShader;
   VENeuralGraph.makeShader=op=>makeShader(op,{channelBlock:16});
  });
  if(process.env.FI_CANVAS_COPY==='1')await page.evaluate(()=>{
   const create=VENeuralWebGPU.create.bind(VENeuralWebGPU);
   VENeuralWebGPU.create=(...args)=>{args[7]={...args[7],canvasCopy:true};return create(...args);};
  });
  if(process.env.FI_CAPTURE)await page.evaluate(captureMode=>{
   const create=VENeuralWebGPU.create.bind(VENeuralWebGPU);
   VENeuralWebGPU.create=(...args)=>{args[7]={...args[7],captureMode};return create(...args);};
  },process.env.FI_CAPTURE);
  if(['storage-compact','storage-generic','storage-specialized'].includes(process.env.FI_KERNEL))await page.evaluate(options=>{
   const create=VENeuralWebGPU.create.bind(VENeuralWebGPU);
   VENeuralWebGPU.create=(...args)=>{args[7]={...args[7],...options};return create(...args);};
  },{storageTiles:true,compact:process.env.FI_KERNEL!=='storage-specialized',genericStorage:process.env.FI_KERNEL==='storage-generic'});
  if(process.env.FI_FILTERED_SOURCES!==undefined)await page.evaluate(filteredSources=>{
   const create=VENeuralWebGPU.create.bind(VENeuralWebGPU);
   VENeuralWebGPU.create=(...args)=>{args[7]={...args[7],filteredSources};return create(...args);};
  },process.env.FI_FILTERED_SOURCES==='1');
  if(process.env.FI_GENERIC_CONCAT!==undefined)await page.evaluate(genericConcat=>{
   const create=VENeuralWebGPU.create.bind(VENeuralWebGPU);
   VENeuralWebGPU.create=(...args)=>{args[7]={...args[7],genericConcat};return create(...args);};
  },process.env.FI_GENERIC_CONCAT==='1');
  if(process.env.FI_GENERIC_FLOW!==undefined)await page.evaluate(genericFlow=>{
   const create=VENeuralWebGPU.create.bind(VENeuralWebGPU);
   VENeuralWebGPU.create=(...args)=>{args[7]={...args[7],genericFlow};return create(...args);};
  },process.env.FI_GENERIC_FLOW==='1');
  if(process.env.FI_API==='webgl2')await page.evaluate(()=>{window.VENeuralWebGPU=undefined;});
  if(!ref&&process.env.FI_API!=='webgl2')await page.evaluate(()=>{
   const pipeline=VENeuralWebGPU.prototype.pipeline;
   VENeuralWebGPU.prototype.pipeline=async function(descriptor,...args){
    const cached=this.pipelines.has(descriptor.code),start=performance.now();
    try{return await pipeline.call(this,descriptor,...args);}
    finally{if(!cached)series.pipelines.push({start,ms:performance.now()-start,bytes:descriptor.code.length,label:descriptor.label,
     kind:descriptor.convLayout?'generic':descriptor.tiled?'tiled':descriptor.code.includes('texture_external')?'external':'other'});}
   };
  });
  await page.evaluate(quantum=>{
   const profiler=window.__veCpuProfile;
   const instrumentDevice=device=>{
    if(!profiler||!device)return;
    for(const name of ['createShaderModule','createComputePipelineAsync','createRenderPipelineAsync','createTexture','createBindGroup'])
     profiler.wrapMethod(device,name,'device.'+name);
    const queue=device.queue;
    profiler.wrapMethod(queue,'submit','device.queue.submit');profiler.wrapMethod(queue,'onSubmittedWorkDone','device.queue.onSubmittedWorkDone');
   };
   if(profiler&&window.VENeuralDevice&&typeof window.VENeuralDevice.acquire==='function'){
    const deviceApi=window.VENeuralDevice,acquire=deviceApi.acquire;
    deviceApi.acquire=async function(...args){const lease=await acquire.apply(this,args);instrumentDevice(lease?.device);return lease;};
   }
   if(profiler&&window.VENeuralCompositor&&typeof window.VENeuralCompositor.create==='function'){
    const compositorApi=window.VENeuralCompositor,createCompositor=compositorApi.create;
    compositorApi.create=async function(...args){
     const compositor=await createCompositor.apply(this,args);
     for(const name of ['render','snapshot','transitionSource'])profiler.wrapMethod(compositor,name,'compositor.'+name);
     return compositor;
    };
   }
   for(const api of [VENeuralRuntime,window.VENeuralWebGPU].filter(Boolean)){
    const create=api.create.bind(api);
    api.create=async(...args)=>{
     const rt=await create(...args),estimate=rt.estimate.bind(rt);
     if(profiler&&rt.backend==='webgpu'){
      for(const name of ['captureFrame','sourceResource','queuePresentation','waitForCompletion'])profiler.wrapMethod(rt,name,'webgpu.'+name);
      instrumentDevice(rt.device);
     }
     if(rt.backend!=='webgpu'){
      const gl=args[0],wait=gl.clientWaitSync.bind(gl);
      gl.clientWaitSync=(...args)=>{const start=performance.now();const value=wait(...args),ms=performance.now()-start;
       if(series.measurementCutoff===null){series.waitCalls++;series.maxWaitCallMs=Math.max(series.maxWaitCallMs,ms);series.waitHistogram[Math.min(2000,Math.ceil(ms*10))]++;}return value;};
     }
     rt.estimate=async(...a)=>{
      const requestTime=performance.now();let validResult=false,completedMs=null;
      if(quantum)a[4]={...a[4],quantumMs:quantum};
      const row=series.timeline?{serial:a[2],request:performance.now(),anchor:fiPairAnchorTime,duration:lastVideoFrameDurationMs,reference:fiDisplayReference,
       period:fiDisplayPeriod,slot:{...fiNeuralTarget},raf:[],quantum:a[4]?.quantumMs,
       timing:rt.presentationTiming?{samples:rt.presentationTiming.samples.slice(),deadlineMisses:rt.presentationTiming.deadlineMisses}:null}:null;
      if(row){series.pairs.push(row);series.rows.set(row.serial,row);}
      if(row&&typeof a[4]?.onSubmitted==='function'){
       const onSubmitted=a[4].onSubmitted;a[4]={...a[4],onSubmitted:function(...args){
        row.submitted=performance.now();row.submittedPhase=args[0]?.phase;let returnValue;
        try{returnValue=onSubmitted.apply(this,args);return returnValue;}
        finally{row.submissionAccepted=returnValue===true;}
       }};
      }
      try{const result=await estimate(...a);validResult=!!result?.valid;completedMs=result?.elapsedMs??null;
       if(row)row.valid=validResult;if(validResult)series.complete.push(completedMs);return result;}
      finally{if(row){row.completed=performance.now();row.reason=rt.lastRun?.reason;row.elapsed=rt.lastRun?.elapsedMs;
       row.run=rt.lastRun?{...rt.lastRun,stageMs:rt.lastRun.stageMs?{...rt.lastRun.stageMs}:rt.lastRun.stageMs}:null;}
       const outcome=rt.lastRun?.completed?'completed':rt.lastRun?.reason||'unknown';series.outcomes[outcome]=(series.outcomes[outcome]||0)+1;
       if(series.measurementCutoff===null)series.attemptEvents.push({requestTime,completedAt:performance.now(),valid:validResult,elapsedMs:completedMs,
        outcome,reused:!!rt.lastRun?.reusedEncoder,cached:!!rt.lastRun?.cachedEncoder});
       series.attempts++;if(rt.lastRun?.reusedEncoder)series.reusedAttempts++;if(rt.lastRun?.cachedEncoder)series.cachedAttempts++;}};return rt;
    };
   }
  },Number(process.env.FI_QUANTUM||0));
  const spatialSetupStart=performance.now();await page.evaluate(()=>{series.phase='spatial';series.phaseStarts.spatial=performance.now();performance.mark('ve-spatial');});
  let contentSource=code('content.js');
  if(timingMode==='last'){
   // A/B only the scheduling estimate and recovery admission. All model,
   // shader, callback detector and rendering code remains the same snapshot.
   const history='const estimate=buffered?lastCost:(costs.length?costs[Math.floor(costs.length/2)]:0);';
   const recovery='estimate&&(buffered||timing.deadlineMisses<2)?performance.now()+lead+estimate-callbackDelay:anchor+duration*.85';
   assert.equal(contentSource.split(history).length,2,'last-cost control must replace exactly one estimate');
   assert.equal(contentSource.split(recovery).length,2,'last-cost control must replace exactly one recovery condition');
   contentSource=contentSource.replace(history,'const estimate=engine.stats.ms||0;').replace(recovery,
    'estimate?performance.now()+lead+estimate-callbackDelay:anchor+duration*.85');
  }
  scriptHashes['content.js']=require('node:crypto').createHash('sha256').update(contentSource).digest('hex');
  await page.addScriptTag({content:contentSource});
  await page.waitForFunction(()=>status==='ok'&&activePipeline!=='disabled',{timeout:30000});
  if(cpuProfileEnabled)await page.evaluate(()=>{
   const profiler=window.__veCpuProfile;
   for(const name of ['draw','syncLayout','fiAfterVideoUpload','fiDrawDirect'])profiler.wrapMethod(window,name,'controller.'+name);
  });
  await page.evaluate(()=>{
   window.fixtureCallbackSelector=()=>({fallback:useAnimationFallback,kind:scheduledKind});
   if(typeof fiScheduleBufferedMidFrame==='function'){
    const schedule=fiScheduleBufferedMidFrame;
    fiScheduleBufferedMidFrame=()=>{if(series.measurementCutoff!==null)return schedule();series.schedules++;const pair=fiBufferedPairs.get(fiPairSerial-1),row=series.rows.get(fiPairSerial-1);
     if(row)row.schedule={time:performance.now(),ready:!!pair?.ready,sourceAnchor:fiPairAnchorTime};
     if(pair)series.found++;if(pair?.ready)series.readyOnSchedule++;return schedule();};
   }
   if(series.timeline){const raf=requestAnimationFrame;window.requestAnimationFrame=fn=>{
    if(fn.name!=='present')return raf(fn);const buffered=fiBufferedMode,row=series.rows.get(fiPairSerial-(buffered?1:0));
    return raf(now=>{if(row)row.raf.push({now,perf:performance.now(),ready:buffered?!!fiBufferedPairs.get(row.serial)?.ready:fiGpuReadySerial===row.serial&&!!fiNeuralResult,serial:fiPairSerial});return fn(now);});
   };}
   const original=draw;draw=function(options={}){const real=metricWindow?.realDrawn||0,mid=metricWindow?.midDrawn||0;original(options);
    if(series.measurementCutoff!==null)return;
    if(options.fiBuffered)series.midCalls++;
    const sourceDrawn=options.newVideoFrame&&(metricWindow?.realDrawn||0)>real;
    const midDrawn=options.fiMid&&(metricWindow?.midDrawn||0)>mid;
    if(sourceDrawn){const time=performance.now();series.real.push(time);if(series.phase!=='steady'&&series.sourcePresentationEvents.length<20000)series.sourcePresentationEvents.push({time,phase:series.phase});}
    if(sourceDrawn){const row=series.rows.get(fiPairSerial-(fiBufferedMode?2:1));if(row)row.nextCapture=performance.now();}
    if(midDrawn){series.mid.push(performance.now());
     const row=series.rows.get(options.fiBuffered?.serial??fiPairSerial);if(row){row.presented=performance.now();row.presentationTime=options.fiPresentationTime;}
     if(fiGpuEngine?.kind!=='ifrnet'||fiMethod!=='ifrnet')series.otherMids++;}
    if(sourceDrawn||midDrawn){
     if(series.timeline&&series.presentationEvents.length<20000)series.presentationEvents.push({time:performance.now(),phase:series.phase,
      kind:sourceDrawn&&midDrawn?'source+mid':sourceDrawn?'source':'mid',pairSerial:fiPairSerial,buffered:fiBufferedMode,
      presentation:fiLastPresentation,capturedMediaTime:lastMediaTime,predictionSerial:options.fiBuffered?.serial??fiDirectLastPrediction?.serial??null});
     if(!series.gpuProbeEnabled)return;
     if(fiGpuEngine?.compositor&&fiDirectActive){
      const time=performance.now(),phase=series.phase,kind=sourceDrawn?'source':'mid';
      const job={time,phase,kind};series.gpuNativePending.add(job);
      const finish=error=>{series.gpuNativePending.delete(job);series.gpu.push({phase,kind,submittedAt:time,completedAt:performance.now(),ms:performance.now()-time,...(error?{failed:true,error:String(error.message||error)}:{})});};
      try{fiGpuEngine.device.queue.onSubmittedWorkDone().then(()=>finish(null),finish);}catch(error){finish(error);}return;
     }
     series.context=gl;const sync=gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE,0);gl.flush();
     series.gpuPending.push({sync,time:performance.now(),phase:series.phase,kind:sourceDrawn?'source':'mid'});
    }
   };
  });
  const spatialStart=await page.evaluate(()=>performance.now());await new Promise(r=>setTimeout(r,2000));
  const spatial=await page.evaluate(start=>({fps:series.real.filter(t=>t>=start).length*1000/(performance.now()-start)}),spatialStart);
  bench.phasesMs.spatialSetupAndBaseline=performance.now()-spatialSetupStart;
  const modelStart=performance.now();
  if(fiEnabled){await page.evaluate(()=>{series.phase='model';series.phaseStarts.model=performance.now();performance.mark('ve-model');applySettings({...settings,fiInfra:true});});
   await page.waitForFunction(()=>fiGpuState==='ready'&&fiGpuEngine?.kind==='ifrnet',{timeout:60000});}
  bench.phasesMs.modelPreparation=fiEnabled?performance.now()-modelStart:0;
  await page.evaluate(()=>{series.phase='warm';series.phaseStarts.warm=performance.now();performance.mark('ve-warm');});
  const warmStart=performance.now();await new Promise(r=>setTimeout(r,warmMs));bench.phasesMs.warm=performance.now()-warmStart;
  const start=await page.evaluate(loadPattern=>{series.real=[];series.mid=[];series.otherMids=0;series.complete=[];series.outcomes={};series.attemptEvents=[];
   series.attempts=series.reusedAttempts=series.cachedAttempts=0;
   series.schedules=series.found=series.readyOnSchedule=series.midCalls=0;series.pairs=[];series.rows.clear();
   series.phase='steady';series.phaseStarts.steady=performance.now();performance.mark('ve-steady');
   if(loadPattern==='periodic-main-thread')series.loadTimer=setInterval(()=>{const begin=performance.now();while(performance.now()-begin<8){}series.syntheticSlices++;},100);
   series.waitCalls=0;series.maxWaitCallMs=0;series.waitHistogram.fill(0);return performance.now();},loadPattern);
  await new Promise(r=>setTimeout(r,steadyMs));
  const cutoff=await page.evaluate(()=>{
   clearInterval(series.loadTimer);series.loadTimer=null;series.measurementCutoff=performance.now();
   series.cutoffSnapshot=structuredClone(snapshot());series.cutoffDiagnostics=structuredClone(fiGpuEngine?.diagnostics||null);
   series.cutoffLastRun=structuredClone(fiGpuEngine?.lastRun||null);
   return series.measurementCutoff;
  });
  // Completion after the measurement boundary still belongs to a previously
  // submitted presentation. Drain it without adding newer probes or counting
  // later source/midpoint draws. A timeout remains an explicit failed probe.
  await page.evaluate(async cutoff=>{
   const begin=performance.now(),timeoutMs=1000;
   const pending=()=>series.gpuPending.filter(job=>job.time<=cutoff).length+[...series.gpuNativePending].filter(job=>job.time<=cutoff).length;
   const initialPending=pending();
   while(pending()&&performance.now()-begin<timeoutMs){
    const context=series.context;
    while(context&&series.gpuPending.length){const job=series.gpuPending[0],state=context.clientWaitSync(job.sync,0,0);
     if(state===context.TIMEOUT_EXPIRED)break;series.gpuPending.shift();context.deleteSync(job.sync);
     series.gpu.push({phase:job.phase,kind:job.kind,submittedAt:job.time,completedAt:performance.now(),ms:performance.now()-job.time,failed:state===context.WAIT_FAILED});}
    if(pending())await new Promise(resolve=>setTimeout(resolve,4));
   }
   const now=performance.now(),remaining=[...series.gpuPending.map(job=>({...job,api:'webgl2'})),
    ...[...series.gpuNativePending].map(job=>({...job,api:'webgpu'}))].filter(job=>job.time<=cutoff)
    .map(job=>({api:job.api,phase:job.phase,kind:job.kind,submittedAt:job.time,observedLowerBoundMs:now-job.time}));
   series.probeDrain={cutoff,timeoutMs,elapsedMs:now-begin,initialPending,remaining:remaining.length,pending:remaining};
  },cutoff);
  const result=await page.evaluate(start=>{
   const end=series.measurementCutoff,real=series.real.filter(t=>t>=start&&t<=end),mid=series.mid.filter(t=>t>=start&&t<=end);
   const attempts=series.attemptEvents.filter(event=>event.completedAt>=start&&event.completedAt<=end),times=attempts.filter(event=>event.valid).map(event=>event.elapsedMs).sort((a,b)=>a-b);
   const windows=Array.from({length:Math.ceil((end-start)/1000)},(_,i)=>({durationMs:Math.min(1000,end-start-i*1000),
    real:real.filter(t=>t>=start+i*1000&&t<start+(i+1)*1000).length,mid:mid.filter(t=>t>=start+i*1000&&t<start+(i+1)*1000).length}));
   const waitPercentile=p=>{let n=0;for(let i=0;i<series.waitHistogram.length;i++){
    n+=series.waitHistogram[i];if(n>=series.waitCalls*p)return i/10;}return null;};
   const gaps=real.slice(1).map((t,i)=>t-real[i]).sort((a,b)=>a-b);
   const presentations=series.presentationEvents.filter(event=>event.time>=start&&event.time<=end);
   const outputGaps=presentations.slice(1).map((event,i)=>event.time-presentations[i].time).sort((a,b)=>a-b);
   const outputCadence={samples:presentations.length,maxGapMs:outputGaps.at(-1)??null,p50GapMs:outputGaps[Math.floor(outputGaps.length*.5)]??null,
    p95GapMs:outputGaps[Math.floor(outputGaps.length*.95)]??null,
    adjacentSources:presentations.slice(1).filter((event,i)=>event.kind==='source'&&presentations[i].kind==='source').length,
    adjacentMidpoints:presentations.slice(1).filter((event,i)=>event.kind==='mid'&&presentations[i].kind==='mid').length};
   const phases=['spatial','model','warm','steady'];
   const sourceByPhase=Object.fromEntries(phases.filter(phase=>Number.isFinite(series.phaseStarts[phase])).map(phase=>{
    const begin=series.phaseStarts[phase],finish=Math.min(end,...phases.map(p=>series.phaseStarts[p]).filter(t=>t>begin));
    const times=phase==='steady'?real:series.sourcePresentationEvents.filter(e=>e.phase===phase&&e.time>=begin&&e.time<=finish).map(e=>e.time);
    const boundaries=[begin,...times,finish],gaps=boundaries.slice(1).map((t,i)=>t-boundaries[i]);
    return [phase,{durationMs:finish-begin,frames:times.length,fps:times.length*1000/(finish-begin),maxGapMs:Math.max(0,...gaps)}];
   }));
   const responsiveness=Object.fromEntries(['device','spatial','model','warm','steady'].map(phase=>{
    const times=series.raf.filter(r=>r.phase===phase&&r.time<=end).map(r=>r.ms).sort((a,b)=>a-b);
    return [phase,{samples:times.length,maxMs:times.at(-1)??null,p99Ms:times[Math.floor(times.length*.99)]??null,over33ms:times.filter(t=>t>33).length}];}));
   const callbackResponsiveness=Object.fromEntries(['device','spatial','model','warm','steady'].map(phase=>{
    const times=series.raf.filter(r=>r.phase===phase&&r.observedAt<=end).map(r=>r.callbackGapMs).sort((a,b)=>a-b);
    return [phase,{samples:times.length,maxMs:times.at(-1)??null,p99Ms:times[Math.floor(times.length*.99)]??null,over33ms:times.filter(t=>t>33).length}];}));
   const gpuResponsiveness=Object.fromEntries(['spatial','model','warm','steady'].map(phase=>{
    const times=series.gpu.filter(r=>r.phase===phase&&r.submittedAt<=end).map(r=>r.ms).sort((a,b)=>a-b);
    const pending=series.probeDrain.pending.filter(job=>job.phase===phase);
    return [phase,{samples:times.length,maxMs:times.at(-1)??null,p99Ms:times[Math.floor(times.length*.99)]??null,over33ms:times.filter(t=>t>33).length,
     pendingCount:pending.length,pendingAgeLowerBoundMaxMs:pending.length?Math.max(...pending.map(job=>job.observedLowerBoundMs)):null}];}));
   return {elapsedMs:end-start,sourceCount:real.length,midCount:mid.length,sourceRate:real.length*1000/(end-start),midRate:mid.length*1000/(end-start),otherMids:series.otherMids,windows,
    maxSourceGapMs:gaps.at(-1)??0,sourceGapP99Ms:gaps[Math.floor(gaps.length*.99)]??null,outputCadence,responsiveness,callbackResponsiveness,gpuResponsiveness,
    failedGpuCompletions:series.gpu.filter(x=>x.failed&&x.submittedAt<=end).length,probeDrain:series.probeDrain,
    sourceByPhase,slowCalls:series.slowCalls,glPeaks:series.glPeaks,pipelines:series.pipelines.filter(x=>x.start<=end),longTasks:series.tasks.filter(x=>x.time<=end),
    completed:times.length,p50:times[Math.floor(times.length*.5)]??null,p95:times[Math.floor(times.length*.95)]??null,
    attempts:attempts.length,reusedAttempts:attempts.filter(event=>event.reused).length,cachedAttempts:attempts.filter(event=>event.cached).length,
    lastRun:series.cutoffLastRun,outcomes:attempts.reduce((counts,event)=>(counts[event.outcome]=(counts[event.outcome]||0)+1,counts),{}),
    backendOptions:{captureMode:fiGpuEngine?.captureMode,compact:fiGpuEngine?.shaderOptions?.compact,generic:fiGpuEngine?.shaderOptions?.generic,genericStorage:fiGpuEngine?.shaderOptions?.genericStorage,stagedStorage:fiGpuEngine?.shaderOptions?.stagedStorage,storageTiles:fiGpuEngine?.shaderOptions?.storageTiles,filteredSources:fiGpuEngine?.shaderOptions?.filteredSources,genericConcat:fiGpuEngine?.shaderOptions?.genericConcat,genericFlow:fiGpuEngine?.shaderOptions?.genericFlow,canvasCopy:fiGpuEngine?.canvasCopy},
    direct:{active:fiDirectActive,skip:fiGpuEngine?.compositor?.lastSkipReason,memoryBytes:fiGpuEngine?.compositor?.memoryBytes},
    buffered:{schedules:series.schedules,found:series.found,readyOnSchedule:series.readyOnSchedule,midCalls:series.midCalls},
    waitCalls:series.waitCalls,maxWaitCallMs:series.maxWaitCallMs,waitP95Ms:waitPercentile(.95),waitP99Ms:waitPercentile(.99),
    waitsOver2Ms:series.waitHistogram.slice(21).reduce((a,b)=>a+b,0),waitsOver4Ms:series.waitHistogram.slice(41).reduce((a,b)=>a+b,0),
    waitTimeoutNs:fiGpuEngine?.waitTimeoutNs,devicePreparation:window.VENeuralDevice?.status,
    maxClientWait:gl.getParameter(gl.MAX_CLIENT_WAIT_TIMEOUT_WEBGL),diagnostics:series.cutoffDiagnostics,
    fi:series.cutoffSnapshot.fi||null,pipeline:series.cutoffSnapshot.pipeline,settings:series.cutoffSnapshot.settings,syntheticSlices:series.syntheticSlices,
    selectedBackends:{neural:fiGpuEngine?.kind||null,api:fiGpuEngine?.backend||null,presentation:fiDirectActive?'webgpu':'webgl2',modelSize:fiGpuEngine?.modelSize||null},
    sizes:{source:{width:video.videoWidth,height:video.videoHeight},canvas:{width:canvas.width,height:canvas.height},css:{width:canvas.getBoundingClientRect().width,height:canvas.getBoundingClientRect().height}},
    visible:!document.hidden,canRender:canRender(),paused:video.paused,currentTime:video.currentTime,
    callbackKind:scheduledKind,glError:gl.getError(),timeline:series.timeline?series.pairs.filter(row=>row.request<=end):undefined,
    videoCallbacks:series.callbackTimeline?series.videoCallbacks:undefined,
    refreshTimeline:series.callbackTimeline?series.raf:undefined,presentationTimeline:series.timeline?presentations:undefined,
    callbackJitter:series.callbackJitterMs?{delayMs:series.callbackJitterMs,injected:series.jitterCount,selectors:series.callbackSelectors}:undefined,
    cpuProfile:window.__veCpuProfile?window.__veCpuProfile.snapshot():null};
  },start);
  bench.phasesMs.steady=result.elapsedMs;
  if(process.env.NEURAL_TRACE&&kind==='chromium')await page.tracing.stop();
  bench.result={browser:bench.environment.browserVersion,ref:ref||'current',fps,profile,timingMode,config,native,pixels,spatial,...result};
  console.log(JSON.stringify(bench.result,null,2));
  check('gl-errors',()=>assert.equal(result.glError,0));check('page-errors',()=>assert.deepEqual(errors,[]));
  check('gpu-completions',()=>assert.equal(result.failedGpuCompletions,0));
  check('gpu-probe-drain',()=>assert.equal(result.probeDrain.remaining,0,'all GPU probes submitted before cutoff must complete within the bounded drain'));
  check('settings-mode',()=>assert.equal(result.settings.mode,mode));check('settings-fi',()=>assert.equal(result.settings.fiInfra,fiEnabled));
  if(loadPattern==='periodic-main-thread')check('synthetic-load-ran',()=>assert.ok(result.syntheticSlices>0,'the declared synthetic main-thread workload must actually run'));
  if(callbackJitterMs&&fiEnabled){
   check('jitter-injected',()=>assert.ok(result.callbackJitter.injected>0,'the controlled jitter must actually be injected'));
   check('jitter-clock-transition',()=>assert.ok(result.callbackJitter.selectors.some(s=>!s.fallback)&&result.callbackJitter.selectors.some(s=>s.fallback),
    'controlled callback jitter must transition from video callbacks to the display clock'));
   check('jitter-clock-recovery',()=>assert.equal(result.callbackKind,'animation','the display clock must remain selected after jitter recovery'));
  }
  if(fiEnabled){
   if(['compact','scalar-compact'].includes(process.env.FI_KERNEL))check('experimental-kernel',()=>assert.equal(result.backendOptions.compact,true,'the requested experimental kernel must actually run'));
   if(process.env.FI_KERNEL==='generic')check('experimental-kernel',()=>assert.equal(result.backendOptions.generic,true,'the requested generic kernel must actually run'));
   if(process.env.FI_KERNEL==='storage')check('experimental-kernel',()=>assert.equal(result.backendOptions.storageTiles,true,'the requested storage-tiled kernel must actually run'));
   if(process.env.FI_CANVAS_COPY==='1')check('experimental-presentation',()=>assert.equal(result.backendOptions.canvasCopy,true,'the requested experimental presentation path must actually run'));
   if(process.env.FI_CAPTURE)check('experimental-capture',()=>assert.equal(result.backendOptions.captureMode,process.env.FI_CAPTURE,'the requested capture path must actually run'));
   if(['storage-compact','storage-generic','storage-specialized'].includes(process.env.FI_KERNEL))check('experimental-kernel',()=>{assert.equal(result.backendOptions.compact,process.env.FI_KERNEL!=='storage-specialized');assert.equal(result.backendOptions.storageTiles,true);assert.equal(result.backendOptions.genericStorage,process.env.FI_KERNEL==='storage-generic');});
   if(process.env.FI_FILTERED_SOURCES!==undefined)check('filtered-sources',()=>assert.equal(result.backendOptions.filteredSources,process.env.FI_FILTERED_SOURCES==='1'));
   if(process.env.FI_GENERIC_CONCAT!==undefined)check('generic-concat',()=>assert.equal(result.backendOptions.genericConcat,process.env.FI_GENERIC_CONCAT==='1'));
   if(process.env.FI_GENERIC_FLOW!==undefined)check('generic-flow',()=>assert.equal(result.backendOptions.genericFlow,process.env.FI_GENERIC_FLOW==='1'));
  }
  check('source-cadence',()=>assert.ok(result.sourceRate>=effectiveFps*.95,'source playback must preserve its original cadence at the requested playback rate'));
  if(!ref){
   check('source-gap',()=>assert.ok(result.maxSourceGapMs<Math.max(35,1000/effectiveFps*1.6),'a good FPS average cannot hide a source stutter'));
   // Initial browser device setup is reported independently before source
   // playback, never included in the model's steady FPS or hidden in an average.
   check('raf-probe-steady',()=>assert.ok(result.responsiveness.steady.samples>0,'steady refresh responsiveness must actually be observed'));
   check('gpu-probe-steady',()=>assert.ok(result.gpuResponsiveness.steady.samples>0,'steady GPU completion responsiveness must actually be observed'));
   for(const [name,phase] of Object.entries(result.responsiveness))if(name!=='device'&&phase.samples)check('raf-'+name,()=>assert.ok(phase.maxMs<50,'spatial/model preparation and steady execution cannot hold browser refresh for 50 ms'));
   for(const [name,phase] of Object.entries(result.gpuResponsiveness))if(phase.samples)check('gpu-'+name,()=>assert.ok(phase.maxMs<50,'responsive JavaScript cannot hide a GPU presentation stall'));
   if(fiEnabled){
    for(const phase of ['model','warm']){const cadence=result.sourceByPhase[phase];if(cadence?.durationMs>=500){
     check('source-gap-'+phase,()=>assert.ok(cadence.maxGapMs<Math.max(35,1000/effectiveFps*1.6),'model preparation must preserve original-frame presentation'));
     check('source-cadence-'+phase,()=>assert.ok(cadence.fps>=effectiveFps*.95,'model preparation must preserve the source rate'));
    }}
    check('neural-engine',()=>assert.equal(result.fi?.actualEngine,'ifrnet'));check('neural-fallback',()=>assert.equal(result.fi?.fallbackReason,''));
    check('neural-error',()=>assert.equal(result.fi?.backendError,''));check('neural-midpoints',()=>assert.equal(result.otherMids,0,'all counted midpoints must be neural IFRNet frames'));
    if(result.fi?.displayHz>effectiveFps*1.45){
     check('sustained-midpoint-rate',()=>assert.ok(result.midRate>=effectiveFps*.2,'neural interpolation must present a sustained series of actual midpoints'));
     const windows=result.windows.filter(w=>w.durationMs>=Math.min(1000,steadyMs)*.8);
     check('sustained-midpoint-windows',()=>assert.ok(windows.length>0&&windows.filter(w=>w.mid>0).length>=Math.ceil(windows.length*.8),'a transient midpoint is not sufficient'));
    }
   }else{
    check('spatial-only-no-midpoints',()=>assert.equal(result.midRate,0));check('spatial-only-no-neural-work',()=>assert.equal(result.attempts,0));
   }
  }
  if(bench.failures.length)throw new AggregateError(bench.failures.map(f=>new Error(f.name+': '+f.message)),'Browser benchmark assertions failed');
 }catch(error){failure=error;if(!bench.failures.length||!(error instanceof AggregateError))record(error,'harness');}
 finally{
  if(page&&!page.isClosed())try{
   const observed=await page.evaluate(()=>{
    if(window.series)clearInterval(series.loadTimer);
    const context=typeof gl==='undefined'?null:gl,debug=context?.getExtension('WEBGL_debug_renderer_info');
    const engine=typeof fiGpuEngine==='undefined'?null:fiGpuEngine;
    const adapters=window.series?.adapterObservations||[],lastAdapter=adapters.at(-1);
    return {adapterObservations:adapters,webglRenderer:context?{renderer:context.getParameter(context.RENDERER),vendor:context.getParameter(context.VENDOR),
      unmaskedRenderer:debug?context.getParameter(debug.UNMASKED_RENDERER_WEBGL):null,unmaskedVendor:debug?context.getParameter(debug.UNMASKED_VENDOR_WEBGL):null,
      version:context.getParameter(context.VERSION),shadingLanguageVersion:context.getParameter(context.SHADING_LANGUAGE_VERSION)}:null,
     capabilities:{webgpuApi:!!navigator.gpu,webgpuAdapter:lastAdapter?lastAdapter.available:!navigator.gpu?false:null,
      webgpuAdapterStatus:!navigator.gpu?'unavailable':lastAdapter?(lastAdapter.available?'available':'unavailable'):'not-requested',
      webgpuUnavailableReason:!navigator.gpu?'WebGPU API unavailable':lastAdapter&&!lastAdapter.available?lastAdapter.error||'requestAdapter returned null':null,webgl2:!!context,
      gpuCompletionProbeStatus:window.series?.probeDrain?(series.probeDrain.remaining?'unavailable':'available'):'not-measured',
      requestVideoFrameCallback:typeof HTMLVideoElement.prototype.requestVideoFrameCallback==='function',videoFrame:typeof VideoFrame==='function',
      offscreenCanvas:typeof OffscreenCanvas==='function',secureContext:isSecureContext,crossOriginIsolated,
      webglExtensions:context?.getSupportedExtensions()||[]},
     screen:{width:screen.width,height:screen.height,availWidth:screen.availWidth,availHeight:screen.availHeight,colorDepth:screen.colorDepth,pixelDepth:screen.pixelDepth,
      devicePixelRatio,viewport:{width:innerWidth,height:innerHeight},orientation:screen.orientation?{type:screen.orientation.type,angle:screen.orientation.angle}:null},
     userAgent:navigator.userAgent,hardwareConcurrency:navigator.hardwareConcurrency,deviceMemory:navigator.deviceMemory??null,
     deviceMarks:performance.getEntriesByType('mark').filter(mark=>mark.name.startsWith('ve-device-')).map(mark=>({name:mark.name,startTime:mark.startTime})),
     observedVideo:window.video?{width:video.videoWidth,height:video.videoHeight,playbackRate:video.playbackRate,readyState:video.readyState}:null,
     liveState:{phase:window.series?.phase||'setup',status:typeof status==='undefined'?null:status,pipeline:typeof activePipeline==='undefined'?null:activePipeline,
      selectedBackends:{neural:engine?.kind||null,api:engine?.backend||null,modelSize:engine?.modelSize||null}}};
   });
   bench.environment={...bench.environment,...observed,nodeVersion:process.version,platform:process.platform,arch:process.arch};
  }catch(error){bench.environment={...bench.environment,collectionError:String(error.message||error)};}
  bench.finishedAt=new Date().toISOString();bench.phasesMs.totalBeforeCleanup=performance.now()-hostStart;
  bench.status=failure||bench.failures.length?'failed':'passed';bench.exitCode=bench.status==='passed'?0:1;
  if(!bench.result)console.log(JSON.stringify(bench,null,2));else if(bench.failures.length)console.log(JSON.stringify({benchFailures:bench.failures},null,2));
  try{writeBench();}catch(error){record(error,'result-file');failure||=error;console.error('Cannot write BENCH_RESULT_FILE:',error);}
  try{await browser?.close();}catch(error){record(error,'browser-cleanup');failure||=error;}
  try{if(server?.listening)await new Promise(r=>server.close(r));
   if(temp){const resolved=fs.realpathSync(temp),parent=fs.realpathSync(os.tmpdir());
    assert.equal(path.dirname(resolved),parent);assert.ok(path.basename(resolved).startsWith('video-enhancer-browser-'));fs.rmSync(resolved,{recursive:true,force:true});}
  }catch(error){record(error,'fixture-cleanup');failure||=error;}
  // Keep the early report for abrupt browser cleanup failures, then always
  // rewrite the final record, including cleanup errors even after test failure.
  bench.status=failure||bench.failures.length?'failed':'passed';bench.exitCode=bench.status==='passed'?0:1;
  bench.finishedAt=new Date().toISOString();bench.phasesMs.totalIncludingCleanup=performance.now()-hostStart;
  try{writeBench();}catch(error){record(error,'final-result-file');failure||=error;console.error('Cannot finalize BENCH_RESULT_FILE:',error);}
 }
 if(failure)throw failure;
})().catch(e=>{console.error(e);process.exitCode=1;});
