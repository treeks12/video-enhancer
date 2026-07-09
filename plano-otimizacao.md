# Plano: deixar o Firefox Video Enhancer "invisível" em custo

## Context

Objetivo do projeto: a extensão ser tão leve que **usar ou não usar** quase não mude FPS, latência, scroll e bateria.

Hoje (0.0.28) o idle path já melhorou bastante (top-frame only, RAVU lazy, listeners sob demanda). O gargalo real, porém, está no **path ativo**: cada frame de vídeo paga custo extra obrigatório que o browser sozinho não paga.

### Realidade física (importante)

Com o efeito **ligado**, zero-diff absoluto é impossível: sempre há upload do frame + pelo menos um pass de shader. O alvo realista é:

| Situação | Alvo |
|----------|------|
| Modo `off` / sem vídeo | ≈ custo zero (só parse mínimo) |
| Efeito ligado, 1080p60 | overhead pequeno o bastante para não perder frames vs baseline |
| Efeito ligado, 4K | degradar qualidade (escala) antes de perder FPS |

A maior fatia do custo **não** é o RCAS em si — é o pipeline:

```text
decode (browser)
  → paint do <video>          ← ainda acontece (double paint)
  → texSubImage2D (cópia)     ← costuma ser o #1
  → EASU (muitos taps + FBO)  ← costuma ser o #2
  → RCAS
  → paint do <canvas>
```

---

## Diagnóstico do código atual

Arquivo crítico: `content.js`

| Já bom | Ainda caro / desnecessário |
|--------|----------------------------|
| Só top frame (`window.top`) | Default `mode: "rcas"` → ativa sozinho em qualquer página com vídeo |
| RAVU/LUT lazy | `content.js` inteiro (~57 KB) injeta em **todo** http/https |
| Listeners detach quando off | `<video>` original **continua sendo pintado** sob o canvas |
| Auto scale + cap megapixels | EASU e RCAS em **2 passes** (FBO intermediário = bandwidth extra) |
| Uniform cache, CPU sample 1/15 | Métricas + `dataset` + `getVideoPlaybackQuality` no hot path |
| Pause no scroll/hidden | Strength 0 ainda pode rodar EASU se houver upscale |

---

## Abordagem recomendada (por impacto)

Priorizar na ordem abaixo. Não implementar tudo de uma vez — medir entre ondas.

### Onda 1 — idle e "não estou usando" (rápido, alto ROI)

**1. Default `mode: "off"`**
- Em `DEFAULT_SETTINGS` em `content.js`.
- Instalada = inerte até o usuário escolher FSR1/RAVU.
- Alinha com “não faz diferença usar ou não” no dia a dia de navegação.

**2. Bootstrap mínimo (split do content script)**
- Hoje o manifest injeta o monólito inteiro em toda página.
- Padrão: `content-lite.js` (~2–5 KB) que só:
  - lê storage;
  - se `mode === "off"`, só escuta `storage.onChanged` e mensagens do popup;
  - se `mode !== "off"`, `import()` / inject dinâmico do `content-full.js` (shaders + GL).
- Manifest: `content-lite` + `web_accessible_resources` / `scripting` conforme o modelo Firefox MV3 escolhido.
- Ganho: parse/compile de shaders FSR **zero** em 99% das abas.

**3. Discovery ainda mais preguiçosa**
- Com mode on: não anexar `play`/`loadedmetadata` em capture até o primeiro `querySelector("video")` falhar; ou MutationObserver com debounce em vez de 5 listeners capture permanentes.
- Já existe `attachDiscoveryListeners` / `detachDiscoveryListeners` — reutilizar.

### Onda 2 — compositor e work quando o efeito está ON (maior ganho de FPS)

**4. Esconder o `<video>` enquanto o overlay está desenhando**
- Hoje o canvas cobre o vídeo, mas o browser **ainda pinta** o vídeo por baixo.
- Ao `status === "ok"` e `canRender()`: aplicar no vídeo algo como `opacity: 0` (ou `visibility: hidden` se não quebrar hit-testing dos controles — preferir opacity e manter o vídeo no layout).
- Restaurar em deactivate / hide overlay / scroll pause / tainted.
- **Não** remove decode (ainda precisamos do frame para textura); remove paint duplicado no compositor — em muitos players isso é grande.

