# Upscaling de vídeo em tempo real no Firefox

## Objetivo

Melhorar vídeos genéricos, como YouTube, em tempo real, usando uma extensão do Firefox.

Restrições principais:

* O conteúdo é vídeo, não jogo.
* Não há motion vectors, depth buffer, camera jitter ou outras informações fornecidas por uma engine.
* O método deve funcionar em conteúdo geral, não apenas anime, rostos ou jogos.
* Precisa ser leve o suficiente para manter reprodução fluida.
* A GPU disponível é uma AMD Radeon RX 7900 XTX.
* O resultado deve ser perceptivelmente melhor que um resize convencional.
* FSR1 é a referência atual por ser leve, simples e visualmente aceitável.

---

## Por que FSR2, FSR3 e FSR4 não são substitutos diretos

Os FSR posteriores ao FSR1 são métodos temporais projetados para jogos.

Eles normalmente dependem de dados como:

* motion vectors;
* depth buffer;
* histórico temporal;
* jitter de renderização;
* reactive masks;
* informações da engine sobre objetos e movimento.

Um vídeo comum não fornece esses dados.

Seria possível estimar movimento usando optical flow, mas isso criaria outro pipeline, muito mais pesado e sujeito a:

* ghosting;
* instabilidade temporal;
* erros em oclusões;
* custo elevado;
* aumento de latência.

Portanto, sem informações temporais confiáveis, o problema deve ser tratado principalmente como **single-frame spatial upscaling**, processando cada frame isoladamente.

---

## Categorias de solução

### 1. Filtros espaciais clássicos

Exemplos:

* Lanczos;
* bicúbico;
* EWA;
* sharpening convencional.

São extremamente leves, mas não reconstruem detalhes. Apenas interpolam os pixels disponíveis.

---

### 2. Upscalers espaciais inteligentes

Exemplos:

* AMD FSR1;
* NVIDIA Image Scaling;
* RAVU-lite;
* shaders direcionais personalizados.

Normalmente combinam:

* detecção de bordas;
* interpolação adaptativa;
* reconstrução direcional;
* sharpening controlado.

Têm custo baixo e são apropriados para execução em shaders WebGL ou WebGPU.

FSR1 continua relevante porque possui ótima relação entre custo, simplicidade e melhoria perceptível.

NVIDIA Image Scaling pertence aproximadamente à mesma classe tecnológica. Pode produzir uma aparência diferente, mas não representa necessariamente um salto claro sobre o FSR1.

---

### 3. Redes neurais pequenas por frame

Exemplos:

* FSRCNNX;
* SPAN;
* RLFN e variantes;
* EfRLFN;
* outros modelos compactos de super-resolution.

Essas redes podem reconstruir melhor:

* bordas;
* texturas;
* detalhes finos;
* conteúdo degradado por compressão.

Entretanto, o custo total não depende apenas da inferência. Em uma extensão de navegador, também é necessário considerar:

* acesso ao frame decodificado;
* cópia do vídeo para uma textura;
* conversões de formato e espaço de cor;
* upload para a GPU;
* renderização em canvas;
* composição com a página;
* sincronização com o elemento `<video>`.

Uma rede pequena pode ser rápida isoladamente, mas o pipeline completo pode ser lento.

---

## FSRCNNX

FSRCNNX é uma alternativa intermediária entre shaders clássicos e redes maiores.

Vantagens:

* relativamente pequena;
* pode ser implementada como shaders;
* processa grande parte da imagem em resolução baixa;
* oferece melhoria mais real do que apenas sharpening;
* já possui implementações usadas em players como mpv.

Variantes comuns incluem configurações rápidas, médias e de maior qualidade.

Um pipeline possível seria:

```text
frame decodificado
    ↓
extração ou priorização da luminância
    ↓
FSRCNNX ×2
    ↓
upscale simples da crominância
    ↓
resize final para a resolução da tela
    ↓
sharpening discreto
```

Processar apenas a luminância pode reduzir o custo, pois o olho humano percebe mais resolução no brilho do que nos canais de cor.

Limitações:

* normalmente opera com fatores fixos, como ×2;
* ainda exige múltiplos passes;
* pode ser pesado em 1080p60 ou 4K;
* precisa ser portado cuidadosamente para WebGL2 ou WebGPU;
* o ganho pode não compensar o custo dentro do Firefox.

Seria mais plausível como modo experimental para vídeos 720p ou resoluções menores.

---

## RAVU-lite

