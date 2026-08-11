# Regras de cálculo — Nexus Operacional

Atualizado em 19/07/2026. Fonte analisada: `Relatórios - MAIO-JUNHO 2026.xlsx`, SHA-256 `7ba9e6c1a14091033fcf22a74c1b9d208da0719b27f0125d035e17b1a3f1f5fb`.

## Contrato

Registro oficial fica em `apps/api/src/domain/calculations/rule-registry.ts`. Cada regra contém:

- ID estável;
- nome e versão inteira;
- fórmula legível;
- descrição e unidade;
- entradas, obrigatoriedade e unidade de cada entrada;
- tratamento de ausências;
- evidência no Excel, código anterior ou requisito aprovado;
- estado `ACTIVE` ou `REVIEW_REQUIRED`;
- ambiguidade explícita quando existente.

Mudança semântica exige nova versão. Correção apenas textual não muda versão. Execuções retornam `calculationRuleVersions`, mapa `{ regra: versão }`. Catálogo completo fica disponível em `GET /dashboard/calculation-rules` para usuários autorizados.

Valores financeiros usam `Prisma.Decimal` durante soma, multiplicação, divisão e arredondamento. Conversão para `number` ocorre somente na borda do DTO, mantendo compatibilidade do frontend; colunas persistidas continuam `Decimal` no PostgreSQL.

Percentuais usam razão decimal: `0,95 = 95%`. Razões operacionais não são multiplicadas por 100 no backend. Valor acima de `1` não é silenciosamente limitado: pode representar desempenho acima de 100% ou inconsistência e precisa continuar visível. Exceção: percentual de parada é naturalmente limitado porque minutos parados são limitados ao período disponível.

## Produção e sobrepeso

| Regra | v | Fórmula | Unidade | Ausência | Estado |
|---|---:|---|---|---|---|
| `production.produced_kg.box_weight` | 1 | `caixas × kg/caixa` | kg | inválido/negativo = 0 | ACTIVE |
| `production.produced_kg.package_weight` | 1 | `caixas × pacotes/caixa × kg/pacote` | kg | inválido/negativo = 0 | ACTIVE |
| `production.expected_yield_kg` | 1 | `bateladas realizadas × kg/massa + reforma usada(P1)` | kg | ausente = 0; P2 ignora reforma | REVIEW_REQUIRED |
| `production.real_yield_percent` | 1 | `kg produzidos ÷ kg esperados` | razão decimal | divisor 0 = 0 + inconsistência | REVIEW_REQUIRED |
| `production.plan_attainment_percent` | 1 | `realizado ÷ planejado` | razão decimal | plano 0 = 0 + inconsistência se realizado | ACTIVE |
| `production.plan_difference_batches` | 1 | `realizado − planejado` | batelada | inválido/negativo de entrada = 0 | ACTIVE |
| `production.package_count` | 1 | `caixas × pacotes/caixa` | pacote | inválido/negativo = 0 | ACTIVE |
| `overweight.unit_g` | 1 | `max(média − alvo, 0)` | g/pacote | média ausente assume alvo | ACTIVE |
| `overweight.total_kg` | 1 | `sobrepeso g/pacote × pacotes ÷ 1000` | kg | inválido/negativo = 0 | ACTIVE |
| `overweight.percent` | 1 | `sobrepeso kg ÷ produção kg` | razão decimal | produção 0 = 0 | ACTIVE |
| `production.total_losses_kg` | 1 | `perda pesagem + reforma gerada + sobrepeso` | kg | componente ausente = 0 | REVIEW_REQUIRED |

Evidência encontrada no XLSX:

- `Plan x Real (P1)` contém multiplicações compartilhadas `J×W`, `K×W` e `T×W`.
- `Plan x Real (P2)` contém `I×V`, `J×V` e `S×V`.
- Rendimento aparece com variantes `J×100/M`, `(J−H)×100/M` no P1 e `I/L` no P2.
- Abas auxiliares normalizam percentuais da planilha dividindo por 100.

### Bloqueio P0 — rendimento P1

Não existe equivalência comprovada entre Excel e backend atual:

- Excel P1 usa esperado `G×O`, sem somar reforma utilizada `H`.
- Backend legado usa `realizedBatches × massWeightKg + usedReworkKg` para P1.
- Caso real `Plan x Real (P1)!E7`, OP `23334`: `G=5`, `H=325`, `O=491,7`, `M=2458,5`, `J=2424`.
- Excel: esperado `2458,5 kg`; rendimento `2424/2458,5 = 0,985967`.
- Backend: esperado `2783,5 kg`; rendimento `2424/2783,5 = 0,870846`.