**5. Fundir EASU + RCAS num único pass (FSR1)**
- Hoje em `draw()` (path `useEasu`): FBO write full-res + segundo pass RCAS.
- Novo shader: EASU calcula cor → RCAS no mesmo fragment (ou RCAS em vizinhança amostrada do resultado EASU *sem* FBO, se a matemática permitir no mesmo kernel; se não, ainda vale **um** pass de upsample+sharpen se RCAS operar no domínio upscaled com taps no source).
- Meta: eliminar `ensureIntermediate` + bind FBO no path recomendado.
- Reusar `adjustedRcasStrength`, `VERT`, lógica de `EASU_FRAG` / `FRAG`.
- RAVU continua multi-pass (experimental; não otimizar primeiro).

**6. Short-circuit strength 0**
- Se `strength === 0` e `!compare`: não rodar EASU/RCAS; ou desativar overlay e deixar o vídeo nativo (melhor de todos).
- Se strength 0 com compare: blit simples.

### Onda 3 — hot path fino (ganhos menores, mas cumulativos)

**7. Telemetria só com popup aberto**
- `snapshot()` já liga GPU timing por 1.2s; bom.
- Ir além: flag `metricsEnabled` setada só quando o popup manda `fv-status` / `fv-metrics-on`; com popup fechado, pular:
  - `recordVideoFrame` pesado (`getVideoPlaybackQuality`);
  - `publishMetrics` / `adaptRenderScale` em janelas longas (manter auto-scale mais rarefeito, ex. a cada 2–3s);
  - `updateCanvasDataset` (debug).
- Auto-scale sem telemetria fina: usar só `missed` de rVFC `presentedFrames`.

**8. Não chamar `syncLayout` todo frame**
- Só quando `layoutDirty` (já early-return se limpo, mas ainda invoca a função). Inline guard no `draw`.

**9. Evitar alocações / string no hot path**
- `activePipeline = \`EASU → RCAS\`` e template em todo frame: setar só quando o pipeline muda (padrão já usado em `updateCanvasDataset`).

**10. Cap de canvas mais agressivo no default auto**
- `autoScaleCap` / degraus em `selectAutoScale`: preferir 0.85 ou 0.7 mais cedo em 1080p60+.
- Troca: levemente mais soft visual, bem menos fill-rate.
- Calibrar com telemetria na RX 7900 XTX *e* em GPU integrada se possível.

**11. Scroll: não `draw()` imediato no resume se o próximo rVFC vem em <16ms**
- Hoje resume faz `schedule()` + `draw()` — um frame extra. Só `schedule()`.

### Onda 4 — estrutural / futuro (só se Onda 2 não bastar)

**12. Host permissions opcionais / activate on click**
- Extensão sem content script global; `activeTab` + inject ao clicar no ícone.
- Máximo idle; pior UX (“preciso clicar em cada site”).

**13. WebGPU + `importExternalTexture` / VideoFrame**
- Potencial upload mais barato que `texSubImage2D` do WebGL2.
- Muito mais código e superfície de bug; só depois de esgotar Onda 1–2.

**14. RAVU**
- Manter experimental e fora do path “leve”. Não investir em fundir RAVU agora.

---

## O que **não** recomendo agora

- Reescrever em TypeScript/bundler só por performance (zero ganho de runtime).
- Rede neural no browser (contradiz o objetivo de leveza).
- Otimizar micro-uniforms já cacheados (ganho residual).
- Remover FSR1 em favor de CSS `filter: contrast()` (leve mas visualmente outro produto).

---

## Arquivos a tocar (implementação)

| Arquivo | Mudanças |
|---------|----------|
| `manifest.json` | content-lite, WAR se split, version bump |
| `content.js` (ou split lite/full) | default off, hide video, fused shader, métricas gate, short-circuits |
| `popup.html` / `popup.js` | se default off, copy “ative o efeito”; opcional `fv-metrics-on` |
| Self-check no final de `content.js` | testes de normalize + extractRavu (já existe) + novos guards se pure functions |

Reutilizar: `canRender`, `activateRenderer` / `deactivateRenderer`, `selectAutoScale`, `autoScaleCap`, `adjustedRcasStrength`, `loadRavuAssets`, attach/detach listeners.

---

## Ordem de execução sugerida

1. **Default off** + hide video no overlay OK (1–2h, medível no compositor).
2. **Fused EASU+RCAS** (meio dia, maior ganho GPU no path recomendado).
3. **Métricas só com popup** + short-circuit strength 0.
4. **Split content-lite** se ainda quiser idle zero em sites sem efeito.
5. Só então calibrar `autoScaleCap` com telemetria real.

