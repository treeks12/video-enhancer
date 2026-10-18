// Production controller: API fallback keeps the selected IFRNet model, and
// cancelled preparations cannot install a stale engine or start another API.
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../content.js'),'utf8');
const extract=name=>{const start=source.indexOf('function '+name+'('),end=source.indexOf('\nfunction ',start+1);return source.slice(start,end);};
const production=['fiWarmGpu','fiResizeIfrGpu','fiReleaseGpu','fiUseClassicFallback'].map(extract).join('\n');
const setup=`
 let settings={fiInfra:true,fiEngine:'ifrnet',fiProfile:'quality',mode:'native'},gl={},currentVideo={videoWidth:1280,videoHeight:720};
 let fiGpuInit=null,fiGpuEngine=null,fiGpuState='idle',fiGpuGeneration=0,fiNeuralFailure='',fiWebGpuFailure='',fiGpuError='';
 let fiGpuController=null,fiGpuInitSize=null,fiAnalyticStep=0,feedSessionId=1,stopped=false;
 let fiBufferedEpoch=0,fiHasHistory=false;const fiBufferedPairs=new Map();
 let fiDisplayRaf=null,fiNeuralResult=null,fiNeuralTarget=null,fiGpuReadySerial=-1,fiGpuBusy=false,fiMethod='skip',fiSkipReason='';
 const fiMeasureDisplay=()=>{},cancelFiMid=()=>{},cancelAnimationFrame=()=>{},log=()=>{};
 const counters={webgpu:0,webgl:0,analytic:0,captureMode:null,filteredSources:false,genericConcat:false,genericFlow:false};
 function make(backend){return {backend,dimensions:{activeW:512,activeH:288},dead:false,whenLost:new Promise(()=>{}),destroy(){this.dead=true;}};}
 const gpu=make('webgpu'),legacy=make('webgl2'),analytic={...make('webgl2'),kind:'analytic'};
 const VENeuralClient={load:async()=>new Uint8Array(1)};
 const VENeuralWebGPU={create:async(...args)=>{counters.webgpu++;counters.captureMode=args[7]?.captureMode;counters.filteredSources=args[7]?.filteredSources;counters.genericConcat=args[7]?.genericConcat;counters.genericFlow=args[7]?.genericFlow;return gpu;}};
 const VENeuralRuntime={create:async()=>{counters.webgl++;return legacy;}};
 const FiAnalytic={create:async()=>{counters.analytic++;return analytic;}};
 globalThis.state=()=>({backend:fiGpuEngine?.backend,kind:fiGpuEngine?.kind,apiFailure:fiWebGpuFailure,modelFailure:fiNeuralFailure,
  init:!!fiGpuInit,...counters,gpuDead:gpu.dead});
`;
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const harness=()=>{const c=vm.createContext({AbortController,navigator:{gpu:{}}});vm.runInContext(setup+production,c);return c;};
(async()=>{
 const success=harness();vm.runInContext('fiWarmGpu()',success);await tick();
 assert.equal(success.state().backend,'webgpu');assert.equal(success.state().webgl,0);
 assert.equal(success.state().captureMode,'snapshot','shipping controller selects GPU-owned immutable video snapshots');
 assert.equal(success.state().filteredSources,true);assert.equal(success.state().genericConcat,true,'shipping controller reuses concatenation programs');
 assert.equal(success.state().genericFlow,true,'shipping controller shares flow warp and refinement programs across scales and directions');
 vm.runInContext("fiUseClassicFallback(fiGpuEngine,new Error('device unavailable'))",success);await tick();
 assert.equal(success.state().backend,'webgl2');assert.equal(success.state().kind,'ifrnet');
 assert.equal(success.state().webgpu,1,'API failure must not reinitialize the same failing device');
 assert.equal(success.state().webgl,1);assert.equal(success.state().modelFailure,'');
 assert.match(success.state().apiFailure,/device unavailable/);assert.equal(success.state().analytic,0);assert.equal(success.state().gpuDead,true);
 vm.runInContext('fiReleaseGpu();fiWarmGpu()',success);await tick();
 assert.equal(success.state().webgpu,2,'explicit disable/reload allows a fresh capability attempt');
 assert.equal(success.state().apiFailure,'');

 const unavailable=harness();vm.runInContext("VENeuralWebGPU.create=async()=>{counters.webgpu++;throw new Error('adapter unavailable')};fiWarmGpu()",unavailable);await tick();
 assert.equal(unavailable.state().backend,'webgl2');assert.equal(unavailable.state().kind,'ifrnet');
 assert.equal(unavailable.state().modelFailure,'');assert.match(unavailable.state().apiFailure,/adapter unavailable/);

 const brokenModel=harness();vm.runInContext("VENeuralWebGPU.create=async()=>{throw new Error('GPU unavailable')};VENeuralRuntime.create=async()=>{throw new Error('model invalid')};fiWarmGpu()",brokenModel);await tick();
 assert.equal(brokenModel.state().kind,'analytic');assert.match(brokenModel.state().modelFailure,/model invalid/);

 const cancelled=harness();vm.runInContext(`
  VENeuralWebGPU.create=(_gl,_bytes,_w,_h,_profile,_step,signal)=>{
   counters.webgpu++;
   return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{const error=new Error('cancelled');error.name='AbortError';reject(error);}));
  };fiWarmGpu();
 `,cancelled);await tick();vm.runInContext('settings.fiInfra=false;fiReleaseGpu()',cancelled);await tick();
 assert.equal(cancelled.state().webgl,0,'cancellation never starts another preparation');
 assert.equal(cancelled.state().apiFailure,'');assert.equal(cancelled.state().modelFailure,'');assert.equal(cancelled.state().init,false);
 console.log('PASS: IFRNet API fallback preserves model choice, avoids retry loops, and respects cancelled preparations');
})().catch(error=>{console.error(error);process.exitCode=1;});
