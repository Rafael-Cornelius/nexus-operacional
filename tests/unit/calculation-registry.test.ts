import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { calculateDosage } from "../../apps/api/src/domain/calculations/dosage-calculations";
import {
  calculateDashboardFinancials,
  calculatePackagingLoss,
  calculateProductionCosts
} from "../../apps/api/src/domain/calculations/financial-calculations";
import { calculateLossPercent, calculateRelativeVariation } from "../../apps/api/src/domain/calculations/dashboard-calculations";
import { calculateDowntime } from "../../apps/api/src/domain/calculations/downtime-calculations";
import { summarizeLossBuckets } from "../../apps/api/src/domain/calculations/loss-calculations";
import { calculateOverweightRanking } from "../../apps/api/src/domain/calculations/overweight-calculations";
import { calculatePlanPerformance, calculateProductionEntry } from "../../apps/api/src/domain/calculations/production-calculations";
import { calculateAverageKgPerDay, calculateKgPerHour } from "../../apps/api/src/domain/calculations/productivity-calculations";
import {
  CALCULATION_RULE_IDS,
  CALCULATION_RULES,
  getCalculationRule
} from "../../apps/api/src/domain/calculations/rule-registry";

const weightConfig = {
  formula: "BOX_WEIGHT" as const,
  packageWeightKg: 1,
  boxWeightKg: 12,
  packagesPerBox: 12,
  massWeightKg: 511,
  targetPackageWeightG: 1000,
  overweightTolerancePercent: 0.02
};
const repoRoot = process.cwd();

describe("versioned calculation registry", () => {
  it("publishes complete, unique and immutable metadata for every registered rule", () => {
    const rules = Object.values(CALCULATION_RULES);
    expect(rules.length).toBeGreaterThanOrEqual(35);
    expect(new Set(rules.map((rule) => rule.id)).size).toBe(rules.length);

    for (const rule of rules) {
      expect(rule.id.length).toBeGreaterThan(3);
      expect(rule.name.length).toBeGreaterThan(3);
      expect(rule.version).toBeGreaterThan(0);
      expect(rule.formula.length).toBeGreaterThan(3);
      expect(rule.description.length).toBeGreaterThan(3);
      expect(rule.unit.length).toBeGreaterThan(0);
      expect(rule.inputs.length).toBeGreaterThan(0);
      expect(rule.missingValueTreatment.length).toBeGreaterThan(3);
      expect(rule.evidence.length).toBeGreaterThan(0);
      expect(Object.isFrozen(rule)).toBe(true);
      expect(Object.isFrozen(rule.inputs)).toBe(true);
      expect(Object.isFrozen(rule.evidence)).toBe(true);
    }
  });

  it("resolves the exact active version used by a production execution", () => {
    const result = calculateProductionEntry({
      sector: "P1",
      plannedBatches: 10,
      realizedBatches: 9,
      packedBoxes: 300,
      weightConfig
    });

    for (const [id, version] of Object.entries(result.calculationRuleVersions)) {
      expect(getCalculationRule(id as keyof typeof CALCULATION_RULES).version).toBe(version);
    }
    expect(result.calculationRuleVersions[CALCULATION_RULE_IDS.producedKgBox]).toBe(1);
  });

  it("keeps critical production and financial formulas out of operational frontend components", () => {
    const productionForm = readFileSync(join(repoRoot, "apps/web/components/forms/production-form.tsx"), "utf8");
    const dashboard = readFileSync(join(repoRoot, "apps/web/components/dashboard/executive-dashboard.tsx"), "utf8");
    expect(productionForm).not.toContain("const localPreview");
    expect(productionForm).not.toMatch(/producedKg\s*\/|producedKg\s*\*/);
    expect(productionForm).not.toMatch(/productionCost:\s*[^,]+\*/);
    expect(dashboard).not.toContain("item.lossesCost + item.overweightCost");
  });
});

