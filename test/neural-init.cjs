const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../content.js'),'utf8');
const extract=name=>{const start=source.indexOf('function '+name+'(');const end=source.indexOf('\nfunction ',start+1);return source.slice(start,end);};
const code=['fiWarmGpu','fiReleaseGpu','fiUseClassicFallback'].map(extract).join('\n');
const prelude=`
let settings={fiInfra:true,fiEngine:'neural',fiProfile:'balanced',mode:'native'};
let fiGpuInit=null,fiGpuEngine=null,fiGpuState='idle',fiGpuGeneration=0,fiNeuralFailure='',fiGpuError='';
let fiDisplayRaf=null,fiNeuralResult=null,fiNeuralTarget=null,fiGpuReadySerial=-1,fiGpuBusy=false,fiMethod='skip',fiSkipReason='',stopped=false;
const fiMeasureDisplay=()=>{},cancelFiMid=()=>{},cancelAnimationFrame=()=>{};
let resolveNeural;
function engine(kind){return {kind,lost:false,dead:false,destroy(){this.dead=true;},whenLost:new Promise(()=>{})};}
const classic=engine('classic'),neural=engine('neural');
const FiNeural={create:()=>new Promise(resolve=>resolveNeural=resolve)};
const FiWebGpu={create:async()=>classic};
globalThis.inspect=()=>({kind:fiGpuEngine?.kind,generation:fiGpuGeneration,init:!!fiGpuInit,failure:fiNeuralFailure,classicDead:classic.dead,neuralDead:neural.dead});
`;
const tick=()=>new Promise(r=>setImmediate(r));
(async()=>{
 const c=vm.createContext({console});vm.runInContext(prelude+code,c);
 vm.runInContext('fiWarmGpu()',c);await tick();vm.runInContext("fiReleaseGpu(); settings.fiEngine='classic'; fiWarmGpu();",c);await tick();
 assert.equal(c.inspect().kind,'classic');vm.runInContext('resolveNeural(neural)',c);await tick();assert.equal(c.inspect().kind,'classic');assert.ok(c.inspect().neuralDead);assert.equal(c.inspect().init,false);
 const d=vm.createContext({console});vm.runInContext(prelude+code,d);vm.runInContext("FiNeural.create=async()=>{throw new Error('Model missing')};fiWarmGpu();",d);await tick();assert.equal(d.inspect().kind,'classic');assert.match(d.inspect().failure,/Model missing/);
 console.log('PASS: async backend-init generation race and missing-model fallback use production controller functions');
})().catch(e=>{console.error(e);process.exitCode=1;});
