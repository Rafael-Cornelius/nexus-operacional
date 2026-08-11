# Matriz planilha × Nexus Operacional — 19/07/2026

## Escopo e critério de leitura

Esta matriz compara a planilha `Relatórios -MAIO-JUNHO 2026.xlsx` com o banco, API e frontend existentes no commit-base `5287d13`. O inventário integral da fonte está em `docs/excel-sheet-inventory-2026-07-19.md`.

O worktree estava recebendo alterações concorrentes durante a auditoria, inclusive uma migration e serviços de staging. Essas mudanças não foram contadas como cobertura concluída: ainda não pertencem ao commit-base, não foram homologadas aqui e podem mudar. Quando relevantes, aparecem como **WIP não validado**.

Esta é uma análise de capacidade do código, não uma reconciliação do banco em execução. Não foi obtida uma extração certificada do PostgreSQL; por isso, existência de model, rota ou tela não prova que os registros da planilha foram importados ou que os totais coincidem.

### Legenda

| Estado | Significado |
| --- | --- |
| **Parcial** | Existe parte da cadeia, mas falta pelo menos uma camada obrigatória, regra, validação, auditoria, teste ou reconciliação. |
| **Derivável** | O aplicativo possui dados capazes de reconstruir o resultado; equivalência numérica ainda não foi provada. |
| **Ausente** | Não foi encontrada implementação suficiente no commit-base. |
| **Quarentena** | O dado existe no Excel, mas não pode virar registro oficial sem revisão humana. |
| **WIP não validado** | Há mudança local em andamento; não conta como concluída. |

Prioridades: **P0** bloqueia importação ou confiabilidade operacional; **P1** é alta e necessária antes de substituir o Excel; **P2** fecha equivalência funcional e usabilidade; **P3** é evolução posterior.

## Cobertura das 26 abas

