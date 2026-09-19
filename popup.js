"use strict";

const ext = globalThis.browser ?? globalThis.chrome;
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const statusChip = $("#statusChip");
const label = $("#label");
const detail = $("#detail");
const strength = $("#strength");
const strengthValue = $("#strengthValue");
const outline = $("#outline");
const compare = $("#compare");
const fiInfra = $("#fiInfra");
const fiSceneCut = $("#fiSceneCut");
const fiHalfLuma = $("#fiHalfLuma");
const fiBlockMatch = $("#fiBlockMatch");
const fiFallback = $("#fiFallback");
const toggle = $("#toggle");
const reload = $("#reload");
const hint = $("#hint");
const healthEl = $("#health");
const modeChips = $$("#modeChips .chip");
const qualityChips = $$("#qualityChips .chip");
const interactionChips = $$("#interactionChips .chip");
const presetChips = $$("#presetChips .chip");
const allControls = [...modeChips, ...qualityChips, ...interactionChips, ...presetChips,
  strength, outline, compare, fiInfra, fiSceneCut, fiHalfLuma, fiBlockMatch, toggle];

let tabId;
let controlsLocked = false;
let pendingUpdates = 0;
let draggingStrength = false;
let currentState = null;

const labels = {off:"Disabled",idle:"Waiting","no-video":"No video",ok:"Active","no-webgl":"WebGL unavailable",tainted:"Video blocked",error:"Unavailable"};
const tones = {off:"off",idle:"warn","no-video":"warn",ok:"ok","no-webgl":"error",tainted:"error",error:"error"};
const modeNames = {off:"Off",native:"Native",rcas:"FSR1",ravu:"RAVU"};
const number = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const fixed = (value, digits = 1) => Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : "—";

function setPressed(chips, name, value) {
  for (const chip of chips) chip.setAttribute("aria-pressed", String(chip.dataset[name] === value));
}

function setDisabled(chips, disabled) {
  for (const chip of chips) chip.disabled = controlsLocked || disabled;
}

function healthSummary(state) {
  if (state.settings.mode === "off") return {text:"Inactive",tone:"off"};
  if (state.status !== "ok" || !state.hasVideo || !state.visible) return {text:"—",tone:"off"};
  const m = state.metrics || {};
  if (number(m.missedPct) > 8 || number(m.latePct) > 25 || number(m.videoDroppedPct) > 5) return {text:"Overloaded",tone:"warn"};
  if (number(m.missedPct) > 1 || number(m.latePct) > 10) return {text:"Attention",tone:"warn"};
  return {text:"Good",tone:"ok"};
}

