"use strict";

const statusChip = document.querySelector("#statusChip");
const label = document.querySelector("#label");
const detail = document.querySelector("#detail");
const strength = document.querySelector("#strength");
const strengthValue = document.querySelector("#strengthValue");
const outline = document.querySelector("#outline");
const compare = document.querySelector("#compare");
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
const modeChips = [...document.querySelectorAll("#modeChips .chip")];
const qualityChips = [...document.querySelectorAll("#qualityChips .chip")];
const interactionChips = [...document.querySelectorAll("#interactionChips .chip")];
const presetChips = [...document.querySelectorAll("#presetChips .chip")];

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
    ? "Desativado: nenhum processamento na página. Ative RAVU quando quiser."
    : state.settings.mode === "ravu"
      ? "RAVU-lite é o modo de qualidade. FSR1 fica como opção leve."
      : "FSR1 é o modo leve. Use RAVU para máxima qualidade.";

  setPressed(modeChips, "mode", state.settings.mode);
  setPressed(qualityChips, "quality", state.settings.quality);
  setPressed(interactionChips, "interaction", state.settings.interaction);
  setChipDisabled(modeChips, false);
  setChipDisabled(qualityChips, false);

  const effectOn = ["rcas", "ravu"].includes(state.settings.mode);
  setChipDisabled(interactionChips, !effectOn);
  strength.disabled = !effectOn;
  strength.value = state.settings.strength;
  strengthValue.textContent = `${state.settings.strength}%`;
  setChipDisabled(presetChips, !effectOn);
  const preset = nearestPreset(state.settings.strength);
  for (const chip of presetChips) {
    chip.setAttribute(
      "aria-pressed",
      String(effectOn && Number(chip.dataset.strength) === preset),
    );
  }

  outline.disabled = false;
  compare.disabled = false;
  outline.checked = state.settings.outline;
  compare.checked = state.settings.compare;

  toggle.disabled = state.settings.mode === "off" ||
    !state.hasVideo || state.status !== "ok";
  toggle.textContent = state.visible ? "Ocultar overlay" : "Mostrar overlay";

  const health = healthSummary(state);
  healthEl.textContent = health.text;
  healthEl.dataset.tone = health.tone;

  fps.textContent = `${state.metrics.videoFps.toFixed(1)} / ${state.metrics.fps.toFixed(1)} fps`;
  renderScale.textContent = `${Math.round(state.metrics.renderScale * 100)}%`;
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
  return browser.tabs.sendMessage(tabId, { type, settings }, { frameId: 0 });
}

async function init() {
  try {
    const manifest = browser.runtime.getManifest();
    versionEl.textContent = `v${manifest.version}`;
  } catch {
    versionEl.textContent = "v—";
  }
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
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
  toggle.disabled = true;
  setChipDisabled(modeChips, true);
  setChipDisabled(qualityChips, true);
  setChipDisabled(interactionChips, true);
  setChipDisabled(presetChips, true);
  healthEl.textContent = "—";
  healthEl.dataset.tone = "off";
}

async function updateSettings(patch, persist = true) {
  render(await send("fv-settings", patch));
  if (persist) await browser.storage.local.set(patch);
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
  browser.storage.local.set({ strength: Number(strength.value) });
});
outline.addEventListener("change", () => {
  updateSettings({ outline: outline.checked }).catch(unavailable);
});
compare.addEventListener("change", () => {
  updateSettings({ compare: compare.checked }).catch(unavailable);
});

toggle.addEventListener("click", async () => {
  try {
    render(await send("fv-toggle"));
  } catch {
    unavailable();
  }
});
reload.addEventListener("click", async () => {
  await browser.tabs.reload(tabId);
  window.close();
});

init().catch(unavailable);
setInterval(() => {
  if (tabId !== undefined && !controlsLocked) {
    send("fv-status").then(render).catch(unavailable);
  }
}, 1000);
