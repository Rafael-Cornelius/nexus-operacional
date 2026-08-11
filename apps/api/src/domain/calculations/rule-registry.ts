export type CalculationRuleStatus = "ACTIVE" | "REVIEW_REQUIRED";

export interface CalculationRuleInput {
  name: string;
  unit: string;
  required: boolean;
  description: string;
}

export interface CalculationRuleDefinition {
  id: CalculationRuleId;
  name: string;
  version: number;
  formula: string;
  description: string;
  unit: string;
  inputs: readonly CalculationRuleInput[];
  missingValueTreatment: string;
  evidence: readonly string[];
  status: CalculationRuleStatus;
  ambiguity?: string;
}

const input = (name: string, unit: string, required: boolean, description: string): CalculationRuleInput => ({
  name,
  unit,
  required,
  description
});

const ruleIds = {
  producedKgBox: "production.produced_kg.box_weight",
  producedKgPackage: "production.produced_kg.package_weight",
  expectedYieldKg: "production.expected_yield_kg",
  realYield: "production.real_yield_percent",
  planAttainment: "production.plan_attainment_percent",
  planDifference: "production.plan_difference_batches",
  packageCount: "production.package_count",
  overweightUnit: "overweight.unit_g",
  overweightTotal: "overweight.total_kg",
  overweightPercent: "overweight.percent",
  totalLosses: "production.total_losses_kg",
  productionCost: "financial.production_cost",
  weighingLossCost: "financial.weighing_loss_cost",
  overweightCost: "financial.overweight_cost",
  packagingFilmUsed: "financial.packaging_film_used_kg",
  packagingLossCost: "financial.packaging_loss_cost",
  packagingFilmValue: "financial.packaging_film_value",
  packagingResult: "financial.packaging_result",
  lossResult: "financial.loss_result",
  lossTotal: "loss.total_kg",
  lossShare: "loss.bucket_percent",
  availableMinutes: "downtime.available_minutes",
  stoppedMinutes: "downtime.stopped_minutes",
  productiveMinutes: "downtime.productive_minutes",
  stoppedPercent: "downtime.stopped_percent",
  efficiencyPercent: "downtime.efficiency_percent",
  realKgHour: "downtime.real_kg_hour",
  possibleKgHour: "downtime.possible_kg_hour",
  downtimeStatus: "downtime.status",
  productivityKgHour: "productivity.kg_per_hour",
  productivityKgDay: "productivity.average_kg_per_day",
  dosageAverage: "dosage.average_weight_g",
  dosageStdDev: "dosage.population_standard_deviation_g",
  dosageOverweight: "dosage.overweight_g",
  overweightRankingPercent: "overweight.ranking_percent",
  overweightRankingStatus: "overweight.ranking_status",
  dashboardCostPerKg: "dashboard.cost_per_kg",
  dashboardLossPercent: "dashboard.loss_percent",
  dashboardTotalImpact: "dashboard.total_impact_cost",
  dashboardVariation: "dashboard.relative_variation"
} as const;

export type CalculationRuleId = (typeof ruleIds)[keyof typeof ruleIds];
export type CalculationRuleVersions = Readonly<Record<string, number>>;

const productionEvidence = [
  "Relatórios - MAIO-JUNHO 2026.xlsx / Plan x Real (P1): fórmulas compartilhadas J*W, K*W e T*W.",
  "Relatórios - MAIO-JUNHO 2026.xlsx / Plan x Real (P2): fórmulas compartilhadas I*V, J*V e S*V.",
  "apps/api/src/domain/calculations/production-calculations.ts (regra operacional anterior ao catálogo)."
] as const;

const financialEvidence = [
  "Relatórios - MAIO-JUNHO 2026.xlsx / Plan x Real (P1/P2): preço obtido da aba Tabela Preços e multiplicado pela quantidade.",
  "apps/api/src/domain/calculations/financial-calculations.ts (regra operacional anterior ao catálogo)."
] as const;