---

## Verification

**Idle (sem efeito):**
- Abrir 10 abas aleatórias com mode off → Firefox Performance / about:processes: sem canvas, sem WebGL context, sem rVFC.
- `node content.js` self-check passa.

**Ativo (YouTube 1080p60 e 1440p/4K se possível):**
- Popup: `Vídeo/overlay` FPS próximos; `missed` ~0; `CPU/GPU` por frame antes vs depois de cada onda.
- Comparar A/B: extensão off vs on com overlay hide-video + fused shader.
- Scroll / theater / fullscreen: vídeo reaparece corretamente ao desligar; controles clicáveis.
- CORS tainted: para e restaura opacidade do vídeo.
- Mode RAVU: ainda funciona (path separado).
- Compare 50/50 e outline: ok.

**Critério de sucesso:**
- Mode off: indistinguível de extensão desinstalada.
- Mode FSR1, 1080p60 em GPU dedicada: `missedPct < 1` e FPS overlay ≈ video FPS; sem stutter de scroll pior que baseline.

---

## Resposta direta

Sim — ainda há otimizações claras. As que mais aproximam do ideal “não faz diferença”:

1. **Não fazer nada até o usuário pedir** (default off + bootstrap leve).
2. **Não pintar o vídeo duas vezes** (esconder o `<video>` sob o canvas).
3. **Não pagar FBO extra** (EASU+RCAS fused).
4. **Não medir o que ninguém está olhando** (métricas só com popup).

O resto (uniforms, scroll 300ms, RAVU lazy) já está no caminho certo; o salto grande é compositor + passes GPU + idle injection.

---

# Plano B: interface e features cosméticas (custo ≈ zero)

Tudo abaixo roda **só no popup** (quando o usuário abre) ou é **CSS/state estático** no canvas. Nada disso entra no hot path por frame se feito direito.

## Estado atual da UI

`popup.html` / `popup.js` — painel 280px, dark, funcional mas “debug-first”:

- Título + bolinha + labels técnicos
- Controles no mesmo bloco: modo, intensidade, outline, compare, qualidade
- 8 linhas de métricas sempre visíveis (assustam usuário comum)
- Botões “Ocultar overlay” / “Recarregar”
- Sem ícone da extensão, sem hierarquia clara, sem presets

Features cosméticas já existentes (baratas):

| Feature | Custo |
|---------|--------|
| Contorno verde no canvas (`outline`) | zero no GPU (só CSS do canvas) |
| Comparação 50/50 + linha divisória no shader | **não** é de graça — branch no fragment todo frame (aceitável só como debug) |
| `dataset.fvPipeline` no canvas | DOM write por mudança de pipeline |

## Princípios

1. **Popup pode ser bonito** — não afeta FPS de vídeo.
2. **Debug some atrás de “Avançado”** — métricas, outline, compare.
3. **Controles do dia a dia em 3 segundos**: ligar, modo, intensidade, qualidade.
4. **Cosmético no vídeo** = CSS ou 1 write quando setting muda, nunca trabalho por frame extra.

---

## UI do popup (redesign)

### Layout proposto (~300px)

```text
┌─────────────────────────────┐
│  ◆ FV Enhancer    v0.0.28   │  header + versão
│  ● Renderizando             │  status chip (cor por estado)
│  FSR1 · 1920×1080 · rVFC    │  detail em 1 linha
├─────────────────────────────┤
│  Efeito                     │
│  [ Off | FSR1 | RAVU ]      │  segmented control (não select longo)
│                             │
│  Intensidade        35%     │
│  ════●════════              │
│  Suave  Médio  Forte        │  presets = só setam o slider
│                             │
│  Qualidade                  │
│  [ Auto | 100% | 75% | 50% ]│
├─────────────────────────────┤
│  [ Ocultar overlay ]        │  primary
│  [ Recarregar página ]      │  secondary
├─────────────────────────────┤
│  ▸ Avançado / Diagnóstico   │  <details> fechado por padrão
│    ☐ Contorno de teste      │
│    ☐ Comparação 50/50       │
│    Saúde: OK                │  resumo 1 palavra
│    Vídeo/overlay  60/60     │  métricas como agora
│    …                        │
└─────────────────────────────┘
```

### Detalhes de polish

