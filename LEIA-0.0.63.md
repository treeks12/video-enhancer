# Video Enhancer 0.0.63: edição de loja e edição pessoal

## O que esta entrega resolve

O projeto agora produz dois tipos de pacote a partir da mesma fonte. A edição **Store** não depende dos modelos de interpolação anteriores. A edição **Personal** mantém **Framegen e IFRNet-S**, incluindo os respectivos runtimes e instaladores. Nenhum arquivo de pesos desses dois modelos é incorporado aos ZIPs.

O motor novo, **Analytic Flow**, não é uma rede neural treinada. É uma implementação de correspondência de movimento e reconstrução em WebGL2, sem checkpoint, professor, treinamento ou serviço externo. Ela é uma alternativa independente para testar e evoluir, não uma demonstração de qualidade equivalente à IA que o usuário aprovou.

**Estado: versão experimental, candidata à validação. Não é extensão aprovada, assinada ou publicada na loja. Não há benchmark na GPU do usuário.**

## Qual pacote usar

| Edição | Conteúdo | Uso pretendido |
|---|---|---|
| Store | Analytic Flow, LK anterior para comparação, RAVU, EASU e RCAS | Validar a edição independente dos modelos neurais antes de submeter à loja |
| Personal | Tudo da Store, mais Framegen e IFRNet-S opcionais | Uso pessoal e publicação da fonte completa no GitHub, respeitando os termos de cada modelo |

Os arquivos têm `store` ou `personal` no nome. O popup também exibe essa identificação junto da versão. Não instale/ative as duas edições simultaneamente na mesma página. O identificador do Firefox foi mantido para compatibilidade de atualização; as edições são alternativas, não extensões destinadas a operar juntas.

As duas entregas anteriores, ambas rotuladas 0.0.62, eram implementações distintas. Esta versão elimina essa ambiguidade no seletor:

- **Framegen · personal / noncommercial**: implementação WebGPU e pesos v7-small opcionais.
- **IFRNet-S · optional weights**: implementação WebGL2 e checkpoint GoPro small opcional.

Se a instalação anterior era a variante IFRNet e usava a chave genérica `neural`, selecione **IFRNet-S** explicitamente. A chave `neural` identifica Framegen nesta fonte unificada. Não é possível deduzir com segurança qual pacote 0.0.62 foi instalado apenas por esse nome de configuração.

## Instalação e primeira comparação

Desative a versão antiga, extraia o ZIP da edição e do navegador desejados e carregue a pasta como extensão de desenvolvimento. No Firefox, use o carregamento temporário em `about:debugging`; o ZIP não é um XPI assinado. No Chromium, use o modo de desenvolvedor e o carregamento sem compactação. Recarregue a página do vídeo.

Comece com **Original**, **Frame interpolation** habilitado e **Analytic Flow**. Use **Balanced** antes de **High quality**. “Original” significa ausência de upscale espacial, não desligamento da interpolação. Depois reative o upscale preferido.

Na edição pessoal, alterne Analytic Flow com o modelo que deu bom resultado. Os dois modelos opcionais (Framegen e IFRNet-S) agora se instalam na mesma página: botão **Model setup** no popup. Ela mostra explicitamente o estado de cada um ("Not installed" em destaque quando faltam os pesos), e o próprio popup avisa em vermelho quando o motor selecionado não tem modelo instalado, antes de qualquer fallback. Os dois downloads usam somente cdn.jsdelivr.net (o IFRNet-S vem do espelho GitHub da revisão pinada, bytes idênticos ao blob original). Confira **Motion method** e o aviso de fallback: selecionar uma IA não comprova que ela carregou. O botão **Save diagnostics** exporta um JSON local com método efetivo, tempos, cadência, resolução e suporte amostrado; não exporta frames e não envia o arquivo automaticamente.

O comparador 50/50 usa o anchor original atrasado à esquerda, não uma imagem original no mesmo instante inexistente da interpolação. Portanto ele é útil para comparação visual, mas não constitui ground truth temporal.

## Mudanças no motor independente

`fi-analytic.js` contém oito shaders. A estimação trabalha em pirâmide de até quatro níveis, com busca de hipóteses nos dois sentidos, custo fotométrico/estrutural/cromático, refinamento subpixel e propostas de vizinhos. Um filtro vetorial guiado trata outliers isolados sem fazer média indiscriminada entre movimentos opostos.

