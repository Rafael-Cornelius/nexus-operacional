# Inventário integral da planilha operacional — 19/07/2026

Arquivo analisado: `Relatórios -MAIO-JUNHO 2026.xlsx`
Tamanho: 1.084.386 bytes
SHA-256: `7ba9e6c1a14091033fcf22a74c1b9d208da0719b27f0125d035e17b1a3f1f5fb`

## Escopo, método e limites

- A inspeção percorreu diretamente o pacote OOXML: workbook, worksheets, shared strings, estilos, relações, tabelas, drawings, gráficos, comentários, nomes definidos, filtros, células mescladas, validações, linhas/colunas ocultas e fórmulas.
- O resultado do OOXML foi conferido com `scripts/import_excel.py`, sem modificar o arquivo original.
- A planilha não foi recalculada. Valores armazenados no cache do XLSX podem estar antigos; fórmula e valor em cache são tratados como evidências distintas.
- Não havia LibreOffice/Excel nem sessão de planilha conectada para renderizar visualmente as 26 abas. A inspeção de layout ficou limitada aos elementos estruturais do OOXML: dimensões, estilos, mesclas, formatação condicional, drawings e gráficos.
- As datas usam o sistema padrão 1900 do Excel. Seriais foram convertidos somente quando o tipo e o contexto permitiam; texto inválido continuou texto.
- “Entrada manual” abaixo significa constante ou seletor encontrado no XLSX. Não significa que o valor esteja correto ou aprovado.
- Todas as 16.980 fórmulas foram contadas e examinadas lexicalmente para referências, famílias de função e `#REF!`. O documento traz famílias e exemplos auditáveis, não uma transcrição de 16.980 linhas.

## Censo estrutural

| Item | Evidência OOXML |
| --- | ---: |
| Abas | 26, todas visíveis |
| Células com fórmula | 16.980 |
| Tabelas estruturadas | 25 |
| Gráficos | 86 |
| Valores em cache iguais a `#REF!` | 1.454 |
| Fórmulas cujo texto contém `#REF!` | 1.609 |
| Nomes definidos | 118 |
| Nomes definidos ocultos | 103 |
| Nomes definidos contendo `#REF!` | 30 |
| Nomes definidos apontando para a antiga aba inexistente `BHN Mensal` | 37 |
| Validações de dados | 14 regras em 9 abas |
| Blocos de formatação condicional | 111 em 4 abas |
| Partes de comentários | 4, com 11 comentários |
| Abas ocultas | 0 |
| Colunas ocultas | 0 |
| Linhas ocultas | 4, todas em `GRAF. PERD-SOBRE.` |
| VBA/macros, pivôs e conexões | nenhum artefato encontrado |
| Relações externas ausentes | 5 relações `xlPathMissing` para `Relatórios -MAIO 2026.xlsx` em P1, P2 e `Pacotes-caixas` |

Funções mais recorrentes, por ocorrências internas às fórmulas: `IFERROR` 11.419, `IF` 8.755, `INDEX` 2.987, `OR` 2.507, `ISNUMBER` 2.298, `EOMONTH` 1.960, `SUMIFS` 1.817, `ROW` 1.515, `VLOOKUP` 1.500, `LET` 1.405, `DATEVALUE` 1.370 e `EDATE` 1.362. Uma fórmula pode conter várias funções; por isso essa soma excede 16.980.

## Inventário funcional obrigatório

