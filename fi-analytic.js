/* SPDX-License-Identifier: MIT
 * Video Enhancer: deterministic, untrained motion estimation and reconstruction.
 * No neural checkpoint, teacher model, dataset, network request or ML dependency.
 * All image/flow work stays in the renderer's WebGL2 context. Only 4 diagnostics
 * floats are read after a fence. This is not a neural-quality equivalence claim.
 */
(function (root) {
'use strict';
const VERT = `#version 300 es
void main(){vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));gl_Position=vec4(p*2.-1.,0.,1.);}`;
const HEAD = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
out vec4 result;
float luma(vec3 c){return dot(c,vec3(.2126,.7152,.0722));}
vec4 px(sampler2D s,vec2 p){vec2 n=vec2(textureSize(s,0));return texture(s,(clamp(p,vec2(0.),n-1.)+.5)/n);}
`;
// Four area samples for the initial resize. Later pyramid levels use the same
// box-prefilter rather than throwing away three of every four pixels.
const PREP = HEAD + `
uniform sampler2D source;uniform vec2 size;
void main(){vec2 uv=gl_FragCoord.xy/size;vec2 d=.25/size;
vec3 c=(texture(source,uv+vec2(-d.x,-d.y)).rgb+texture(source,uv+vec2(d.x,-d.y)).rgb+
 texture(source,uv+vec2(-d.x,d.y)).rgb+texture(source,uv+d).rgb)*.25;
result=vec4(c,luma(c));}`;
const FLOW = HEAD + `
uniform sampler2D refImage;uniform sampler2D targetImage;
uniform sampler2D prior;uniform int mode;uniform int iteration;
vec2 center(){return gl_FragCoord.xy-.5;}
float cost(vec2 f){
 vec2 p=center(),q=p+f,n=vec2(textureSize(refImage,0));
 if(any(lessThan(q,vec2(0.)))||any(greaterThan(q,n-1.)))return 1.+length(f)*.001;
 vec4 a0=px(refImage,p),b0=px(targetImage,q);float s=0.,ws=0.;
 for(int y=-1;y<=1;y++)for(int x=-1;x<=1;x++){
  vec2 d=vec2(x,y);vec4 a=px(refImage,p+d),b=px(targetImage,q+d);
  float w=1./(1.+12.*abs(a.a-a0.a));
  float photo=min(abs(a.a-b.a),.15);
  float structure=min(abs((a.a-a0.a)-(b.a-b0.a)),.12);
  float chroma=min(length((a.rgb-vec3(a.a))-(b.rgb-vec3(b.a))),.2);
  s+=w*(photo+.5*structure+.15*chroma);ws+=w;
 }return s/max(ws,.001);
}
void consider(vec2 candidate,inout vec2 best,inout float score){
 float c=cost(candidate)+.00012*length(candidate);
 if(c+0.000002<score){score=c;best=candidate;}
}
void main(){
 vec2 p=center(),f=vec2(0.);float score=cost(f);
 if(mode==0){
  // Independent coarse hypotheses, not one camera translation imposed on all objects.
  for(int y=-4;y<=4;y++)for(int x=-4;x<=4;x++)consider(vec2(x,y),f,score);
 }else if(mode==1){
  vec2 scale=vec2(textureSize(refImage,0))/vec2(textureSize(prior,0));
  vec2 q=(p+.5)/scale-.5;ivec2 b=ivec2(floor(q)),hi=textureSize(prior,0)-1;
  // Evaluate four observed vectors, instead of blending foreground and background.
  for(int y=0;y<2;y++)for(int x=0;x<2;x++)consider(texelFetch(prior,clamp(b+ivec2(x,y),ivec2(0),hi),0).xy*scale,f,score);
  vec2 base=f;
  for(int y=-1;y<=1;y++)for(int x=-1;x<=1;x++)consider(base+vec2(x,y),f,score);
  // Small motion must remain a competing hypothesis when a coarse repeated
  // texture aliases to a distant displacement.
  for(int y=-2;y<=2;y++)for(int x=-2;x<=2;x++)consider(vec2(x,y),f,score);
 }else{
  f=texelFetch(prior,ivec2(p),0).xy;score=cost(f)+.00012*length(f);
  int r=iteration%2==0?1:2;ivec2 hi=textureSize(prior,0)-1;
  for(int i=0;i<4;i++){
   ivec2 d=i==0?ivec2(-r,0):i==1?ivec2(r,0):i==2?ivec2(0,-r):ivec2(0,r);
   consider(texelFetch(prior,clamp(ivec2(p)+d,ivec2(0),hi),0).xy,f,score);
  }
  vec2 base=f;float step=iteration<2?1.:.5;
  consider(base+vec2(step,0),f,score);consider(base-vec2(step,0),f,score);
  consider(base+vec2(0,step),f,score);consider(base-vec2(0,step),f,score);
 }
 // Robust subpixel refinement. Outliers contribute less, and a step is accepted
 // only when the actual patch objective improves (never blindly integrate it).
 float xx=0.,xy=0.,yy=0.,bx=0.,by=0.;float ac=px(refImage,p).a;
 for(int y=-1;y<=1;y++)for(int x=-1;x<=1;x++){
  vec2 a=p+vec2(x,y),b=a+f;float v=px(refImage,a).a;
  float it=px(targetImage,b).a-v;
  vec2 g=vec2(px(targetImage,b+vec2(1,0)).a-px(targetImage,b-vec2(1,0)).a,
              px(targetImage,b+vec2(0,1)).a-px(targetImage,b-vec2(0,1)).a)*.5;
  float w=1./((1.+12.*abs(v-ac))*(1.+30.*abs(it)));
  xx+=w*g.x*g.x;xy+=w*g.x*g.y;yy+=w*g.y*g.y;bx+=w*g.x*it;by+=w*g.y*it;
 }
 float det=xx*yy-xy*xy;
 if(det>1e-9){vec2 d=clamp(vec2(-yy*bx+xy*by,xy*bx-xx*by)/det,vec2(-.75),vec2(.75));
  vec2 base=f;consider(base+d,f,score);consider(base+d*.5,f,score);}
 float eigen=max(0.,.5*(xx+yy-sqrt(max(0.,(xx-yy)*(xx-yy)+4.*xy*xy))));
 float confidence=exp(-cost(f)*24.)*(.3+.7*eigen/(eigen+.0004));
 if(cost(vec2(0.))<.001&&length(f)<.25)confidence=1.;
 result=vec4(f,clamp(confidence,0.,1.),cost(f));
}`;
const CLEAN = HEAD + `
uniform sampler2D field;uniform sampler2D image;
void main(){vec2 p=gl_FragCoord.xy-.5;vec4 c=px(field,p);vec3 guide=px(image,p).rgb;
 vec4 values[9];float weights[9];int n=0,support=0;float mass=0.;
 for(int y=-1;y<=1;y++)for(int x=-1;x<=1;x++){
  vec2 q=p+vec2(x,y);vec4 v=px(field,q);float w=exp(-length(px(image,q).rgb-guide)*20.)*(.05+v.z);
  values[n]=v;weights[n]=w;mass+=w;n++;
  if(length(v.xy-c.xy)<1.25)support++;
 }
 if(support>=4){result=c;return;}
 int best=4;float bestScore=1e6;
 for(int a=0;a<9;a++){float score=0.;for(int b=0;b<9;b++)score+=weights[b]*min(4.,length(values[a].xy-values[b].xy));
  if(score<bestScore){bestScore=score;best=a;}}
 vec4 v=values[best];
 if(length(v.xy-c.xy)>1.5&&bestScore/max(mass,.00001)<.65&&v.w<=c.w+.01)result=v;else result=c;
}`;
const CHECK = HEAD + `
uniform sampler2D forwardFlow;uniform sampler2D reverseFlow;
void main(){vec2 p=gl_FragCoord.xy-.5,n=vec2(textureSize(forwardFlow,0));
 vec4 f=px(forwardFlow,p);vec2 q=p+f.xy;
 if(any(lessThan(q,vec2(0.)))||any(greaterThan(q,n-1.))){result=vec4(f.xy,0.,1.);return;}
 vec4 b=px(reverseFlow,q);float err=length(f.xy+b.xy);
 float tol=.7+.025*(length(f.xy)+length(b.xy));
 float c=sqrt(max(0.,f.z*b.z))*exp(-err*err/(tol*tol));
 result=vec4(f.xy,c,clamp(err/4.,0.,1.));}`;
const GEOMETRY = `
uniform sampler2D prevImage;uniform sampler2D currImage;
uniform sampler2D fwd;uniform sampler2D bwd;uniform float phase;
vec4 guided(sampler2D field,sampler2D image,vec2 uv){
 vec2 n=vec2(textureSize(field,0)),q=uv*n-.5;ivec2 b=ivec2(floor(q)),hi=textureSize(field,0)-1;
 vec2 frac=fract(q);float guide=luma(texture(image,clamp(uv,vec2(0),vec2(1))).rgb);
 vec4 v[4];float w[4];int best=0;float maxWeight=-1.;
 for(int i=0;i<4;i++){
  ivec2 o=ivec2(i%2,i/2),at=clamp(b+o,ivec2(0),hi);v[i]=texelFetch(field,at,0);
  vec2 d=mix(1.-frac,frac,vec2(o));
  float l=luma(texture(image,(vec2(at)+.5)/n).rgb);
  w[i]=max(.0001,d.x*d.y)*exp(-abs(l-guide)*24.)*(.2+.8*v[i].z);
  if(w[i]>maxWeight){maxWeight=w[i];best=i;}
 }
 vec4 sum=vec4(0);float ws=0.;
 for(int i=0;i<4;i++){
  // Never average opposite object motion across a discontinuity.
  float weight=w[i]*exp(-dot(v[i].xy-v[best].xy,v[i].xy-v[best].xy)*1.5);
  sum+=weight*v[i];ws+=weight;
 }return sum/max(ws,.000001);
}
vec4 invertFlow(sampler2D field,sampler2D image,vec2 uv,float t){
 vec2 n=vec2(textureSize(field,0));vec4 f=guided(field,image,uv);vec2 q=uv;
 for(int i=0;i<3;i++){q=uv-f.xy*t/n;f=guided(field,image,q);}
 q=uv-f.xy*t/n;
 float inside=float(all(greaterThanEqual(q,vec2(0)))&&all(lessThanEqual(q,vec2(1))));
 // The endpoint-origin field must actually project back onto this intermediate pixel.
 vec4 verify=guided(field,image,q);float err=length((q+verify.xy*t/n-uv)*n);
 return vec4(q,f.z*inside*exp(-err*err*2.),f.w);
}
`;
const MASK = HEAD + GEOMETRY + `
void main(){vec2 n=vec2(textureSize(fwd,0)),uv=gl_FragCoord.xy/n;
 vec4 a=invertFlow(fwd,prevImage,uv,phase),b=invertFlow(bwd,currImage,uv,1.-phase);
 vec3 ca=texture(prevImage,a.xy).rgb,cb=texture(currImage,b.xy).rgb;
 float wa=(1.-phase)*a.z,wb=phase*b.z,coverage=max(a.z,b.z);
 float dis=length(ca-cb);float ratio=wa/max(wa+wb,.00001);
 // Smooth, spatially filterable ownership, not a per-pixel ternary endpoint switch.
 float ownership=smoothstep(.18,.82,ratio);
 float w=mix(ratio,ownership,smoothstep(.02,.16,dis));
 result=vec4(w,coverage,luma(mix(cb,ca,w)),dis);
}`;
const MASK_FILTER = HEAD + `
uniform sampler2D maskImage;
void main(){vec2 p=gl_FragCoord.xy-.5;vec4 c=px(maskImage,p);vec2 sum=vec2(0);float ws=0.;
 for(int y=-1;y<=1;y++)for(int x=-1;x<=1;x++){
  vec4 v=px(maskImage,p+vec2(x,y));
  float w=exp(-abs(c.z-v.z)*28.)/(1.+float(x*x+y*y));
  // Do not pull an invalid region's ownership into a valid one.
  w*=exp(-abs(c.y-v.y)*5.);sum+=w*v.xy;ws+=w;
 }result=vec4(sum/max(ws,.00001),c.zw);}`;
const SYNTH = HEAD + GEOMETRY + `
uniform sampler2D maskImage;uniform vec2 size;uniform int debug;
void main(){vec2 uv=gl_FragCoord.xy/size;
 if(phase<=0.){result=texture(prevImage,uv);return;}
 if(phase>=1.){result=texture(currImage,uv);return;}
 vec4 a=invertFlow(fwd,prevImage,uv,phase),b=invertFlow(bwd,currImage,uv,1.-phase);
 vec4 m=texture(maskImage,uv);vec3 ca=texture(prevImage,a.xy).rgb,cb=texture(currImage,b.xy).rgb;
 // A single unwarped endpoint is used for unsupported regions. In particular,
 // never describe a choice between two already-broken warps as a safe fallback.
 vec3 anchor=phase<.5?texture(prevImage,uv).rgb:texture(currImage,uv).rgb;
 float coverage=min(m.y,max(a.z,b.z));float valid=smoothstep(.04,.24,coverage);
 vec3 color=mix(anchor,mix(cb,ca,m.x),valid);
 if(debug==1){vec2 f=guided(fwd,prevImage,uv).xy; color=vec3(.5+f*.025,.5);}
 if(debug==2)color=vec3(m.x,m.y,1.-valid);
 if(debug==3)color=vec3(clamp(m.w*3.,0.,1.),0.,0.);
 if(debug==4)color=vec3(1.-valid);
 result=vec4(clamp(color,0.,1.),1.);
}`;
const STATS = HEAD + `
uniform sampler2D prevImage;uniform sampler2D currImage;uniform sampler2D fwd;
void main(){float ha[16],hb[16];for(int i=0;i<16;i++){ha[i]=0.;hb[i]=0.;}
 float mad=0.,conf=0.,supported=0.;
 for(int y=0;y<12;y++)for(int x=0;x<16;x++){
  vec2 uv=(vec2(x,y)+.5)/vec2(16,12);float a=luma(texture(prevImage,uv).rgb),b=luma(texture(currImage,uv).rgb);
  ha[min(15,int(a*16.))]+=1.;hb[min(15,int(b*16.))]+=1.;mad+=abs(a-b);
  float c=texture(fwd,uv).z;conf+=c;supported+=float(c>.24);
 }float hist=0.;for(int i=0;i<16;i++)hist+=abs(ha[i]-hb[i]);
 result=vec4(hist/384.,mad/192.,conf/192.,supported/192.);}`;
const SHADERS=Object.freeze({PREP,FLOW,CLEAN,CHECK,MASK,MASK_FILTER,SYNTH,STATS});
function dimensions(w,h,profile='balanced',step=0){
 if(![w,h].every(Number.isSafeInteger)||w<1||h<1||w>16384||h>16384)throw new Error('Invalid source dimensions');
 const cap=(profile==='quality'?512:320)*Math.max(.5,1-Math.max(0,Math.min(2,step))*.25);
 const scale=Math.min(1,cap/Math.max(w,h));
 return {width:Math.max(8,Math.round(w*scale)),height:Math.max(8,Math.round(h*scale))};
}
function plan(w,h,profile='balanced'){
 const levels=[{w,h}];while(levels.length<4&&Math.min(levels.at(-1).w,levels.at(-1).h)>=24){const p=levels.at(-1);levels.push({w:Math.ceil(p.w/2),h:Math.ceil(p.h/2)});}
 const textures={},ops=[];const add=(name,w,h)=>{textures[name]={w,h};return name;};
 for(let i=0;i<levels.length;i++)for(const side of ['a','b']){
  const d=levels[i];add(side+i,d.w,d.h);ops.push({shader:'PREP',out:side+i,inputs:{source:i?side+(i-1):side==='a'?'prev':'curr'},uniforms:{size:[d.w,d.h]}});
 }
 const rounds=profile==='quality'?5:3;
 for(const dir of ['f','b']){
  let coarse=null;
  for(let i=levels.length-1;i>=0;i--){const d=levels[i];let prior=coarse;
   add(dir+i+'p',d.w,d.h);add(dir+i+'q',d.w,d.h);
   for(let j=0;j<rounds;j++){
    const out=dir+i+(j%2?'q':'p');ops.push({shader:'FLOW',out,inputs:{refImage:(dir==='f'?'a':'b')+i,targetImage:(dir==='f'?'b':'a')+i,prior:prior||'a'+i},uniforms:{mode:j?2:coarse?1:0,iteration:j}});prior=out;
   }coarse=prior;
  }
  add(dir+'Clean',w,h);ops.push({shader:'CLEAN',out:dir+'Clean',inputs:{field:coarse,image:dir==='f'?'a0':'b0'},uniforms:{}});
  textures[dir+'Final']={alias:dir+'Clean'};
 }
 add('forward',w,h);add('backward',w,h);
 ops.push({shader:'CHECK',out:'forward',inputs:{forwardFlow:'fFinal',reverseFlow:'bFinal'},uniforms:{}});
 ops.push({shader:'CHECK',out:'backward',inputs:{forwardFlow:'bFinal',reverseFlow:'fFinal'},uniforms:{}});
 add('mask0',w,h);add('mask1',w,h);add('stats',1,1);
 ops.push({shader:'STATS',out:'stats',inputs:{prevImage:'prev',currImage:'curr',fwd:'forward'},uniforms:{}});
 return {levels,textures,ops};
}
const pause=ms=>new Promise(r=>setTimeout(r,ms));
class Runtime{
 constructor(gl,w,h,profile='balanced',step=0){
  this.gl=gl;this.kind='analytic';this.profile=profile;this.sourceW=w;this.sourceH=h;this.step=step;
  this.dimensions=dimensions(w,h,profile,step);this.graph=plan(this.dimensions.width,this.dimensions.height,profile);
  this.textures=new Map();this.programs=new Map();this.bytes=0;this.busy=false;this.destroyed=false;this.lost=false;
  this.epoch=0;this.serial=-1;this.complete=false;this.fbo=gl.createFramebuffer();this.vao=gl.createVertexArray();
  this.whenLost=new Promise(resolve=>{this.reportLoss=resolve;});
  this.stats={ms:0,p95:0,completed:0,stale:0,sceneCuts:0,coverage:0,memoryBytes:0};this.times=[];
 }
 static async create(gl,w,h,profile='balanced',step=0){
  if(!gl||gl.isContextLost())throw new Error('WebGL2 context unavailable');
  if(!gl.getExtension('EXT_color_buffer_float'))throw new Error('Floating-point color buffers are unavailable');
  const r=new Runtime(gl,w,h,profile,step);try{await r.prepare();return r;}catch(e){r.destroy();throw e;}
 }
 async prepare(){
  const gl=this.gl,khr=gl.getExtension('KHR_parallel_shader_compile');
  for(const [name,src]of Object.entries(SHADERS)){
   if(this.destroyed)throw new Error('Analytic initialization cancelled');
   const shaders=[];let p=null;
   try{
    for(const[type,code]of [[gl.VERTEX_SHADER,VERT],[gl.FRAGMENT_SHADER,src]]){
     const s=gl.createShader(type);shaders.push(s);gl.shaderSource(s,code);gl.compileShader(s);
    }
    p=gl.createProgram();for(const s of shaders)gl.attachShader(p,s);gl.linkProgram(p);
    const start=performance.now();
    while(khr&&!gl.getProgramParameter(p,khr.COMPLETION_STATUS_KHR)){
     if(this.destroyed||gl.isContextLost()||performance.now()-start>30000)throw new Error('Analytic shader compilation interrupted');await pause(4);
    }
    if(this.destroyed||gl.isContextLost())throw new Error('Analytic shader compilation cancelled');
    if(!gl.getProgramParameter(p,gl.LINK_STATUS))throw new Error(name+': '+(gl.getShaderInfoLog(shaders[1])||gl.getProgramInfoLog(p)));
    this.programs.set(name,{p,locations:new Map()});p=null;
   }finally{for(const s of shaders)gl.deleteShader(s);if(p)gl.deleteProgram(p);}
   await pause(0);
  }
  this.state(()=>{
   for(const[name,d]of Object.entries(this.graph.textures)){
    if(d.alias)continue;const t=gl.createTexture();this.textures.set(name,t);gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,t);
    for(const k of[gl.TEXTURE_MIN_FILTER,gl.TEXTURE_MAG_FILTER])gl.texParameteri(gl.TEXTURE_2D,k,gl.LINEAR);
    for(const k of[gl.TEXTURE_WRAP_S,gl.TEXTURE_WRAP_T])gl.texParameteri(gl.TEXTURE_2D,k,gl.CLAMP_TO_EDGE);
    const fp32=name==='stats';gl.texImage2D(gl.TEXTURE_2D,0,fp32?gl.RGBA32F:gl.RGBA16F,d.w,d.h,0,gl.RGBA,gl.FLOAT,null);
    // RGBA32F is not linearly filterable on all WebGL2 implementations.
    if(fp32)for(const k of[gl.TEXTURE_MIN_FILTER,gl.TEXTURE_MAG_FILTER])gl.texParameteri(gl.TEXTURE_2D,k,gl.NEAREST);
    this.bytes+=d.w*d.h*(fp32?16:8);
    if(this.bytes>64*1024*1024)throw new Error('Analytic scratch memory budget exceeded');
    gl.bindFramebuffer(gl.FRAMEBUFFER,this.fbo);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,t,0);
    if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw new Error('Incomplete analytic framebuffer');
   }
  });this.stats.memoryBytes=this.bytes;
 }
 state(fn){
  const g=this.gl;
  const old={fb:g.getParameter(g.DRAW_FRAMEBUFFER_BINDING),read:g.getParameter(g.READ_FRAMEBUFFER_BINDING),vao:g.getParameter(g.VERTEX_ARRAY_BINDING),program:g.getParameter(g.CURRENT_PROGRAM),viewport:g.getParameter(g.VIEWPORT),unit:g.getParameter(g.ACTIVE_TEXTURE),textures:[]};
  // This context belongs to the upscaler as well. Restoring only ACTIVE_TEXTURE
  // does not restore the bindings the renderer expects on each unit.
  for(let i=0;i<5;i++){g.activeTexture(g.TEXTURE0+i);old.textures.push(g.getParameter(g.TEXTURE_BINDING_2D));}
  const flags=[g.BLEND,g.DEPTH_TEST,g.SCISSOR_TEST,g.CULL_FACE];const enabled=flags.map(x=>g.isEnabled(x));
  try{for(const x of flags)g.disable(x);g.bindVertexArray(this.vao);return fn();}
  finally{g.bindFramebuffer(g.DRAW_FRAMEBUFFER,old.fb);g.bindFramebuffer(g.READ_FRAMEBUFFER,old.read);g.bindVertexArray(old.vao);g.useProgram(old.program);g.viewport(...old.viewport);old.textures.forEach((t,i)=>{g.activeTexture(g.TEXTURE0+i);g.bindTexture(g.TEXTURE_2D,t);});g.activeTexture(old.unit);flags.forEach((x,i)=>{if(enabled[i])g.enable(x);});}
 }
 tex(name,external){if(external&&external[name])return external[name];const d=this.graph.textures[name];return this.textures.get(d?.alias||name);}
 loc(p,name){if(!p.locations.has(name))p.locations.set(name,this.gl.getUniformLocation(p.p,name));return p.locations.get(name);}
 draw(shader,target,w,h,inputs,uniforms={}){
  const g=this.gl,p=this.programs.get(shader);g.useProgram(p.p);g.bindVertexArray(this.vao);g.bindFramebuffer(g.FRAMEBUFFER,this.fbo);
  g.framebufferTexture2D(g.FRAMEBUFFER,g.COLOR_ATTACHMENT0,g.TEXTURE_2D,target,0);g.viewport(0,0,w,h);
  let unit=0;for(const[name,t]of Object.entries(inputs)){if(t===target)throw new Error('Analytic read/write feedback');g.activeTexture(g.TEXTURE0+unit);g.bindTexture(g.TEXTURE_2D,t);g.uniform1i(this.loc(p,name),unit++);}
  for(const[name,value]of Object.entries(uniforms)){
   const l=this.loc(p,name);if(Array.isArray(value))g.uniform2f(l,...value);else if(['mode','iteration','debug'].includes(name))g.uniform1i(l,value);else g.uniform1f(l,value);
  }g.drawArrays(g.TRIANGLES,0,3);
 }
 async estimate(prev,curr,serial){
  if(this.busy)return null;if(this.destroyed||this.gl.isContextLost())throw new Error('Analytic context lost');
  const g=this.gl,start=performance.now(),epoch=this.epoch;this.busy=true;this.complete=false;let fence=null;
  try{
   this.state(()=>{
    const external={prev,curr};for(const op of this.graph.ops){const d=this.graph.textures[op.out];this.draw(op.shader,this.tex(op.out),d.w,d.h,Object.fromEntries(Object.entries(op.inputs).map(([k,v])=>[k,this.tex(v,external)])),op.uniforms);}
    fence=g.fenceSync(g.SYNC_GPU_COMMANDS_COMPLETE,0);if(!fence)throw new Error('Analytic fence allocation failed');g.flush();
   });
   while(true){
    if(this.destroyed||g.isContextLost())throw new Error('Analytic processing cancelled');
    const state=g.clientWaitSync(fence,0,0);if(state===g.WAIT_FAILED)throw new Error('Analytic GPU fence failed');
    if(state!==g.TIMEOUT_EXPIRED)break;if(performance.now()-start>3000)throw new Error('Analytic GPU safety timeout');await pause(1);
   }
   const values=new Float32Array(4);this.state(()=>{g.bindFramebuffer(g.FRAMEBUFFER,this.fbo);g.framebufferTexture2D(g.FRAMEBUFFER,g.COLOR_ATTACHMENT0,g.TEXTURE_2D,this.tex('stats'),0);g.readPixels(0,0,1,1,g.RGBA,g.FLOAT,values);});
   if(!values.every(Number.isFinite))throw new Error('Invalid analytic diagnostics');
   const sceneCut=(values[0]>.35&&values[1]>.15)||(values[1]>.24&&values[2]<.10);
   const ms=performance.now()-start;this.times.push(ms);if(this.times.length>60)this.times.shift();const times=[...this.times].sort((a,b)=>a-b);
   Object.assign(this.stats,{ms,p95:times[Math.min(times.length-1,Math.floor(times.length*.95))],coverage:values[3]});
   this.stats.completed++;if(sceneCut)this.stats.sceneCuts++;
   this.complete=epoch===this.epoch;this.serial=serial;if(!this.complete)this.stats.stale++;
   return{serial,epoch,valid:this.complete,sceneCut,confidence:values[2],coverage:values[3],elapsedMs:ms};
  }finally{if(fence)g.deleteSync(fence);this.busy=false;}
 }
 render(prev,curr,target,w,h,phase,debug=0){
  if(this.destroyed||this.busy||!this.complete||!Number.isFinite(phase))return false;
  const d=this.dimensions,inputs={prevImage:prev,currImage:curr,fwd:this.tex('forward'),bwd:this.tex('backward')};
  this.state(()=>{
   this.draw('MASK',this.tex('mask0'),d.width,d.height,inputs,{phase});
   this.draw('MASK_FILTER',this.tex('mask1'),d.width,d.height,{maskImage:this.tex('mask0')});
   this.draw('SYNTH',target,w,h,{...inputs,maskImage:this.tex('mask1')},{phase,size:[w,h],debug});
  });return true;
 }
 reset(){this.epoch++;this.complete=false;this.serial=-1;}
 destroy(){if(this.destroyed)return;this.destroyed=true;this.lost=true;this.reset();const g=this.gl;for(const t of this.textures.values())g.deleteTexture(t);for(const p of this.programs.values())g.deleteProgram(p.p);g.deleteFramebuffer(this.fbo);g.deleteVertexArray(this.vao);this.textures.clear();this.programs.clear();}
}
const api=Object.freeze({VERT,SHADERS,dimensions,plan,Runtime,create:Runtime.create});root.FiAnalytic=api;
if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(globalThis);