| # | Aba e papel no Excel | Banco/Prisma no commit-base | API no commit-base | Frontend/relatório no commit-base | Importação e reconciliação | Diagnóstico |
| ---: | --- | --- | --- | --- | --- | --- |
| 1 | `Dashboards`: KPIs executivos | `ProductionEntry`, `LossEntry`, `DowntimeEntry`, `Goal`, `DashboardSnapshot` e preços oferecem fontes normalizadas | `/dashboard/kpis`, `/dashboard/charts`, `/dashboard/comparison`, `/dashboard/alerts` | `app/dashboard` e apresentação executiva existem | Não há prova de equivalência indicador a indicador nem linhagem visível até os lançamentos | **Parcial · P1**: operacional, mas faltam reconciliação, drill-down, regra/atualização da métrica e tratamento integral dos erros legados |
| 2 | `graficos diarios `: recorte por dia | As fontes operacionais existem | Endpoints de dashboard agregam dados; não foi encontrado equivalente dedicado certificado para esta aba | Há gráficos no dashboard, mas não paridade demonstrada para `E6` e seus indicadores | Seis caches `#REF!`; nenhum deve ser usado como zero | **Derivável · P2**: reconstruir no backend e testar por data |
| 3 | `plan real`: planejado × realizado | `ProductionEntry.plannedBatches` e `realizedBatches` representam a base | CRUD e consultas de produção existem | Páginas P1/P2 mostram produção; não há relatório de paridade diária/semanal/mensal provado | Produção é lida pelo importador, sem certificação por agregado | **Parcial · P1** |
| 4 | `Plan x Real (P1)`: fonte primária P1 | `ProductionEntry`, `ProductionOrder`, configuração de peso, preço, workflow e versionamento cobrem muitos campos | CRUD, preview, duplicar, excluir/restaurar e aprovar/rejeitar existem | Formulário e lista P1 existem | Parser emite 138 candidatos P1, mas há 37 inconsistências; regra de rendimento diverge do Excel e as inconsistências calculadas não impedem `status: "OK"` no importador-base | **Parcial · P0** |
| 5 | `Plan x Real (P2)`: fonte primária P2 | Mesma estrutura de produção, com setor P2 | Mesmas rotas de produção | Formulário e lista P2 existem | Parser emite 23 candidatos P2 e 7 inconsistências; datas e valor semelhante a OP exigem revisão; escala de rendimento precisa ser normalizada explicitamente | **Parcial · P0** |
| 6 | `CONTROLE DE PERDAS`: filme e caixa por turno | `LossEntry` guarda `quantityKg` e alguns campos financeiros, mas não preserva corretamente filme em kg, caixas em unidades e T1/T2 como dimensões separadas | CRUD, tipos, resumo e workflow existem | Formulário/lista de perdas existem | Importador-base lê somente data, máquina e total de filme; ignora E/F e G:I como granularidade e unidade | **Parcial · P0**: modelo/importador perdem semântica |
| 7 | `dados do controle de perdas `: espelho e parâmetros | Parte cabe em produto, configuração e perda; não há versão completa dos parâmetros financeiros da aba | Produtos/preços e perdas possuem rotas separadas | Consultas correspondentes existem, sem tela específica necessária | Não deve ser segunda fonte; seus parâmetros precisam de mapeamento com vigência | **Parcial · P1** |
| 8 | `relatorios de paradas`: fonte primária de paradas | `DowntimeEntry`, `DowntimeReason`, linha, equipamento, turno, workflow e versionamento existem | CRUD, motivos, resumo e workflow existem | Formulário/lista de paradas existem | Há 657 datas, apenas 360 linhas completas e 240 candidatas do período; importador-base fixa P1, trata o campo legado como linha e grava `producedMassKg: 0` | **Parcial · P0**: linhas incompletas, setor/equipamento e produtividade não podem ser presumidos |
| 9 | `PARADAS`: consolidação e Pareto | Dados normalizados de paradas permitem derivar parte dos resultados | `/downtime/summary` e dashboard oferecem agregados | Página de paradas e dashboard existem | Não há comparação certificada de Pareto, disponibilidade e criticidade | **Derivável · P2** |
| 10 | `paradas m1`: visão de equipamento | `Equipment` + `DowntimeEntry` suportam filtro | Equipamentos e paradas possuem rotas | Páginas de equipamentos/paradas existem | Nome legado precisa ser mapeado para ID controlado; não há reconciliação por equipamento | **Parcial · P1** |
| 11 | `paradas mq`: visão de equipamento | Mesmo suporte estrutural de M1 | Mesmo suporte de API | Mesmo suporte de interface | Mesmo risco de mapeamento legado | **Parcial · P1** |
| 12 | `paradas giro freezer `: visão de equipamento | Equipamento e parada existem, mas “giro/freezer” precisa de decisão cadastral | Rotas existem | Páginas existem | Duas fórmulas de kg/h têm `#REF!`; resultados não são certificáveis | **Quarentena/Parcial · P1** |
| 13 | `Perdas - dosagem`: 60 amostras órfãs | `DosageCheck` exige semana, produto, setor, data e pesos amostrais, o que é estruturalmente adequado | GET/POST de dosagem existem | Cadastro e lista de dosagem existem | Nenhum importador de dosagem; Excel não informa produto, OP, data, equipamento, turno ou operador | **Quarentena · P0**: não vincular automaticamente |
| 14 | `resumo`: painel executivo/financeiro | Fontes operacionais, preços e snapshots existem | Dashboard, relatórios semanais e apresentação cobrem parte | Dashboard/apresentação existem | Não há reconciliação KPI a KPI ou relatório mensal equivalente | **Derivável · P1** |
| 15 | `Banco de Dados Pesagen`: configuração técnica de peso | `ProductWeightConfig` representa pacote, caixa, quantidade por caixa, massa, alvo, tolerância e fórmula | Produtos expõem criação/edição, mas a governança completa da configuração não foi provada | Página de produtos é parcial | Parser cruza essa aba com produtos, mas detecta quatro códigos de pesagem duplicados e comentários de peso sem referência confiável | **Parcial · P0** |
| 16 | `GRAF. PRODUTIVIDADE`: indicadores | `ProductivityEntry` existe | Somente `/productivity/summary`; não há CRUD operacional no commit-base | Página é de consulta | Não há importação nem reconciliação da produtividade | **Parcial · P1** |
| 17 | `GRAF. PERD-SOBRE.`: perdas/sobrepeso | Perdas e sobrepeso derivado da produção existem | Resumos de perdas, ranking de sobrepeso e dashboard existem | Páginas de perdas/sobrepeso/dashboard existem | Cinco fórmulas quebradas exibem falso zero; metas textuais não podem virar regra sem aprovação | **Derivável · P2** |
| 18 | `BANCO DE DADOS SOBRE.`: base analítica calculada | `ProductionEntry` armazena campos de sobrepeso | `/overweight/ranking` e dashboard leem resultados | Página de sobrepeso existe | Não deve ser importada como outra fonte; deve ser recalculada e conciliada | **Derivável · P1** |
| 19 | `Pacotes-caixas`: cadastro primário de produto/embalagem | `Product` + `ProductWeightConfig` representam o núcleo | CRUD parcial de produtos existe | Lista/desativação/preço existem; CRUD completo na UI não foi provado | Parser forma 87 candidatos válidos, mas registra 54 ausências de pacotes/caixa e 35 de peso de caixa nas fontes | **Parcial · P0** |
| 20 | `BANCO DE DADOS PRODV.`: cache de produtividade | `ProductionEntry`, `DowntimeEntry` e `ProductivityEntry` permitem reconstrução | Dashboard/produtividade fornecem agregados | Consulta existe | Não importar como fonte; falta equivalência numérica documentada | **Derivável · P1** |
| 21 | `ARQUIVO MORTO`: histórico materializado | `WeeklyPeriod.snapshotData`, `DashboardSnapshot`, `AuditLog` e `ImportBatch` ajudam, mas não preservam sozinhos as quatro tabelas legadas com identidade, versão, linha, hash e valor bruto | Sem rota de ingestão do arquivo morto no commit-base | Histórico exibe dados do aplicativo, não equivalência do legado | Nenhum importador das 67 linhas P1, 13 P2, 59 paradas e 26 perdas; 1.446 caches `#REF!` precisam permanecer como erro | **Ausente/Parcial · P0** |
| 22 | `LISTAS_CONTROLE`: listas e estado legado | `WeeklyPeriod`, `Sector`, equipamentos/turnos e `SystemSetting` cobrem partes | Semanas, equipamentos e turnos têm APIs; setores/linhas não têm CRUD dedicado no commit-base | Páginas de semanas, equipamentos e turnos existem | Texto de VBA não deve ser importado como automação; o XLSX não tem VBA | **Parcial · P1** |
| 23 | `PARADAS_HISTORICO`: tabela-reserva vazia | Auditoria/snapshot oferecem alternativa normalizada | Não há API de linhagem por célula | Histórico geral existe | Não há registros a importar; cabeçalho não equivale a 822 linhas | **Sem dado/Parcial · P2** |
| 24 | `DASHBOARD_HISTORICO`: resumo da tabela vazia | `DashboardSnapshot` pode preservar snapshots futuros | Snapshot semanal pode ser consultado | Página de histórico existe | Nenhuma equivalência demonstrada; a fonte Excel está vazia | **Parcial · P2** |
| 25 | `Tabela Preços`: 54 preços/kg | `ProductPricePeriod` possui início/fim e constraint de sobreposição, mas faltam moeda, origem, responsável, aprovador e justificativa | GET/POST de períodos por produto existem | Manutenção básica de preços existe | Importador-base não lê `tbl_Precos` diretamente; Excel não fornece vigência, logo aplicar retroativamente seria invenção | **Parcial · P0** |
| 26 | `GRÁFICOS DE PERDAS`: relatório visual | Perdas e custos oferecem fontes | Resumo de perdas/dashboard cobrem parte | Página de perdas e dashboard existem | Não há exportação/paridade dos oito gráficos certificada | **Derivável · P2** |