| # | Aba | Finalidade operacional | Entrada manual encontrada | Cálculo derivado | Histórico | Dashboard | Relatório | Entidades relacionadas |
| ---: | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `Dashboards` | Controle do período e visão executiva consolidada | Ano, mês, semana e seletor numérico de máquina (`C59`) | Produção, perdas, sobrepeso, rendimento, custos, paradas, rankings e status | Não; apenas consulta | Sim | Sim | semana, setor, produção, perda, parada, produto, preço, meta |
| 2 | `graficos diarios ` | Recorte diário de produção, perdas, sobrepeso e rendimento | Data em `E6` | Filtros e agregações diárias | Não | Sim | Sim | semana, data, produto, produção, perda, sobrepeso |
| 3 | `plan real` | Bases e gráficos de planejado × realizado diário, semanal e mensal | Dia da semana em `C4` | Plano/real por produto e P1/P2 | Não | Sim | Sim | semana, produto, OP, produção |
| 4 | `Plan x Real (P1)` | Fonte primária de produção P1 e cálculos técnicos/financeiros | semana, data, produto, OP, plano, realizado, reforma usada, caixas, perda de pesagem, reforma gerada, peso médio, observação | kg produzido, rendimento esperado/real, pesos por cadastro, sobrepeso e custos | Parcial; blocos sucessivos de maio, junho e julho na mesma aba | Não | Base de relatórios | semana, produto, OP, produção, reprocesso, peso, sobrepeso, preço, custo |
| 5 | `Plan x Real (P2)` | Fonte primária de produção P2 e cálculos técnicos/financeiros | semana, data, produto, OP, plano, realizado, caixas, perdas, reforma gerada, peso médio, observação | kg produzido, rendimento, pesos, sobrepeso e custos | Parcial; blocos sucessivos de períodos | Não | Base de relatórios | semana, produto, OP, produção, peso, sobrepeso, preço, custo |
| 6 | `CONTROLE DE PERDAS` | Fonte primária de perdas de filme e caixa por máquina/turno; análise financeira de embalagem | data, máquina, filme T1/T2, caixa T1/T2, caixas feitas/vendidas e alguns parâmetros | totais de filme/caixa, consumo, valor aproveitado, prejuízo e análise semanal | Sim, por linha datada | Parcial | Sim | perda, unidade, turno, equipamento, produto, preço de filme, custo |
| 7 | `dados do controle de perdas ` | Espelho/base auxiliar do controle de perdas e parâmetros editáveis | preços/gramaturas em área marcada “EDITÁVEL” | cópia, subtotal, consumo e resultado financeiro | Não | Não | Base auxiliar | produto, embalagem, configuração de filme, preço, perda |
| 8 | `relatorios de paradas` | Fonte primária de paradas | data, início/fim da produção, início/fim da parada, motivo, “setor” legado e semana | semana, contagens, tempo total e blocos filtrados por máquina | Sim, por registro | Parcial | Sim | semana, parada, motivo, linha/equipamento, tempo produtivo |
| 9 | `PARADAS` | Consolidação executiva das paradas | Nenhuma entrada operacional confiável; período vem do dashboard | Pareto, ocorrências, tempo, disponibilidade, percentual e criticidade | Não | Sim | Sim | parada, motivo, equipamento, semana, produtividade |
| 10 | `paradas m1` | Visão diária detalhada de paradas atribuídas a M1 | Nenhuma fonte primária; campos exibidos são puxados | intervalos, tempo, percentual, kg/h real e “pingando” | Não | Sim | Sim | equipamento M1, parada, produtividade |
| 11 | `paradas mq` | Visão diária detalhada de paradas atribuídas a MQ | Nenhuma fonte primária | intervalos, tempo, percentual, kg/h real e “pingando” | Não | Sim | Sim | equipamento MQ, parada, produtividade |
| 12 | `paradas giro freezer ` | Visão diária detalhada do giro/freezer | Nenhuma fonte primária | intervalos, tempo, percentual, kg/h real e “pingando” | Não | Sim | Sim | equipamento giro/freezer, parada, produtividade |
| 13 | `Perdas - dosagem` | Grade de 60 pesagens amostrais sem identificação operacional | pesos `B11:D30` | duas médias (`M8` e `H31`) | Não identificável | Não | Não | dosagem/pesagem; produto, data, OP, semana e operador ausentes |
| 14 | `resumo` | Resumo geral executivo/financeiro | Nenhuma entrada operacional; período vem do dashboard | KPIs, custos, paradas e perdas de embalagem | Não | Sim | Sim | produção, perda, sobrepeso, parada, custo |
| 15 | `Banco de Dados Pesagen` | Cadastro técnico de pesos por produto | produto, peso da massa, peso da caixa, peso do pacote | Nenhum | Cadastro vigente, sem versão temporal | Não | Não | produto, configuração de peso |
| 16 | `GRAF. PRODUTIVIDADE` | Painel mensal/semanal de produtividade | Seletores de semana/mês têm validação, mas atualmente recebem fórmulas do dashboard | produção, rendimento, dias, kg/dia, distribuição | Não | Sim | Sim | produtividade, produção, semana, meta |
| 17 | `GRAF. PERD-SOBRE.` | Painel consolidado de perdas e sobrepeso P1/P2 | seletores de semana/mês; rankings são derivados | totais, percentuais, rendimento, evolução, top 5 | Não | Sim | Sim | produção, perda, sobrepeso, produto, meta |
| 18 | `BANCO DE DADOS SOBRE.` | Base calculada de produção/perdas/sobrepeso para gráficos | seletores de navegação; dados operacionais vêm de fórmulas | extração mensal P1/P2, agregações e indicadores | Não; cache calculado, não fonte histórica | Sim | Base auxiliar | produção, perda, sobrepeso, semana, produto |
| 19 | `Pacotes-caixas` | Cadastro primário de produtos e embalagem | código, produto, peso de pacote/caixa, pacotes por caixa, peso da massa | Nenhum | Cadastro vigente, sem versão temporal | Não | Não | produto, embalagem, configuração de peso |
| 20 | `BANCO DE DADOS PRODV.` | Base calculada de produtividade mensal | seletores de navegação; dados vêm das fontes | produção, rendimento, dias, médias e comparação P1/P2 | Não | Sim | Base auxiliar | produtividade, produção, perda, parada, sobrepeso |
| 21 | `ARQUIVO MORTO` | Histórico legado e painéis históricos | tabelas congeladas de P1, P2, paradas e perdas; seletor de semana | grande área antiga por fórmulas e duas consolidações gráficas | Sim | Sim | Sim | snapshot, versão, produção, perda, parada, semana, hash de origem |
| 22 | `LISTAS_CONTROLE` | Listas de mês/semana/ano/origem e metadados da automação antiga | listas e estado da “semana aberta” | Nenhum | Metadado de automação, não histórico operacional | Não | Não | configuração, semana; texto de VBA não representa uma entidade operacional |
| 23 | `PARADAS_HISTORICO` | Estrutura reservada para histórico célula a célula das paradas | Nenhum registro material além do cabeçalho | seletores ligados ao dashboard | Estrutura vazia | Não | Base auxiliar | histórico de parada, linhagem de célula |
| 24 | `DASHBOARD_HISTORICO` | Resumo do histórico de paradas por origem | Nenhuma | `COUNTIFS` sobre `PARADAS_HISTORICO` | Sim, derivado | Sim | Sim | histórico de parada, semana |
| 25 | `Tabela Preços` | Referência de produtos, preço médio/vendas e lookup de preço por kg | duas áreas de constantes; tabela `CÓD`, descrição, preço/kg | apenas resumos de custo em linhas finais | Cadastro vigente, sem vigência explícita | Não | Base financeira | produto, preço, custo |
| 26 | `GRÁFICOS DE PERDAS` | Relatório visual das perdas e resultado de filme | Nenhuma | vínculos diretos ao controle de perdas | Não | Sim | Sim | perda, equipamento, produto, custo de embalagem |

