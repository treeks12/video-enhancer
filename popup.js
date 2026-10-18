"use strict";

const ext = globalThis.browser ?? globalThis.chrome;
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const statusChip = $("#statusChip"), label = $("#label"), detail = $("#detail");
const strength = $("#strength"), strengthValue = $("#strengthValue");
const outline = $("#outline"), compare = $("#compare"), protectNoise = $("#protectNoise");
const fiInfra = $("#fiInfra"), fiEngine = $("#fiEngine"), fiProfile = $("#fiProfile"), fiDebug = $("#fiDebug");
const fiSceneCut = $("#fiSceneCut"), fiHalfLuma = $("#fiHalfLuma"), fiBlockMatch = $("#fiBlockMatch"), fiFallback = $("#fiFallback");
const toggle = $("#toggle"), reload = $("#reload"), hint = $("#hint"), healthEl = $("#health");
const saveDiagnostics = $("#saveDiagnostics");
const modeChips = $$("#modeChips .chip"), qualityChips = $$("#qualityChips .chip");
const interactionChips = $$("#interactionChips .chip"), presetChips = $$("#presetChips .chip");
const allControls = [...modeChips, ...qualityChips, ...interactionChips, ...presetChips,
  strength, outline, compare, protectNoise, fiInfra, fiEngine, fiProfile, fiDebug,
  fiSceneCut, fiHalfLuma, fiBlockMatch, toggle, saveDiagnostics];

let tabId;
let controlsLocked = true;
let pendingUpdates = 0;
let settingsRevision = 0;
let settingsQueue = Promise.resolve();
let polling = false;
let draggingStrength = false;
let strengthDirty = false;
let strengthPreviewTimer = null;
let currentState = null;
let confirmedState = null;

const labels = {off:"Disabled",idle:"Waiting","no-video":"No video",preparing:"Preparing",buffering:"Buffering",
  ok:"Ready","no-webgl":"GPU unavailable",tainted:"Video blocked",error:"Unavailable"};
const tones = {off:"off",idle:"warn","no-video":"warn",preparing:"warn",buffering:"warn",ok:"ok",
  "no-webgl":"error",tainted:"error",error:"error"};
const modeNames = {off:"Off",native:"Original",rcas:"FSR1",ravu:"RAVU-lite"};
const modeHints = {
  off:"Choose an image mode, or enable frame interpolation below.",
  native:"Original image without sharpening. Interpolation can be used separately.",
  rcas:"Spatial upscaling with adjustable sharpening.",
  ravu:"Edge-directed upscaling with adjustable sharpening.",
};
const engineNames = {ifrnet:"IFRNet-S",analytic:"Analytic Flow",classic:"Legacy LK"};
/* PERSONAL_ONLY_BEGIN */
engineNames.neural = "Framegen";
/* PERSONAL_ONLY_END */
const modelInstalled = {ifrnet:null};
/* PERSONAL_ONLY_BEGIN */
modelInstalled.framegen = null;
/* PERSONAL_ONLY_END */

// Missing measurements are unknown, not zero. In particular, null is not a
// successful zero-millisecond GPU job or an observed zero-frame rate.
const finite = (value) => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
const number = (value, fallback = 0) => finite(value) ? Number(value) : fallback;
const fixed = (value, digits = 1) => finite(value) ? Number(value).toFixed(digits) : "—";
const milliseconds = (value) => finite(value) ? `${fixed(value)} ms` : "—";
// Avoid repeating unchanged live-region announcements on every status poll.
function setText(element, text) {
  if (element.textContent !== text) element.textContent = text;
}

function setPressed(chips, name, value) {
  for (const chip of chips) chip.setAttribute("aria-pressed", String(chip.dataset[name] === value));
}
function setDisabled(chips, disabled) {
  for (const chip of chips) chip.disabled = controlsLocked || disabled;
}
function showFeedback(text) {
  setText($("#feedback"),text);
  $("#feedback").hidden = !text;
}
function isPresenting(state) {
  return state.status === "ok" && state.hasVideo && state.visible &&
    state.settings?.mode !== "off" && state.canRender !== false &&
    state.hasVisibleVideo !== false && state.videoInViewport !== false &&
    state.videoPaused !== true && state.videoEnded !== true;
}
function healthSummary(state) {
  if (state.settings?.mode === "off") return {text:"Inactive",tone:"off"};
  if (!isPresenting(state)) return {text:"—",tone:"off"};
  const m = state.metrics || {};
  if (!finite(m.fps) || number(m.fps) + number(m.midFps) <= 0) return {text:"Measuring",tone:"off"};
  if (number(m.missedPct) > 8 || number(m.latePct) > 25 || number(m.videoDroppedPct) > 5) return {text:"Overloaded",tone:"warn"};
  if (number(m.missedPct) > 1 || number(m.latePct) > 10) return {text:"Attention",tone:"warn"};
  return {text:"Good",tone:"ok"};
}

