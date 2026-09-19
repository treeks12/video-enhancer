# Plano de Qualidade — Frame Interpolation (pós-0.0.61)

> Contexto: 0.0.61 trocou média fantasma por seleção dura de endpoint por pixel.
> Resultado relatado: frames melhores, PORÉM artefatos em lugares aleatórios da
> imagem (em frames gerados, não tipo driver/GPU). Este plano foi precedido de
> busca ampla; nenhuma linha do interpolador deve mudar antes de decidir por ele.

## 1. Diagnóstico — sintoma → hipótese

| Sintoma | Hipótese técnica | Confiança |
|---|---|---|
| Patches errados espalhados aleatoriamente | **Incoerência espacial**: decisão `a`-ou-`b` por pixel sem regularização; vizinhos escolhem endpoints diferentes quando confiança/vetores oscilam → mosaico | Alta |
| Patches em lugares "aleatórios" | **Vetores outlier isolados**: LK por célula 2×2 sem pós-filtro; uma célula ruim deforma uma região e a escolha dura expõe o erro que a média antiga escondia | Alta |
| Ghosting residual em bordas | Fluxo sub-pixel nas bordas de oclusão; threshold fotométrico (0.025–0.12) não pega desalinhamento < ~1 px | Média |

As três hipóteses são **testáveis com um overlay de debug** (seção 4) antes de
qualquer fix. Não patchear às cegas.

## 2. Achados da pesquisa

