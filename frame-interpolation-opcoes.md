# Frame interpolation na extensão — mapa completo (custo × benefício)

Documento de exploração. Não é plano de implementação.

## Contexto

A extensão roda no **Firefox**, sobre `<video>` genérico (YouTube etc.), **sem motion vectors / depth** de engine de jogo. O pipeline atual é **espacial** (FSR1, RAVU-lite) em WebGL2: frame via textura + overlay canvas.

Interpolação temporal é **outro problema**:

- precisa de **pelo menos dois instantes** no tempo;
- precisa de uma forma de **mostrar frames extras** entre os do stream;
- compete com o objetivo de extensão “leve”.

### Latência (regra de ouro)

| Estratégia temporal | Latência | Qualidade típica |
|---------------------|----------|------------------|
| Só passado → “inventar” o futuro | ~0 | Pior (adivinha) |
| Guardar frame *t*, esperar *t+1*, interpolar com atraso de 1 frame | **+1 frame** (~16–33 ms) | Bem melhor |
| Buffer de N frames | +N frames | Melhor ainda, pior para live |

---

## 0. Baseline e não-interpolação

### 0.1 Não fazer nada

- **O quê:** 1 frame desenhado por frame do vídeo.
- **Custo:** zero.
- **Benefício:** zero de fluidez extra.
- **Veredito:** referência.

### 0.2 Frame duplication (30→60 “falso”)

- **O quê:** mostrar cada frame duas vezes no refresh da tela.
- **Custo:** quase zero (só scheduling).
- **Benefício:** mínimo; movimento continua em “degrau”, só preenche vsync.
- **Veredito:** barato, **não** é interpolação; útil só como fallback.

### 0.3 Frame blending (média A+B)

- **O quê:** `(frame_t + frame_{t+1}) / 2` sem flow.
- **Custo:** baixo (1 pass). Latência +1 frame se usar o frame futuro.
- **Benefício:** ghosting forte em movimento; em trechos estáticos ok.
- **Veredito:** demo em uma tarde; qualidade tipo VHS.

### 0.4 Pulldown / 3:2 (cinema 24→display)

- **O quê:** padrões de repetição cadenciados, não movimento real.
- **Custo:** baixo.
- **Benefício:** só se a fonte for 24 fps e o objetivo for cadência de cinema — **não** suavidade tipo soap-opera.
- **Veredito:** nicho; quase irrelevante no YouTube 30/60.

---

## 1. Clássicos de video processing (sem rede neural)

### 1.1 Block matching / full-search ME (estilo MPEG antigo)

- **O quê:** blocos 8×8/16×16, busca de vetor, warping + tratamento simples de oclusão.
- **Custo:** médio–alto em CPU; GPU parallelizável. Engenharia média.
- **Benefício:** ok em pan/movimento rígido; quebra em oclusões, rotação, mãos, texto.
- **Veredito:** viável em 720p; 1080p60 no browser é apertado sem muita otimização.

### 1.2 Hierarchical / pyramidal block matching

- **O quê:** ME em multi-escala (mais robusto e em geral mais rápido).
- **Custo:** médio.
- **Benefício:** melhor que full-search ingênuo. Ainda “TV de 2008”.
- **Veredito:** melhor clássico “à mão” antes de ir para rede neural.

### 1.3 Optical flow denso clássico (Farneback, TV-L1, Horn–Schunck)

- **O quê:** campo denso de movimento → warp bidirecional + blend.
- **Custo:** alto em CPU; ports WASM/OpenCV possíveis; GPU existe mas é trabalhoso.
- **Benefício:** superior a block matching em gradientes suaves; ainda sofre com compressão de streaming e oclusões.
- **Veredito:** bom protótipo científico; duvidoso como produto 1080p60 em extensão.

### 1.4 DIS / flow “clássico moderno” leve

- **O quê:** optical flow rápido (ex.: OpenCV DIS).
- **Custo:** médio (WASM ou compute).
- **Benefício:** melhor trade-off entre os clássicos; ainda longe de RIFE.
- **Veredito:** candidato “sem NN” se quiser zero pesos na extensão.

