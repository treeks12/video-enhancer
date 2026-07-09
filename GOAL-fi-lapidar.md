# Goal: lapidar frame interpolation (6 opções)

**Status:** pendente — rodar **depois** da implementação bruta e dos testes A/B do usuário.  
**Projeto:** `C:\Users\Filipe\ZCodeProject\firefox-video-enhancer`  
**Contexto:** as 6 peças abaixo entram como flags testáveis; este goal é só a **fase de polimento**, não a primeira entrega.

Referências:

- `frame-interpolation-opcoes.md` — mapa de possibilidades
- Pipeline acordado: infra → scene-cut → gate 24/30 → half-res/luma → block match → fallback

---

## Objetivo

Deixar cada opção de FI **correta, observável e barata o bastante** para decidir com confiança o que fica e o que morre — sem reescrever o produto inteiro.

Critério de “lapidado” por opção:

1. Toggle no popup (ou Avançado) com efeito real e isolável  
2. Métrica/status legível (método ativo, confiança, fps fonte, cut hold)  
3. Self-check ou harness em `test/` onde fizer sentido  
4. Sem regressão grave no path FSR1/RAVU quando FI estiver off  
5. Notas de custo (CPU/GPU/latência) honestas no UI ou no log `[fv-enhancer]`

---

## As 6 opções a lapidar

### 1. Infra temporal mínima

- [ ] Ring buffer `t−1` / `t` estável (texturas + mediaTime)
- [ ] Atraso de 1 frame explícito e documentado
- [ ] rAF entre âncoras rVFC sem double-schedule / leak de callbacks
- [ ] Cancel limpo em off / scroll pause / video change / tainted
- [ ] Esconder `<video>` só quando o canvas FI+upscale está pintando de verdade

### 2. Scene-cut detect

- [ ] Threshold calibrável (default sensato para YT compresso)
- [ ] Hold de N frames em duplicate após corte
- [ ] Não disparar em motion alto legítimo (falsos positivos)
- [ ] Indicador no snapshot: `fiSceneCutHold` / último corte

### 3. Interpolação 2× só 24/30 fps

- [ ] Estimativa de fps por `mediaTime` / presentedFrames (não confiar no player UI)
- [ ] Gate: ~20–32 fps → 2×; ≥ ~48–50 → FI off (só path normal)
- [ ] Histerese para não oscilar no limiar
- [ ] Popup mostra “FI elegível: sim/não (X fps)”

### 4. Half-res / luma-first

- [ ] ME e/ou warp em meia resolução (ou grid reduzido) de forma consistente
- [ ] Luma-only no match; chroma recomposta sem sangramento óbvio
- [ ] FI **antes** do FSR/RAVU (nunca upscale→FI full-res)
- [ ] Toggle isolado: medir ganho de custo com telemetria do popup

### 5. Hierarchical block matching simples

- [ ] Poucos níveis, blocos grandes, search pequeno (orçamento fixo de CPU)
- [ ] Campo de MV esparso → warp GPU (ou path documentado se ainda for CPU)
- [ ] Limitar trabalho por frame (cap de blocos / early exit)
- [ ] Qualidade “aceitável em pan”; aceitar falha em oclusão (vai pro fallback)

### 6. Fallback duplicate / blend (confiança baixa)

- [ ] Score de confiança por frame (SAD residual, coerência de MV, magnitude)
- [ ] Limiares: warp → blend → duplicate
- [ ] Scene-cut força duplicate independentemente do score
- [ ] Snapshot: `fiMethod` = `block` | `blend` | `duplicate` | `skip`

---

## Ordem de lapidação (sugerida)

1. Infra (sem ela nada é confiável)  
2. Gate 24/30 + scene-cut (protegem qualidade e custo)  
3. Fallback (evita warp horror durante o resto)  
4. Half-res/luma (custo)  
5. Block match (qualidade do meio)  
6. Passe final: defaults, copy do popup, o que descartar

---

## Fora de escopo deste goal

- RIFE / WebGPU NN  
- Server-side FI  
- Multiplicadores >2×  
- Interceptar MSE/MVs do codec  
- Fundir FI com redesign grande de performance não relacionado

---

## Verificação

- [ ] `node content.js` (e `fi-*.js` se separado) self-check OK  
- [ ] `test/runtime.html` / harness FI se existir: PASS  
- [ ] YouTube (ou vídeo local) 24/30: meios visíveis, cut limpo  
- [ ] Vídeo 60 fps: FI não gasta trabalho inútil  
- [ ] Cada flag off ≈ comportamento pré-FI  
- [ ] Lista do usuário: **fica / descarta** por opção, atualizar este arquivo

---

## Decisão final (preencher depois dos testes)

| # | Opção | Fica? | Notas |
|---|--------|-------|-------|
| 1 | Infra temporal | | |
| 2 | Scene-cut | | |
| 3 | Gate 24/30 2× | | |
| 4 | Half-res / luma | | |
| 5 | Block match hierárquico | | |
| 6 | Fallback conf. | | |

---

## Prompt curto para retomar (copiar no chat)

```text
Goal FI lapidar: abrir GOAL-fi-lapidar.md no firefox-video-enhancer.
Estado atual do código + o que o usuário já testou (fica/descarta).
Lapidar só o que ficou, na ordem do goal; não reabrir NN/RIFE.
```
