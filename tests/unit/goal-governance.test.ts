import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BadRequestException, ConflictException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { GoalsService } from "../../apps/api/src/modules/goals/goals.service";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "../..");
const actor = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "manager@nexus.local",
  roles: ["MANAGER"]
};
const responsibleId = "22222222-2222-4222-8222-222222222222";

function goal(overrides: Record<string, unknown> = {}) {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    seriesId: "44444444-4444-4444-8444-444444444444",
    previousVersionId: null,
    version: 1,
    name: "Rendimento semanal",
    metric: "yield",
    sectorCode: null,
    lineId: null,
    equipmentId: null,
    shiftId: null,
    productId: null,
    scopeKey: "yield|sector=*|line=*|equipment=*|shift=*|product=*",
    targetValue: new Prisma.Decimal("0.943000"),
    comparator: ">=",
    measurementUnit: "%",
    cadence: "WEEKLY",
    startsOn: new Date("2026-07-01T00:00:00.000Z"),
    endsOn: null,
    responsibleId,
    approvedBy: null,
    status: "DRAFT",
    approvedAt: null,
    approvalReason: null,
    retiredAt: null,
    retiredBy: null,
    retirementReason: null,
    versionReason: "Definição inicial validada pela gestão.",
    legacyDueDate: null,
    legacyActive: true,
    createdBy: actor.id,
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    updatedAt: new Date("2026-07-01T00:00:00.000Z"),
    deletedAt: null,
    sector: null,
    line: null,
    equipment: null,
    shift: null,
    product: null,
    responsible: { id: responsibleId, name: "Responsável", email: "responsavel@nexus.local" },
    approver: null,
    ...overrides
  };
}

function referenceDelegates() {
  return {
    sector: { findUnique: vi.fn() },
    productionLine: { findUnique: vi.fn() },
    equipment: { findUnique: vi.fn() },
    shift: { findUnique: vi.fn() },
    product: { findUnique: vi.fn() },
    user: {
      findUnique: vi.fn().mockResolvedValue({ id: responsibleId, active: true, deletedAt: null })
    }
  };
}

