(function(root){
'use strict';
const ext=root.browser??root.chrome,S=root.VENeuralSpec;
let loading=null,cached=null,revision=0;
async function call(type,extra={},retried=false){
 let response;
 try{response=await ext.runtime.sendMessage({type,...extra});}
 catch(e){
  // An MV3 service worker may not be listening yet on the first call after
  // browser start; one retry after a beat covers the wake-up race.
  const dead=/receiving end does not exist|message channel|context invalidated/i.test(String(e.message));
  if(!dead||retried)throw e;
  await new Promise(r=>setTimeout(r,400));
  return call(type,extra,true);
 }
 if(!response?.ok)throw new Error(response?.error||'Model service unavailable. Reload the extension.');return response;
}
async function load(){
 if(cached)return cached;if(loading)return loading;
 const generation=revision; const task=(async()=>{
  let installed=false;
  try{installed=(await call('ve-model-status')).installed;}
  catch{
   // Background unavailable (still waking, or absent): bundled weights do not
   // need it. models/ifrnet.bin is web-accessible for exactly this path.
   installed=false;
  }
  let bytes;
  if(installed){
   const b=new Uint8Array(S.MODEL.bytes);let offset=0,index=0;
   while(offset<b.length){
    const chunk=await call('ve-model-chunk',{index});const raw=atob(chunk.data);
    if(chunk.index!==index||chunk.total!==b.length||!raw.length||offset+raw.length>b.length)throw new Error('Invalid model response.');
    for(let i=0;i<raw.length;i++)b[offset+i]=raw.charCodeAt(i);offset+=raw.length;index++;
   }
   bytes=b;
  }else{
   // Optional local checkout: weights placed in models/ are used as-is.
   const response=await fetch(ext.runtime.getURL('models/ifrnet.bin'));
   if(!response.ok)throw new Error('Neural model not installed. Use Download or Import in the model setup page.');
   bytes=new Uint8Array(await response.arrayBuffer());
  }
  await S.verifyBytes(bytes);if(generation!==revision)throw new Error("Model selection changed during loading.");cached=bytes;return bytes;
 })();loading=task;try{return await task;}finally{if(loading===task)loading=null;}
}
root.VENeuralClient={load,clear(){revision++;cached=null;loading=null;}};
})(globalThis);
