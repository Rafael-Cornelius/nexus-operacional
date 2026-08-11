import { CalculationRuleVersions } from "./rule-registry";

export type SectorCode = "P1" | "P2";
export type AlertStatus = "OK" | "MEDIUM" | "ATTENTION" | "CRITICAL";
export type ProductionFormula = "BOX_WEIGHT" | "PACKAGE_WEIGHT";

export interface ProductWeightConfig {
  formula: ProductionFormula;
  packageWeightKg: number;
  boxWeightKg: number;
  packagesPerBox: number;
  massWeightKg: number;
  targetPackageWeightG: number;
  overweightTolerancePercent: number;
}

export interface ProductionCalculationInput {
  sector: SectorCode;
  plannedBatches: number;
  realizedBatches: number;
  usedReworkKg?: number | null;
  packedBoxes: number;
  weighingLossKg?: number | null;
  generatedReworkKg?: number | null;
  averagePackageWeightG?: number | null;
  weightConfig: ProductWeightConfig;
}

export interface ProductionCalculationResult {
  producedKg: number;
  expectedYieldKg: number;
  realYieldPercent: number;
  planAttainmentPercent: number;
  planDifferenceBatches: number;
  packageCount: number;
  overweightGPerPackage: number;
  overweightTotalKg: number;
  overweightPercent: number;
  totalLossesKg: number;
  inconsistencies: string[];
  calculationRuleVersions: CalculationRuleVersions;
}

export interface DowntimeCalculationInput {
  productionStart: Date;
  productionEnd: Date;
  downtimeStart: Date;
  downtimeEnd: Date;
  producedMassKg: number;
}

export interface DowntimeCalculationResult {
  availableMinutes: number;
  stoppedMinutes: number;
  productiveMinutes: number;
  stoppedPercent: number;
  efficiencyPercent: number;
  realKgHour: number;
  possibleKgHour: number;
  status: AlertStatus;
  inconsistencies: string[];
  calculationRuleVersions: CalculationRuleVersions;
}
