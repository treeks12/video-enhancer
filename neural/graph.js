/* Fixed IFRNet-S graph and GLSL ES 3.0 kernels. All graph code ships with the extension. */
(function(root){
'use strict';
const VERT=`#version 300 es
void main(){vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));gl_Position=vec4(p*2.0-1.0,0.0,1.0);}`;
const HEAD=`#version 300 es
precision highp float;
precision highp int;
out vec4 color;
`;
function layout(w,h,c,max=4096){
 const groups=Math.ceil(c/4), maxCols=Math.floor(max/w), maxRows=Math.floor(max/h);
 if(maxCols<1||maxRows<1||maxCols*maxRows<groups)throw new Error('Neural tensor exceeds MAX_TEXTURE_SIZE.');
 // Stable tiling for a channel count lets every spatial shape share kernels.
 // Only fall back from this layout if a hardware texture-size bound requires it.
 const cols=Math.min(maxCols,groups,Math.max(Math.ceil(groups/maxRows),Math.ceil(Math.sqrt(groups))));
 return {w,h,c,groups,cols,tw:w*cols,th:h*Math.ceil(groups/cols)};
}
function baseOf(t){return t.base||t;}
function view(t,offset,c){if(offset<0||offset+c>t.c)throw new Error('Channel slice outside tensor.');return {...t,c,base:baseOf(t),offset:(t.offset||0)+offset};}
function reader(t,name){
 const b=baseOf(t),off=t.offset||0;
 return `uniform sampler2D ${name};
uniform ivec2 ${name}Size;
float ${name}C(ivec2 p,int c){
 if(c<0||c>=${t.c})return 0.0;
 int k=c+${off};int g=k/4;
 ivec2 q=clamp(p,ivec2(0),${name}Size-1);
 return texelFetch(${name},q+ivec2(g%${b.cols},g/${b.cols})*${name}Size,0)[k%4];
}
vec4 ${name}V(ivec2 p,int g){${off%4===0?`
 int k=g+${off/4};ivec2 q=clamp(p,ivec2(0),${name}Size-1);
 vec4 v=texelFetch(${name},q+ivec2(k%${b.cols},k/${b.cols})*${name}Size,0);
 ${t.c%4?`if(g==${Math.floor(t.c/4)})v*=vec4(${[0,1,2,3].map(i=>i<t.c%4?'1.0':'0.0').join(',')});`:''}return v;`
 :`int k=g*4;return vec4(${name}C(p,k),${name}C(p,k+1),${name}C(p,k+2),${name}C(p,k+3));`}}
vec4 ${name}B(vec2 p,int g){
 p=clamp(p,vec2(0.0),vec2(${name}Size-1));ivec2 q=ivec2(floor(p));vec2 f=fract(p);
 return mix(mix(${name}V(q,g),${name}V(q+ivec2(1,0),g),f.x),mix(${name}V(q+ivec2(0,1),g),${name}V(q+ivec2(1,1),g),f.x),f.y);
}
`;
}
function coords(o){return `ivec2 q=ivec2(gl_FragCoord.xy);ivec2 p=q%tensorSize;int g=q.x/tensorSize.x+q.y/tensorSize.y*${o.cols};if(g>=${o.groups}){color=vec4(0.0);return;}\n`;}
function makeShader(op){
 const {type,out:o,inputs:ins}=op;
 let src=HEAD+'uniform ivec2 tensorSize;\n'+ins.map((t,i)=>reader(t,'s'+i)).join('');
 let body=coords(o);
 if(type==='conv'){
  const {layer:l,stride=1,deconv=false,residual=false}=op;
  src+='uniform sampler2D weights;\n';
  body+=`vec4 total=texelFetch(weights,ivec2(0,g),0);\n`;
  // Four output channels per fragment; share each input texel across four FMAs.
  // Deconvolution visits only the 2x2 non-zero taps of a stride-2, 4x4 kernel.
  body+=`for(int ic=0;ic<${l.ci};ic+=4){for(int y=0;y<${deconv?2:l.k};y++){for(int x=0;x<${deconv?2:l.k};x++){
   ${deconv?`int ky=(p.y+1)%2+2*y;int kx=(p.x+1)%2+2*x;ivec2 ip=ivec2((p.x+1-kx)/2,(p.y+1-ky)/2);`:
   `int ky=y;int kx=x;ivec2 ip=p*${stride}+ivec2(x-1,y-1);`}
   if(ip.x<0||ip.y<0||ip.x>=s0Size.x||ip.y>=s0Size.y)continue;
   vec4 v=s0V(ip,ic/4);int k=ky*${l.k}+kx;int ix=2+ic*${l.k*l.k}+k;
   total+=v.x*texelFetch(weights,ivec2(ix,g),0);
   if(ic+1<${l.ci})total+=v.y*texelFetch(weights,ivec2(ix+${l.k*l.k},g),0);
   if(ic+2<${l.ci})total+=v.z*texelFetch(weights,ivec2(ix+${2*l.k*l.k},g),0);
   if(ic+3<${l.ci})total+=v.w*texelFetch(weights,ivec2(ix+${3*l.k*l.k},g),0);
  }}}\n`;
  if(residual)body+='total+=s1V(p,g);\n';
  if(l.slope)body+='total=max(total,vec4(0.0))+min(total,vec4(0.0))*texelFetch(weights,ivec2(1,g),0);\n';
  body+='color=total;';
 }else if(type==='concat'){
  let offset=0;
  src+='float pick(ivec2 p,int c){\n';
  ins.forEach((t,i)=>{src+=`if(c<${offset+t.c})return s${i}C(p,c-${offset});\n`;offset+=t.c;});
  src+='return 0.0;}\n';body+='int c=g*4;color=vec4(pick(p,c),pick(p,c+1),pick(p,c+2),pick(p,c+3));';
 }else if(type==='warp'){
  body+='vec2 f=s1V(p,0).xy;color=s0B(vec2(p)+f,g);';
 }else if(type==='refine'){
  body+=`color=s0V(p,g)+2.0*s1B((vec2(p)+0.5)*0.5-0.5,g);`;
 }else if(type==='head'){
  body+='vec4 r=s0V(p,g);color=vec4(1.0/(1.0+exp(-clamp(r.x,-20.0,20.0))),r.yzw);';
 }else if(type==='phase'){
  src+='uniform float phase;\n';body+='color=vec4(phase,0.0,0.0,0.0);';
 }else if(type==='preprocess'){
  // Match the maintained ncnn port: RGB/255 - 0.5, zero padding in centered space.
  src+='uniform sampler2D source;\nuniform vec2 activeSize;\n';
  body+=`if(float(p.x)>=activeSize.x||float(p.y)>=activeSize.y){color=vec4(0.0);return;}
  vec3 v=texture(source,(vec2(p)+0.5)/activeSize).rgb;
  color=vec4(v-0.5,0.0);`;
 }else throw new Error('Unknown fixed graph operation: '+type);
 return src+'void main(){\n'+body+'\n}';
}
class Graph{
 constructor(max=4096){this.max=max;this.ops=[];this.tensors=[];this.outputs=new Set();this.counter=0;}
 tensor(w,h,c){const t={...layout(w,h,c,this.max),id:this.counter++,offset:0};this.tensors.push(t);return t;}
 op(type,inputs,w,h,c,extra={}){const out=this.tensor(w,h,c);const op={type,inputs,out,...extra};this.ops.push(op);return out;}
 conv(input,layer,stride=1,residual=null,deconv=false){
  if(input.c!==layer.ci)throw new Error('Convolution channel mismatch.');
  return this.op('conv',residual?[input,residual]:[input],deconv?input.w*2:Math.ceil(input.w/stride),deconv?input.h*2:Math.ceil(input.h/stride),layer.co,{layer,stride,deconv,residual:!!residual});
 }
 concat(ts){if(ts.some(t=>t.w!==ts[0].w||t.h!==ts[0].h))throw new Error('Concat shape mismatch.');return this.op('concat',ts,ts[0].w,ts[0].h,ts.reduce((s,t)=>s+t.c,0));}
 warp(t,f){return this.op('warp',[t,f],t.w,t.h,t.c);}
 refine(t,prior){return this.op('refine',[t,prior],t.w,t.h,4);}
 keep(t){this.outputs.add(baseOf(t));return t;}
}
function encoder(model,d,max){
 const graph=new Graph(max), input=graph.op('preprocess',[],d.w,d.h,3,{dimensions:d});
 let t=input;const features=[];
 model.encoder.forEach((l,i)=>{t=graph.conv(t,l,i%2===0?2:1);if(i%2)features.push(graph.keep(t));});
 return {graph,features};
}
function block(g,input,d){
 const entry=g.conv(input,d.entry);let t=g.conv(entry,d.r1);
 t=g.concat([view(t,0,t.c-24),g.conv(view(t,t.c-24,24),d.s1)]);
 t=g.conv(t,d.r2);
 t=g.concat([view(t,0,t.c-24),g.conv(view(t,t.c-24,24),d.s2)]);
 t=g.conv(t,d.r3,1,entry);return g.conv(t,d.up,2,null,true);
}
function decoder(model,prev,curr,max){
 const graph=new Graph(max),phase=graph.op('phase',[],prev[3].w,prev[3].h,1);
 let out=block(graph,graph.concat([prev[3],curr[3],phase]),model.decoder[0]);
 let flow=view(out,0,4);
 for(let i=1;i<4;i++){
  const level=3-i;
  const input=graph.concat([view(out,4,out.c-4),graph.warp(prev[level],view(flow,0,2)),graph.warp(curr[level],view(flow,2,2)),view(flow,0,2),view(flow,2,2)]);
  out=block(graph,input,model.decoder[i]);flow=graph.refine(view(out,0,4),flow);
 }
 const head=graph.op('head',[view(out,4,4)],out.w,out.h,4);
 graph.keep(flow);graph.keep(head);return {graph,flow,raw:head};
}
function packLayer(layer){
 const width=2+layer.ci*layer.k*layer.k,height=Math.ceil(layer.co/4),a=new Float32Array(width*height*4);
 for(let co=0;co<layer.co;co++){
  const row=Math.floor(co/4)*width*4, lane=co%4;
  a[row+lane]=layer.bias[co];a[row+4+lane]=layer.slope?layer.slope[co]:1;
  const n=layer.ci*layer.k*layer.k;
  for(let i=0;i<n;i++)a[row+(i+2)*4+lane]=layer.weights[co*n+i];
 }
 return {width,height,data:a};
}
function synthShader(flow,raw,d){return HEAD+reader(flow,'flow')+reader(raw,'raw')+`
uniform sampler2D prev;
uniform sampler2D curr;
uniform vec2 outputSize;
uniform vec2 activeSize;
uniform int debugMode;
void main(){
 vec2 uv=gl_FragCoord.xy/outputSize;
 vec2 p=uv*activeSize-0.5;
 vec4 f=flowB(p,0);vec4 r=rawB(p,0); // visibility, residual RGB; sigmoid precedes resizing
 if(any(isnan(f))||any(isinf(f))||any(isnan(r))||any(isinf(r))){color=vec4(texture(prev,uv).rgb,1.0);return;}
 float mask=clamp(r.x,0.0,1.0);
 vec2 a=uv+f.xy/activeSize;
 vec2 b=uv+f.zw/activeSize;
 // Preserve the learned visibility mask. Do not replace it with noisy local argmax.
 vec3 v=texture(prev,clamp(a,vec2(0.0),vec2(1.0))).rgb*mask+
        texture(curr,clamp(b,vec2(0.0),vec2(1.0))).rgb*(1.0-mask)+r.yzw;
 if(debugMode==1)v=vec3(clamp(vec2(0.5)+f.xy/24.0,vec2(0.0),vec2(1.0)),0.5);
 if(debugMode==2)v=vec3(mask);
 if(debugMode==3)v=clamp(vec3(0.5)+r.yzw*4.0,0.0,1.0);
 color=vec4(clamp(v,0.0,1.0),1.0);
}`;}
const STATS=HEAD+`
uniform sampler2D prev;
uniform sampler2D curr;
void main(){
 float hp[16];float hc[16];for(int i=0;i<16;i++){hp[i]=0.0;hc[i]=0.0;}
 float mad=0.0,changed=0.0;
 for(int y=0;y<16;y++)for(int x=0;x<16;x++){
  vec2 uv=(vec2(x,y)+0.5)/16.0;vec3 a=texture(prev,uv).rgb,b=texture(curr,uv).rgb;
  float la=dot(a,vec3(.2126,.7152,.0722)),lb=dot(b,vec3(.2126,.7152,.0722));
  hp[min(15,int(la*16.0))]+=1.0;hc[min(15,int(lb*16.0))]+=1.0;
  mad+=abs(la-lb);changed+=step(.12,length(a-b));
 }
 float hist=0.0;for(int i=0;i<16;i++)hist+=abs(hp[i]-hc[i]);
 color=vec4(mad/256.0,hist/512.0,changed/256.0,1.0);
}`;
const api={VERT,HEAD,Graph,layout,view,baseOf,reader,makeShader,encoder,decoder,packLayer,synthShader,STATS};
root.VENeuralGraph=api;if(typeof module!=='undefined')module.exports=api;
})(globalThis);