Nenhuma das 26 abas recebeu estado “coberto” porque o prompt mestre define conclusão pela cadeia inteira: banco, regra, API, interface, validação, permissão, auditoria, testes, consulta/relatório, tratamento de erro e documentação. Uma tela isolada não satisfaz esse critério.

## Cobertura por domínio do prompt mestre

| Domínio | O que existe no commit-base | Lacuna comprovada | Estado/prioridade |
| --- | --- | --- | --- |
| Estrutura industrial | `Sector`, `ProductionLine`, `Equipment`, `Shift`; CRUD de equipamento e turno | Empresa, unidade, centro de trabalho, equipe e vínculos de supervisor/operador ausentes; setor/linha sem CRUD dedicado; nomes M1/MQ/giro/freezer precisam de tabela de correspondência aprovada | **Parcial · P1** |
| Produtos | `Product`, configuração de peso e períodos de preço; API de produto | UI não prova CRUD completo; cadastro não contém família, descrição operacional estruturada, linhas compatíveis ou limites; 127 erros de origem precisam de revisão | **Parcial · P0** |
| Semanas | `WeeklyPeriod` com estados, datas, snapshot e transições fechar/reabrir/arquivar | Criação histórica completa, responsáveis/motivos de todas as transições e snapshot versionado/imutável não foram provados ponta a ponta | **Parcial · P1** |
| Ordens de produção | `ProductionOrder` ligado a semana/produto/setor | Sem controller/página dedicada; ciclo de cancelar/encerrar/histórico não existe como fluxo completo | **Parcial · P1** |
| Produção | Modelo rico, versionamento, workflow, CRUD, preview, duplicar, restaurar e telas P1/P2 | Regra P1 em conflito; frontend-base continha configuração fictícia quando peso faltava e repetia cálculo crítico local; importador não promove inconsistências de cálculo como bloqueio | **Parcial · P0** |
| Perdas | Modelo, tipos, workflow, CRUD e resumo | Unidade única `quantityKg` não representa caixas; turnos T1/T2 e valores de caixa são descartados na importação; faltam taxonomia/causa/ação corretiva completas | **Parcial · P0** |
| Paradas | Modelo temporal, motivo, equipamento/linha/turno, workflow, CRUD e resumo | Importação presume P1, grava massa zero, pula linhas incompletas e não resolve 90 grafias de motivo; faltam planejada/não planejada, causa, custo e ação corretiva | **Parcial · P0** |
| Produtividade | Modelo e endpoint de resumo | Sem CRUD, workflow, importação ou fonte externa documentada; tela somente leitura | **Parcial · P1** |
| Dosagem | Modelo com amostras, média/desvio/sobrepeso; GET/POST e tela | Faltam hora, OP/vínculo com produção, min/max/mediana, conformidade, custo, workflow e importação; fonte Excel sem chaves | **Parcial/Quarentena · P0** |
| Sobrepeso | Campos calculados em produção, ranking e tela | Fonte derivada não conciliada; metas e referências quebradas do Excel não podem virar defaults | **Parcial · P1** |
| Metas | `Goal`, GET/POST e tela | Falta vigência inicial/final completa, versão, produto/linha/equipamento/turno, unidade, aprovação e histórico; números textuais do Excel ainda não são regra aprovada | **Parcial · P1** |
| Preços e custos | `ProductPricePeriod` com vigência e proteção contra sobreposição; API/tela básica; custos em lançamentos | Falta governança do preço e ingestão dos 54 valores; aplicação histórica exige decisão de vigência | **Parcial · P0** |
| Histórico/arquivo morto | Snapshots, auditoria e vínculo de lote | Quatro tabelas materiais do legado não são ingeridas; faltam identidade/versão/linha/hash/valor bruto por registro histórico e regra de imutabilidade/correção | **Parcial · P0** |
| Importação | Upload seguro, preview, lotes, erros e importação direta de produtos/operação | Commit-base não possui staging editável/promovível; importação não cobre preços, dosagem, produtividade, metas ou arquivo morto; reconciliação não substitui promoção transacional | **Parcial · P0**; staging local é **WIP não validado** |
| Normalização de tipos | Datas, decimais e enums são modelados | Data textual inválida, escala 0–1/0–100, códigos numéricos e unidades mistas ainda exigem regras por fonte com teste | **Parcial · P0** |
| Dashboard | KPIs, gráficos, comparação, alertas e apresentação | Falta evidência de origem, regra, quantidade de registros, atualização, drill-down e equivalência integral | **Parcial · P1** |
| Relatórios | Dois CSVs semanais e apresentação executiva | Diário/mensal, XLSX e PDF não existem como fluxo completo; própria UI indica etapa futura | **Parcial · P1** |
| Auditoria | `AuditLog` guarda usuário, antes/depois, motivo, IP, agente, correlação, dispositivo e versão | Não foi provado que toda mutação crítica grava auditoria na mesma transação; anexos/comentários têm models, sem fluxo completo | **Parcial · P1** |
| Backup/restauração | Listar, criar, verificar e ensaiar restauração; checksum SHA-256 no serviço | Restauração real em banco separado, criptografia, evidência periódica, retenção e armazenamento externo não foram homologados nesta auditoria | **Parcial · P1** |
| Segurança | Cookie HTTP-only, JWT, papéis/permissões, revogação de sessão e administração de usuário | Cobertura de permissão por todos os novos fluxos e segurança de staging/promoção precisam de testes; credenciais operacionais não devem ter fallback | **Parcial · P1** |
| Testes | Suites e infraestrutura existem no repositório | Não há evidência, nesta matriz, de barreira obrigatória cobrindo todas as regras, importação, reconciliação, permissões e E2E do prompt | **Parcial · P0** |
| Concorrência | `version` existe em produção, perdas e paradas | Não está generalizado a cadastros, metas, preços, semanas, dosagem e demais registros importantes; mensagem E2E de conflito não foi provada | **Parcial · P1** |

