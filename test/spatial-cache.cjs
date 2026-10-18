// Production cache lifetime and memory checks; mock GL, not shader execution.
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../content.js'),'utf8');
const start=source.indexOf('function trimSpatialTextures('),end=source.indexOf('\nfunction ensureIntermediate(',start);
let uploads=0,subUploads=0,failUpload=false,complete=true,id=0,failPackedWidth=0;
const textures=new Set(),framebuffers=new Set();
const gl={TEXTURE_2D:1,RGBA:2,RGBA16F:3,UNSIGNED_BYTE:4,HALF_FLOAT:5,LINEAR:6,NEAREST:7,FRAMEBUFFER:8,FRAMEBUFFER_COMPLETE:9,
 createTexture:()=>{const t={id:++id};textures.add(t);return t;},
 deleteTexture:t=>{assert.ok(textures.delete(t),'texture deleted once');},
 createFramebuffer:()=>{const f={id:++id};framebuffers.add(f);return f;},
 deleteFramebuffer:f=>{assert.ok(framebuffers.delete(f),'framebuffer deleted once');},
 bindTexture(){},bindFramebuffer(){},texParameteri(){},framebufferTexture2D(){},
 checkFramebufferStatus:()=>complete?9:0,
 texImage2D(...args){if(failUpload)throw new Error('SecurityError');if(args[2]===3&&args[3]===failPackedWidth)throw new Error('Packed allocation failed');uploads++;},
 texSubImage2D(){if(failUpload)throw new Error('SecurityError');subUploads++;}
};
const ctx=vm.createContext({gl});vm.runInContext(`
 const spatialTextures=new Map(),spatialActive=new Map();let spatialTextureBytes=0;
 const SPATIAL_CACHE_BYTES=96*1024*1024;let ravuFloatTarget=true;
 let ravuWidth=0,ravuHeight=0,ravuPackedTexture=null,ravuFramebuffer=null;
 let ravuClassifyTexture=null,ravuClassifyFramebuffer=null;
 let intermediateWidth=0,intermediateHeight=0,upscaledTexture=null,framebuffer=null;
 ${source.slice(start,end)}
 globalThis.acquire=acquireSpatialTexture;
 globalThis.select=selectSpatialTargets;
 globalThis.inspect=()=>({bytes:spatialTextureBytes,limit:SPATIAL_CACHE_BYTES,entries:[...spatialTextures.values()],active:[...spatialActive.values()]});
`,ctx);
const a=ctx.acquire('source',1280,720,{}),b=ctx.acquire('source',720,1280,{});
assert.notEqual(a.texture,b.texture);assert.equal(ctx.acquire('source',1280,720,{}),a);
assert.equal(uploads,2);assert.equal(subUploads,1,'warm source uses subimage upload');
const output=ctx.acquire('output',1920,1080),packed=ctx.acquire('ravu',1280,720);
const classification=ctx.acquire('ravuClassify',1280,720);
assert.equal(classification.bytes,1280*720*4,'LUT row classification uses byte storage');
assert.equal(packed.bytes,1280*720*8);assert.equal(output.bytes,1920*1080*4);
for(let i=0;i<20;i++)ctx.acquire('source',80+i,60,{});
assert.ok(ctx.inspect().entries.filter(e=>e.role==='source').length<=8);
for(let i=0;i<12;i++){
 ctx.acquire('ravu',1920+i*32,1080);ctx.acquire('output',1920+i*16,1080);
 const state=ctx.inspect(),activeBytes=state.active.reduce((s,e)=>s+e.bytes,0);
 assert.ok(state.bytes<=Math.max(state.limit,activeBytes),'only the active working set may exceed budget');
 for(const entry of state.active)assert.ok(textures.has(entry.texture),'active targets survive eviction');
}
const before=ctx.inspect(),live=textures.size,fbLive=framebuffers.size;
failUpload=true;assert.throws(()=>ctx.acquire('source',500,500,{}),/SecurityError/);failUpload=false;
assert.equal(textures.size,live);assert.equal(ctx.inspect().bytes,before.bytes);
complete=false;assert.throws(()=>ctx.acquire('output',123,321),/Incomplete/);complete=true;
assert.equal(textures.size,live);assert.equal(framebuffers.size,fbLive);assert.equal(ctx.inspect().bytes,before.bytes);
const active=ctx.inspect().active.find(e=>e.role==='source');
failUpload=true;assert.throws(()=>ctx.acquire('source',99,60,{}),/SecurityError/);failUpload=false;
assert.equal(ctx.inspect().active.find(e=>e.role==='source'),active,'failed warm upload preserves resource ownership');
assert.equal(ctx.inspect().bytes,[...textures].reduce((sum,t)=>sum+ctx.inspect().entries.find(e=>e.texture===t).bytes,0));
ctx.acquire('ravu',4096,4096);
assert.ok(ctx.inspect().bytes>ctx.inspect().limit,'oversized active working set is allowed');
ctx.select(false,false);
assert.ok(ctx.inspect().active.every(e=>e.role==='source'),'unused spatial roles are unpinned');
assert.ok(ctx.inspect().bytes<=ctx.inspect().limit,'unused oversized targets are evicted');
// Classification B can evict classification A before packed B fails. Returning
// to A must reacquire both targets rather than trust its old dimensions.
const ensureStart=source.indexOf('function ensureRavuIntermediate('),ensureEnd=source.indexOf('\nfunction attachCanvasTo(',ensureStart);
vm.runInContext(`let currentVideo={videoWidth:0,videoHeight:0},ravuFloatChecked=true,status='',lastError='';
 ${source.slice(ensureStart,ensureEnd)}
 globalThis.ensure=(w,h)=>{currentVideo.videoWidth=w;currentVideo.videoHeight=h;return ensureRavuIntermediate();};
 globalThis.targets=()=>({width:ravuWidth,height:ravuHeight,classify:ravuClassifyTexture,packed:ravuPackedTexture});`,ctx);
ctx.acquire('source',3840,2160,{});assert.equal(ctx.ensure(3840,2160),true);
const prior=ctx.targets();failPackedWidth=2160;
assert.equal(ctx.ensure(2160,3840),false);failPackedWidth=0;
assert.ok(!textures.has(prior.classify),'fixture evicted the old classification target');
assert.equal(ctx.targets().width,0,'failed replacement clears readiness');
assert.equal(ctx.ensure(3840,2160),true);
assert.ok(textures.has(ctx.targets().classify)&&textures.has(ctx.targets().packed),'returning size has live targets');
console.log('PASS: spatial source/output/RAVU shape reuse, active-target protection, bounded LRU and allocation/upload cleanup');