function renderControls(settings) {
  const mode = settings.mode || "off";
  const renderOn = ["native","rcas","ravu"].includes(mode);
  const spatialOn = ["rcas","ravu"].includes(mode);
  const enabled = settings.fiInfra === true;
  setPressed(modeChips,"mode",mode);
  setPressed(qualityChips,"quality",settings.quality);
  setPressed(interactionChips,"interaction",settings.interaction);
  setDisabled(modeChips,false);
  setDisabled(qualityChips,!renderOn);
  setDisabled(interactionChips,!renderOn);
  setDisabled(presetChips,!spatialOn);
  $("#modeHint").textContent = modeHints[mode] || modeHints.off;
  strength.disabled = controlsLocked || !spatialOn;
  if (!draggingStrength) strength.value = number(settings.strength,100);
  strengthValue.textContent = `${number(strength.value)}%`;
  strength.setAttribute("aria-valuetext", strengthValue.textContent);
  compare.checked = settings.compare === true;
  compare.disabled = controlsLocked || !renderOn;
  protectNoise.checked = settings.protectNoise === true;
  protectNoise.disabled = controlsLocked || !spatialOn;
  outline.checked = settings.outline === true;
  outline.disabled = controlsLocked || !renderOn;
  fiInfra.checked = enabled;
  fiInfra.disabled = controlsLocked;
  fiEngine.value = settings.fiEngine || "ifrnet";
  fiEngine.disabled = controlsLocked;
  fiProfile.value = settings.fiProfile || "balanced";
  fiProfile.disabled = controlsLocked || fiEngine.value === "classic";
  fiDebug.value = String(settings.fiDebug || 0);
  fiDebug.disabled = controlsLocked || !enabled || fiEngine.value === "classic";
  fiDebug.options[3].textContent = fiEngine.value === "ifrnet" ? "Refine residual" : "Warp disagreement";
  fiDebug.options[4].textContent = fiEngine.value === "analytic" ? "Fallback regions" : "Refine residual";
  fiDebug.options[4].disabled = fiEngine.value === "ifrnet";
  fiSceneCut.checked = settings.fiSceneCut !== false;
  fiHalfLuma.checked = settings.fiHalfLuma !== false;
  fiBlockMatch.checked = settings.fiBlockMatch !== false;
  fiFallback.checked = true;
  fiSceneCut.disabled = controlsLocked || !enabled;
  fiHalfLuma.disabled = controlsLocked || !enabled || fiEngine.value !== "classic";
  fiBlockMatch.disabled = controlsLocked || !enabled;
  fiFallback.disabled = true;
  toggle.disabled = controlsLocked || pendingUpdates > 0 || !renderOn || !currentState?.hasVideo || currentState.status !== "ok";
  toggle.textContent = currentState?.visible ? "Hide effects" : "Show effects";
  saveDiagnostics.disabled = controlsLocked || pendingUpdates > 0;
  updateModelWarn();
}

