'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const s=fs.readFileSync(path.join(__dirname,'../content.js'),'utf8');
const start=s.indexOf('function fiRequestAnalyticPair('),end=s.indexOf('\nfunction ',start+10);
const code=s.slice(start,end).replaceAll('/* PERSONAL_ONLY_BEGIN */','').replaceAll('/* PERSONAL_ONLY_END */','');
function context(){
 const ctx=vm.createContext({console,performance:{now:()=>1000}});
 vm.runInContext(`
 let resolve,reject,calls=0,rebuilds=0;
 const engine={estimate:()=>{calls++;return new Promise((r,j)=>{resolve=r;reject=j;});},destroy(){this.dead=true;}};
 let fiGpuEngine=engine,fiPairSerial=1,currentVideo={playbackRate:1},fiHasPrev=true,fiPairDiscontinuous=false,settings={fiBlockMatch:true,fiInfra:true,fiSceneCut:true};
 let fiGpuBusy=false,lastVideoFrameDurationMs=33.333,metricReport={videoFps:30},fiDisplayPeriod=16.667;
 let fiAnalyticRetryAt=0,fiMethod='skip',fiSkipReason='',fiGpuElapsedMs=0,fiAnalyticSlow=0,fiAnalyticStep=0,fiAnalyticLate=0,fiConfidence=0,fiGpuReadySerial=-1,fiGpuError='',fiGpuState='ready';
 const fiPrevTexture={},fiCurrTexture={},canRender=()=>true;
 const fiReleaseGpu=()=>{rebuilds++;fiGpuBusy=false;},fiWarmGpu=()=>{};
 globalThis.inspect=()=>({calls,rebuilds,method:fiMethod,ready:fiGpuReadySerial,busy:fiGpuBusy,step:fiAnalyticStep,cooldown:fiAnalyticRetryAt,late:fiAnalyticLate});
 `+code,ctx);return ctx;
}
const tick=()=>new Promise(r=>setImmediate(r));
(async()=>{
 const c=context();vm.runInContext('fiRequestAnalyticPair();fiRequestAnalyticPair()',c);assert.equal(c.inspect().calls,1);
 vm.runInContext('fiPairSerial++;resolve({valid:true,elapsedMs:5,confidence:.9})',c);await tick();assert.notEqual(c.inspect().ready,1);assert.equal(c.inspect().late,1);
 vm.runInContext('fiRequestAnalyticPair();resolve({valid:true,elapsedMs:5,sceneCut:true})',c);await tick();assert.equal(c.inspect().method,'skip');assert.equal(c.inspect().ready,-1);
 vm.runInContext('fiRequestAnalyticPair();resolve({valid:true,elapsedMs:5,confidence:.8,sceneCut:false})',c);await tick();assert.equal(c.inspect().method,'analytic');assert.equal(c.inspect().ready,2);
 const d=context();for(let i=0;i<12;i++){vm.runInContext('fiPairSerial++;fiRequestAnalyticPair();resolve({valid:true,elapsedMs:40})',d);await tick();}
 assert.equal(d.inspect().step,2);assert.equal(d.inspect().rebuilds,2);assert.ok(d.inspect().cooldown>1000);
 const n=d.inspect().calls;vm.runInContext('fiRequestAnalyticPair()',d);assert.equal(d.inspect().calls,n,'cooldown submits no extra work');
 const e=context();vm.runInContext('lastVideoFrameDurationMs=16.667;fiRequestAnalyticPair()',e);assert.equal(e.inspect().calls,0,'no source/display headroom');
 console.log('PASS production analytic controller: single flight, stale serial, scene cut, valid presentation, adaptive resolution, minimum-tier cooldown, display cadence guard');
})().catch(e=>{console.error(e);process.exitCode=1;});