## Evidência técnica por aba

Legenda: `F` = fórmulas; `T` = tabelas; `G` = gráficos; `M` = mesclas; `V` = regras de validação; `FC` = blocos de formatação condicional.

1. **`Dashboards`** — dimensão `A2:BH285`; F=1.288, T=0, G=21, M=71, V=1, FC=2. Referencia principalmente P2, P1, `BANCO DE DADOS SOBRE.`, `relatorios de paradas`, `Tabela Preços`, `PARADAS` e `CONTROLE DE PERDAS`. Gráficos abrangem produção diária/mensal/semanal, rendimento, P1×P2, perdas, sobrepeso, paradas, eficiência e custos. `Q67:Q71` contém cinco fórmulas com referências quebradas para `paradas m1`, mascaradas por `IFERROR`.
2. **`graficos diarios `** — `D1:O32`; F=76, G=2, V=1, FC=7. Validação de data em `E6` usa `$L$2:$L$32`. Gráficos: perdas/sobrepeso e rendimento do dia. Há seis valores `#REF!` em `D30:F31`; `E30` e `E31` têm fórmula literal `#REF!`.
3. **`plan real`** — `B2:O86`; F=288, G=8, V=1. Validação de `C4` lista os sete dias. Usa `INDEX`, `COUNTIFS`, `SUMIFS` e referências a P1, P2 e dashboard. Não contém erro em cache.
4. **`Plan x Real (P1)`** — `A1:AZ341`; F=4.295, T=4, M=5, FC=96. Tabelas: resumo `AF2:AW4` vazio e três blocos operacionais `B2:Z109`, `B112:Z225`, `B229:AA341`. Fórmulas-base: `J=I*P`, `M=G*O`, `N=(J*100)/M`, lookup de peso em `Tabela1`, lookup de preço em `Tabela Preços`, custos por kg. Duas relações externas ausentes apontam para arquivo anterior de maio. Sem `#REF!` em cache, mas 36 linhas foram colocadas fora do período maio–junho e uma linha tem campos mínimos incompletos no parser seguro.
5. **`Plan x Real (P2)`** — `A1:AW120`; F=1.079, T=4, M=2. Tabelas: resumo vazio e blocos `B2:Y36`, `B40:U78`, `B82:U120`. Fórmulas-base: `I=H*O`, `L=G*N`, `M=I/L`, lookup de pesos/preços e custos. Duas relações externas ausentes. Evidências que exigem revisão: `C3=46117` (05/04/2026), `C11=46331` (05/11/2026), `C56` contém texto `17/06/20226`, e `F54=23478` parece OP em coluna de planejado. Seis linhas ficam fora do período e `F54` fica em quarentena.
6. **`CONTROLE DE PERDAS`** — `B2:AI99`; F=383, T=1 (`tbl_Perdas`, `B2:I97`), V=2, comentários=4. Em 93 linhas de dados, `B/C/E/F/H/I` são constantes; `D=E+F` e `G=H+I`. As validações estão em `E1`, `E97:E159`, `C1` e `C97:C159`, não no corpo principal já preenchido. Não há gráficos nesta aba; eles foram movidos para `GRÁFICOS DE PERDAS`. O parser atual lê data, máquina e total de filme `D`, mas não importa T1/T2 nem caixa/unidade `G:I`.
7. **`dados do controle de perdas `** — `C4:Z61`; F=860, sem tabelas/gráficos/validações, comentários=4. Quase toda a aba replica `CONTROLE DE PERDAS`; existe área editável de preço/gramatura. Deve virar consulta/configuração, não segunda fonte de verdade.
8. **`relatorios de paradas`** — `A2:AY1443`; F=196, T=0, G=0, M=1, V=2. As validações abrangem `F1:F1048576` (motivos `AQ5:AQ36`) e `B1:E1048576` (horários em `AY:AY`). Existem 657 datas preenchidas, mas somente 360 linhas têm todos os campos exigidos pelo parser; linhas incompletas hoje não formam registro importável. Entre as linhas completas, 120 ficam fora de maio–junho. O campo chamado “Setor” contém `paradas giro freezer`, `paradas mq` e `paradas m1`, indicando semântica de linha/equipamento a validar.
9. **`PARADAS`** — `B2:AJ125`; F=167, G=6, M=6. Gráficos: semana por dia, parado×disponível, top motivos, setores, Pareto e total semanal. É cálculo/relatório; não deve ser importado como lançamentos adicionais.
10. **`paradas m1`** — `A1:M238`; F=601, G=8. Usa `FILTER`/`INDEX` sobre `relatorios de paradas`, separado por dia. Sem erro em cache.
11. **`paradas mq`** — `A1:M235`; F=591, G=6. Mesmo padrão derivado de M1, filtrando `paradas mq`. Sem erro em cache.
12. **`paradas giro freezer `** — `A1:M235`; F=598, G=5. `D102:D103` contém dois valores e fórmulas com `#REF!`; esses cálculos de kg/h não são certificáveis.
13. **`Perdas - dosagem`** — `A8:M31`; F=2, sem tabela, gráfico, validação, rótulo ou contexto. Há exatamente 60 constantes em `B11:D30`. `M8=AVERAGE(B:D)` e `H31=AVERAGE(B11:M30)`, ambos com cache `406,35`. Produto, OP, data, horário, semana, setor, equipamento, turno e operador não existem; as amostras devem ficar em revisão humana, nunca vinculadas por presunção.
14. **`resumo`** — `B2:L60`; F=247, M=7. Agrega dashboard, P1/P2, paradas, perdas e preços. É relatório reconstruível.
15. **`Banco de Dados Pesagen`** — `A7:G50`; F=0, T=1 (`Tabela1`, `D7:G50`), comentários=2. O parser encontra códigos duplicados `70974`, `73735`, `76379`, `76678`. Comentários em `G43` e `G47` registram ausência de referência confiável para peso de caixa dos produtos `76315` e `205`.
16. **`GRAF. PRODUTIVIDADE`** — `A2:Z58`; F=243, G=4, M=3, V=2. Validações em `K5` e `M5`; ambos recebem referências do dashboard. Exibe metas fixas em texto/células (`>10.000`, `>95%`, `>5.000`), que são requisitos legados a validar, não limites autorizados para hardcode.
17. **`GRAF. PERD-SOBRE.`** — `A2:AQ94`; F=1.094, T=6, G=9, M=32, V=2, FC=6. `AN14:AN18` contém cinco fórmulas `IFERROR(#REF!*24,0)`, portanto exibe zero para referência inexistente. Linhas ocultas 68, 69, 72 e 74 repetem exatamente o índice 8 de `BANCO DE DADOS SOBRE.`; são auxiliares duplicados, não dados independentes. Também contém metas fixas em texto (`<50`, `<100`, `<2%`, `>95%`).
18. **`BANCO DE DADOS SOBRE.`** — `B1:AA181`; F=1.316, T=2, G=5, M=13, V=2. As 150 linhas das tabelas P1/P2 são inteiramente calculadas com `LET`, `EOMONTH`, `EDATE`, `INDEX` e `DATEVALUE` a partir de P1/P2 e seletores do dashboard. Não é fonte histórica independente.
19. **`Pacotes-caixas`** — `A1:F74`; F=0, filtro `A1:E1`, sem tabela OOXML. É fonte manual de produtos. Uma relação externa ausente aponta para arquivo anterior de maio. O parser une esta aba à pesagem e produz 87 produtos normalizados, mas registra 54 ausências de pacotes/caixa e 35 ausências de peso de caixa.
20. **`BANCO DE DADOS PRODV.`** — `B2:W99`; F=575, G=2, M=4, V=2. Deriva P1/P2, dashboard, banco de sobrepeso e controle de perdas. É cache analítico reconstruível, não entidade operacional.
21. **`ARQUIVO MORTO`** — `A2:DI297`; F=2.942, T=5, G=2, M=20, V=1. Contém 1.446 valores `#REF!` e 1.595 fórmulas com `#REF!`. Área antiga por fórmulas está quebrada, mas quatro tabelas congeladas possuem conteúdo útil: P1 com 67 registros, P2 com 13, paradas com 59 e perdas com 26; `tbl_Log_Salvamentos` está vazio. Há escala percentual inconsistente: P1 `V231=99,842181...` enquanto P2 `BC232=0,666666...`; não converter sem regra por origem. As tabelas congeladas, IDs, chaves, versões, linha de origem, hash e valores originais devem ser preservados.
22. **`LISTAS_CONTROLE`** — `A1:K13`; F=0. Lista meses, semanas, anos, origens e estado da automação. Comentário em `K2` e texto em `K9` citam automação VBA, mas o pacote não contém VBA; portanto a troca automática de semana não existe neste `.xlsx`.
23. **`PARADAS_HISTORICO`** — `A1:J4`; F=3, T=1 declarada como `A4:J826`. A tabela possui só cabeçalho; não há linhas históricas materializadas. Não confundir capacidade reservada com 822 registros.
24. **`DASHBOARD_HISTORICO`** — `A1:F9`; F=15. Usa `COUNTIFS` contra a tabela vazia de `PARADAS_HISTORICO`; é relatório derivado, sem histórico próprio.
25. **`Tabela Preços`** — `A1:M138`; F=9, T=1 (`tbl_Precos`, `J3:L57`). A tabela de lookup tem 54 produtos/preços; não há colunas de vigência, moeda, responsável, aprovador ou origem. As fórmulas finais agregam custos de P1/P2. O importador atual não lê diretamente `tbl_Precos`; encontra preço nos lançamentos de produção quando disponível.
26. **`GRÁFICOS DE PERDAS`** — `A1:Q107`; F=112, G=8, M=2. Todos os auxiliares apontam para `CONTROLE DE PERDAS`. Gráficos: filme/caixa por máquina ou produto, custos, perdas diárias/semanais e filme aproveitado. É relatório reconstruível.