function interpolationSummary(state) {
  const settings = state.settings || {}, fi = state.fi || {};
  const result = (tone,title,status) => ({tone,title,status});
  if (settings.fiInfra !== true) return result("off","Off","Turn on interpolation for smoother playback.");
  if (settings.fiBlockMatch === false || settings.mode === "off" || !state.visible && state.hasVideo) {
    return result("warn","Interpolation paused",settings.fiBlockMatch === false ?
      "Enable motion estimation in Advanced to resume." : "Interpolation resumes when the video overlay is active.");
  }
  if (!state.hasVideo || state.status === "no-video") return result("warn","Waiting for video","Interpolation will start when playback begins.");
  if (state.videoEnded) return result("off","Playback ended","Play another video to resume interpolation.");
  if (state.videoPaused) return result("off","Video paused","Interpolation resumes with video playback.");
  if (state.status === "preparing") return result("warn","Preparing enhancement","Video processing is starting. The source video remains visible.");
  if (state.status === "buffering" || state.status === "idle") return result("warn","Waiting for decoded frames","Interpolation needs adjacent decoded video frames.");
  if (state.status !== "ok") return result("warn","Video processing unavailable",state.lastError || "Waiting for a video that can be processed.");
  if (state.hasVisibleVideo === false || state.videoInViewport === false || state.canRender === false) {
    return result("off","Waiting for visible playback","Interpolation resumes when the selected video can be rendered.");
  }
  const backend = String(fi.backend || "").toLowerCase();
  if (fi.backendError || /fail|error|unsupported|unavailable|disabled/.test(backend)) {
    return result("error","Motion backend unavailable",fi.backendError || "Motion interpolation is unavailable in this browser session.");
  }
  if (fi.fallbackReason) {
    const fallback = fi.actualEngine === "analytic" ? "Analytic fallback (not neural)" :
      fi.actualEngine === "classic" ? "Legacy motion fallback" : "Preparing interpolation fallback";
    return result("warn",fallback,fi.fallbackReason);
  }
  const name = engineNames[fi.actualEngine] || engineNames[settings.fiEngine] || "Interpolation";
  const mids = number(fi.midPerSec);
  if (mids > 0) {
    const title = ["ifrnet","neural"].includes(fi.actualEngine) ? `${name} active` :
      fi.actualEngine === "analytic" ? "Analytic interpolation active" : "Interpolation active";
    return result("ok",title,`${fixed(mids)} interpolated frames/s rendered. ${number(fi.presentationDelayMs) > 0 ? milliseconds(fi.presentationDelayMs) + " presentation delay." : ""}`.trim());
  }
  if (backend === "initializing" || backend === "preparing") {
    return result("warn",`Preparing ${name}`,"Preparing the local motion engine. No interpolated frames have been rendered yet.");
  }
  if (["ifrnet","neural"].includes(fi.actualEngine)) {
    const run = fi.neural?.lastRun;
    const cancelled = (run && !run.completed && run.reason === "deadline" && number(run.ageMs,Infinity) < 1500) ||
      (finite(fi.neural?.deadlineAgeMs) && number(fi.neural.deadlineAgeMs) < 1500);
    if (cancelled) return result("warn","Neural work exceeded the frame budget","Late neural work was stopped to preserve source playback. The selected model quality is unchanged.");
    if (number(fi.frameIntervalMs) > 0 && number(fi.computeMs) >= number(fi.frameIntervalMs)) {
      return result("warn","Neural inference is behind playback","No interpolated frames were rendered in the last measurement window.");
    }
    const title = /No extra display slot/.test(fi.explain || "") ? "No extra display slot" :
      /Waiting for adjacent/.test(fi.explain || "") ? "Waiting for adjacent video frames" : "Waiting for a neural result";
    return result("warn",title,fi.explain || "No interpolated frames were rendered in the last measurement window.");
  }
  return result("warn",fi.actualEngine === "analytic" ? "Analytic: preparing or missing slots" : "Waiting for an interpolated frame",
    fi.explain || "A prepared frame pair does not guarantee a rendered interpolated frame.");
}

function renderInterpolation(state) {
  const fi = state.fi || {}, enabled = state.settings.fiInfra === true;
  const summary = interpolationSummary(state);
  $("#fiStatus").dataset.tone = summary.tone;
  setText($("#fiStatusTitle"),summary.title);
  $("#fiStatusDetail").textContent = summary.status;
  $("#fiDelay").textContent = enabled ? milliseconds(fi.presentationDelayMs) : "—";
  $("#fiCompute").textContent = enabled ? milliseconds(fi.computeMs) : "—";
  $("#fiMethod").textContent = enabled ? (fi.backend || fi.method || "Starting") : "Off";
  $("#presentationBackend").textContent = state.settings.mode !== "off" ? (fi.presentationBackend || "—") : "—";
  $("#fiConfidence").textContent = enabled && finite(fi.confidence) ? `${Math.round(number(fi.confidence) * 100)}%` : "—";
  $("#fiHold").textContent = enabled ? `${fixed(fi.sceneCutHold,0)} · ${fi.hasPair ? "ready" : "buffering"}` : "—";
  const neural = fi.neural || fi.analytic;
  $("#fiSample").textContent = enabled ? (neural?.modelSize ? `${neural.modelSize.width}×${neural.modelSize.height} model` : (fi.sample || "—")) : "—";
  $("#fiNeuralStats").textContent = enabled && neural ? `${milliseconds(neural.p95 ?? neural.ms)} · ${fixed(neural.completed,0)} / ${fixed(neural.late,0)}` : "n/a";
  $("#fiCoverage").textContent = enabled && finite(fi.analytic?.coverage) ? `${Math.round(number(fi.analytic.coverage)*100)}% sampled support` : "n/a";
  const metrics = state.metrics || {};
  $("#fiRates").textContent = isPresenting(state) ? `${fixed(fi.realPerSec ?? metrics.fps)} / ${fixed(fi.midPerSec ?? metrics.midFps)} per s` : "—";
}

