// Native trained-checkpoint host-composition regression, development only.
// Executes the complete shipping WebGPU and WebGL engines. This is not an
// interpolation-quality benchmark or a claim about arbitrary real videos.
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),os=require('node:os');
const puppeteer=require('puppeteer-core');
const root=path.resolve(__dirname,'..'),kind=process.env.TEST_BROWSER||'firefox';
assert.ok(['firefox','chromium'].includes(kind),'TEST_BROWSER must be firefox or chromium');

async function integration(captureModes=['rgba','external'],kernelOptions={}){
 const response=await fetch('/models/ifrnet.bin');
 if(!response.ok)throw new Error('Bundled trained IFRNet checkpoint unavailable: '+response.status);
 const bytes=new Uint8Array(await response.arrayBuffer());await VENeuralSpec.verifyBytes(bytes);
 if(!navigator.gpu)throw new Error('Native WebGPU unavailable; integration was not run');
 if(typeof VideoFrame!=='function')throw new Error('VideoFrame unavailable; both capture modes must be tested');
 const canvas=document.createElement('canvas');canvas.width=128;canvas.height=96;
 const gl=canvas.getContext('webgl2',{antialias:false,preserveDrawingBuffer:true});
 if(!gl||!gl.getExtension('EXT_color_buffer_float'))throw new Error('Floating-point WebGL2 reference unavailable');
 gl.disable(gl.DITHER);gl.disable(gl.BLEND);gl.disable(gl.SCISSOR_TEST);
 gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,false);gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,false);
 gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL,gl.NONE);
 const fbo=gl.createFramebuffer(),results=[],failures=[],gpuErrors=[];
 const tolerance={maxRgbBytes:3,meanRgbBytes:.4,alphaBytes:0};
 const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 function fixture(width,height,frame){
  const pixels=new Uint8Array(width*height*4),surface=document.createElement('canvas');surface.width=width;surface.height=height;
  Object.defineProperties(surface,{videoWidth:{get:()=>surface.width},videoHeight:{get:()=>surface.height},currentTime:{value:frame/60}});
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
   const xx=x-frame*1.5,yy=y-frame*.65,i=(y*width+x)*4;
   const spot=Math.exp(-((xx-width*.34)**2+(yy-height*.6)**2)/(width*height*.035));
   pixels[i]=Math.round(117+44*Math.sin(xx*.071)+18*Math.cos(yy*.083)+17*spot);
   pixels[i+1]=Math.round(119+37*Math.cos(xx*.047+yy*.061)+20*y/height-14*spot);
   pixels[i+2]=Math.round(121+39*Math.sin(yy*.057-xx*.035)+15*x/width+10*spot);pixels[i+3]=255;
  }
  const context=surface.getContext('2d');
  return {width,height,pixels,canvas:surface,restore(){context.putImageData(new ImageData(new Uint8ClampedArray(pixels),width,height),0,0);},mutate(){context.fillStyle='#ff00ff';context.fillRect(0,0,width,height);}};
 }
 function texture(width,height){
  const tex=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,tex);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA8,width,height,0,gl.RGBA,gl.UNSIGNED_BYTE,null);return tex;
 }
 function upload(tex,frame,route){
  gl.bindTexture(gl.TEXTURE_2D,tex);
  if(route==='canvas')gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,gl.RGBA,gl.UNSIGNED_BYTE,frame.canvas);
  else gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,frame.width,frame.height,gl.RGBA,gl.UNSIGNED_BYTE,frame.pixels);
 }
 function read(tex,width,height){
  gl.bindFramebuffer(gl.FRAMEBUFFER,fbo);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,tex,0);
  if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw new Error('Integration framebuffer incomplete');
  const pixels=new Uint8Array(width*height*4);gl.readPixels(0,0,width,height,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
  gl.bindFramebuffer(gl.FRAMEBUFFER,null);return pixels;
 }
 function difference(actual,expected){
  let max=0,total=0,alpha=0;
  for(let i=0;i<actual.length;i++){const d=Math.abs(actual[i]-expected[i]);if(i%4===3)alpha=Math.max(alpha,d);else{max=Math.max(max,d);total+=d;}}
  return {maxRgbBytes:max,meanRgbBytes:total/(actual.length/4*3),alphaBytes:alpha};
 }
 function record(label,details,actual,expected){
  const metric=difference(actual,expected),passed=metric.maxRgbBytes<=tolerance.maxRgbBytes&&metric.meanRgbBytes<=tolerance.meanRgbBytes&&metric.alphaBytes<=tolerance.alphaBytes;
  const result={label,...details,...metric,passed};results.push(result);
  // Report every comparison before the Node-side final assertion. Tolerances
  // are fixed here and are never expanded in response to a failing case.
  console.log('integration '+JSON.stringify(result));if(!passed)failures.push(label+' '+JSON.stringify(metric));
 }
 function check(condition,message){if(!condition){failures.push(message);console.log('integration '+JSON.stringify({label:message,passed:false}));}}
 function glError(label){const error=gl.getError();if(error!==gl.NO_ERROR)throw new Error(label+': WebGL error '+error);}
 let reference=null;
 try{
  // Each engine receives an independent binary copy. The production decoder
  // releases its own decoded weight arrays after uploading them.
  reference=await VENeuralRuntime.create(gl,new Uint8Array(bytes),96,64,'balanced');
  // This is a numerical reference at tiny tensor sizes. Keep its initial work
  // budget fixed so a browser's cached fence notification timing cannot turn
  // the comparison into thousands of timer-bound tiles. Production adaptation
  // and deadlines have dedicated host and native playback regressions.
  reference.dispatchWork=32*1024*1024;reference.adaptDispatchWork=()=>{};
  for(const mode of captureModes){
   let warm=null,fresh=null;const textures=[];
   try{
    await reference.resize(96,64,'balanced');
    warm=await VENeuralWebGPU.create(gl,new Uint8Array(bytes),96,64,'balanced',0,null,{...kernelOptions,captureMode:mode});
    fresh=await VENeuralWebGPU.create(gl,new Uint8Array(bytes),96,64,'balanced',0,null,{...kernelOptions,captureMode:mode});
    check(warm.captureMode===mode&&fresh.captureMode===mode,mode+': required capture mode selected');
    for(const [name,engine]of [['warm',warm],['fresh',fresh]])engine.device.addEventListener('uncapturederror',event=>gpuErrors.push({mode,engine:name,message:event.error.message}));
    let width=96,height=64,inputs=[],targets=[];
    const allocate=()=>{
     for(const tex of [...inputs,...targets]){gl.deleteTexture(tex);textures.splice(textures.indexOf(tex),1);}
     inputs=Array.from({length:4},()=>texture(width,height));targets=Array.from({length:3},()=>texture(width,height));textures.push(...inputs,...targets);
    };
    allocate();
    async function pair(frames,index,phase,debug,direction,label){
     const previous=frames[index-1],current=frames[index],route=index%2?'bytes':'canvas';
     previous.restore();current.restore();const prev=inputs[(index-1)%4],curr=inputs[index%4];upload(prev,previous,route);upload(curr,current,route);
     reference.reset();fresh.reset();
     warm.device.pushErrorScope('validation');fresh.device.pushErrorScope('validation');
     let warmPopped=false,freshPopped=false;
     try{
      if(index===1)check(warm.captureFrame(previous.canvas,index-1),label+': first warm snapshot captured');
      check(warm.captureFrame(current.canvas,index),label+': current warm snapshot captured');
      check(fresh.captureFrame(previous.canvas,index-1)&&fresh.captureFrame(current.canvas,index),label+': fresh pair captured');
      // Both the GPU copy and VideoFrame route must retain the original pair
      // across a task delay even after the source canvas has changed.
      previous.mutate();current.mutate();await pause(40);
      const expectedResult=await reference.estimate(prev,curr,index,phase,{valid:()=>true,cacheValid:()=>true});
      const warmResult=await warm.estimate(prev,curr,index,phase,{debug,valid:()=>true,cacheValid:()=>true});
      const freshResult=await fresh.estimate(prev,curr,index,phase,{debug,valid:()=>true,cacheValid:()=>true});
      if(!expectedResult?.valid||!warmResult?.valid||!freshResult?.valid)throw new Error(label+': complete prediction unavailable');
      check(!expectedResult.reusedEncoder,label+': WebGL reference encodes both endpoints freshly');
      check(warmResult.reusedEncoder===(index>1),label+': adjacent warm encoder reuse');
      check(!freshResult.reusedEncoder,label+': fresh WebGPU encoder reference');
      check(warm.lastSlot===(index%2),label+': both encoder slot orientations');
      check(reference.render(prev,curr,targets[0],width,height,debug),label+': GL synthesis rendered');
      const expected=read(targets[0],width,height);
      check(warm.render(prev,curr,targets[1],width,height,debug),label+': warm GPU canvas interop rendered');
      const warmPixels=read(targets[1],width,height);
      check(fresh.render(prev,curr,targets[2],width,height,debug),label+': fresh GPU canvas interop rendered');
      const freshPixels=read(targets[2],width,height);
      const detail={captureMode:mode,phase,debug,direction,pair:index,reusedEncoder:warmResult.reusedEncoder,slot:warm.lastSlot,width,height,glUpload:route};
      record(label+'/warm-vs-gl',detail,warmPixels,expected);
      record(label+'/fresh-vs-gl',detail,freshPixels,expected);
      record(label+'/warm-vs-fresh',detail,warmPixels,freshPixels);
      glError(label);
      const warmError=await warm.device.popErrorScope();warmPopped=true;
      const freshError=await fresh.device.popErrorScope();freshPopped=true;
      if(warmError||freshError)throw new Error(label+': GPU validation '+(warmError?.message||freshError?.message));
      check(warm.sources.length<=4&&warm.shapes.size<=2,label+': bounded source/shape ownership');
     }finally{if(!warmPopped)await warm.device.popErrorScope().catch(()=>{});if(!freshPopped)await fresh.device.popErrorScope().catch(()=>{});}
    }
    for(const direction of ['forward','reverse'])for(const phase of [.35,.5,.7])for(const debug of ['off','flow','mask','residual']){
     warm.reset();const order=direction==='forward'?[0,1,2,3]:[3,2,1,0],frames=order.map(frame=>fixture(width,height,frame));
     for(let index=1;index<=3;index++)await pair(frames,index,phase,debug,direction,`${mode}/${direction}/${phase}/${debug}/${index}`);
    }
    // Reset must reject an old result and source epoch immediately.
    warm.reset();check(!warm.render(inputs[2],inputs[3],targets[1],width,height,'residual'),mode+': reset invalidates old output');
    check(await warm.estimate(inputs[2],inputs[3],3,.5)===null,mode+': reset rejects uncaptured old source epoch');
    for(const next of [[128,64],[96,64],[128,64]]){
     [width,height]=next;await reference.resize(width,height);await warm.resize(width,height);await fresh.resize(width,height);allocate();
     check(await warm.estimate(inputs[0],inputs[1],1,.5)===null,mode+': resize rejects old source epoch');
     const frames=Array.from({length:4},(_,frame)=>fixture(width,height,frame));
     await pair(frames,1,.5,'off','forward',`${mode}/resize/${width}x${height}/${warm.diagnostics.resizes}`);
    }
    check(warm.diagnostics.shapeBuilds===2&&warm.diagnostics.shapeHits>=2,mode+': repeated shapes reuse prepared graphs');
    warm.check();fresh.check();glError(mode+' final');
   }finally{
    if(warm)await warm.destroy();if(fresh)await fresh.destroy();for(const tex of textures)gl.deleteTexture(tex);
   }
  }
  if(gpuErrors.length)failures.push('uncaptured GPU errors: '+JSON.stringify(gpuErrors));
  return {fixture:'Pinned bundled trained IFRNet-S; smooth moving RGB canvas fixtures; whole shipping WebGPU vs fresh WebGL graph and fresh WebGPU host',
   interpretation:'Trained-model port/interop/reuse regression only; no claim about arbitrary-video interpolation quality or playback performance',
   kernelOptions,tolerance,results,failures,gpuErrors,passed:failures.length===0};
 }finally{reference?.destroy();VENeuralDevice.dispose();gl.deleteFramebuffer(fbo);gl.getExtension('WEBGL_lose_context')?.loseContext();}
}

