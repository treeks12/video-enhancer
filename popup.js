"use strict";
const ext = globalThis.browser ?? globalThis.chrome;

const statusChip = document.querySelector("#statusChip");
const label = document.querySelector("#label");
const detail = document.querySelector("#detail");
const strength = document.querySelector("#strength");
const strengthValue = document.querySelector("#strengthValue");
const outline = document.querySelector("#outline");
const compare = document.querySelector("#compare");
const fiInfra = document.querySelector("#fiInfra");
const fiSceneCut = document.querySelector("#fiSceneCut");
const fiFpsGate = document.querySelector("#fiFpsGate");
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
const fiEligibleEl = document.querySelector("#fiEligible");
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
const fiChecks = [fiInfra, fiSceneCut, fiFpsGate, fiHalfLuma, fiBlockMatch, fiFallback];

let tabId;
let controlsLocked = false;

const labels = {
  off: "Desativado",
  idle: "Aguardando vídeo",
  ok: "Renderizando",
  "no-video": "Nenhum vídeo encontrado",
  "no-webgl": "WebGL2 indisponível",
  tainted: "Vídeo bloqueado por CORS",
  error: "Falha ao capturar o vídeo",
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
  off: "Desativado",
  native: "Nativo",
  rcas: "FSR1",
  ravu: "RAVU-lite",
};

const schedulerNames = {
  "frame do vídeo": "frame do vídeo",
  "refresh da tela": "refresh da tela",
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
    return { text: "Inativo", tone: "off" };
  }
  if (state.status !== "ok" || !state.hasVideo || !state.visible) {
    return { text: "—", tone: "off" };
  }
  const m = state.metrics;
  const latePct = m.latePct === null ? 0 : m.latePct;
  if (m.missedPct > 8 || latePct > 25 || m.videoDroppedPct > 5) {
    return { text: "Sobrecarga", tone: "warn" };
  }
  if (m.missedPct > 1 || latePct > 10) {
    return { text: "Atenção", tone: "warn" };
  }
  return { text: "OK", tone: "ok" };
}

