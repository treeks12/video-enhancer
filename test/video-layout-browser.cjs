// Native video versus the real identity-mode overlay. Browser profiles and
// screenshots are disposable; requires Puppeteer Core and a WebGL2 browser.
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const os=require('node:os'),http=require('node:http'),zlib=require('node:zlib'),puppeteer=require('puppeteer-core');
const root=path.resolve(__dirname,'..'),kind=process.env.TEST_BROWSER||'firefox';
assert.ok(['firefox','chromium'].includes(kind));

// Browser screenshots use noninterlaced 8-bit RGB/RGBA PNGs. Decode locally to
// avoid adding a dependency to the extension or changing its package files.
function png(bytes){
 bytes=Buffer.from(bytes);let offset=8,w,h,channels;const parts=[];
 assert.equal(bytes.subarray(1,4).toString(),'PNG');
 while(offset<bytes.length){const n=bytes.readUInt32BE(offset),type=bytes.toString('ascii',offset+4,offset+8),data=bytes.subarray(offset+8,offset+8+n);offset+=n+12;
  if(type==='IHDR'){w=data.readUInt32BE(0);h=data.readUInt32BE(4);assert.equal(data[8],8);channels=data[9]===6?4:data[9]===2?3:0;assert.ok(channels);assert.equal(data[12],0);}
  if(type==='IDAT')parts.push(data);if(type==='IEND')break;
 }
 const raw=zlib.inflateSync(Buffer.concat(parts)),stride=w*channels,out=Buffer.alloc(stride*h);let input=0;
 const paeth=(a,b,c)=>{const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);return pa<=pb&&pa<=pc?a:pb<=pc?b:c;};
 for(let y=0;y<h;y++){const filter=raw[input++];assert.ok(filter<=4);
  for(let x=0;x<stride;x++){const i=y*stride+x,a=x>=channels?out[i-channels]:0,b=y?out[i-stride]:0,c=y&&x>=channels?out[i-stride-channels]:0;
   const prediction=filter===0?0:filter===1?a:filter===2?b:filter===3?Math.floor((a+b)/2):paeth(a,b,c);out[i]=(raw[input++]+prediction)&255;}
 }
 return {w,h,channels,data:out};
}
function compare(nativeBytes,overlayBytes){
 const a=png(nativeBytes),b=png(overlayBytes);assert.equal(a.w,b.w);assert.equal(a.h,b.h);
 let total=0,count=0,bad=0,max=0;
 // Solid regions provide an independent geometric oracle. Skip native image
 // boundaries: browsers may choose different video versus WebGL filters there.
 for(let y=3;y<a.h-3;y+=3)for(let x=3;x<a.w-3;x+=3){
  const stable=[[-2,0],[2,0],[0,-2],[0,2]].every(([dx,dy])=>[0,1,2].every(c=>Math.abs(a.data[(y*a.w+x)*a.channels+c]-a.data[((y+dy)*a.w+x+dx)*a.channels+c])<=3));
  if(!stable)continue;let difference=0;
  for(let c=0;c<3;c++)difference=Math.max(difference,Math.abs(a.data[(y*a.w+x)*a.channels+c]-b.data[(y*b.w+x)*b.channels+c]));
  total+=difference;max=Math.max(max,difference);count++;if(difference>8)bad++;
 }
 assert.ok(count>500,'sufficient solid video and surrounding pixels must be compared');
 return {samples:count,mean:total/count,badFraction:bad/count,max};
}