function render(state) {
  if (!state || !state.settings) throw new Error("Invalid video status");
  currentState = state;
  confirmedState = state;
  controlsLocked = false;
  const settings = state.settings, metrics = state.metrics || {};
  let title = labels[state.status] || "Waiting", tone = tones[state.status] || "warn";
  let description = state.lastError || (state.hasVideo ? "Waiting for video processing." : "Open or play a video in this tab.");
  if (settings.mode === "off") { title = "Disabled"; tone = "off"; description = "Choose an image mode or enable frame interpolation."; }
  else if (state.status === "preparing") description = "Preparing enhancement. The source video remains visible.";
  else if (state.status === "buffering") description = "Waiting for the next decoded video frame.";
  else if (state.status === "ok") {
    if (!state.visible) { title = "Hidden"; tone = "off"; description = "Effects are hidden in this tab. Show effects to resume."; }
    else if (state.videoEnded) { title = "Ended"; tone = "off"; description = "Video playback has ended."; }
    else if (state.videoPaused) { title = "Paused"; tone = "off"; description = "Video paused. The current image can still be enhanced."; }
    else if (!isPresenting(state)) { title = "Waiting"; tone = "off"; description = "Waiting for visible video playback."; }
    else {
      const measured = number(metrics.fps) + number(metrics.midFps) > 0;
      title = !measured ? "Ready" : settings.mode === "native" ? "Original" : "Enhancing";
      tone = measured ? "ok" : "off";
      const size = state.canvasWidth && state.canvasHeight ? ` · ${state.canvasWidth}×${state.canvasHeight}` : "";
      description = `${modeNames[settings.mode] || "Video"}${size}${measured ? "" : " · measuring playback"}`;
    }
  }
  statusChip.dataset.tone = tone;
  setText(label,title);
  detail.textContent = description;
  renderControls(settings);
  renderInterpolation(state);
  const health = healthSummary(state);
  healthEl.textContent = health.text;
  healthEl.dataset.tone = health.tone;
  const presenting = isPresenting(state);
  $("#sourceFps").textContent = presenting && finite(metrics.videoFps) ? `${fixed(metrics.videoFps)} fps` : "—";
  $("#fps").textContent = presenting && finite(metrics.fps) && finite(metrics.midFps) ? `${fixed(number(metrics.fps)+number(metrics.midFps))} frames/s` : "—";
  $("#renderScale").textContent = finite(metrics.renderScale) ? `${Math.round(number(metrics.renderScale)*100)}%` : "—";
  $("#missed").textContent = finite(metrics.missed) ? `${fixed(metrics.missed,0)} (${fixed(metrics.missedPct)}%)` : "—";
  $("#videoDropped").textContent = finite(metrics.videoDropped) ? `${fixed(metrics.videoDropped,0)} (${fixed(metrics.videoDroppedPct)}%)` : "—";
  $("#late").textContent = finite(metrics.latePct) ? `${fixed(metrics.latePct)}%` : "n/a";
  $("#cpu").textContent = finite(metrics.cpuMs) ? `${fixed(metrics.cpuMs,2)} ms` : "—";
  $("#gpu").textContent = finite(metrics.gpuMs) ? `${fixed(metrics.gpuMs,2)} ms` : (metrics.gpuSupported ? "Measuring…" : "Timer unavailable");
  $("#decoder").textContent = finite(metrics.decoderMs) ? `${fixed(metrics.decoderMs,2)} ms` : "n/a";
  hint.textContent = settings.fiInfra && number(state.fi?.presentationDelayMs) > 0 ?
    `Saved across tabs · ${milliseconds(state.fi.presentationDelayMs)} motion delay.` :
    "Saved settings apply across tabs. Video stays on this device.";
}

