export const demoDashboardKpis = {
  productionTotalKg: 18420,
  lossesTotalKg: 42,
  overweightTotalKg: 28,
  overweightPercent: 0.0015,
  averageYield: 0.972,
  stoppedMinutes: 64,
  averageRealKgHour: 846,
  averagePingandoKgHour: 912,
  records: 38,
  financial: {
    productionCost: 103152,
    lossesCost: 235.2,
    overweightCost: 156.8,
    totalImpactCost: 392,
    costPerKg: 5.6,
    lossPercent: 0.0023,
    packaging: {
      lostKg: 7.8,
      lossCost: 146.64,
      filmUsedKg: 318,
      filmUsedValue: 5978.4,
      financialResult: -146.64
    }
  },
  financialBySector: [
    { sector: "P1", producedKg: 12840, lossesKg: 29, overweightKg: 19, productionCost: 71904, lossesCost: 162.4, overweightCost: 106.4 },
    { sector: "P2", producedKg: 5580, lossesKg: 13, overweightKg: 9, productionCost: 31248, lossesCost: 72.8, overweightCost: 50.4 }
  ]
};

export const demoDashboardCharts = {
  productionBySector: [
    { sector: "P1", producedKg: 12840, lossesKg: 29, overweightKg: 19 },
    { sector: "P2", producedKg: 5580, lossesKg: 13, overweightKg: 9 }
  ],
  downtimeByReason: [
    { reason: "Aguardando massa", stoppedMinutes: 28 },
    { reason: "Setup", stoppedMinutes: 21 },
    { reason: "Limpeza", stoppedMinutes: 15 }
  ],
  lossesByType: [
    { type: "Massa", quantityKg: 19, lossCost: 106.4 },
    { type: "Embalagem", quantityKg: 13, lossCost: 72.8 },
    { type: "Processo", quantityKg: 10, lossCost: 56 }
  ]
};

export const demoDashboardComparison = {
  currentWeek: { id: "demo-current", label: "Semana demonstrativa" },
  previousWeek: { id: "demo-previous", label: "Semana demonstrativa anterior" },
  metrics: [
    { label: "Produção", key: "productionTotalKg", currentValue: 18420, previousValue: 17680, variationPercent: 0.0419, trend: "up" as const, improvesWhen: "up" as const },
    { label: "Perdas", key: "lossesTotalKg", currentValue: 42, previousValue: 51, variationPercent: -0.1765, trend: "up" as const, improvesWhen: "down" as const },
    { label: "Rendimento", key: "averageYield", currentValue: 0.972, previousValue: 0.958, variationPercent: 0.0146, trend: "up" as const, improvesWhen: "up" as const }
  ]
};

export const demoDashboardAlerts = [
  { goalId: "demo-goal-1", name: "Perdas totais", value: 42, target: 45, status: "OK", action: "Manter acompanhamento diário." },
  { goalId: "demo-goal-2", name: "Tempo parado", value: 64, target: 55, status: "ATTENTION", action: "Revisar espera por massa e tempo de setup." }
];

export function createDemoExecutiveDeck() {
  return {
    generatedAt: new Date().toISOString(),
    source: "demo-preview" as const,
    week: {
      id: "demo-current",
      label: "Semana demonstrativa",
      startsOn: "2026-05-04T00:00:00.000Z",
      endsOn: "2026-05-10T00:00:00.000Z",
      status: "OPEN"
    },
    slides: [
      { title: "Capa", kind: "cover", data: { weekId: "demo-current" } },
      { title: "Resumo executivo", kind: "kpis", data: demoDashboardKpis },
      { title: "Produção", kind: "production", data: demoDashboardCharts.productionBySector },
      { title: "Perdas e sobrepeso", kind: "losses", data: demoDashboardCharts.productionBySector },
      { title: "Paradas", kind: "downtime", data: demoDashboardCharts.downtimeByReason },
      { title: "Plano de ação", kind: "action-plan", data: demoDashboardAlerts.filter((alert) => alert.status !== "OK") }
    ]
  };
}