## Validações encontradas

| Aba | Célula/intervalo | Regra |
| --- | --- | --- |
| `Dashboards` | `C59` | inteiro entre 1 e 3 |
| `graficos diarios ` | `E6` | lista `$L$2:$L$32` |
| `plan real` | `C4` | sete dias da semana |
| `CONTROLE DE PERDAS` | `E1 E97:E159` | `Embalagem,Caixa,Orgânico,Outros` |
| `CONTROLE DE PERDAS` | `C1 C97:C159` | `1,2,3,4,5` |
| `relatorios de paradas` | `F1:F1048576` | lista de motivos `AQ5:AQ36` |
| `relatorios de paradas` | `B1:E1048576` | lista de horários `AY:AY` |
| `GRAF. PRODUTIVIDADE` | `K5`; `M5` | semana 1–5; mês |
| `GRAF. PERD-SOBRE.` | `C87 C89 AC6`; `AG6` | semana 1–5; mês |
| `BANCO DE DADOS SOBRE.` | `C177 T6`; `X6` | semana 1–5; mês |
| `BANCO DE DADOS PRODV.` | `T5`; `V5 W5` | semana 1–5; mês |
| `ARQUIVO MORTO` | `I6` | semana 1–10 |

## Fluxo real entre abas

1. `Pacotes-caixas`, `Banco de Dados Pesagen` e `Tabela Preços` fornecem cadastros técnicos e financeiros.
2. `Plan x Real (P1)`, `Plan x Real (P2)`, `CONTROLE DE PERDAS` e `relatorios de paradas` contêm as fontes operacionais primárias identificáveis.
3. `dados do controle de perdas `, `plan real`, `PARADAS`, as três abas de máquina, `BANCO DE DADOS SOBRE.` e `BANCO DE DADOS PRODV.` transformam ou replicam essas fontes.
4. `Dashboards`, `graficos diarios `, `GRAF. PRODUTIVIDADE`, `GRAF. PERD-SOBRE.`, `resumo`, `DASHBOARD_HISTORICO` e `GRÁFICOS DE PERDAS` apresentam os resultados.
5. `ARQUIVO MORTO` contém mistura de fórmulas quebradas com quatro tabelas históricas materializadas; só as tabelas materializadas e sua linhagem são fontes preserváveis.
6. `Perdas - dosagem` é fonte manual órfã. Sem contexto, não pode alimentar tabela oficial.

