# Video Enhancer 0.0.64: Store com IFRNet-S nativo

## O que mudou

A edição **Store** agora inclui o motor neural **IFRNet-S de fábrica**, com o checkpoint GoPro (MIT) embutido como `models/ifrnet.bin` (5.921.992 bytes, git blob `cae4a927…`, verificado por hash a cada carregamento). Fallback do IFRNet: **Analytic Flow**. A Personal mantém tudo: Framegen opcional (instalador com aceite de licença não-comercial) + IFRNet-S (agora também embutido) + Analytic Flow + Legacy LK.

Motivação: o Framegen é levemente superior, mas seus pesos têm termos não-comerciais e não podem ser distribuídos em loja. O IFRNet-S é MIT (repositórios do Kong et al. e do port ncnn do nihui), está congelado desde 2024 — ideal para pinar — e o usuário validou visualmente ser suficiente.

## Store: o que entra e o que não entra

- **Entra**: runtime IFRNet (`neural/model-spec.js`, `graph.js`, `runtime.js`, `client.js`), pesos `models/ifrnet.bin`, licenças MIT e model card, popup com a opção "IFRNet-S · built-in neural model", engine default `ifrnet`.
- **Não entra** (excluído de arquivo, não escondido): runtime e instalador do Framegen (`fi-neural*.js`, `neural-model.js`, `models.html/js/css`), background instalador, `third_party/framegen/`, qualquer permissão de rede. O `model-spec.js` da Store tem a URL de download removida na construção — nenhum endpoint de download existe no artefato.
- Sem download, sem permissão opcional, sem tela de aceite: o modelo simplesmente está lá.

## Rearquitetura dos marcadores

O código IFRNet do content.js saiu dos blocos `PERSONAL_ONLY` (agora é comum às edições); os blocos restantes são exclusivos do Framegen. Testes de fronteira (`test/packaging.py`) atualizados: Store precisa conter runtime+pesos IFRNet e continua proibida de conter qualquer coisa do Framegen.

## Testes

Suíte Node completa e `test/packaging.py` PASS (4/4 combinações navegador/edição, ZIPs byte-reproduzíveis). Validação em Chrome real: mesma pasta do repositório carregada via CDP, pesos acessíveis ao content script, engines prontas.

## Compilação

```sh
node test/run.cjs
python test/packaging.py
python tools/package.py --flavor all
```

`dist/video-enhancer-0.0.64-{store,personal}-{firefox,chromium}.zip` (~5,7 MB cada, pesos incluídos).

## Nota de licenciamento

MIT cobre o código e o checkpoint conforme distribuído pelos repositórios upstream; isso não é certificação independente sobre dados de treinamento. Os avisos completos seguem em `THIRD_PARTY_NOTICES.txt` e `neural/MODEL-CARD.md`, ambos incluídos na Store. O Framegen permanece exclusivo da Personal, com aceite explícito.
