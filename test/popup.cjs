'use strict';

const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const {pathToFileURL} = require('node:url');
const path = require('node:path');
const fs = require('node:fs');
const popup = path.resolve(__dirname,'..','popup.html');
const output = process.env.POPUP_OUTPUT || path.join(require('node:os').tmpdir(),'video-enhancer-popup-review');
fs.mkdirSync(output,{recursive:true});

function state(overrides = {}) {
  const base = {
    status:'ok',hasVideo:true,hasVisibleVideo:true,videoInViewport:true,canRender:true,
    videoPaused:false,videoEnded:false,visible:true,pipeline:'Original',canvasWidth:1920,canvasHeight:1080,
    settings:{mode:'off',strength:100,quality:'high',interaction:'smooth',outline:false,compare:false,
      protectNoise:false,fiInfra:false,fiEngine:'ifrnet',fiProfile:'balanced',fiDebug:0,
      fiSceneCut:true,fiHalfLuma:true,fiBlockMatch:true},
    metrics:{videoFps:30,fps:30,midFps:29.7,renderScale:1,missed:0,missedPct:0,
      videoDropped:0,videoDroppedPct:0,latePct:0,cpuMs:.5,gpuMs:.7,gpuSupported:true,decoderMs:1.2},
    fi:{backend:'IFRNet-S neural',computeMs:4.8,presentationDelayMs:33.3,confidence:null,
      hasPair:true,sceneCutHold:0,sample:'320×180',realPerSec:30,midPerSec:29.7,presentationBackend:'webgpu'},
  };
  return {...base,...overrides,settings:{...base.settings,...overrides.settings},
    metrics:{...base.metrics,...overrides.metrics},fi:{...base.fi,...overrides.fi}};
}

