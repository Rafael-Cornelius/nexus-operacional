import { round, safeDivide } from "./safe-number";
import { CALCULATION_RULE_IDS, calculationRuleVersions } from "./rule-registry";

export function calculateLossPercent(lossesTotalKg: number, productionTotalKg: number) {
  return round(safeDivide(lossesTotalKg, productionTotalKg), 6);
}

export function calculateRelativeVariation(currentValue: number, previousValue: number): number | null {
  if (previousValue === 0) return currentValue === 0 ? 0 : null;
  return round((currentValue - previousValue) / previousValue, 6);
}

export const DASHBOARD_CALCULATION_RULE_VERSIONS = calculationRuleVersions(
  CALCULATION_RULE_IDS.dashboardCostPerKg,
  CALCULATION_RULE_IDS.dashboardLossPercent,
  CALCULATION_RULE_IDS.dashboardTotalImpact,
  CALCULATION_RULE_IDS.dashboardVariation
);