A consistência forward/backward é recalculada depois do filtro. A reconstrução usa inversão aproximada do fluxo, consulta guiada por bordas e uma máscara de visibilidade/apoio espacialmente filtrada. Regiões sem suporte recorrem a um endpoint original não deformado. Esse fallback é conservador, mas pode deixar movimento local menos fluido e ainda não resolve todos os casos de oclusão.

Os pixels, pirâmides, campos e frames gerados ficam no mesmo contexto WebGL2 do upscaler. A CPU recebe quatro números de diagnóstico após uma fence. As texturas e programas são reutilizados; as pirâmides dos dois endpoints ainda são recalculadas a cada par. Não alegamos reutilização temporal dessas pirâmides nesta versão.

| Perfil | Limite inicial do lado maior do campo | Rodadas por nível |
|---|---:|---:|
| Balanced | 320 pixels | 3 |
| High quality | 512 pixels | 5 |

Em 16:9, isso equivale aproximadamente a 320×180 e 512×288. O campo é denso nessa resolução, sem a célula 2×2 do LK WebGPU anterior. A composição lê o RGB original; o frame final não é simplesmente uma miniatura ampliada.

O controlador não acumula uma fila de pares. Descarta resultados antigos ou atrasados, reduz resolução após sobrecarga repetida e aplica uma pausa de três segundos se a sobrecarga persistir no menor nível. Reduzir a resolução é um compromisso de desempenho, não garantia de que todo hardware médio terá boa qualidade.

Continuam existindo as limitações do acesso ao vídeo, do relógio de apresentação e do buffer visual de um frame sem atraso equivalente do áudio. Não foram adicionados fan-out para 120/240 fps, bypass de DRM, código remoto ou processamento em nuvem.

## O que foi removido apenas dos pacotes Store

O empacotador usa uma lista explícita de arquivos. Exclui os dois runtimes neurais, seus carregadores/instaladores, a página de configuração de modelos, o background de instalação, permissões opcionais de rede, controles correspondentes e blocos pessoais do controlador. Valores antigos como `neural` ou `ifrnet` são normalizados para `analytic` na edição Store.

Não se trata de esconder botões com CSS. Os arquivos e caminhos de execução opcionais não estão no ZIP Store. Os mesmos arquivos continuam na fonte completa e no pacote Personal.

**A Store continua contendo a LUT treinada do RAVU**, com 59.904 bytes e os avisos/fontes LGPL correspondentes. Ela já fazia parte do upscaling. “Sem pesos neurais de interpolação” não significa “sem qualquer tabela binária ou parâmetro treinado em todo o projeto”. O novo interpolador não usa essa LUT.

## Licenças: distinções necessárias

Os pesos do Framegen consultados possuem termos de uso pessoal/pesquisa não comercial separados do código MIT. Manter a opção pessoal não remove esses termos. A distribuição de pesos, caso realizada separadamente, exige observar o aviso do autor; esta entrega não os redistribui.

Os repositórios de código IFRNet/port NCNN possuem avisos MIT. Isso não constitui, por si só, uma certificação independente de todos os direitos associados a cada checkpoint e aos dados de treinamento. Excluímos também essa dependência da Store por escolha conservadora de produto, sem afirmar que ela possui a mesma proibição expressa do Framegen.

Os arquivos novos do motor independente e do empacotamento são disponibilizados sob MIT, com escopo em `LICENSE-ANALYTIC.txt`. Isso não relicencia arquivos antigos nem componentes de terceiros. RAVU mantém seus avisos LGPL e FSR1 mantém seu aviso MIT.

Uma licença não comercial não é, sozinha, uma regra universal de rejeição por toda loja. Licenciamento, autorização para a distribuição pretendida e revisão da loja são assuntos distintos. O contrato da Mozilla exige direitos suficientes sobre conteúdo de terceiros e as políticas têm requisitos próprios de segurança, privacidade, código e desempenho. Esta entrega reduz a dependência específica apontada pelo usuário, mas não é parecer jurídico nem garantia de aprovação.

## Testes executados e limitações

Foi executada a suíte Node do projeto, acrescida de testes do grafo, ciclo de vida, isolamento do estado GL, erro/cancelamento, serial de par, deadline, controle de sobrecarga e limites entre edições. Inclui as regressões half de 63.488 padrões finitos e 100.000 entradas float32 contra o oráculo independente já presente.

