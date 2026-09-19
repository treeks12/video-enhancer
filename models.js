'use strict';
const api=globalThis.browser??globalThis.chrome,$=s=>document.querySelector(s);
const status=$('#status'),details=$('#details'),buttons=[...document.querySelectorAll('button')];
let busy=false;
function message(text,error=false){status.textContent=text;status.dataset.error=String(error);}
async function show(){try{const model=await FiNeuralModel.load();message('Model installed. Select Neural in the extension popup.');details.textContent=`${model.id}\nSHA-256 (local integrity): ${model.sha256}`;}catch{message('No usable model installed. Classical interpolation is still available.');details.textContent='';}}
async function run(action){if(busy)return;if(!$('#consent').checked){message('Read and accept the weight license before installing.',true);return;}busy=true;buttons.forEach(b=>b.disabled=true);try{await action();await show();}catch(e){message(e.message||String(e),true);}finally{busy=false;buttons.forEach(b=>b.disabled=false);}}
$('#download').addEventListener('click',()=>{
 if(busy||!$('#consent').checked){message('Read and accept the weight license before downloading.',true);return;}
 // Invoke the permission request directly within the user's click gesture.
 const permission=api.permissions.request({origins:['https://cdn.jsdelivr.net/*']});
 run(async()=>{let timer,controller;try{
  if(!await permission)throw new Error('Download permission was not granted. Offline import is available.');
  message('Downloading model data…');controller=new AbortController();timer=setTimeout(()=>controller.abort(),60000);
  const [json,bin]=await Promise.all([FiNeuralModel.fetchBounded(FiNeuralModel.BASE+'rt_v7s.json',128*1024,controller.signal),FiNeuralModel.fetchBounded(FiNeuralModel.BASE+'rt_v7s.bin',8*1024*1024,controller.signal)]);
  message('Validating tensors and saving locally…');await FiNeuralModel.store(JSON.parse(new TextDecoder().decode(json)),bin);
 }finally{clearTimeout(timer);controller?.abort();await api.permissions.remove({origins:['https://cdn.jsdelivr.net/*']}).catch(()=>{});}});
});
$('#import').addEventListener('click',()=>run(async()=>{const j=$('#manifest').files[0],b=$('#binary').files[0];if(!j||!b)throw new Error('Choose both model files.');if(j.size>128*1024||b.size>8*1024*1024)throw new Error('Model files exceed the size limit.');await FiNeuralModel.store(JSON.parse(await j.text()),await b.arrayBuffer());}));
$('#remove').addEventListener('click',async()=>{if(busy)return;await api.storage.local.remove(FiNeuralModel.KEY);await api.storage.local.set({fiNeuralRevision:Date.now()});await show();});
show();
