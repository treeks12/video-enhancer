'use strict';

// Exercise the shipped popup script with deterministic extension responses.
// This validates state and message ordering, not browser layout or GPU speed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname,'..');
const htmlSource = fs.readFileSync(path.join(root,'popup.html'),'utf8');
const scriptSource = fs.readFileSync(path.join(root,'popup.js'),'utf8');
const copy = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => {resolve=a;reject=b;}); return {promise,resolve,reject}; };

function state(overrides = {}) {
  const base = {
    status:'ok',hasVideo:true,hasVisibleVideo:true,videoInViewport:true,canRender:true,
    visible:true,videoPaused:false,videoEnded:false,canvasWidth:1920,canvasHeight:1080,pipeline:'RAVU-lite AR → RCAS',
    settings:{mode:'ravu',strength:100,quality:'high',interaction:'smooth',protectNoise:false,
      outline:false,compare:false,fiInfra:true,fiEngine:'ifrnet',fiProfile:'balanced',fiDebug:0,
      fiSceneCut:true,fiHalfLuma:true,fiBlockMatch:true},
    metrics:{videoFps:59.7,fps:52.7,midFps:2.5,renderScale:1,missed:0,missedPct:0,
      videoDropped:0,videoDroppedPct:0,latePct:0,cpuMs:.5,gpuMs:null,gpuSupported:false,decoderMs:null},
    fi:{actualEngine:'ifrnet',backend:'IFRNet-S neural (WebGPU)',presentationBackend:'webgpu',
      computeMs:13.1,presentationDelayMs:33.3,frameIntervalMs:16.7,confidence:null,hasPair:true,
      sceneCutHold:0,midPerSec:2.5,realPerSec:52.7},
  };
  return {...base,...overrides,settings:{...base.settings,...overrides.settings},
    metrics:{...base.metrics,...overrides.metrics},fi:{...base.fi,...overrides.fi}};
}

class Element {
  constructor(tag, attrs='') {
    this.tagName = tag.toUpperCase(); this.attributes = {}; this.listeners = new Map();
    this.dataset = {}; this.checked = false; this.hidden = /\bhidden\b/.test(attrs);
    this.disabled = /\bdisabled\b/.test(attrs); this.textContent = ''; this.value = '';
    for (const match of attrs.matchAll(/([\w-]+)="([^"]*)"/g)) {
      const [,name,value] = match; this.attributes[name]=value;
      if(name==='id')this.id=value;
      if(name==='value')this.value=value;
      if(name.startsWith('data-'))this.dataset[name.slice(5)]=value;
    }
  }
  setAttribute(name,value) { this.attributes[name]=String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  addEventListener(name,callback) {
    if(!this.listeners.has(name))this.listeners.set(name,[]);
    this.listeners.get(name).push(callback);
  }
  dispatch(name) { for(const callback of this.listeners.get(name)||[])callback({type:name,target:this}); }
  click() { if(!this.disabled)this.dispatch('click'); }
}