### 1.5 Phase-based interpolation

- **O quê:** pirâmide complexa / phase shift em vez de flow explícito (linha de papers MIT etc.).
- **Custo:** médio–alto; implementação não trivial; poucas libs prontas para WebGL.
- **Benefício:** bom em movimento pequeno/médio; artefatos diferentes (ringing).
- **Veredito:** exótico-elegante; raro no browser.

### 1.6 Motion-compensated interpolation “broadcast” (MCFI de TVs)

- **O quê:** pipeline de TV: ME + máscaras de oclusão + fallback blend + detecção de film mode.
- **Custo:** **muito alto** de engenharia (é um produto inteiro).
- **Benefício:** se bem feito, sweet spot clássico de qualidade.
- **Veredito:** reinventar chip de TV no Firefox — só se for a *razão de ser* do app.

### 1.7 Adaptive: interpolar só se motion &lt; limiar; senão duplicate

- **O quê:** heurística de energia/diferença entre frames.
- **Custo:** baixo extra.
- **Benefício:** evita lixo em ação rápida; ganho só em pans lentos / falas.
- **Veredito:** bom *wrapper* em cima de qualquer método.

---

## 2. Neurais de frame interpolation

### 2.1 RIFE (e variantes real-time)

- **O quê:** rede leve de FI, amplamente usada em players / AI video.
- **Custo:** pesos + ONNX/TF.js/WebGPU; 720p–1080p depende da GPU; engenharia alta. Latência +1 frame típica.
- **Benefício:** melhor custo/qualidade “consumer” atual.
- **Veredito:** **primeiro candidato sério** se for NN no cliente.

### 2.2 IFRNet / EMA-VFI / AMT / VFIformer (família moderna)

- **O quê:** evoluções na linha do RIFE (qualidade ou eficiência).
- **Custo:** similar ou pior que RIFE; menos ports web maduros.
- **Benefício:** incremental sobre RIFE.
- **Veredito:** só se um modelo for claramente mais barato em WebGPU.

### 2.3 FILM (Google)

- **O quê:** qualidade alta, multi-scale.
- **Custo:** pesado para real-time browser em 1080p.
- **Benefício:** visual top em muitos casos.
- **Veredito:** offline/editor; fraco como extensão live.

### 2.4 DAIN / depth-aware interpolation

- **O quê:** estimativa de profundidade + flow.
- **Custo:** duas redes (depth + FI) → pesadíssimo.
- **Benefício:** oclusões melhores em cenas certas.
- **Veredito:** exótico e caro demais para extensão.

### 2.5 SoftSplat / softmax splatting

- **O quê:** warping diferenciável de alta qualidade.
- **Custo:** alto; implementação cuidadosa.
- **Benefício:** excelentes oclusões em paper; runtime pesado.
- **Veredito:** pesquisa, não MVP.

### 2.6 SepConv / kernel prediction

- **O quê:** prediz kernels locais de convolução em vez de flow.
- **Custo:** médio–alto.
- **Benefício:** bom histórico; superado por RIFE-like em real-time.
- **Veredito:** opção histórica.

### 2.7 Modelos anime-oriented

- **O quê:** treinados em line art / 12–24 fps anime.
- **Custo:** igual RIFE; benefício só no domínio.
- **Benefício:** ótimo em anime; medíocre em live-action.
- **Veredito:** modo opcional de nicho.

### 2.8 Diffusion temporal / generative FI

- **O quê:** “inventar” frames com gen AI.
- **Custo:** absurdo para real-time local; tamanho e privacidade.
- **Benefício:** às vezes excelente offline.
- **Veredito:** fora do escopo de extensão Firefox (hoje).

### 2.9 Distilled / INT8 / WebNN / ONNX quantizado

- **O quê:** mesma família RIFE, runtime otimizado.
- **Custo:** engenharia de export + quirks Firefox WebNN/WebGPU.
- **Benefício:** pode ser o que torna 1080p60 possível.
- **Veredito:** caminho de productization depois do protótipo.

---

