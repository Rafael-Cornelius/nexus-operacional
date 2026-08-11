import "reflect-metadata";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { CALCULATION_RULE_IDS } from "../../apps/api/src/domain/calculations/rule-registry";
import {
  assertReviewRequiredCalculationRulesApproved,
  CalculationRulesService
} from "../../apps/api/src/modules/calculation-rules/calculation-rules.service";
import { ProductionService } from "../../apps/api/src/modules/production/production.service";
import { DowntimeService } from "../../apps/api/src/modules/downtime/downtime.service";
import { OverweightService } from "../../apps/api/src/modules/overweight/overweight.service";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "../..");
const actor = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "admin@nexus.local",
  roles: ["ADMIN"]
};
const ruleId = CALCULATION_RULE_IDS.expectedYieldKg;

function approval(overrides: Record<string, unknown> = {}) {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    ruleId,
    ruleVersion: 1,
    status: "APPROVED",
    approvedAt: new Date("2026-08-01T12:00:00.000Z"),
    approvedBy: actor.id,
    approvalReason: "Fórmula validada em reunião industrial.",
    retiredAt: null,
    retiredBy: null,
    retirementReason: null,
    createdAt: new Date("2026-08-01T12:00:00.000Z"),
    updatedAt: new Date("2026-08-01T12:00:00.000Z"),
    approver: { id: actor.id, name: "Administrador", email: actor.email },
    retirer: null,
    ...overrides
  };
}

