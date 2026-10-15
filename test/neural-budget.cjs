// Actual GPU overload: repeat identical convolutions to emulate a slower GPU.
// No artificial sleeps in inference. Compare source playback with FI disabled
// and enabled, then remove the extra work and require automatic recovery.
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const cp=require('node:child_process'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),ref=process.env.BASELINE_REF||'',multiplier=Number(process.env.BUDGET_LOAD||24);
const profile=process.env.BUDGET_PROFILE||'quality';
if(ref&&!/^[a-f0-9]{7,40}$/.test(ref))throw new Error('BASELINE_REF must be a commit hash');
assert.ok(multiplier>=1&&multiplier<=64);
const code=name=>ref?cp.execFileSync('git',['show',ref+':'+name],{cwd:root,encoding:'utf8'}):fs.readFileSync(path.join(root,name),'utf8');
(async()=>{
 const model=fs.readFileSync(path.join(root,'models/ifrnet.bin'));
 const server=http.createServer((req,res)=>{
  if(req.url==='/models/ifrnet.bin'){res.setHeader('Content-Length',model.length);res.end(model);return;}
  if(['/third_party/ravu-lite/ravu-lite-webgl2.js','/third_party/ravu-lite/ravu-lite-lut3.bin'].includes(req.url)){
   res.end(fs.readFileSync(path.join(root,req.url.slice(1))));return;}
  res.setHeader('Content-Type','text/html');res.end('<!doctype html><div style="position:relative;width:960px"><video muted autoplay style="width:960px;height:540px"></video></div>');
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
 try{
  browser=await chromium.launch({channel:process.env.TEST_BROWSER||'msedge',headless:true,args:['--autoplay-policy=no-user-gesture-required']});
  const page=await browser.newPage({viewport:{width:1100,height:750}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.evaluate(({multiplier,profile})=>{
   window.chrome={runtime:{getURL:p=>location.origin+'/'+p,sendMessage:async()=>({ok:true,installed:false}),onMessage:{addListener(){}}},
    storage:{onChanged:{addListener(){}},local:{get:async d=>({...d,mode:'ravu',strength:100,quality:'high',fiProfile:profile,fiEngine:'ifrnet',fiInfra:false,interaction:'quality'})}}};
   const source=document.createElement('canvas');source.width=1280;source.height=720;const ctx=source.getContext('2d');let frame=0;
   const paint=()=>{ctx.fillStyle='#224477';ctx.fillRect(0,0,1280,720);ctx.fillStyle='#eecc55';ctx.fillRect(frame++*3%1200,100,60,400);};
   window.video=document.querySelector('video');
   window.setSourceFps=async fps=>{clearInterval(window.paintTimer);for(const track of video.srcObject?.getTracks()||[])track.stop();
    paint();video.srcObject=source.captureStream(fps);window.paintTimer=setInterval(paint,1000/fps);await video.play();};
   setSourceFps(60);
   window.budgetTest={multiplier,frames:[],mids:0,calls:0,completed:[],afterDeadline:0};
  },{multiplier,profile});
  for(const name of ['feed-session.js','fi-quality.js','fi-core.js','fi-analytic.js','fi-webgpu.js','neural/model-spec.js','neural/graph.js','neural/runtime.js','neural/client.js'])await page.addScriptTag({content:code(name)});
  await page.evaluate(()=>{
   const run=VENeuralRuntime.prototype.runOps;
   VENeuralRuntime.prototype.runOps=function(ops,...args){
    if(this.testDeadline&&performance.now()>=this.testDeadline)budgetTest.afterDeadline++;
    for(const op of ops)for(let i=0;i<(op.layer?budgetTest.multiplier:1);i++)run.call(this,[op],...args);
   };
   const estimate=VENeuralRuntime.prototype.estimate;
   VENeuralRuntime.prototype.estimate=async function(...args){
    budgetTest.calls++;this.testDeadline=args[4]?.deadline||0;
    try{const result=await estimate.apply(this,args);if(result?.valid)budgetTest.completed.push(result.elapsedMs);return result;}
    finally{this.testDeadline=0;}
   };
  });
  await page.addScriptTag({content:code('content.js')});
  await page.waitForFunction(()=>status==='ok'&&activePipeline.includes('RAVU'));
  await page.evaluate(()=>{
   const original=draw;draw=function(options={}){const before=metricWindow?.realDrawn||0,mids=metricWindow?.midDrawn||0;original(options);
    if(options.newVideoFrame&&(metricWindow?.realDrawn||0)>before)budgetTest.frames.push(performance.now());
    if(options.fiMid&&(metricWindow?.midDrawn||0)>mids)budgetTest.mids++;
   };
  });
  await page.waitForFunction(()=>budgetTest.frames.length>=90,null,{timeout:30000});
  const measure=async()=>{
   const start=await page.evaluate(()=>performance.now());await page.waitForTimeout(3000);
   return page.evaluate(start=>{const end=performance.now(),frames=budgetTest.frames.filter(t=>t>=start&&t<=end);
    return {fps:frames.length*1000/(end-start),maxGapMs:Math.max(0,...frames.slice(1).map((t,i)=>t-frames[i]))};},start);
  };
  const spatial=await measure();
  await page.evaluate(()=>applySettings({...settings,fiInfra:true}));
  await page.waitForFunction(()=>fiGpuState==='ready'&&fiGpuEngine?.kind==='ifrnet',null,{timeout:60000});
  await page.waitForTimeout(1500); // Exclude compilation and first kernel execution from the steady window.
  await page.evaluate(()=>setSourceFps(60));
  await page.waitForTimeout(500);
  const neural=await measure(),overload=await page.evaluate(()=>{
   const samples=budgetTest.completed.slice().sort((a,b)=>a-b),fi=snapshot().fi;
   return {calls:budgetTest.calls,completed:{count:samples.length,p50:samples[Math.floor(samples.length*.5)],p95:samples[Math.floor(samples.length*.95)]},
    diagnostics:fiGpuEngine.diagnostics,lastRun:fiGpuEngine.lastRun,afterDeadline:budgetTest.afterDeadline,
    mids:budgetTest.mids,sourceFps:fi.videoFps,displayHz:fi.displayHz,reason:fi.explain};});
  console.log(JSON.stringify({ref:ref||'current',multiplier,profile,spatial,neural,overload},null,2));
  if(!ref){
   assert.ok(spatial.fps>=50,'fixture must sustain source playback before FI');
   assert.ok(neural.fps>=spatial.fps*.9,'neural overload must preserve at least 90% of spatial-only source FPS');
   assert.ok(neural.maxGapMs<60,'neural overload cannot hold a source frame for several intervals');
   if(multiplier>1)assert.ok(overload.diagnostics.deadlinePairs>0,'actual GPU overload exercises deadline cancellation');
   if(multiplier===1&&profile==='balanced')assert.ok(overload.mids>0,'a feasible 60 FPS workload must still generate neural frames');
   assert.equal(overload.afterDeadline,0,'expired work submits no further GPU dispatches');
   const before=await page.evaluate(async()=>{budgetTest.multiplier=1;await setSourceFps(24);return budgetTest.mids;});
   await page.waitForFunction(before=>budgetTest.mids>before,before,{timeout:20000});
   assert.ok(await page.evaluate(()=>fiGpuEngine.stats.completed>0),'fast work resumes without toggling FI');
   console.log('PASS: real GPU overload preserves 60 FPS source playback, stops expired work and recovers neural midpoints on a subsequent feasible source');
  }
  assert.equal(await page.evaluate(()=>gl.getError()),0);assert.deepEqual(errors,[]);
 }finally{await browser?.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
