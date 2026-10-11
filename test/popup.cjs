const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const { pathToFileURL } = require("node:url");
const path = require("node:path");

const popup = path.resolve(__dirname,"..","popup.html");
const screenshot = path.resolve(__dirname,"popup-preview.png");

function state(overrides = {}) {
  const base = {
    status:"ok",hasVideo:true,visible:true,pipeline:"Native",canvasWidth:1920,canvasHeight:1080,
    settings:{mode:"off",strength:35,quality:"auto",interaction:"balanced",outline:false,compare:false,fiInfra:false,fiSceneCut:true,fiHalfLuma:true,fiBlockMatch:true},
    metrics:{videoFps:30,fps:30,midFps:29.7,renderScale:1,missed:0,missedPct:0,videoDropped:0,videoDroppedPct:0,latePct:0,cpuMs:.5,gpuMs:.7,gpuSupported:true,decoderMs:1.2},
    fi:{backend:"WebGPU optical flow",computeMs:4.8,presentationDelayMs:33.3,confidence:.74,hasPair:true,sceneCutHold:0,sample:"adaptive 320×180",realPerSec:30,midPerSec:29.7},
  };
  return {...base,...overrides,settings:{...base.settings,...overrides.settings},metrics:{...base.metrics,...overrides.metrics},fi:{...base.fi,...overrides.fi}};
}

(async()=>{
  const browser = await chromium.launch({headless:true,channel:"msedge"});
  const page = await browser.newPage({viewport:{width:430,height:760},deviceScaleFactor:1});
  await page.addInitScript((initial)=>{
    window.__mockState=initial; window.__writes=[]; window.__messages=[];
    globalThis.chrome={
      runtime:{getManifest:()=>({version:"0.0.60"})},
      storage:{local:{set:async patch=>{window.__writes.push(structuredClone(patch));Object.assign(window.__mockState.settings,patch)}}},
      tabs:{query:async()=>[{id:7}],reload:async()=>{},sendMessage:async(_id,message)=>{
        window.__messages.push(structuredClone(message));
        if(message.type==="fv-settings")Object.assign(window.__mockState.settings,message.settings);
        return structuredClone(window.__mockState);
      }},
    };
  },state());
  await page.goto(pathToFileURL(popup).href);
  await page.waitForSelector("#fiInfra:not([disabled])");

  assert.equal(await page.locator("#advanced").getAttribute("open"),null,"diagnostics start collapsed");
  await page.locator(".switch .track").click();
  await page.waitForFunction(()=>window.__writes.length>0);
  const enableWrite=await page.evaluate(()=>window.__writes.at(-1));
  assert.deepEqual(enableWrite,{fiInfra:true,mode:"native"},"enabling FI also starts the native pipeline");
  assert.equal(await page.locator('[data-mode="native"]').getAttribute("aria-pressed"),"true");

  await page.evaluate(()=>{window.__mockState.settings.strength=20});
  await page.locator('[data-mode="rcas"]').click();
  const slider=page.locator("#strength");
  await slider.dispatchEvent("pointerdown");
  await slider.evaluate(el=>{el.value="88";el.dispatchEvent(new Event("input",{bubbles:true}))});
  await page.evaluate(()=>{window.__mockState.settings.strength=20});
  await page.waitForTimeout(1150);
  assert.equal(await slider.inputValue(),"88","status polling does not overwrite an active slider edit");
  await slider.dispatchEvent("pointerup");

  await page.evaluate(()=>{window.__mockState.fi={backend:"failed",backendError:"No WebGPU adapter",hasPair:false};window.__mockState.settings.fiInfra=true});
  await page.waitForTimeout(1100);
  assert.equal(await page.locator("#fiStatusTitle").textContent(),"Motion backend unavailable");
  assert.equal(await page.locator("#fiStatus").getAttribute("data-tone"),"error");

  await page.evaluate(()=>{window.__mockState.fi={backend:"WebGPU optical flow",computeMs:4.8,presentationDelayMs:33.3,confidence:.74,hasPair:true,sceneCutHold:0,sample:"adaptive 320×180",realPerSec:30,midPerSec:29.7};window.__mockState.settings.mode="native"});
  await page.waitForTimeout(1100);
  assert.equal(await page.locator("#fiStatusTitle").textContent(),"Interpolation active");
  await page.locator("body").screenshot({path:screenshot});
  await page.evaluate(()=>{window.__mockState.settings.fiBlockMatch=false});
  await page.waitForTimeout(1100);
  assert.equal(await page.locator("#fiStatusTitle").textContent(),"Interpolation paused");
  await page.evaluate(()=>{window.__mockState.settings.fiBlockMatch=true;window.__mockState.visible=false});
  await page.waitForTimeout(1100);
  assert.equal(await page.locator("#fiStatusTitle").textContent(),"Interpolation paused");
  console.log(`popup tests passed; screenshot: ${screenshot}`);
  await browser.close();
})().catch(error=>{console.error(error);process.exitCode=1});

