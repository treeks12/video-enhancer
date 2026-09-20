'use strict';
const api=globalThis.browser??globalThis.chrome,$=s=>document.querySelector(s);
const status=$('#status'),details=$('#details'),ifrStatus=$('#ifrStatus'),ifrDetails=$('#ifrDetails');
const buttons=[...document.querySelectorAll('button')];
let busy=false;
function message(el,text,error=false){el.textContent=text;el.dataset.error=String(error);}
async function modelCall(type,extra={},retried=false){
 let v;
 try{v=await api.runtime.sendMessage({type,...extra});}
 catch(e){
  // A sleeping or just-reloaded background can reject the first call with a
  // dead-channel error; one retry after a beat covers the wake/reload race.
  const dead=/receiving end does not exist|message channel|context invalidated|extension context/i.test(String(e.message));
  if(!dead||retried)throw new Error(dead?'The extension background is not responding. Reload the extension (about:debugging → Reload, or the extensions page), reopen this page and try again.':e);
  await new Promise(r=>setTimeout(r,400));
  return modelCall(type,extra,true);
 }
 if(!v?.ok)throw new Error(v?.error||'Model service unavailable. Reload the extension.');return v;
}
async function show(){ // Framegen weights live in storage.local via FiNeuralModel.
 try{const model=await FiNeuralModel.load();
  message(status,'Installed — the Framegen engine is ready.');
  details.textContent=`${model.id}\nSHA-256 (local integrity): ${model.sha256}`;
 }catch{message(status,'Not installed. The Framegen engine falls back to classical motion until you install these weights.',true);details.textContent='';}}
async function ifrShow(){ // IFRNet-S weights live in IndexedDB via the background model service.
 try{const v=await modelCall('ve-model-status');
  if(v.installed){message(ifrStatus,'Installed — the IFRNet-S engine is ready.');
   ifrDetails.textContent=`${v.id} · ${v.bytes} bytes\ngit blob ${v.blob}\ninstalled ${v.installedAt||'unknown date'}`;}
  else{message(ifrStatus,'Not installed. The IFRNet-S engine falls back to classical motion until you install these weights.',true);ifrDetails.textContent='';}
 }catch(e){message(ifrStatus,e.message||String(e),true);ifrDetails.textContent='';}}
async function refresh(){await Promise.all([show(),ifrShow()]);}
async function run(statusEl,action){if(busy)return;busy=true;buttons.forEach(b=>b.disabled=true);
 try{await action();}catch(e){message(statusEl,e.message||String(e),true);}finally{busy=false;buttons.forEach(b=>b.disabled=false);await refresh();}}
$('#download').addEventListener('click',()=>{
 if(busy||!$('#consent').checked){message(status,'Read and accept the weights license before downloading.',true);return;}
 // Invoke the permission request directly within the user's click gesture.
 const permission=api.permissions.request({origins:['https://cdn.jsdelivr.net/*']});
 run(status,async()=>{let timer,controller;try{
  if(!await permission)throw new Error('Download permission was not granted. Offline import is available.');
  message(status,'Downloading model data…');controller=new AbortController();timer=setTimeout(()=>controller.abort(),60000);
  const [json,bin]=await Promise.all([FiNeuralModel.fetchBounded(FiNeuralModel.BASE+'rt_v7s.json',128*1024,controller.signal),FiNeuralModel.fetchBounded(FiNeuralModel.BASE+'rt_v7s.bin',8*1024*1024,controller.signal)]);
  message(status,'Validating tensors and saving locally…');await FiNeuralModel.store(JSON.parse(new TextDecoder().decode(json)),bin);
 }finally{clearTimeout(timer);controller?.abort();await api.permissions.remove({origins:['https://cdn.jsdelivr.net/*']}).catch(()=>{});}});});
$('#import').addEventListener('click',()=>run(status,async()=>{const j=$('#manifest').files[0],b=$('#binary').files[0];if(!j||!b)throw new Error('Choose both model files.');if(j.size>128*1024||b.size>8*1024*1024)throw new Error('Model files exceed the size limit.');await FiNeuralModel.store(JSON.parse(await j.text()),await b.arrayBuffer());}));
$('#remove').addEventListener('click',async()=>{if(busy)return;await api.storage.local.remove(FiNeuralModel.KEY);await api.storage.local.set({fiNeuralRevision:Date.now()});await refresh();});
$('#ifrDownload').addEventListener('click',()=>{
 if(busy||!$('#ifrConsent').checked){message(ifrStatus,'Read and accept the model license before downloading.',true);return;}
 const permission=api.permissions.request({origins:['https://cdn.jsdelivr.net/*']});
 run(ifrStatus,async()=>{try{
  if(!await permission)throw new Error('Download permission was not granted. Offline import is available.');
  message(ifrStatus,'Downloading and verifying IFRNet-S…');
  await modelCall('ve-model-download');
 }finally{await api.permissions.remove({origins:['https://cdn.jsdelivr.net/*']}).catch(()=>{});}});});
$('#ifrImport').addEventListener('change',async event=>{const f=event.target.files?.[0];event.target.value='';if(!f||busy)return;
 run(ifrStatus,async()=>{if(f.size>8*1024*1024)throw new Error('Model file exceeds the size limit.');
  const b=new Uint8Array(await f.arrayBuffer());let text='';for(let i=0;i<b.length;i+=16384)text+=String.fromCharCode(...b.subarray(i,i+16384));
  await modelCall('ve-model-import',{data:btoa(text)});});});
$('#ifrRemove').addEventListener('click',()=>run(ifrStatus,async()=>{await modelCall('ve-model-remove');}));
refresh();