describe("calculation rule governance", () => {
  it("creates immutable versioned decisions without inserting approval data", () => {
    const schema = readFileSync(join(repoRoot, "prisma/schema.prisma"), "utf8");
    const migration = readFileSync(
      join(repoRoot, "prisma/migrations/0020_calculation_rule_governance/migration.sql"),
      "utf8"
    );
    const seed = readFileSync(join(repoRoot, "prisma/seed.ts"), "utf8");

    expect(schema).toContain("model CalculationRuleApproval");
    expect(schema).toContain("@@unique([ruleId, ruleVersion])");
    expect(schema).not.toMatch(/model CalculationRuleApproval \{[\s\S]*?formula\s+/);
    expect(migration.trim().startsWith("BEGIN;")).toBe(true);
    expect(migration.trim().endsWith("COMMIT;")).toBe(true);
    expect(migration).toContain("protect_calculation_rule_approval");
    expect(migration).toContain("Retirada permanece histórica; reativação exige nova versão");
    expect(migration).toContain("BEFORE INSERT OR UPDATE OR DELETE");
    expect(migration).not.toMatch(/INSERT\s+INTO\s+"calculation_rule_approvals"/i);
    expect(seed).not.toContain("calculationRuleApproval");
  });

  it("lists registry definition combined with exact-version decision", async () => {
    const current = approval();
    const prisma = {
      calculationRuleApproval: { findMany: vi.fn().mockResolvedValue([current]) }
    };
    const service = new CalculationRulesService(prisma as never, { record: vi.fn() } as never);

    const rows = await service.list();
    const row = rows.find((item) => item.id === ruleId);

    expect(row).toMatchObject({
      id: ruleId,
      version: 1,
      status: "REVIEW_REQUIRED",
      governanceStatus: "APPROVED",
      approval: current
    });
    expect(row?.formula).toContain("expectedYieldKg");
  });

  it("approves current REVIEW_REQUIRED version and audits in same transaction", async () => {
    const approved = approval();
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      calculationRuleApproval: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue(approved)
      }
    };
    const prisma = {
      $transaction: vi.fn((operation: (client: typeof transaction) => unknown) => operation(transaction))
    };
    const audit = { record: vi.fn().mockResolvedValue(undefined) };
    const service = new CalculationRulesService(prisma as never, audit as never);

    await expect(service.approve(
      ruleId,
      1,
      { reason: "Fórmula validada em reunião industrial." },
      actor
    )).resolves.toEqual(approved);

    expect(transaction.calculationRuleApproval.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        ruleId,
        ruleVersion: 1,
        status: "APPROVED",
        approvedBy: actor.id
      })
    }));
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "approve", reason: "Fórmula validada em reunião industrial." }),
      transaction
    );
    expect(transaction.$queryRaw).toHaveBeenCalledOnce();
  });

  it("never reactivates retired version and requires decision reason", async () => {
    const retired = approval({ status: "RETIRED", retiredAt: new Date(), retiredBy: actor.id });
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      calculationRuleApproval: { findUnique: vi.fn().mockResolvedValue(retired), create: vi.fn() }
    };
    const prisma = {
      $transaction: vi.fn((operation: (client: typeof transaction) => unknown) => operation(transaction))
    };
    const service = new CalculationRulesService(prisma as never, { record: vi.fn() } as never);

    await expect(service.approve(ruleId, 1, { reason: "curto" }, actor)).rejects.toThrow();
    expect(prisma.$transaction).not.toHaveBeenCalled();

    await expect(service.approve(
      ruleId,
      1,
      { reason: "Tentativa de reaprovação após retirada." },
      actor
    )).rejects.toBeInstanceOf(ConflictException);
    expect(transaction.calculationRuleApproval.create).not.toHaveBeenCalled();
  });

  it("retires approval atomically while preserving original approval metadata", async () => {
    const current = approval();
    const retired = approval({
      status: "RETIRED",
      retiredAt: new Date("2026-08-02T12:00:00.000Z"),
      retiredBy: actor.id,
      retirementReason: "Evidência operacional posterior invalidou regra."
    });
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      calculationRuleApproval: {
        findUnique: vi.fn().mockResolvedValue(current),
        update: vi.fn().mockResolvedValue(retired)
      }
    };
    const prisma = {
      $transaction: vi.fn((operation: (client: typeof transaction) => unknown) => operation(transaction))
    };
    const audit = { record: vi.fn().mockResolvedValue(undefined) };
    const service = new CalculationRulesService(prisma as never, audit as never);

    await expect(service.retire(
      ruleId,
      1,
      { reason: "Evidência operacional posterior invalidou regra." },
      actor
    )).resolves.toEqual(retired);
    expect(transaction.calculationRuleApproval.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: current.id },
      data: expect.objectContaining({ status: "RETIRED", retiredBy: actor.id })
    }));
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: "retire", before: current }), transaction);
  });

  it("blocks missing approval and accepts only exact approved ruleId plus version", async () => {
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      calculationRuleApproval: { findMany: vi.fn().mockResolvedValue([]) }
    };
    const snapshot = { [ruleId]: 1 };

    await expect(assertReviewRequiredCalculationRulesApproved(transaction as never, snapshot))
      .rejects.toBeInstanceOf(ConflictException);

    transaction.calculationRuleApproval.findMany.mockResolvedValue([{ ruleId, ruleVersion: 1 }]);
    await expect(assertReviewRequiredCalculationRulesApproved(transaction as never, snapshot)).resolves.toBeUndefined();

    await expect(assertReviewRequiredCalculationRulesApproved(
      transaction as never,
      { "unknown.historical.rule": 1 }
    )).rejects.toBeInstanceOf(ConflictException);
  });

  it("blocks ProductionEntry approval before update when snapshot uses unapproved rule", async () => {
    const entryId = "33333333-3333-4333-8333-333333333333";
    const current = {
      id: entryId,
      version: 3,
      workflowStatus: "SUBMITTED",
      submittedBy: "44444444-4444-4444-8444-444444444444",
      deletedAt: null,
      date: new Date("2026-08-01T00:00:00.000Z"),
      calculationRuleVersions: { [ruleId]: 1 },
      week: {
        id: "55555555-5555-4555-8555-555555555555",
        status: "OPEN",
        deletedAt: null,
        startsOn: new Date("2026-07-27T00:00:00.000Z"),
        endsOn: new Date("2026-08-02T00:00:00.000Z")
      }
    };
    const update = vi.fn();
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      productionEntry: { findUnique: vi.fn().mockResolvedValue(current), update },
      calculationRuleApproval: { findMany: vi.fn().mockResolvedValue([]) }
    };
    const prisma = {
      $transaction: vi.fn((operation: (client: typeof transaction) => unknown) => operation(transaction))
    };
    const service = new ProductionService(prisma as never, { record: vi.fn() } as never);

    await expect(service.approve(
      entryId,
      { version: 3, reason: "Revisão operacional concluída." },
      actor
    )).rejects.toBeInstanceOf(ConflictException);
    expect(update).not.toHaveBeenCalled();
  });

  it("blocks downtime approval when its ambiguous classification rule is pending", async () => {
    const entryId = "66666666-6666-4666-8666-666666666666";
    const update = vi.fn();
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      downtimeEntry: {
        findUnique: vi.fn().mockResolvedValue({
          id: entryId,
          version: 2,
          workflowStatus: "SUBMITTED",
          submittedBy: "77777777-7777-4777-8777-777777777777",
          deletedAt: null,
          lineId: "99999999-9999-4999-8999-999999999999",
          equipmentId: null,
          date: new Date("2026-08-01T00:00:00.000Z"),
          productionStart: new Date("2026-08-01T08:00:00.000Z"),
          productionEnd: new Date("2026-08-01T16:00:00.000Z"),
          downtimeStart: new Date("2026-08-01T10:00:00.000Z"),
          downtimeEnd: new Date("2026-08-01T10:30:00.000Z"),
          calculationRuleVersions: { [CALCULATION_RULE_IDS.downtimeStatus]: 1 },
          week: {
            status: "OPEN",
            deletedAt: null,
            startsOn: new Date("2026-07-27T00:00:00.000Z"),
            endsOn: new Date("2026-08-02T00:00:00.000Z")
          }
        }),
        update
      },
      calculationRuleApproval: { findMany: vi.fn().mockResolvedValue([]) }
    };
    const prisma = {
      $transaction: vi.fn((operation: (client: typeof transaction) => unknown) => operation(transaction))
    };
    const service = new DowntimeService(prisma as never, { record: vi.fn() } as never);

    await expect(service.approve(
      entryId,
      { version: 2, reason: "Parada revisada por aprovador independente." },
      actor
    )).rejects.toBeInstanceOf(ConflictException);
    expect(update).not.toHaveBeenCalled();
  });

  it("does not classify an overweight ranking with an unapproved ambiguous rule", async () => {
    const productLookup = vi.fn();
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      productionEntry: {
        groupBy: vi.fn().mockResolvedValue([
          { productId: "88888888-8888-4888-8888-888888888888", _sum: { overweightTotalKg: 2, producedKg: 100 } }
        ])
      },
      product: { findMany: productLookup },
      calculationRuleApproval: { findMany: vi.fn().mockResolvedValue([]) }
    };
    const prisma = {
      $transaction: vi.fn((operation: (client: typeof transaction) => unknown) => operation(transaction))
    };
    const service = new OverweightService(prisma as never);

    await expect(service.ranking()).rejects.toBeInstanceOf(ConflictException);
    expect(productLookup).not.toHaveBeenCalled();
  });

  it("exposes ADMIN-only API and review controls in Settings", () => {
    const controller = readFileSync(
      join(repoRoot, "apps/api/src/modules/calculation-rules/calculation-rules.controller.ts"),
      "utf8"
    );
    const page = readFileSync(join(repoRoot, "apps/web/app/configuracoes/page.tsx"), "utf8");

    expect(controller).toContain('@Roles("ADMIN")');
    expect(controller).toContain('Post(":ruleId/versions/:version/approve")');
    expect(controller).toContain('Post(":ruleId/versions/:version/retire")');
    expect(page).toContain("Revisar");
    expect(page).toContain("Aprovar");
    expect(page).toContain("Retirar");
    expect(page).toContain("nenhuma decisão é automática");
  });

  it("rejects unknown registry rule before opening retirement transaction", async () => {
    const prisma = { $transaction: vi.fn() };
    const service = new CalculationRulesService(prisma as never, { record: vi.fn() } as never);

    await expect(service.retire(
      "unknown.rule",
      1,
      { reason: "Regra ausente precisa permanecer bloqueada." },
      actor
    )).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