## 3. Onde rodar (runtime)

Transversal às seções 1 e 2.

### 3.1 WebGL2 (fragment / ping-pong)

- **O quê:** flow aproximado + warp em shaders (sem NN completa).
- **Custo:** médio; limites de precisão e passes.
- **Benefício:** encaixa no stack atual da extensão.
- **Veredito:** natural para blend/MC simples; NN grande fica forçada.

### 3.2 WebGPU compute

- **O quê:** ME / NN / warps em compute passes.
- **Custo:** reescrever parte do pipeline; maturidade WebGPU no Firefox depende da versão/alvo.
- **Benefício:** único jeito sério de NN + 1080p.
- **Veredito:** base recomendada se interpolação for feature principal.

### 3.3 WebNN / ONNX Runtime Web / TF.js

- **O quê:** rodar modelos prontos.
- **Custo:** peso do runtime + compatibilidade; debug difícil.
- **Benefício:** time-to-prototype de RIFE-like.
- **Veredito:** MVP de qualidade; vigiar tamanho da extensão e cold start.

### 3.4 WASM (OpenCV, C++ custom)

- **O quê:** Farneback/DIS em CPU (SIMD).
- **Custo:** bundle grande; CPU compete com decode da aba.
- **Benefício:** previsível, sem WebGPU.
- **Veredito:** laptops fracos sofrem; ok como experimental.

### 3.5 Worker + OffscreenCanvas

- **O quê:** isolar FI da main thread.
- **Custo:** médio (transferência de frames).
- **Benefício:** UI da página não morre; **não** reduz custo total de GPU.
- **Veredito:** quase obrigatório se o método for pesado.

### 3.6 WebCodecs `VideoFrame`

- **O quê:** acesso mais explícito a frames; possível pipeline com menos cópia.
- **Custo:** integração com player de streaming alheio é espinhosa (YouTube não entrega bitstream limpo).
- **Benefício:** teoricamente melhor controle temporal.
- **Veredito:** poderoso em app MSE próprio; na extensão em cima do player, limitado.

---

## 4. Como obter frame anterior / próximo

### 4.1 Ring buffer de texturas no `requestVideoFrameCallback`

- **O quê:** a cada frame real, upload → guardar `t-1`; interpolar entre `t-1` e `t` com atraso de 1.
- **Custo:** +1 textura VRAM; +1 frame de latência.
- **Benefício:** base de **qualquer** método decente.
- **Veredito:** infraestrutura mínima — primeiro passo de qualquer caminho.

### 4.2 Só passado (extrapolação)

- **O quê:** a partir de `t-2, t-1` prever meio-frame “para frente”.
- **Custo:** similar ou maior; artefatos em mudanças de cena.
- **Benefício:** latência zero; qualidade pior.
- **Veredito:** live “sem delay”; visualmente arriscado.

### 4.3 Atraso de 2+ frames

- **O quê:** buffer N; algoritmos que usam 4 frames.
- **Custo:** latência e VRAM.
- **Benefício:** redes/métodos melhores.
- **Veredito:** ok para VOD; ruim para live/chat interativo.

### 4.4 Seek no vídeo para “pegar” subframes

- **O quê:** hopping de `currentTime`.
- **Custo:** destrói UX, quebra streaming, caríssimo.
- **Benefício:** nenhum na prática.
- **Veredito:** lixo (só por completude).

### 4.5 Interceptar decode / MSE / `SourceBuffer`

- **O quê:** patch no MediaSource ou no player da página.
- **Custo:** frágil por site (YouTube muda sempre); manutenção e risco altos.
- **Benefício:** acesso teoricamente mais limpo a timestamps/chunks.
- **Veredito:** exótico e de alto risco.

### 4.6 `captureStream` do video → processar → outro destino

- **O quê:** MediaStream intermediário (já usado em harness de teste).
- **Custo:** possível cópia extra.
- **Benefício:** desacopla um pouco do layout.
- **Veredito:** útil em teste; no produto o overlay WebGL já é parecido.

---

## 5. Como apresentar frames interpolados

