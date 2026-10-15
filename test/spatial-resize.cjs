// Real-browser spatial processing isolation: no interpolation or neural model.
// Requires Playwright and a WebGL2 browser. BASELINE_REF accepts a commit hash.
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const cp=require('node:child_process'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),ref=process.env.BASELINE_REF||'';
if(ref&&!/^[a-f0-9]{7,40}$/.test(ref))throw new Error('BASELINE_REF must be a commit hash');
const code=name=>ref?cp.execFileSync('git',['show',ref+':'+name],{cwd:root,encoding:'utf8'}):fs.readFileSync(path.join(root,name),'utf8');
(async()=>{
 const assets=new Set(['/third_party/ravu-lite/ravu-lite-webgl2.js','/third_party/ravu-lite/ravu-lite-lut3.bin']);
 const server=http.createServer((req,res)=>{
  if(assets.has(req.url)){const data=fs.readFileSync(path.join(root,req.url.slice(1)));res.setHeader('Content-Length',data.length);res.end(data);return;}
  res.setHeader('Content-Type','text/html');res.end('<!doctype html><div id="player" style="position:relative"><video muted autoplay></video></div>');
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
 try{
  browser=await chromium.launch({channel:process.env.TEST_BROWSER||'msedge',headless:true,args:['--autoplay-policy=no-user-gesture-required']});
  const results=[];
  for(const mode of ['native','rcas','ravu']){
   const page=await browser.newPage({viewport:{width:1200,height:850},deviceScaleFactor:2}),errors=[];
   page.on('pageerror',e=>errors.push(e.message));await page.goto(`http://127.0.0.1:${server.address().port}`);
   await page.evaluate(mode=>{
    window.chrome={runtime:{getURL:p=>location.origin+'/'+p,onMessage:{addListener(){}}},
     storage:{onChanged:{addListener(){}},local:{get:async d=>({...d,mode,strength:35,fiInfra:false,quality:'high',interaction:'quality'})}}};
    window.video=document.querySelector('video');window.player=document.getElementById('player');
    window.spatial={frames:[],gpu:[],raf:[],allocations:[],serial:0};
    let last=0;function tick(t){if(last)spatial.raf.push({t,gap:t-last});last=t;requestAnimationFrame(tick);}requestAnimationFrame(tick);
    window.switchSource=async(w,h)=>{
     if(window.paintTimer)clearInterval(paintTimer);
     for(const track of video.srcObject?.getTracks()||[])track.stop();
     const src=document.createElement('canvas');src.width=w;src.height=h;const ctx=src.getContext('2d');let frame=0;
     const paint=()=>{ctx.fillStyle='#224477';ctx.fillRect(0,0,w,h);ctx.fillStyle='#eecc55';ctx.fillRect((frame++*11)%(w-50),h/4,50,h/2);};paint();
     const cssScale=Math.min(960/w,720/h);video.style.cssText=`width:${w*cssScale}px;height:${h*cssScale}px`;player.style.width=w*cssScale+'px';
     spatial.serial++;video.srcObject=src.captureStream(30);window.paintTimer=setInterval(paint,1000/30);await video.play();
    };
   },mode);
   await page.evaluate(()=>switchSource(1280,720));
   for(const name of ['feed-session.js','fi-quality.js','fi-core.js','content.js'])await page.addScriptTag({content:code(name)});
   await page.waitForFunction(()=>status==='ok'&&canvas.width>0);
   await page.evaluate(()=>{
    gpuTimingUntil=performance.now()+60000;
    const upload=gl.texImage2D.bind(gl);gl.texImage2D=function(...args){spatial.allocations.push({t:performance.now(),serial:spatial.serial,w:args[3],h:args[4]});return upload(...args);};
    const original=draw;let lastSerial=-1;
    draw=function(options={}){
     const start=performance.now();original(options);
     if(spatial.checkPaused&&status==='ok'){
      const pixel=new Uint8Array(4);gl.readPixels(Math.floor(canvas.width/2),Math.floor(canvas.height/2),1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);
      spatial.pausedPixel=Array.from(pixel);
     }
     if(status!=='ok'||!options.newVideoFrame)return;
     const serial=spatial.serial,first=serial!==lastSerial;lastSerial=serial;
     spatial.frames.push({t:performance.now(),submitMs:performance.now()-start,serial,w:currentVideo.videoWidth,h:currentVideo.videoHeight});
     if(first){const sync=gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE,0);gl.flush();
      const poll=()=>{const s=gl.clientWaitSync(sync,0,0);if(s===gl.TIMEOUT_EXPIRED){setTimeout(poll,1);return;}
       spatial.gpu.push({serial,ms:performance.now()-start,failed:s===gl.WAIT_FAILED});gl.deleteSync(sync);};setTimeout(poll,0);}
    };
   });
   await page.waitForFunction(()=>spatial.frames.length>=35);
   const transitions=[];
   for(const [w,h]of [[1920,1080],[720,1280],[1280,720],[1080,1920],[640,360],[720,1280],[1280,720]]){
    const begin=await page.evaluate(()=>performance.now());await page.evaluate(([w,h])=>switchSource(w,h),[w,h]);
    await page.waitForFunction(({w,h,begin})=>spatial.frames.some(f=>f.w===w&&f.h===h&&f.t>begin),{w,h,begin},{timeout:20000});
    await page.waitForFunction(()=>spatial.gpu.some(g=>g.serial===spatial.serial),null,{timeout:20000});
    await page.waitForFunction(()=>spatial.frames.filter(f=>f.serial===spatial.serial).length>=10);
    transitions.push(await page.evaluate(begin=>{
     const frames=spatial.frames.filter(f=>f.serial===spatial.serial),first=frames[0],gpu=spatial.gpu.find(g=>g.serial===spatial.serial);
     const raf=spatial.raf.filter(f=>f.t>begin);return {size:`${video.videoWidth}x${video.videoHeight}`,firstFrameMs:Math.round(first.t-begin),
      firstSubmitMs:+first.submitMs.toFixed(2),gpuCompleteMs:Math.round(gpu.ms),maxRafGapMs:Math.round(Math.max(...raf.map(f=>f.gap))),
      allocations:spatial.allocations.filter(a=>a.serial===spatial.serial).length,pipeline:activePipeline};
    },begin));
   }
   const metrics=await page.evaluate(()=>({status,glError:gl.getError(),neural:fiGpuEngine?.kind||'none',metrics:snapshot().metrics}));
   assert.equal(metrics.status,'ok');assert.equal(metrics.glError,0);assert.equal(metrics.neural,'none');assert.deepEqual(errors,[]);
   const expected=mode==='native'?'Native':mode==='ravu'?'RAVU-lite':'RCAS';assert.ok(transitions.every(t=>t.pipeline.includes(expected)),JSON.stringify(transitions));
   if(mode==='rcas')assert.ok(transitions.some(t=>t.pipeline.includes('EASU')),'FSR1 upscaling was exercised');
   await page.evaluate(()=>video.pause());
   await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
   const oldWidth=await page.evaluate(()=>{spatial.checkPaused=true;video.style.width='700px';video.style.height='393.75px';player.style.width='700px';return canvas.width;});
   await page.waitForFunction(oldWidth=>canvas.width!==oldWidth,oldWidth);
   const paused=await page.evaluate(()=>spatial.pausedPixel||null);
   if(!ref){
    assert.ok(paused&&paused.slice(0,3).some(v=>v>0),`paused ${mode} canvas must repaint after layout-only resize: ${paused}`);
    assert.ok(transitions.slice(-2).every(t=>t.allocations===0),'warm spatial shapes must not redefine texture storage');
   }
   results.push({mode,transitions,pausedPixel:paused,metrics});await page.close();
  }
  console.log(JSON.stringify({ref:ref||'current',results},null,2));
  console.log('PASS: HD portrait/landscape spatial processing without interpolation or GL errors');
 }finally{await browser?.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