## Bloqueios P0 com evidência reproduzível

### 1. Regra P1 não pode ser escolhida por intuição

No Excel, `Plan x Real (P1)!M7 = G7*O7` e não soma `H7` (reforma usada). Para a OP `23334`, a fonte contém `G7=5`, `H7=325`, `O7=491,7`, `M7=2.458,5`, `J7=2.424` e `N7=98,596705%`. O cálculo do commit-base soma a reforma no rendimento esperado; o resultado seria aproximadamente `87,084606%`.

Nenhuma das duas interpretações está autorizada como verdade operacional. A decisão precisa de responsável, justificativa, versão de regra, data de vigência e testes com casos reais. O frontend-base também repetia esse cálculo e usava configurações de peso fictícias quando o produto não possuía cadastro; ambos violam cálculo centralizado e “não inventar”.

### 2. Anomalia calculada não pode virar `OK`

Foram encontradas 48 fórmulas P1 acima de 100% e 13 P2 acima de 1. Percentuais maiores que 100% podem sinalizar anomalia; não devem ser limitados ou aceitos silenciosamente. No importador do commit-base, o cálculo produz uma lista de inconsistências, mas a criação do lançamento grava `status: "OK"` e não transforma essa lista em bloqueio de promoção/revisão.

### 3. Perda em kg não representa caixa em unidade