const rules: CalculationRuleDefinition[] = [
  {
    id: ruleIds.producedKgBox,
    name: "Produção em kg por peso da caixa",
    version: 1,
    formula: "producedKg = packedBoxes × boxWeightKg",
    description: "Converte caixas embaladas em quilogramas quando cadastro do produto usa peso por caixa.",
    unit: "kg",
    inputs: [input("packedBoxes", "caixa", true, "Caixas embaladas."), input("boxWeightKg", "kg/caixa", true, "Peso configurado da caixa.")],
    missingValueTreatment: "Entrada ausente, inválida ou negativa vira 0; resultado arredondado para 3 casas.",
    evidence: productionEvidence,
    status: "ACTIVE"
  },
  {
    id: ruleIds.producedKgPackage,
    name: "Produção em kg por peso do pacote",
    version: 1,
    formula: "producedKg = packedBoxes × packagesPerBox × packageWeightKg",
    description: "Converte caixas em quilogramas quando cadastro do produto usa peso e quantidade de pacotes.",
    unit: "kg",
    inputs: [input("packedBoxes", "caixa", true, "Caixas embaladas."), input("packagesPerBox", "pacote/caixa", true, "Pacotes por caixa."), input("packageWeightKg", "kg/pacote", true, "Peso do pacote.")],
    missingValueTreatment: "Entrada ausente, inválida ou negativa vira 0; resultado arredondado para 3 casas.",
    evidence: productionEvidence,
    status: "ACTIVE"
  },
  {
    id: ruleIds.expectedYieldKg,
    name: "Massa esperada para rendimento",
    version: 1,
    formula: "expectedYieldKg = realizedBatches × massWeightKg + usedReworkKg(P1)",
    description: "Calcula massa esperada pela quantidade de bateladas realizadas; reforma utilizada entra apenas em P1.",
    unit: "kg",
    inputs: [input("realizedBatches", "batelada", true, "Bateladas realizadas."), input("massWeightKg", "kg/batelada", true, "Peso configurado da massa."), input("usedReworkKg", "kg", false, "Reforma utilizada no P1.")],
    missingValueTreatment: "Valor ausente, inválido ou negativo vira 0; P2 sempre ignora reforma utilizada.",
    evidence: productionEvidence,
    status: "REVIEW_REQUIRED",
    ambiguity: "Bloqueio de homologação: P1 Excel calcula esperado como G×O, sem somar reforma H; backend legado soma usedReworkKg. Em Plan x Real (P1)!E7, OP 23334: G=5, H=325, O=491,7, M=2458,5 e J=2424. Excel rende 0,985967; backend rende 0,870846. Fórmula preserva comportamento existente somente até decisão humana versionada."
  },
  {
    id: ruleIds.realYield,
    name: "Rendimento real",
    version: 1,
    formula: "realYieldPercent = producedKg ÷ expectedYieldKg",
    description: "Razão normalizada entre produção e massa esperada.",
    unit: "razão decimal (1 = 100%; pode exceder 1)",
    inputs: [input("producedKg", "kg", true, "Produção calculada."), input("expectedYieldKg", "kg", true, "Massa esperada calculada.")],
    missingValueTreatment: "Denominador 0 gera 0 e inconsistência quando existe produção; resultado acima de 1 permanece visível para revisão.",
    evidence: productionEvidence,
    status: "REVIEW_REQUIRED",
    ambiguity: "Planilha usa escala 0..100 em células de origem e divide por 100 em bancos auxiliares. Nexus usa razão decimal, mas não limita valores acima de 1 porque isso esconderia rendimento superior a 100%."
  },
  {
    id: ruleIds.planAttainment,
    name: "Atingimento do plano",
    version: 1,
    formula: "planAttainmentPercent = realizedBatches ÷ plannedBatches",
    description: "Mede atendimento do plano em escala decimal sem ocultar realização acima do plano.",
    unit: "razão decimal (1 = 100%; pode exceder 1)",
    inputs: [input("realizedBatches", "batelada", true, "Bateladas realizadas."), input("plannedBatches", "batelada", true, "Bateladas planejadas.")],
    missingValueTreatment: "Plano 0 gera 0; realizado sem plano gera inconsistência.",
    evidence: ["PROMPT MESTRE, seção 4.1: cálculo obrigatório de atingimento do plano.", "Campos planejado e realizado existentes em Plan x Real (P1/P2) e ProductionEntry."],
    status: "ACTIVE"
  },
  {
    id: ruleIds.planDifference,
    name: "Diferença entre realizado e plano",
    version: 1,
    formula: "planDifferenceBatches = realizedBatches − plannedBatches",
    description: "Mantém sinal: positivo acima do plano; negativo abaixo.",
    unit: "batelada",
    inputs: [input("realizedBatches", "batelada", true, "Bateladas realizadas."), input("plannedBatches", "batelada", true, "Bateladas planejadas.")],
    missingValueTreatment: "Entrada ausente, inválida ou negativa vira 0.",
    evidence: ["PROMPT MESTRE, seção 4.1: cálculo obrigatório de diferença entre plano e realizado.", "Campos planejado e realizado existentes em Plan x Real (P1/P2) e ProductionEntry."],
    status: "ACTIVE"
  },
  {
    id: ruleIds.packageCount,
    name: "Quantidade de pacotes",
    version: 1,
    formula: "packageCount = packedBoxes × packagesPerBox",
    description: "Calcula pacotes associados às caixas embaladas.",
    unit: "pacote",
    inputs: [input("packedBoxes", "caixa", true, "Caixas embaladas."), input("packagesPerBox", "pacote/caixa", true, "Pacotes por caixa do produto.")],
    missingValueTreatment: "Entrada ausente, inválida ou negativa vira 0.",
    evidence: productionEvidence,
    status: "ACTIVE"
  },
  {
    id: ruleIds.overweightUnit,
    name: "Sobrepeso unitário",
    version: 1,
    formula: "overweightGPerPackage = max(averagePackageWeightG − targetPackageWeightG, 0)",
    description: "Excesso médio por pacote; subpeso não vira sobrepeso negativo.",
    unit: "g/pacote",
    inputs: [input("averagePackageWeightG", "g/pacote", false, "Peso médio amostral."), input("targetPackageWeightG", "g/pacote", true, "Peso alvo cadastrado.")],
    missingValueTreatment: "Média ausente assume peso alvo, produzindo sobrepeso 0; configuração inválida é sinalizada.",
    evidence: productionEvidence,
    status: "ACTIVE"
  },
  {
    id: ruleIds.overweightTotal,
    name: "Sobrepeso total",
    version: 1,
    formula: "overweightTotalKg = overweightGPerPackage × packageCount ÷ 1000",
    description: "Converte excesso unitário e população produzida em kg.",
    unit: "kg",
    inputs: [input("overweightGPerPackage", "g/pacote", true, "Excesso médio unitário."), input("packageCount", "pacote", true, "Quantidade de pacotes.")],
    missingValueTreatment: "Entrada ausente, inválida ou negativa vira 0; resultado arredondado para 3 casas.",
    evidence: productionEvidence,
    status: "ACTIVE"
  },
  {
    id: ruleIds.overweightPercent,
    name: "Percentual de sobrepeso",
    version: 1,
    formula: "overweightPercent = overweightTotalKg ÷ producedKg",
    description: "Razão normalizada de sobrepeso sobre produção.",
    unit: "razão decimal (1 = 100%)",
    inputs: [input("overweightTotalKg", "kg", true, "Sobrepeso calculado."), input("producedKg", "kg", true, "Produção calculada.")],
    missingValueTreatment: "Produção 0 gera 0; valor acima de 1 não é ocultado e indica dado inconsistente.",
    evidence: productionEvidence,
    status: "ACTIVE"
  },
  {
    id: ruleIds.totalLosses,
    name: "Perdas totais derivadas da produção",
    version: 1,
    formula: "totalLossesKg = weighingLossKg + generatedReworkKg + overweightTotalKg",
    description: "Soma componentes derivados do lançamento; perdas independentes ficam no módulo de perdas.",
    unit: "kg",
    inputs: [input("weighingLossKg", "kg", false, "Perda de pesagem."), input("generatedReworkKg", "kg", false, "Reforma gerada."), input("overweightTotalKg", "kg", true, "Sobrepeso calculado.")],
    missingValueTreatment: "Componente ausente, inválido ou negativo vira 0.",
    evidence: ["apps/api/src/domain/calculations/production-calculations.ts (regra operacional anterior ao catálogo)."],
    status: "REVIEW_REQUIRED",
    ambiguity: "Planilha distribui perdas em abas distintas. Homologação deve confirmar se reforma gerada deve compor perda total executiva."
  },
  ...[
    [ruleIds.productionCost, "Custo da produção", "productionCost = producedKg × unitPricePerKg", "producedKg", "Produção calculada."],
    [ruleIds.weighingLossCost, "Custo da perda de pesagem", "lossesCost = weighingLossKg × unitPricePerKg", "weighingLossKg", "Perda de pesagem."],
    [ruleIds.overweightCost, "Custo do sobrepeso", "overweightCost = overweightKg × unitPricePerKg", "overweightKg", "Sobrepeso calculado."]
  ].map(([id, name, formula, quantity, quantityDescription]) => ({
    id: id as CalculationRuleId,
    name,
    version: 1,
    formula,
    description: `${name} usando preço vigente preservado no lançamento.`,
    unit: "moeda",
    inputs: [input(quantity, "kg", true, quantityDescription), input("unitPricePerKg", "moeda/kg", true, "Preço vigente do produto.")],
    missingValueTreatment: "Entrada ausente, inválida ou negativa vira Decimal(0); resultado monetário arredondado para 2 casas.",
    evidence: financialEvidence,
    status: "ACTIVE" as const
  })),
  {
    id: ruleIds.packagingFilmUsed,
    name: "Filme utilizado",
    version: 1,
    formula: "filmUsedKg = packedBoxes × packagesPerBox × packageFilmWeightG ÷ 1000",
    description: "Converte peso de filme por pacote em consumo total de filme.",
    unit: "kg",
    inputs: [input("packedBoxes", "caixa", false, "Caixas embaladas."), input("packagesPerBox", "pacote/caixa", false, "Pacotes por caixa."), input("packageFilmWeightG", "g/pacote", false, "Peso do filme por pacote.")],
    missingValueTreatment: "Entrada ausente, inválida ou negativa vira Decimal(0); resultado arredondado para 3 casas.",
    evidence: ["Relatórios - MAIO-JUNHO 2026.xlsx / CONTROLE DE PERDAS: T×U×W/1000.", ...financialEvidence],
    status: "ACTIVE"
  },
  {
    id: ruleIds.packagingLossCost,
    name: "Custo da perda registrada",
    version: 1,
    formula: "lossCost = quantityKg × unitCost",
    description: "Valora quantidade perdida pelo custo unitário vigente.",
    unit: "moeda",
    inputs: [input("quantityKg", "kg", true, "Quantidade perdida."), input("unitCost", "moeda/kg", true, "Custo unitário aplicável.")],
    missingValueTreatment: "Entrada ausente, inválida ou negativa vira Decimal(0); resultado arredondado para 2 casas.",
    evidence: ["Relatórios - MAIO-JUNHO 2026.xlsx / CONTROLE DE PERDAS: X×Y.", ...financialEvidence],
    status: "ACTIVE"
  },
  {
    id: ruleIds.packagingFilmValue,
    name: "Valor do filme utilizado",
    version: 1,
    formula: "filmUsedValue = filmUsedKg × filmCostPerKg",
    description: "Valora filme consumido pelo custo vigente.",
    unit: "moeda",
    inputs: [input("filmUsedKg", "kg", true, "Filme calculado."), input("filmCostPerKg", "moeda/kg", true, "Preço vigente do filme.")],
    missingValueTreatment: "Entrada ausente, inválida ou negativa vira Decimal(0); resultado arredondado para 2 casas.",
    evidence: financialEvidence,
    status: "ACTIVE"
  },
  {
    id: ruleIds.packagingResult,
    name: "Resultado financeiro da embalagem",
    version: 1,
    formula: "financialResult = filmUsedValue − lossCost",
    description: "Diferença entre valor de filme calculado e custo da perda.",
    unit: "moeda",
    inputs: [input("filmUsedValue", "moeda", true, "Valor do filme usado."), input("lossCost", "moeda", true, "Custo da perda.")],
    missingValueTreatment: "Entrada ausente ou inválida vira Decimal(0); resultado arredondado para 2 casas.",
    evidence: ["Relatórios - MAIO-JUNHO 2026.xlsx / CONTROLE DE PERDAS: Z−AA.", ...financialEvidence],
    status: "ACTIVE"
  },
  {
    id: ruleIds.lossResult,
    name: "Resultado financeiro da perda",
    version: 1,
    formula: "financialResult = −lossCost",
    description: "Representa como impacto negativo o custo de uma perda sem cálculo de filme.",
    unit: "moeda",
    inputs: [input("lossCost", "moeda", true, "Custo calculado da perda.")],
    missingValueTreatment: "Entrada ausente ou inválida vira Decimal(0); resultado arredondado para 2 casas.",
    evidence: ["apps/api/src/modules/losses/losses.service.ts (comportamento operacional anterior ao catálogo)."],
    status: "ACTIVE"
  },
  {
    id: ruleIds.lossTotal,
    name: "Total de perdas agrupadas",
    version: 1,
    formula: "totalKg = Σ max(quantityKg, 0)",
    description: "Soma perdas não negativas dos grupos selecionados.",
    unit: "kg",
    inputs: [input("losses[].quantityKg", "kg", true, "Quantidade de cada grupo.")],
    missingValueTreatment: "Lista vazia gera 0; quantidade inválida ou negativa vira 0.",
    evidence: ["Relatórios - MAIO-JUNHO 2026.xlsx / CONTROLE DE PERDAS: SUM e SUMIFS por tipo.", "apps/api/src/domain/calculations/loss-calculations.ts."],
    status: "ACTIVE"
  },
  {
    id: ruleIds.lossShare,
    name: "Participação do grupo de perda",
    version: 1,
    formula: "bucketPercent = clamp(bucketKg ÷ totalKg, 0, 1)",
    description: "Participação normalizada do grupo no total selecionado.",
    unit: "ratio 0..1",
    inputs: [input("bucketKg", "kg", true, "Quantidade do grupo."), input("totalKg", "kg", true, "Total agrupado.")],
    missingValueTreatment: "Total 0 gera participação 0.",
    evidence: ["Relatórios - MAIO-JUNHO 2026.xlsx / PARADAS e dashboards: participação via valor/SUM(total).", "apps/api/src/domain/calculations/loss-calculations.ts."],
    status: "ACTIVE"
  },
  ...[
    [ruleIds.availableMinutes, "Minutos disponíveis", "availableMinutes = productionEnd − productionStart", "min"],
    [ruleIds.stoppedMinutes, "Minutos parados", "stoppedMinutes = min(downtimeEnd − downtimeStart, availableMinutes)", "min"],
    [ruleIds.productiveMinutes, "Minutos produtivos", "productiveMinutes = max(availableMinutes − stoppedMinutes, 0)", "min"],
    [ruleIds.stoppedPercent, "Percentual parado", "stoppedPercent = clamp(stoppedMinutes ÷ availableMinutes, 0, 1)", "ratio 0..1"],
    [ruleIds.efficiencyPercent, "Eficiência temporal", "efficiencyPercent = clamp(productiveMinutes ÷ availableMinutes, 0, 1)", "ratio 0..1"],
    [ruleIds.realKgHour, "Produção real por hora disponível", "realKgHour = producedMassKg ÷ (availableMinutes ÷ 60)", "kg/h"],
    [ruleIds.possibleKgHour, "Produção por hora produtiva", "possibleKgHour = producedMassKg ÷ (productiveMinutes ÷ 60)", "kg/h"]
  ].map(([id, name, formula, unit]) => ({
    id: id as CalculationRuleId,
    name,
    version: 1,
    formula,
    description: `${name} calculado no backend a partir dos intervalos registrados.`,
    unit,
    inputs: [input("productionStart/End", "DateTime", true, "Intervalo disponível."), input("downtimeStart/End", "DateTime", true, "Intervalo parado."), input("producedMassKg", "kg", false, "Massa produzida.")],
    missingValueTreatment: "Datas inválidas são rejeitadas pelo DTO/serviço; divisor 0 gera 0 e inconsistência.",
    evidence: ["Relatórios - MAIO-JUNHO 2026.xlsx / relatorios de paradas: MOD(fim−início,1).", "apps/api/src/domain/calculations/downtime-calculations.ts."],
    status: "ACTIVE" as const
  })),
  {
    id: ruleIds.downtimeStatus,
    name: "Classificação da parada",
    version: 1,
    formula: "OK < 0.05; MEDIUM < 0.10; ATTENTION < 0.20; CRITICAL ≥ 0.20",
    description: "Classifica percentual parado com limites legados do backend.",
    unit: "status",
    inputs: [input("stoppedPercent", "ratio 0..1", true, "Percentual parado.")],
    missingValueTreatment: "Percentual inválido vira 0 e resulta OK.",
    evidence: ["apps/api/src/domain/calculations/downtime-calculations.ts (limites existentes)."],
    status: "REVIEW_REQUIRED",
    ambiguity: "Limites não foram confirmados na planilha. Devem migrar para metas/configuração aprovada antes da certificação operacional."
  },
  {
    id: ruleIds.productivityKgHour,
    name: "Produtividade em kg por hora",
    version: 1,
    formula: "kgPerHour = producedKg ÷ (productiveMinutes ÷ 60)",
    description: "Fonte oficial proposta pelo PROMPT MESTRE para produtividade automática.",
    unit: "kg/h",
    inputs: [input("producedKg", "kg", true, "Produção aprovada."), input("productiveMinutes", "min", true, "Tempo produtivo calculado.")],
    missingValueTreatment: "Tempo produtivo 0 gera 0.",
    evidence: ["PROMPT MESTRE, seção 7: Produtividade = quilogramas produzidos ÷ horas produtivas.", "apps/api/src/domain/calculations/productivity-calculations.ts."],
    status: "ACTIVE"
  },
  {
    id: ruleIds.productivityKgDay,
    name: "Média produzida por dia trabalhado",
    version: 1,
    formula: "averageKgPerDay = producedKg ÷ workedDays",
    description: "Média semanal por datas distintas com produção aprovada.",
    unit: "kg/dia",
    inputs: [input("producedKg", "kg", true, "Produção total."), input("workedDays", "dia", true, "Quantidade de dias distintos.")],
    missingValueTreatment: "Dias 0 gera 0.",
    evidence: ["Relatórios - MAIO-JUNHO 2026.xlsx / BANCO DE DADOS PRODV.: soma de produção e contagem de datas.", "apps/api/src/domain/calculations/productivity-calculations.ts."],
    status: "ACTIVE"
  },
  {
    id: ruleIds.dosageAverage,
    name: "Média das amostras de dosagem",
    version: 1,
    formula: "averageWeightG = Σ sampleWeightG ÷ sampleCount",
    description: "Média aritmética das pesagens amostrais.",
    unit: "g",
    inputs: [input("sampleWeightsG", "g[]", true, "Pesagens positivas; mínimo 1 amostra.")],
    missingValueTreatment: "Lista vazia é rejeitada pelo schema; valores inválidos ou não positivos são rejeitados.",
    evidence: ["apps/api/src/modules/dosage/dosage.service.ts (regra existente extraída para domínio)."],
    status: "ACTIVE"
  },
  {
    id: ruleIds.dosageStdDev,
    name: "Desvio padrão populacional das amostras",
    version: 1,
    formula: "standardDeviationG = sqrt(Σ(sampleWeightG − averageWeightG)² ÷ sampleCount)",
    description: "Desvio padrão populacional, preservando divisor N da implementação existente.",
    unit: "g",
    inputs: [input("sampleWeightsG", "g[]", true, "Pesagens positivas."), input("averageWeightG", "g", true, "Média calculada.")],
    missingValueTreatment: "Lista vazia é rejeitada; uma amostra produz desvio 0.",
    evidence: ["apps/api/src/modules/dosage/dosage.service.ts (regra existente extraída para domínio)."],
    status: "REVIEW_REQUIRED",
    ambiguity: "Planilha não confirmou se desvio esperado é populacional (N) ou amostral (N−1)."
  },
  {
    id: ruleIds.dosageOverweight,
    name: "Sobrepeso médio da dosagem",
    version: 1,
    formula: "overweightG = max(averageWeightG − targetWeightG, 0)",
    description: "Excesso da média amostral sobre peso alvo.",
    unit: "g",
    inputs: [input("averageWeightG", "g", true, "Média amostral."), input("targetWeightG", "g", true, "Peso alvo do produto.")],
    missingValueTreatment: "Peso alvo inválido deve ser rejeitado no cadastro; subpeso gera 0.",
    evidence: ["apps/api/src/modules/dosage/dosage.service.ts (regra existente extraída para domínio)."],
    status: "ACTIVE"
  },
  {
    id: ruleIds.overweightRankingPercent,
    name: "Percentual agregado de sobrepeso",
    version: 1,
    formula: "overweightPercent = Σ overweightKg ÷ Σ producedKg",
    description: "Razão ponderada usada no ranking por produto.",
    unit: "ratio 0..1",
    inputs: [input("overweightKg", "kg", true, "Sobrepeso agregado."), input("producedKg", "kg", true, "Produção agregada.")],
    missingValueTreatment: "Produção 0 gera 0.",
    evidence: ["apps/api/src/modules/overweight/overweight.service.ts (regra existente extraída para domínio)."],
    status: "ACTIVE"
  },
  {
    id: ruleIds.overweightRankingStatus,
    name: "Classificação agregada de sobrepeso",
    version: 1,
    formula: "CRITICAL se percent > 2×tolerance; ATTENTION se percent > tolerance; senão OK",
    description: "Compara razão agregada à tolerância do cadastro do produto.",
    unit: "status",
    inputs: [input("overweightPercent", "ratio 0..1", true, "Percentual agregado."), input("tolerancePercent", "ratio 0..1", true, "Tolerância cadastrada.")],
    missingValueTreatment: "Tolerância ausente não recebe valor presumido; serviço envia 0 e regra sinaliza qualquer excesso.",
    evidence: ["apps/api/src/modules/overweight/overweight.service.ts (regra existente extraída para domínio)."],
    status: "REVIEW_REQUIRED",
    ambiguity: "Multiplicador crítico 2 não foi localizado como fórmula homologada na planilha."
  },
  {
    id: ruleIds.dashboardCostPerKg,
    name: "Custo médio por kg",
    version: 1,
    formula: "costPerKg = productionCost ÷ productionTotalKg",
    description: "Custo agregado da produção por kg aprovado.",
    unit: "moeda/kg",
    inputs: [input("productionCost", "moeda", true, "Custo agregado."), input("productionTotalKg", "kg", true, "Produção agregada.")],
    missingValueTreatment: "Produção 0 gera Decimal(0); resultado arredondado para 4 casas.",
    evidence: ["apps/api/src/modules/dashboard/dashboard.service.ts (regra existente extraída para domínio)."],
    status: "ACTIVE"
  },
  {
    id: ruleIds.dashboardLossPercent,
    name: "Percentual agregado de perdas",
    version: 1,
    formula: "lossPercent = lossesTotalKg ÷ productionTotalKg",
    description: "Razão entre perdas aprovadas e produção aprovada.",
    unit: "ratio 0..1",
    inputs: [input("lossesTotalKg", "kg", true, "Perdas agregadas."), input("productionTotalKg", "kg", true, "Produção agregada.")],
    missingValueTreatment: "Produção 0 gera 0.",
    evidence: ["apps/api/src/modules/dashboard/dashboard.service.ts (regra existente extraída para domínio)."],
    status: "ACTIVE"
  },
  {
    id: ruleIds.dashboardTotalImpact,
    name: "Impacto financeiro total",
    version: 1,
    formula: "totalImpactCost = lossesCost + overweightCost",
    description: "Soma custos aprovados de perdas e sobrepeso usando Decimal.",
    unit: "moeda",
    inputs: [input("lossesCost", "moeda", true, "Custo de perdas."), input("overweightCost", "moeda", true, "Custo de sobrepeso.")],
    missingValueTreatment: "Entrada ausente ou inválida vira Decimal(0); resultado arredondado para 2 casas.",
    evidence: ["apps/api/src/modules/dashboard/dashboard.service.ts (regra existente extraída para domínio)."],
    status: "ACTIVE"
  },
  {
    id: ruleIds.dashboardVariation,
    name: "Variação relativa entre períodos",
    version: 1,
    formula: "relativeVariation = (currentValue − previousValue) ÷ previousValue",
    description: "Variação analítica assinada; não é persistida como percentual operacional limitado.",
    unit: "ratio assinado",
    inputs: [input("currentValue", "unidade da métrica", true, "Valor atual."), input("previousValue", "unidade da métrica", true, "Valor anterior.")],
    missingValueTreatment: "Anterior 0 e atual 0 gera 0; anterior 0 e atual diferente gera null por variação indefinida.",
    evidence: ["apps/api/src/modules/dashboard/dashboard.service.ts (regra existente extraída para domínio)."],
    status: "ACTIVE"
  }
];

const frozenRules = rules.map((rule) => Object.freeze({
  ...rule,
  inputs: Object.freeze(rule.inputs.map((item) => Object.freeze({ ...item }))),
  evidence: Object.freeze([...rule.evidence])
}));

export const CALCULATION_RULES: Readonly<Record<CalculationRuleId, CalculationRuleDefinition>> = Object.freeze(
  Object.fromEntries(frozenRules.map((rule) => [rule.id, rule])) as Record<CalculationRuleId, CalculationRuleDefinition>
);

export const CALCULATION_RULE_IDS = Object.freeze(ruleIds);

export function getCalculationRule(id: CalculationRuleId): CalculationRuleDefinition {
  return CALCULATION_RULES[id];
}

export function calculationRuleVersions(...ids: CalculationRuleId[]): CalculationRuleVersions {
  return Object.freeze(Object.fromEntries(ids.map((id) => [id, CALCULATION_RULES[id].version])));
}

export function mergeCalculationRuleVersions(...sets: CalculationRuleVersions[]): CalculationRuleVersions {
  return Object.freeze(Object.assign({}, ...sets));
}
