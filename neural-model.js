/* Model data only: no remote JavaScript, WGSL or executable graph is accepted. */
(function(scope){
 'use strict';
 const KEY='fvNeuralModelV1', ID='framegen-1.4.7-v7-small';
 const BASE='https://cdn.jsdelivr.net/npm/framegen@1.4.7/weights/';
 const ext=scope.browser??scope.chrome;
 function encode(bytes){let s='';for(let i=0;i<bytes.length;i+=16384)s+=String.fromCharCode(...bytes.subarray(i,i+16384));return btoa(s);}
 function decode(s){if(typeof s!=='string'||s.length>12*1024*1024)throw new Error('Invalid cached model');const v=atob(s),a=new Uint8Array(v.length);for(let i=0;i<v.length;i++)a[i]=v.charCodeAt(i);return a.buffer;}
 async function sha256(bin){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bin))].map(x=>x.toString(16).padStart(2,'0')).join('');}
 async function store(manifest,binary){
  const spec=scope.FiNeuralRuntime.validateModel(manifest,binary,{production:true});
  const hash=await sha256(binary);
  const record={id:ID,manifest,base64:encode(new Uint8Array(binary)),sha256:hash,bytes:binary.byteLength,installedAt:new Date().toISOString(),license:'non-commercial-research-personal'};
  // A complete replacement is atomic at the storage API boundary. An aborted
  // download never overwrites an already installed, valid model.
  await ext.storage.local.set({[KEY]:record,fiNeuralRevision:Date.now()});
  return {...spec,sha256:hash};
 }
 async function load(){
  const record=(await ext.storage.local.get(KEY))[KEY];
  if(record){
   if(record.id!==ID)throw new Error('Unsupported cached model version');
   const binary=decode(record.base64);
   if(binary.byteLength!==record.bytes||await sha256(binary)!==record.sha256)throw new Error('Cached model checksum failed. Reinstall the neural model.');
   scope.FiNeuralRuntime.validateModel(record.manifest,binary,{production:true});
   return {binary,manifest:record.manifest,id:ID,sha256:record.sha256};
  }
  // Optional offline build: tools/install-model.py puts the same data here.
  try{
   const manifestResponse=await fetch(ext.runtime.getURL('models/rt_v7s.json'));
   if(!manifestResponse.ok)throw new Error('No bundled manifest');
   const manifest=await manifestResponse.json();
   const binResponse=await fetch(ext.runtime.getURL('models/rt_v7s.bin'));
   if(!binResponse.ok)throw new Error('No bundled weights');
   const binary=await binResponse.arrayBuffer();scope.FiNeuralRuntime.validateModel(manifest,binary,{production:true});
   return {binary,manifest,id:ID,sha256:await sha256(binary)};
  }catch(error){throw new Error('Neural model not installed. Open Model setup in the popup. '+(error?.message||''));}
 }
 async function fetchBounded(url,maxBytes,signal){
  if(![BASE+'rt_v7s.json',BASE+'rt_v7s.bin'].includes(url))throw new Error('Unexpected model download origin');
  const response=await fetch(url,{signal,credentials:'omit',cache:'no-cache',redirect:'error'});
  if(!response.ok)throw new Error('Model download HTTP '+response.status);
  const size=Number(response.headers.get('content-length'));if(size>maxBytes)throw new Error('Model download too large');
  const reader=response.body.getReader(),chunks=[];let total=0;
  try{while(true){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>maxBytes)throw new Error('Model download exceeds limit');chunks.push(value);}}
  catch(error){await reader.cancel().catch(()=>{});throw error;}
  const bytes=new Uint8Array(total);let pos=0;for(const chunk of chunks){bytes.set(chunk,pos);pos+=chunk.byteLength;}return bytes.buffer;
 }
 const api={KEY,ID,BASE,store,load,sha256,fetchBounded,decode,encode};scope.FiNeuralModel=api;if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(globalThis);