### 5.1 Overlay canvas no refresh da tela (rAF) + clock do vídeo

- **O quê:** vídeo real a 30; canvas desenha 60 com frames sintéticos no meio.
- **Custo:** alinhamento de clock (`mediaTime`) é a parte delicada.
- **Benefício:** funciona **sem** reescrever o elemento `<video>`.
- **Veredito:** encaixa no desenho atual da extensão.

### 5.2 Esconder o `<video>`, só o canvas pinta

- **O quê:** um único paint visível (também ajuda performance do upscaler).
- **Custo:** baixo se já estiver no roadmap de perf.
- **Benefício:** evita double-paint e “vazar” o frame nativo no meio.
- **Veredito:** quase necessário para FI limpa.

### 5.3 rVFC só para âncoras + rAF para meios

- **O quê:** frames reais no callback do vídeo; meios no vsync do monitor.
- **Custo:** scheduling complexo (jitter, late).
- **Benefício:** melhor cadência em monitores 120/144.
- **Veredito:** arquitetura certa para “filme 24 em tela 144”.

### 5.4 Multiplicador fixo 2×

- **O quê:** sempre um meio entre cada par (30→60).
- **Custo:** simples.
- **Benefício:** soap-opera 60 clássico.
- **Veredito:** MVP de produto.

### 5.5 Multiplicador variável (1.5×, 2×, 3×, 4×)

- **O quê:** 24→60, 30→120, etc.
- **Custo:** lógica de fase + mais warps/inferências.
- **Benefício:** monitores de alta taxa.
- **Veredito:** fase 2.

### 5.6 Controle de “suavidade” 0–100 no popup

- **O quê:** mistura duplicate ↔ interpolate (força do warp / confiança).
- **Custo:** baixo.
- **Benefício:** usuário controla o efeito soap-opera.
- **Veredito:** boa UX em cima de qualquer motor.

---

## 6. Híbridos com upscale atual (FSR1 / RAVU)

### 6.1 FI no espaço fonte (baixa res) → depois FSR1/RAVU

- **O quê:** interpolar em resolução menor; upscale para a tela.
- **Custo:** FI bem mais barata.
- **Benefício:** trade-off excelente.
- **Veredito:** **melhor arquitetura** para a extensão.

### 6.2 Upscale primeiro → FI em alta res

- **O quê:** FSR e depois flow em resolução de tela/4K interno.
- **Custo:** absurdo.
- **Benefício:** desnecessário.
- **Veredito:** evitar.

### 6.3 FI só em luma; chroma blend

- **O quê:** clássico de broadcast.
- **Custo:** médio de implementação.
- **Benefício:** ordem de 30–40% menos trabalho em muitos pipelines.
- **Veredito:** otimização forte em shader / NN small.

### 6.4 FI em tiles (só região com movimento)

- **O quê:** grid; estático = copy.
- **Custo:** engenharia média (bookkeeping).
- **Benefício:** grandes ganhos em talking-heads.
- **Veredito:** ótimo para YouTube “pessoa falando”.

### 6.5 Scene-cut detect → desligar FI por N frames

- **O quê:** histograma / diff grande = corte de cena.
- **Custo:** baixo.
- **Benefício:** evita morph horror entre cenas.
- **Veredito:** **obrigatório** em qualquer método.

---

## 7. Servidor / off-device

### 7.1 Proxy que reencoda com FI e entrega HLS/DASH

- **O quê:** RIFE/SVP no servidor; extensão só consome o stream.
- **Custo:** infra, dinheiro, privacidade, ToS, delay.
- **Benefício:** qualidade desktop-class.
- **Veredito:** outro produto — não “extensão leve”.

### 7.2 Cloud burst só em cenas difíceis

- **O quê:** local no default; nuvem quando motion é alto.
- **Custo:** absurdo de sistema.
- **Benefício:** teórico.
- **Veredito:** overkill exótico.

### 7.3 Offline: baixar + RIFE + assistir arquivo

- **O quê:** não é live.
- **Custo:** storage; UX diferente.
- **Benefício:** melhor qualidade possível no cliente.
- **Veredito:** app de arquivo, não enhancer live.