function formatDetail(state) {
  if (state.lastError) return state.lastError;
  if (!state.hasVideo) {
    return state.settings.mode === "off"
      ? "Escolha RAVU para ativar o efeito nesta aba."
      : "Aguardando um vídeo na página.";
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
    ? "Off desliga totalmente o processamento e o overlay nesta página."
    : state.settings.mode === "native"
      ? "Nativo mantém o canvas/overlay, mas não aplica RAVU/FSR/RCAS. Use para FI sem filtro."
      : state.settings.mode === "ravu"
        ? "RAVU-lite é o modo de qualidade. FSR1 fica como opção leve."
        : "FSR1 é o modo leve. Use Nativo para testar FI sem upscale.";

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
  fiFpsGate.checked = state.settings.fiFpsGate !== false;
  fiHalfLuma.checked = state.settings.fiHalfLuma !== false;
  fiBlockMatch.checked = state.settings.fiBlockMatch !== false;
  fiFallback.checked = state.settings.fiFallback !== false;
  for (const el of fiChecks) {
    if (el) el.disabled = false;
  }
  const subDisabled = !fiInfra.checked;
  fiSceneCut.disabled = subDisabled;
  fiFpsGate.disabled = subDisabled;
  fiHalfLuma.disabled = subDisabled;
  fiBlockMatch.disabled = subDisabled;
  fiFallback.disabled = subDisabled;

  toggle.disabled = state.settings.mode === "off" ||
    !state.hasVideo || state.status !== "ok";
  toggle.textContent = state.visible ? "Ocultar overlay" : "Mostrar overlay";

  const health = healthSummary(state);
  healthEl.textContent = health.text;
  healthEl.dataset.tone = health.tone;

  const outputFps = state.metrics.fps +
    (state.settings.fiInfra ? (state.metrics.midFps || 0) : 0);
  fps.textContent = `${state.metrics.videoFps.toFixed(1)} / ${outputFps.toFixed(1)} fps`;
  renderScale.textContent = `${Math.round(state.metrics.renderScale * 100)}%`;
  const fi = state.fi || {};
  const methodNames = {
    skip: "sem meios",
    blend: "mistura (fraco)",
    block: "movimento (mais visível)",
    duplicate: "cópia (não suaviza)",
    off: "desligado",
  };
  const methodKey = state.settings.fiInfra ? (fi.method || "skip") : "off";
  fiMethodEl.textContent = methodNames[methodKey] || methodKey;
  fiEligibleEl.textContent = state.settings.fiInfra
    ? `${fi.fpsEligible ? "sim" : "não"} · fonte ${(fi.videoFps || 0).toFixed(1)} fps`
    : "—";
  fiConfidenceEl.textContent = state.settings.fiInfra && fi.confidence != null
    ? `${(fi.confidence * 100).toFixed(0)}%`
    : "—";
  fiHoldEl.textContent = state.settings.fiInfra
    ? `${fi.sceneCutHold || 0} · ${fi.hasPair ? "par ok" : "sem par ainda"}`
    : "—";
  fiSampleEl.textContent = fi.sample || "—";
  fiRatesEl.textContent = state.settings.fiInfra
    ? `${(fi.realPerSec || 0).toFixed(0)} / ${(fi.midPerSec || 0).toFixed(0)} por s`
    : "—";

  // Human status card
  const explain = fi.explain ||
    (state.settings.fiInfra
      ? "Suavização ligada — veja o detalhe abaixo."
      : "Suavização desligada.");
  if (fiExplain) {
    fiExplain.textContent =
      "Experimental: gera um meio por par (até 2×) em vídeos ~24/30 fps; em RAVU pode pesar.";
  }
  if (fiStatus && fiStatusTitle && fiStatusDetail) {
    let tone = "off";
    let title = "Desligado";
    if (!state.settings.fiInfra) {
      title = "Desligado";
      tone = "off";
    } else if (!fi.fpsEligible && state.settings.fiFpsGate) {
      title = "Ligado, mas fonte não é 24/30";
      tone = "warn";
    } else if ((fi.midPerSec || 0) >= (fi.realPerSec || 0) * 0.5 && (fi.realPerSec || 0) > 5) {
      title = methodKey === "block" ? "Gerando meios (movimento)" :
        methodKey === "blend" ? "Gerando meios (mistura fraca)" :
          "Gerando meios";
      tone = methodKey === "blend" || methodKey === "duplicate" ? "warn" : "ok";
    } else if (state.settings.fiInfra) {
      title = "Ligado, efeito pouco visível";
      tone = "warn";
    }
    fiStatus.dataset.tone = tone;
    fiStatusTitle.textContent = title;
    fiStatusDetail.textContent = explain;
  }

  missed.textContent = `${state.metrics.missed} (${state.metrics.missedPct.toFixed(1)}%)`;
  videoDropped.textContent =
    `${state.metrics.videoDropped} (${state.metrics.videoDroppedPct.toFixed(1)}%)`;
  late.textContent = state.metrics.latePct === null ? "n/d" : `${state.metrics.latePct.toFixed(1)}%`;
  cpu.textContent = `${state.metrics.cpuMs.toFixed(2)} ms (máx ${state.metrics.cpuMaxMs.toFixed(1)})`;
  gpu.textContent = state.metrics.gpuMs === null
    ? (state.metrics.gpuSupported ? "medindo…" : "n/d")
    : `${state.metrics.gpuMs.toFixed(2)} ms`;
  decoder.textContent = state.metrics.decoderMs === null
    ? "n/d"
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
  if (tabId === undefined) throw new Error("Aba ativa não encontrada");
  reload.disabled = false;
  render(await send("fv-status"));
}

function unavailable() {
  controlsLocked = true;
  statusChip.dataset.tone = "error";
  label.textContent = "Recarregue esta página";
  detail.textContent = "A extensão ainda não foi injetada nesta aba.";
  hint.textContent = "Recarregue a página para carregar o content script.";
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
    fiFpsGate: fiFpsGate.checked,
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