Em `CONTROLE DE PERDAS`, `E/F` guardam filme T1/T2 em kg, `D=E+F`, `H/I` guardam caixas T1/T2 em unidades e `G=H+I`. O importador-base leva apenas `D` para `LossEntry.quantityKg`. Isso perde turno e caixas, e impede reconciliação financeira correta. O modelo deve preservar quantidade e unidade originais; conversão só com regra autorizada.

### 4. Paradas não têm mapeamento seguro

`relatorios de paradas` possui 657 datas, 360 linhas completas e 240 candidatas dentro do período. O parser registra 120 linhas completas fora do período, enquanto linhas incompletas são silenciosamente omitidas. O campo chamado “Setor” contém `paradas m1`, `paradas mq` e `paradas giro freezer`; o importador-base, porém, associa tudo a P1 e grava massa produzida zero. Existem ainda 90 grafias de motivo. Tudo exige staging, correspondência controlada e revisão.

### 5. Dosagem não tem chave operacional

As 60 constantes de `Perdas - dosagem` não informam produto, OP, data, horário, semana, setor, equipamento, turno ou operador. Elas podem ser preservadas como linhas brutas e pendências, mas não podem alimentar `DosageCheck` oficial automaticamente.

### 6. Cadastro técnico não está limpo

O parser encontra 87 produtos candidatos, mas também 127 erros de origem: 54 ausências de pacotes/caixa, 35 de peso de caixa, 34 de peso alvo e quatro códigos duplicados na pesagem (`70974`, `73735`, `76379`, `76678`). Configuração ausente deve bloquear o cálculo dependente; nunca ativar valores padrão inventados.

### 7. Preço não possui vigência na fonte

`tbl_Precos` tem 54 linhas, mas não possui data inicial/final, moeda, origem, responsável ou aprovação. `ProductPricePeriod` resolve parte estrutural, porém a vigência da migração precisa ser decidida e registrada; o importador-base nem sequer lê essa tabela diretamente.

### 8. Arquivo morto precisa ser preservado, não achatado

