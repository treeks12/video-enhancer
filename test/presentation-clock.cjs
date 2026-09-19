// Real WebGL pixels + deterministic GPU completions: missed interpolation must
// not switch from delayed anchor to current frame and back to delayed playback.
const {chromium}=require('playwright');
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const assert=require('node:assert/strict');
(async()=>{
  const server=http.createServer((req,res)=>res.end('<!doctype html><div id="player" style="position:relative;width:64px;height:64px"></div>'));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let browser;
  try {
    browser=await chromium.launch({channel:'msedge',headless:true});
    const page=await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(()=>{
      window.chrome={runtime:{onMessage:{addListener(){}}},storage:{onChanged:{addListener(){}},local:{get:async defaults=>({...defaults,mode:'off'})}}};
    });
    for(const name of ['fi-core.js','content.js'])await page.addScriptTag({content:fs.readFileSync(path.join(__dirname,'..',name),'utf8')});
    const results=await page.evaluate(async()=>{
      const source=document.createElement('canvas');source.width=source.height=64;
      document.querySelector('#player').append(source);
      Object.assign(source,{videoWidth:64,videoHeight:64,readyState:4,paused:false,ended:false,playbackRate:1});
      const ctx=source.getContext('2d');
      currentVideo=source;settings=normalizeSettings({mode:'native',fiInfra:true,interaction:'quality'});
      fiWarmGpu=()=>{};
      fiGpuState='ready';
      let resolveFlow;
      fiGpuEngine={lost:false,estimate:()=>new Promise(resolve=>{resolveFlow=resolve}),destroy(){}};
      createOverlay();attachCanvasTo(source);
      lastVideoFrameDurationMs=1000/30;fiDisplayPeriod=1000/60;
      const pixels=[];
      const read=()=>{const p=new Uint8Array(4);gl.readPixels(32,32,1,1,gl.RGBA,gl.UNSIGNED_BYTE,p);return p[0];};
      const capture=n=>{
        ctx.fillStyle=`rgb(${n*20},${n*20},${n*20})`;ctx.fillRect(0,0,64,64);
        layoutDirty=true;draw({newVideoFrame:true});cancelFiMid();pixels.push(read());
      };
      const finish=async confidence=>{
        const count=32*32;
        const match=()=>({gridW:32,gridH:32,block:2,mvs:new Float32Array(count*2),confidences:new Float32Array(count).fill(confidence),confidence,meanResidual:0});
        resolveFlow({forward:match(),backward:match()});
        await new Promise(resolve=>setTimeout(resolve,0));
      };
      capture(1); // first available frame
      capture(2); // show frame 1, calculate 1->2
      await finish(.15); // low confidence no longer discards the complete pair
      const lowConfidence=fiMethod;
      draw({fiMid:true,fiPhase:.5}); // may hold locally, but never jump timeline
      pixels.push(read());
      capture(3); // show 2, calculation stays pending
      capture(4); // GPU busy: must show 3, never jump to 4
      await finish(1); // stale result from 2->3 cannot change visible frame
      const afterStale=read();
      capture(5); // show 4, resumes interpolation
      // Deliberately use unrelated scenes: protection must hold delayed frame.
      await finish(1);
      fiPairDiscontinuous=true;
      capture(6); // callback gap: show 5; no resetting to current 6
      fiPairDiscontinuous=false;
      const delayed=fiLatencyActive;
      return {pixels,afterStale,delayed,lowConfidence,error:gl.getError()};
    });
    assert.deepEqual(results.pixels,[20,20,20,40,60,80,100]);
    assert.equal(results.afterStale,60);
    assert.equal(results.delayed,true);
    assert.equal(results.lowConfidence,'webgpu');
    assert.equal(results.error,0);
    console.log('PASS: monotonic delayed presentation pixels across low confidence, busy GPU and missed callbacks',results.pixels);
  }finally{if(browser)await browser.close();server.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
