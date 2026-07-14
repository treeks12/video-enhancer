# RIFE ONNX WebGPU — protótipo isolado

Prova mínima, sem framework e sem alterar a extensão. Ela interpola dois SVGs fixos em
640×360, com padding inferior para 640×384 (múltiplo de 32), e mede carga, preparação,
inferência P50/P95 e conversão da saída para `ImageData`.

## Rodar

```powershell
cd test\rife-webgpu
.\vendor.ps1 -ModelPath C:\tmp\practical-rife-export\rife-4.25-lite-384x640-opset18.onnx
python serve.py
```

Abra `http://localhost:8765/` e clique em **Carregar e medir**. Parâmetros opcionais:

```text
?provider=auto&warmup=3&runs=20
?provider=wasm&warmup=1&runs=5
?provider=webgpu&gpuOutput=1&warmup=3&runs=20
```

`auto` tenta WebGPU e registra o motivo antes de cair para WASM. Sirva por HTTP; abrir
`index.html` via `file://` impede o carregamento correto de WASM/modelo. O servidor
incluído também envia os MIME types de `.mjs`/`.wasm` e os headers necessários para
WASM multithread; o `python -m http.server` padrão do Windows serve `.mjs` como texto.

## Critério

- resolução útil: 640×360; computação real: 640×384;
- WebGPU P50 ≤ 12 ms e P95 ≤ 15 ms, após 3 warmups;
- WASM é apenas diagnóstico e não pode passar o orçamento de produto;
- a API pública do runtime não confirma a partição por operador; portanto o benchmark
  pode aprovar o tempo, mas não aprova sozinho o gate de produto sem provar zero fallback;
- o tempo de `session.run` inclui upload do tensor CPU e readback da saída CPU;
- preparação RGBA→NCHW e `ImageData` são informadas separadamente.

Este é deliberadamente o caminho pessimista de cópias. ONNX Runtime oferece IO binding
com `Tensor.fromGpuBuffer`, mas isso só ajuda a extensão depois de existir um preprocess
WebGPU que converta `VideoFrame`/textura para NCHW e um consumidor GPU da saída. Medir
apenas um tensor já residente na GPU esconderia o custo que o pipeline atual ainda paga.
`gpuOutput=1` mede uma etapa intermediária: mantém a saída na GPU e sincroniza a fila em
cada amostra, mas a entrada ainda é enviada da CPU.

## Artefatos e licenças

- `onnxruntime-web@1.27.0`, MIT, obtido do npm pelo `vendor.ps1`.
- Practical-RIFE 4.25 Lite, commit `17d8c7a…`, checkpoint oficial e código MIT.
- Checkpoint SHA-256: `81CDBA22…96B8B1`.
- ONNX opset 18 exportado e validado: 24.542.776 bytes, SHA-256 `9E98E435…6BC18`.

Fontes:

- https://onnxruntime.ai/docs/tutorials/web/ep-webgpu.html
- https://www.npmjs.com/package/onnxruntime-web/v/1.27.0
- https://github.com/hzwer/Practical-RIFE

## Export oficial

`export-model.py` documenta a receita usada com o checkpoint oficial. A validação contra
PyTorch obteve PSNR 72,61 dB, erro absoluto médio `8,87e-5` e P99 `0,001018`.
O checkpoint Lite exige geometria compatível com sua escala inicial 32; 384×640 funciona,
enquanto 192×320 falha internamente apesar de ambas as dimensões serem múltiplas de 64.

Reprodução resumida:

```powershell
$work = "C:\tmp\practical-rife-export"
git clone https://github.com/hzwer/Practical-RIFE.git "$work\source"
git -C "$work\source" checkout 17d8c7a1005b37f4c97bfee04e316aaec7fdc536
py -3.11 -m venv --system-site-packages "$work\.venv"
& "$work\.venv\Scripts\python" -m pip install gdown onnx onnxruntime
& "$work\.venv\Scripts\python" -m gdown 1zlKblGuKNatulJNFf5jdB-emp9AqGK05 -O "$work\practical-rife-4.25-lite.zip"
Expand-Archive "$work\practical-rife-4.25-lite.zip" "$work\checkpoint"
& "$work\.venv\Scripts\python" .\export-model.py $work
```

### Poda Web-Lite sem retreinamento

O último bloco produz 13 canais, mas seus 8 canais de features não alimentam outro
estágio. A opção abaixo exporta apenas os 5 canais usados por fluxo e máscara:

```powershell
& "$work\.venv\Scripts\python" .\export-model.py $work --web-lite
.\vendor.ps1 -ModelPath "$work\rife-4.25-lite-web-lite-384x640-opset18.onnx" -Force
```

A saída PyTorch antes/depois da poda é idêntica (`max abs error = 0`). As convoluções
caem de 4,163 para 3,408 GMAC (-18,1%), mas os 18 `GridSample` permanecem. No mesmo
AMD RDNA 3, com 10 warmups, 200 execuções, saída GPU e upload CPU em cada execução:

| Modelo | P50 | P95 | Resultado |
|---|---:|---:|---|
| 4.25 Lite oficial | 20,87 ms | 24,90 ms | falhou |
| Web-Lite podado | 21,56 ms | 23,99 ms | falhou |

A poda isolada não acelerou o P50 de forma reproduzível; não integrá-la como otimização
de velocidade. O próximo experimento útil é FP16, medido separadamente.

## Resultado local (2026-07-12)

Sonda em WebGPU, adaptador reportado como AMD RDNA 3; números não são universais:

| Modelo | Entrada computada | Saída | P50 | P95 | Veredito |
|---|---|---|---:|---:|---|
| ONNX público sem proveniência | 640×384 | CPU a cada execução | 33,73 ms | 35,06 ms | falhou |
| ONNX público sem proveniência | 320×192 | CPU a cada execução | 23,43 ms | 28,88 ms | falhou |
| ONNX público sem proveniência | 320×192 | GPU + sincronização | 16,50 ms | 21,87 ms | falhou |
| 4.25 Lite oficial | 640×384 | GPU + sincronização | 21,14 ms | 25,13 ms | falhou |

O checkpoint Lite oficial não cumpriu 12/15 ms. Não integrar RIFE neste pipeline; só
reabrir o gate com entrada e saída residentes na GPU e hardware/runtime significativamente
mais rápidos.