A área quebrada tem 1.446 caches `#REF!` e 1.595 fórmulas contendo `#REF!`. Quatro tabelas congeladas ainda possuem 67 registros P1, 13 P2, 59 paradas e 26 perdas, com percentuais em escalas diferentes. O aplicativo precisa preservar origem, linha, valor bruto, hash, versão e resolução; snapshot genérico não prova essa linhagem.

### 9. Importação profissional ainda não existe no baseline

No commit `5287d13`, `ImportController` expõe preview, upload, importação de produtos e importação operacional direta. Não há rotas de staging editável e promoção transacional. `ReconciliationController` consulta/certifica um lote, mas isso acontece depois e não recupera campos descartados.

O worktree passou a conter `prisma/migrations/0012_import_staging`, `import-staging.service.ts` e `import-promotion.service.ts`. Nesta auditoria documental isso permanece WIP: só pode ser promovido a “coberto” após migration limpa, testes unitários/integração/E2E, rollback, permissões, auditoria, idempotência e reconciliação comprovada.

## Reconciliação inicial

Os valores abaixo são contagens da fonte e do parser seguro. A coluna Aplicativo permanece “não medido” porque nenhuma consulta certificada ao PostgreSQL foi entregue para esta auditoria. Preencher zero seria uma suposição.

| Métrica | Excel/parser | Aplicativo | Diferença | Situação |
| --- | ---: | --- | --- | --- |
| Abas catalogadas | 26 | Não aplicável | Não aplicável | Inventário completo |
| Produtos candidatos normalizados | 87 | Não medido | Indeterminada | 127 erros de configuração/origem separados |
| Produções P1 candidatas | 138 | Não medido | Indeterminada | Não certificada |
| Produções P2 candidatas | 23 | Não medido | Indeterminada | Não certificada |
| Produções candidatas, total | 161 | Não medido | Indeterminada | 44 ocorrências de erro em P1/P2; uma linha pode ter erro e ainda exigir decisão separada |
| Perdas candidatas | 68 | Não medido | Indeterminada | 25 fora do período; T1/T2 e caixas não preservados pelo baseline |
| Paradas candidatas | 240 | Não medido | Indeterminada | 120 completas fora do período; 657 datas versus 360 linhas completas |
| Registros operacionais candidatos | 469 | Não medido | Indeterminada | “Candidato” não significa aprovado |
| Amostras de dosagem órfãs | 60 | Não medido | Indeterminada | Quarentena obrigatória |
| Preços na `tbl_Precos` | 54 | Não medido | Indeterminada | Falta vigência de origem |
| Histórico materializado P1/P2/paradas/perdas | 67 / 13 / 59 / 26 | Não medido | Indeterminada | Importação ausente no baseline |
| Inconsistências operacionais classificadas | 189 | Não medido | Indeterminada | Devem virar staging/revisão |
| Erros de cadastro/configuração | 127 | Não medido | Indeterminada | Devem bloquear dependências |
| Caches `#REF!` | 1.454 | Não medido | Indeterminada | Preservar como erro, nunca zero |

## Backlog consolidado

### P0 — crítico

1. Homologar e versionar a regra P1/P2, removendo configuração fictícia e cálculo crítico duplicado no frontend.
2. Finalizar staging por linha/célula, revisão, promoção atômica/idempotente, rollback e reconciliação antes de qualquer carga oficial.
3. Preservar perdas por unidade e turno; migrar filme e caixa sem conversão presumida.
4. Resolver mapeamento de paradas para setor/linha/equipamento, massa produzida, grafias de motivo e linhas incompletas.
5. Bloquear dosagem órfã e configuração de produto incompleta; oferecer revisão humana.
6. Importar preços somente após decisão auditada de vigência e completar seus metadados de governança.
7. Criar ingestão histórica preservando as quatro tabelas materiais e todos os erros/valores brutos do arquivo morto.
8. Tornar testes de cálculo, importação, permissão, transação e reconciliação barreira obrigatória.

### P1 — alta

