// Host API contract fake. Does NOT compile WGSL or execute GPU arithmetic.
const assert=require('node:assert/strict');
const usage={STORAGE:128,COPY_DST:8,UNIFORM:64,MAP_READ:1,COPY_SRC:4};
global.GPUBufferUsage=usage;global.GPUTextureUsage={STORAGE_BINDING:8,TEXTURE_BINDING:4,COPY_DST:2,RENDER_ATTACHMENT:16,COPY_SRC:1};
function mockDevice({half=false,compileFailure=false}={}) {
 const allocations=[],submissions=[],shaders=[],writes=[];let next=0,bindings=0;
 const device={features:new Set(half?['shader-f16']:[]),limits:{maxStorageBufferBindingSize:128*1024*1024,maxTextureDimension2D:8192},lost:new Promise(()=>{}),
 createBuffer(spec){const b={...spec,id:++next,type:'buffer',dead:false,destroy(){this.dead=true;}};allocations.push(b);return b;},
 createTexture(spec){const t={...spec,width:spec.size[0],height:spec.size[1],id:++next,type:'texture',dead:false,destroy(){this.dead=true;},createView(){assert.ok(!this.dead,'view of dead texture');return {texture:this};}};allocations.push(t);return t;},
 createSampler(){return {type:'sampler'};},
 createShaderModule(spec){shaders.push(spec);return {...spec,getCompilationInfo:async()=>({messages:compileFailure?[{type:'error',message:'injected compiler failure'}]:[]})};},
 async createComputePipelineAsync(spec){return {...spec,getBindGroupLayout(){return {code:spec.compute.module.code};}};},
 async createRenderPipelineAsync(spec){return {...spec,getBindGroupLayout(){return {render:true};}};},
 createBindGroup(spec){bindings++;if(spec.layout.code){const expected=[...spec.layout.code.matchAll(/@binding\((\d+)\)/g)].map(m=>Number(m[1]));assert.deepEqual(spec.entries.map(x=>x.binding),expected);}
  for(const entry of spec.entries){const r=entry.resource?.buffer||entry.resource?.texture;assert.ok(!r?.dead,'binding dead resource');}return spec;},
 createCommandEncoder(){const stages=[];return {beginComputePass(){let pipeline,group;return {setPipeline(p){pipeline=p;},setBindGroup(i,g){group=g;},dispatchWorkgroups(...dims){assert.ok(dims.every(x=>Number.isInteger(x)&&x>0));stages.push({label:pipeline.label,group,dims});},end(){}};},beginRenderPass(){return {setPipeline(){},setBindGroup(){},draw(){},end(){}};},finish(){return {stages};}};},
 pushErrorScope(){},async popErrorScope(){return null;},destroy(){device.dead=true;},addEventListener(){},
 queue:{submit(commands){submissions.push(...commands);},writeBuffer(buffer,offset,data){assert.ok(!buffer.dead);assert.ok(offset+data.byteLength<=buffer.size);writes.push({buffer,offset,data:data.slice?.()||data});},onSubmittedWorkDone:async()=>{},copyExternalImageToTexture(source,destination){assert.ok(!destination.texture.dead);}},
 allocations,submissions,shaders,writes,get bindingCount(){return bindings;}};
 return device;
}
module.exports={mockDevice};
