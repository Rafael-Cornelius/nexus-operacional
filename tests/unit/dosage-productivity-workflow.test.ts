import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DosageService } from "../../apps/api/src/modules/dosage/dosage.service";
import { ProductivityService } from "../../apps/api/src/modules/productivity/productivity.service";

const repoRoot = join(__dirname, "../..");
const weekId = "11111111-1111-4111-8111-111111111111";
const productId = "22222222-2222-4222-8222-222222222222";
const actor = { id: "33333333-3333-4333-8333-333333333333", roles: ["OPERATOR"] };
const week = {
  id: weekId,
  label: "2026-05 S1",
  startsOn: new Date("2026-05-04T00:00:00.000Z"),
  endsOn: new Date("2026-05-10T00:00:00.000Z"),
  status: "OPEN",
  deletedAt: null
};

function prismaWithTransaction<T extends Record<string, unknown>>(transaction: T) {
  return {
    ...transaction,
    $transaction: vi.fn((operation: (client: T) => unknown) => operation(transaction))
  };
}

describe("dosage and productivity governance", () => {
  it("exposes complete versioned CRUD and workflow endpoints", () => {
    for (const moduleName of ["dosage", "productivity"]) {
      const controller = readFileSync(join(repoRoot, `apps/api/src/modules/${moduleName}/${moduleName}.controller.ts`), "utf8");
      for (const contract of ['@Get()', '@Get(":id")', '@Post()', '@Patch(":id")', '@Delete(":id")', '@Post(":id/restore")', '@Post(":id/submit")', '@Post(":id/approve")', '@Post(":id/reject")']) {
        expect(controller, `${moduleName}: ${contract}`).toContain(contract);
      }
    }
  });

  it("migrates legacy rows to review without inventing approval or source", () => {
    const schema = readFileSync(join(repoRoot, "prisma/schema.prisma"), "utf8");
    const migration = readFileSync(join(repoRoot, "prisma/migrations/0021_dosage_productivity_workflow/migration.sql"), "utf8");
    for (const model of ["DosageCheck", "ProductivityEntry"]) {
      const block = schema.match(new RegExp(`model ${model} \\{([\\s\\S]*?)\\n\\}`))?.[1] ?? "";
      expect(block).toContain("workflowStatus");
      expect(block).toContain("version");
      expect(block).toContain("deletedAt");
      expect(block).toContain("createdBy");
      expect(block).toContain("updatedBy");
    }
    expect(migration.trim().startsWith("BEGIN;")).toBe(true);
    expect(migration.trim().endsWith("COMMIT;")).toBe(true);
    expect(migration.match(/UPDATE "(?:dosage_checks|productivity_entries)"[\s\S]*?SET\s+"workflow_status" = 'UNDER_REVIEW'/g)).toHaveLength(2);
    expect(migration).toContain("LEGACY_UNVERIFIED");
    expect(migration).toContain("INFORMED_MANUALLY");
    expect(migration).toContain("workflow_metadata_consistent");
    const legacyUpdates = migration.slice(
      migration.indexOf('UPDATE "dosage_checks"'),
      migration.indexOf('ALTER TABLE "productivity_entries"\n  ALTER COLUMN')
    );
    expect(legacyUpdates).not.toContain("'APPROVED'");
  });

  it("creates dosage as a transactional draft with executed rules and audit", async () => {
    const calculatedRow = { id: "44444444-4444-4444-8444-444444444444", workflowStatus: "DRAFT", version: 1 };
    const transaction = {
      weeklyPeriod: { findUnique: vi.fn().mockResolvedValue(week) },
      product: { findUnique: vi.fn().mockResolvedValue({ id: productId, active: true, deletedAt: null, weightConfig: { targetPackageWeightG: 400 } }) },
      equipment: { findUnique: vi.fn() },
      shift: { findUnique: vi.fn() },
      user: { findUnique: vi.fn() },
      dosageCheck: { create: vi.fn().mockResolvedValue(calculatedRow) }
    };
    const audit = { record: vi.fn().mockResolvedValue({}) };
    const prisma = prismaWithTransaction(transaction);
    const service = new DosageService(prisma as never, audit as never);

    await expect(service.create({
      weekId,
      productId,
      sector: "P1",
      date: "2026-05-05",
      sampleWeightsG: [398, 402]
    }, actor)).resolves.toBe(calculatedRow);

    expect(transaction.dosageCheck.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ workflowStatus: "DRAFT", averageWeightG: 400, createdBy: actor.id, updatedBy: actor.id })
    }));
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: "create", entity: "DosageCheck" }), transaction);
  });

  it("creates an explicitly informed productivity draft without replacing automatic metrics", async () => {
    const row = { id: "55555555-5555-4555-8555-555555555555", workflowStatus: "DRAFT", version: 1, dataSource: "INFORMED_MANUALLY" };
    const transaction = {
      weeklyPeriod: { findUnique: vi.fn().mockResolvedValue(week) },
      sector: { findUnique: vi.fn().mockResolvedValue({ id: "sector-1", code: "P1" }) },
      equipment: { findUnique: vi.fn() },
      shift: { findUnique: vi.fn() },
      productivityEntry: { create: vi.fn().mockResolvedValue(row) }
    };
    const audit = { record: vi.fn().mockResolvedValue({}) };
    const service = new ProductivityService(prismaWithTransaction(transaction) as never, audit as never);

    await expect(service.create({
      weekId,
      sector: "P1",
      date: "2026-05-05",
      producedKg: 800,
      productiveHours: 8
    }, actor)).resolves.toBe(row);

    expect(transaction.productivityEntry.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        kgPerHour: 100,
        dataSource: "INFORMED_MANUALLY",
        workflowStatus: "DRAFT",
        createdBy: actor.id,
        calculationRuleVersions: { "productivity.kg_per_hour": 1 }
      })
    }));
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: "create", entity: "ProductivityEntry" }), transaction);
  });

  it("blocks dosage approval while its REVIEW_REQUIRED rule lacks human approval", async () => {
    const entryId = "66666666-6666-4666-8666-666666666666";
    const update = vi.fn();
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      dosageCheck: {
        findUnique: vi.fn().mockResolvedValue({
          id: entryId,
          version: 2,
          workflowStatus: "SUBMITTED",
          submittedBy: actor.id,
          deletedAt: null,
          date: new Date("2026-05-05T00:00:00.000Z"),
          calculationRuleVersions: {
            "dosage.average_weight_g": 1,
            "dosage.population_standard_deviation_g": 1,
            "dosage.overweight_g": 1
          },
          week
        }),
        update
      },
      calculationRuleApproval: { findMany: vi.fn().mockResolvedValue([]) }
    };
    const service = new DosageService(prismaWithTransaction(transaction) as never, { record: vi.fn() } as never);

    await expect(service.approve(entryId, { version: 2, reason: "Valores conferidos" }, {
      id: "77777777-7777-4777-8777-777777777777",
      roles: ["SUPERVISOR"]
    })).rejects.toThrow("REVIEW_REQUIRED sem aprovação vigente");
    expect(update).not.toHaveBeenCalled();
  });

  it("labels automatic summary and reads only approved production", async () => {
    const productionEntry = {
      aggregate: vi.fn().mockResolvedValue({ _sum: { producedKg: 800 }, _avg: { realYieldPercent: 0.95 }, _count: 1 }),
      groupBy: vi.fn().mockResolvedValue([{ date: new Date("2026-05-05T00:00:00.000Z"), _sum: { producedKg: 800 }, _avg: { realYieldPercent: 0.95 } }])
    };
    const service = new ProductivityService({ productionEntry } as never, { record: vi.fn() } as never);
    const summary = await service.summary(weekId);

    expect(summary).toMatchObject({ source: "CALCULATED_FROM_APPROVED_PRODUCTION", producedKg: 800, records: 1 });
    expect(summary.sourceDescription).toContain("apontamentos informados nao substituem");
    for (const call of [productionEntry.aggregate, productionEntry.groupBy]) {
      expect(call).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ workflowStatus: "APPROVED", deletedAt: null }) }));
    }
  });

  it("keeps week close and snapshots approved-only for both modules", () => {
    const source = readFileSync(join(repoRoot, "apps/api/src/modules/weeks/weeks.service.ts"), "utf8");
    expect(source).toContain('tx.dosageCheck.count({ where: { weekId: id, deletedAt: null, workflowStatus: { not: "APPROVED" } } })');
    expect(source).toContain('tx.productivityEntry.count({ where: { weekId: id, deletedAt: null, workflowStatus: { not: "APPROVED" } } })');
    expect(source).toMatch(/tx\.dosageCheck\.findMany\(\{[\s\S]*?workflowStatus: "APPROVED"/);
    expect(source).toMatch(/tx\.productivityEntry\.findMany\(\{[\s\S]*?workflowStatus: "APPROVED"/);
  });
});
