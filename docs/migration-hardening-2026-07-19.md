# Entrega de hardening da migração — 19/07/2026

## Resultado

Esta branch transforma a leitura inicial do Excel em um fluxo conservador de evidência, revisão e promoção. Nenhuma ambiguidade da planilha é convertida silenciosamente em dado operacional. A entrega reduz riscos críticos, mas **não libera a substituição do Excel**: o lote fornecido não possui métricas derivadas independentes suficientes para certificação, a fórmula P1 exige decisão operacional e não houve restauração real em PostgreSQL separado.

## Diagnóstico e decisões

- O dashboard e o modo reunião usam a API no modo operacional; demo permanece isolada e explícita.
- O workbook possui 26 abas, 16.980 fórmulas, 1.454 resultados em cache `#REF!` e 1.609 fórmulas contendo `#REF!`. A união resulta em 1.613 células de erro/referência quebrada, cada uma preservada separadamente.
- O Excel não fornece contexto suficiente para associar automaticamente dosagem, perdas, equipamentos e preços a entidades oficiais.
- Valores ausentes, células de erro e fórmulas quebradas permanecem nulos/erros. Nunca viram zero.
- Percentuais acima de 100% permanecem visíveis e exigem revisão. Nunca são truncados.
- Valores monetários e métricas críticas usam `Decimal`/Prisma Decimal no backend.
- Dados oficiais continuam separados do preview demonstrativo publicado.

## Banco e migrations

| Migration | Finalidade |
| --- | --- |
| `0012_import_staging` | Lote, registros de staging, decisões, classificação, versão e promoção |
| `0013_week_close_concurrency` | Transições/locks e proteção de escrita por estado da semana |
| `0014_calculation_rule_versions` | Versão de regra executada nos lançamentos |
| `0015_downtime_overlap_constraints` | Exclusão de intervalos conflitantes por equipamento/linha |
| `0016_certified_import_immutability` | Congelamento de lote certificado e entidades vinculadas |
| `0017_goal_governance` | Séries, versões, escopos, vigência e aprovação de metas |
| `0018_product_price_governance` | Séries, versões, moeda, origem, vigência e aprovação de preços |
| `0019_loss_dimensions_and_source_quarantine` | Filme/caixas por T1/T2 e domínios de quarentena |

Constraints adicionais impedem valores negativos, caixas fracionárias, decomposição T1/T2 inconsistente, sobreposição de preços aprovados e mutação de registros protegidos. Rascunhos de preço podem sobrepor o legado para permitir uma nova versão governada, mas a aprovação é bloqueada se outra versão aprovada ocupar a vigência. Aplicar as migrations primeiro em PostgreSQL limpo e em cópia restaurável de homologação.

## APIs e permissões principais

| Método e rota | Papel | Função |
| --- | --- | --- |
| `GET /api/import/:batchId/staging` | ADMIN/MANAGER/SUPERVISOR | Lista evidência original, interpretação e correção |
| `GET /api/import/:batchId/staging/summary` | ADMIN/MANAGER/SUPERVISOR | Resume domínio, classificação e decisão |
| `PATCH /api/import/:batchId/staging/:recordId` | ADMIN/MANAGER/SUPERVISOR | Corrige com justificativa e versão otimista |
| `POST /api/import/:batchId/staging/:recordId/review` | ADMIN/MANAGER/SUPERVISOR | Aprova, ignora ou rejeita com auditoria |
| `POST /api/import/:batchId/promote` | ADMIN/MANAGER | Promove em transação serializável e idempotente |
| `GET /api/import/:batchId/reconciliation` | Usuário autenticado autorizado | Compara fonte, staging e PostgreSQL |
| `POST /api/import/:batchId/reconciliation/certify` | ADMIN | Certifica somente lote elegível, com motivo |
| `GET /api/dashboard/calculation-rules` | Usuário autenticado | Expõe fórmula, unidade, versão e estado da regra |

Metas e preços receberam rotas de criação de versão, aprovação e retirada. Semanas receberam revisão, fechamento, reabertura e arquivamento auditados. Relatórios aceitam período/tipo/formato e geram CSV, XLSX ou PDF com hash e auditoria.

## Frontend

- Importação: filtros, valor bruto, interpretado e corrigido, justificativa, revisão, promoção, reconciliação e certificação.
- Metas e preços: vigência, versões imutáveis, escopo, aprovação e retirada.
- Perdas: filme e caixas por T1/T2 sem mistura de unidade; ausência aparece como não informada.
- Semanas: fluxo de revisão/fechamento/reabertura/arquivamento.
- Relatórios: seleção diária/semanal/mensal e download CSV/XLSX/PDF.
- Dashboard: fonte operacional exclusiva via API; demo somente quando ativada explicitamente.

## Importação da planilha fornecida

| Domínio | Evidências |
| --- | ---: |
| Produto | 154 |
| Produção | 455 |
| Perda | 95 |
| Parada | 657 |
| Dosagem em quarentena | 60 |
| Histórico em quarentena | 165 |
| Fórmula/célula quebrada em quarentena | 1.613 |
| **Total** | **3.199** |

Classificações conservadoras do `xlsx-normalizer-v4`: 2.970 `ERROR`, 225 `REQUIRES_REVIEW` e 4 `DUPLICATE`; nenhum registro é declarado `VALID` enquanto setor, fórmula, tolerância, estado de produto, mapeamentos oficiais e demais lacunas de fonte não forem decididos por uma pessoa autorizada. O parser preserva 455 linhas de produção, 95 de perdas e 657 de paradas, inclusive incompletas e fora do período. Elas não são candidatas aprovadas. As 154 evidências de produto incluem 87 registros consolidados por código e 67 inconsistências de origem que não podem ser anexadas silenciosamente a outro registro.

