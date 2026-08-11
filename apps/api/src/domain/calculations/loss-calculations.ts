import { boundedRatio, round } from "./safe-number";
import { CALCULATION_RULE_IDS, calculationRuleVersions } from "./rule-registry";

export interface LossBucket {
  type: string;
  quantityKg: number;
}

export function summarizeLossBuckets(losses: LossBucket[]) {
  const totalKg = round(losses.reduce((sum, loss) => sum + Math.max(loss.quantityKg, 0), 0), 3);
  return {
    totalKg,
    buckets: losses.map((loss) => ({
      ...loss,
      quantityKg: round(Math.max(loss.quantityKg, 0), 3),
      percent: round(boundedRatio(Math.max(loss.quantityKg, 0), totalKg), 6)
    })),
    calculationRuleVersions: calculationRuleVersions(
      CALCULATION_RULE_IDS.lossTotal,
      CALCULATION_RULE_IDS.lossShare
    )
  };
}

export function summarizeLosses(losses: LossBucket[]) {
  return summarizeLossBuckets(losses).buckets;
}
