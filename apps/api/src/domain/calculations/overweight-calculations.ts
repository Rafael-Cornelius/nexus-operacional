import { asFiniteNumber, nonNegative, round, safeDivide } from "./safe-number";
import { CALCULATION_RULE_IDS, calculationRuleVersions } from "./rule-registry";

export const OVERWEIGHT_RANKING_CALCULATION_RULE_VERSIONS = calculationRuleVersions(
  CALCULATION_RULE_IDS.overweightRankingPercent,
  CALCULATION_RULE_IDS.overweightRankingStatus
);

export function calculateOverweightRanking(overweightKg: number, producedKg: number, tolerancePercent: number) {
  const overweight = nonNegative(asFiniteNumber(overweightKg));
  const produced = nonNegative(asFiniteNumber(producedKg));
  const tolerance = Math.min(nonNegative(asFiniteNumber(tolerancePercent)), 1);
  const overweightPercent = round(safeDivide(overweight, produced), 6);
  const status = overweightPercent > tolerance * 2 ? "CRITICAL" : overweightPercent > tolerance ? "ATTENTION" : "OK";

  return {
    overweightKg: overweight,
    producedKg: produced,
    overweightPercent,
    tolerancePercent: tolerance,
    status,
    calculationRuleVersions: OVERWEIGHT_RANKING_CALCULATION_RULE_VERSIONS
  };
}