async function send(type, settings) {
  return ext.tabs.sendMessage(tabId,{type,settings},{frameId:0});
}
function unavailable() {
  controlsLocked = true;
  statusChip.dataset.tone = "warn";
  setText(label,"Not connected");
  detail.textContent = "Video Enhancer could not connect to this tab.";
  hint.textContent = "Open a regular web page or reload this tab to reconnect.";
  for (const control of allControls) if (control) control.disabled = true;
  reload.disabled = tabId === undefined;
  healthEl.textContent = "—";
  healthEl.dataset.tone = "off";
  $("#fiStatus").dataset.tone = "off";
  setText($("#fiStatusTitle"),"Status unavailable");
  $("#fiStatusDetail").textContent = "Reconnect to check the current interpolation state.";
  for (const id of ["sourceFps","fps","fiRates"]) $("#" + id).textContent = "—";
}

// Serialize saves and messages: a slow earlier acknowledgement must never
// overwrite a newer control change or send an old slider preview after commit.
function updateSettings(patch, {persist = true} = {}) {
  const revision = ++settingsRevision;
  pendingUpdates++;
  if (currentState) {
    currentState = {...currentState, settings:{...currentState.settings,...patch}};
    renderControls(currentState.settings);
  }
  showFeedback("");
  const work = settingsQueue.then(async () => {
    let phase = persist ? "save" : "apply";
    try {
      if (persist) await ext.storage.local.set(patch);
      phase = "apply";
      const state = await send("fv-settings",patch);
      if (revision === settingsRevision) render(state);
      return true;
    } catch (error) {
      if (revision === settingsRevision) {
        if (phase === "save") {
          if (confirmedState) render(confirmedState);
          showFeedback("Could not save settings. Please try the change again.");
        } else {
          unavailable();
          if (persist) showFeedback("Settings were saved. Reconnect this tab to check their effect.");
        }
      }
      return false;
    } finally {
      pendingUpdates--;
      if (!pendingUpdates && !controlsLocked && currentState) renderControls(currentState.settings);
    }
  });
  settingsQueue = work;
  return work;
}

function cancelStrengthPreview() {
  if (strengthPreviewTimer !== null) clearTimeout(strengthPreviewTimer);
  strengthPreviewTimer = null;
}
function finishStrengthEdit() {
  draggingStrength = false;
  cancelStrengthPreview();
  if (!strengthDirty) return;
  strengthDirty = false;
  updateSettings({strength:number(strength.value)});
}
for (const chip of modeChips) chip.addEventListener("click",() => {
  const mode = chip.dataset.mode;
  const patch = mode === "off" && currentState?.settings?.fiInfra ? {mode,fiInfra:false} : {mode};
  updateSettings(patch);
});
for (const chip of qualityChips) chip.addEventListener("click",() => updateSettings({quality:chip.dataset.quality}));
for (const chip of interactionChips) chip.addEventListener("click",() => updateSettings({interaction:chip.dataset.interaction}));
for (const chip of presetChips) chip.addEventListener("click",() => updateSettings({strength:number(chip.dataset.strength)}));
strength.addEventListener("pointerdown",() => {draggingStrength = true;});
strength.addEventListener("input",() => {
  draggingStrength = true;
  strengthDirty = true;
  strengthValue.textContent = `${strength.value}%`;
  strength.setAttribute("aria-valuetext",strengthValue.textContent);
  if (strengthPreviewTimer === null) strengthPreviewTimer = setTimeout(() => {
    strengthPreviewTimer = null;
    updateSettings({strength:number(strength.value)},{persist:false});
  },32);
});
for (const event of ["change","pointerup","pointercancel","blur"]) strength.addEventListener(event,finishStrengthEdit);
for (const input of [outline,compare,protectNoise,fiSceneCut,fiHalfLuma,fiBlockMatch]) {
  input.addEventListener("change",() => updateSettings({[input.id]:input.checked}));
}
fiInfra.addEventListener("change",() => {
  const patch = {fiInfra:fiInfra.checked};
  if (patch.fiInfra && currentState?.settings?.mode === "off") patch.mode = "native";
  updateSettings(patch);
});
for (const input of [fiEngine,fiProfile,fiDebug]) input.addEventListener("change",() =>
  updateSettings({[input.id]:input.id === "fiDebug" ? Number(input.value) : input.value}));
