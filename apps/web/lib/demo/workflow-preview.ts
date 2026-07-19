import type { WorkflowStatus } from "@/lib/operational-workflow";

export const demoWorkflowWeek = {
  id: "demo-current",
  label: "Semana demonstrativa",
  year: 2026,
  month: 5,
  weekNumber: 1,
  status: "OPEN"
};

export const demoWorkflowProducts = [
  {
    id: "demo-product-p1",
    code: "72169",
    name: "Pão de queijo 13 g x 1 kg",
    active: true,
    pricePerKg: 5.6,
    defaultSector: { code: "P1" as const },
    weightConfig: {
      formula: "BOX_WEIGHT" as const,
      packageWeightKg: 1,
      boxWeightKg: 12,
      packagesPerBox: 12,
      massWeightKg: 511,
      targetPackageWeightG: 1000,
      overweightTolerancePercent: 0.02
    }
  },
  {
    id: "demo-product-p2",
    code: "84021",
    name: "Bolo congelado 2 kg",
    active: true,
    pricePerKg: 7.4,
    defaultSector: { code: "P2" as const },
    weightConfig: {
      formula: "BOX_WEIGHT" as const,
      packageWeightKg: 2,
      boxWeightKg: 2,
      packagesPerBox: 1,
      massWeightKg: 0.582,
      targetPackageWeightG: 2000,
      overweightTolerancePercent: 0.02
    }
  }
];

export const demoWorkflowLossTypes = [
  { id: "demo-loss-packaging", name: "Embalagem" },
  { id: "demo-loss-weighing", name: "Pesagem" },
  { id: "demo-loss-process", name: "Processo" }
];

export const demoWorkflowDowntimeReasons = [
  { id: "demo-reason-mass", name: "Aguardando massa" },
  { id: "demo-reason-setup", name: "Setup/troca de produto" },
  { id: "demo-reason-cleaning", name: "Limpeza" }
];

function workflow(status: WorkflowStatus, version: number, rejectionReason?: string) {
  return {
    workflowStatus: status,
    version,
    rejectionReason: rejectionReason ?? null
  };
}

export function createDemoProductionEntries(sector: "P1" | "P2") {
  const product = demoWorkflowProducts.find((item) => item.defaultSector.code === sector) ?? demoWorkflowProducts[0];
  const factor = sector === "P1" ? 1 : 0.48;
  return [
    { id: `demo-production-${sector}-draft`, date: "2026-05-04T00:00:00.000Z", productionOrder: `${sector}-260504-A`, packedBoxes: 420, producedKg: 5040 * factor, expectedYieldKg: 5110 * factor, realYieldPercent: 0.986, overweightTotalKg: 7.2 * factor, productionCost: 28224 * factor, lossesCost: 31.4, overweightCost: 40.32, status: "OK", product, ...workflow("DRAFT", 1) },
    { id: `demo-production-${sector}-submitted`, date: "2026-05-05T00:00:00.000Z", productionOrder: `${sector}-260505-B`, packedBoxes: 385, producedKg: 4620 * factor, expectedYieldKg: 4701 * factor, realYieldPercent: 0.983, overweightTotalKg: 9.1 * factor, productionCost: 25872 * factor, lossesCost: 42.8, overweightCost: 50.96, status: "MEDIUM", product, ...workflow("SUBMITTED", 2) },
    { id: `demo-production-${sector}-approved`, date: "2026-05-06T00:00:00.000Z", productionOrder: `${sector}-260506-C`, packedBoxes: 456, producedKg: 5472 * factor, expectedYieldKg: 5621 * factor, realYieldPercent: 0.973, overweightTotalKg: 6.4 * factor, productionCost: 30643.2 * factor, lossesCost: 28, overweightCost: 35.84, status: "OK", product, ...workflow("APPROVED", 3) },
    { id: `demo-production-${sector}-rejected`, date: "2026-05-07T00:00:00.000Z", productionOrder: `${sector}-260507-D`, packedBoxes: 350, producedKg: 4200 * factor, expectedYieldKg: 4480 * factor, realYieldPercent: 0.938, overweightTotalKg: 12.3 * factor, productionCost: 23520 * factor, lossesCost: 61.6, overweightCost: 68.88, status: "ATTENTION", product, ...workflow("REJECTED", 2, "Conferir quantidade de caixas informada.") }
  ];
}

export function createDemoLossEntries() {
  const product = demoWorkflowProducts[0];
  return [
    { id: "demo-loss-draft", date: "2026-05-04T00:00:00.000Z", quantityKg: 8.4, reason: "Ajuste de pesagem", sector: { code: "P1" }, lossType: demoWorkflowLossTypes[1], product, lossCost: 47.04, filmUsedKg: 0, financialResult: -47.04, ...workflow("DRAFT", 1) },
    { id: "demo-loss-submitted", date: "2026-05-05T00:00:00.000Z", quantityKg: 6.8, reason: "Filme danificado", sector: { code: "P1" }, lossType: demoWorkflowLossTypes[0], product, lossCost: 38.08, filmUsedKg: 1.2, financialResult: -38.08, ...workflow("SUBMITTED", 2) },
    { id: "demo-loss-approved", date: "2026-05-06T00:00:00.000Z", quantityKg: 11.2, reason: "Perda de processo", sector: { code: "P2" }, lossType: demoWorkflowLossTypes[2], product: demoWorkflowProducts[1], lossCost: 82.88, filmUsedKg: 0, financialResult: -82.88, ...workflow("APPROVED", 3) },
    { id: "demo-loss-rejected", date: "2026-05-07T00:00:00.000Z", quantityKg: 15.6, reason: "Quebra operacional", sector: { code: "P1" }, lossType: demoWorkflowLossTypes[2], product, lossCost: 87.36, filmUsedKg: 0, financialResult: -87.36, ...workflow("REJECTED", 2, "Peso não confere com o apontamento da OP.") }
  ];
}

export function createDemoDowntimeEntries() {
  return [
    { id: "demo-downtime-draft", date: "2026-05-04T00:00:00.000Z", stoppedMinutes: 18, stoppedPercent: 0.0375, realKgHour: 812, possibleKgHour: 844, status: "OK", sector: { code: "P1" }, reason: demoWorkflowDowntimeReasons[0], ...workflow("DRAFT", 1) },
    { id: "demo-downtime-submitted", date: "2026-05-05T00:00:00.000Z", stoppedMinutes: 26, stoppedPercent: 0.0542, realKgHour: 765, possibleKgHour: 809, status: "MEDIUM", sector: { code: "P1" }, reason: demoWorkflowDowntimeReasons[1], ...workflow("SUBMITTED", 2) },
    { id: "demo-downtime-approved", date: "2026-05-06T00:00:00.000Z", stoppedMinutes: 12, stoppedPercent: 0.025, realKgHour: 886, possibleKgHour: 909, status: "OK", sector: { code: "P2" }, reason: demoWorkflowDowntimeReasons[2], ...workflow("APPROVED", 3) },
    { id: "demo-downtime-rejected", date: "2026-05-07T00:00:00.000Z", stoppedMinutes: 34, stoppedPercent: 0.0708, realKgHour: 702, possibleKgHour: 755, status: "ATTENTION", sector: { code: "P1" }, reason: demoWorkflowDowntimeReasons[0], ...workflow("REJECTED", 2, "Revisar horário final da parada.") }
  ];
}
