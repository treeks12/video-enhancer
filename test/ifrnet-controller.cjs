// Real controller functions: slot failures, in-flight ownership and late accounting.
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../content.js'),'utf8'),start=source.indexOf('function fiRequestIfrPair('),end=source.indexOf('\nfunction ',start+1);
const ctx=vm.createContext({FiQuality:require('../fi-quality.js')});
vm.runInContext(`
 let now=1000;const performance={now:()=>now};
 let currentVideo={playbackRate:1},feedSessionId=1,fiPairSerial=1,fiPairAnchorTime=1000;
 let fiHasPrev=true,fiPairDiscontinuous=false,fiGpuBusy=false,fiDisplayPeriod=1000/60,fiDisplayReference=1000;
 let fiNeuralResult=null,fiNeuralTarget=null,fiMethod='skip',fiGpuElapsedMs=0,fiGpuReadySerial=-1,fiSkipReason='';
 let lastVideoFrameDurationMs=1000/24,metricReport={videoFps:24},settings={fiInfra:true,fiBlockMatch:true,fiSceneCut:true};
 const fiPrevTexture={},fiCurrTexture={},jobs=[];
 const fiGpuEngine={stats:{ms:0,completed:0,late:0},estimate:()=>new Promise(resolve=>jobs.push(resolve))};
 const isCurrentFeedSession=(v,id)=>v===currentVideo&&id===feedSessionId,canRender=()=>true;
 const fiUseClassicFallback=()=>{throw new Error('Unexpected fallback');};
 ${source.slice(start,end)}
 globalThis.request=fiRequestIfrPair;
 globalThis.resolveJob=(i,result)=>jobs[i](result);
 globalThis.advance=()=>{fiPairSerial++;fiPairAnchorTime+=1000/24;fiMethod='skip';};
 globalThis.setNow=t=>{now=t;};
 globalThis.noSlot=()=>{fiDisplayPeriod=1000/24;};
 globalThis.restoreSlot=()=>{fiDisplayPeriod=1000/60;};
 globalThis.inspect=()=>({busy:fiGpuBusy,method:fiMethod,reason:fiSkipReason,ready:fiGpuReadySerial,...fiGpuEngine.stats});
`,ctx);
const tick=()=>new Promise(r=>setImmediate(r));
(async()=>{
 assert.equal(ctx.request(),true);ctx.advance();assert.equal(ctx.request(),false);
 assert.match(ctx.inspect().reason,/previous pair/);assert.equal(ctx.inspect().busy,true);
 ctx.setNow(1052);ctx.resolveJob(0,{valid:true,elapsedMs:52});await tick();
 assert.equal(ctx.inspect().completed,1,'completed inference is counted even after source pair advanced');
 assert.equal(ctx.inspect().late,1);assert.equal(ctx.inspect().busy,false);
 ctx.noSlot();assert.equal(ctx.request(),false);assert.match(ctx.inspect().reason,/No extra display slot/);
 ctx.restoreSlot();assert.equal(ctx.request(),true);ctx.setNow(1053);ctx.resolveJob(1,{valid:true,elapsedMs:3});await tick();
 assert.equal(ctx.inspect().method,'ifrnet');assert.equal(ctx.inspect().ready,2,'next pair recovers without toggling');
 ctx.advance();assert.equal(ctx.request(),true);ctx.setNow(1200);ctx.resolveJob(2,{valid:true,elapsedMs:60});await tick();
 assert.equal(ctx.inspect().method,'skip');assert.match(ctx.inspect().reason,/after its display slot/);
 const extract=name=>{const a=source.indexOf('function '+name+'('),b=source.indexOf('\nfunction ',a+1);return source.slice(a,b);};
 const prep=vm.createContext({queueMicrotask:fn=>fn()});
 vm.runInContext(`
  let settings={fiInfra:true,fiEngine:'ifrnet',interaction:'quality'},gl={},scrolling=false,fiGpuEngine=null;
  let fiBlendProgram=null,fiWarpProgram=null,fiHasCurr=false,fiHasPrev=false,fiPairSerial=0;
  let fiPrevTexture={},fiCurrTexture={},texture={},reads=0,shaders=0;
  const fiEnsureFrameTextures=()=>{},fiCopyTexture=()=>{},fiRequestGpuPair=()=>false;
  const fiUpdateLumaSample=()=>{reads++;},fiEnsurePrograms=()=>{shaders++;return true;};
  ${extract('warmFiPrograms')}
  ${extract('fiAfterVideoUpload')}
  globalThis.prepare=(requested,kind)=>{settings.fiEngine=requested;fiGpuEngine=kind?{kind}:null;
   warmFiPrograms();fiAfterVideoUpload({videoWidth:1280,videoHeight:720});return {reads,shaders};};
 `,prep);
 for(const kind of [null,'ifrnet','analytic']){
  const state=prep.prepare('ifrnet',kind);assert.equal(state.reads,0);assert.equal(state.shaders,0);
 }
 assert.equal(prep.prepare('neural',null).reads,0,'unready Personal backend performs no CPU analysis');
 const personal=prep.prepare('neural','neural');assert.equal(personal.reads,1,'ready Personal backend preserves its scene checks');assert.equal(personal.shaders,0);
 const classic=prep.prepare('classic','classic');assert.equal(classic.reads,2);assert.equal(classic.shaders,1,'legacy engine keeps its required preparation');
 console.log('PASS: IFRNet controller reports slot/busy/late states and resumes with correct single-flight ownership');
 console.log('PASS: IFRNet startup avoids unused CPU analysis/shaders; classic and Personal paths preserve required checks');
})().catch(e=>{console.error(e);process.exitCode=1;});
