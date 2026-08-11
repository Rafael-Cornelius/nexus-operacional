import { asFiniteNumber, nonNegative, round } from "./safe-number";
import { CALCULATION_RULE_IDS, calculationRuleVersions } from "./rule-registry";

export function calculateDosage(sampleWeightsG: number[], targetWeightG: number) {
  const samples = sampleWeightsG.map((value) => nonNegative(asFiniteNumber(value)));
  if (samples.length === 0) {
    throw new Error("Dosage calculation requires at least one sample.");
  }

  const averageWeightG = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  const variance = samples.reduce((sum, value) => sum + (value - averageWeightG) ** 2, 0) / samples.length;
  const target = nonNegative(asFiniteNumber(targetWeightG));

  return {
    sampleCount: samples.length,
    averageWeightG: round(averageWeightG, 3),
    standardDeviationG: round(Math.sqrt(variance), 3),
    overweightG: round(Math.max(averageWeightG - target, 0), 3),
    calculationRuleVersions: calculationRuleVersions(
      CALCULATION_RULE_IDS.dosageAverage,
      CALCULATION_RULE_IDS.dosageStdDev,
      CALCULATION_RULE_IDS.dosageOverweight
    )
  };
}
