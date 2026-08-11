import { DowntimeCalculationInput, DowntimeCalculationResult, AlertStatus } from "./types";
import { boundedRatio, nonNegative, round, safeDivide } from "./safe-number";
import { CALCULATION_RULE_IDS, calculationRuleVersions } from "./rule-registry";

function minutesBetween(start: Date, end: Date): number {
  return (end.getTime() - start.getTime()) / 60_000;
}

export function classifyDowntime(stoppedPercent: number): AlertStatus {
  if (stoppedPercent >= 0.2) return "CRITICAL";
  if (stoppedPercent >= 0.1) return "ATTENTION";
  if (stoppedPercent >= 0.05) return "MEDIUM";
  return "OK";
}

export function calculateDowntime(input: DowntimeCalculationInput): DowntimeCalculationResult {
  const inconsistencies: string[] = [];
  const availableMinutesRaw = minutesBetween(input.productionStart, input.productionEnd);
  const stoppedMinutesRaw = minutesBetween(input.downtimeStart, input.downtimeEnd);

  if (availableMinutesRaw < 0) {
    inconsistencies.push("Termino da producao menor que inicio da producao.");
  }
  if (stoppedMinutesRaw < 0) {
    inconsistencies.push("Termino da parada menor que inicio da parada.");
  }

  const availableMinutes = nonNegative(availableMinutesRaw);
  const stoppedMinutes = Math.min(nonNegative(stoppedMinutesRaw), availableMinutes);
  const productiveMinutes = nonNegative(availableMinutes - stoppedMinutes);
  const stoppedPercent = round(boundedRatio(stoppedMinutes, availableMinutes), 6);
  const efficiencyPercent = round(boundedRatio(productiveMinutes, availableMinutes), 6);
  const realKgHour = round(safeDivide(input.producedMassKg, availableMinutes / 60), 3);
  const possibleKgHour = round(safeDivide(input.producedMassKg, productiveMinutes / 60), 3);

  if (availableMinutes === 0) {
    inconsistencies.push("Tempo disponivel zerado.");
  }

  return {
    availableMinutes: round(availableMinutes, 2),
    stoppedMinutes: round(stoppedMinutes, 2),
    productiveMinutes: round(productiveMinutes, 2),
    stoppedPercent,
    efficiencyPercent,
    realKgHour,
    possibleKgHour,
    status: classifyDowntime(stoppedPercent),
    inconsistencies,
    calculationRuleVersions: calculationRuleVersions(
      CALCULATION_RULE_IDS.availableMinutes,
      CALCULATION_RULE_IDS.stoppedMinutes,
      CALCULATION_RULE_IDS.productiveMinutes,
      CALCULATION_RULE_IDS.stoppedPercent,
      CALCULATION_RULE_IDS.efficiencyPercent,
      CALCULATION_RULE_IDS.realKgHour,
      CALCULATION_RULE_IDS.possibleKgHour,
      CALCULATION_RULE_IDS.downtimeStatus
    )
  };
}