(async()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'video-enhancer-layout-'));
 const scripts=['feed-session.js','fi-quality.js','fi-core.js','content.js'].map(name=>fs.readFileSync(path.join(root,name),'utf8'));
 let browser,server;const results=[],errors=[];
 try{
  server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end(`<!doctype html><style>
   html,body{margin:0;background:#171b22}body{height:1800px;padding:80px;box-sizing:border-box}
   #player{position:relative;width:640px;height:360px;background:#252b35}
   video{display:block;width:100%;height:100%;object-fit:contain;background:#000}
   #player:fullscreen{width:100vw;height:100vh}
   </style><div id="player"><video muted autoplay playsinline></video></div>`);});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  browser=await puppeteer.launch({browser:kind==='firefox'?'firefox':'chrome',headless:process.env.HEADLESS!=='0',
   extraPrefsFirefox:{'media.videocontrols.picture-in-picture.video-toggle.enabled':false},
   executablePath:kind==='firefox'?(process.env.FIREFOX_PATH||'C:/Program Files/Mozilla Firefox/firefox.exe'):
    (process.env.CHROMIUM_PATH||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'),
   defaultViewport:{width:1000,height:800},timeout:60000,args:kind==='chromium'?['--autoplay-policy=no-user-gesture-required']:[]});
  const page=await browser.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.evaluate(()=>{
   window.fixtureStorageListeners=[];
   const api={runtime:{getURL:p=>location.origin+'/'+p,onMessage:{addListener(){}}},
    storage:{onChanged:{addListener(fn){fixtureStorageListeners.push(fn);}},local:{get:async defaults=>({...defaults,mode:'native',strength:0,fiInfra:false,quality:'high',interaction:'quality'})}}};
   window.fixtureInteraction=value=>{for(const listener of fixtureStorageListeners)listener({interaction:{newValue:value}},'local');};
   window.browser=api;window.chrome=api;window.video=document.querySelector('video');window.player=document.querySelector('#player');
   window.source=async(w,h)=>{
    clearInterval(window.paintTimer);for(const track of video.srcObject?.getTracks()||[])track.stop();
    const image=document.createElement('canvas');image.width=w;image.height=h;const ctx=image.getContext('2d');let sequence=0;
    const paint=()=>{ctx.fillStyle='#df3448';ctx.fillRect(0,0,w/2,h/2);ctx.fillStyle='#2bba65';ctx.fillRect(w/2,0,w/2,h/2);
     ctx.fillStyle='#356ee0';ctx.fillRect(0,h/2,w/2,h/2);ctx.fillStyle='#e8ba36';ctx.fillRect(w/2,h/2,w/2,h/2);
     ctx.fillStyle='#eeeeee';ctx.fillRect(w*.4,h*.2,w*.2,h*.6);ctx.fillStyle='#222222';ctx.fillRect(w*.45,h*.3,w*.1,h*.4);
     // Firefox may stop delivering capture frames when all pixels are static.
     // A one-level change cannot affect the comparison's <=8 rounding bound.
     ctx.fillStyle=sequence++%2?'#df3448':'#de3448';ctx.fillRect(1,1,2,2);};
    paint();video.srcObject=image.captureStream(30);window.paintTimer=setInterval(paint,1000/30);await video.play();
   };
  });
  await page.evaluate(()=>source(320,240));await page.waitForFunction(()=>video.videoWidth===320&&video.currentTime>0);
  for(const content of scripts)await page.addScriptTag({content});
  await page.waitForFunction(()=>typeof status!=='undefined'&&status==='ok'&&document.querySelector('#fv-enhancer-canvas')?.width>0);
  // Geometry changes must repaint without depending on new decoded frames.
  // Pausing also makes native/overlay screenshots observe exactly one frame.
  await page.evaluate(()=>video.pause());

  async function check(name,expectedVisible=true){
   // Allow ResizeObserver, MutationObserver and decoder callbacks to settle.
   await new Promise(r=>setTimeout(r,180));
   const box=await page.evaluate(()=>{const r=(document.fullscreenElement||player).getBoundingClientRect();return {x:Math.max(0,Math.floor(r.x)-20),y:Math.max(0,Math.floor(r.y)-20),
    width:Math.min(innerWidth,Math.ceil(r.right)+20)-Math.max(0,Math.floor(r.x)-20),height:Math.min(innerHeight,Math.ceil(r.bottom)+20)-Math.max(0,Math.floor(r.y)-20)};});
   const state=await page.evaluate(()=>{const c=document.querySelector('#fv-enhancer-canvas'),s=getComputedStyle(c);return {status,
    video:{width:video.videoWidth,height:video.videoHeight,fit:getComputedStyle(video).objectFit,position:getComputedStyle(video).objectPosition},
    overlay:{visible:s.display!=='none'&&s.visibility==='visible'&&(!document.fullscreenElement||document.fullscreenElement.contains(c)),
     width:c.width,height:c.height,style:c.style.cssText},fi:snapshot().settings.fiInfra};});
   assert.equal(state.status,'ok',name);assert.equal(state.fi,false);assert.equal(state.overlay.visible,expectedVisible,`${name}: overlay visibility`);
   await page.evaluate(()=>document.querySelector('#fv-enhancer-canvas').style.opacity='0');
   const native=await page.screenshot({clip:box});
   await page.evaluate(()=>document.querySelector('#fv-enhancer-canvas').style.opacity='1');
   const overlay=await page.screenshot({clip:box});
   const difference=compare(native,overlay);const result={name,...difference,state};results.push(result);
   fs.writeFileSync(path.join(temp,name+'-native.png'),native);fs.writeFileSync(path.join(temp,name+'-overlay.png'),overlay);
   fs.writeFileSync(path.join(temp,name+'.json'),JSON.stringify(result,null,2));
   console.log(JSON.stringify({name,...difference}));
   // Geometry failures alter entire solid regions, unlike a few filtered edge
   // pixels. The limits also tolerate native YUV conversion rounding (<=8).
   assert.ok(difference.badFraction<.005,`${name}: changed geometric regions: ${JSON.stringify(difference)}`);
   assert.ok(difference.mean<2,`${name}: identity overlay differs from the native image: ${JSON.stringify(difference)}`);
  }

  for(const fit of ['contain','cover','fill','none','scale-down'])for(const position of ['0% 0%','50% 50%','100% 100%']){
   await page.evaluate(({fit,position})=>{video.style.objectFit=fit;video.style.objectPosition=position;},{fit,position});
   await check(fit+'-'+position.replaceAll('%','').replaceAll(' ','-'));
  }
  await page.evaluate(()=>{video.style.objectFit='contain';video.style.objectPosition='50% 50%';scrollTo(0,60);});await check('scroll');
  await page.evaluate(()=>fixtureInteraction('smooth'));
  await page.mouse.move(300,300);await page.mouse.wheel({deltaY:30});await page.mouse.move(10,10);
  await page.waitForFunction(()=>getComputedStyle(document.querySelector('#fv-enhancer-canvas')).visibility!=='visible',{timeout:3000});
  await page.waitForFunction(()=>getComputedStyle(document.querySelector('#fv-enhancer-canvas')).visibility==='visible',{timeout:5000});
  await check('smooth-scroll-return');await page.evaluate(()=>fixtureInteraction('quality'));
  await page.evaluate(()=>{player.style.transformOrigin='top left';player.style.transform='scale(0.8, 1.15)';});await check('scaled-parent');
  await page.evaluate(()=>{player.style.transform='';scrollTo(0,0);});
  await page.evaluate(()=>{video.style.boxSizing='border-box';video.style.padding='11px 17px';video.style.border='7px solid #8b70bc';});
  await check('video-border-padding');
  await page.evaluate(()=>{video.style.boxSizing='';video.style.padding='';video.style.border='';});
  for(const [w,h]of [[240,400],[160,120],[640,360]]){
   await page.evaluate(([w,h])=>source(w,h),[w,h]);await page.waitForFunction(({w,h})=>video.videoWidth===w&&video.videoHeight===h,{}, {w,h});
   await page.evaluate(()=>video.pause());
   await check('source-'+w+'x'+h);
  }
  await page.evaluate(()=>video.pause());
  await page.evaluate(()=>{video.style.objectPosition='0% 100%';});await check('paused-position-only');
  await page.evaluate(()=>{player.style.width='540px';player.style.height='420px';video.style.objectPosition='100% 0%';});await check('paused-resize');
  // Fullscreen requires a genuine user activation. Puppeteer's click provides
  // one, even though the fixture deliberately has no player controls.
  await page.evaluate(()=>player.addEventListener('click',()=>player.requestFullscreen(),{once:true}));
  await page.click('#player');
  await page.waitForFunction(()=>!!document.fullscreenElement,{timeout:5000});await check('fullscreen');
  await page.evaluate(()=>document.exitFullscreen());await page.waitForFunction(()=>!document.fullscreenElement);await check('fullscreen-return');
  // A fullscreen <video> cannot contain a sibling canvas. The extension must
  // expose the correctly framed native video, then restore the overlay on exit.
  await page.evaluate(()=>video.addEventListener('click',()=>video.requestFullscreen(),{once:true}));
  await page.click('video');await page.waitForFunction(()=>document.fullscreenElement===video,{timeout:5000});await check('video-fullscreen',false);
  await page.evaluate(()=>document.exitFullscreen());await page.waitForFunction(()=>!document.fullscreenElement);await check('video-fullscreen-return');
  assert.deepEqual(errors,[]);console.log(JSON.stringify({browser:kind,artifacts:temp,results},null,2));
  console.log('PASS: native video framing matches the identity overlay across fit, position, source, layout and fullscreen changes');
 }finally{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));console.log('Layout artifacts: '+temp);}
})().catch(error=>{console.error(error);process.exitCode=1;});
