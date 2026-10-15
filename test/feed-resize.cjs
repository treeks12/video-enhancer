// Real-browser IFRNet regression and optional before/after measurement.
// NODE_PATH must include Playwright. BASELINE_REF=71b4cdd runs the previous code.
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const cp=require('node:child_process'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),ref=process.env.BASELINE_REF||'';
const hd=process.env.FEED_HD==='1';
if(ref&&!/^[a-f0-9]{7,40}$/.test(ref))throw new Error('BASELINE_REF must be a commit hash');
const scripts=['feed-session.js','fi-quality.js','fi-core.js','fi-analytic.js','fi-webgpu.js',
 'neural/model-spec.js','neural/graph.js','neural/runtime.js','neural/client.js','content.js'];
const code=name=>ref?cp.execFileSync('git',['show',ref+':'+name],{cwd:root,encoding:'utf8'}):fs.readFileSync(path.join(root,name),'utf8');
(async()=>{
 const server=http.createServer((req,res)=>{
  if(req.url==='/models/ifrnet.bin'){const data=fs.readFileSync(path.join(root,'models/ifrnet.bin'));res.setHeader('Content-Type','application/octet-stream');res.setHeader('Content-Length',data.length);res.end(data);return;}
  res.setHeader('Content-Type','text/html');res.end('<!doctype html><div id="player" style="position:relative"><video muted autoplay></video></div>');
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
 try{
  browser=await chromium.launch({channel:process.env.TEST_BROWSER||'msedge',headless:true,args:['--autoplay-policy=no-user-gesture-required']});
  const page=await browser.newPage({viewport:{width:900,height:700}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.evaluate(()=>{
   window.chrome={runtime:{getURL:p=>location.origin+'/'+p,sendMessage:async()=>({ok:true,installed:false}),onMessage:{addListener(){}}},
    storage:{onChanged:{addListener(){}},local:{get:async d=>({...d,mode:'rcas',strength:35,fiEngine:'ifrnet',fiInfra:true,interaction:'quality'})}}};
   window.testState={frames:[],creates:0,decodes:0,inferences:[],midpoints:0};
   window.video=document.querySelector('video');window.player=document.getElementById('player');
   window.switchSource=async(w,h,replace=false)=>{
    if(window.paintTimer)clearInterval(paintTimer);
    for(const track of video.srcObject?.getTracks()||[])track.stop();
    if(replace){const next=document.createElement('video');next.muted=true;next.autoplay=true;video.replaceWith(next);
     // A queued layout callback can run after removal but before rescan selects next.
     if(window.checkDetachedLayout){layoutDirty=true;syncLayout();}video=next;}
    const src=document.createElement('canvas');src.width=w;src.height=h;
    const ctx=src.getContext('2d');let frame=0;
    const paint=()=>{ctx.fillStyle='#224477';ctx.fillRect(0,0,w,h);ctx.fillStyle='#eecc55';ctx.fillRect((frame++*2)%(w-12),h/4,12,h/2);};paint();
    const scale=Math.min(2,384/Math.max(w,h));
    video.style.cssText=`width:${w*scale}px;height:${h*scale}px`;player.style.width=w*scale+'px';player.style.height=h*scale+'px';
    video.srcObject=src.captureStream(30);window.paintTimer=setInterval(paint,1000/30);await video.play();
   };
  });
  for(const name of scripts.slice(0,-1))await page.addScriptTag({content:code(name)});
  const fetchedModel=await page.evaluate(async()=>{const response=await fetch(chrome.runtime.getURL('models/ifrnet.bin'));const data=await response.arrayBuffer();return {url:response.url,status:response.status,headers:[...response.headers],bytes:data.byteLength};});
  assert.equal(fetchedModel.bytes,5921992,'browser receives the complete bundled model');
  await page.evaluate(()=>{
   const create=VENeuralRuntime.create.bind(VENeuralRuntime);VENeuralRuntime.create=(...args)=>{
    testState.creates++;return create(...args).then(engine=>{
     const estimate=engine.estimate.bind(engine);engine.estimate=(...a)=>estimate(...a).then(result=>{
      if(result?.valid)testState.inferences.push(result.elapsedMs);return result;
     });return engine;
    });
   };
   const decode=VENeuralSpec.decodeWeights;VENeuralSpec.decodeWeights=(...args)=>{testState.decodes++;return decode(...args);};
  });
  await page.evaluate(hd=>switchSource(...(hd?[1280,720]:[96,64])),hd);await page.addScriptTag({content:code('content.js')});
  await page.evaluate(()=>{
   const original=draw;draw=function(options={}){const mids=metricWindow?.midDrawn||0;original(options);if(options.newVideoFrame&&status==='ok')testState.frames.push({t:performance.now(),session:feedSessionId,w:currentVideo.videoWidth,h:currentVideo.videoHeight});if(options.fiMid&&(metricWindow?.midDrawn||0)>mids)testState.midpoints++;};
  });
  try{await page.waitForFunction(()=>Boolean(fiNeuralFailure)||(fiGpuState==='ready'&&fiGpuEngine?.kind==='ifrnet'),null,{timeout:40000});
   assert.equal(await page.evaluate(()=>fiNeuralFailure),'','IFRNet must run without fallback');}
  catch(error){console.error(await page.evaluate(()=>snapshot()));throw error;}
  console.log('IFRNet ready',await page.evaluate(()=>({kind:fiGpuEngine.kind,dimensions:fiGpuEngine.dimensions})));
  // Exercise production inference until at least one result completes; this
  // is not the old analytic-only stability test with neural disabled.
  await page.waitForFunction(()=>fiGpuEngine?.stats.completed>0,null,{timeout:20000});
  await page.evaluate(enabled=>{window.checkDetachedLayout=enabled;},!ref);
  if(process.env.FEED_MEASURE==='1'){
   const before=await page.evaluate(()=>({frames:testState.frames.length,mid:testState.midpoints,samples:testState.inferences.length}));
   await new Promise(r=>setTimeout(r,3000));
   console.log('Steady source measurement',await page.evaluate(before=>({sourceFrames:testState.frames.length-before.frames,
    presentedMidpoints:testState.midpoints-before.mid,inferenceMs:testState.inferences.slice(before.samples)}),before));
  }
  const transitions=[];
  const sizes=hd?[[1920,1080,false],[720,1280,false],[1280,720,true],[1080,1920,true],[1920,1080,false],[720,1280,false],[1280,720,true]]:
   [[90,60,false],[64,96,false],[96,64,true],[64,96,true],[96,64,false],[64,96,false],[96,64,true]];
  for(const [w,h,replace]of sizes){
   const begin=await page.evaluate(()=>performance.now());await page.evaluate(({w,h,replace})=>switchSource(w,h,replace),{w,h,replace});
   await page.waitForFunction(({w,h,begin})=>testState.frames.some(f=>f.w===w&&f.h===h&&f.t>begin),{w,h,begin},{timeout:10000});
   const first=await page.evaluate(({w,h,begin})=>testState.frames.find(f=>f.w===w&&f.h===h&&f.t>begin),{w,h,begin});
   await page.waitForFunction(({w,h})=>fiGpuState==='ready'&&fiGpuEngine?.sourceW===w&&fiGpuEngine?.sourceH===h,{w,h},{timeout:30000});
   const readyMs=await page.evaluate(begin=>Math.round(performance.now()-begin),begin);
   transitions.push({size:`${w}x${h}`,firstFrameMs:Math.round(first.t-begin),backendReadyMs:readyMs});
  }
  if(!ref){
   // A -> uncached B -> A while B is still compiling. Real production controller
   // and GPU resources, with one delayed program to make the race deterministic.
   await page.evaluate(async()=>{
    window.retainedEngine=fiGpuEngine;window.programBefore=retainedEngine.program;window.resizeGate=false;
    retainedEngine.program=async function(...args){if(!resizeGate){resizeGate=true;await new Promise(r=>setTimeout(r,120));}return programBefore.apply(this,args);};
    await switchSource(96,96);
   });
   await page.waitForFunction(()=>resizeGate&&fiGpuState==='initializing');
   await page.evaluate(()=>switchSource(96,64));
   await page.waitForFunction(()=>fiGpuState==='ready'&&fiGpuEngine===retainedEngine&&fiGpuEngine.sourceW===96&&fiGpuEngine.sourceH===64);
   await page.evaluate(()=>{retainedEngine.program=programBefore;});
   console.log('PASS: interrupted A -> B -> A resize returns to the retained neural model');
   for(const interaction of ['balanced','smooth']){
    const before=await page.evaluate(interaction=>{applySettings({...settings,interaction});suspendOverlayForInteraction();return feedSessionId;},interaction);
    await page.evaluate(()=>switchSource(64,96));
    await page.waitForFunction(before=>!scrolling&&feedSessionId>before&&fiGpuState==='ready'&&status==='ok'&&canvas.style.visibility==='visible',before);
    await page.evaluate(()=>switchSource(96,64));
   }
   await page.evaluate(()=>applySettings({...settings,interaction:'quality'}));
   await page.waitForFunction(()=>fiGpuState==='ready');
   console.log('PASS: changing resolution during balanced/smooth scrolling resumes current session');
  }
  const result=await page.evaluate(()=>({creates:testState.creates,decodes:testState.decodes,
   frames:testState.frames.length,glError:gl.getError(),status,engine:fiGpuEngine.kind,
   cache:fiGpuEngine.diagnostics||null,memoryBytes:fiGpuEngine.memoryBytes,shapeCount:fiGpuEngine.shapes?.size||0,
   gpu:gl.getParameter(gl.RENDERER)}));
  assert.equal(result.engine,'ifrnet');assert.equal(result.glError,0);assert.deepEqual(errors,[]);
  assert.equal(result.status,'ok');assert.ok(result.frames>10);
  if(!ref){assert.equal(result.creates,1,'source resizing must not reconstruct the whole model');assert.equal(result.decodes,1);
   assert.ok(result.shapeCount<=2);assert.ok(result.memoryBytes<=256*1024*1024);assert.ok(result.cache.shapeHits>=4);}
  console.log(JSON.stringify({mode:ref?'baseline '+ref:'current',hd,transitions,...result},null,2));

  if(!ref){
   // Independent numerical regression: compare the resized dynamic kernels
   // against the previous fixed-shape implementation with the same checkpoint.
   await page.evaluate(()=>{window.ResizeRuntime=VENeuralRuntime;window.ResizeGraph=VENeuralGraph;});
   for(const name of ['neural/graph.js','neural/runtime.js'])await page.addScriptTag({content:cp.execFileSync('git',['show','71b4cdd:'+name],{cwd:root,encoding:'utf8'})});
   await page.evaluate(()=>{window.ReferenceRuntime=VENeuralRuntime;window.VENeuralRuntime=ResizeRuntime;window.VENeuralGraph=ResizeGraph;});
   const pixels=await page.evaluate(async()=>{
    cancelScheduledFrame();resetFiPairState();
    const bytes=await VENeuralClient.load(),rt=fiGpuEngine;
    const make=(w,h,shift)=>{const t=fiMakeTexture(),data=new Uint8Array(w*h*4);
     for(let y=0;y<h;y++)for(let x=0;x<w;x++){const i=(y*w+x)*4;data[i]=Math.min(255,(x+shift)*3);data[i+1]=y*3;data[i+2]=90;data[i+3]=255;}
     gl.bindTexture(gl.TEXTURE_2D,t);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,w,h,0,gl.RGBA,gl.UNSIGNED_BYTE,data);return t;};
    const w=82,h=58,a=make(w,h,0),b=make(w,h,3),out=make(w,h,0);
    await rt.resize(w,h);const reused=await rt.estimate(a,b,100);
    if(!reused?.valid)throw new Error('Reused model did not infer');rt.render(a,b,out,w,h);
    const read=()=>{gl.bindFramebuffer(gl.FRAMEBUFFER,fiCopyFb||=gl.createFramebuffer());gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,out,0);const p=new Uint8Array(w*h*4);gl.readPixels(0,0,w,h,gl.RGBA,gl.UNSIGNED_BYTE,p);gl.bindFramebuffer(gl.FRAMEBUFFER,null);return p;};
    const expected=read(),cold=await ReferenceRuntime.create(gl,bytes,w,h);
    await cold.estimate(a,b,100);cold.render(a,b,out,w,h);const actual=read();let maxDiff=0;
    for(let i=0;i<actual.length;i++)maxDiff=Math.max(maxDiff,Math.abs(actual[i]-expected[i]));
    cold.destroy();for(const t of[a,b,out])gl.deleteTexture(t);
    return {maxDiff,glError:gl.getError()};
   });
   assert.equal(pixels.glError,0);assert.ok(pixels.maxDiff<=1,JSON.stringify(pixels));
   console.log('PASS: real IFRNet GPU pixels agree with previous fixed-shape implementation',pixels);
  }
 }finally{await browser?.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
