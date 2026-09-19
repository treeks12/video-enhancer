# Video Enhancer 0.0.62 experimental

## O que esta entrega contém

Implementação sobre o snapshot 0.0.61 fornecido, com backend neural compacto WebGPU, instalador de pesos, dois perfis de interpolação e fallback para o motor clássico. O comparador original/processado foi corrigido, assim como a conversão numérica half-float.

**Não é uma versão já homologada em vídeo real.** O ambiente de desenvolvimento não disponibilizou WebGPU nem WebGL2. A inferência com os pesos treinados, a compilação WGSL, a transferência WebGPU → WebGL e a qualidade/performance no seu computador continuam exigindo validação. Os testes de controle e os testes numéricos foram executados; não devem ser confundidos com essa validação visual.

## Instalar e ativar

### Firefox

Extraia `video-enhancer-firefox-0.0.62.zip`. Desative a versão anterior para não executar dois overlays. Em `about:debugging#/runtime/this-firefox`, use **Carregar extensão temporária** e selecione o `manifest.json` extraído. Recarregue a página do vídeo.

O pacote não é assinado. A instalação temporária não é uma publicação na loja e pode precisar ser refeita depois de reiniciar o navegador.

### Chrome ou Edge

Extraia `video-enhancer-chromium-0.0.62.zip`. Na página de extensões, habilite o modo de desenvolvedor e use **Carregar sem compactação**, apontando para a pasta extraída. Desative a extensão anterior e recarregue a página do vídeo.

### Pesos neurais

No popup, abra **Neural model setup**. Leia os termos, marque a confirmação e use **Download and install model**. O download obtém somente os arquivos de dados `rt_v7s.json` e `rt_v7s.bin` do pacote `framegen@1.4.0` do npm (o npm não publica nada além da 1.4.0; esses pesos são byte-idênticos aos da tag GitHub v1.4.7. O pin original na 1.4.7 dava HTTP 404 e foi corrigido em 0.0.63). O upstream descreve aproximadamente 2,9 MB de pesos. A permissão para o domínio de download é opcional, solicitada nesse clique e removida ao terminar. Nenhum frame de vídeo é enviado.

Depois, selecione **Compact neural (experimental)** em Engine, habilite Frame interpolation e escolha Balanced ou High quality. O modo Original mantém a imagem sem upscale, mas permite testar a interpolação separadamente. FSR1 e RAVU continuam disponíveis e também processam os frames intermediários.

Os pesos **não estão dentro destes ZIPs**. O download não foi executado neste ambiente. Há importação manual dos mesmos dois arquivos na página de configuração e um script para montar um pacote offline.

## A rede, sem confundir integração com treinamento

Não treinei um modelo novo. Implementei um runtime denso compatível com a arquitetura compacta t-factored do Framegen e com seus pesos v7-small. O código usa convoluções/PReLU, uma parte inicial independente do instante de interpolação, condicionamento FiLM, fluxos intermediários, máscara aprendida e um refinamento residual para oclusões.

A preparação da rede, os recursos intermediários, o warp e a reconstrução RGB ficam na GPU. Uma pequena rede de condicionamento temporal roda em JavaScript. Uma miniatura de luma ainda é lida na CPU para detectar cortes. O resultado passa por um canvas WebGPU para a cadeia WebGL de upscale existente. Portanto, esta versão **não** promete um pipeline inteiro sem cópias ou uma única API gráfica.

O runtime não é o runtime otimizado original do Framegen: não incorpora seu autotuning nem seu refinamento esparso. Benchmarks do upstream não são resultados deste código.

| Perfil | Resolução interna neural típica em vídeo 16:9 | Reconstrução final |
|---|---|---|
| Balanced | 640 × 352, limitada pela fonte | Na resolução da fonte; upscale depois |
| High quality | 960 × 528, limitada pela fonte | Na resolução da fonte; upscale depois |

As dimensões internas são múltiplos de 16. Os perfis usam o mesmo modelo, não duas redes com quantidades diferentes de parâmetros. FP16 é usado quando o dispositivo anuncia `shader-f16`; caso contrário, há implementação FP32. Fontes acima do limite de texturas ou de 4096 × 2304 pixels totais acionam fallback. Não há garantia de tempo real em qualquer hardware médio.

## Como a reprodução é protegida

Uma inferência fica em execução por vez. Um anel limitado de quatro texturas preserva os endpoints em uso sem criar uma fila de pares antigos. O instante a sintetizar é escolhido antes da inferência; um midpoint vencido não recebe um timestamp novo para parecer válido. Se o resultado não chega ao slot, o anchor original permanece. O atraso visual segue aproximadamente um frame de origem; não foi acrescentado um buffer de vários frames nem alterado o áudio.

