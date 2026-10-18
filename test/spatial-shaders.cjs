// Real spatial shader preparation functions with deferred mock GPU completion.
// Blocking status queries fail immediately while compilation is outstanding.
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../content.js'),'utf8');
const extract=name=>{
 const start=source.indexOf('function '+name+'('),asyncStart=source.lastIndexOf('async ',start);
 const begin=asyncStart===start-6?asyncStart:start,end=source.indexOf('\nfunction ',start+1);
 assert.ok(start>=0&&end>start,'production function '+name);return source.slice(begin,end);
};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const shaderSource='step1: String.raw`STEP`,\ncompose: String.raw`COMPOSE`,\nclassify: String.raw`CLASSIFY`,\n';
function mockGL({parallel=true,failProgram=-1,allocationFailure=''}={}){
 const events=[],programs=[],shaders=[];let next=0;
 const gl={VERTEX_SHADER:'vertex',FRAGMENT_SHADER:'fragment',LINK_STATUS:'link',COMPILE_STATUS:'compile',lost:false,
  getExtension(name){events.push(['extension',name]);assert.equal(name,'KHR_parallel_shader_compile');return parallel?{COMPLETION_STATUS_KHR:'complete'}:null;},
  createShader(type){if(allocationFailure===type)return null;const shader={owner:gl,id:++next,type,deleted:0};shaders.push(shader);return shader;},
  createProgram(){if(allocationFailure==='program')return null;const program={owner:gl,id:++next,index:programs.length,complete:!parallel,deleted:0,attached:[]};programs.push(program);return program;},
  shaderSource(shader,text){shader.text=text;},
  compileShader(shader){events.push(['compileShader',shader.id]);assert.equal(events[0][0],'extension','parallel compilation must be enabled before compiling');},
  attachShader(program,shader){program.attached.push(shader);},
  linkProgram(program){events.push(['linkProgram',program.id]);},
  getShaderParameter(){throw new Error('COMPILE_STATUS would synchronously wait for shader compilation');},
  getProgramParameter(program,pname){
   assert.equal(program.owner,gl);assert.equal(program.deleted,0);
   events.push(['query',pname,program.id]);
   if(pname==='complete')return program.complete;
   assert.equal(pname,'link');assert.ok(program.complete,'LINK_STATUS queried before completion');
   return program.index!==failProgram;
  },
  getProgramInfoLog(program){assert.ok(program.complete,'info log queried before completion');return 'mock spatial link failure';},
  deleteShader(shader){assert.equal(shader.owner,gl);assert.equal(shader.deleted++,0,'shader deleted exactly once');},
  deleteProgram(program){assert.equal(program.owner,gl,'program must be deleted through its owning context');assert.equal(program.deleted++,0,'program deleted exactly once');},
  isContextLost(){return gl.lost;},
  getUniformLocation(program,name){assert.equal(program.owner,gl);assert.equal(program.deleted,0);events.push(['uniform',program.id,name]);return {program,name};},
  useProgram(program){assert.equal(program.owner,gl);assert.equal(program.deleted,0);},uniform1i(){},uniform1f(){},
 };
 return {gl,events,programs,shaders,complete(index){programs[index].complete=true;}};
}
function harness(options={}){
 const gpu=mockGL(options),timers=[],clock={now:0};let fetchCount=0,respond;
 const context=vm.createContext({performance:{now:()=>clock.now},
  setTimeout:(callback,delay)=>{timers.push({callback,delay});return timers.length;},
  fetch:()=>{fetchCount++;return new Promise(resolve=>{respond=resolve;});},initialGL:gpu.gl});
 vm.runInContext(`
  let gl=initialGL,ravuClassifyProgram=null,ravuStepProgram=null,ravuComposeProgram=null,ravuShadersPromise=null,ravuShaderError='',lastError='';
  let ravuSourceLoc,ravuLutLoc,ravuClassificationLoc,ravuClassifySourceLoc,ravuComposeSourceLoc,ravuPackedLoc,ravuSourceSizeLoc,ravuOutputTexelLoc,ravuCompareLoc;
  const VERT='vertex source',VERT_PLAIN='plain vertex source',ext={runtime:{getURL:path=>'extension://'+path}};
  const log=()=>{};
  ${['linkProgramCooperatively','extractRavuShader','loadRavuShaders'].map(extract).join('\n')}
  globalThis.api={link:linkProgramCooperatively,load:loadRavuShaders,
   replace:context=>{gl=context;},state:()=>({classify:ravuClassifyProgram,step:ravuStepProgram,compose:ravuComposeProgram,error:ravuShaderError,lastError})};
 `,context);
 return {...gpu,api:context.api,clock,timers,
  fetched:()=>fetchCount,respond(text=shaderSource,status=200){respond({ok:status===200,status,text:async()=>text});},
  async flush(){const batch=timers.splice(0);for(const timer of batch){assert.ok([8,16].includes(timer.delay));timer.callback();}await tick();},
 };
}
function track(promise){
 const state={status:'pending'};state.done=promise.then(value=>{state.status='fulfilled';state.value=value;},error=>{state.status='rejected';state.error=error;});return state;
}
function noResourcesLeaked(h){
 assert.ok(h.shaders.every(shader=>shader.deleted===1),'all allocated shaders released');
 assert.ok(h.programs.every(program=>program.deleted===1),'all allocated programs released');
}
(async()=>{
 const compiling=harness(),pending=track(compiling.api.link('VERTEX','FRAGMENT'));
 assert.equal(compiling.programs.length,1);assert.equal(compiling.shaders.length,2);
 let heartbeat=false;setImmediate(()=>{heartbeat=true;});await tick();
 assert.equal(heartbeat,true,'other event-loop tasks run while compilation remains pending');
 assert.equal(pending.status,'pending');assert.ok(compiling.timers.length>0);
 assert.equal(compiling.events.filter(event=>event[0]==='query'&&event[1]==='link').length,0);
 compiling.complete(0);compiling.clock.now=8;await compiling.flush();await pending.done;
 assert.equal(pending.status,'fulfilled');assert.equal(pending.value,compiling.programs[0]);
 assert.ok(compiling.shaders.every(shader=>shader.deleted===1));assert.equal(compiling.programs[0].deleted,0);
 compiling.gl.deleteProgram(pending.value);noResourcesLeaked(compiling);

 const failed=harness({failProgram:0}),failure=track(failed.api.link('V','F'));
 failed.complete(0);await failed.flush();await failure.done;
 assert.equal(failure.status,'rejected');assert.match(failure.error.message,/mock spatial link failure/);noResourcesLeaked(failed);
 for(const allocationFailure of ['vertex','fragment','program']){
  const h=harness({allocationFailure}),job=track(h.api.link('V','F'));await job.done;
  assert.equal(job.status,'rejected');assert.match(job.error.message,/allocation failed/);noResourcesLeaked(h);
 }
 const timeout=harness(),timeoutWork=track(timeout.api.link('V','F'));
 timeout.clock.now=30001;await timeout.flush();await timeoutWork.done;
 assert.equal(timeoutWork.status,'rejected');assert.match(timeoutWork.error.message,/timed out/);noResourcesLeaked(timeout);
 const lost=harness(),lostWork=track(lost.api.link('V','F'));
 lost.gl.lost=true;await lost.flush();await lostWork.done;
 assert.equal(lostWork.status,'rejected');assert.match(lostWork.error.message,/context changed/);noResourcesLeaked(lost);

 // Completion may become available on the same turn in which the old context
 // is replaced. A guard only inside the polling loop misses this race.
 const changed=harness(),changedWork=track(changed.api.link('V','F'));
 changed.api.replace(mockGL().gl);changed.complete(0);await changed.flush();await changedWork.done;
 assert.equal(changedWork.status,'rejected');assert.match(changedWork.error.message,/context changed/);noResourcesLeaked(changed);

 // Without KHR there is no asynchronous completion query. Preserve a working
 // fallback without querying each shader separately or polling forever.
 const synchronous=harness({parallel:false}),fallback=track(synchronous.api.link('V','F'));await fallback.done;
 assert.equal(fallback.status,'fulfilled');assert.equal(synchronous.timers.length,0);
 assert.equal(synchronous.events.filter(event=>event[0]==='query'&&event[1]==='link').length,1);
 synchronous.gl.deleteProgram(fallback.value);noResourcesLeaked(synchronous);

 const both=harness(),shared=both.api.load(),sharedAgain=both.api.load(),bothWork=track(shared);
 assert.equal(sharedAgain,shared,'concurrent callers share preparation');assert.equal(both.fetched(),1);
 both.respond();await tick();assert.equal(both.programs.length,3,'parallel links start without waiting for their sibling');
 both.complete(0);await both.flush();
 assert.equal(bothWork.status,'pending');assert.equal(both.api.state().step,null,'no partially installed spatial pipeline');
 both.complete(1);await both.flush();assert.equal(bothWork.status,'pending');
 both.complete(2);await both.flush();await bothWork.done;
 assert.equal(bothWork.value,true);assert.equal(both.api.state().classify,both.programs[0]);assert.equal(both.api.state().step,both.programs[1]);assert.equal(both.api.state().compose,both.programs[2]);
 assert.equal(await both.api.load(),true);assert.equal(both.fetched(),1,'ready shader reuse does not refetch');
 assert.ok(both.shaders.every(shader=>shader.deleted===1));
 for(const program of both.programs)both.gl.deleteProgram(program);noResourcesLeaked(both);

 const sibling=harness({failProgram:1}),siblingWork=track(sibling.api.load());sibling.respond();await tick();
 sibling.complete(1);await sibling.flush();
 assert.equal(siblingWork.status,'pending','settled failure waits for its still-compiling sibling');
 sibling.complete(0);sibling.complete(2);await sibling.flush();await siblingWork.done;
 assert.equal(siblingWork.value,false);assert.equal(sibling.api.state().step,null);assert.equal(sibling.api.state().compose,null);
 assert.match(sibling.api.state().error,/mock spatial link failure/);noResourcesLeaked(sibling);

 const replaced=harness(),replacedWork=track(replaced.api.load());replaced.respond();await tick();
 replaced.complete(0);await replaced.flush();
 const replacement=mockGL();replaced.api.replace(replacement.gl);replaced.complete(1);replaced.complete(2);await replaced.flush();await replacedWork.done;
 assert.equal(replacedWork.value,false);assert.equal(replaced.api.state().step,null);assert.equal(replaced.api.state().compose,null);
 noResourcesLeaked(replaced);assert.equal(replacement.events.length,0,'old programs are neither installed nor deleted through a replacement context');

 const serial=harness({parallel:false}),serialWork=track(serial.api.load());serial.respond();await tick();
 assert.equal(serial.programs.length,0,'without KHR the first compile also yields after compositor initialization');
 await serial.flush();assert.equal(serial.programs.length,1,'without KHR only one program compiles per task');
 await serial.flush();assert.equal(serial.programs.length,2);await serial.flush();await serialWork.done;
 assert.equal(serialWork.value,true);assert.equal(serial.programs.length,3);
 for(const program of serial.programs)serial.gl.deleteProgram(program);noResourcesLeaked(serial);

 const serialChanged=harness({parallel:false}),serialChangedWork=track(serialChanged.api.load());serialChanged.respond();await tick();
 serialChanged.api.replace(mockGL().gl);await serialChanged.flush();await serialChangedWork.done;
 assert.equal(serialChangedWork.value,false);assert.equal(serialChanged.programs.length,0);noResourcesLeaked(serialChanged);

 const corrupt=harness(),corruptWork=track(corrupt.api.load());corrupt.respond('step1: String.raw`STEP`,\n');await tick();
 // If one parser fails, no asynchronous sibling should have been launched.
 assert.equal(corrupt.programs.length,0,'extract every shader before starting compilation');
 await corruptWork.done;assert.equal(corruptWork.value,false);assert.match(corrupt.api.state().error,/compose/);noResourcesLeaked(corrupt);
 const network=harness(),networkWork=track(network.api.load());network.respond('',503);await networkWork.done;
 assert.equal(networkWork.value,false);assert.equal(network.programs.length,0);assert.match(network.api.state().error,/503/);
 console.log('PASS spatial shaders: cooperative progress, deferred status queries, timeout/context/allocation cleanup and no-KHR fallback');
 console.log('PASS spatial shaders: shared parallel preparation, atomic installation, sibling cleanup and malformed-source failure safety');
})().catch(error=>{console.error(error);process.exitCode=1;});