Os **oito shaders realmente foram compilados e executados** em OpenGL ES/EGL com Mesa llvmpipe. O teste percorre oito cenas sintéticas em três fases: estática, pan, subpixel, pan rápido, oclusão, cruzamento, texto fixo e corte. A execução foi repetida com fonte 2× maior que o campo de movimento, totalizando 48 combinações de cena/fase, além de endpoints e saídas de diagnóstico. Isso é renderização por software, não teste em uma GPU física e não execução de WebGL dentro de Firefox/Chrome.

A interface dos ZIPs finais foi testada em Chromium 144 com APIs de extensão simuladas: seleção, identificação da edição, ausência/presença de instaladores, permissão negada, exportação local e estados de falha. Nenhum contexto WebGL2 ou WebGPU ficou disponível nesse navegador de teste. As capturas do popup usam métricas fictícias identificadas como fixture, não resultados de desempenho.

Os testes de empacotamento conferem sintaxe, manifests, ausência das dependências neurais na Store, normalização de preferências antigas e ZIPs reproduzíveis byte a byte. Os runtimes neurais preservados não receberam nova validação com checkpoints reais nesta sessão.

### Resultado visual limitado, não equivalência à IA

Nas cenas sintéticas de pan, pan rápido, oclusão e cruzamento, o candidato reduziu o erro absoluto médio frente a uma mistura simples dos endpoints. **Não foi comparado quantitativamente com Framegen, IFRNet ou o LK WebGPU anterior no hardware real.**

A primeira tentativa apresentou uma regressão subpixel importante, registrada no desenvolvimento. A inclusão de hipóteses de movimento pequeno reduziu esse problema. Ainda assim, na cena subpixel suave, a mistura simples mantém PSNR superior ao motor de movimento em parte dos testes. O teste final usa limites explícitos de erro e artefatos para essa cena, não uma alegação falsa de vitória sobre mistura em todas as situações.

Há artefatos residuais em bordas/oclusões e perda de movimento nas regiões de fallback. Resultados sintéticos não demonstram que mãos, cabelo, anime, partículas e vídeos comprimidos terão a mesma qualidade da rede aprovada pelo usuário.

Os logs e números completos estão em `test/results063/`. O arquivo `analytic-gpu.json` registra erros e fração de pixels com erro máximo de canal superior a 0,15. Essa definição não equivale à contagem perceptual de artefatos por um observador.

## Build reproduzível

Requer Python 3.10+ para empacotar, somente biblioteca padrão. O builder não acessa a rede e não lê pesos opcionais existentes em pastas locais.

```sh
python tools/package.py --flavor store
python tools/package.py --flavor personal
python tools/package.py --flavor all
```

No Windows:

```powershell
.\build.ps1 -Flavor store
.\build.ps1 -Flavor personal
```

O wrapper PowerShell foi escrito para delegar ao mesmo builder, mas não foi executado no Linux. O comando Python foi executado.

Testes:

```sh
node test/run.cjs
python test/packaging.py
python test/analytic-gpu.py
# Linux/macOS, repetição com fonte maior que o campo:
TEST_SOURCE_SCALE=2 python test/analytic-gpu.py
python test/ui-063.py
```

Os testes EGL exigem NumPy, Pillow e uma implementação EGL/GLES compatível; o teste de UI exige Playwright e Chromium. Esses requisitos são de desenvolvimento, não dependências da extensão instalada.

As instruções 0.0.62 e seus logs presentes na fonte são históricos. O antigo `tools/install-model.py` instala pesos para um checkout pessoal local; ele não faz o empacotador 0.0.63 incorporá-los aos ZIPs. Para os ZIPs Personal, use os instaladores explícitos da interface.

## Próximo critério de aceitação

Comparar Analytic Flow e a IA preservada, na mesma máquina e nos mesmos trechos problemáticos, registrando frames efetivamente apresentados e fallback. Sem isso, aumentar fluidez ou reduzir artefatos apenas deixando de interpolar não representa atingir o resultado desejado.

Para uma rede treinada substituta, o caminho independente exige um checkpoint com autorização adequada ao uso pretendido, ou treinamento com dados autorizados. Não foi treinada nem validada uma rede nova nesta sessão; trocar rótulo, quantizar ou destilar de pesos restritos não foi usado como atalho para declarar a cadeia de direitos resolvida.

Nenhum push, release remoto, envio à loja ou alteração da versão live foi feito.