(async()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'ifrnet-integration-'));let browser,server;
 try{
  const files=['neural/webgpu-device.js','neural/model-spec.js','neural/graph.js','neural/runtime.js','neural/webgpu-shaders.js','neural/webgpu-runtime.js'],allowed=new Set([...files,'models/ifrnet.bin']);
  server=http.createServer((req,res)=>{
   const name=req.url?.slice(1);
   if(allowed.has(name)){res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':'application/octet-stream');res.end(fs.readFileSync(path.join(root,name)));}
   else if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>IFRNet host integration</title><body>Native IFRNet integration</body>');}
   else{res.statusCode=404;res.end();}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  browser=await puppeteer.launch({browser:kind==='firefox'?'firefox':'chrome',headless:process.env.HEADLESS?process.env.HEADLESS!=='0':kind!=='firefox',userDataDir:temp,
   executablePath:kind==='firefox'?(process.env.FIREFOX_PATH||'C:/Program Files/Mozilla Firefox/firefox.exe'):
    (process.env.CHROMIUM_PATH||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'),
   defaultViewport:{width:800,height:500},timeout:60000,protocolTimeout:300000});
  const page=await browser.newPage(),pageErrors=[];page.on('pageerror',error=>pageErrors.push(error.message));
  page.on('console',message=>{if(message.text().startsWith('integration '))console.log(message.text());});
  await page.bringToFront();await page.goto(`http://127.0.0.1:${server.address().port}/`);
  for(const file of files)await page.addScriptTag({url:'/'+file});
  const captureModes=process.env.IFRNET_CAPTURE_MODES?process.env.IFRNET_CAPTURE_MODES.split(','):['rgba','external'];
  assert.ok(captureModes.length&&captureModes.every(mode=>['rgba','external','snapshot'].includes(mode)),'supported capture modes');
  const stagedStorage=process.env.IFRNET_STAGED_STORAGE==='1';
  const kernelOptions=stagedStorage||process.env.IFRNET_GENERIC_STORAGE==='1'?{storageTiles:true,compact:true,genericStorage:true,...(stagedStorage?{stagedStorage:true}:{})}:{};
  if(process.env.IFRNET_FILTERED_SOURCES==='1')kernelOptions.filteredSources=true;
  if(process.env.IFRNET_GENERIC_CONCAT==='1')kernelOptions.genericConcat=true;
  if(process.env.IFRNET_GENERIC_FLOW==='1')kernelOptions.genericFlow=true;
  const result=await page.evaluate(integration,captureModes,kernelOptions),{results,...summary}=result;
  console.log(JSON.stringify({browser:await browser.version(),cases:results.length,...summary,pageErrors},null,2));
  assert.deepEqual(pageErrors,[],'browser page errors');assert.ok(result.passed,'Native trained IFRNet integration failures: '+result.failures.join(', '));
 }finally{
  try{await browser?.close();}finally{
   if(server?.listening)await new Promise(resolve=>server.close(resolve));
   const target=fs.realpathSync(temp),parent=fs.realpathSync(os.tmpdir());assert.equal(path.dirname(target),parent);assert.ok(path.basename(target).startsWith('ifrnet-integration-'));
   fs.rmSync(target,{recursive:true,force:true});
  }
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