Regra existente foi catalogada, não declarada correta. Mudança está bloqueada até responsável operacional confirmar significado de reforma usada e colunas `G/H/J/M/O`. Decisão deve criar versão 2 e caso de reconciliação aprovado.

Também falta decisão se `reforma gerada` compõe perda executiva. Hoje comportamento anterior foi preservado.

## Financeiro e perdas

| Regra | v | Fórmula | Unidade | Precisão | Estado |
|---|---:|---|---|---|---|
| `financial.production_cost` | 1 | `kg produzidos × preço/kg` | moeda | preço 4; total 2 | ACTIVE |
| `financial.weighing_loss_cost` | 1 | `perda pesagem kg × preço/kg` | moeda | preço 4; total 2 | ACTIVE |
| `financial.overweight_cost` | 1 | `sobrepeso kg × preço/kg` | moeda | preço 4; total 2 | ACTIVE |
| `financial.packaging_film_used_kg` | 1 | `caixas × pacotes/caixa × filme g/pacote ÷ 1000` | kg | 3 | ACTIVE |
| `financial.packaging_loss_cost` | 1 | `quantidade perdida × custo unitário` | moeda | 2 | ACTIVE |
| `financial.packaging_film_value` | 1 | `filme usado kg × custo filme/kg` | moeda | 2 | ACTIVE |
| `financial.packaging_result` | 1 | `valor filme − custo perda` | moeda | 2 | ACTIVE |
| `financial.loss_result` | 1 | `−custo da perda` | moeda | 2 | ACTIVE |
| `loss.total_kg` | 1 | `Σ max(perda kg, 0)` | kg | 3 | ACTIVE |
| `loss.bucket_percent` | 1 | `perda grupo ÷ perda total` | razão decimal | 6 | ACTIVE |

`CONTROLE DE PERDAS` confirma fórmulas `T×U×W/1000`, `X×Y` e `Z−AA`. Preço vem de `Tabela Preços`. Ausência, valor inválido ou negativo vira `Decimal(0)`; sistema não inventa preço.

## Paradas e produtividade

| Regra | v | Fórmula | Unidade | Ausência | Estado |
|---|---:|---|---|---|---|
| `downtime.available_minutes` | 1 | `fim produção − início produção` | min | data inválida rejeitada | ACTIVE |
| `downtime.stopped_minutes` | 1 | `min(fim parada − início parada, disponível)` | min | data inválida rejeitada | ACTIVE |
| `downtime.productive_minutes` | 1 | `max(disponível − parado, 0)` | min | inválido = 0 | ACTIVE |
| `downtime.stopped_percent` | 1 | `parado ÷ disponível` | razão 0..1 | divisor 0 = 0 | ACTIVE |
| `downtime.efficiency_percent` | 1 | `produtivo ÷ disponível` | razão 0..1 | divisor 0 = 0 | ACTIVE |
| `downtime.real_kg_hour` | 1 | `kg produzidos ÷ horas disponíveis` | kg/h | divisor 0 = 0 | ACTIVE |
| `downtime.possible_kg_hour` | 1 | `kg produzidos ÷ horas produtivas` | kg/h | divisor 0 = 0 | ACTIVE |
| `downtime.status` | 1 | `<5% OK; <10% MEDIUM; <20% ATTENTION; ≥20% CRITICAL` | status | inválido = OK | REVIEW_REQUIRED |
| `productivity.kg_per_hour` | 1 | `kg produzidos ÷ horas produtivas` | kg/h | divisor 0 = 0 | ACTIVE |
| `productivity.average_kg_per_day` | 1 | `kg produzidos ÷ dias distintos` | kg/dia | divisor 0 = 0 | ACTIVE |

`relatorios de paradas` usa diferença `fim−início` e `MOD(...,1)`. Limites de classificação vieram do código, não foram confirmados no Excel; precisam virar configuração/meta aprovada. Produtividade oficial em kg/h está implementada como função, mas resumo atual só pode publicar kg/dia: vínculo homologado entre tempo produtivo, linha e produção ainda falta.

## Dosagem

| Regra | v | Fórmula | Unidade | Ausência | Estado |
|---|---:|---|---|---|---|
| `dosage.average_weight_g` | 1 | `Σ amostras ÷ N` | g | lista vazia rejeitada | ACTIVE |
| `dosage.population_standard_deviation_g` | 1 | `sqrt(Σ(x−média)² ÷ N)` | g | 1 amostra = 0 | REVIEW_REQUIRED |
| `dosage.overweight_g` | 1 | `max(média − alvo, 0)` | g | alvo inválido bloqueia cadastro | ACTIVE |