| Item | Como |
|------|------|
| Cores de status | `ok` verde, `off` cinza, `idle` azul, erro/CORS vermelho, warning âmbar |
| Chip de status | bolinha + texto + fundo suave (não só bolinha crua) |
| Segmented mode | botões; RAVU com badge “exp.” |
| Presets de intensidade | 20 / 35 / 55 (ou Suave/Médio/Forte) — só `storage` + mensagem |
| Qualidade | chips em vez de `<select>` |
| Métricas | dentro de `<details open>` só se quiser debug; default fechado |
| Saúde | `OK` se missedPct&lt;1 e late&lt;10; `Sobrecarga` senão — esconde números do usuário casual |
| Copy | menos jargão: “Frame do vídeo” em vez de “rVFC”; “FSR1 (recomendado)” |
| Tip tip | se default mode off: “Escolha FSR1 para ativar nesta aba” |
| Disabled states | controles esmaecidos + motivo no detail |
| A11y | `aria-pressed` nos chips, focus ring, labels associados |
| Ícone | `icons/icon.svg` simples (sinal / upscale) no manifest — zero runtime |

### Arquivos

- Reescrever estilos em `popup.html` (CSS só no popup).
- `popup.js`: render de chips, presets, saúde, status colors; mesma API `fv-status` / `fv-settings`.
- Opcional: `icons/icon-48.png` ou SVG se o Firefox aceitar bem no MV3.

**Não precisa** mudar o pipeline de vídeo para a UI nova.

---

## Features cosméticas no overlay (custo ≈ zero)

Só as que **não** competem com o hot path:

### Vale a pena

1. **Contorno de teste** (já existe) — manter em Avançado; talvez cor/espessura fixa.
2. **Flash de confirmação ao mudar modo** — por ~400ms outline ou label CSS no canvas; um timer, zero por frame depois.
3. **Label de compare** — se compare on, texto CSS absoluto “Original | Enhanced” nas metades (elementos HTML irmãos `pointer-events:none`), em vez de só a linha no shader. Labels = DOM estático; a linha no shader já existe.
4. **Presets nomeados no storage** — `"strengthPreset": "medium"` só para UI; valor numérico continua mandando.
5. **Tema do popup** — dark only ou `color-scheme` auto (system). Cosmético puro.

### Evitar / não chamar de cosmético

| Feature | Por quê não |
|---------|-------------|
| HUD de FPS no canto do vídeo | tentador, mas atualizar texto a cada 1s no page DOM de site estranho; e incentiva métricas sempre on |
| Animação contínua no outline | reflow/paint inútil |
| Blur/glass no canvas | GPU extra |
| Partículas, logo animado | ruído |
| Compare 50/50 como “feature principal” | tem custo de branch no shader; ok como debug |

### Compare “mais bonito” sem custo extra de GPU

- Manter a linha divisória atual no shader (já paga o compare).
- Acrescentar **só quando compare=true**: dois `span` fixos no contêiner do player (`Original` / `FSR1`), posicionados left/right, `pointer-events:none`, removidos ao desligar.  
- Setup/teardown em `applySettings`, não em `draw()`.

---

## Ordem sugerida (UI)

1. **Redesign do popup** (chips, seções, Avançado fechado, status colors, copy).  
2. **Presets de intensidade** + saúde resumida.  
3. **Ícone da extensão**.  
4. **Labels do compare 50/50** (DOM estático).  
5. Flash ao mudar modo (opcional).

Isso pode ir **em paralelo** às ondas de performance: UI não depende de fused shader nem de hide-video.

---

## Verification (UI)

- Abrir popup em: off / aguardando vídeo / renderizando / CORS / página sem inject.
- Alternar modo, preset, qualidade; recarregar aba e ver persistência.
- Expandir Avançado: métricas batem com o comportamento atual.
- Compare: labels aparecem/somem; controles do player ainda clicáveis.
- Popup em 100% e 125% zoom do SO: layout não quebra (~300px).
- Sem regressão: `node content.js` self-check; hot path sem novos `querySelector` por frame.

---

## Resumo

| Frente | Objetivo |
|--------|----------|
| Performance | idle zero + path ativo barato (plano A) |
| UI | controle em 3s; debug escondido; parece produto, não spike |
| Cosmético | CSS/DOM em mudança de setting; nunca por frame |

UI e cosmético são o caminho mais barato para a extensão “parecer pronta” sem tocar no gargalo de GPU.
