# Video Enhancer for Firefox

## Para que serve

Melhora o vídeo principal da página localmente com WebGL2:

- FSR1 (EASU + RCAS) para upscale e nitidez;
- RAVU-lite + RCAS para reconstrução adaptativa;
- interpolação de quadros experimental para vídeos próximos de 24/30 fps.

Não há telemetria ou coleta de dados. A única permissão é `storage`, usada para salvar as preferências.

## Como usar

1. Baixe o ZIP para Firefox na página [Releases](https://github.com/treeks12/video-enhancer/releases).
2. Enquanto a versão da AMO não estiver assinada, abra `about:debugging#/runtime/this-firefox`, clique em **Carregar extensão temporária** e selecione o ZIP.
3. Abra uma página com vídeo, clique no ícone da extensão e escolha Nativo, FSR1 ou RAVU.
4. Ative a interpolação somente se quiser testar 2x em fontes próximas de 24/30 fps.

## Bugs conhecidos

- A interpolação pode produzir ghosting ou distorções em oclusões, movimentos extremos e cortes de cena.
- Vídeos protegidos por DRM ou bloqueados por CORS podem não aceitar processamento.
- Apenas o vídeo principal do documento superior é processado; vídeos dentro de iframes não são suportados.
- RAVU e interpolação podem ser reduzidos ou cancelados quando não cabem no orçamento da GPU.
