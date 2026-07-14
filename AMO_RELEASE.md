# AMO release 0.0.51

## Listing

Default locale: `pt-BR`

Name: `Video Enhancer for Firefox`

Summary:

> Melhore vídeos com FSR1, RAVU-lite + RCAS e interpolação de quadros experimental, processados localmente em WebGL2.

Description:

> Video Enhancer for Firefox processa o vídeo principal da página localmente com WebGL2.
>
> Recursos:
>
> - FSR1 (EASU + RCAS) para upscale e nitidez;
> - RAVU-lite + RCAS para reconstrução adaptativa de detalhes;
> - interpolação de quadros experimental para fontes próximas de 24/30 fps;
> - perfis de qualidade e adaptação automática ao orçamento da GPU;
> - comparação visual e diagnóstico de desempenho.
>
> A extensão começa desligada e só processa o vídeo quando você escolhe um efeito. Todo o processamento ocorre no navegador. Nenhum dado é coletado ou transmitido.

Category: `Photos, Music & Videos`

License: `All Rights Reserved` for the original project code. Bundled third-party components retain their MIT/LGPL licenses.

Release notes:

> Primeira versão pública. Inclui FSR1, RAVU-lite, RCAS, interpolação de quadros experimental, adaptação ao orçamento da GPU e correções de cadência para reprodução sem stutter. RAVU permanece ativo em downscale no perfil 100% e é economizado nos perfis Auto/75%/50% quando não há upscale.

## Reviewer notes

The extension has no remote code, telemetry, advertising or data collection. Its only permission is `storage`, used for local preferences. The default mode is off.

To test:

1. Open a normal HTTP(S) page containing a video.
2. Open the extension popup and select Native, FSR1 or RAVU.
3. Optionally enable the experimental frame interpolation for a 24/30 fps source.
4. Open Advanced / Diagnostics to inspect the active pipeline and frame metrics.

RAVU-Lite-AR r3 provenance:

- upstream: `bjin/mpv-prescalers`;
- pinned commit: `3f24e7c53085854d122bb5d6629d1d503ba29e35`;
- original hook and licenses are bundled under `third_party/ravu-lite/`;
- `ravu-lite-webgl2.js` is the readable WebGL2 port used at runtime;
- local modifications and licensing are documented in `THIRD_PARTY_NOTICES.txt`;
- no minification or transpilation is used, and no separate source archive is required to inspect the shipped code.

The experimental RIFE/WebGPU prototype under `test/rife-webgpu/` is research-only and is not included in the extension package or executed at runtime.