---

## 8. Atalhos de player / OS (quase fora da extensão)

### 8.1 Motion smoothing da TV / driver do monitor

- **O quê:** usuário liga soap no aparelho.
- **Custo:** zero para o projeto.
- **Benefício:** às vezes melhor que um port web.
- **Veredito:** não é feature da extensão.

### 8.2 mpv + VapourSynth / SVP no desktop (laboratório)

- **O quê:** referência de qualidade A/B.
- **Custo:** zero de ship.
- **Benefício:** calibração visual.
- **Veredito:** laboratório, não shipping.

### 8.3 API nativa do Firefox para FI

- **O quê:** não existe de forma usável para páginas genéricas.
- **Veredito:** descartado hoje.

---

## 9. Métodos exóticos

### 9.1 Residual learning em cima do blend

- **O quê:** rede prevê só o residual do frame médio.
- **Custo:** pesquisa / treino.
- **Benefício:** pode ficar leve.
- **Veredito:** paper → protótipo.

### 9.2 Depth monocular (MiDaS etc.) + reprojeção temporal

- **O quê:** “FSR3-like” sem MVs, com depth estimado.
- **Custo:** altíssimo; ghosting temporal.
- **Benefício:** tentador no papel; instável em vídeo de streaming.
- **Veredito:** armadilha sedutora; evitar no v1.

### 9.3 Gaussian Splatting / NeRF temporal por clipe

- **O quê:** reconstruir cena 4D.
- **Custo:** impossível real-time genérico.
- **Benefício:** demo de pesquisa.
- **Veredito:** não.

### 9.4 Motion vectors do codec (H.264/H.265)

- **O quê:** reutilizar MVs do bitstream.
- **Custo:** precisa do bitstream (MSE intercept / chunks) — via `<video>` no YouTube **quase nunca** acessível de forma limpa.
- **Benefício:** ME “de graça” e barata **se** tivesse acesso.
- **Veredito:** santo graal bloqueado pelo sandbox do player.

### 9.5 Treinar rede só em artefatos de streaming

- **O quê:** FI robusta a blocos, low bitrate, YouTube.
- **Custo:** dataset + treino.
- **Benefício:** pode bater RIFE genérico **no domínio da extensão**.
- **Veredito:** diferencial de produto a longo prazo.

### 9.6 Stereo / multi-view (VR180)

- **O quê:** FI com geometria multi-câmera.
- **Benefício:** nicho minúsculo.
- **Veredito:** ignore para o produto geral.

### 9.7 Trabalhar em YUV 4:2:0 nativo do decoder

- **O quê:** menos amostras de chroma.
- **Custo:** WebGL costuma subir RGB — difícil.
- **Benefício:** menos bandwidth.
- **Veredito:** micro-otimização avançada.

### 9.8 Audio-aligned (cortes no áudio / beat)

- **O quê:** scene detect ou efeito rítmico.
- **Benefício:** cosmético para músicas.
- **Veredito:** feature meme.

### 9.9 FI só em fullscreen

- **O quê:** política de custo (desliga em miniplayer).
- **Custo:** baixo.
- **Benefício:** poupa bateria e GPU.
- **Veredito:** boa regra de produto.

### 9.10 Modelo joint (FI + denoise + sharpen)

- **O quê:** uma rede “melhorar vídeo”.
- **Custo:** enorme.
- **Benefício:** unifica FSR e FI.
- **Veredito:** visão final; não é o passo 1.

### 9.11 Dois elementos `<video>` defasados

- **O quê:** dois players com `currentTime` offset para ter dois frames “reais”.
- **Custo:** **double decode**, sync infernal.
- **Benefício:** evita buffer próprio de textura.
- **Veredito:** exótico **mau**; mata leveza.

### 9.12 Interpolar legendas/UI em vez de pixels

- **O quê:** não é interpolação de vídeo.
- **Veredito:** fora de escopo.

---

## 10. Matriz resumida

