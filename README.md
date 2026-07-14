# Video Enhancer for Firefox

Extensão experimental que aplica FSR1 ou RAVU-lite + RCAS ao vídeo principal da página usando WebGL2. Inclui interpolação de frames clássica, opcional, para fontes próximas de 24/30 fps.

## Privacidade e permissões

- Não coleta nem transmite dados.
- Não usa telemetria, anúncios ou código remoto.
- A única permissão é `storage`, usada para salvar as preferências localmente.
- O processamento acontece no navegador e usa somente recursos empacotados na extensão.

## Build e validação

No PowerShell:

```powershell
node fi-core.js
node content.js
.\build.ps1
npx web-ext lint --source-dir dist\firefox
```

O build gera ZIPs separados em `dist/` para Firefox e Chromium. Os caminhos internos são normalizados com `/`, necessário para o Firefox resolver os recursos RAVU.

## Observações para revisão

RAVU-Lite-AR r3 foi portado do commit `3f24e7c53085854d122bb5d6629d1d503ba29e35` de `bjin/mpv-prescalers`. O hook-fonte, a LUT treinada, as licenças e a descrição das modificações locais estão incluídos em `third_party/ravu-lite/` e `THIRD_PARTY_NOTICES.txt`.

Não há minificação, transpilação, download de modelos ou etapa de geração necessária para revisar o código executado.

## Limites conhecidos

- A interpolação é experimental e adiciona um frame intermediário por par, no máximo 2x.
- Em qualidade 100%, RAVU é respeitado mesmo em downscale; os perfis econômicos podem usar o caminho direto + RCAS quando não há upscale.
- O modo padrão de uma instalação nova é desligado. Preferências de instalações existentes não são alteradas.

O código original deste repositório ainda não possui uma licença pública. As licenças dos componentes de terceiros continuam válidas e estão distribuídas com eles.
