# Continuation notice: 0.0.62 experimental

Read `LEIA_PRIMEIRO-0.0.62.md`, `docs/NEURAL-INTEGRATION.md` and `release-evidence/validation-status.json` first. The previous 0.0.61 handoff is preserved below for provenance. The user explicitly requested implementing the neural path during this task; it is opt-in and remains unvalidated on actual GPU playback.

---

# HANDOFF — Video Enhancer (v0.0.61)

> Documento de continuidade para outro agente/LLM assumir o trabalho.
> Ler este arquivo inteiro antes de qualquer modificação. Não editar o
> interpolador sem antes internalizar `docs/INTERPOLATION-QUALITY-PLAN.md`.

## 1. O que é este projeto

Extensão de navegador (Firefox + Chromium/Edge) que melhora o vídeo principal
da página localmente, sem telemetria, permissão única `storage`:

- **FSR1** (EASU + RCAS) para upscale/sharpen (WebGL2).
- **RAVU-lite + RCAS** como segunda engine (arquivos em `third_party/`).
- **Frame interpolation 2×** por fluxo óptico Lucas-Kanade piramidal denso
  bidirecional em **WebGPU compute** (`fi-webgpu.js`), warp final em WebGL2.

Produto público: https://github.com/treeks12/video-enhancer ·
website GitHub Pages (docs/index.html). Manifestos Firefox e Chromium
**devem ter a mesma versão** (build.ps1 valida e rejeita divergência).

## 2. Estado atual (set/2026, v0.0.61)

Última mudança (feita por agente ZCode em 18-19/set):
1. `FI_WARP_FRAG` (content.js): média dos endpoints substituída por
   **seleção de endpoint consciente de oclusão** — consistência
   forward-backward (`length(forwardMv + backwardMv)`) + acordo fotométrico
   (`length(a-b)`); falha em qualquer teste mostra o endpoint mais confiável
   (`vec3 near = wa >= wb ? a : b`) em vez de média fantasma.
2. `fiUploadMvTexture`: texturas de MV migradas de 8-bit `(px*4+128)/255`
   para **RGBA16F half-float** (`fiFloatToHalf`), matando quantização de
   0.25 px que fazia pans lentos engasgarem.
3. Self-checks novos + conversor float→half validado por round-trip.

**Problema em aberto (o motivo deste handoff)**: o usuário reporta que
0.0.61 ficou simultaneamente melhor E pior — frames melhores, mas
**artefatos em lugares aleatórios da imagem** (em frames gerados). Hipóteses
diagnosticadas e plano de ação: `docs/INTERPOLATION-QUALITY-PLAN.md`
(Track A: overlay de debug → mediana 3×3 no fluxo → máscara coerente →
gating AFMF; Track B neural, gated). **NÃO patchear o interpolador sem
seguir o plano. O primeiro passo é o overlay de debug (A1).**

## 3. Linhagem (para não redescobrir história)

1. Spike de 2 arquivos criado em sessão ZCode (jul/2026): passthrough WebGL2
   sobre `<video>`, prova de viabilidade CORS (YouTube passa: MSE `blob:`
   é same-origin).
2. Evolução a produto (0.0.5 → 0.0.47) em outro workspace.
3. Sessões Codex 5-6/set/2026 (threads `01a0741b-1047-7eb1-b96a-ba071bb6c5cb`,
   logs em `~/.codex/sessions/2026/09/05/`): estabilidade 0.0.57 + protótipo
   WebGPU optical flow 0.0.59-0.0.60.
4. 0.0.61 (acima) por ZCode.

Cópias do projeto em disco:
- `C:\Users\Filipe\Desktop\projetos\video-enhancer-main` — **source of truth** (SEM git!).
- `C:\Users\Filipe\ZCodeProject\firefox-video-enhancer` — cópia com git, porém
  **defasada** (árvore 0.0.56, histórico até prep-0.0.53) e com 43 zips de
  build soltos. NÃO trabalhar nela.
- Recomendação pendente: `git init` na pasta Desktop e `.gitignore` já existe.

## 4. Mapa do código