/* PERSONAL_ONLY_BEGIN */
$("#modelSetup")?.addEventListener("click",() => {
  Promise.resolve().then(() => ext.runtime.openOptionsPage()).catch(() => showFeedback("Could not open Personal model setup."));
});
/* PERSONAL_ONLY_END */
toggle.addEventListener("click",() => send("fv-toggle").then(render).catch(unavailable));
reload.addEventListener("click",async () => {
  try { await ext.tabs.reload(tabId); window.close(); }
  catch { showFeedback("Could not reload this tab. Reload it from your browser."); }
});

async function refreshState() {
  if (tabId === undefined || polling || pendingUpdates || draggingStrength) return;
  const revision = settingsRevision;
  polling = true;
  try {
    const state = await send("fv-status");
    if (revision === settingsRevision && !pendingUpdates && !draggingStrength) render(state);
  } catch {
    if (revision === settingsRevision) unavailable();
  } finally { polling = false; }
}
async function init() {
  try { $("#version").textContent = `v${ext.runtime.getManifest().version} · ${globalThis.VE_BUILD?.personal === false ? "Store" : "Personal"}`; }
  catch { $("#version").textContent = "v—"; }
  const [tab] = await ext.tabs.query({active:true,currentWindow:true});
  tabId = tab?.id;
  if (tabId === undefined) throw new Error("Active tab not found");
  reload.disabled = false;
  await refreshState();
}

function updateModelWarn() {
  const warn = $("#modelWarn");
  const engine = fiEngine.value;
  let text = "";
/* PERSONAL_ONLY_BEGIN */
  if (engine === "neural" && modelInstalled.framegen === false) text = "Framegen weights are not installed. Open Personal model setup, or choose the built-in IFRNet-S engine. Framegen weights are for personal, noncommercial use.";
/* PERSONAL_ONLY_END */
  if (engine === "ifrnet" && modelInstalled.ifrnet === false) text = "Bundled IFRNet-S weights are unavailable. The engine may use Analytic Flow; reinstall the extension to restore the model.";
  warn.hidden = !text;
  setText(warn,text);
}
async function refreshModels() {
  try {
    const value = await ext.runtime.sendMessage({type:"ve-model-status"});
    modelInstalled.ifrnet = value?.ok ? !!(value.installed || value.bundled) : null;
  } catch {
    try { const probe = await fetch(ext.runtime.getURL("models/ifrnet.bin"),{method:"HEAD"}); modelInstalled.ifrnet = probe.ok; }
    catch { modelInstalled.ifrnet = null; }
  }
/* PERSONAL_ONLY_BEGIN */
  // "fvNeuralModelV1" mirrors FiNeuralModel.KEY in neural-model.js.
  try {
    const stored = await ext.storage.local.get("fvNeuralModelV1");
    modelInstalled.framegen = !!stored.fvNeuralModelV1;
    if (!modelInstalled.framegen) {
      const probe = await fetch(ext.runtime.getURL("models/rt_v7s.json"),{method:"HEAD"});
      modelInstalled.framegen = probe.ok;
    }
  } catch { modelInstalled.framegen = null; }
/* PERSONAL_ONLY_END */
  updateModelWarn();
}
saveDiagnostics.addEventListener("click",async () => {
  try {
    const state = await send("fv-status");
    const payload = {version:ext.runtime.getManifest().version,edition:globalThis.VE_BUILD?.flavor,
      savedAt:new Date().toISOString(),status:state.status,pipeline:state.pipeline,
      videoPaused:state.videoPaused,videoEnded:state.videoEnded,canRender:state.canRender,
      settings:state.settings,metrics:state.metrics,fi:state.fi,
      note:"Local diagnostic snapshot. No video pixels. Rendered frame rates are not monitor refresh measurements."};
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload,null,2)],{type:"application/json"}));
    const link = document.createElement("a");
    link.href = url;
    link.download = "video-enhancer-diagnostics.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url),1000);
    showFeedback("Diagnostics saved.");
  } catch { showFeedback("Could not export diagnostics. Reconnect the tab and try again."); }
});

init().catch(unavailable);
setInterval(refreshState,1000);
refreshModels();
setInterval(refreshModels,5000);
