import { round, safeDivide } from "./safe-number";
import { CALCULATION_RULE_IDS, calculationRuleVersions } from "./rule-registry";

export function calculateKgPerHour(producedKg: number, productiveMinutes: number): number {
  return round(safeDivide(producedKg, productiveMinutes / 60), 3);
}

export function calculateAverageKgPerDay(producedKg: number, workedDays: number): number {
  return round(safeDivide(producedKg, workedDays), 3);
}

export const PRODUCTIVITY_ENTRY_CALCULATION_RULE_VERSIONS = calculationRuleVersions(
  CALCULATION_RULE_IDS.productivityKgHour
);

export const PRODUCTIVITY_SUMMARY_CALCULATION_RULE_VERSIONS = calculationRuleVersions(
  CALCULATION_RULE_IDS.productivityKgDay
);
