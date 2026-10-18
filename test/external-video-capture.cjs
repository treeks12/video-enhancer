// Native WebGPU external-video capture microbenchmark. It does not use the add-on.
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),os=require('node:os');
const crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),browserKind=process.env.TEST_BROWSER||'firefox';
const sourceFile=process.env.SOURCE_FILE?path.resolve(process.env.SOURCE_FILE):'';
const sourceSize=process.env.SOURCE_SIZE||'1920x1080',[sourceWidth,sourceHeight]=sourceSize.split('x').map(Number);
const sourceFps=Number(process.env.SOURCE_FPS||60),captureFrames=Number(process.env.CAPTURE_FRAMES||120);
const captureCompare=process.env.CAPTURE_COMPARE==='1';
const resultFile=process.env.BENCH_RESULT_FILE||'';
const config={browser:browserKind,sourceFile:sourceFile||null,sourceSize,sourceWidth,sourceHeight,sourceFps,captureFrames,
 captureCompare,order:['A','B','B','A'],maxInFlight:4,headless:false};
const bench={schemaVersion:1,test:'external-video-capture',startedAt:new Date().toISOString(),finishedAt:null,status:'failed',config,
 fixture:null,environment:null,result:null,failures:[],exitCode:1};
let browser,server,temp,failure;

function validate(){
 assert.ok(['firefox','chromium','edge'].includes(browserKind),'TEST_BROWSER must be firefox or chromium/edge');
 assert.ok(sourceFile,'SOURCE_FILE must point to an existing MP4 fixture');
 assert.ok(/\.mp4$/i.test(sourceFile),'SOURCE_FILE must be an MP4');
 assert.ok(fs.statSync(sourceFile).isFile(),'SOURCE_FILE must be a regular file');
 assert.ok(['640x360','1280x720','1920x1080'].includes(sourceSize),'supported SOURCE_SIZE');
 assert.ok([24,30,60].includes(sourceFps),'supported SOURCE_FPS');
 assert.ok(Number.isInteger(captureFrames)&&captureFrames>=10&&captureFrames<=3600,'CAPTURE_FRAMES must be an integer from 10 to 3600');
}
function writeBench(){
 if(!resultFile)return;
 fs.mkdirSync(path.dirname(path.resolve(resultFile)),{recursive:true});
 fs.writeFileSync(resultFile,JSON.stringify(bench,null,2)+'\n');
}

