// Host ownership and bounded scheduling only; native arithmetic is tested separately.
'use strict';
const assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const quality=require('../fi-quality.js');
global.GPUBufferUsage={COPY_DST:8,UNIFORM:64};
global.GPUTextureUsage={COPY_SRC:1,COPY_DST:2,TEXTURE_BINDING:4,STORAGE_BINDING:8,RENDER_ATTACHMENT:16};
global.GPUShaderStage={COMPUTE:4,FRAGMENT:2};
Object.defineProperty(global,'navigator',{configurable:true,value:{gpu:{getPreferredCanvasFormat:()=> 'bgra8unorm'}}});
function surface(width=64,height=32){
 let base;
 const makeParent=()=>({children:[],insertBefore(node,before){if(node.parentNode){const index=node.parentNode.children.indexOf(node);if(index>=0)node.parentNode.children.splice(index,1);}let index=before?this.children.indexOf(before):-1;if(index<0)index=this.children.length;this.children.splice(index,0,node);node.parentNode=this;if(node!==base&&!nodes.includes(node))nodes.push(node);}});
 const nodes=[],document={createElement:()=>({
  width:300,height:150,style:{cssText:''},setAttribute(){},remove(){if(this.parentNode){const index=this.parentNode.children.indexOf(this);if(index>=0)this.parentNode.children.splice(index,1);this.parentNode=null;}const index=nodes.indexOf(this);if(index>=0)nodes.splice(index,1);},
  getContext(){return this.context={
   configure(config){this.config=config;assert.equal(config.alphaMode,'premultiplied');},unconfigure(){this.stopped=true;},
   getCurrentTexture(){return {createView(){return {canvas:true};}};}
  };}
 })};
 base={width,height,id:'base',style:{cssText:'position:absolute;left:4px;top:9px;',opacity:'.75',visibility:'visible'},ownerDocument:document,parentNode:null};Object.defineProperty(base,'nextSibling',{get(){const list=this.parentNode?.children||[];return list[list.indexOf(this)+1]||null;}});makeParent().insertBefore(base,null);
 return {base,nodes,makeParent};
}
function mock(){
 const resources=[],submissions=[],gates=[],writes=[],uploads=[];let submitted=0,completed=0;
 const device={limits:{maxTextureDimension2D:8192},lost:new Promise(()=>{}),holding:false,waitCalls:0,pipelines:[],bufferCalls:0,textureCalls:0,
  createBuffer(config){if(++device.bufferCalls===device.failBufferAt)throw new Error('buffer allocation failed');const buffer={...config,dead:false,destroy(){assert.equal(this.dead,false);this.dead=true;}};resources.push(buffer);return buffer;},
  createTexture(config){if(++device.textureCalls===device.failTextureAt)throw new Error('texture allocation failed');const texture={...config,width:config.size[0],height:config.size[1],dead:false,destroy(){assert.equal(this.dead,false,'one destruction per texture');assert.ok((this.usedUntil||0)<=completed,'never destroy submitted texture before its fence');this.dead=true;},createView(){assert.equal(this.dead,false);return {texture:this};}};resources.push(texture);return texture;},
  createShaderModule:config=>config,createBindGroupLayout:config=>config,createPipelineLayout:config=>config,createSampler:config=>config,
  async createComputePipelineAsync(config){device.pipelines.push(config);if(device.failCompile)throw new Error('pipeline failed');return {...config,getBindGroupLayout(){return config.layout.bindGroupLayouts[0];}};},
  async createRenderPipelineAsync(config){device.pipelines.push(config);return {...config,getBindGroupLayout(){return {render:true};}};},
  createBindGroup(config){for(const entry of config.entries){assert.ok(!entry.resource.texture?.dead);assert.ok(!entry.resource.buffer?.dead);}return config;},
  createCommandEncoder(){const stages=[],copies=[];return {beginComputePass(){let pipeline,group;return {setPipeline(value){pipeline=value;},setBindGroup(index,value){group=value;},dispatchWorkgroups(x,y){assert.ok(x>0&&y>0);stages.push({pipeline,group,x,y});},end(){}};},beginRenderPass(){let group;return {setPipeline(){},setBindGroup(index,value){group=value;},draw(){stages.push({group,render:true});},end(){}};},copyTextureToTexture(source,target,size){assert.ok(source.texture.usage&GPUTextureUsage.COPY_SRC);assert.ok(target.texture.usage&GPUTextureUsage.COPY_DST);assert.equal(source.texture.format,target.texture.format);copies.push({source:source.texture,target:target.texture,size});},finish(){return {stages,copies};}};},
  queue:{writeBuffer(buffer,offset,data){assert.ok((buffer.usedUntil||0)<=completed,'uniform buffer still in use');writes.push(new Uint8Array(data).slice());},writeTexture(destination,data,layout,size){uploads.push({destination,data,layout,size});},submit(commands){if(device.failSubmit)throw new Error('submission failed');submitted++;for(const command of commands){for(const stage of command.stages)for(const entry of stage.group.entries){const resource=entry.resource.texture||entry.resource.buffer;if(resource)resource.usedUntil=submitted;}for(const copy of command.copies){copy.source.usedUntil=submitted;copy.target.usedUntil=submitted;}submissions.push(command);}},onSubmittedWorkDone(){throw new Error('must route completion through the supplied helper');}},
  wait(){device.waitCalls++;const target=submitted;if(device.holding)return new Promise(resolve=>gates.push(()=>{completed=Math.max(completed,target);resolve();}));completed=target;return Promise.resolve();},
  resources,submissions,gates,writes,uploads
 };return device;
}
const API=require('../neural/webgpu-compositor.js');
const lut=new Float32Array(13*288*4);lut[0]=1;lut[1]=-.5;lut[2]=2**-24;lut[3]=1+2**-11;
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
async function create(options={}){const device=mock(),dom=surface();const compositor=await API.create(device,dom.base,{captureMode:'external',lut,waitForCompletion:()=>device.wait(),...options});return {device,dom,compositor};}
function assertHalfUpload(data,expected,label){assert.equal(data.length,expected.length,label+' length');for(let i=0;i<expected.length;i++)assert.equal(data[i],expected[i],`${label} differs at LUT element ${i}`);}
function expectedHalfLut(values){const bits=new Uint32Array(values.buffer,values.byteOffset,values.length);return Array.from({length:values.length},(_,i)=>{const n=bits[i],sign=(n>>>31)&1,exponent=(n>>>23)&255,mantissa=n&0x7fffff;if(exponent===255)return mantissa?(sign?0xfe00:0x7e00):(sign?0xfc00:0x7c00);return quality.floatToHalf(values[i]);});}
(async()=>{
 let {device,dom,compositor:c}=await create();
 assert.equal(c.ready,true);assert.deepEqual(c.supportedAlgorithms,['native','rcas','ravu']);assert.equal(dom.nodes.length,1);assert.equal(c.canvas.style.visibility,'hidden');assert.equal(c.format,'bgra8unorm');
 assert.equal(c.canRenderDimensions(1280,720,1920,1080),true);assert.equal(c.canRenderDimensions(2560,1440,2560,1440),false);assert.equal(c.canRenderDimensions(3840,2160,3840,2160),false);assert.equal(c.canRenderDimensions(1920,1080,3840,2160),false);assert.equal(c.canRenderDimensions(0,24,64,48),false);
 dom.base.width=2560;dom.base.height=1440;const beforeCapacity=device.resources.length;assert.equal(c.render({external:{}},2560,1440),false);assert.equal(c.lastSkipReason,'capacity');assert.equal(device.resources.length,beforeCapacity,'permanently impossible shapes are rejected before allocating');dom.base.width=64;dom.base.height=32;
 assert.deepEqual(Array.from(device.uploads[0].data.slice(0,4)),[0x3c00,0xb800,1,0x3c00],'LUT binary16 rounding matches GL RGBA16F, including tie-to-even');
 assert.equal(device.uploads[0].destination.texture.format,'rgba16float');assert.deepEqual(device.uploads[0].size,[13,288]);
 const LUT_FLOATS=13*288*4;
 const edgeCases=[0,-0,1,-1,{bits:0x7f800000},{bits:0xff800000},{bits:0x7fc00000},{bits:0xffc00000},2**-24,-(2**-24),2**-25,3*2**-25,1+2**-11,1+3*2**-11,65504,65520,-65520];
 const paddedLut=new Float32Array(LUT_FLOATS+7),offsetLut=paddedLut.subarray(3,3+LUT_FLOATS);
 const offsetData=new DataView(paddedLut.buffer);
 for(let i=0;i<offsetLut.length;i++){const value=edgeCases[i%edgeCases.length];if(value&&typeof value==='object')offsetData.setUint32(offsetLut.byteOffset+i*4,value.bits,true);else offsetLut[i]=value;}
 assert.ok(offsetLut.byteOffset>0);assert.equal(offsetLut.length,LUT_FLOATS);
 const offsetExpected=expectedHalfLut(offsetLut);
 assert.deepEqual(offsetExpected.slice(0,edgeCases.length),[0x0000,0x8000,0x3c00,0xbc00,0x7c00,0xfc00,0x7e00,0xfe00,0x0001,0x8001,0x0000,0x0002,0x3c00,0x3c02,0x7bff,0x7c00,0xfc00],'finite oracle cases and signed IEEE nonfinite encodings cover boundaries and ties');
 let lutCase=await create({lut:offsetLut});
 assert.equal(lutCase.device.uploads.length,1);assert.equal(lutCase.device.uploads[0].data.length,LUT_FLOATS);
 const offsetActual=Array.from(lutCase.device.uploads[0].data);
 await lutCase.compositor.destroy();assert.ok(lutCase.device.resources.every(resource=>resource.dead));
 const lutBytes=fs.readFileSync(path.join(__dirname,'..','third_party','ravu-lite','ravu-lite-lut3.bin'));
 assert.equal(lutBytes.byteLength,LUT_FLOATS*Float32Array.BYTES_PER_ELEMENT,'bundled RAVU LUT has the complete expected float count');
 const realLut=new Float32Array(lutBytes.buffer.slice(lutBytes.byteOffset,lutBytes.byteOffset+lutBytes.byteLength));
 const realExpected=expectedHalfLut(realLut);
 lutCase=await create({lut:realLut});
 assert.equal(lutCase.device.uploads.length,1);assert.equal(lutCase.device.uploads[0].data.length,LUT_FLOATS);
 assertHalfUpload(lutCase.device.uploads[0].data,realExpected,'complete bundled RAVU LUT upload');
 await lutCase.compositor.destroy();assert.ok(lutCase.device.resources.every(resource=>resource.dead));
 const NativeFloat32Array=global.Float32Array,NativeUint32Array=global.Uint32Array;
 let float32Constructors=0,uint32Constructors=0,countedCompositor;
 global.Float32Array=new Proxy(NativeFloat32Array,{construct(target,args){float32Constructors++;return Reflect.construct(target,args,target);}});
 global.Uint32Array=new Proxy(NativeUint32Array,{construct(target,args){uint32Constructors++;return Reflect.construct(target,args,target);}});
 try{
  const countedDevice=mock(),countedDom=surface();
  countedCompositor=await API.create(countedDevice,countedDom.base,{captureMode:'external',lut:realLut,waitForCompletion:()=>countedDevice.wait()});
 }finally{global.Float32Array=NativeFloat32Array;global.Uint32Array=NativeUint32Array;}
 assert.equal(float32Constructors,0,'LUT preparation does not allocate a one-element Float32Array per value');
 assert.ok(uint32Constructors<=1,`LUT preparation creates at most one Uint32Array view (got ${uint32Constructors})`);
 await countedCompositor.destroy();
 assertHalfUpload(offsetActual,offsetExpected,'nonzero-byteOffset LUT upload');
 const input=device.createTexture({size:[64,32],format:'rgba8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_SRC});
 c.setVisible(true);assert.equal(dom.base.style.opacity,'0');assert.equal(c.canvas.style.visibility,'visible');
 const oldParent=dom.base.parentNode,newParent=dom.makeParent();newParent.insertBefore(dom.base,null);c.align();assert.equal(c.canvas.parentNode,newParent,'overlay follows the base to another feed/player');assert.equal(dom.base.nextSibling,c.canvas);assert.equal(oldParent.children.length,0);assert.equal(dom.nodes.length,1,'reparenting moves the existing canvas');
 assert.equal(c.render({texture:input},64,32,{algorithm:'ravu',strength:.6,compare:true,comparisonSource:{external:{frame:'retained'}}}),true);
 let command=device.submissions.at(-1);assert.equal(command.stages.filter(stage=>!stage.render).length,4,'copy two endpoints, classify and filter');assert.equal(command.stages.filter(stage=>stage.render).length,3,'compose and RCAS preserve raster interpolation/UNORM conversion before canvas blit');
 assert.equal(c.output.format,'rgba8unorm');assert.ok(c.output.usage&GPUTextureUsage.COPY_SRC);assert.ok(c.output.usage&GPUTextureUsage.TEXTURE_BINDING);
 assert.equal(command.stages[1].group.entries[1].resource.frame,'retained','external source is bound directly');
 const uniforms=new DataView(device.writes.at(-1).buffer);assert.equal(uniforms.getFloat32(16,true),Math.fround(.6));assert.equal(uniforms.getUint32(20,true),1);assert.equal(uniforms.getUint32(24,true),9);
 await c.whenIdle();
 const snap=c.snapshot(c.output,64,32,0);assert.ok(snap);assert.equal(snap.format,'rgba8unorm');assert.equal(device.submissions.at(-1).copies[0].source,c.output);assert.equal(device.submissions.at(-1).copies[0].target,snap);
 await c.whenIdle();assert.equal(c.snapshot(c.output,64,32,0),snap,'same-shape slot retains identity');await c.whenIdle();
 const first=c.output;dom.base.width=128;dom.base.height=64;assert.equal(c.render({texture:input},64,32,{algorithm:'native'}),true);await c.whenIdle();
 const second=c.output;dom.base.width=64;dom.base.height=32;assert.equal(c.render({texture:input},64,32,{algorithm:'rcas',strength:.3}),true);await c.whenIdle();assert.equal(c.output,first,'repeated shapes reuse their resources');
 dom.base.width=96;dom.base.height=48;assert.equal(c.render({texture:input},64,32),true);await c.whenIdle();assert.equal(c.shapes.size,2);assert.equal(second.dead,true,'third shape retires the least recently used drained shape');assert.ok(c.memoryBytes<96*1024*1024);
 c.setVisible(false);assert.equal(dom.base.style.opacity,'.75');assert.equal(c.canvas.style.visibility,'hidden');
 const lossTarget=c.lossTarget;await c.destroy();assert.equal(lossTarget.current,null,'document device-loss callback no longer retains the destroyed compositor');assert.equal(c.ready,false);assert.equal(dom.nodes.length,0);assert.equal(dom.base.style.opacity,'.75');assert.equal(c.memoryBytes,0);assert.ok(device.resources.filter(resource=>resource!==input).every(resource=>resource.dead));assert.equal(input.dead,false,'source remains caller-owned');await c.destroy();

 ({device,dom,compositor:c}=await create());device.holding=true;
 const external={external:{frame:'locked'}};for(let i=0;i<4;i++)assert.equal(c.render(external,64,32),true);assert.equal(c.pending.size,4);
 assert.equal(c.render(external,64,32),false,'bounded pending GPU submissions');assert.equal(c.lastSkipReason,'busy');assert.equal(c.snapshot(c.output,64,32,0),null,'snapshot obeys the same submission cap');
 assert.equal(new Set(device.submissions.map(command=>command.stages[0].group.entries[0].resource.buffer)).size,4,'four immutable uniform slots');
 let idle=false;c.whenIdle().then(()=>{idle=true;});await tick();assert.equal(idle,false);
 let destroyed=false;const destroying=c.destroy().then(()=>{destroyed=true;});await tick();assert.equal(destroyed,false);assert.ok(device.resources.some(resource=>!resource.dead));
 while(device.gates.length){device.gates.shift()();await tick();}device.holding=false;while(device.gates.length)device.gates.shift()();await destroying;assert.equal(destroyed,true);assert.equal(dom.nodes.length,0);

 ({device,dom,compositor:c}=await create({lut:null,captureMode:'rgba'}));assert.deepEqual(c.supportedAlgorithms,['native','rcas']);assert.throws(()=>c.render(external,64,32),/External compositor capture was not prepared/);assert.throws(()=>c.render({texture:{}},64,32,{algorithm:'ravu'}),/Unsupported/);assert.throws(()=>c.render({texture:{},external:{}},64,32),/exactly one/);assert.throws(()=>c.snapshot({},64,32,2),/slot/);await c.destroy();

 device=mock();dom=surface();device.failCompile=true;await assert.rejects(API.create(device,dom.base,{waitForCompletion:()=>device.wait()}),/pipeline failed/);assert.equal(dom.nodes.length,0);assert.ok(device.resources.every(resource=>resource.dead));
 device=mock();dom=surface();device.failBufferAt=3;await assert.rejects(API.create(device,dom.base,{waitForCompletion:()=>device.wait()}),/buffer allocation failed/);assert.equal(dom.nodes.length,0,'constructor failure removes the overlay before create can retain its instance');assert.ok(device.resources.every(resource=>resource.dead),'constructor failure destroys preceding uniform allocations');assert.equal(dom.base.style.opacity,'.75');
 ({device,dom,compositor:c}=await create());device.failSubmit=true;
 assert.throws(()=>c.render({external:{}},64,32),/submission failed/);assert.equal(c.pending.size,0);assert.ok(c.slots.every(slot=>!slot.pending));assert.ok(Array.from(c.shapes.values()).every(shape=>shape.refs===0),'failed submit releases shape ownership');
 device.failSubmit=false;assert.equal(c.render({external:{}},64,32),true);await c.whenIdle();await c.destroy();
 ({device,dom,compositor:c}=await create());const bytesBefore=c.memoryBytes;device.failTextureAt=device.textureCalls+3;
 assert.throws(()=>c.render({external:{}},64,32),/texture allocation failed/);assert.equal(c.shapes.size,0);assert.equal(c.memoryBytes,bytesBefore,'partial shape allocation rolls back bytes/resources');device.failTextureAt=0;
 assert.equal(c.render({external:{}},64,32),true);await c.whenIdle();await c.destroy();
 ({device,dom,compositor:c}=await create());dom.base.width=3840;dom.base.height=2160;
 assert.equal(c.render({external:{}},512,288),true);await c.whenIdle();const largeOutput=c.output;
 assert.equal(c.snapshot(largeOutput,3840,2160,0),null,'an over-budget snapshot is refused');assert.equal(largeOutput.dead,false,'budget trimming cannot destroy the source about to be copied');assert.equal(c.output,largeOutput);await c.destroy();
 ({device,dom,compositor:c}=await create());dom.base.width=1920;dom.base.height=1080;
 assert.equal(c.render({external:{}},1920,1080),true);await c.whenIdle();const oldSnapshots=[c.snapshot(c.output,1920,1080,0),c.snapshot(c.output,1920,1080,1)];await c.whenIdle();
 assert.ok(oldSnapshots.every(Boolean));dom.base.width=3840;dom.base.height=2160;assert.equal(c.canRenderDimensions(1280,720,3840,2160),true);device.holding=true;
 assert.equal(c.render({external:{}},1280,720),false,'new source may wait once for old snapshot retirement');assert.equal(c.lastSkipReason,'busy');assert.deepEqual(c.snapshots,[null,null]);assert.ok(oldSnapshots.every(texture=>!texture.dead),'stale snapshot allocations survive until their shared-queue fence');
 const retirement=c.whenIdle();while(device.gates.length)device.gates.shift()();device.holding=false;await retirement;assert.ok(oldSnapshots.every(texture=>texture.dead));
 assert.equal(c.render({external:{}},1280,720),true,'dimension transition recovers after drain without needing a new midpoint snapshot');await c.whenIdle();await c.destroy();
 // Extension fetch buffers can originate in the page/privileged realm. Their
 // Float32Array view is valid LUT data even though local instanceof rejects it.
 const foreignLut=vm.runInNewContext('new Float32Array(13*288*4)');foreignLut.set(lut);
 assert.equal(foreignLut instanceof Float32Array,false,'fixture actually crosses a JavaScript realm');assert.equal(ArrayBuffer.isView(foreignLut),true);
 ({device,dom,compositor:c}=await create({lut:foreignLut}));assert.equal(c.ready,true);assert.ok(c.supportedAlgorithms.includes('ravu'));
 assert.deepEqual(Array.from(device.uploads[0].data.slice(0,4)),[0x3c00,0xb800,1,0x3c00],'foreign float LUT reaches the same binary16 upload');
 await c.destroy();assert.equal(dom.nodes.length,0);assert.ok(device.resources.every(resource=>resource.dead));
 for(const [label,invalidLut]of [['Uint32Array',new Uint32Array(13*288*4)],['wrong length',new Float32Array(13*288*4-1)],['regular array',Array(13*288*4).fill(0)]]){
  device=mock();dom=surface();await assert.rejects(API.create(device,dom.base,{lut:invalidLut,waitForCompletion:()=>device.wait()}),/requires the bundled/,label+' must be rejected');
  assert.equal(device.uploads.length,0,label+' must not upload misinterpreted LUT bytes');assert.equal(dom.nodes.length,0,label+' rejection removes the overlay');assert.equal(dom.base.style.opacity,'.75');assert.ok(device.resources.every(resource=>resource.dead),label+' rejection destroys all prior GPU allocations');
 }
 console.log('WebGPU compositor host ownership checks passed (mock GPU; no arithmetic or timing claim).');
})().catch(error=>{console.error(error);process.exitCode=1;});
