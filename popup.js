"use strict";
const ext = globalThis.browser ?? globalThis.chrome;

function localizeStatic() {
  for (const element of document.querySelectorAll("[data-i18n]")) {
    const value = ext.i18n.getMessage(element.dataset.i18n);
    if (value) element.textContent = value;
  }
  for (const element of document.querySelectorAll("[data-i18n-aria-label]")) {
    const value = ext.i18n.getMessage(element.dataset.i18nAriaLabel);
    if (value) element.setAttribute("aria-label", value);
  }
}

localizeStatic();

const statusChip = document.querySelector("#statusChip");
const label = document.querySelector("#label");
const detail = document.querySelector("#detail");
const strength = document.querySelector("#strength");
const strengthValue = document.querySelector("#strengthValue");
const outline = document.querySelector("#outline");
const compare = document.querySelector("#compare");
const fiInfra = document.querySelector("#fiInfra");
const fiSceneCut = document.querySelector("#fiSceneCut");
const fiHalfLuma = document.querySelector("#fiHalfLuma");
const fiBlockMatch = document.querySelector("#fiBlockMatch");
const fiFallback = document.querySelector("#fiFallback");
const toggle = document.querySelector("#toggle");
const reload = document.querySelector("#reload");
const hint = document.querySelector("#hint");
const versionEl = document.querySelector("#version");
const healthEl = document.querySelector("#health");
const fps = document.querySelector("#fps");
const missed = document.querySelector("#missed");
const videoDropped = document.querySelector("#videoDropped");
const late = document.querySelector("#late");
const cpu = document.querySelector("#cpu");
const gpu = document.querySelector("#gpu");
const decoder = document.querySelector("#decoder");
const renderScale = document.querySelector("#renderScale");
const fiMethodEl = document.querySelector("#fiMethod");
const fiConfidenceEl = document.querySelector("#fiConfidence");
const fiHoldEl = document.querySelector("#fiHold");
const fiSampleEl = document.querySelector("#fiSample");
const fiRatesEl = document.querySelector("#fiRates");
const fiStatus = document.querySelector("#fiStatus");
const fiStatusTitle = document.querySelector("#fiStatusTitle");
const fiStatusDetail = document.querySelector("#fiStatusDetail");
const fiExplain = document.querySelector("#fiExplain");
const modeChips = [...document.querySelectorAll("#modeChips .chip")];
const qualityChips = [...document.querySelectorAll("#qualityChips .chip")];
const interactionChips = [...document.querySelectorAll("#interactionChips .chip")];
const presetChips = [...document.querySelectorAll("#presetChips .chip")];
const fiChecks = [fiInfra, fiSceneCut, fiHalfLuma, fiBlockMatch, fiFallback];

let tabId;
let controlsLocked = false;

const labels = {
  off: "Disabled",
  idle: "Waiting for video",
  ok: "Rendering",
  "no-video": "No video found",
  "no-webgl": "WebGL2 unavailable",
  tainted: "Video blocked by CORS",
  error: "Failed to capture video",
};

const tones = {
  off: "off",
  idle: "idle",
  ok: "ok",
  "no-video": "warn",
  "no-webgl": "error",
  tainted: "error",
  error: "error",
};

const modeNames = {
  off: "Disabled",
  native: "Native",
  rcas: "FSR1",
  ravu: "RAVU-lite",
};

const schedulerNames = {
  "video frame": "video frame",
  "display refresh": "display refresh",
};

function setPressed(chips, attr, value) {
  for (const chip of chips) {
    chip.setAttribute("aria-pressed", String(chip.dataset[attr] === value));
  }
}

function setChipDisabled(chips, disabled) {
  for (const chip of chips) chip.disabled = disabled || controlsLocked;
}

function healthSummary(state) {
  if (state.settings.mode === "off") {
    return { text: "Inactive", tone: "off" };
  }
  if (state.status !== "ok" || !state.hasVideo || !state.visible) {
    return { text: "—", tone: "off" };
  }
  const m = state.metrics;
  const latePct = m.latePct === null ? 0 : m.latePct;
  if (m.missedPct > 8 || latePct > 25 || m.videoDroppedPct > 5) {
    return { text: "Overloaded", tone: "warn" };
  }
  if (m.missedPct > 1 || latePct > 10) {
    return { text: "Attention", tone: "warn" };
  }
  return { text: "OK", tone: "ok" };
}

function formatDetail(state) {
  if (state.lastError) return state.lastError;
  if (!state.hasVideo) {
    return state.settings.mode === "off"
      ? "Choose an effect to enable processing in this tab."
      : "Waiting for a video on this page.";
  }
  const pipeline = state.pipeline || modeNames[state.settings.mode] || "—";
  const size = state.canvasWidth && state.canvasHeight
    ? `${state.canvasWidth}×${state.canvasHeight}`
    : "—";
  const scheduler = schedulerNames[state.scheduler] || state.scheduler || "—";
  return `${pipeline} · ${size} · ${scheduler}`;
}