| # | Opção | Qualidade | Custo eng. | Custo runtime | Latência | Fit na extensão |
|---|--------|-----------|------------|---------------|----------|-----------------|
| 0.2 | Duplicate | ★☆☆ | ★☆☆ | ★☆☆ | 0 | Sim |
| 0.3 | Blend | ★☆☆ | ★☆☆ | ★☆☆ | +1 | Sim |
| 1.2 | Block ME hierárquico | ★★☆ | ★★☆ | ★★☆ | +1 | Sim |
| 1.3 | Flow clássico | ★★☆ | ★★★ | ★★★ | +1 | No limite |
| 1.5 | Phase-based | ★★☆ | ★★★★ | ★★★ | +1 | Exótico |
| 1.6 | MCFI “TV” | ★★★ | ★★★★★ | ★★★ | +1 | Só se for o produto |
| 2.1 | RIFE-like | ★★★★ | ★★★★ | ★★★★ | +1 | Melhor NN |
| 2.3 | FILM | ★★★★★ | ★★★★ | ★★★★★ | +1 | Offline |
| 2.4 | Depth-aware | ★★★★ | ★★★★★ | ★★★★★ | +1 | Não |
| 4.1 | Buffer +1 | — (infra) | ★☆☆ | ★☆☆ | +1 | **Infra** |
| 6.1 | FI low-res → FSR | ★★★★ | ★★☆ | ★★☆ | +1 | **Arquitetura** |
| 6.4 | Tiles com motion | ★★★ | ★★★ | ★★ | +1 | Otimização |
| 7.1 | Server proxy | ★★★★★ | ★★★★★ | $ | alta | Outro produto |
| 9.4 | MVs do codec | ★★★★ | ★★★★★ | ★☆☆ | +1 | Bloqueado no YT |
| 9.11 | Dual `<video>` | ★★ | ★★★ | ★★★★★ | ? | Evitar |

Legenda rápida das estrelas: mais estrelas = mais qualidade **ou** mais custo (conforme a coluna).

---

## 11. Leitura honesta no contexto desta extensão

1. **Infra mínima (qualquer caminho):** ring buffer de 2 texturas + scene-cut + canvas em rAF com `mediaTime` + esconder `<video>` + FI **antes** do FSR (baixa res).
2. **MVP barato (sem NN):** hierarchical block match **ou** blend motion-adaptive + duplicate como fallback — para provar scheduling e latência.
3. **MVP que as pessoas sentem:** RIFE-like quantizado em **WebGPU**, 2×, só fullscreen, qualidade auto (tiles / escala).
4. **Não começar por:** depth, diffusion, dual video, interceptar MSE do YouTube, FILM full.
5. **Conflito de produto:** FI bem feita **não é de graça**. O objetivo “não sentir a extensão” **briga** com soap-opera 1080p60 — a não ser FI em meia resolução + tiles + **opt-in**.

---

## 12. Ordem de exploração (mapa, não compromisso)

1. Buffer `t−1` / `t` + blend (valida clock e estabilidade).
2. Scene-cut + fallback para duplicate.
3. Warp por flow barato (DIS / block hierárquico).
4. Substituir o motor por RIFE WebGPU se o passo 3 não bastar.
5. FI em half-res → FSR1.
6. Controles no popup: off / 2× / agressivo + suavidade.

---

## Índice rápido por seção

| Seção | Tema |
|-------|------|
| 0 | Baseline / fake 60 |
| 1 | Clássicos sem NN |
| 2 | Redes neurais |
| 3 | Runtime (WebGL, WebGPU, WASM…) |
| 4 | Como obter frames no tempo |
| 5 | Como mostrar frames extras |
| 6 | Híbridos com FSR/RAVU |
| 7 | Servidor / offline |
| 8 | Fora da extensão |
| 9 | Exóticos |
| 10 | Matriz |
| 11–12 | Recomendações e ordem |

---

*Gerado a partir da exploração de opções de frame interpolation para o Firefox Video Enhancer. Atualizar este arquivo se o pipeline da extensão mudar de forma relevante (WebGPU, hide-video, etc.).*
