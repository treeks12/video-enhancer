// Host lifecycle/state tests. No shader arithmetic is emulated here.
'use strict';
const assert=require('node:assert/strict'),A=require('../fi-analytic.js');
function mockGL(){
 const alloc=[],bindings=new Map(),flags=new Set(['BLEND']),params=new Map();let unit=1003,id=0;
 let fb=null,read=null,vao={original:true},program={original:true},viewport=[2,3,300,200];
 const originalTextures=Array.from({length:5},(_,i)=>({original:i}));originalTextures.forEach((t,i)=>bindings.set(1000+i,t));
 const make=kind=>{const r={kind,id:++id,dead:false};alloc.push(r);return r;};const dead=r=>{if(r)r.dead=true;};
 const core={TEXTURE0:1000,hold:false,fail:false,lost:false,draws:0,stats:[0,.01,.9,.9],alloc,
  getExtension:n=>n==='EXT_color_buffer_float'?{}:null,isContextLost(){return this.lost;},
  createTexture:()=>make('texture'),createFramebuffer:()=>make('fbo'),createVertexArray:()=>make('vao'),
  createProgram:()=>make('program'),createShader:()=>make('shader'),fenceSync:()=>make('sync'),
  deleteTexture:dead,deleteFramebuffer:dead,deleteVertexArray:dead,deleteProgram:dead,deleteShader:dead,deleteSync:dead,
  activeTexture:u=>unit=u,bindTexture:(_,t)=>bindings.set(unit,t),
  bindFramebuffer:(target,f)=>{if(target==='FRAMEBUFFER'||target==='DRAW_FRAMEBUFFER')fb=f;if(target==='FRAMEBUFFER'||target==='READ_FRAMEBUFFER')read=f;},
  bindVertexArray:v=>vao=v,useProgram:p=>program=p,viewport:(...v)=>viewport=v,
  getParameter:n=>({DRAW_FRAMEBUFFER_BINDING:fb,READ_FRAMEBUFFER_BINDING:read,VERTEX_ARRAY_BINDING:vao,CURRENT_PROGRAM:program,VIEWPORT:viewport,ACTIVE_TEXTURE:unit,TEXTURE_BINDING_2D:bindings.get(unit)??null}[n]),
  isEnabled:n=>flags.has(n),enable:n=>flags.add(n),disable:n=>flags.delete(n),
  getUniformLocation:(_,n)=>n,getProgramParameter(){return !this.fail;},getShaderInfoLog:()=>'',getProgramInfoLog:()=>'',
  checkFramebufferStatus:()=> 'FRAMEBUFFER_COMPLETE',clientWaitSync(){return this.hold?'TIMEOUT_EXPIRED':'CONDITION_SATISFIED';},
  drawArrays(){this.draws++;},readPixels:(x,y,w,h,fmt,type,out)=>out.set(core.stats),
  state:()=>({fb,read,vao,program,viewport:[...viewport],unit,textures:Array.from({length:5},(_,i)=>bindings.get(1000+i)),flags:[...flags]})
 };
 for(const n of ['shaderSource','compileShader','attachShader','linkProgram','texParameteri','texImage2D','framebufferTexture2D','uniform1i','uniform1f','uniform2f','flush'])core[n]=()=>{};
 return new Proxy(core,{get:(o,k)=>k in o?o[k]:String(k)});
}
(async()=>{
 assert.deepEqual(A.dimensions(1920,1080),{width:320,height:180});assert.deepEqual(A.dimensions(3840,2160,'quality'),{width:512,height:288});
 assert.throws(()=>A.dimensions(NaN,50));assert.throws(()=>A.dimensions(0,50));
 for(const [w,h]of [[128,80],[320,180],[512,288],[8,8],[8,320]]){
  const graph=A.plan(w,h,'balanced'),available=new Set(['prev','curr']);
  const resolve=n=>graph.textures[n]?.alias||n;
  for(const op of graph.ops){for(const input of Object.values(op.inputs)){assert.ok(available.has(resolve(input)),`${input} unavailable`);assert.notEqual(resolve(input),op.out);}available.add(op.out);}
 }
 const g=mockGL(),initial=g.state(),r=await A.create(g,128,80);
 assert.deepEqual(g.state(),initial,'initialization restores upscaler state');const prev={},curr={},out={};
 const result=await r.estimate(prev,curr,1);assert.ok(result.valid);assert.equal(result.sceneCut,false);assert.equal(r.serial,1);assert.equal(g.draws,r.graph.ops.length);
 assert.deepEqual(g.state(),initial,'estimate restores state after submission and diagnostics');
 assert.equal(r.render(prev,curr,out,256,160,.5),true);assert.deepEqual(g.state(),initial,'synthesis restores state');
 assert.equal(r.render(prev,curr,out,256,160,NaN),false);
 g.hold=true;const job=r.estimate(prev,curr,2);assert.equal(await r.estimate(prev,curr,3),null,'single flight');r.reset();g.hold=false;
 assert.equal((await job).valid,false);assert.equal(r.render(prev,curr,out,128,80,.5),false,'invalid epoch cannot present');
 g.stats=[.8,.5,0,0];assert.equal((await r.estimate(prev,curr,4)).sceneCut,true);
 g.stats=[NaN,0,0,0];await assert.rejects(()=>r.estimate(prev,curr,5),/Invalid/);assert.equal(r.busy,false);
 g.stats=[0,.01,.9,.9];g.hold=true;const cancelled=r.estimate(prev,curr,6);r.destroy();await assert.rejects(()=>cancelled,/cancelled/);r.destroy();assert.ok(g.alloc.every(x=>x.dead),'all owned resources released');
 const broken=mockGL();broken.fail=true;await assert.rejects(()=>A.create(broken,64,32));assert.ok(broken.alloc.every(x=>x.dead),'failed initialization releases allocations');
 console.log('PASS analytic host: graph lifetime, single flight, invalid epochs, cuts, nonfinite rejection, cancellation, disposal and GL state isolation (mock GL, not shader execution)');
})().catch(e=>{console.error(e);process.exitCode=1;});