function nearestPreset(value) {
  const presets = [20, 35, 100];
  let best = null;
  let bestDist = Infinity;
  for (const p of presets) {
    const dist = Math.abs(p - value);
    if (dist < bestDist) {
      best = p;
      bestDist = dist;
    }
  }
  return bestDist === 0 ? best : null;
}

function render(state) {
  controlsLocked = false;
  const tone = tones[state.status] || "warn";
  statusChip.dataset.tone = tone;
  label.textContent = labels[state.status] || state.status;
  detail.textContent = formatDetail(state);
  hint.textContent = state.settings.mode === "off"
    ? "Off completely disables processing and the overlay on this page."
    : state.settings.mode === "native"
      ? "Native keeps the canvas/overlay but applies no spatial filter. Use it for unfiltered FI."
      : state.settings.mode === "ravu"
        ? "RAVU-lite is the quality mode. FSR1 is the lighter option."
        : "FSR1 is the lightweight mode. Use Native to test FI without upscaling.";

  setPressed(modeChips, "mode", state.settings.mode);
  setPressed(qualityChips, "quality", state.settings.quality);
  setPressed(interactionChips, "interaction", state.settings.interaction);
  setChipDisabled(modeChips, false);
  setChipDisabled(qualityChips, false);

  const renderOn = ["native", "rcas", "ravu"].includes(state.settings.mode);
  const spatialOn = ["rcas", "ravu"].includes(state.settings.mode);
  setChipDisabled(interactionChips, !renderOn);
  strength.disabled = !spatialOn;
  strength.value = state.settings.strength;
  strengthValue.textContent = `${state.settings.strength}%`;
  setChipDisabled(presetChips, !spatialOn);
  const preset = nearestPreset(state.settings.strength);
  for (const chip of presetChips) {
    chip.setAttribute(
      "aria-pressed",
      String(spatialOn && Number(chip.dataset.strength) === preset),
    );
  }

  outline.disabled = false;
  compare.disabled = false;
  outline.checked = state.settings.outline;
  compare.checked = state.settings.compare;

  fiInfra.checked = state.settings.fiInfra === true;
  fiSceneCut.checked = state.settings.fiSceneCut !== false;
  fiHalfLuma.checked = state.settings.fiHalfLuma !== false;
  fiBlockMatch.checked = state.settings.fiBlockMatch !== false;
  fiFallback.checked = state.settings.fiFallback !== false;
  for (const el of fiChecks) {
    if (el) el.disabled = false;
  }
  const subDisabled = !fiInfra.checked;
  fiSceneCut.disabled = subDisabled;
  fiHalfLuma.disabled = subDisabled;
  fiBlockMatch.disabled = subDisabled;
  fiFallback.disabled = subDisabled;

  toggle.disabled = state.settings.mode === "off" ||
    !state.hasVideo || state.status !== "ok";
  toggle.textContent = state.visible ? "Hide overlay" : "Show overlay";

  const health = healthSummary(state);
  healthEl.textContent = health.text;
  healthEl.dataset.tone = health.tone;

  const outputFps = state.metrics.fps +
    (state.settings.fiInfra ? (state.metrics.midFps || 0) : 0);
  fps.textContent = `${state.metrics.videoFps.toFixed(1)} / ${outputFps.toFixed(1)} fps`;
  renderScale.textContent = `${Math.round(state.metrics.renderScale * 100)}%`;
  const fi = state.fi || {};
  const methodNames = {
    skip: "no midpoints",
    blend: "blend (weak)",
    block: "motion (more visible)",
    duplicate: "copy (no smoothing)",
    off: "disabled",
  };
  const methodKey = state.settings.fiInfra ? (fi.method || "skip") : "off";
  fiMethodEl.textContent = methodNames[methodKey] || methodKey;
  fiConfidenceEl.textContent = state.settings.fiInfra && fi.confidence != null
    ? `${(fi.confidence * 100).toFixed(0)}%`
    : "—";
  fiHoldEl.textContent = state.settings.fiInfra
    ? `${fi.sceneCutHold || 0} · ${fi.hasPair ? "pair ready" : "no pair yet"}`
    : "—";
  fiSampleEl.textContent = fi.sample || "—";
  fiRatesEl.textContent = state.settings.fiInfra
    ? `${(fi.realPerSec || 0).toFixed(0)} / ${(fi.midPerSec || 0).toFixed(0)} per s`
    : "—";

  // Human status card
  const explain = fi.explain ||
    (state.settings.fiInfra
      ? "Smoothing enabled — see details below."
      : "Smoothing disabled.");
  if (fiExplain) {
    fiExplain.textContent =
      "Experimental: generates one midpoint per pair (up to 2×); RAVU can be expensive.";
  }
  if (fiStatus && fiStatusTitle && fiStatusDetail) {
    let tone = "off";
    let title = "Disabled";
    if (!state.settings.fiInfra) {
      title = "Disabled";
      tone = "off";
    } else if ((fi.midPerSec || 0) >= (fi.realPerSec || 0) * 0.5 && (fi.realPerSec || 0) > 5) {
      title = methodKey === "block" ? "Generating midpoints (motion)" :
        methodKey === "blend" ? "Generating midpoints (weak blend)" :
          "Generating midpoints";
      tone = methodKey === "blend" || methodKey === "duplicate" ? "warn" : "ok";
    } else if (state.settings.fiInfra) {
      title = "Enabled, limited visible effect";
      tone = "warn";
    }
    fiStatus.dataset.tone = tone;
    fiStatusTitle.textContent = title;
    fiStatusDetail.textContent = explain;
  }

  missed.textContent = `${state.metrics.missed} (${state.metrics.missedPct.toFixed(1)}%)`;
  videoDropped.textContent =
    `${state.metrics.videoDropped} (${state.metrics.videoDroppedPct.toFixed(1)}%)`;
  late.textContent = state.metrics.latePct === null ? "n/a" : `${state.metrics.latePct.toFixed(1)}%`;
  cpu.textContent = `${state.metrics.cpuMs.toFixed(2)} ms (max ${state.metrics.cpuMaxMs.toFixed(1)})`;
  gpu.textContent = state.metrics.gpuMs === null
    ? (state.metrics.gpuSupported ? "measuring…" : "n/a")
    : `${state.metrics.gpuMs.toFixed(2)} ms`;
  decoder.textContent = state.metrics.decoderMs === null
    ? "n/a"
    : `${state.metrics.decoderMs.toFixed(2)} ms`;
}