describe("goal governance", () => {
  it("migrates legacy goals to DRAFT without inventing approval metadata", () => {
    const migration = readFileSync(join(repoRoot, "prisma/migrations/0017_goal_governance/migration.sql"), "utf8");
    const legacyUpdate = migration.match(/UPDATE "goals"([\s\S]*?);/)?.[0] ?? "";

    expect(migration).toContain("CREATE TYPE \"GoalStatus\" AS ENUM ('DRAFT', 'APPROVED', 'RETIRED')");
    expect(migration).toContain('"status" = \'DRAFT\'');
    expect(legacyUpdate).not.toContain("'APPROVED'");
    expect(migration).toContain("goals_approved_scope_validity_no_overlap");
    expect(migration).toContain("goals_prevent_version_mutation");
    expect(migration).toContain("goals_approved_metadata_required");
    expect(migration).toContain("goals_workflow_metadata_consistent");
  });

  it("blocks forged goal decisions outside a valid state transition", () => {
    const migration = readFileSync(join(repoRoot, "prisma/migrations/0017_goal_governance/migration.sql"), "utf8");
    const triggerFunction = migration.match(
      /CREATE OR REPLACE FUNCTION prevent_goal_version_mutation\(\)([\s\S]*?)\$\$ LANGUAGE plpgsql;/
    )?.[1] ?? "";

    expect(migration).toContain('BEFORE INSERT OR UPDATE ON "goals"');
    expect(triggerFunction).toContain("TG_OP = 'INSERT'");
    expect(triggerFunction).toContain("NEW.status <> 'DRAFT'");
    expect(triggerFunction).toContain("NEW.status IS NOT DISTINCT FROM OLD.status");
    expect(triggerFunction).toContain("Metadados de decisão só podem mudar durante transição válida.");
    expect(triggerFunction).toContain("OLD.status = 'DRAFT' AND NEW.status IN ('APPROVED', 'RETIRED')");
    expect(triggerFunction).toContain("OLD.status = 'APPROVED' AND NEW.status = 'RETIRED'");
    expect(triggerFunction).toContain("Retirada não pode reescrever metadados de aprovação.");
    expect(triggerFunction).toContain("Aprovação não pode gravar metadados de retirada.");
    for (const field of ["approved_by", "approved_at", "approval_reason", "retired_by", "retired_at", "retirement_reason"]) {
      expect(triggerFunction).toContain(`OLD.${field}`);
      expect(triggerFunction).toContain(`NEW.${field}`);
    }
  });

  it("removes fabricated target values from the database seed", () => {
    const seed = readFileSync(join(repoRoot, "prisma/seed.ts"), "utf8");
    expect(seed).not.toContain("Sobrepeso maximo");
    expect(seed).not.toContain("Rendimento minimo");
    expect(seed).not.toMatch(/prisma\.goal\.(?:create|update|upsert)/);
  });

  it("creates an immutable DRAFT using Decimal and audits in the same transaction", async () => {
    const created = goal();
    const transaction = {
      ...referenceDelegates(),
      goal: { create: vi.fn().mockResolvedValue(created) },
      auditLog: { create: vi.fn() }
    };
    const prisma = {
      $transaction: vi.fn(async (operation: (client: typeof transaction) => Promise<unknown>) => operation(transaction))
    };
    const audit = { record: vi.fn().mockResolvedValue(undefined) };
    const service = new GoalsService(prisma as never, audit as never);

    const result = await service.create({
      name: "Rendimento semanal",
      metric: "yield",
      targetValue: "0.943000",
      comparator: ">=",
      measurementUnit: "%",
      cadence: "WEEKLY",
      startsOn: "2026-07-01",
      responsibleId,
      reason: "Definição inicial validada pela gestão."
    }, actor);

    const data = transaction.goal.create.mock.calls[0]?.[0].data;
    expect(data.status).toBe("DRAFT");
    expect(data.targetValue).toBeInstanceOf(Prisma.Decimal);
    expect(data.targetValue.toString()).toBe("0.943");
    expect(data.approvedBy).toBeUndefined();
    expect(result).toMatchObject({ workflowStatus: "DRAFT", active: false, targetValue: "0.943" });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: "create_draft" }), transaction);
  });

  it("rejects invalid validity before opening a transaction", async () => {
    const prisma = { $transaction: vi.fn() };
    const service = new GoalsService(prisma as never, { record: vi.fn() } as never);

    await expect(service.create({
      name: "Perdas semanais",
      metric: "losses_kg",
      targetValue: "50",
      comparator: "<=",
      measurementUnit: "kg",
      cadence: "WEEKLY",
      startsOn: "2026-07-10",
      endsOn: "2026-07-01",
      responsibleId,
      reason: "Período solicitado pela gestão industrial."
    }, actor)).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("blocks approval when another series overlaps same metric and scope", async () => {
    const current = goal();
    const transaction = {
      ...referenceDelegates(),
      goal: {
        findUnique: vi.fn().mockResolvedValue(current),
        findFirst: vi.fn().mockResolvedValue({ id: "conflict", name: "Meta vigente", version: 2 }),
        findMany: vi.fn(),
        update: vi.fn()
      }
    };
    const prisma = {
      $transaction: vi.fn(async (operation: (client: typeof transaction) => Promise<unknown>) => operation(transaction))
    };
    const service = new GoalsService(prisma as never, { record: vi.fn() } as never);

    await expect(service.approve(current.id, { reason: "Aprovação após revisão gerencial completa." }, actor))
      .rejects.toBeInstanceOf(ConflictException);
    expect(transaction.goal.update).not.toHaveBeenCalled();
  });

  it("approves new version and retires prior approved version atomically", async () => {
    const current = goal({ version: 2, previousVersionId: "55555555-5555-4555-8555-555555555555" });
    const previous = goal({
      id: "55555555-5555-4555-8555-555555555555",
      status: "APPROVED",
      approvedBy: "66666666-6666-4666-8666-666666666666",
      approvedAt: new Date("2026-06-01T00:00:00.000Z"),
      approvalReason: "Aprovação anterior registrada pela gestão."
    });
    const retired = { ...previous, status: "RETIRED", retiredAt: new Date(), retirementReason: "Substituída pela versão 2." };
    const approved = { ...current, status: "APPROVED", approvedBy: actor.id, approvedAt: new Date(), approver: { id: actor.id, name: "Gestor", email: actor.email } };
    const transaction = {
      ...referenceDelegates(),
      goal: {
        findUnique: vi.fn().mockResolvedValue(current),
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: vi.fn().mockResolvedValue([previous]),
        update: vi.fn().mockResolvedValueOnce(retired).mockResolvedValueOnce(approved)
      }
    };
    const prisma = {
      $transaction: vi.fn(async (operation: (client: typeof transaction) => Promise<unknown>) => operation(transaction))
    };
    const audit = { record: vi.fn().mockResolvedValue(undefined) };
    const service = new GoalsService(prisma as never, audit as never);

    const result = await service.approve(current.id, { reason: "Aprovação após revisão gerencial completa." }, actor);

    expect(transaction.goal.update).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: { id: previous.id },
      data: expect.objectContaining({ status: "RETIRED", retiredBy: actor.id })
    }));
    expect(transaction.goal.update).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: { id: current.id },
      data: expect.objectContaining({ status: "APPROVED", approvedBy: actor.id })
    }));
    expect(result).toMatchObject({ workflowStatus: "APPROVED", active: true });
    expect(audit.record).toHaveBeenCalledTimes(2);
  });
});