- **Forward-backward consistency** é o detector de oclusão padrão em VFI flow-based;
  o que varia entre métodos é o *tratamento* (mascaramento, síntese alternativa).
  [IET occlusion-aware flow networks](https://ietresearch.onlinelibrary.wiley.com),
  [survey VFI 2026](https://arxiv.org).
- **AFMF (AMD)**: filosofia conservadora — quando o movimento é problemático,
  **pula a geração** e entrega o frame nativo. AFMF 2 só reduz a frequência do
  fallback. É o comportamento a imitar: melhor sem frame do que frame com glitch.
- **RIFE**: estima fluxo **da perspectiva do frame intermediário** (F_t→0, F_t→1)
  direto, coarse-to-fine, + rede de refinement limpando o resultado do warp.
  Nosso shader aproxima isso com 1 refinamento inverse-warp — sem refinement,
  erros do fluxo aparecem crus na imagem.
- **Softmax Splatting (Softsplat)**: forward warping ponderado por importância
  resolve colisões de oclusão e buracos do backward warp. Principado, porém
  caro de implementar (splatting em compute). Candidato de médio prazo.
  [Paper](https://arxiv.org/abs/2003.05534) · [Repo](https://github.com/sniklaus/softmax-splatting).
- **Fluxo simétrico** (Rakêt et al., [Mia Saarland](https://www.mia.uni-saarland.de)):
  interpolação com fluxo simétrico supera forward, backward ou "ambos" — apoia
  estimar o campo na coordenada do meio, não reusar endpoints.
- **Filtro de mediana sobre o campo de fluxo** é heurística clássica de
  rejeição de outliers (["Secrets of Optical Flow", Sun et al.](https://cs.brown.edu/people/dqsun/pubs/cvpr_2010_flow.pdf));
  formalizada como weighted image restoration. Barato e diretamente aplicável
  ao nosso WGSL.
- **⚠ Framegen** ([Chrome Store](https://chromewebstore.google.com/detail/framegen-frame-interpolat/hpdpcjakhclhljfdkpjolonjlopbdhfk) ·
  [GitHub](https://github.com/MONZikWasTaken/Framegen)): extensão que faz
  interpolação **neural** (RIFE destilado, 2.9 MB) com runtime WGSL escrito à
  mão, ~2–3.75 ms/frame 1080p, GPU-residente, sem servidor. Provas:
  (a) neural in-browser é prático HOJE; (b) pipeline GPU-residente (sem
  readback de luma pra CPU) é arquitetura superior à nossa ponte atual.
  Poréns: pesos **não-comerciais** (inviável pro nosso release), Chromium-only,
  runtime hand-WGSL = projeto inteiro por si só.

## 3. Track A — espremer o pipeline clássico (barato, incremental, Firefox incluso)

Ordem por razão custo/benefício; A1 e A2 são independentes; A3 depende de A2.

### A1. Overlay de debug (fazer primeiro, sempre)
Visualizar no próprio vídeo: máscara de oclusão/inconsistência, magnitude do
fluxo, confiança — como cores sobre o frame gerado. Resolve "não consigo te
mostrar": patch de artefato passa a correlacionar (ou não) com máscara vermelha.
Esforço: ~1h. Risco: zero (setting escondido). **Gate de tudo que vem depois.**

### A2. Regularização do campo de fluxo — mediana 3×3 em WGSL
Pós-passo no nível fino do `fi-webgpu.js`: mediana vetorial por célula
(mediana por componente basta; ou mediana por magnitude). Mata outliers
isolados = "lugares aleatórios". Clássico barato. Esforço: ~½ dia com teste.
Risco: baixo (preserva bordas de movimento se mediana por componente).

### A3. Decisão espacialmente coerente no shader
Suavizar a máscara `pick` (blur 3×3 no espaço da grade de MV) ou decidir
por **célula** (não por pixel) e interpolar suavemente entre células vizinhas.
Remove o mosaico da escolha dura. Esforço: ~½ dia. Risco: médio (pode re-
introduzir ghost se suavizar demais — validar com A1).

### A4. Gating conservador estilo AFMF
Células com consistência abaixo do limiar **não interpolam**: exibem o endpoint
mais próximo sem warp (ou o frame original). Hoje escolhemos `a` ou `b` *warped*;
onde o fluxo é ruim, conteúdo sem warp é mais seguro que warp errado.
Esforço: pequeno (muda o `else` do pick). Risco: baixo.

### A5. (Opcional) Fluxo simétrico / refinement melhorado
Substituir o refinamento inverse-warp de 1 passo por estimativa na coordenada
do meio (aproximação do IFNet do RIFE sem rede). Pesquisar mais antes; só se
A1–A4 não bastarem.

**Teto honesto do Track A**: LK a 320–480 px não é RIFE. O objetivo realista é
**"AFMF-conservador"**: nenhum glitch aleatório, interpol só onde é seguro,
fallback gracioso no resto. Se o teto for insuficiente pro usuário → Track B.

## 4. Track B — motor neural (estratégico, decisão gate após A1–A4)

Evidência Framegen valida a viabilidade. Requisitos próprios:
1. **Licença limpa** (pesos comerciais): verificar FILM (Apache-2.0?),
   AMT, IFRNet, ou destilar nós mesmos de um professor de licença limpa.
   Os pesos do Framegen são não-comerciais — não copiar.
2. **Runtime**: onnxruntime-web com WebGPU EP (peso ~10–20 MB no pacote, sem
   WGSL à mão) vs port WGSL próprio (rápido, caríssimo de construir).
   Começar pelo ORT-web com modelo pequeno em 480p.
3. **Pipeline GPU-residente**: eliminar o readback de luma (lição do Framegen).
4. **Firefox**: WebGPU no Firefox continua atrás; Track A permanece como
   fallback — investimento em A não é perdido.

**Gate de entrada do Track B**: Track A entregue (A1–A4) e o usuário ainda
insatisfeito com o teto clássico. Não abrir antes.

## 5. Metodologia de teste

- Sequência fixa de teste (a "corrida" das sessões Codex) + 1 anime + 1 pan lento.
- Popup já tem 6 toggles A/B desde 0.0.36: reusar, adicionar o overlay A1.
- Critério de sucesso por fix: artefato-alvo some SEM introduzir novo tipo
  (ghost de volta, blur, flicker). Sem visão confiável do agente → o veredito
  é sempre do usuário, com o overlay A1 como evidência compartilhável.

## 6. Ordem de execução

```
A1 overlay  →  A2 mediana  →  A3 máscara coerente  →  A4 gating
      ↓ (se teto insuficiente, com evidência)
     Track B (spike ORT-web + modelo licenciável a 480p)
```

## Fontes

- [Survey VFI 2026 (arXiv)](https://arxiv.org) · [IET: flow+occlusion](https://ietresearch.onlinelibrary.wiley.com)
- [RIFE (arXiv 2011.06294)](https://arxiv.org/abs/2011.06294) · [RIFE (GitHub)](https://github.com/hzwer/RIFE)
- [Softsplat (arXiv 2003.05534)](https://arxiv.org/abs/2003.05534) · [Repo](https://github.com/sniklaus/softmax-splatting)
- [Fluxo simétrico — Rakêt et al.](https://www.mia.uni-saarland.de)
- [Secrets of Optical Flow — Sun et al., CVPR 2010](https://cs.brown.edu/people/dqsun/pubs/cvpr_2010_flow.pdf)
- [AFMF — AMD](https://www.amd.com) · [AFMF 2 quality/hwcooling](https://www.hwcooling.net)
- [Framegen (GitHub)](https://github.com/MONZikWasTaken/Framegen) · [Chrome Store](https://chromewebstore.google.com/detail/framegen-frame-interpolat/hpdpcjakhclhljfdkpjolonjlopbdhfk)
