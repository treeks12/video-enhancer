/* Development-only readback harness. Not packaged in the extension. */
'use strict';
const log=document.getElementById('log'),button=document.getElementById('run');
async function bytes(path){const r=await fetch('fixtures/'+path);if(!r.ok)throw new Error(path+': HTTP '+r.status);return r.arrayBuffer();}
button.onclick=async()=>{
 button.disabled=true;log.textContent='';const report={kind:'untrained-graph-conformance',userAgent:navigator.userAgent,cases:[],errors:[]};
 const write=v=>{log.textContent+=v+'\n';};
 try{
  if(!navigator.gpu)throw new Error('WebGPU unavailable in this context. This test must not be marked PASS.');
  const reference=JSON.parse(new TextDecoder().decode(await bytes('reference.json'))),manifest=JSON.parse(new TextDecoder().decode(await bytes('model.json'))),bin=await bytes('model.bin');
  for(const half of [false,true]){
   // Fresh adapter per pass: this Chrome build consumes a GPUAdapter after one
   // requestDevice, so the shared adapter broke the FP16 half of the run.
   const adapter=await navigator.gpu.requestAdapter();if(!adapter)throw new Error('No WebGPU adapter');
   if(half&&!adapter.features.has('shader-f16')){write('SKIP FP16: shader-f16 unavailable');continue;}
   const device=await adapter.requestDevice({requiredFeatures:half?['shader-f16']:[]});const resources=[];let rt=null;
   device.pushErrorScope('validation');
   try{
    rt=await FiNeuralRuntime.create(device,{w:reference.modelWidth,h:reference.modelHeight,weightsBin:bin,weightsManifest:manifest,useF16:half});
    const w=reference.sourceWidth,h=reference.sourceHeight,stride=Math.ceil(w*4/256)*256;
    const texture=()=>{const t=device.createTexture({size:[w,h],format:'rgba8unorm',usage:GPUTextureUsage.COPY_DST|GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.STORAGE_BINDING|GPUTextureUsage.COPY_SRC});resources.push(t);return t;};
    const a=texture(),b=texture(),out=texture();
    device.queue.writeTexture({texture:a},await bytes('input-a.rgba'),{bytesPerRow:w*4},[w,h]);device.queue.writeTexture({texture:b},await bytes('input-b.rgba'),{bytesPerRow:w*4},[w,h]);
    const staging=device.createBuffer({size:stride*h,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});resources.push(staging);
    rt.prepPair(a,b);
    for(const test of reference.cases.filter(x=>x.half===half)){
     const start=performance.now();rt.runT(test.t,out);
     const enc=device.createCommandEncoder();enc.copyTextureToBuffer({texture:out},{buffer:staging,bytesPerRow:stride},[w,h]);device.queue.submit([enc.finish()]);await staging.mapAsync(GPUMapMode.READ);
     const data=new Uint8Array(staging.getMappedRange()),gold=new Uint8Array(await bytes(test.file));let max=0,sum=0,n=0;
     for(let y=0;y<h;y++)for(let x=0;x<w;x++)for(let c=0;c<4;c++){const d=Math.abs(data[y*stride+x*4+c]-gold[(y*w+x)*4+c]);max=Math.max(max,d);sum+=d;n++;}
     staging.unmap();const mseLimit=(test.t===0||test.t===1)?0:2;const passed=max<=mseLimit&&sum/n<=.35;
     const row={half,t:test.t,passed,maxByteError:max,meanByteError:sum/n,elapsedMs:performance.now()-start};report.cases.push(row);write(JSON.stringify(row));
    }
   }finally{const validation=await device.popErrorScope();if(validation)report.errors.push(validation.message);rt?.destroy();resources.forEach(r=>r.destroy());device.destroy();}
  }
  report.passed=report.cases.length>=5&&report.cases.every(x=>x.passed)&&report.errors.length===0;write(report.passed?'PASS: GPU kernels agree with CPU fixtures':'FAIL: investigate numerical/validation differences');
 }catch(error){report.passed=false;report.errors.push(error.message);write('FAIL: '+error.message);}
 finally{window.__neuralConformance=report;write(JSON.stringify(report,null,2));button.disabled=false;}
};