| Arquivo | Papel |
|---|---|
| `content.js` (~3100 linhas) | Content script: overlay/canvas, WebGL2 (EASU/RCAS/RAVU, shaders FI `FI_BLEND_FRAG`/`FI_WARP_FRAG`), relógio de apresentação FI, seleção de vídeo, `selfCheck()` |
| `fi-core.js` | Decisões puras FI sem DOM (block matcher CPU legado, `fiBidirectionalConsistency`, fase/relógio, `fiPickMethod`); `node fi-core.js` roda `fiSelfCheck` |
| `fi-webgpu.js` | Estimador WebGPU: pirâmide LK denso (BLOCK=2, 4 níveis, seed global ±4px na escala grossa, busca local limitada), forward+backward em um submit, readback compacto vec4/célula; single-flight (`_busy`), device-loss → fallback frames originais |
| `popup.html/js` | UI: modos de imagem, FI promovido ao painel principal, diagnósticos colapsados, 6 toggles A/B de FI |
| `build.ps1` | Empacota `dist/firefox` + `dist/chromium` + zips; valida versões iguais, entradas do zip, assets RAVU |
| `test/*.cjs` | `cadence.cjs` (puro, node) · `presentation-clock.cjs`, `stability.cjs`, `webgpu-*.cjs` (precisam `playwright`, nem todo ambiente tem) |
| `docs/` | `INTERPOLATION-QUALITY-PLAN.md` (plano de qualidade), landing page do site |

Fluxo FI por frame: luma baixada p/ CPU (320×176 padrão, 480×270 detalhado,
auto-reduz ~0.75× após 3 pares lentos) → `estimate()` WebGPU → consistência
bidirecional CPU → upload texturas MV half-float → warp WebGL2 na fase do
relógio. Delay de 1 frame (~33 ms @30fps) é **aceito e intencional**.
Fallbacks: nunca blend simples; frame original quando incerto/late/busy.

## 5. Como construir e testar

```
node content.js                 # selfCheck do content (pure units)
node fi-core.js                 # fiSelfCheck
node test/cadence.cjs           # suite pura de cadência 24/30/60
powershell -File build.ps1      # gera dist/ + zips (exige versões iguais nos manifests)
```

Teste manual: `about:debugging` (Firefox) ou Load unpacked (Edge) apontando
para `dist/firefox` ou `dist/chromium`. Sequência de teste canônica do usuário:
vídeo de corrida + anime + pan lento. **O veredito de qualidade é sempre do
usuário** — agente não tem visão confiável dos artefatos.

## 6. Invariantes críticos (quebrar = rejeitar build)

- `selfCheck()` em **content.js** e `fiSelfCheck()` em **fi-core.js** fazem
  **guards de string sobre o shader** (`FI_WARP_FRAG` deve conter
  `v_uv - forwardMv * t * u_texel`, `packedForward.a`,
  `length(forwardMv + backwardMv)`, `mix(warped, near, pick)`, …).
  **Se editar o shader, atualize os guards correspondentes nos dois arquivos
  e adicione guards novos para lógica nova.** É o mecanismo anti-regressão.
- `fiUploadMvTexture` deve manter `gl.LINEAR`, `gl.RGBA16F`, `gl.HALF_FLOAT`;
  packing 8-bit (`* 4 + 128`) é proibido (guard existe).
- Warp FI em coordenadas da **grade luma** (`1 / fiLumaW`), nunca
  `videoWidth / fiLumaW` (guard existe).
- FBOs: `fiCopyTexture` usa `fiCopyFb`; path mid re-binda `fiOutFb` via
  `fiBindOutTarget` a cada uso (guards existem).
- Single-flight WebGPU; resultados checados contra serial do par; sem
  cooldown temporizado; device loss → frames originais.
- Versões dos manifests iguais; README público em inglês, product-focused.

## 7. Próximo passo (decidido, aprovado pelo usuário como abordagem)

Executar **Track A do plano de qualidade** na ordem: A1 overlay de debug →
A2 mediana 3×3 no campo de fluxo (WGSL) → A3 máscara de decisão espacialmente
coerente → A4 gating conservador estilo AFMF. Track B (neural, estilo
Framegen) só abre se o teto do Track A decepcionar com evidência. Detalhes,
hipóteses, esforços, riscos e fontes: `docs/INTERPOLATION-QUALITY-PLAN.md`.
