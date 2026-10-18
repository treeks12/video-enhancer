const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../content.js'),'utf8');
const extract=name=>{const start=source.indexOf('function '+name+'(');const end=source.indexOf('\nfunction ',start+1);return source.slice(start,end);};
const code=['fiWarmGpu','fiResizeIfrGpu','fiReleaseGpu','fiUseClassicFallback'].map(extract).join('\n');
const prelude=`
let settings={fiInfra:true,fiEngine:'neural',fiProfile:'balanced',mode:'native'};
let gl={},currentVideo={videoWidth:1280,videoHeight:720},fiAnalyticStep=0;
let fiGpuInit=null,fiGpuEngine=null,fiGpuState='idle',fiGpuGeneration=0,fiNeuralFailure='',fiWebGpuFailure='',fiGpuError='';
let fiGpuController=null,fiGpuInitSize=null,feedSessionId=1;
let fiBufferedEpoch=0,fiHasHistory=false;const fiBufferedPairs=new Map();
let fiDisplayRaf=null,fiNeuralResult=null,fiNeuralTarget=null,fiGpuReadySerial=-1,fiGpuBusy=false,fiMethod='skip',fiSkipReason='',stopped=false;
const fiMeasureDisplay=()=>{},cancelFiMid=()=>{},cancelAnimationFrame=()=>{};
let resolveNeural;
function engine(kind){return {kind,lost:false,dead:false,destroy(){this.dead=true;},whenLost:new Promise(()=>{})};}
const classic=engine('classic'),neural=engine('neural'),analytic=engine('analytic');
const FiAnalytic={create:async()=>analytic};
const FiNeural={create:()=>new Promise(resolve=>resolveNeural=resolve)};
const FiWebGpu={create:async()=>classic};
globalThis.inspect=()=>({kind:fiGpuEngine?.kind,generation:fiGpuGeneration,init:!!fiGpuInit,failure:fiNeuralFailure,classicDead:classic.dead,neuralDead:neural.dead});
`;
const tick=()=>new Promise(r=>setImmediate(r));
(async()=>{
 const c=vm.createContext({console,AbortController});vm.runInContext(prelude+code,c);
 vm.runInContext('fiWarmGpu()',c);await tick();vm.runInContext("fiReleaseGpu(); settings.fiEngine='classic'; fiWarmGpu();",c);await tick();
 assert.equal(c.inspect().kind,'classic');vm.runInContext('resolveNeural(neural)',c);await tick();assert.equal(c.inspect().kind,'classic');assert.ok(c.inspect().neuralDead);assert.equal(c.inspect().init,false);
 const d=vm.createContext({console,AbortController});vm.runInContext(prelude+code,d);vm.runInContext("FiNeural.create=async()=>{throw new Error('Model missing')};fiWarmGpu();",d);await tick();assert.equal(d.inspect().kind,'analytic');assert.match(d.inspect().failure,/Model missing/);
 // Returning to A while B is compiling must reactivate A, even though sourceW
 // still describes A when the aborted B preparation resolves.
 const e=vm.createContext({console,AbortController});vm.runInContext(prelude+code+`
 let resizeCalls=0;
 const retained=engine('ifrnet');retained.sourceW=1280;retained.sourceH=720;
 retained.dimensions={activeW:320,activeH:180};retained.resize=(w,h,p,signal)=>{
  resizeCalls++;
  if(resizeCalls===1)return new Promise((r,j)=>signal.addEventListener('abort',()=>{const error=new Error('cancelled');error.name='AbortError';j(error);}));
  return Promise.resolve(retained);
 };
 fiGpuEngine=retained;fiGpuState='ready';settings.fiEngine='ifrnet';
 currentVideo={videoWidth:720,videoHeight:1280};fiWarmGpu();
 currentVideo={videoWidth:1280,videoHeight:720};fiWarmGpu();
 globalThis.resizeState=()=>({resizeCalls,ready:fiGpuState,width:retained.sourceW,dead:retained.dead});
 `,e);await tick();await tick();
 assert.equal(e.resizeState().ready,'ready');assert.equal(e.resizeState().width,1280);
 assert.equal(e.resizeState().resizeCalls,2);assert.equal(e.resizeState().dead,false);
 console.log('PASS: async backend-init generation race and missing-model fallback use production controller functions');
})().catch(e=>{console.error(e);process.exitCode=1;});
