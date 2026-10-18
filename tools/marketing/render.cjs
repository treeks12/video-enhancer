/* Rebuild marketing examples with released shaders, not photo retouching.
 * Use --download to fetch the six public sample images listed in media.json.
 * Outputs: docs/assets, icons/*.png, and promo PNGs in MARKETING_WORKDIR.
 * Run with NODE_PATH pointing to Playwright and CHROMIUM_PATH to Edge/Chrome.
 */
'use strict';
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),cp=require('node:child_process');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'../..'),work=path.resolve(process.env.MARKETING_WORKDIR||path.join(root,'dist/marketing')),assets=path.join(root,'docs/assets');
const examples=require('./media.json');
fs.mkdirSync(assets,{recursive:true});
const content=cp.execFileSync('git',['show','HEAD:content.js'],{cwd:root,encoding:'utf8',maxBuffer:4e6});
const literal=name=>{const match=content.match(new RegExp('const '+name+' = `([\\s\\S]*?)`;'));if(!match)throw Error('Missing '+name);return match[1];};
async function imageExamples({shaders,examples}){
 const sourceImage=async url=>{const image=new Image();image.src=url;await image.decode();return image;};
 const lut=new Float32Array(await(await fetch('/third_party/ravu-lite/ravu-lite-lut3.bin')).arrayBuffer());
 const canvas=document.createElement('canvas');canvas.width=1280;canvas.height=720;
 const gl=canvas.getContext('webgl2',{antialias:false,preserveDrawingBuffer:true});if(!gl.getExtension('EXT_color_buffer_float'))throw Error('Float color unavailable');
 gl.disable(gl.BLEND);gl.disable(gl.DITHER);gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,false);gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL,gl.NONE);
 function program(v,f){function shader(type,text){const s=gl.createShader(type);gl.shaderSource(s,text);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(s));return s;}const p=gl.createProgram();gl.attachShader(p,shader(gl.VERTEX_SHADER,v));gl.attachShader(p,shader(gl.FRAGMENT_SHADER,f));gl.linkProgram(p);if(!gl.getProgramParameter(p,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(p));return p;}
 const programs={direct:program(shaders.vert,shaders.frag),rcas:program(shaders.plain,shaders.frag),classify:program(shaders.plain,__fvRavuShaders.classify),filter:program(shaders.vert,__fvRavuShaders.step1),compose:program(shaders.plain,__fvRavuShaders.compose)};
 const vao=gl.createVertexArray();gl.bindVertexArray(vao);const buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),gl.STATIC_DRAW);gl.enableVertexAttribArray(0);gl.vertexAttribPointer(0,2,gl.FLOAT,false,0,0);
 const owned=[];
 function texture(w,h,float=false,pixels=null){const t=gl.createTexture();owned.push(t);gl.bindTexture(gl.TEXTURE_2D,t);for(const [p,v]of [[gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE],[gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE],[gl.TEXTURE_MIN_FILTER,float?gl.NEAREST:gl.LINEAR],[gl.TEXTURE_MAG_FILTER,float?gl.NEAREST:gl.LINEAR]])gl.texParameteri(gl.TEXTURE_2D,p,v);gl.texImage2D(gl.TEXTURE_2D,0,float?gl.RGBA16F:gl.RGBA8,w,h,0,gl.RGBA,float?gl.FLOAT:gl.UNSIGNED_BYTE,pixels);return t;}
 function target(w,h,float=false){const tex=texture(w,h,float),fbo=gl.createFramebuffer();gl.bindFramebuffer(gl.FRAMEBUFFER,fbo);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,tex,0);if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw Error('Framebuffer incomplete');return {tex,fbo};}
 function draw(p,target,w,h,inputs,uniforms={}){gl.bindFramebuffer(gl.FRAMEBUFFER,target?.fbo||null);gl.viewport(0,0,w,h);gl.useProgram(p);inputs.forEach(([name,t],unit)=>{gl.activeTexture(gl.TEXTURE0+unit);gl.bindTexture(gl.TEXTURE_2D,t);gl.uniform1i(gl.getUniformLocation(p,name),unit);});for(const [name,v]of Object.entries(uniforms)){const l=gl.getUniformLocation(p,name);if(Array.isArray(v))gl.uniform2f(l,...v);else if(name==='u_gradient_count')gl.uniform1i(l,v);else gl.uniform1f(l,v);}gl.drawArrays(gl.TRIANGLES,0,3);}
 function save(target){gl.bindFramebuffer(gl.FRAMEBUFFER,target.fbo);const raw=new Uint8Array(1280*720*4),flipped=new Uint8ClampedArray(raw.length);gl.readPixels(0,0,1280,720,gl.RGBA,gl.UNSIGNED_BYTE,raw);for(let y=0;y<720;y++)flipped.set(raw.subarray((719-y)*1280*4,(720-y)*1280*4),y*1280*4);const result=document.createElement('canvas');result.width=1280;result.height=720;result.getContext('2d').putImageData(new ImageData(flipped,1280,720),0,0);return result.toDataURL('image/webp',.94);}
 const lutGL=texture(13,288,true,lut),result=[];
 for(const entry of examples){const image=await sourceImage('/inputs/'+(entry.input||entry.id)+'.jpg');const small=document.createElement('canvas');small.width=640;small.height=360;const ctx=small.getContext('2d');const ratio=16/9,iw=image.naturalWidth,ih=image.naturalHeight;let crop=entry.crop;if(!crop){const w=Math.min(iw,ih*ratio),h=w/ratio;crop=[(iw-w)/2,(ih-h)/2,w,h];}ctx.drawImage(image,...crop,0,0,640,360);
  const pixels=ctx.getImageData(0,0,640,360).data,src=texture(640,360,false,pixels),before=target(1280,720),after=target(1280,720),classification=target(640,360),packed=target(640,360,true),composed=target(1280,720);
  draw(programs.direct,before,1280,720,[['u_tex',src]],{u_texel:[1/640,1/360],u_strength:0,u_compare:0});
  draw(programs.classify,classification,640,360,[['u_source',src]],{u_gradient_count:9});
  draw(programs.filter,packed,640,360,[['u_source',src],['u_lut',lutGL],['u_classification',classification.tex]]);
  draw(programs.compose,composed,1280,720,[['u_source',src],['u_packed',packed.tex]],{u_source_size:[640,360],u_output_texel:[1/1280,1/720],u_compare:0});
  draw(programs.rcas,after,1280,720,[['u_tex',composed.tex]],{u_texel:[1/1280,1/720],u_strength:.85,u_compare:0});
  result.push({id:entry.id,before:save(before),after:save(after)});for(const t of [before,after,classification,packed,composed])gl.deleteFramebuffer(t.fbo);
  if(gl.getError()!==gl.NO_ERROR)throw Error('Native shader error');
 }
 return result;
}
async function main(){let server,browser;try{
 fs.mkdirSync(work,{recursive:true});fs.mkdirSync(path.join(work,'popup'),{recursive:true});
 if(process.argv.includes('--download'))for(const entry of examples){const response=await fetch(entry.asset);if(!response.ok)throw Error('Media download '+response.status);fs.writeFileSync(path.join(work,(entry.input||entry.id)+'.jpg'),Buffer.from(await response.arrayBuffer()));}
 const python=process.env.PYTHON_PATH||'python';cp.execFileSync(python,['-c',"import importlib.util,pathlib,sys;root=pathlib.Path(sys.argv[1]);out=pathlib.Path(sys.argv[2]);s=importlib.util.spec_from_file_location('pack',root/'tools/package.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m);e=m.entries_for('firefox','store');[(out/n).write_bytes(e[n])for n in ['popup.html','popup.js','build-flavor.js']]",root,path.join(work,'popup')]);
 server=http.createServer((req,res)=>{const url=new URL(req.url,'http://localhost');let file;if(url.pathname.startsWith('/inputs/'))file=path.join(work,path.basename(url.pathname));else if(url.pathname==='/third_party/ravu-lite/ravu-lite-lut3.bin')file=path.join(root,url.pathname);else if(url.pathname==='/ravu.js')file=path.join(root,'third_party/ravu-lite/ravu-lite-webgl2.js');else if(url.pathname==='/popup/icons/icon.svg')file=path.join(root,'icons/icon.svg');else if(url.pathname.startsWith('/popup/'))file=path.join(work,'popup',path.basename(url.pathname));else if(url.pathname.startsWith('/assets/'))file=path.join(assets,path.basename(url.pathname));else if(url.pathname==='/icon.svg')file=path.join(root,'docs/icon.svg');else if(url.pathname==='/promos')file=path.join(__dirname,'promos.html');else if(url.pathname==='/')return res.end('<!doctype html><title>Native marketing renderer</title>');
  if(!file||!fs.existsSync(file)){res.statusCode=404;return res.end();}res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.html')?'text/html':file.endsWith('.webp')?'image/webp':file.endsWith('.png')?'image/png':file.endsWith('.svg')?'image/svg+xml':'application/octet-stream');res.end(fs.readFileSync(file));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{channel:'msedge'})});
 const iconPage=await browser.newPage();for(const size of [16,32,48,128]){await iconPage.setViewportSize({width:size,height:size});await iconPage.goto(origin+'/icon.svg');await iconPage.screenshot({path:path.join(root,'icons','icon-'+size+'.png'),omitBackground:true});}await iconPage.close();
 const page=await browser.newPage({viewport:{width:1600,height:1000},deviceScaleFactor:1});await page.goto(origin);await page.addScriptTag({url:origin+'/ravu.js'});
 for(const item of await page.evaluate(imageExamples,{shaders:{vert:literal('VERT'),plain:literal('VERT_PLAIN'),frag:literal('FRAG')},examples}))for(const side of ['before','after'])fs.writeFileSync(path.join(assets,item.id+'-'+side+'.webp'),Buffer.from(item[side].split(',')[1],'base64'));
 fs.writeFileSync(path.join(assets,'examples.json'),JSON.stringify(examples,null,2)+'\n');
 const popup=await browser.newPage({viewport:{width:392,height:1000},deviceScaleFactor:1});const releaseVersion=JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8')).version;await popup.addInitScript(version=>{const state={status:'ok',hasVideo:true,visible:true,pipeline:'RAVU-lite AR → RCAS · FI neural',canvasWidth:1920,canvasHeight:1080,settings:{mode:'ravu',strength:85,quality:'high',interaction:'smooth',outline:false,compare:false,fiInfra:true,fiEngine:'ifrnet',fiProfile:'quality',fiSceneCut:true,fiHalfLuma:true,fiBlockMatch:true},metrics:{fps:60,videoFps:60,midFps:60,renderScale:1,cpuMs:.4},fi:{backend:'IFRNet-S neural (WebGPU)',actualEngine:'ifrnet',profile:'quality',computeMs:12,presentationDelayMs:33.3,hasPair:true,realPerSec:60,midPerSec:60,method:'neural',neural:{completed:400,late:0,ms:12,modelSize:{width:512,height:288}}}};window.chrome={runtime:{getManifest:()=>({version})},storage:{local:{set:async()=>{}}},tabs:{query:async()=>[{id:1}],sendMessage:async()=>state}};},releaseVersion);
 await popup.goto(origin+'/popup/popup.html');await popup.waitForFunction(()=>['Active','Enhancing'].includes(document.querySelector('#label')?.textContent));await popup.locator('body').screenshot({path:path.join(assets,'popup.png')});
 await page.goto(origin+'/promos');await page.evaluate(()=>document.fonts.ready);for(const id of ['overview','cinema','gaming','creators','motion','feeds']){const el=page.locator('#'+id);await el.screenshot({path:path.join(work,id+'.png')});}
 await page.locator('#overview').screenshot({path:path.join(assets,'social.png')});
 console.log(JSON.stringify({examples:examples.length,promos:6,output:work,nativeShaders:'Released RAVU-lite + RCAS, 85% sharpness, 640x360 sample to 1280x720. Before is native bilinear enlargement; no added blur.'},null,2));
 }finally{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));}}
main().catch(e=>{console.error(e);process.exitCode=1;});