function renderInterpolation(state) {
  const fi = state.fi || {};
  const enabled = state.settings.fiInfra === true;
  fiInfra.checked = enabled;
  let tone = "off", title = "Off", status = "Turn on interpolation for smoother playback.";
  const backend = String(fi.backend || "").toLowerCase();
  const backendFailed = fi.backendError || /fail|error|unsupported|unavailable|disabled/.test(backend);
  if (enabled && backendFailed) {
    tone = "error";
    title = "WebGPU unavailable";
    status = "Motion interpolation is not available in this browser session.";
  } else if (enabled && (!state.hasVideo || state.status === "no-video" || state.status === "idle")) {
    tone = "warn";
    title = "Waiting for video";
    status = "Interpolation will start when playback begins.";
  } else if (enabled && (state.settings.fiBlockMatch === false || state.settings.mode === "off" || !state.visible)) {
    tone = "warn";
    title = "Interpolation paused";
    status = state.settings.fiBlockMatch === false ? "Enable motion estimation in Advanced to resume." : "Interpolation resumes when the video overlay is active.";
  } else if (enabled && state.status !== "ok") {
    tone = "warn";
    title = "Video processing unavailable";
    status = state.lastError || "Waiting for a video that can be processed.";
  } else if (enabled && fi.hasPair && /webgpu|ready/.test(backend)) {
    tone = "ok";
    title = "Interpolation active";
    const delay = number(fi.presentationDelayMs, -1);
    status = delay >= 0 ? `GPU motion · ${delay.toFixed(1)} ms presentation delay` : "GPU motion with one frame of presentation delay";
  } else if (enabled) {
    tone = "warn";
    title = "Starting interpolation";
    status = "Preparing WebGPU motion estimation…";
  }
  $("#fiStatus").dataset.tone = tone;
  $("#fiStatusTitle").textContent = title;
  $("#fiStatusDetail").textContent = status;
  $("#fiDelay").textContent = enabled && Number.isFinite(Number(fi.presentationDelayMs)) ? `${fixed(fi.presentationDelayMs)} ms` : "—";
  $("#fiCompute").textContent = enabled && Number.isFinite(Number(fi.computeMs)) ? `${fixed(fi.computeMs)} ms` : "—";
  $("#fiMethod").textContent = enabled ? (fi.backend || fi.method || "Starting") : "Off";
  $("#fiConfidence").textContent = enabled && fi.confidence != null ? `${Math.round(number(fi.confidence) * 100)}%` : "—";
  $("#fiHold").textContent = enabled ? `${number(fi.sceneCutHold)} · ${fi.hasPair ? "ready" : "buffering"}` : "—";
  $("#fiSample").textContent = fi.sample || "—";
  $("#fiRates").textContent = enabled ? `${fixed(fi.realPerSec,0)} / ${fixed(fi.midPerSec,0)} per s` : "—";
}

function render(state) {
  currentState = state;
  controlsLocked = false;
  const settings = state.settings || {};
  const metrics = state.metrics || {};
  statusChip.dataset.tone = tones[state.status] || "warn";
  label.textContent = labels[state.status] || state.status || "Checking";
  const size = state.canvasWidth && state.canvasHeight ? ` · ${state.canvasWidth}×${state.canvasHeight}` : "";
  detail.textContent = state.lastError || (state.hasVideo ? `${state.pipeline || modeNames[settings.mode] || "Video"}${size}` : "Open or play a video in this tab.");

  setPressed(modeChips,"mode",settings.mode);
  setPressed(qualityChips,"quality",settings.quality);
  setPressed(interactionChips,"interaction",settings.interaction);
  setDisabled(modeChips,false); setDisabled(qualityChips,false);
  const renderOn = ["native","rcas","ravu"].includes(settings.mode);
  const spatialOn = ["rcas","ravu"].includes(settings.mode);
  setDisabled(interactionChips,!renderOn); setDisabled(presetChips,!spatialOn);
  strength.disabled = controlsLocked || !spatialOn;
  if (!draggingStrength) strength.value = number(settings.strength,35);
  strengthValue.textContent = `${number(strength.value)}%`;
  outline.checked = settings.outline === true; compare.checked = settings.compare === true;
  fiSceneCut.checked = settings.fiSceneCut !== false; fiHalfLuma.checked = settings.fiHalfLuma !== false;
  fiBlockMatch.checked = settings.fiBlockMatch !== false; fiFallback.checked = true;
  fiSceneCut.disabled = !settings.fiInfra; fiHalfLuma.disabled = !settings.fiInfra; fiBlockMatch.disabled = !settings.fiInfra; fiFallback.disabled = true;
  toggle.disabled = settings.mode === "off" || !state.hasVideo || state.status !== "ok";
  toggle.textContent = state.visible ? "Hide overlay" : "Show overlay";
  renderInterpolation(state);

  const health = healthSummary(state); healthEl.textContent = health.text; healthEl.dataset.tone = health.tone;
  $("#fps").textContent = `${fixed(metrics.videoFps)} / ${fixed(number(metrics.fps)+number(metrics.midFps))} fps`;
  $("#renderScale").textContent = `${Math.round(number(metrics.renderScale,1)*100)}%`;
  $("#missed").textContent = `${number(metrics.missed)} (${fixed(metrics.missedPct)}%)`;
  $("#videoDropped").textContent = `${number(metrics.videoDropped)} (${fixed(metrics.videoDroppedPct)}%)`;
  $("#late").textContent = metrics.latePct == null ? "n/a" : `${fixed(metrics.latePct)}%`;
  $("#cpu").textContent = `${fixed(metrics.cpuMs,2)} ms`;
  $("#gpu").textContent = metrics.gpuMs == null ? (metrics.gpuSupported ? "measuring…" : "n/a") : `${fixed(metrics.gpuMs,2)} ms`;
  $("#decoder").textContent = metrics.decoderMs == null ? "n/a" : `${fixed(metrics.decoderMs,2)} ms`;
  hint.textContent = settings.fiInfra ? "Interpolation adds one frame of presentation delay." : "Settings apply to this tab.";
}