O v4 não cria mais nome técnico de produto, OP `LEG-*`, setor por palavra-chave, fórmula, tolerância, estado ativo, pesos derivados ou zero para célula ausente. Cada campo desconhecido permanece `null` e bloqueia cálculo/promoção. As células mapeadas guardam referência, valor em cache, tipo, fórmula e atributos da fórmula.

## Reconciliação

O serviço compara contagens, planejamento/realização, caixas, reprocesso, massa produzida, perda de pesagem, sobrepeso, perda registrada, filme T1/T2, caixa T1/T2 e parada. O hash inclui valor original, interpretação, correção, decisão e dimensões completas das entidades promovidas. Certificação exige correspondência Excel→staging e staging→PostgreSQL e todos os lançamentos promovidos em `APPROVED`; assim, o gatilho de imutabilidade nunca congela um rascunho.

| Métrica | Excel/parser | PostgreSQL | Diferença | Situação |
| --- | ---: | --- | --- | --- |
| Evidências de staging | 3.199 | Não medido | Indeterminada | Parser v4 executado; banco real indisponível neste host |
| Linhas de produção preservadas | 455 | Não medido | Indeterminada | Ausências e regra P1 bloqueiam certificação |
| Linhas de perda preservadas | 95 | Não medido | Indeterminada | Setor/produto exigem correção humana |
| Linhas de parada preservadas | 657 | Não medido | Indeterminada | Linha e motivo precisam de IDs oficiais ativos |
| Dosagem órfã | 60 | 0 oficial | Não aplicável | Evidência preservada, promoção proibida |
| Histórico materializado | 165 | 0 oficial | Não aplicável | Evidência preservada, normalização pendente |

Não existe número inventado para preencher a coluna PostgreSQL. Certificação continua bloqueada por `sourceIntegrity.independentDerivedMetrics = false` e `completeReconciliationScope = false`. O contrato completo ainda exige produtividade, dosagem, custos, pacotes, histórico e totais separados de P1/P2.

## Riscos resolvidos

- Escrita oficial durante upload inicial.
- Promoção parcial sem rollback.
- Perda de evidência original ao corrigir staging.
- `#REF!`, vazio ou inválido convertido em zero.
- Mistura de caixas com quilogramas.
- Preço da planilha tratado como preço aprovado.
- Meta/preço histórico sobrescrito.
- Mutação ordinária de semana arquivada ou lote certificado.
- Sobreposição concorrente silenciosa de paradas.
- Fallback fictício no ambiente operacional.
- Metadados de aprovação/retirada alteráveis fora de transição válida.
- Linhagem financeira apontando para preço de outro produto, versão, moeda, origem ou vigência.
- Auditoria de upload, perdas e paradas fora da transação da mutação.

## Pendências

### P0 — bloqueiam substituição do Excel

1. Homologar e aprovar a regra P1 com responsável, justificativa e vigência.
2. Extrair métricas derivadas independentes célula/fórmula e reconciliar cada domínio contra PostgreSQL.
3. Executar migrations, rollback e E2E contra PostgreSQL limpo em infraestrutura de homologação.
4. Restaurar backup criptografado em outro PostgreSQL e reconciliar pós-restauração.
5. Executar período de uso paralelo e obter aceite formal do responsável operacional.

### P1 — alta

1. Aprovar mapa legado de setor/linha/equipamento, aliases de motivo e vigência dos preços.
2. Completar workflow/versionamento de produtividade e dosagem e auditoria transacional dos CRUDs restantes. Upload, perdas e paradas já gravam auditoria na mesma transação serializável.
3. Completar estrutura industrial (empresa, unidade, centro de trabalho, equipe e vínculos humanos) e CRUD próprio de ordens.
4. Homologar drill-down e equivalência visual/numérica dos relatórios e dashboards.
5. Criar promoção faseada de cadastro mestre/`PRICE`; hoje produto novo com lançamento no mesmo lote exige cadastro e preço aprovado prévios, e falha antes de qualquer escrita oficial.

### P2/P3

Completar anexos, comentários, ações corretivas, análises históricas e automações somente depois dos portões P0/P1.

## Critério de uso

- Preview e demonstração: liberados, sem dado real.
- Homologação controlada: liberada após migrations e configuração de segredos.
- Operação paralela: somente com supervisão, backup e reconciliação diária.
- Substituição total do Excel: bloqueada até concluir todos os itens P0.

## Verificação executada nesta branch

- Prisma format/generate/validate: aprovado.
- Typecheck e ESLint de API/web: aprovados.
- Vitest: 37 arquivos e 233 testes aprovados.
- Playwright: 34 cenários aprovados em desktop e celular; telas de login/dashboard renderizadas sem fundo preto.
- Builds: aplicação operacional (`standalone`) e preview demonstrativo (`export`) aprovados.
- `npm audit --audit-level=high`: sem achado alto/crítico; quatro transitivos moderados documentados.
- Parser v4 executado na planilha fornecida; relatório e contagens desta entrega vêm dessa execução real.

Não foi possível executar migrations nem restauração contra PostgreSQL real neste host, pois não havia servidor/container/`psql` disponível. Essa prova permanece portão obrigatório de homologação.