Serviço agora usa função pura do domínio. Divisor `N` preserva implementação anterior. Planilha ainda não prova se usuário espera desvio populacional (`N`) ou amostral (`N−1`); decisão humana deve preceder versão 2.

## Dashboard

| Regra | v | Fórmula | Unidade | Ausência | Estado |
|---|---:|---|---|---|---|
| `overweight.ranking_percent` | 1 | `Σ sobrepeso ÷ Σ produção` | razão decimal | produção 0 = 0 | ACTIVE |
| `overweight.ranking_status` | 1 | `>2×tolerância CRITICAL; >tolerância ATTENTION; senão OK` | status | tolerância ausente = 0 | REVIEW_REQUIRED |
| `dashboard.cost_per_kg` | 1 | `custo produção ÷ kg produção` | moeda/kg | produção 0 = 0 | ACTIVE |
| `dashboard.loss_percent` | 1 | `perdas kg ÷ produção kg` | razão decimal | produção 0 = 0 | ACTIVE |
| `dashboard.total_impact_cost` | 1 | `custo perdas + custo sobrepeso` | moeda | ausente = Decimal(0) | ACTIVE |
| `dashboard.relative_variation` | 1 | `(atual − anterior) ÷ anterior` | razão assinada | ambos 0 = 0; base 0 = null | ACTIVE |

Variação relativa é analítica, pode ser negativa e não é persistida como percentual operacional. Multiplicador crítico `2×` do ranking de sobrepeso veio do código e não foi localizado na planilha; permanece `REVIEW_REQUIRED`.

Produção não usa mais meta fixa `0,95` para classificar lançamento. Comparação de rendimento com meta ocorre no módulo de metas, usando valor vigente do banco.

## O que não foi inventado

- Unidades finais não são calculadas: cadastro possui pacotes por caixa, mas não possui unidades por pacote homologadas.
- Mediana, peso mínimo/máximo e custo total de dosagem não foram adicionados ao registro porque schema e planilha ainda precisam de mapeamento conclusivo.
- Horas produtivas agregadas não são inferidas cruzando produção e parada sem chave operacional confirmada.
- Fórmula P1 conflitante não foi trocada silenciosamente.
- Erros `#REF!`, células vazias críticas e preços ausentes não viram zero por decisão de cálculo; importador deve mantê-los como inconsistência.

## Persistência das versões executadas

A migração `0014_calculation_rule_versions` adiciona `calculation_rule_versions JSONB NOT NULL DEFAULT '{}'` a `ProductionEntry`, `LossEntry`, `DowntimeEntry`, `ProductivityEntry` e `DosageCheck`.

- Criação e edição de produção, perdas e paradas gravam as versões das regras que produziram os campos derivados.
- Promoção revisada da importação grava o mesmo mapa nas linhas oficiais. Uma perda importada que só materializa `lossCost` registra apenas `financial.packaging_loss_cost`; não declara cálculo de filme que não foi persistido.
- Dosagem grava média, desvio populacional e sobrepeso executados.
- Duplicação de produção preserva o snapshot do lançamento copiado, pois copia valores sem recalcular.
- Alterações apenas de workflow não trocam o snapshot. Edição de valores recalcula, grava novo mapa e mantém o antes/depois no log de auditoria.
- Linhas existentes recebem `{}` de propósito: atribuir retroativamente versão 1 sem prova de qual código as calculou criaria rastreabilidade falsa.

`ProductivityEntry` registra apontamentos informados em fluxo próprio e grava somente a versão de `productivity.kg_per_hour`, regra executada no lançamento. Registros anteriores à governança ficam com origem `LEGACY_UNVERIFIED` e aguardam revisão humana. O resumo automático continua separado: agrega somente produção aprovada e grava na resposta apenas a versão de `productivity.average_kg_per_day`.

`DashboardSnapshot.payload` pode carregar o mapa atual. Fechamento histórico completo ainda depende da política de snapshots do período.

Prioridade:

- **P0:** homologar rendimento P1 com OP `23334` e amostra maior; só então criar versão 2.
- **P1:** persistir versões no snapshot de fechamento do período.
- **P1:** substituir limites de parada e multiplicador crítico de sobrepeso por configuração/meta versionada.
- **P1:** reconciliar produtividade kg/h por linha/equipamento/turno.
- **P2:** decidir desvio padrão populacional ou amostral.
- **P2:** mapear unidades por pacote e estatísticas adicionais de dosagem.

## Testes

`tests/unit/calculation-registry.test.ts` cobre integridade/imutabilidade do catálogo, referência exata de versão, escala decimal, conflito P1 Excel versus backend, Decimal financeiro, perda, dosagem, sobrepeso, paradas e variação. `tests/unit/calculations.test.ts` mantém casos anteriores de produção e parada.