async function send(type, settings) { return ext.tabs.sendMessage(tabId,{type,settings},{frameId:0}); }

function unavailable() {
  controlsLocked = true; statusChip.dataset.tone = "error"; label.textContent = "Reload page";
  detail.textContent = "The extension is not active in this tab."; hint.textContent = "Reload the page to connect Video Enhancer.";
  for (const control of allControls) if (control) control.disabled = true;
  reload.disabled = false; healthEl.textContent = "—"; healthEl.dataset.tone = "off";
}

async function updateSettings(patch) {
  pendingUpdates++;
  try {
    await ext.storage.local.set(patch);
    render(await send("fv-settings",patch));
  } finally { pendingUpdates--; }
}

for (const chip of modeChips) chip.addEventListener("click",()=> {
  const mode = chip.dataset.mode;
  const patch = mode === "off" && currentState?.settings?.fiInfra ? {mode,fiInfra:false} : {mode};
  updateSettings(patch).catch(unavailable);
});
for (const chip of qualityChips) chip.addEventListener("click",()=>updateSettings({quality:chip.dataset.quality}).catch(unavailable));
for (const chip of interactionChips) chip.addEventListener("click",()=>updateSettings({interaction:chip.dataset.interaction}).catch(unavailable));
for (const chip of presetChips) chip.addEventListener("click",()=>updateSettings({strength:number(chip.dataset.strength)}).catch(unavailable));

strength.addEventListener("pointerdown",()=>{draggingStrength=true});
strength.addEventListener("input",()=>{strengthValue.textContent=`${strength.value}%`;send("fv-settings",{strength:number(strength.value)}).catch(unavailable)});
strength.addEventListener("change",async()=>{draggingStrength=false;await ext.storage.local.set({strength:number(strength.value)})});
strength.addEventListener("pointerup",()=>{draggingStrength=false});
outline.addEventListener("change",()=>updateSettings({outline:outline.checked}).catch(unavailable));
compare.addEventListener("change",()=>updateSettings({compare:compare.checked}).catch(unavailable));
fiInfra.addEventListener("change",()=>{
  const enabled = fiInfra.checked;
  const patch = {fiInfra:enabled};
  if (enabled && currentState?.settings?.mode === "off") patch.mode = "native";
  updateSettings(patch).catch(unavailable);
});
for (const input of [fiSceneCut,fiHalfLuma,fiBlockMatch]) input.addEventListener("change",()=>updateSettings({[input.id]:input.checked}).catch(unavailable));
toggle.addEventListener("click",()=>send("fv-toggle").then(render).catch(unavailable));
reload.addEventListener("click",async()=>{await ext.tabs.reload(tabId);window.close()});

async function init() {
  try { $("#version").textContent=`v${ext.runtime.getManifest().version}`; } catch { $("#version").textContent="v—"; }
  const [tab] = await ext.tabs.query({active:true,currentWindow:true}); tabId = tab?.id;
  if (tabId === undefined) throw new Error("Active tab not found");
  reload.disabled = false; render(await send("fv-status"));
}

init().catch(unavailable);
setInterval(()=>{if(tabId!==undefined&&!controlsLocked&&!pendingUpdates&&!draggingStrength)send("fv-status").then(render).catch(unavailable)},1000);