1. Completar estrutura industrial, ordens de produção e seletores por ID em todos os formulários.
2. Completar CRUDs de produto, produtividade, meta, preço, semana e usuário, incluindo restauração e histórico quando aplicável.
3. Generalizar concorrência otimista, auditoria transacional, anexos e comentários.
4. Entregar dashboard com linhagem, drill-down, regra, horário de atualização e contagem de registros.
5. Entregar relatórios diário/semanal/mensal e exportações CSV/XLSX/PDF com filtros idênticos ao aplicativo.
6. Homologar backup/restauração em banco separado e snapshots imutáveis de fechamento.

### P2 — importante

1. Reproduzir, como relatórios derivados, paridade dos painéis diários, Paretos, rankings e gráficos legados que tenham valor operacional aprovado.
2. Fechar equivalência visual/funcional de histórico e dashboards sem copiar fórmulas quebradas, caches ou duplicações.
3. Consolidar aliases de produto, motivo e equipamento com fila de revisão administrável.

### P3 — futura

1. Depois da homologação, adicionar análises preditivas, comparações avançadas e automações que não sejam necessárias para a substituição segura do Excel.

## Evidências de código consultadas

- Banco: `prisma/schema.prisma` e migrations até o commit `5287d13`.
- Importação: `apps/api/src/modules/import/import.controller.ts`, `import.service.ts`, `scripts/import_excel.py` e `apps/api/src/modules/reconciliation`.
- Cálculos: `apps/api/src/domain/calculations/*` e `apps/web/components/forms/production-form.tsx`.
- APIs: controllers em `apps/api/src/modules/*`.
- Interface: páginas em `apps/web/app/*`, com atenção a produção, perdas, paradas, produtividade, dosagem, sobrepeso, metas, produtos, semanas, importação, relatórios, histórico, equipamentos, turnos, usuários, backups, dashboard e apresentações.
- Fonte Excel: inspeção OOXML e relatório temporário gerado por `python3 scripts/import_excel.py --file ... --report`.

## Portão objetivo de aceitação

O Excel só pode deixar de ser fonte operacional depois que cada domínio tiver, simultaneamente: dados persistidos e normalizados; regra versionada; API e interface completas; validação/permissão/auditoria; testes aprovados; relatório consultável; importação por staging; reconciliação Excel × PostgreSQL com diferenças explicadas; uso paralelo; restauração ensaiada; e aceite formal do responsável operacional.

Até esse portão ser cumprido, o resultado correto desta matriz é: **Fase 0 documentada; migração ainda não certificada para substituir a planilha.**

## Evolução implementada no worktree após o baseline

Esta seção registra a diferença entre o diagnóstico do commit-base `5287d13` e a entrega de hardening desta branch. Ela não altera o resultado histórico das tabelas anteriores e não transforma implementação em homologação.