describe("operational percentages in decimal scale", () => {
  it("keeps overachievement visible instead of silently capping it", () => {
    expect(calculatePlanPerformance(10, 12)).toMatchObject({
      planAttainmentPercent: 1.2,
      planDifferenceBatches: 2
    });

    const result = calculateProductionEntry({
      sector: "P2",
      plannedBatches: 1,
      realizedBatches: 1,
      packedBoxes: 2,
      weightConfig: { ...weightConfig, boxWeightKg: 12, massWeightKg: 10 }
    });
    expect(result.realYieldPercent).toBe(2.4);
  });

  it("keeps inconsistent loss and overweight ratios visible while downtime remains bounded by interval", () => {
    expect(calculateLossPercent(200, 100)).toBe(2);
    expect(calculateOverweightRanking(200, 100, 0.02).overweightPercent).toBe(2);
    const downtime = calculateDowntime({
      productionStart: new Date("2026-05-01T08:00:00Z"),
      productionEnd: new Date("2026-05-01T09:00:00Z"),
      downtimeStart: new Date("2026-05-01T08:00:00Z"),
      downtimeEnd: new Date("2026-05-01T10:00:00Z"),
      producedMassKg: 100
    });
    expect(downtime.stoppedPercent).toBe(1);
    expect(downtime.efficiencyPercent).toBe(0);
  });

  it("documents without resolving the P1 Excel versus backend yield conflict", () => {
    const backend = calculateProductionEntry({
      sector: "P1",
      plannedBatches: 5,
      realizedBatches: 5,
      usedReworkKg: 325,
      packedBoxes: 202,
      weightConfig: { ...weightConfig, massWeightKg: 491.7 }
    });
    const excelExpectedKg = 5 * 491.7;
    const excelYield = 2424 / excelExpectedKg;

    expect(backend.producedKg).toBe(2424);
    expect(backend.expectedYieldKg).toBe(2783.5);
    expect(backend.realYieldPercent).toBe(0.870846);
    expect(excelExpectedKg).toBe(2458.5);
    expect(excelYield).toBeCloseTo(0.985967, 6);
    expect(getCalculationRule(CALCULATION_RULE_IDS.expectedYieldKg).status).toBe("REVIEW_REQUIRED");
    expect(getCalculationRule(CALCULATION_RULE_IDS.expectedYieldKg).ambiguity).toContain("OP 23334");
  });
});

describe("Decimal financial calculations", () => {
  it("performs production monetary arithmetic with Decimal and declared precision", () => {
    const costs = calculateProductionCosts({
      producedKg: "0.1",
      weighingLossKg: "0.2",
      overweightKg: "0.3",
      pricePerKg: "0.2"
    });
    expect(costs.productionCost).toBe(0.02);
    expect(costs.lossesCost).toBe(0.04);
    expect(costs.overweightCost).toBe(0.06);
  });

  it("calculates packaging and dashboard financial outputs without float multiplication", () => {
    const packaging = calculatePackagingLoss({
      quantityKg: "10.005",
      unitCost: "2.50",
      packedBoxes: "10",
      packagesPerBox: "12",
      packageFilmWeightG: "2.5",
      filmCostPerKg: "4.20"
    });
    expect(packaging.lossCost).toBe(25.01);
    expect(packaging.filmUsedKg).toBe(0.3);
    expect(packaging.filmUsedValue).toBe(1.26);
    expect(packaging.financialResult).toBe(-23.75);
    expect(packaging.lossOnlyFinancialResult).toBe(-25.01);

    expect(calculateDashboardFinancials({
      productionCost: "10.00",
      productionTotalKg: "4",
      lossesCost: "0.10",
      overweightCost: "0.20"
    })).toMatchObject({ totalImpactCost: 0.3, costPerKg: 2.5 });
  });
});

describe("dosage, losses and comparison rules", () => {
  it("preserves population standard deviation used by dosage", () => {
    expect(calculateDosage([990, 1000, 1010], 1000)).toMatchObject({
      sampleCount: 3,
      averageWeightG: 1000,
      standardDeviationG: 8.165,
      overweightG: 0
    });
    expect(() => calculateDosage([], 1000)).toThrow("Dosage calculation requires at least one sample.");
  });

  it("summarizes loss buckets and treats undefined relative baseline explicitly", () => {
    expect(summarizeLossBuckets([
      { type: "A", quantityKg: 3 },
      { type: "B", quantityKg: 1 }
    ])).toMatchObject({
      totalKg: 4,
      buckets: [{ type: "A", quantityKg: 3, percent: 0.75 }, { type: "B", quantityKg: 1, percent: 0.25 }]
    });
    expect(calculateRelativeVariation(10, 0)).toBeNull();
    expect(calculateRelativeVariation(0, 0)).toBe(0);
    expect(calculateRelativeVariation(12, 10)).toBe(0.2);
  });

  it("calculates productivity only from explicit production and time bases", () => {
    expect(calculateKgPerHour(120, 90)).toBe(80);
    expect(calculateKgPerHour(120, 0)).toBe(0);
    expect(calculateAverageKgPerDay(600, 3)).toBe(200);
    expect(calculateAverageKgPerDay(600, 0)).toBe(0);
  });

  it("supports the product-declared package-weight production formula", () => {
    const result = calculateProductionEntry({
      sector: "P2",
      plannedBatches: 2,
      realizedBatches: 2,
      packedBoxes: 10,
      averagePackageWeightG: 505,
      weightConfig: {
        ...weightConfig,
        formula: "PACKAGE_WEIGHT",
        packageWeightKg: 0.5,
        packagesPerBox: 20,
        massWeightKg: 50,
        targetPackageWeightG: 500
      }
    });
    expect(result.producedKg).toBe(100);
    expect(result.packageCount).toBe(200);
    expect(result.overweightTotalKg).toBe(1);
    expect(result.calculationRuleVersions[CALCULATION_RULE_IDS.producedKgPackage]).toBe(1);
  });
});
