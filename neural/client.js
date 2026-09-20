(function(root){
'use strict';
const ext=root.browser??root.chrome,S=root.VENeuralSpec;
let loading=null,cached=null,revision=0;
async function call(type,extra={}){
 const response=await ext.runtime.sendMessage({type,...extra});
 if(!response?.ok)throw new Error(response?.error||'Model service unavailable. Reload the extension.');return response;
}
async function load(){
 if(cached)return cached;if(loading)return loading;
 const generation=revision; const task=(async()=>{
  const status=await call('ve-model-status');if(!status.installed)throw new Error('Neural model not installed. Use Download model or Import in the popup.');
  const b=new Uint8Array(S.MODEL.bytes);let offset=0,index=0;
  while(offset<b.length){
   const chunk=await call('ve-model-chunk',{index});const raw=atob(chunk.data);
   if(chunk.index!==index||chunk.total!==b.length||!raw.length||offset+raw.length>b.length)throw new Error('Invalid model response.');
   for(let i=0;i<raw.length;i++)b[offset+i]=raw.charCodeAt(i);offset+=raw.length;index++;
  }
  await S.verifyBytes(b);if(generation!==revision)throw new Error("Model selection changed during loading.");cached=b;return b;
 })();loading=task;try{return await task;}finally{if(loading===task)loading=null;}
}
root.VENeuralClient={load,clear(){revision++;cached=null;loading=null;}};
})(globalThis);
