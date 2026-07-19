import "reflect-metadata";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { calculatePackagingLoss } from "../../apps/api/src/domain/calculations/financial-calculations";
import { CALCULATION_RULE_IDS } from "../../apps/api/src/domain/calculations/rule-registry";
import { DosageService } from "../../apps/api/src/modules/dosage/dosage.service";

const repoRoot = process.cwd();

function source(path: string) {
  return readFileSync(join(repoRoot, path), "utf8");
}

function modelBody(schema: string, model: string) {
  const match = schema.match(new RegExp(`model ${model} \\{([\\s\\S]*?)\\n\\}`));
  if (!match) throw new Error(`Model ${model} not found.`);
  return match[1];
}

describe("calculation rule version persistence", () => {
  it("adds a non-null JSON snapshot with an honest empty default to every critical table", () => {
    const schema = source("prisma/schema.prisma");
    const field = /calculationRuleVersions\s+Json\s+@default\("\{\}"\)\s+@map\("calculation_rule_versions"\)/;

    for (const model of ["ProductionEntry", "LossEntry", "DowntimeEntry", "ProductivityEntry", "DosageCheck"]) {
      expect(modelBody(schema, model)).toMatch(field);
    }

    const migration = source("prisma/migrations/0014_calculation_rule_versions/migration.sql");
    for (const table of ["production_entries", "loss_entries", "downtime_entries", "productivity_entries", "dosage_checks"]) {
      expect(migration).toContain(`ALTER TABLE "${table}"`);
    }
    expect(migration.match(/ADD COLUMN "calculation_rule_versions" JSONB NOT NULL DEFAULT '\{\}'::jsonb;/g)).toHaveLength(5);
  });

  it("distinguishes the rule snapshot for a plain loss from packaging calculations", () => {
    const result = calculatePackagingLoss({ quantityKg: "4", unitCost: "2.50" });

    expect(result.lossCostCalculationRuleVersions).toEqual({
      [CALCULATION_RULE_IDS.packagingLossCost]: 1
    });
    expect(result.lossOnlyCalculationRuleVersions).toEqual({
      [CALCULATION_RULE_IDS.packagingLossCost]: 1,
      [CALCULATION_RULE_IDS.lossResult]: 1
    });
    expect(result.lossOnlyCalculationRuleVersions).not.toHaveProperty(CALCULATION_RULE_IDS.packagingFilmUsed);
  });

  it("persists dosage rules actually executed when a check is created", async () => {
    const create = vi.fn().mockImplementation(({ data }) => Promise.resolve({ id: "dosage-1", ...data }));
    const audit = vi.fn().mockResolvedValue(undefined);
    const service = new DosageService({
      weeklyPeriod: {
        findUnique: vi.fn().mockResolvedValue({
          id: "11111111-1111-4111-8111-111111111111",
          status: "OPEN",
          startsOn: new Date("2026-05-04T00:00:00.000Z"),
          endsOn: new Date("2026-05-10T00:00:00.000Z"),
          deletedAt: null
        })
      },
      product: {
        findUnique: vi.fn().mockResolvedValue({
          id: "22222222-2222-4222-8222-222222222222",
          deletedAt: null,
          weightConfig: { targetPackageWeightG: 1000 }
        })
      },
      dosageCheck: { create }
    } as never, { record: audit } as never);

    await service.create({
      weekId: "11111111-1111-4111-8111-111111111111",
      productId: "22222222-2222-4222-8222-222222222222",
      sector: "P1",
      date: "2026-05-05",
      sampleWeightsG: [990, 1000, 1010]
    });

    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        calculationRuleVersions: {
          [CALCULATION_RULE_IDS.dosageAverage]: 1,
          [CALCULATION_RULE_IDS.dosageStdDev]: 1,
          [CALCULATION_RULE_IDS.dosageOverweight]: 1
        }
      })
    }));
  });

  it("wires snapshots into operational writes and reviewed import promotion", () => {
    const expectedWrites = [
      ["apps/api/src/modules/production/production.service.ts", 3],
      ["apps/api/src/modules/losses/losses.service.ts", 2],
      ["apps/api/src/modules/downtime/downtime.service.ts", 2],
      ["apps/api/src/modules/dosage/dosage.service.ts", 1],
      ["apps/api/src/modules/import/import-promotion.service.ts", 3]
    ] as const;

    for (const [path, minimum] of expectedWrites) {
      const assignments = source(path).match(/calculationRuleVersions:\s/g) ?? [];
      expect(assignments.length, path).toBeGreaterThanOrEqual(minimum);
    }
  });
});