Há dependências bidirecionais entre `Dashboards` e bases calculadas. Isso não prova circularidade célula a célula, mas impede copiar a arquitetura de fórmulas para o aplicativo. No Nexus, seletores devem virar filtros e os indicadores devem ser calculados sobre uma única fonte persistida.

## Dados a persistir, calcular ou não promover

### Persistir após validação

- produtos, códigos como texto, pesos e configurações de embalagem;
- preços por produto, após definir vigência e origem;
- P1/P2 por semana, data, produto e OP;
- perdas preservando filme em kg, caixa em unidades e divisão T1/T2;
- paradas preservando valores brutos, motivo original e mapeamento revisado de equipamento/linha;
- quatro tabelas materializadas do `ARQUIVO MORTO`, com ID, chave, versão, linha de origem e hash;
- amostras de dosagem somente após identificação humana de produto, período e contexto.

### Calcular no backend

- totais produzidos, atingimento, rendimento, sobrepeso, custos e produtividade;
- resumos por período, Paretos, rankings e comparações;
- todos os conteúdos das abas de gráficos, dashboards e bases auxiliares.

### Preservar como evidência, mas nunca promover como valor oficial

- fórmulas/valores com `#REF!`;
- nomes definidos quebrados e relações externas ausentes;
- linhas auxiliares ocultas/duplicadas;
- células mescladas, textos instrucionais e caches de gráficos;
- metadados de automação VBA, pois não há VBA no arquivo;
- tabelas-reserva vazias e totais/subtotais misturados aos registros.