(async()=>{
  const browser = await chromium.launch({
    headless:true,args:['--no-sandbox'],
    ...(process.env.CHROMIUM_PATH ? {executablePath:process.env.CHROMIUM_PATH} : {channel:process.env.CHROMIUM_CHANNEL || 'msedge'}),
  });
  try {
    const page = await browser.newPage({viewport:{width:392,height:760},deviceScaleFactor:1,acceptDownloads:true});
    const errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.addInitScript(initial=>{
      window.__mockState=initial;window.__writes=[];window.__messages=[];
      globalThis.chrome={
        runtime:{getManifest:()=>({version:'0.0.72'}),getURL:path=>'https://fixture.invalid/'+path,
          sendMessage:async()=>({ok:true,bundled:true}),openOptionsPage:async()=>{window.__openedOptions=true;}},
        storage:{local:{get:async()=>({fvNeuralModelV1:true}),set:async patch=>{
          window.__writes.push(structuredClone(patch));
          Object.assign(window.__mockState.settings,patch);
        }}},
        tabs:{query:async()=>[{id:7}],reload:async()=>{},sendMessage:async(_id,message)=>{
          window.__messages.push(structuredClone(message));
          if(message.type==='fv-settings')Object.assign(window.__mockState.settings,message.settings);
          if(message.type==='fv-toggle')window.__mockState.visible=!window.__mockState.visible;
          return structuredClone(window.__mockState);
        }},
      };
    },state());
    await page.goto(pathToFileURL(popup).href);
    await page.waitForSelector('#fiInfra:not([disabled])');
    assert.equal(await page.locator('#advanced').getAttribute('open'),null,'Advanced starts collapsed');
    assert.equal(await page.locator('#saveDiagnostics').isVisible(),false,'diagnostic export is inside Advanced');
    assert.equal(await page.locator('#fiEngine').isVisible(),false,'secondary engine control is inside Advanced');
    assert.equal(await page.locator('#strength').inputValue(),'100','existing strength default is preserved');
    assert.equal(await page.locator('#label').textContent(),'Disabled');
    assert.equal(await page.getByRole('checkbox',{name:'Enable frame interpolation'}).count(),1,'motion switch has an accessible name');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),392,'collapsed popup has no horizontal overflow');
    const collapsedHeight=await page.locator('body').evaluate(element=>element.getBoundingClientRect().height);
    assert.ok(collapsedHeight<=600,'normal collapsed popup fits a 600px extension window: '+collapsedHeight);
    await page.locator('body').screenshot({path:path.join(output,'popup-disabled.png')});

    await page.getByRole('checkbox',{name:'Enable frame interpolation'}).check();
    await page.waitForFunction(()=>window.__writes.length>0);
    assert.deepEqual(await page.evaluate(()=>window.__writes.at(-1)),{fiInfra:true,mode:'native'});
    await page.waitForFunction(()=>document.querySelector('[data-mode="native"]').getAttribute('aria-pressed')==='true');
    await page.locator('[data-mode="rcas"]').click();
    await page.locator('#advanced summary').click();
    assert.equal(await page.locator('#fiEngine').inputValue(),'ifrnet');
    assert.equal(await page.locator('#protectNoise').isChecked(),false);
    await page.getByRole('checkbox',{name:'Reduce noise sharpening'}).check();
    await page.waitForFunction(()=>window.__mockState.settings.protectNoise===true);
    assert.deepEqual(await page.evaluate(()=>window.__writes.at(-1)),{protectNoise:true});
    await page.locator('#fiProfile').selectOption('quality');
    await page.waitForFunction(()=>window.__mockState.settings.fiProfile==='quality');
    await page.locator('#modelSetup').click();
    assert.equal(await page.evaluate(()=>window.__openedOptions),true);

    const slider=page.locator('#strength');
    await slider.dispatchEvent('pointerdown');
    await slider.evaluate(element=>{element.value='88';element.dispatchEvent(new Event('input',{bubbles:true}));});
    await page.evaluate(()=>{window.__mockState.settings.strength=20;});
    await page.waitForTimeout(1100);
    assert.equal(await slider.inputValue(),'88','status polling preserves the active slider edit');
    await slider.dispatchEvent('pointerup');
    await page.waitForFunction(()=>window.__writes.at(-1)?.strength===88);
    await slider.focus();
    await page.keyboard.press('ArrowLeft');
    await page.waitForFunction(()=>window.__writes.at(-1)?.strength===87);
    assert.equal(await slider.getAttribute('aria-valuetext'),'87%','keyboard value is announced');

    await page.evaluate(()=>{window.__mockState.fi={backend:'failed',backendError:'No WebGPU adapter',hasPair:false};});
    await page.waitForFunction(()=>document.querySelector('#fiStatusTitle').textContent==='Motion backend unavailable');
    assert.equal(await page.locator('#fiStatus').getAttribute('data-tone'),'error');
    await page.evaluate(()=>{
      window.__mockState.fi={backend:'IFRNet-S neural',computeMs:4.8,presentationDelayMs:33.3,confidence:null,
        hasPair:true,sceneCutHold:0,sample:'320×180',realPerSec:30,midPerSec:29.7,presentationBackend:'webgpu'};
      window.__mockState.settings.mode='ravu';
    });
    await page.waitForFunction(()=>document.querySelector('#fiStatusTitle').textContent==='Interpolation active');
    assert.equal(await page.locator('#sourceFps').textContent(),'30.0 fps');
    assert.equal(await page.locator('#fiRates').textContent(),'30.0 / 29.7 per s');
    assert.equal(await page.locator('#fps').textContent(),'59.7 frames/s');
    assert.equal(await page.locator('#fiConfidence').textContent(),'—');
    await page.locator('body').screenshot({path:path.join(output,'popup-advanced.png')});
    await page.locator('#advanced summary').click();
    await page.locator('body').screenshot({path:path.join(output,'popup-active.png')});
    const activeHeight=await page.locator('body').evaluate(element=>element.getBoundingClientRect().height);
    assert.ok(activeHeight<=600,'active collapsed popup fits a 600px extension window: '+activeHeight);

    await page.evaluate(()=>{window.__mockState.fi={backend:'IFRNet-S neural (WebGL2)',actualEngine:'ifrnet',computeMs:117,
      frameIntervalMs:16.667,midPerSec:0,hasPair:true,explain:'Waiting for adjacent video frames after a source change or gap.'};});
    await page.waitForFunction(()=>document.querySelector('#fiStatusTitle').textContent==='Neural inference is behind playback');
    await page.evaluate(()=>{window.__mockState.fi.neural={lastRun:{reason:'deadline',completed:false,elapsedMs:14,ageMs:100}};});
    await page.waitForFunction(()=>document.querySelector('#fiStatusTitle').textContent==='Neural work exceeded the frame budget');
    assert.match(await page.locator('#fiStatusDetail').textContent(),/preserve source playback/);
    assert.equal(await page.locator('#fiCompute').textContent(),'117.0 ms');
    await page.evaluate(()=>{window.__mockState.fi.neural.lastRun.reason='obsolete';});
    await page.waitForFunction(()=>document.querySelector('#fiStatusTitle').textContent==='Neural inference is behind playback');
    await page.evaluate(()=>{window.__mockState.fi.neural.deadlineAgeMs=100;});
    await page.waitForFunction(()=>document.querySelector('#fiStatusTitle').textContent==='Neural work exceeded the frame budget');
    await page.evaluate(()=>{window.__mockState.settings.fiBlockMatch=false;window.__mockState.fi.fallbackReason='Old fallback';});
    await page.waitForFunction(()=>document.querySelector('#fiStatusTitle').textContent==='Interpolation paused');
    await page.evaluate(()=>{window.__mockState.settings.fiBlockMatch=true;window.__mockState.videoPaused=true;});
    await page.waitForFunction(()=>document.querySelector('#fiStatusTitle').textContent==='Video paused');
    assert.equal(await page.locator('#fps').textContent(),'—','paused rates do not pretend to be live');
    await page.evaluate(()=>{window.__mockState.videoPaused=false;window.__mockState.visible=false;});
    await page.waitForFunction(()=>document.querySelector('#fiStatusTitle').textContent==='Interpolation paused');
    assert.equal(await page.locator('#label').textContent(),'Hidden');

    await page.locator('#advanced summary').click();
    const download=page.waitForEvent('download');
    await page.locator('#saveDiagnostics').click();
    const exported=await download;
    assert.equal(exported.suggestedFilename(),'video-enhancer-diagnostics.json');
    await page.waitForFunction(()=>document.querySelector('#feedback').textContent==='Diagnostics saved.');
    await page.setViewportSize({width:320,height:760});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),320,'narrow Advanced view has no horizontal overflow');
    await page.locator('body').screenshot({path:path.join(output,'popup-narrow.png')});
    assert.deepEqual(errors,[],'popup has no unhandled browser errors');
    console.log(JSON.stringify({result:'PASS',browser:await browser.version(),headless:true,
      fixture:'Synthetic popup status and extension APIs; no video, GPU speed or live-site validation',
      collapsedHeight,activeHeight,output,
      checks:['compact collapsed layout','320px Advanced layout','accessible switch and keyboard slider',
        'IFRNet-S/defaults preserved','noise guard persistence','profile and Personal setup','separate source/mid/output rates',
        'startup/failure/budget/pause/hidden states','diagnostic download','no page errors']},null,2));
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