| Lacuna do baseline | Tratamento implementado | Evidência atual | Estado |
| --- | --- | --- | --- |
| Importação escrevia diretamente em tabelas oficiais | Staging por registro, classificação, correção/revisão com versão otimista e promoção serializável/atômica | migrations `0012`/`0019`, serviços de staging/promoção, tela de importação e testes unitários | Implementado; integração PostgreSQL e homologação pendentes |
| Fórmula quebrada podia perder contexto | Valor bruto, célula, tipo, fórmula e atributos são preservados; erro permanece bloqueante | `scripts/import_excel.py` e staging `UNKNOWN/ERROR` | Implementado para fontes extraídas; linhagem célula a célula de todas as métricas derivadas ainda pendente |
| Perdas misturavam kg e caixas e descartavam T1/T2 | Filme total/T1/T2 em kg e caixas total/T1/T2 em unidades ganharam campos, constraints, validação, importação, reconciliação e exportação próprios | migration `0019`, `LossEntry`, API, UI e relatórios | Implementado; setor/produto da fonte requerem correção humana |
| Setor de paradas era presumido | Setor passou a ser obrigatório na correção humana; promoção usa linha/equipamento compatíveis e semana já cadastrada | serviços de staging/promoção | Implementado como bloqueio seguro; mapa operacional M1/MQ/giro/freezer ainda precisa aprovação |
| Dosagem órfã era invisível | As 60 amostras são preservadas célula a célula em domínio de quarentena não promovível | parser v4 e testes de quarentena | Preservado; não reconciliado por falta de chaves na fonte |
| Arquivo morto não era ingerido | As quatro tabelas materiais, totalizando 165 registros, são preservadas com tabela, intervalo, células, fórmula/cache, chave/versão/hash legados | parser v4 e domínio `HISTORY` não promovível | Preservado; normalização histórica dedicada ainda pendente |
| Preço sem governança podia contaminar cálculo | Preço ganhou série/versionamento imutável, vigência, moeda, origem e aprovação independente; lançamentos aceitam somente período aprovado e guardam linhagem | migration `0018`, API, UI e testes | Implementado; os 54 preços da planilha continuam sem vigência autorizada e não são aprovados automaticamente |
| Meta antiga podia ser sobrescrita | Meta ganhou série/versionamento imutável, escopos, vigência, responsável/aprovador e estados `DRAFT/APPROVED/RETIRED` | migration `0017`, API, UI e testes | Implementado; metas legadas continuam rascunho até aprovação |
| Semana/snapshot não possuíam proteção suficiente | Fluxo `OPEN -> REVIEW -> CLOSED -> ARCHIVED`, locks, motivo de reabertura, snapshot versionado e gatilhos de imutabilidade | migrations `0013`/`0016`, serviço de semanas e testes | Implementado; resta provar em PostgreSQL limpo e homologar processo |
| Paradas concorrentes podiam se sobrepor | Constraints de exclusão PostgreSQL e tratamento de conflito `409` | migration `0015` e testes | Implementado; validação real da migration em PostgreSQL pendente neste host |
| Metadados decisórios e linhagem de preço dependiam só da aplicação | Triggers limitam transições, congelam aprovação/retirada e conferem produto, status, vigência, versão, origem, moeda e preço unitário | migrations `0017`/`0018` e testes estruturais | Implementado; execução SQL em PostgreSQL real ainda pendente |
| Auditoria podia falhar depois da mutação | Upload, perdas e paradas agora gravam mutação e auditoria no mesmo `TransactionClient` serializável | serviços e testes de concorrência/auditoria | Implementado para estes fluxos; outros CRUDs ainda em auditoria |
| Regra crítica estava duplicada/implícita | Registro central de regras com versão e estado; versões usadas persistem em lançamentos e snapshot | migration `0014`, registry, endpoints e testes | Implementado; regra P1 permanece `REVIEW_REQUIRED` e bloqueia certificação |
| Relatórios eram incompletos | Relatórios diário/semanal/mensal em CSV, XLSX e PDF, sempre de registros aprovados, com auditoria e hash | módulo de relatórios e tela | Implementado; equivalência com Excel ainda não homologada |
| Backup era só arquivo/checksum | Contêiner AES-256-GCM, retenção, cópia externa opcional e ensaio não destrutivo de leitura/tipos/contagens | módulo de backup e testes | Implementado parcialmente; restauração real em outro PostgreSQL continua obrigatória |

### Execução real do parser v4 na planilha fornecida

O parser gerou **3.199 registros de evidência**: 154 de produto (87 registros por código e 67 inconsistências de origem separadas), 455 de produção, 95 de perda, 657 de parada, 60 de dosagem, 165 históricos e 1.613 células de fórmula/erro em quarentena. A classificação foi 2.970 erros, 225 que exigem revisão e 4 duplicados. Nenhum registro recebe `VALID` enquanto os campos ausentes na fonte não forem decididos e justificados. O parser não cria OP, nome, setor, fórmula, tolerância, estado ativo, peso derivado nem zero para ausências.

O lote atual declara `sourceIntegrity.independentDerivedMetrics = false`. Portanto, a própria API impede certificação, ainda que staging e banco coincidam. Esse bloqueio é intencional: sem extração independente das células/fórmulas derivadas, comparar o banco com valores recalculados pelo mesmo importador seria reconciliação circular.

### Situação atual do portão de aceitação

- **Pode:** preview demonstrativo isolado, homologação controlada e futura operação paralela supervisionada.
- **Não pode:** promoção automática da planilha fornecida, certificação do lote, substituição integral do Excel ou declaração de equivalência numérica.
- **Decisões humanas obrigatórias:** fórmula P1; vigência/origem dos preços; mapa de setor/linha/equipamento; produto e setor das perdas; destino histórico das amostras órfãs.
- **Provas externas obrigatórias:** migrations em PostgreSQL limpo, restauração em banco separado, E2E com infraestrutura real, reconciliação independente, período paralelo e aceite formal do responsável operacional.
