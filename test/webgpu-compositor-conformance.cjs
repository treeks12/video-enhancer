// Development-only native WebGPU/WebGL spatial-port comparison; no playback claim.
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),os=require('node:os');
const puppeteer=require('puppeteer-core');
const root=path.resolve(__dirname,'..'),kind=process.env.TEST_BROWSER||'firefox';
assert.ok(['firefox','chromium'].includes(kind));
async function conformance(shaders){
 if(!navigator.gpu)throw new Error('Native WebGPU unavailable; compositor conformance was not run.');
 const adapter=await navigator.gpu.requestAdapter();if(!adapter)throw new Error('Native WebGPU adapter unavailable.');const device=await adapter.requestDevice();
 const errors=[],failures=[],results=[],tolerance={maxRgbBytes:3,meanRgbBytes:.4,alphaBytes:0};device.addEventListener('uncapturederror',event=>errors.push(event.error.message));
 const lut=new Float32Array(await (await fetch('/third_party/ravu-lite/ravu-lite-lut3.bin')).arrayBuffer());
 const base=document.createElement('canvas');base.width=64;base.height=48;base.style.cssText='position:absolute;left:0;top:0;width:128px;height:96px;';document.body.append(base);
 const gl=base.getContext('webgl2',{antialias:false,preserveDrawingBuffer:true});if(!gl?.getExtension('EXT_color_buffer_float'))throw new Error('RGBA16F WebGL reference unavailable.');
 gl.disable(gl.BLEND);gl.disable(gl.DITHER);gl.disable(gl.SCISSOR_TEST);gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,false);gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,false);gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL,gl.NONE);
 function program(vertex,fragment){function shader(type,source){const shader=gl.createShader(type);gl.shaderSource(shader,source);gl.compileShader(shader);if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(shader));return shader;}const v=shader(gl.VERTEX_SHADER,vertex),f=shader(gl.FRAGMENT_SHADER,fragment),p=gl.createProgram();gl.attachShader(p,v);gl.attachShader(p,f);gl.linkProgram(p);gl.deleteShader(v);gl.deleteShader(f);if(!gl.getProgramParameter(p,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(p));return p;}
 const compareUniform='uniform sampler2D u_comparison;\n';
 const direct=shaders.frag.replace('uniform sampler2D u_tex;','uniform sampler2D u_tex;\n'+compareUniform).replace('outColor = vec4(texture(u_tex, v_uv).rgb, 1.0);','outColor = vec4(compare && v_uv.x < 0.5 ? texture(u_comparison, v_uv).rgb : texture(u_tex, v_uv).rgb, 1.0);');
 const compose=__fvRavuShaders.compose.replace('uniform sampler2D u_source;','uniform sampler2D u_source;\n'+compareUniform).replace('outColor = vec4(original, 1.0);','outColor = vec4(texture(u_comparison, vec2(v_uv.x, 1.0-v_uv.y)).rgb, 1.0);');
 const programs={direct:program(shaders.vert,direct),rcas:program(shaders.plain,direct),classify:program(shaders.plain,__fvRavuShaders.classify),filter:program(shaders.vert,__fvRavuShaders.step1),compose:program(shaders.plain,compose)};
 const vao=gl.createVertexArray();gl.bindVertexArray(vao);const buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),gl.STATIC_DRAW);gl.enableVertexAttribArray(0);gl.vertexAttribPointer(0,2,gl.FLOAT,false,0,0);
 const textures=[],fbos=[];
 function texture(w,h,float=false,data=null){const texture=gl.createTexture();textures.push(texture);gl.bindTexture(gl.TEXTURE_2D,texture);for(const [p,v]of [[gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE],[gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE],[gl.TEXTURE_MIN_FILTER,float?gl.NEAREST:gl.LINEAR],[gl.TEXTURE_MAG_FILTER,float?gl.NEAREST:gl.LINEAR]])gl.texParameteri(gl.TEXTURE_2D,p,v);gl.texImage2D(gl.TEXTURE_2D,0,float?gl.RGBA16F:gl.RGBA8,w,h,0,gl.RGBA,float?gl.FLOAT:gl.UNSIGNED_BYTE,data);return texture;}
 function target(w,h,float=false){const tex=texture(w,h,float),fbo=gl.createFramebuffer();fbos.push(fbo);gl.bindFramebuffer(gl.FRAMEBUFFER,fbo);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,tex,0);if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw new Error('Reference framebuffer incomplete');return {tex,fbo,w,h};}
 const lutGL=texture(13,288,true,lut);
 function draw(p,target,w,h,inputs,uniforms={}){gl.bindFramebuffer(gl.FRAMEBUFFER,target?.fbo||null);gl.viewport(0,0,w,h);gl.useProgram(p);inputs.forEach(([name,texture],unit)=>{gl.activeTexture(gl.TEXTURE0+unit);gl.bindTexture(gl.TEXTURE_2D,texture);gl.uniform1i(gl.getUniformLocation(p,name),unit);});for(const [name,value]of Object.entries(uniforms)){const location=gl.getUniformLocation(p,name);if(Array.isArray(value))gl.uniform2f(location,...value);else if(name==='u_gradient_count')gl.uniform1i(location,value);else gl.uniform1f(location,value);}gl.drawArrays(gl.TRIANGLES,0,3);}
 function reference(pixels,comparison,sw,sh,ow,oh,algorithm,strength,compare){
  const src=texture(sw,sh,false,pixels),other=texture(sw,sh,false,comparison),output=target(ow,oh);
  if(algorithm==='ravu'){
   const classification=target(sw,sh),packed=target(sw,sh,true),composed=strength>0?target(ow,oh):output;
   draw(programs.classify,classification,sw,sh,[['u_source',src]],{u_gradient_count:9});
   draw(programs.filter,packed,sw,sh,[['u_source',src],['u_lut',lutGL],['u_classification',classification.tex]]);
   draw(programs.compose,composed,ow,oh,[['u_source',src],['u_packed',packed.tex],['u_comparison',other]],{u_source_size:[sw,sh],u_output_texel:[1/ow,1/oh],u_compare:compare?1:0});
   if(strength>0)draw(programs.rcas,output,ow,oh,[['u_tex',composed.tex],['u_comparison',composed.tex]],{u_texel:[1/ow,1/oh],u_strength:strength,u_compare:compare?1:0});
  }else draw(programs.direct,output,ow,oh,[['u_tex',src],['u_comparison',other]],{u_texel:[1/sw,1/sh],u_strength:algorithm==='native'?0:strength,u_compare:compare?1:0});
  gl.bindFramebuffer(gl.FRAMEBUFFER,output.fbo);const bytes=new Uint8Array(ow*oh*4),top=new Uint8Array(bytes.length);gl.readPixels(0,0,ow,oh,gl.RGBA,gl.UNSIGNED_BYTE,bytes);
  for(let y=0;y<oh;y++)top.set(bytes.subarray((oh-1-y)*ow*4,(oh-y)*ow*4),y*ow*4);if(gl.getError()!==gl.NO_ERROR)throw new Error('WebGL reference error');
  for(const fbo of fbos.splice(0))gl.deleteFramebuffer(fbo);for(const texture of textures.splice(1))gl.deleteTexture(texture);return top;
 }
 function fixture(w,h,pattern,frame=0){const pixels=new Uint8Array(w*h*4);for(let y=0;y<h;y++)for(let x=0;x<w;x++){const i=(y*w+x)*4;if(pattern==='smooth'){pixels[i]=Math.round(111+51*Math.sin((x-frame)*.13)+21*Math.cos(y*.07));pixels[i+1]=Math.round(113+39*Math.cos(x*.08+y*.11+frame*.2));pixels[i+2]=Math.round(125+47*Math.sin(y*.09-x*.05));}else{pixels[i]=x<w/2?32:221;pixels[i+1]=y<h/3?205:42;pixels[i+2]=(Math.floor(x/5)+Math.floor(y/7))%2?181:63;}pixels[i+3]=255;}return pixels;}
 async function read(texture,w,h){const stride=Math.ceil(w*4/256)*256,buffer=device.createBuffer({size:stride*h,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});try{const encoder=device.createCommandEncoder();encoder.copyTextureToBuffer({texture},{buffer,bytesPerRow:stride},[w,h]);device.queue.submit([encoder.finish()]);await buffer.mapAsync(GPUMapMode.READ);const mapped=new Uint8Array(buffer.getMappedRange()),pixels=new Uint8Array(w*h*4);for(let y=0;y<h;y++)pixels.set(mapped.subarray(y*stride,y*stride+w*4),y*w*4);buffer.unmap();return pixels;}finally{buffer.destroy();}}
 function record(label,actual,expected){let max=0,total=0,alpha=0;for(let i=0;i<actual.length;i++){const delta=Math.abs(actual[i]-expected[i]);if(i%4===3)alpha=Math.max(alpha,delta);else{max=Math.max(max,delta);total+=delta;}}const result={label,maxRgbBytes:max,meanRgbBytes:total/(actual.length/4*3),alphaBytes:alpha};result.passed=max<=tolerance.maxRgbBytes&&result.meanRgbBytes<=tolerance.meanRgbBytes&&alpha===0;results.push(result);console.log('compositor '+JSON.stringify(result));if(!result.passed)failures.push(label);}
 let compositor;
 try{
  for(const mode of ['rgba','external']){
   if(mode==='external'&&typeof VideoFrame!=='function')throw new Error('VideoFrame unavailable; both source routes are required.');
   compositor=await VENeuralCompositor.create(device,base,{captureMode:mode,lut});compositor.setVisible(true);
   for(const pattern of ['smooth','edges'])for(const [sw,sh,ow,oh]of [[32,24,64,48],[32,24,48,36],[32,24,64,48]]){
    base.width=ow;base.height=oh;const pixels=fixture(sw,sh,pattern),other=fixture(sw,sh,'smooth',4),owned=[];
    function source(data){if(mode==='rgba'){const texture=device.createTexture({size:[sw,sh],format:'rgba8unorm',usage:GPUTextureUsage.COPY_DST|GPUTextureUsage.TEXTURE_BINDING});device.queue.writeTexture({texture},data,{bytesPerRow:sw*4},[sw,sh]);owned.push({close:()=>texture.destroy()});return {texture};}const canvas=document.createElement('canvas');canvas.width=sw;canvas.height=sh;canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(data),sw,sh),0,0);const frame=new VideoFrame(canvas,{timestamp:0});owned.push(frame);return {external:device.importExternalTexture({source:frame,colorSpace:'srgb'})};}
    const src=source(pixels),comparison=source(other);
    try{
     for(const algorithm of ['native','rcas','ravu'])for(const strength of algorithm==='native'?[0]:[0,.65,1])for(const compare of [false,true]){
      device.pushErrorScope('validation');const label=[mode,pattern,`${sw}x${sh}-${ow}x${oh}`,algorithm,strength,compare].join('/');
      if(!compositor.render(src,sw,sh,{algorithm,strength,compare}))throw new Error(label+': unexpected bounded-submission refusal');await compositor.whenIdle();
      record(label,await read(compositor.output,ow,oh),reference(pixels,pixels,sw,sh,ow,oh,algorithm,strength,compare));const error=await device.popErrorScope();if(error)throw new Error(label+': '+error.message);
     }
     for(const algorithm of ['native','rcas','ravu']){
      const label=[mode,pattern,'comparisonSource',algorithm].join('/');if(!compositor.render(src,sw,sh,{algorithm,strength:.65,compare:true,comparisonSource:comparison}))throw new Error('Comparison render refused');await compositor.whenIdle();record(label,await read(compositor.output,ow,oh),reference(pixels,other,sw,sh,ow,oh,algorithm,.65,true));
     }
     const snapshot=compositor.snapshot(compositor.output,ow,oh,0);if(!snapshot)throw new Error('Snapshot unexpectedly refused');await compositor.whenIdle();const before=await read(snapshot,ow,oh);
     compositor.render(comparison,sw,sh,{algorithm:'native'});await compositor.whenIdle();record(mode+'/snapshot-retained',await read(snapshot,ow,oh),before);
     if(compositor.shapes.size>2||compositor.memoryBytes>96*1024*1024)throw new Error('Compositor ownership budget exceeded');
    }finally{await compositor.whenIdle();for(const item of owned)item.close();}
   }
   await compositor.destroy();compositor=null;
  }
  if(errors.length)failures.push('uncaptured GPU errors: '+errors.join('; '));return {tolerance,cases:results.length,results,failures,errors,passed:failures.length===0};
 }finally{await compositor?.destroy();for(const p of Object.values(programs))gl.deleteProgram(p);gl.deleteTexture(lutGL);gl.deleteBuffer(buffer);gl.deleteVertexArray(vao);base.remove();device.destroy();}
}
(async()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'webgpu-compositor-'));let browser,server;
 try{
  const files=new Set(['neural/webgpu-compositor.js','third_party/ravu-lite/ravu-lite-webgl2.js','third_party/ravu-lite/ravu-lite-lut3.bin']);
  const content=fs.readFileSync(path.join(root,'content.js'),'utf8'),literal=name=>{const match=content.match(new RegExp('const '+name+' = `([\\s\\S]*?)`;'));assert.ok(match,name+' shader exists');return match[1];};
  const shaders={vert:literal('VERT'),plain:literal('VERT_PLAIN'),frag:literal('FRAG')};
  server=http.createServer((req,res)=>{const file=req.url?.slice(1);if(files.has(file)){res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':'application/octet-stream');res.end(fs.readFileSync(path.join(root,file)));}else if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Native WebGPU compositor conformance</title><body>Spatial port regression</body>');}else{res.statusCode=404;res.end();}});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  browser=await puppeteer.launch({browser:kind==='firefox'?'firefox':'chrome',headless:process.env.HEADLESS?process.env.HEADLESS!=='0':kind!=='firefox',userDataDir:temp,executablePath:kind==='firefox'?(process.env.FIREFOX_PATH||'C:/Program Files/Mozilla Firefox/firefox.exe'):(process.env.CHROMIUM_PATH||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'),defaultViewport:{width:800,height:500},timeout:60000,protocolTimeout:300000});
  const page=await browser.newPage(),pageErrors=[];page.on('pageerror',error=>pageErrors.push(error.message));page.on('console',message=>{if(message.text().startsWith('compositor '))console.log(message.text());});await page.bringToFront();await page.goto(`http://127.0.0.1:${server.address().port}/`);
  for(const file of ['third_party/ravu-lite/ravu-lite-webgl2.js','neural/webgpu-compositor.js'])await page.addScriptTag({url:'/'+file});
  const result=await page.evaluate(conformance,shaders),{results,...summary}=result;console.log(JSON.stringify({browser:await browser.version(),...summary,pageErrors},null,2));assert.deepEqual(pageErrors,[]);assert.ok(result.passed,'Native compositor conformance failures: '+result.failures.join(', '));
 }finally{try{await browser?.close();}finally{if(server?.listening)await new Promise(resolve=>server.close(resolve));const target=fs.realpathSync(temp),parent=fs.realpathSync(os.tmpdir());assert.equal(path.dirname(target),parent);assert.ok(path.basename(target).startsWith('webgpu-compositor-'));fs.rmSync(target,{recursive:true,force:true});}}
})().catch(error=>{console.error(error);process.exitCode=1;});
