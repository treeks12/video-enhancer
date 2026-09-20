/* Optional, user-initiated model installation. Never receives or uploads video frames. */
'use strict';
if(typeof VENeuralSpec==='undefined'&&typeof importScripts==='function')importScripts('model-spec.js');
const api=globalThis.browser??globalThis.chrome;
const {MODEL,verifyBytes}=VENeuralSpec;
const CHUNK=196608;
let pending=null,downloadController=null,progress={state:'idle'},cached=null;
function openDB(){return new Promise((resolve,reject)=>{const r=indexedDB.open('ve-neural-models',1);
 r.onupgradeneeded=()=>r.result.createObjectStore('models');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
async function dbGet(){const db=await openDB();try{return await new Promise((resolve,reject)=>{const tx=db.transaction('models','readonly'),r=tx.objectStore('models').get(MODEL.id);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}finally{db.close();}}
async function dbWrite(value){const db=await openDB();try{await new Promise((resolve,reject)=>{const tx=db.transaction('models','readwrite');
 if(value)tx.objectStore('models').put(value,MODEL.id);else tx.objectStore('models').delete(MODEL.id);
 tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||new Error('Model storage aborted.'));});}finally{db.close();}}
function encode(bytes){let s='';for(let i=0;i<bytes.length;i+=16384)s+=String.fromCharCode(...bytes.subarray(i,i+16384));return btoa(s);}
function decode(text){if(typeof text!=='string'||text.length>Math.ceil(MODEL.bytes/3)*4)throw new Error('Invalid model upload.');const s=atob(text),b=new Uint8Array(s.length);for(let i=0;i<s.length;i++)b[i]=s.charCodeAt(i);return b;}
async function install(bytes){
 progress={state:'verifying',received:bytes.length,total:MODEL.bytes};await verifyBytes(bytes);
 // Verify the binary layout as well; never install a placeholder or a different model.
 VENeuralSpec.decodeWeights(bytes);
 const record={id:MODEL.id,blob:MODEL.gitBlob,bytes:bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),installedAt:new Date().toISOString()};
 await dbWrite(record);cached=record;await api.storage.local.set({fiModelRevision:MODEL.id+':'+MODEL.gitBlob});
 progress={state:'ready',received:MODEL.bytes,total:MODEL.bytes};return {installed:true,bytes:MODEL.bytes,id:MODEL.id};
}
async function download(){
 const allowed=await api.permissions.contains({origins:[MODEL.origin]});if(!allowed)throw new Error('Model-download permission was not granted. You can import the file instead.');
 downloadController=new AbortController();const timeout=setTimeout(()=>downloadController?.abort(),120000);
 try{
  progress={state:'downloading',received:0,total:MODEL.bytes};
  const response=await fetch(MODEL.url,{signal:downloadController.signal,credentials:'omit',referrerPolicy:'no-referrer',cache:'no-store',redirect:'error'});
  if(!response.ok||!response.body)throw new Error('Model download failed: HTTP '+response.status);
  const len=response.headers.get('content-length');if(len&&Number(len)!==MODEL.bytes)throw new Error('Unexpected model download length.');
  const reader=response.body.getReader(),data=new Uint8Array(MODEL.bytes);let at=0;
  while(true){const {done,value}=await reader.read();if(done)break;
   if(at+value.length>data.length){await reader.cancel();throw new Error('Model download exceeds the expected size.');}
   data.set(value,at);at+=value.length;progress={state:'downloading',received:at,total:MODEL.bytes};
  }
  if(at!==MODEL.bytes)throw new Error('Incomplete model download.');return await install(data);
 }finally{clearTimeout(timeout);downloadController=null;}
}
// The options page is the single installation UI; the popup only reports status.
function isAdmin(sender){return sender.id===api.runtime.id&&typeof sender.url==='string'&&['popup.html','models.html'].some(p=>sender.url.split('?')[0]===api.runtime.getURL(p));}
async function handle(message,sender){
 if(sender.id!==api.runtime.id)throw new Error('Untrusted model request.');
 if(message.type==='ve-model-status'){
  const record=cached||await dbGet();return {...progress,installed:!!record,id:MODEL.id,bytes:MODEL.bytes,installedAt:record?.installedAt||null,blob:record?.blob||MODEL.gitBlob};
 }
 if(message.type==='ve-model-chunk'){
  const index=message.index;if(!Number.isInteger(index)||index<0||index>=Math.ceil(MODEL.bytes/CHUNK))throw new Error('Invalid model chunk.');
  const record=cached||await dbGet();if(!record)throw new Error('Install the neural model in the popup first.');cached=record;
  const bytes=new Uint8Array(record.bytes),start=index*CHUNK;return {index,total:bytes.length,chunkSize:CHUNK,data:encode(bytes.subarray(start,start+CHUNK))};
 }
 if(!isAdmin(sender))throw new Error('Model changes are only allowed from the extension popup.');
 if(message.type==='ve-model-remove'){
  downloadController?.abort();if(pending)try{await pending;}catch{}
  await dbWrite(null);cached=null;await api.storage.local.set({fiModelRevision:''});progress={state:'idle'};return {installed:false};
 }
 if(pending)return await pending;
 if(message.type==='ve-model-download'||message.type==='ve-model-import'){
  pending=message.type==='ve-model-download'?download():install(decode(message.data));
  try{return await pending;}catch(error){progress={state:'error',error:String(error.message||error)};throw error;}finally{pending=null;}
 }
 throw new Error('Unknown model operation.');
}
api.runtime.onMessage.addListener((message,sender,respond)=>{
 if(!message||typeof message.type!=='string'||!message.type.startsWith('ve-model-'))return false;
 handle(message,sender).then(value=>respond({ok:true,...value}),error=>respond({ok:false,error:String(error.message||error)}));return true;
});