Seek, troca de fonte, reset e desligamento invalidam resultados anteriores. Falha do modelo, ausência dos pesos e perda do dispositivo neural acionam fallback explícito para o motor clássico. Se WebGPU não funciona, ficam os frames originais e o upscale WebGL, quando disponível. CORS e vídeo protegido continuam sujeitos às restrições do navegador.

O popup informa o backend efetivo, a razão do fallback, a resolução interna e o tempo de trabalho neural. A contagem de frames realmente apresentados deve ser acompanhada junto da qualidade. Os valores de p95 são tempos de parede da tarefa, não timestamps de GPU isolados.

## Correções complementares

A conversão float32 → half-float foi corrigida com arredondamento para o mais próximo/par. Vetores não finitos ou fora de um domínio plausível são neutralizados antes do upload, com confiança zero. No motor clássico, outliers isolados de baixa confiança podem ser substituídos por um vetor da vizinhança, respeitando o guia de luminância; a consistência bidirecional é recalculada depois.

O modo 50/50 desenha novamente a metade original sem EASU/RCAS/RAVU. Nos instantes interpolados, essa metade usa o anchor original atrasado correspondente, não o vídeo ao vivo em outro relógio.

A seleção clássica de oclusão não foi inteiramente reescrita. Também não foram incorporados upscalers ArtCNN/CuNNy, treinamento de pesos novos ou SR temporal. Esta entrega concentra o pedido adicional de uma rede compacta real e sua integração.

## Validação executada

`node test/run.cjs` executa os testes originais e os novos testes de conversão, regularização, cadência, instalação de modelos, ciclo de vida e controle do runtime. Passaram 63.488 padrões half finitos e 100.000 entradas float32 comparadas com o oráculo NumPy independente.

Os testes de GPU simulada verificam a ligação do grafo de 19 dispatches, os caminhos de armazenamento FP32/FP16, a reutilização de recursos, a limpeza de falhas parciais, a concorrência e o descarte de resultados vencidos. Eles **não executam WGSL**.

`python test/neural-reference.py` gerou dez referências independentes em PyTorch, incluindo fases 0, 0,25, 0,5, 0,75 e 1. Os pesos dessa fixture são aleatórios e não treinados. As saídas nas fases 0 e 1 preservam os endpoints exatamente. Esses resultados são referências matemáticas para testar kernels, não evidência de boa imagem.

O popup foi exercitado no Chromium com estado sintético. As capturas em `release-evidence/` mostram esse estado sintético: seus números não são benchmarks.

## Primeiro teste no ambiente real

Na pasta do código-fonte, execute:

```sh
python -m http.server 8765 --bind 127.0.0.1
```

Abra `http://localhost:8765/test/neural-conformance.html` no navegador-alvo e clique em Run WebGPU conformance. A página executa os kernels desta versão contra as referências PyTorch já incluídas, em FP32 e, quando disponível, FP16. Não é necessário instalar PyTorch para executar essa página. O relatório fica também em `window.__neuralConformance`.

**Não promover a neural para padrão antes dessa comparação passar e de testar playback.** Depois, compare Classic/Neural com a mesma cena, tamanho de saída e nitidez. Observe mãos, rostos, legendas, grades, cruzamentos, cortes e movimentos de câmera. Valide pause/seek, fullscreen, scroll, mudança de resolução e velocidade. Use Advanced → Neural debug para fluxo, máscara, diferença entre warps e residual. Compare também a quantidade efetiva de mids: um resultado limpo que não apresenta mids não prova interpolação melhor.

## Recompilar e continuidade

```sh
node test/run.cjs
python tools/package.py
```

Para empacotar com pesos offline, após ler a licença:

```sh
python tools/install-model.py --accept-noncommercial-license
python tools/package.py
```

O instalador offline requer Node.js para usar o mesmo validador da extensão. Não modifica a origem pública nem baixa código remoto. A versão PowerShell `build.ps1` também foi atualizada, mas não foi executada neste ambiente Linux.

O snapshot 0.0.61 é o primeiro commit do Git local desta entrega. O histórico público até 0.0.56 não foi reconstruído nem substituído. Nenhum push foi feito. Há um patch relativo ao snapshot fornecido e um bundle do histórico local.

## Licença dos pesos

O código adaptado do Framegen é MIT, com aviso e atribuição em `third_party/framegen/`. Os pesos têm termos separados de uso pessoal e pesquisa não comercial. Não se deve incorporá-los a um produto pago sob a suposição de que a licença MIT do runtime também os cobre. O hash salvo ao instalar detecta corrupção local, mas não é uma assinatura independente do autor.