async function send(type, settings) {
  return ext.tabs.sendMessage(tabId, { type, settings }, { frameId: 0 });
}

async function init() {
  try {
    const manifest = ext.runtime.getManifest();
    versionEl.textContent = `v${manifest.version}`;
  } catch {
    versionEl.textContent = "v—";
  }
  const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
  tabId = tab && tab.id;
  if (tabId === undefined) throw new Error("Active tab not found");
  reload.disabled = false;
  render(await send("fv-status"));
}

function unavailable() {
  controlsLocked = true;
  statusChip.dataset.tone = "error";
  label.textContent = "Reload this page";
  detail.textContent = "The extension has not been injected into this tab yet.";
  hint.textContent = "Reload the page to load the content script.";
  strength.disabled = true;
  outline.disabled = true;
  compare.disabled = true;
  for (const el of fiChecks) {
    if (el) el.disabled = true;
  }
  toggle.disabled = true;
  setChipDisabled(modeChips, true);
  setChipDisabled(qualityChips, true);
  setChipDisabled(interactionChips, true);
  setChipDisabled(presetChips, true);
  healthEl.textContent = "—";
  healthEl.dataset.tone = "off";
}

async function updateSettings(patch, persist = true) {
  if (persist) await ext.storage.local.set(patch);
  render(await send("fv-settings", patch));
}

for (const chip of modeChips) {
  chip.addEventListener("click", () => {
    updateSettings({ mode: chip.dataset.mode }).catch(unavailable);
  });
}
for (const chip of qualityChips) {
  chip.addEventListener("click", () => {
    updateSettings({ quality: chip.dataset.quality }).catch(unavailable);
  });
}
for (const chip of interactionChips) {
  chip.addEventListener("click", () => {
    updateSettings({ interaction: chip.dataset.interaction }).catch(unavailable);
  });
}
for (const chip of presetChips) {
  chip.addEventListener("click", () => {
    const value = Number(chip.dataset.strength);
    strength.value = value;
    strengthValue.textContent = `${value}%`;
    updateSettings({ strength: value }).catch(unavailable);
  });
}

strength.addEventListener("input", () => {
  strengthValue.textContent = `${strength.value}%`;
  send("fv-settings", { strength: Number(strength.value) }).catch(unavailable);
  const preset = nearestPreset(Number(strength.value));
  for (const chip of presetChips) {
    chip.setAttribute(
      "aria-pressed",
      String(Number(chip.dataset.strength) === preset),
    );
  }
});
strength.addEventListener("change", () => {
  ext.storage.local.set({ strength: Number(strength.value) });
});
outline.addEventListener("change", () => {
  updateSettings({ outline: outline.checked }).catch(unavailable);
});
compare.addEventListener("change", () => {
  updateSettings({ compare: compare.checked }).catch(unavailable);
});

function fiPatchFromUi() {
  return {
    fiInfra: fiInfra.checked,
    fiSceneCut: fiSceneCut.checked,
    fiHalfLuma: fiHalfLuma.checked,
    fiBlockMatch: fiBlockMatch.checked,
    fiFallback: fiFallback.checked,
  };
}
for (const el of fiChecks) {
  el.addEventListener("change", () => {
    updateSettings(fiPatchFromUi()).catch(unavailable);
  });
}

toggle.addEventListener("click", async () => {
  try {
    render(await send("fv-toggle"));
  } catch {
    unavailable();
  }
});
reload.addEventListener("click", async () => {
  await ext.tabs.reload(tabId);
  window.close();
});

init().catch(unavailable);
setInterval(() => {
  if (tabId !== undefined && !controlsLocked) {
    send("fv-status").then(render).catch(unavailable);
  }
}, 1000);
