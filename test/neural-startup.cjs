// Real WebGL2 startup responsiveness with spatial enhancement already active.
// BASELINE_REF runs previous production sources; STARTUP_CPU optionally slows CPU.
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const cp=require('node:child_process'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),ref=process.env.BASELINE_REF||'',cpu=Number(process.env.STARTUP_CPU||1);
const profile=process.env.STARTUP_PROFILE||'balanced',mode=process.env.STARTUP_MODE||'rcas',fps=Number(process.env.STARTUP_FPS||30);
if(ref&&!/^[a-f0-9]{7,40}$/.test(ref))throw new Error('BASELINE_REF must be a commit hash');
assert.ok(cpu>=1&&cpu<=8);
const code=name=>ref?cp.execFileSync('git',['show',ref+':'+name],{cwd:root,encoding:'utf8'}):fs.readFileSync(path.join(root,name),'utf8');
(async()=>{
 const model=fs.readFileSync(path.join(root,'models/ifrnet.bin'));
 const server=http.createServer((req,res)=>{
  if(req.url==='/models/ifrnet.bin'){res.setHeader('Content-Type','application/octet-stream');res.setHeader('Content-Length',model.length);res.end(model);return;}
  if(['/third_party/ravu-lite/ravu-lite-webgl2.js','/third_party/ravu-lite/ravu-lite-lut3.bin'].includes(req.url)){
   const data=fs.readFileSync(path.join(root,req.url.slice(1)));res.setHeader('Content-Length',data.length);res.end(data);return;}
  res.setHeader('Content-Type','text/html');res.end('<!doctype html><div style="position:relative;width:960px"><video muted autoplay style="width:960px;height:540px"></video></div>');
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
 try{
  browser=await chromium.launch({channel:process.env.TEST_BROWSER||'msedge',headless:true,
   args:['--autoplay-policy=no-user-gesture-required','--disable-gpu-shader-disk-cache']});
  const page=await browser.newPage({viewport:{width:1100,height:750}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));await page.goto(`http://127.0.0.1:${server.address().port}`);
  if(cpu!==1){const dev=await page.context().newCDPSession(page);await dev.send('Emulation.setCPUThrottlingRate',{rate:cpu});}
  await page.evaluate(({profile,mode,fps})=>{
   window.chrome={runtime:{getURL:p=>location.origin+'/'+p,sendMessage:async()=>({ok:true,installed:false}),onMessage:{addListener(){}}},
    storage:{onChanged:{addListener(){}},local:{get:async d=>({...d,mode,strength:100,fiProfile:profile,fiEngine:'ifrnet',fiInfra:false,interaction:'quality'})}}};
   const source=document.createElement('canvas');source.width=1280;source.height=720;
   const ctx=source.getContext('2d');let frame=0;
   const paint=()=>{ctx.fillStyle='#224477';ctx.fillRect(0,0,1280,720);ctx.fillStyle='#eecc55';ctx.fillRect(frame++*3%1200,100,60,400);};
   paint();window.paintTimer=setInterval(paint,1000/fps);window.video=document.querySelector('video');video.srcObject=source.captureStream(fps);video.play();
   window.startup={frames:[],raf:[],tasks:[],stages:{},inferences:[]};
   let last=0;function tick(t){if(last)startup.raf.push({t,gap:t-last});last=t;requestAnimationFrame(tick);}requestAnimationFrame(tick);
   window.taskObserver=new PerformanceObserver(list=>startup.tasks.push(...list.getEntries().map(e=>({start:e.startTime,ms:e.duration}))));
   taskObserver.observe({type:'longtask',buffered:true});
  },{profile,mode,fps});
  for(const name of ['feed-session.js','fi-quality.js','fi-core.js','fi-analytic.js','fi-webgpu.js','neural/model-spec.js','neural/graph.js','neural/runtime.js','neural/client.js','content.js'])await page.addScriptTag({content:code(name)});
  await page.waitForFunction(()=>status==='ok'&&textureWidth===1280);
  await page.evaluate(()=>{
   const original=draw;draw=function(options={}){original(options);if(options.newVideoFrame&&status==='ok')startup.frames.push({t:performance.now(),phase:fiGpuState,pipeline:activePipeline});};
   function measure(owner,name,label){const fn=owner[name];owner[name]=function(...args){const start=performance.now();const result=fn.apply(this,args);
    (startup.stages[label]||=[]).push(performance.now()-start);return result;};}
   measure(VENeuralSpec,typeof VENeuralSpec.decodeWeightsAsync==='function'?'decodeWeightsAsync':'decodeWeights','decode');measure(VENeuralGraph,'packLayer','pack');
   for(const name of ['texture','program','prepare'])measure(VENeuralRuntime.prototype,name,name);
   measure(window,'fiUpdateLumaSample','lumaReadback');measure(window,'fiEnsurePrograms','legacyShaders');
   const create=VENeuralRuntime.create.bind(VENeuralRuntime);VENeuralRuntime.create=(...args)=>create(...args).then(engine=>{
    const estimate=engine.estimate.bind(engine);engine.estimate=(...a)=>estimate(...a).then(result=>{if(result?.valid)startup.inferences.push(result.elapsedMs);return result;});return engine;
   });
  });
  await page.waitForFunction(()=>startup.frames.length>=30);
  const begin=await page.evaluate(()=>{startup.begin=performance.now();applySettings({...settings,fiInfra:true});return startup.begin;});
  await page.waitForFunction(()=>Boolean(fiNeuralFailure)||(fiGpuState==='ready'&&fiGpuEngine?.kind==='ifrnet'),null,{timeout:60000});
  const ready=await page.evaluate(()=>performance.now());
  assert.equal(await page.evaluate(()=>fiNeuralFailure),'','startup must not silently fall back');
  await page.waitForFunction(()=>fiGpuEngine.stats.completed>0,null,{timeout:30000});
  if(process.env.STARTUP_MEASURE==='1')await page.waitForFunction(()=>startup.inferences.length>=20,null,{timeout:30000});
  const result=await page.evaluate(({begin,ready})=>{
   const frames=startup.frames.filter(f=>f.t>=begin&&f.t<=ready),raf=startup.raf.filter(f=>f.t>=begin&&f.t<=ready);
   return {readyMs:Math.round(ready-begin),spatialFramesDuringLoad:frames.length,spatialActive:frames.every(f=>f.pipeline.includes('RCAS')),
    maxRafGapMs:Math.round(Math.max(0,...raf.map(f=>f.gap))),longTasks:startup.tasks.filter(t=>t.start>=begin&&t.start<=ready),
    syncPeakMs:Object.fromEntries(Object.entries(startup.stages).map(([k,v])=>[k,+Math.max(...v).toFixed(2)])),
    inferenceMs:startup.inferences,displayHz:1000/fiDisplayPeriod,midPerSec:fiMidPerSec,
    glError:gl.getError(),backend:fiGpuEngine.kind,diagnostics:fiGpuEngine.diagnostics};
  },{begin,ready});
  console.log(JSON.stringify({ref:ref||'current',cpu,profile,mode,fps,...result},null,2));
  assert.equal(result.backend,'ifrnet');assert.equal(result.glError,0);assert.deepEqual(errors,[]);
  assert.ok(result.spatialFramesDuringLoad>=2,'spatial compositor continues while model loads');assert.ok(result.spatialActive);
  if(!ref){
   assert.ok(result.syncPeakMs.decode<16,'decoding cannot consume an entire 60Hz frame in one task');
   assert.equal(result.syncPeakMs.lumaReadback,undefined,'neural startup performs no legacy CPU video readback');
   assert.equal(result.syncPeakMs.legacyShaders,undefined,'neural startup compiles no unused legacy shaders');
  }
  console.log('PASS: real IFRNet startup keeps enhanced source frames advancing');
 }finally{await browser?.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