async function harness(initial=state(), store=false) {
  const strip = source => source.replace(/\/\* PERSONAL_ONLY_BEGIN \*\/[\s\S]*?\/\* PERSONAL_ONLY_END \*\//g,'')
    .replace(/<!-- PERSONAL_ONLY_BEGIN -->[\s\S]*?<!-- PERSONAL_ONLY_END -->/g,'');
  const html = store ? strip(htmlSource) : htmlSource;
  const script = store ? strip(scriptSource) : scriptSource;
  const nodes = new Map(), groups = new Map();
  for(const match of html.matchAll(/<([a-z]+)\b([^>]*\bid="[^"]+"[^>]*)>/g)) {
    const node = new Element(match[1],match[2]); nodes.set(node.id,node);
  }
  for(const id of ['modeChips','qualityChips','interactionChips','presetChips']) {
    const inner = html.match(new RegExp('<div[^>]*id="'+id+'"[^>]*>([\\s\\S]*?)</div>'))[1];
    groups.set('#'+id+' .chip',[...inner.matchAll(/<button\b([^>]*)>/g)].map(m=>new Element('button',m[1])));
  }
  for(const id of ['fiEngine','fiProfile','fiDebug']) {
    const inner = html.match(new RegExp('<select[^>]*id="'+id+'"[^>]*>([\\s\\S]*?)</select>'))[1];
    nodes.get(id).options = [...inner.matchAll(/<option\b([^>]*)>/g)].map(m=>new Element('option',m[1]));
  }
  const h = {nodes,groups,state:copy(initial),saved:{},writes:[],messages:[],timers:new Map(),intervals:[],urls:[],downloads:[],failStatus:false,
    modelStatus:{ok:true,bundled:true},modelStorage:{},framegenFile:false};
  let timerId=0;
  const document = {
    querySelector: selector => nodes.get(selector.slice(1)) || null,
    querySelectorAll: selector => groups.get(selector) || [],
    createElement: tag => {const element=new Element(tag);element.click=()=>h.downloads.push(element);return element;},
  };
  const chrome = {
    runtime:{getManifest:()=>({version:'0.0.72'}),sendMessage:async()=>copy(h.modelStatus),
      getURL:value=>'extension://'+value,openOptionsPage:async()=>{h.openedOptions=true;}},
    storage:{local:{get:async()=>copy(h.modelStorage),set:async patch=>{
      h.writes.push(copy(patch));
      if(h.saveGate){const gate=h.saveGate;h.saveGate=null;await gate;}
      if(h.failSave){h.failSave=false;throw new Error('storage failure');}
      Object.assign(h.saved,copy(patch));
    }}},
    tabs:{query:async()=>[{id:7}],reload:async()=>{h.reloaded=true;},sendMessage:async(_tab,message)=>{
      h.messages.push(copy(message));
      if(message.type==='fv-status'&&h.failStatus)throw new Error('No receiver');
      if(message.settings)Object.assign(h.state.settings,copy(message.settings));
      if(message.type==='fv-toggle')h.state.visible=!h.state.visible;
      const snapshot=copy(h.state);
      if(message.type==='fv-settings'&&h.applyGate){const gate=h.applyGate;h.applyGate=null;await gate;}
      if(message.type==='fv-status'&&h.statusGate){const gate=h.statusGate;h.statusGate=null;await gate;}
      return snapshot;
    }},
  };
  const context = vm.createContext({document,chrome,console,Blob,URL:{createObjectURL:blob=>{h.urls.push(blob);return 'blob:test';},revokeObjectURL:()=>{}},
    window:{close:()=>{h.closed=true;}},VE_BUILD:{personal:!store,flavor:store?'store':'personal'},
    fetch:async url=>({ok:url.includes('ifrnet') || h.framegenFile}),
    setTimeout:(callback,delay)=>{const id=++timerId;h.timers.set(id,{callback,delay});return id;},
    clearTimeout:id=>h.timers.delete(id),setInterval:(callback,delay)=>{h.intervals.push({callback,delay});return h.intervals.length;}});
  h.run = expression => vm.runInContext(expression,context);
  h.node = id => nodes.get(id);
  h.chip = (group,key,value) => groups.get('#'+group+' .chip').find(node=>node.dataset[key]===value);
  h.drain = async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
  h.settle = async()=>{await h.run('settingsQueue');await h.drain();};
  h.render = next=>{h.state=copy(next);context.nextState=copy(next);h.run('render(nextState)');};
  h.flushPreview = ()=>{for(const [id,timer] of h.timers){if(timer.delay===32){h.timers.delete(id);timer.callback();}}};
  h.poll = ()=>h.run('refreshState()');
  h.refreshModels = ()=>h.run('refreshModels()');
  vm.runInContext(script,context,{filename:'popup.js'});
  await h.drain();
  return h;
}

(async()=>{
  const h=await harness();
  assert.equal(h.node('version').textContent,'v0.0.72 · Personal');
  assert.equal(h.node('fiEngine').value,'ifrnet','IFRNet-S remains default');
  assert.equal(h.node('protectNoise').checked,false,'noise guard does not change existing default');
  assert.equal(h.node('sourceFps').textContent,'59.7 fps');
  assert.equal(h.node('fiRates').textContent,'52.7 / 2.5 per s','source anchors and generated frames are separate');
  assert.equal(h.node('fps').textContent,'55.2 frames/s','total output is counted, not assumed to double');
  assert.equal(h.node('fiConfidence').textContent,'—','neural confidence is not fabricated');
  assert.equal(h.node('gpu').textContent,'Timer unavailable','missing GL timer is not missing WebGPU');
  assert.equal(h.node('presentationBackend').textContent,'webgpu');
  assert.match(h.node('hint').textContent,/Saved across tabs.*33\.3 ms/);
  assert.equal(h.writes.length,0,'opening the popup never changes defaults');

  h.render(state({fi:{midPerSec:0,hasPair:true}}));
  assert.doesNotMatch(h.node('fiStatusTitle').textContent,/active/i,'a frame pair alone is not successful interpolation');
  h.render(state({fi:{actualEngine:'none',midPerSec:0,hasPair:true}}));
  assert.equal(h.node('fiStatusTitle').textContent,'Waiting for an interpolated frame');
  h.render(state({metrics:{videoFps:null,fps:null,midFps:null,cpuMs:null,renderScale:null},fi:{computeMs:null,presentationDelayMs:null,midPerSec:null,realPerSec:null}}));
  for(const id of ['sourceFps','fps','cpu','renderScale','fiCompute','fiDelay'])assert.equal(h.node(id).textContent,'—',id+' missing measurement stays unknown');
  assert.equal(h.node('label').textContent,'Ready');

  const staleFallback={fallbackReason:'Model unavailable',backendError:'Previous engine error',midPerSec:25};
  h.render(state({videoPaused:true,fi:staleFallback}));
  assert.equal(h.node('fiStatusTitle').textContent,'Video paused','stale fallback does not override pause');
  assert.equal(h.node('label').textContent,'Paused');
  for(const id of ['sourceFps','fps','fiRates'])assert.equal(h.node(id).textContent,'—','paused rates are not live');
  h.render(state({videoEnded:true,fi:staleFallback}));
  assert.equal(h.node('fiStatusTitle').textContent,'Playback ended');
  h.render(state({visible:false,fi:staleFallback}));
  assert.equal(h.node('fiStatusTitle').textContent,'Interpolation paused');
  h.render(state({canRender:false,fi:staleFallback}));
  assert.equal(h.node('fiStatusTitle').textContent,'Waiting for visible playback');
  assert.equal(h.node('label').textContent,'Waiting');
  h.render(state({status:'preparing',fi:staleFallback}));
  assert.equal(h.node('label').textContent,'Preparing');
  assert.equal(h.node('fiStatusTitle').textContent,'Preparing enhancement');
  h.render(state({status:'buffering',fi:staleFallback}));
  assert.equal(h.node('fiStatusTitle').textContent,'Waiting for decoded frames');
  h.render(state({fi:{actualEngine:'analytic',fallbackReason:'Model unavailable'}}));
  assert.equal(h.node('fiStatusTitle').textContent,'Analytic fallback (not neural)');
  h.render(state({fi:{computeMs:117,midPerSec:0,neural:{lastRun:{completed:false,reason:'deadline',ageMs:100}}}}));
  assert.equal(h.node('fiStatusTitle').textContent,'Neural work exceeded the frame budget');
  assert.equal(h.node('fiCompute').textContent,'117.0 ms','cancelled partial work is not a completed timing');

  h.render(state({settings:{mode:'off',fiInfra:false}}));
  assert.equal(h.node('protectNoise').disabled,true);
  assert.equal(h.node('strength').disabled,true);
  h.node('fiInfra').checked=true;h.node('fiInfra').dispatch('change');await h.settle();
  assert.deepEqual(h.writes.at(-1),{fiInfra:true,mode:'native'},'interpolation enable atomically starts Original from Off');
  assert.equal(h.node('protectNoise').disabled,true,'noise limiter cannot sharpen Original');
  h.chip('modeChips','mode','ravu').click();await h.settle();
  h.node('protectNoise').checked=true;h.node('protectNoise').dispatch('change');await h.settle();
  assert.deepEqual(h.writes.at(-1),{protectNoise:true},'noise preference is explicitly persisted without changing profile or strength');
  assert.equal(h.state.settings.strength,100);
  h.chip('modeChips','mode','off').click();await h.settle();
  assert.deepEqual(h.writes.at(-1),{mode:'off',fiInfra:false});

  h.render(state());
  const save=deferred();h.saveGate=save.promise;
  h.chip('modeChips','mode','rcas').click();await h.drain();
  h.chip('modeChips','mode','ravu').click();
  assert.equal(h.chip('modeChips','mode','ravu').getAttribute('aria-pressed'),'true');
  save.resolve();await h.settle();
  assert.equal(h.saved.mode,'ravu');
  assert.equal(h.state.settings.mode,'ravu','late earlier settings never win');
  assert.equal(h.chip('modeChips','mode','ravu').getAttribute('aria-pressed'),'true');

  const poll=deferred();h.statusGate=poll.promise;
  const pendingPoll=h.poll();await h.drain();
  h.chip('modeChips','mode','rcas').click();await h.settle();
  poll.resolve();await pendingPoll;
  assert.equal(h.chip('modeChips','mode','rcas').getAttribute('aria-pressed'),'true','old polling snapshot cannot undo a newer edit');

  const apply=deferred();h.applyGate=apply.promise;
  const slider=h.node('strength'),start=h.messages.length;
  slider.dispatch('pointerdown');
  for(const value of ['52','58','88']){slider.value=value;slider.dispatch('input');}
  h.flushPreview();await h.drain();
  slider.value='90';slider.dispatch('input');slider.dispatch('pointerup');
  apply.resolve();await h.settle();h.flushPreview();await h.settle();
  assert.deepEqual(h.messages.slice(start).filter(m=>m.settings).map(m=>m.settings.strength),[88,90],
    'rapid previews are coalesced and no stale preview follows the committed value');
  assert.equal(h.saved.strength,90);assert.equal(h.node('strength').value,90);
  slider.value='77';slider.dispatch('input');slider.dispatch('change');await h.settle();h.flushPreview();await h.settle();
  assert.equal(h.saved.strength,77,'keyboard edits persist without pointer events');
  assert.equal(h.node('strength').getAttribute('aria-valuetext'),'77%');

  h.failSave=true;h.chip('modeChips','mode','ravu').click();await h.settle();
  assert.match(h.node('feedback').textContent,/Could not save settings/);
  assert.equal(h.node('fiInfra').disabled,false,'storage errors do not masquerade as a lost tab');
  h.chip('modeChips','mode','ravu').click();await h.settle();
  assert.equal(h.node('feedback').hidden,true);assert.equal(h.saved.mode,'ravu');
  h.failStatus=true;await h.poll();assert.equal(h.node('label').textContent,'Not connected');
  assert.equal(h.node('fiInfra').disabled,true);assert.equal(h.node('fiRates').textContent,'—');
  h.failStatus=false;await h.poll();assert.equal(h.node('fiInfra').disabled,false,'polling reconnects after a transient tab failure');

  h.node('saveDiagnostics').click();await h.drain();
  const payload=JSON.parse(await h.urls.at(-1).text());
  assert.equal(payload.fi.midPerSec,2.5);assert.equal(payload.metrics.videoFps,59.7);
  assert.equal(payload.settings.protectNoise,false);assert.equal(payload.canRender,true);
  assert.equal(h.downloads.at(-1).download,'video-enhancer-diagnostics.json');
  assert.equal(h.node('feedback').textContent,'Diagnostics saved.');

  // Personal model availability used to live in two historical Python smoke
  // scripts. Exercise the actual refresh path and requested/actual distinction.
  const personal=await harness(state({settings:{fiEngine:'neural'},fi:{actualEngine:'analytic',
    backend:'Analytic Flow (WebGL2; no neural weights)',fallbackReason:'Framegen weights are not installed.',midPerSec:0}}));
  assert.deepEqual(personal.node('fiEngine').options.map(option=>option.value),['ifrnet','analytic','classic','neural']);
  assert.equal(personal.node('fiEngine').value,'neural','a Personal engine preference remains selected during fallback');
  assert.equal(personal.node('modelWarn').hidden,false);
  assert.match(personal.node('modelWarn').textContent,/Framegen weights are not installed/);
  assert.match(personal.node('modelWarn').textContent,/noncommercial use/);
  assert.equal(personal.node('fiStatusTitle').textContent,'Analytic fallback (not neural)');

  personal.modelStorage={fvNeuralModelV1:{id:'framegen-test-fixture'}};
  await personal.refreshModels();
  assert.equal(personal.node('modelWarn').hidden,true,'installing Personal weights clears the missing-model warning');
  personal.render(state({settings:{fiEngine:'neural'},metrics:{videoFps:30,fps:30,midFps:28},
    fi:{actualEngine:'neural',backend:'Framegen compact neural (WebGPU)',computeMs:11.2,
      presentationDelayMs:33.3,realPerSec:30,midPerSec:28,confidence:null,
      neural:{p95:13.2,completed:100,late:2,modelSize:{width:640,height:352}}}}));
  assert.equal(personal.node('fiStatusTitle').textContent,'Framegen active');
  assert.equal(personal.node('fiConfidence').textContent,'—','Framegen confidence is not invented');
  assert.equal(personal.node('fiSample').textContent,'640×352 model');
  assert.equal(personal.node('fiNeuralStats').textContent,'13.2 ms · 100 / 2');

  for(const [actualEngine,backend,title] of [
    ['analytic','Analytic Flow (WebGL2; no neural weights)','Analytic fallback (not neural)'],
    ['classic','Legacy LK (WebGPU)','Legacy motion fallback'],
    ['none','initializing','Preparing interpolation fallback'],
  ]) {
    personal.render(state({settings:{fiEngine:'neural'},fi:{actualEngine,backend,midPerSec:0,
      fallbackReason:'The selected Framegen engine could not start.'}}));
    assert.equal(personal.node('fiEngine').value,'neural');
    assert.equal(personal.node('fiStatusTitle').textContent,title,'fallback is labeled from its actual engine, not the requested model');
    assert.equal(personal.node('fiStatusDetail').textContent,'The selected Framegen engine could not start.');
  }
  personal.modelStorage={};await personal.refreshModels();
  assert.equal(personal.node('modelWarn').hidden,false,'removing Personal weights restores the warning');
  personal.framegenFile=true;await personal.refreshModels();
  assert.equal(personal.node('modelWarn').hidden,true,'available Personal model files also satisfy the availability check');

  personal.node('fiEngine').value='ifrnet';personal.node('fiEngine').dispatch('change');await personal.settle();
  personal.modelStatus={ok:true,bundled:false,installed:false};await personal.refreshModels();
  assert.match(personal.node('modelWarn').textContent,/Bundled IFRNet-S weights are unavailable/);
  assert.equal(personal.node('modelWarn').hidden,false);
  personal.modelStatus={ok:true,bundled:true};await personal.refreshModels();
  assert.equal(personal.node('modelWarn').hidden,true,'bundled IFRNet-S never needs a Personal installation');
  personal.modelStatus={ok:true,installed:true};await personal.refreshModels();
  assert.equal(personal.node('modelWarn').hidden,true,'installed IFRNet weights are recognized too');

  const store=await harness(state({settings:{mode:'off',fiInfra:false}}),true);
  assert.equal(store.node('version').textContent,'v0.0.72 · Store');
  assert.equal(store.node('modelSetup'),undefined,'Store UI has no Personal setup');
  assert.deepEqual(store.node('fiEngine').options.map(option=>option.value),['ifrnet','analytic','classic']);
  assert.equal(store.node('fiEngine').value,'ifrnet');
  assert.equal(store.writes.length,0);
  console.log('PASS: popup state, honest rates, lifecycle precedence, noise preference, ordered edits, slider coalescing, recovery, Personal model availability, actual fallback engines and edition separation (DOM/extension mocks; no GPU validation).');
})().catch(error=>{console.error(error);process.exitCode=1;});
