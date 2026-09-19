// Verify WebGPU is available in a content-script-like isolated world, without flags.
const { chromium } = require('playwright');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
(async()=>{
  const server=http.createServer((req,res)=>res.end('<!doctype html><body></body>'));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let browser;
  try {
    browser=await chromium.launch({channel:'msedge',headless:true});
    const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.address().port}`);
    const cdp=await page.context().newCDPSession(page);
    const {frameTree}=await cdp.send('Page.getFrameTree');
    const {executionContextId}=await cdp.send('Page.createIsolatedWorld',{
      frameId:frameTree.frame.id,worldName:'fv-webgpu-test',grantUniveralAccess:false});
    const source=fs.readFileSync(path.join(__dirname,'..','fi-webgpu.js'),'utf8');
    const result=await cdp.send('Runtime.evaluate',{contextId:executionContextId,returnByValue:true,awaitPromise:true,
      expression:source+`; (async()=>{const engine=await FiWebGpu.create();try {
        const a=new Float32Array(64*64).fill(90);const r=await engine.estimate(a,a,64,64);
        return {secure:isSecureContext,confidence:r.forward.confidence,motion:r.forward.mvs.every(v=>Math.abs(v)<.01)};
      } finally {engine.destroy();}})()`});
    assert.equal(result.exceptionDetails,undefined,JSON.stringify(result.exceptionDetails));
    assert.equal(result.result.value.secure,true);assert.equal(result.result.value.motion,true);
    console.log('PASS: WebGPU compute in isolated world without browser flags',result.result.value);
  } finally {if(browser)await browser.close();server.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
