'use strict';
// Native CSS visibility regression. This test selects DOM elements only: it
// does not decode videos, initialize the renderer, or execute neural shaders.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const puppeteer=require('puppeteer-core');
const kind=process.env.TEST_BROWSER||'firefox';assert.ok(['firefox','chromium'].includes(kind));
const source=fs.readFileSync(path.join(__dirname,'../content.js'),'utf8');
const extract=name=>{const a=source.indexOf('function '+name+'('),b=source.indexOf('\nfunction ',a+1);
 assert.ok(a>=0&&b>a,name);return source.slice(a,b);};
(async()=>{
 let browser;
 try{
  browser=await puppeteer.launch({browser:kind==='firefox'?'firefox':'chrome',headless:true,
   executablePath:kind==='firefox'?(process.env.FIREFOX_PATH||'C:/Program Files/Mozilla Firefox/firefox.exe'):
    (process.env.CHROMIUM_PATH||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'),
   defaultViewport:{width:1100,height:750},timeout:30000});
  const page=await browser.newPage();await page.goto('about:blank');
  await page.addScriptTag({content:['visibleArea','playingWeight','pickLargestVideo'].map(extract).join('\n')});
  const results=await page.evaluate(()=>{
   document.body.style.margin='0';
   const visible=document.createElement('video');visible.id='visible';
   visible.style.cssText='position:fixed;left:0;top:0;width:600px;height:340px';document.body.append(visible);
   const wrapper=document.createElement('div'),hidden=document.createElement('video');hidden.id='hidden';
   wrapper.style.cssText='position:fixed;left:0;top:0;width:1000px;height:700px';
   hidden.style.cssText='width:100%;height:100%';wrapper.append(hidden);document.body.append(wrapper);
   const rows=[],test=(name,expected='visible')=>rows.push({name,expected,
    actual:pickLargestVideo(document.querySelectorAll('video'),innerWidth,innerHeight)?.id||null,
    nativeHiddenVisible:hidden.checkVisibility?.({visibilityProperty:true,opacityProperty:true})??null});
   wrapper.style.visibility='hidden';test('hidden ancestor');
   wrapper.style.visibility='';hidden.style.visibility='hidden';test('hidden video');
   hidden.style.visibility='';wrapper.style.opacity='0';test('transparent ancestor');
   wrapper.style.opacity='';hidden.style.opacity='0';test('transparent video');
   hidden.style.opacity='';wrapper.style.display='none';test('display none');
   wrapper.style.display='';wrapper.style.top='900px';test('outside viewport');
   wrapper.style.top='650px';test('partially visible smaller area');
   wrapper.style.top='0';test('visible larger candidate','hidden');
   wrapper.style.visibility='hidden';
   Object.defineProperty(hidden,'checkVisibility',{value:undefined,configurable:true});test('CSS visibility fallback');
   wrapper.style.visibility='';hidden.style.opacity='0';test('CSS opacity fallback');
   hidden.style.opacity='';visible.style.visibility='hidden';hidden.style.visibility='hidden';test('all hidden',null);
   return rows;
  });
  console.log(JSON.stringify({browser:await browser.version(),results},null,2));
  for(const row of results)assert.equal(row.actual,row.expected,row.name);
 }finally{await browser?.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