## Inconsistências classificadas pelo parser vigente

| Grupo | Quantidade | Evidência |
| --- | ---: | --- |
| Produtos/configurações | 127 | 54 sem pacotes/caixa, 35 sem peso de caixa, 34 sem peso alvo, 4 códigos de pesagem duplicados |
| Operacionais | 189 | 120 paradas, 36 P1, 25 perdas e 6 P2 fora do período; 1 planejado semelhante a OP; 1 produção incompleta |
| Registros elegíveis após quarentena | 469 | 161 produções, 68 perdas e 240 paradas |

“Elegível” significa somente que o parser não aplicou uma regra de quarentena já existente. Não significa correto, aprovado ou conciliado.

## Regras ambíguas que exigem decisão humana

1. Em P1, o Excel usa `Rendimento esperado = Realizado × Peso da massa`; o backend vigente soma também `Reforma utilizada`. Exemplo: OP `23334`, `G7=5`, `H7=325`, `O7=491,7`, `M7=2.458,5`, `J7=2.424`, `N7=98,5967`. Somar a reforma mudaria o rendimento para aproximadamente `87,0846%`. Nenhuma versão deve ser declarada correta sem validação operacional.
2. P1 grava rendimento em escala 0–100; P2 grava predominantemente 0–1. Há 48 resultados calculados P1 acima de 100% e 13 P2 acima de 1. Limitar silenciosamente a 100% destrói a evidência da anomalia.
3. O “Setor” de paradas parece nome de máquina/linha. Não é evidência suficiente para classificar todas as paradas como P1.
4. Perda de caixa usa unidade, enquanto perda de filme usa kg. Somar ambas em `quantityKg` é semanticamente incorreto.
5. As 60 amostras de `Perdas - dosagem` não têm chave operacional. Qualquer vínculo automático seria invenção.
6. `Tabela Preços` não contém vigência. Aplicar os valores retroativamente a todo histórico exige decisão registrada.

## Conclusão da Fase 0

As 26 abas estão catalogadas, mas a planilha não é certificável como fonte única. Ela contém fontes primárias aproveitáveis, cálculos reconstruíveis, histórico materializado útil e artefatos quebrados que precisam permanecer em quarentena. Próximo passo seguro: usar a matriz Excel × aplicativo, resolver prioridades P0 e reconciliar por domínio antes de promover qualquer lote.