(async()=>{
 const hostStart=performance.now();
 try{
  validate();
  const puppeteer=require('puppeteer-core');
  temp=fs.mkdtempSync(path.join(os.tmpdir(),'external-video-capture-'));
  const fixtureStat=fs.statSync(sourceFile);
  bench.fixture={path:sourceFile,bytes:fixtureStat.size,sha256:crypto.createHash('sha256').update(fs.readFileSync(sourceFile)).digest('hex')};
  server=http.createServer((req,res)=>{
   const pathname=new URL(req.url,'http://127.0.0.1').pathname;
   if(pathname==='/motion.mp4'){
    res.setHeader('Content-Type','video/mp4');res.setHeader('Accept-Ranges','bytes');
    const range=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range||'');
    if(range){
     const start=Number(range[1]),end=range[2]?Math.min(Number(range[2]),fixtureStat.size-1):fixtureStat.size-1;
     if(start>=fixtureStat.size||end<start){res.statusCode=416;res.setHeader('Content-Range',`bytes */${fixtureStat.size}`);res.end();return;}
     res.statusCode=206;res.setHeader('Content-Range',`bytes ${start}-${end}/${fixtureStat.size}`);
     res.setHeader('Content-Length',end-start+1);fs.createReadStream(sourceFile,{start,end}).pipe(res);return;
    }
    res.setHeader('Content-Length',fixtureStat.size);fs.createReadStream(sourceFile).pipe(res);return;
   }
   if(pathname==='/'){
    res.setHeader('Content-Type','text/html; charset=utf-8');
    res.end(`<!doctype html><meta charset="utf-8"><video id="source" muted autoplay loop playsinline preload="auto" style="width:640px;height:360px"></video>`);return;
   }
   res.statusCode=404;res.end('not found');
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const executablePath=browserKind==='firefox'?(process.env.FIREFOX_PATH||'C:/Program Files/Mozilla Firefox/firefox.exe'):
   (process.env.EDGE_PATH||process.env.CHROMIUM_PATH||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe');
  browser=await puppeteer.launch({browser:browserKind==='firefox'?'firefox':'chrome',headless:false,executablePath,
   userDataDir:path.join(temp,'profile'),defaultViewport:{width:1100,height:750},timeout:60000});
  bench.environment={browserVersion:await browser.version(),nodeVersion:process.version,platform:process.platform,arch:process.arch};
  const page=await browser.newPage();const pageErrors=[];page.on('pageerror',error=>pageErrors.push(String(error.message||error)));
  await page.bringToFront();await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.evaluate(({sourceSize,sourceFps})=>{
   const video=document.querySelector('#source');video.src=location.origin+'/motion.mp4';video.playbackRate=1;
   window.__captureBench={sourceSize,sourceFps};
  },{sourceSize,sourceFps});
  await page.waitForFunction(()=>{const video=document.querySelector('#source');return !video.paused&&video.currentTime>.1&&video.readyState>=2;},{timeout:30000});
  const browserResult=await page.evaluate(async({sourceWidth,sourceHeight,sourceFps,captureFrames,captureCompare})=>{
   const video=document.querySelector('#source'),MAX_JOBS=4,OUTPUT_COUNT=4;
   const rafMaxByPhase={},uncapturedErrors=[],scopeErrors=[],sampleErrors=[];
   let phase='startup',previousRaf=null,rafHandle=0;
   const rafTick=now=>{
    if(previousRaf!==null){const item=rafMaxByPhase[phase]||(rafMaxByPhase[phase]={samples:0,maxMs:0});item.samples++;item.maxMs=Math.max(item.maxMs,now-previousRaf);}
    previousRaf=now;rafHandle=requestAnimationFrame(rafTick);
   };
   rafHandle=requestAnimationFrame(rafTick);
   const now=()=>performance.now(),safeError=error=>String(error?.message||error||'unknown error').slice(0,400);
   const unsupported=(reason,extra={})=>({status:'unsupported',unsupportedReason:reason,...extra});
   if(typeof video.requestVideoFrameCallback!=='function')return unsupported('requestVideoFrameCallback is unavailable.');
   if(!navigator.gpu)return unsupported('WebGPU is unavailable in this browser context.');
   if(typeof VideoFrame!=='function')return unsupported('VideoFrame is unavailable; path A cannot be tested.');
   if(video.videoWidth!==sourceWidth||video.videoHeight!==sourceHeight)return {status:'failed',error:`decoded size ${video.videoWidth}x${video.videoHeight} does not match ${sourceWidth}x${sourceHeight}`};
   let device,adapter;
   try{adapter=await navigator.gpu.requestAdapter();if(!adapter)return unsupported('requestAdapter returned no WebGPU adapter.');device=await adapter.requestDevice();}
   catch(error){return {status:'failed',error:`WebGPU device setup failed: ${safeError(error)}`};}
   device.addEventListener('uncapturederror',event=>{if(uncapturedErrors.length<40)uncapturedErrors.push({phase,errorType:event.error?.constructor?.name||'GPUError',message:safeError(event.error)});});
   if(typeof device.importExternalTexture!=='function')return unsupported('GPUDevice.importExternalTexture is unavailable.');
   const baselineStart=now();let nativeCallbacks=0,nativeEnd=baselineStart;phase='nativeBaseline';
   await new Promise(resolve=>{
    const callback=time=>{nativeCallbacks++;nativeEnd=time;if(time-baselineStart>=2000)resolve();else video.requestVideoFrameCallback(callback);};
    video.requestVideoFrameCallback(callback);
   });
   const nativeElapsedMs=nativeEnd-baselineStart,nativeFPS=nativeElapsedMs>0?nativeCallbacks*1000/nativeElapsedMs:0;
   const shader=`
@group(0) @binding(0) var source:texture_external;
@group(0) @binding(1) var imageSampler:sampler;
@group(0) @binding(2) var output:texture_storage_2d<rgba8unorm,write>;
@compute @workgroup_size(8,8)
fn copyFrame(@builtin(global_invocation_id) id:vec3<u32>){
 let size=textureDimensions(output);
 if(id.x>=size.x||id.y>=size.y){return;}
 let uv=(vec2<f32>(id.xy)+vec2<f32>(0.5))/vec2<f32>(size);
 textureStore(output,vec2<i32>(id.xy),textureSampleBaseClampToEdge(source,imageSampler,uv));
}`;
   let sampler,pipeline,outputs=[];
   phase='setup';device.pushErrorScope('validation');device.pushErrorScope('out-of-memory');device.pushErrorScope('internal');
   try{
    sampler=device.createSampler({addressModeU:'clamp-to-edge',addressModeV:'clamp-to-edge',magFilter:'linear',minFilter:'linear'});
    const module=device.createShaderModule({label:'External video capture microbenchmark',code:shader});
    pipeline=await device.createComputePipelineAsync({label:'External video copy to RGBA8',layout:'auto',compute:{module,entryPoint:'copyFrame'}});
    for(let index=0;index<OUTPUT_COUNT;index++)outputs.push(device.createTexture({label:`external capture output ${index}`,
     size:[sourceWidth,sourceHeight],format:'rgba8unorm',usage:GPUTextureUsage.STORAGE_BINDING|GPUTextureUsage.COPY_SRC}));
   }catch(error){
    const setupScopes=[];for(const type of ['internal','out-of-memory','validation']){try{const result=await device.popErrorScope();if(result)setupScopes.push({type,message:safeError(result)});}catch(popError){setupScopes.push({type,message:safeError(popError)});}}
    return {status:'failed',error:`WebGPU copy pipeline setup failed: ${safeError(error)}`,scopeErrors:setupScopes,uncapturedErrors};
   }
   for(const type of ['internal','out-of-memory','validation']){try{const error=await device.popErrorScope();if(error)scopeErrors.push({phase:'setup',type,message:safeError(error)});}catch(error){scopeErrors.push({phase:'setup',type,message:safeError(error)});}}
   const pathStats={A:{callbacks:0,attempted:0,captured:0,submitted:0,completed:0,failedSamples:0,skippedInFlight:0,
     captureTimes:[],submitTimes:[],totalTimes:[],activeMs:0,blocks:[],errors:[]},
    B:{callbacks:0,attempted:0,captured:0,submitted:0,completed:0,failedSamples:0,skippedInFlight:0,
     captureTimes:[],submitTimes:[],totalTimes:[],activeMs:0,blocks:[],errors:[]}};
   const allFrames=new Set(),freeSlots=[0,1,2,3];let fatalUnsupported=null;
   const addError=(stats,entry)=>{if(stats.errors.length<20)stats.errors.push(entry);};
   const summarize=values=>{
    if(!values.length)return {count:0,totalMs:0,meanMs:null,medianMs:null,p95Ms:null,maxMs:null};
    const sorted=values.slice().sort((a,b)=>a-b),count=sorted.length;
    return {count,totalMs:values.reduce((sum,value)=>sum+value,0),meanMs:values.reduce((sum,value)=>sum+value,0)/count,
     medianMs:count%2?sorted[(count-1)/2]:(sorted[count/2-1]+sorted[count/2])/2,p95Ms:sorted[Math.max(0,Math.ceil(count*.95)-1)],maxMs:sorted.at(-1)};
   };
   const closeFrame=frame=>{if(frame&&!frame.closed){try{frame.close();}catch{}allFrames.delete(frame);}};
   async function runBlock(pathName,callbackTarget,blockIndex){
    const stats=pathStats[pathName],block={path:pathName,index:blockIndex,requested:callbackTarget,callbacks:0,attempted:0,captured:0,submitted:0,completed:0,
     failedSamples:0,skippedInFlight:0,firstCallbackTime:null,lastCallbackTime:null,durationMs:0,errors:[],scopeErrors:[]};
    const pending=new Set();let stopReason=null;phase=`${pathName}${blockIndex}`;
    device.pushErrorScope('validation');device.pushErrorScope('out-of-memory');device.pushErrorScope('internal');
    await new Promise(resolve=>{
     const onFrame=(callbackTime,metadata)=>{
      block.callbacks++;stats.callbacks++;if(block.firstCallbackTime===null)block.firstCallbackTime=callbackTime;block.lastCallbackTime=callbackTime;
      if(freeSlots.length===0){block.skippedInFlight++;block.failedSamples++;stats.skippedInFlight++;stats.failedSamples++;}
      else{
       block.attempted++;stats.attempted++;
       const slot=freeSlots.shift(),texture=outputs[slot];let frame=null,external=null,captureMs=0,submitMs=0,captured=false,submitted=false;
       const captureStart=now();
       try{
        if(pathName==='A'){
         const mediaTime=Number.isFinite(metadata?.mediaTime)?metadata.mediaTime:video.currentTime;
         frame=new VideoFrame(video,{timestamp:Math.round(mediaTime*1e6)});allFrames.add(frame);
         external=device.importExternalTexture({source:frame});
        }else external=device.importExternalTexture({source:video});
        captureMs=now()-captureStart;stats.captureTimes.push(captureMs);captured=true;block.captured++;stats.captured++;
       }catch(error){
        captureMs=now()-captureStart;stats.captureTimes.push(captureMs);block.failedSamples++;stats.failedSamples++;
        const message=safeError(error),entry={path:pathName,block:blockIndex,callback:block.callbacks,stage:'external-texture-import',message};
        addError(stats,entry);if(block.errors.length<20)block.errors.push(entry);closeFrame(frame);freeSlots.push(slot);
        if(pathName==='B'){stopReason=`Direct HTMLVideoElement import is unsupported: ${message}`;fatalUnsupported=stopReason;}
       }
       if(captured){
        const submitStart=now();let fence;
        try{
         const bindGroup=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[
          {binding:0,resource:external},{binding:1,resource:sampler},{binding:2,resource:texture.createView()}]});
         const encoder=device.createCommandEncoder({label:`copy ${pathName} frame ${block.callbacks}`});
         const pass=encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,bindGroup);
         pass.dispatchWorkgroups(Math.ceil(sourceWidth/8),Math.ceil(sourceHeight/8));pass.end();
         device.queue.submit([encoder.finish()]);fence=device.queue.onSubmittedWorkDone();
         submitMs=now()-submitStart;stats.submitTimes.push(submitMs);stats.totalTimes.push(captureMs+submitMs);
         submitted=true;block.submitted++;stats.submitted++;
        }catch(error){
         submitMs=now()-submitStart;stats.submitTimes.push(submitMs);block.failedSamples++;stats.failedSamples++;
         const entry={path:pathName,block:blockIndex,callback:block.callbacks,stage:'encode-submit',message:safeError(error)};
         addError(stats,entry);if(block.errors.length<20)block.errors.push(entry);closeFrame(frame);freeSlots.push(slot);
        }
        if(submitted){
         let tracked;
         tracked=Promise.resolve(fence).then(()=>{block.completed++;stats.completed++;},error=>{
          block.failedSamples++;stats.failedSamples++;const entry={path:pathName,block:blockIndex,callback:block.callbacks,stage:'queue-fence',message:safeError(error)};
          addError(stats,entry);if(block.errors.length<20)block.errors.push(entry);
         }).then(()=>{closeFrame(frame);freeSlots.push(slot);pending.delete(tracked);});
         pending.add(tracked);
        }
       }
      }
      if(stopReason||block.callbacks>=callbackTarget)resolve();else video.requestVideoFrameCallback(onFrame);
     };
     video.requestVideoFrameCallback(onFrame);
    });
    if(pending.size)await Promise.allSettled([...pending]);
    block.durationMs=block.firstCallbackTime===null?0:block.lastCallbackTime-block.firstCallbackTime;
    stats.activeMs+=block.durationMs;
    for(const type of ['internal','out-of-memory','validation']){
     try{const error=await device.popErrorScope();if(error){const entry={phase,block:blockIndex,type,message:safeError(error)};
      scopeErrors.push(entry);block.scopeErrors.push(entry);}}
     catch(error){const entry={phase,block:blockIndex,type,message:safeError(error)};scopeErrors.push(entry);block.scopeErrors.push(entry);}
    }
    stats.blocks.push(block);return {block,stopReason};
   }
   async function compareColor(){
    const thresholds={maxRgbBytes:3,meanRgbBytes:0.5,maxAlphaBytes:0};
    const result={label:'colorComparison',status:'failed',width:sourceWidth,height:sourceHeight,thresholds};
    const buffers=[];let frame=null,copySubmitted=false,scopeCount=0;
    const scopeOrder=['internal','out-of-memory','validation'];
    phase='colorComparison';video.pause();
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    try{
     for(const type of ['validation','out-of-memory','internal']){device.pushErrorScope(type);scopeCount++;}
     frame=new VideoFrame(video,{timestamp:Math.round(video.currentTime*1e6)});
     const frameExternal=device.importExternalTexture({source:frame});
     let videoExternal=null;
     try{videoExternal=device.importExternalTexture({source:video});}
     catch(error){result.status='unsupported';result.unsupportedReason=`HTMLVideoElement import is unsupported: ${safeError(error)}`;}
     if(videoExternal){
      const encoder=device.createCommandEncoder({label:'color comparison copies'});
      for(const [resource,texture] of [[frameExternal,outputs[0]],[videoExternal,outputs[1]]]){
       const bindGroup=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[
        {binding:0,resource},{binding:1,resource:sampler},{binding:2,resource:texture.createView()}]});
       const pass=encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,bindGroup);
       pass.dispatchWorkgroups(Math.ceil(sourceWidth/8),Math.ceil(sourceHeight/8));pass.end();
      }
      device.queue.submit([encoder.finish()]);copySubmitted=true;
      await device.queue.onSubmittedWorkDone();
      frame.close();frame=null;
      const bytesPerRow=Math.ceil(sourceWidth*4/256)*256,bufferSize=bytesPerRow*sourceHeight;
      for(let index=0;index<2;index++)buffers.push(device.createBuffer({label:`color comparison readback ${index}`,
       size:bufferSize,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST}));
      const readback=device.createCommandEncoder({label:'color comparison readback copies'});
      for(let index=0;index<2;index++)readback.copyTextureToBuffer({texture:outputs[index]},
       {buffer:buffers[index],offset:0,bytesPerRow,rowsPerImage:sourceHeight},[sourceWidth,sourceHeight,1]);
      device.queue.submit([readback.finish()]);
      await device.queue.onSubmittedWorkDone();
      await Promise.all(buffers.map(buffer=>buffer.mapAsync(GPUMapMode.READ)));
      const first=new Uint8Array(buffers[0].getMappedRange()),second=new Uint8Array(buffers[1].getMappedRange());
      let maxRgbBytes=0,totalRgbDifference=0,maxAlphaBytes=0,nonzeroRGBcount=0;
      for(let y=0;y<sourceHeight;y++)for(let x=0;x<sourceWidth;x++){
       const offset=y*bytesPerRow+x*4;let nonzero=false;
       for(let channel=0;channel<3;channel++){
        const a=first[offset+channel],b=second[offset+channel],difference=Math.abs(a-b);
        if(difference>maxRgbBytes)maxRgbBytes=difference;totalRgbDifference+=difference;
        if(a!==0||b!==0)nonzero=true;
       }
       if(nonzero)nonzeroRGBcount++;
       const alphaDifference=Math.abs(first[offset+3]-second[offset+3]);
       if(alphaDifference>maxAlphaBytes)maxAlphaBytes=alphaDifference;
      }
      const meanRgbBytes=totalRgbDifference/(sourceWidth*sourceHeight*3);
      Object.assign(result,{maxRgbBytes,meanRgbBytes,maxAlphaBytes,nonzeroRGBcount});
      result.status=nonzeroRGBcount>0&&maxRgbBytes<=thresholds.maxRgbBytes&&meanRgbBytes<=thresholds.meanRgbBytes&&maxAlphaBytes<=thresholds.maxAlphaBytes?'passed':'failed';
     }
    }catch(error){result.status='failed';result.error=safeError(error);}
    finally{
     if(frame){if(copySubmitted)try{await device.queue.onSubmittedWorkDone();}catch(error){result.fenceError=safeError(error);}
      try{frame.close();}catch{}}
     for(let index=scopeCount-1;index>=0;index--){
      try{const error=await device.popErrorScope();if(error){const entry={phase:'colorComparison',type:scopeOrder[index],message:safeError(error)};
       scopeErrors.push(entry);(result.scopeErrors||(result.scopeErrors=[])).push(entry);}}
      catch(error){const entry={phase:'colorComparison',type:scopeOrder[index],message:safeError(error)};
       scopeErrors.push(entry);(result.scopeErrors||(result.scopeErrors=[])).push(entry);}
     }
     for(const buffer of buffers){try{buffer.unmap();}catch{}try{buffer.destroy();}catch{}}
    }
    if(result.scopeErrors?.length&&result.status==='passed')result.status='failed';
    return result;
   }
   const half=Math.ceil(captureFrames/2),other=captureFrames-half;
   const blockPlan=[['A',half],['B',half],['B',other],['A',other]];let blockIndex=0;
   for(const [pathName,requested] of blockPlan){
    if(fatalUnsupported||requested===0)continue;
    const {stopReason}=await runBlock(pathName,requested,++blockIndex);
    if(stopReason)break;
   }
   phase='finalDrain';
   if(allFrames.size){
    try{await device.queue.onSubmittedWorkDone();}catch(error){if(sampleErrors.length<20)sampleErrors.push({stage:'final-drain',message:safeError(error)});}
    for(const frame of [...allFrames])closeFrame(frame);
   }
   const sampleFailures=Object.values(pathStats).some(stats=>stats.failedSamples>stats.skippedInFlight);
   const output={status:'passed',
    unsupportedReason:fatalUnsupported,nativeFPS:{callbacks:nativeCallbacks,elapsedMs:nativeElapsedMs,fps:nativeFPS},
    captureFramesPerPath:captureFrames,order:[],maxInFlight:MAX_JOBS,outputRing:{textures:OUTPUT_COUNT,format:'rgba8unorm',ownedByBenchmark:true},
    rafMaxByPhase,paths:{},blocks:[],gpuErrors:{scoped:scopeErrors,uncaptured:uncapturedErrors,other:sampleErrors},unclosedVideoFrames:allFrames.size};
   // Blocks execute as a serial ABBA sequence; no path starts before the prior fences drain.
   output.order=pathStats.A.blocks.concat(pathStats.B.blocks).sort((a,b)=>a.index-b.index).map(block=>block.path);
   output.blocks=Object.values(pathStats).flatMap(stats=>stats.blocks).sort((a,b)=>a.index-b.index);
   for(const pathName of ['A','B']){
    const stats=pathStats[pathName],activeMs=stats.activeMs;
    output.paths[pathName]={description:pathName==='A'?'VideoFrame(video) → importExternalTexture → compute copy':'importExternalTexture(HTMLVideoElement) → compute copy',
     callbacks:stats.callbacks,attemptedSamples:stats.attempted,capturedSamples:stats.captured,submittedSamples:stats.submitted,completedSamples:stats.completed,
     failedSamples:stats.failedSamples,skippedInFlight:stats.skippedInFlight,activeCallbackMs:activeMs,
     captureFPS:activeMs>0?Math.max(0,stats.callbacks-stats.blocks.length)*1000/activeMs:0,
     captureFPSBasis:'descriptive rVFC callback interval rate; submittedSamples and activeCallbackMs are reported separately',
     timing:{capture:summarize(stats.captureTimes),submit:summarize(stats.submitTimes),total:summarize(stats.totalTimes)},errors:stats.errors};
   }
   if(captureCompare){
    if(fatalUnsupported)output.colorComparison={label:'colorComparison',status:'unsupported',unsupportedReason:fatalUnsupported,
     width:sourceWidth,height:sourceHeight,thresholds:{maxRgbBytes:3,meanRgbBytes:0.5,maxAlphaBytes:0}};
    else output.colorComparison=await compareColor();
   }
   const comparisonStatus=output.colorComparison?.status;
   output.status=fatalUnsupported||comparisonStatus==='unsupported'?'unsupported':
    scopeErrors.length||uncapturedErrors.length||sampleErrors.length||sampleFailures||comparisonStatus==='failed'?'failed':'passed';
   for(const texture of outputs)try{texture.destroy();}catch{}
   try{device.destroy();}catch{}
   cancelAnimationFrame(rafHandle);phase='done';
   return output;
  },{sourceWidth,sourceHeight,sourceFps,captureFrames,captureCompare});
  bench.result={...browserResult,pageErrors};
  if(browserResult.status==='passed'&&!pageErrors.length)bench.status='passed';
  else if(browserResult.status==='unsupported')bench.status='unsupported';
  else{bench.status='failed';if(pageErrors.length)bench.failures.push({name:'page-error',message:pageErrors.join('\n')});}
 }catch(error){
  failure=error;bench.failures.push({name:'harness',type:error.name||'Error',message:String(error.message||error),stack:error.stack||null});
 }finally{
  bench.finishedAt=new Date().toISOString();bench.phasesMs={totalMs:performance.now()-hostStart};
  bench.exitCode=bench.status==='passed'?0:1;
  console.log(`External video capture benchmark: ${bench.status}`);
  for(const name of ['A','B']){const pathResult=bench.result?.paths?.[name];if(pathResult)console.log(`${name}: capture ${pathResult.captureFPS.toFixed(2)} FPS; sync capture p95 ${pathResult.timing.capture.p95Ms?.toFixed(3)??'n/a'} ms; encode+submit p95 ${pathResult.timing.submit.p95Ms?.toFixed(3)??'n/a'} ms`);}
  console.log(JSON.stringify(bench,null,2));
  try{writeBench();}catch(error){failure||=error;bench.failures.push({name:'result-file',message:String(error.message||error)});bench.status='failed';bench.exitCode=1;}
  try{await browser?.close();}catch(error){failure||=error;bench.status='failed';bench.exitCode=1;}
  try{if(server?.listening)await new Promise(resolve=>server.close(resolve));}catch(error){failure||=error;bench.status='failed';bench.exitCode=1;}
  try{if(temp){const resolved=fs.realpathSync(temp),parent=fs.realpathSync(os.tmpdir());assert.equal(path.dirname(resolved),parent);
   assert.ok(path.basename(resolved).startsWith('external-video-capture-'));fs.rmSync(resolved,{recursive:true,force:true});}}catch(error){failure||=error;bench.status='failed';bench.exitCode=1;}
  if(resultFile)try{writeBench();}catch(error){failure||=error;bench.status='failed';bench.exitCode=1;}
 }
 if(failure||bench.exitCode)process.exitCode=1;
})().catch(error=>{console.error(error);process.exitCode=1;});