RAVU-lite é mais próximo de um shader aprendido do que de uma rede neural convencional executada por um runtime.

Características interessantes:

* custo relativamente baixo;
* utiliza informações locais e direcionais;
* pode trabalhar principalmente sobre luminância;
* foi pensado para uso em pipelines de vídeo;
* é mais plausível de portar para shaders do que uma CNN moderna completa.

Potenciais problemas:

* exige adaptação das LUTs e shaders;
* pode precisar de vários passes;
* implementações originais são voltadas para players como mpv;
* a portabilidade para WebGL2 pode ser trabalhosa;
* o ganho sobre FSR1 provavelmente será incremental, não revolucionário.

Ainda assim, é um dos candidatos mais realistas para tentar superar FSR1 sem abandonar a leveza.

---

## Redes modernas como EfRLFN

Modelos compactos treinados especificamente com vídeo comprimido podem superar significativamente FSR1 em qualidade.

O ponto importante não é apenas a arquitetura, mas o treinamento.

Uma rede pequena treinada com conteúdo semelhante a streaming pode aprender a lidar melhor com:

* blocos de compressão;
* ringing;
* bordas borradas;
* perda de textura;
* ruído de codecs;
* diferentes tipos de conteúdo.

Isso tende a ser mais útil para YouTube do que uma rede treinada apenas com fotografias reduzidas por bicúbico.

Porém, mesmo uma arquitetura pequena enfrenta problemas práticos numa extensão:

* integração com WebGPU;
* armazenamento e carregamento dos pesos;
* compilação de pipelines;
* múltiplos dispatches;
* memória intermediária;
* tiled inference;
* conversões entre vídeo, texturas e buffers;
* compatibilidade entre sistemas e drivers;
* sincronização com reprodução;
* consumo elevado em resoluções grandes.

Assim, modelos como EfRLFN podem ser tecnicamente interessantes, mas não são uma primeira opção sensata para uma extensão Firefox.

---

## Principal obstáculo no Firefox

O maior problema não é necessariamente a potência da GPU.

O problema é obter os frames decodificados, processá-los e devolvê-los ao compositor sem cópias desnecessárias.

Um pipeline ruim pode ficar semelhante a:

```text
decodificação de hardware
    ↓
cópia ou readback do frame
    ↓
upload para WebGL/WebGPU
    ↓
processamento
    ↓
renderização em canvas
    ↓
compositor do navegador
```

Se ocorrer ida e volta entre GPU e CPU, o custo de movimentar o frame pode superar o custo do próprio upscaler.

Isso se torna crítico em:

* 1080p60;
* 1440p60;
* 4K;
* HDR;
* vídeos com alta taxa de bits;
* sistemas com múltiplos monitores ou escalas diferentes.

A existência de WebGPU não garante automaticamente um pipeline zero-copy.

---

## Sincronização

`requestVideoFrameCallback()` é a API mais apropriada para acompanhar frames apresentados pelo elemento de vídeo.

Ela ajuda a obter:

* timestamps;
* dimensões do frame;
* metadados de apresentação;
* sincronização melhor que `requestAnimationFrame()`.

Mesmo assim, ainda há riscos:

* processamento terminar depois do prazo;
* perda de frames;
* dessincronização visual;
* atraso de um ciclo;
* canvas exibir um frame anterior ao áudio;
* diferenças entre fullscreen, picture-in-picture e reprodução normal.

Uma extensão precisa conseguir abandonar frames atrasados em vez de criar uma fila crescente.

---

## Pipeline mais realista para uma extensão

A arquitetura recomendada é:

```text
HTMLVideoElement
    ↓
importação direta para textura, quando possível
    ↓
um pequeno número de passes WebGL2 ou WebGPU
    ↓
canvas posicionado sobre o vídeo
```

Evitar no caminho por frame:

* `getImageData()`;
* `putImageData()`;
* `readPixels()`;
* processamento em JavaScript;
* criação constante de `ImageBitmap`;
* cópias CPU;
* arrays RGBA;
* redecode completo com WebCodecs;
* runtimes neurais pesados;
* alocações de texturas a cada frame.

Texturas, framebuffers e pipelines devem ser reutilizados.

---

## Solução recomendada

### Primeira etapa: melhorar o pipeline atual de FSR1

Antes de trocar o algoritmo, otimizar:

* sincronização com `requestVideoFrameCallback()`;
* reutilização de texturas;
* quantidade de passes;
* escalonamento do canvas;
* tratamento de fullscreen;
* descarte de frames atrasados;
* resolução interna;
* custo do RCAS;
* precisão FP16 ou equivalente;
* conversões de cor;
* ausência de cópias CPU.

É possível que a maior melhoria de FPS venha do pipeline, não da troca do upscaler.

---

### Segunda etapa: FSR1 aprimorado

Manter EASU ou uma reconstrução direcional semelhante e melhorar:

* limitação de halos;
* sharpening adaptativo;
* proteção de áreas ruidosas;
* redução de ringing;
* detecção de compressão;
* intensidade baseada na escala;
* intensidade baseada na resolução do vídeo.

Pipeline sugerido:

```text
frame
    ↓
prefiltro leve contra ringing e macroblocos
    ↓
upscale direcional semelhante ao EASU
    ↓
sharpening adaptativo com proteção contra halos
    ↓
saída
```

Esse caminho provavelmente oferece a melhor relação entre esforço, estabilidade e desempenho.

---

### Terceira etapa: testar RAVU-lite

RAVU-lite seria o candidato mais lógico para um modo de qualidade superior ainda baseado em shaders.

Prioridades:

* WebGL2 antes de WebGPU, caso a implementação atual já use WebGL;
* operar em luminância quando possível;
* limitar o número de passes;
* usar fallback automático;
* medir tempo real por frame;
* desativar em 4K ou quando não houver orçamento suficiente.

---

### Quarta etapa: FSRCNNX Fast experimental

Pode ser testado apenas em condições controladas:

* entrada 480p ou 720p;
* upscale ×2;
* vídeos a 24 ou 30 fps;
* GPU com margem;
* modo explicitamente ativado pelo usuário.

Não deve ser o padrão inicial para todo vídeo.

---

## Modos sugeridos para a extensão

### Off

Vídeo original.

### Sharp

Apenas sharpening adaptativo, sem upscale complexo.

### Balanced

FSR1 ou versão aprimorada do EASU + RCAS.

### Quality

RAVU-lite ou outro shader aprendido compacto.

### Experimental Neural

FSRCNNX Fast, limitado por resolução e FPS.

A extensão pode medir o tempo médio por frame e reduzir automaticamente a qualidade.

Exemplo:

```text
tempo < 4 ms:
    modo Quality

tempo entre 4 e 8 ms:
    modo Balanced

tempo > 8 ms:
    modo Sharp ou bypass
```

Para vídeo a 60 fps, o orçamento total por frame é aproximadamente 16,67 ms, mas o upscaler deve consumir apenas uma fração disso.

---

## Resolução de trabalho

Não é necessário sempre processar na resolução física total do monitor.

Exemplo:

* vídeo 1080p;
* tela 4K;
* canvas interno processado em 1440p ou 1800p;
* compositor amplia o restante.

Isso pode oferecer resultado melhor que 1080p nativo com custo muito inferior ao processamento completo em 4K.

Também é possível limitar o upscale por razão:

```text
escala máxima neural/shader: 1,5× ou 2×
restante: interpolação convencional
```

---

## Conclusão

A alternativa teoricamente superior ao FSR1 seria uma pequena rede de super-resolution treinada com vídeo comprimido e executada frame a frame.

Entretanto, dentro de uma extensão Firefox, o principal gargalo é o pipeline entre:

* decodificador;
* elemento de vídeo;
* GPU;
* canvas;
* compositor.

Por isso, a ordem mais realista é:

1. otimizar profundamente o pipeline atual;
2. aprimorar o FSR1 com melhor tratamento de compressão e halos;
3. testar RAVU-lite ou outro shader aprendido compacto;
4. usar FSRCNNX Fast apenas como modo experimental;
5. evitar inicialmente EfRLFN, ONNX e redes modernas completas.

A conclusão prática é:

> Para uma extensão Firefox, a melhor evolução do FSR1 provavelmente não é uma CNN moderna, mas um upscaler espacial em shaders, com poucos passes, importação eficiente do vídeo e controle adaptativo de qualidade.

Para alcançar algo próximo de NVIDIA Video Super Resolution, o ambiente ideal seria:

* player nativo;
* pipeline Vulkan, Direct3D ou similar;
* integração direta com o decodificador;
* acesso zero-copy às superfícies de vídeo;
* controle sobre o compositor.

A RX 7900 XTX possui potência suficiente. O desafio real é alimentar essa potência de forma eficiente dentro das limitações de uma extensão de navegador.
