'use strict';
const assert=require('node:assert/strict'),{mockDevice}=require('./mock-gpu.cjs');
const {Engine}=require('../fi-neural.js');
(async()=>{
 const device=mockDevice();let release;
 const pending=()=>new Promise(resolve=>{release=resolve;});device.queue.onSubmittedWorkDone=pending;
 const engine=new Engine(device,{},'balanced');engine.width=64;engine.height=48;engine.runtime={prepPair(){},runT(){},destroy(){}};
 engine.pool=Array.from({length:4},()=>({texture:device.createTexture({size:[64,48],format:'rgba8unorm'}),locked:false}));
 const video={videoWidth:64,videoHeight:48};
 assert.equal(engine.submit(video,{serial:1}),null,'first frame is only an anchor');
 let serial=2;const work=engine.submit(video,{serial:2,valid:()=>serial===2});assert.ok(work?.then);assert.equal(engine.pool.filter(p=>p.locked).length,2);
 assert.equal(engine.submit(video,{serial:3}),null,'busy updates newest anchor but starts no second inference');serial=3;
 release();await work;assert.equal(engine.stats.late,1);assert.ok(engine.pool.every(p=>!p.locked));assert.equal(engine.busy,false);
 const work2=engine.submit(video,{serial:4});assert.ok(work2);engine.reset();release();assert.equal(await work2,null,'reset invalidates old result');
 assert.equal(engine.last,null);assert.equal(engine.submit(video,{serial:5}),null);engine.destroy();assert.ok(device.allocations.every(p=>p.dead));assert.throws(()=>engine.submit(video,{serial:6}));
 console.log('PASS: snapshot ring, single flight, serial changes, reset, stale-result rejection and destruction (mock GPU)');
})().catch(e=>{console.error(e);process.exitCode=1;});
