import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { DowntimeService } from "../../apps/api/src/modules/downtime/downtime.service";
import { LossesService } from "../../apps/api/src/modules/losses/losses.service";
import { ProductionService } from "../../apps/api/src/modules/production/production.service";
import { assertCanAmendApproved, assertIndependentApprover } from "../../apps/api/src/domain/workflow/workflow-rules";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "../..");
const id = "11111111-1111-4111-8111-111111111111";
const actorId = "22222222-2222-4222-8222-222222222222";
const actor = { id: actorId, email: "supervisor@nexus.local", roles: ["SUPERVISOR"] };
const week = {
  id: "33333333-3333-4333-8333-333333333333",
  status: "OPEN",
  startsOn: new Date("2026-05-04T00:00:00.000Z"),
  endsOn: new Date("2026-05-10T00:00:00.000Z"),
  deletedAt: null
};

function occurrences(content: string, value: string) {
  return content.split(value).length - 1;
}

function modelBlock(schema: string, name: string) {
  const match = schema.match(new RegExp(`model ${name} \\{([\\s\\S]*?)\\n\\}`, "m"));
  if (!match) throw new Error(`Modelo ${name} ausente.`);
  return match[1];
}

function enumValues(schema: string, name: string) {
  const match = schema.match(new RegExp(`enum ${name} \\{([\\s\\S]*?)\\n\\}`, "m"));
  if (!match) throw new Error(`Enum ${name} ausente.`);
  return match[1]
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

describe("workflow and optimistic concurrency", () => {
  it("blocks operators from reopening an approved record through ordinary edit", () => {
    expect(() => assertCanAmendApproved("APPROVED", ["OPERATOR"])).toThrow("Somente supervisao");
    expect(() => assertCanAmendApproved("APPROVED", ["SUPERVISOR"])).not.toThrow();
    expect(() => assertCanAmendApproved("DRAFT", ["OPERATOR"])).not.toThrow();
  });

  it("enforces segregation of duties during approval", () => {
    expect(() => assertIndependentApprover(actorId, actorId)).toThrow("nao pode aprovar o proprio");
    expect(() => assertIndependentApprover(actorId, "44444444-4444-4444-8444-444444444444")).not.toThrow();
  });

  it("submits a draft atomically, increments version and audits the transition", async () => {
    const current = {
      id,
      version: 1,
      workflowStatus: "DRAFT",
      deletedAt: null,
      date: new Date("2026-05-05T00:00:00.000Z"),
      week
    };
    const submitted = { ...current, version: 2, workflowStatus: "SUBMITTED", submittedBy: actorId };
    const update = vi.fn().mockResolvedValue(submitted);
    const audit = vi.fn().mockResolvedValue(undefined);
    const service = new ProductionService(
      { productionEntry: { findUnique: vi.fn().mockResolvedValue(current), update } } as never,
      { record: audit } as never
    );

    await expect(service.submit(id, { version: 1, reason: "Conferencia concluida" }, actor)).resolves.toEqual(submitted);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id, version: 1 },
        data: expect.objectContaining({
          workflowStatus: "SUBMITTED",
          submittedBy: actorId,
          submissionReason: "Conferencia concluida",
          version: { increment: 1 }
        })
      })
    );
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "submit", before: current, after: submitted, reason: "Conferencia concluida" })
    );
  });

  it("approves a submitted loss and records the approver without a foreign-key relation", async () => {
    const current = {
      id,
      version: 4,
      workflowStatus: "SUBMITTED",
      deletedAt: null,
      date: new Date("2026-05-05T00:00:00.000Z"),
      week
    };
    const approved = { ...current, version: 5, workflowStatus: "APPROVED", approvedBy: actorId };
    const update = vi.fn().mockResolvedValue(approved);
    const audit = vi.fn().mockResolvedValue(undefined);
    const service = new LossesService(
      { lossEntry: { findUnique: vi.fn().mockResolvedValue(current), update } } as never,
      { record: audit } as never
    );

    await expect(service.approve(id, { version: 4, reason: "Valores validados" }, actor)).resolves.toEqual(approved);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id, version: 4 },
        data: expect.objectContaining({ workflowStatus: "APPROVED", approvedBy: actorId, approvalReason: "Valores validados", version: { increment: 1 } })
      })
    );
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "approve", reason: "Valores validados" }));
  });

  it("requires a rejection reason and stores it on downtime rejection", async () => {
    const current = {
      id,
      version: 2,
      workflowStatus: "UNDER_REVIEW",
      deletedAt: null,
      date: new Date("2026-05-05T00:00:00.000Z"),
      productionStart: new Date("2026-05-05T08:00:00.000Z"),
      productionEnd: new Date("2026-05-05T16:00:00.000Z"),
      downtimeStart: new Date("2026-05-05T10:00:00.000Z"),
      downtimeEnd: new Date("2026-05-05T11:00:00.000Z"),
      week
    };
    const rejected = { ...current, version: 3, workflowStatus: "REJECTED", rejectedBy: actorId };
    const findUnique = vi.fn().mockResolvedValue(current);
    const update = vi.fn().mockResolvedValue(rejected);
    const audit = vi.fn().mockResolvedValue(undefined);
    const service = new DowntimeService({ downtimeEntry: { findUnique, update } } as never, { record: audit } as never);

    await expect(service.reject(id, { version: 2 }, actor)).rejects.toThrow("Required");
    expect(findUnique).not.toHaveBeenCalled();

    await expect(service.reject(id, { version: 2, reason: "Horario inconsistente" }, actor)).resolves.toEqual(rejected);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id, version: 2 },
        data: expect.objectContaining({
          workflowStatus: "REJECTED",
          rejectedBy: actorId,
          rejectionReason: "Horario inconsistente",
          version: { increment: 1 }
        })
      })
    );
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "reject", reason: "Horario inconsistente" }));
  });

  it("returns HTTP 409 when the atomic version predicate loses a race", async () => {
    const current = {
      id,
      version: 1,
      workflowStatus: "DRAFT",
      deletedAt: null,
      date: new Date("2026-05-05T00:00:00.000Z"),
      week
    };
    const update = vi.fn().mockRejectedValue({ code: "P2025" });
    const service = new ProductionService(
      { productionEntry: { findUnique: vi.fn().mockResolvedValue(current), update } } as never,
      { record: vi.fn() } as never
    );

    const error = await service.submit(id, { version: 1 }, actor).catch((caught) => caught);
    expect(error.getStatus()).toBe(409);
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ where: { id, version: 1 } }));
  });

  it("returns HTTP 409 immediately for a stale client version", async () => {
    const current = {
      id,
      version: 3,
      workflowStatus: "DRAFT",
      deletedAt: null,
      date: new Date("2026-05-05T00:00:00.000Z"),
      week
    };
    const update = vi.fn();
    const service = new ProductionService(
      { productionEntry: { findUnique: vi.fn().mockResolvedValue(current), update } } as never,
      { record: vi.fn() } as never
    );

    const error = await service.submit(id, { version: 2 }, actor).catch((caught) => caught);
    expect(error.getStatus()).toBe(409);
    expect(update).not.toHaveBeenCalled();
  });

  it("requires a reason before editing an approved record", async () => {
    const current = {
      id,
      version: 1,
      workflowStatus: "APPROVED",
      deletedAt: null,
      date: new Date("2026-05-05T00:00:00.000Z"),
      week
    };
    const service = new ProductionService(
      { productionEntry: { findUnique: vi.fn().mockResolvedValue(current) } } as never,
      { record: vi.fn() } as never
    );

    await expect(service.update(id, { version: 1, notes: "Correcao" }, actor)).rejects.toThrow("exige motivo");
  });
});

describe("workflow schema, migration and approved-only projections", () => {
  it("defines workflow/version fields without removing reconciliation, equipment or shift links", () => {
    const schema = readFileSync(join(repoRoot, "prisma/schema.prisma"), "utf8");
    expect(enumValues(schema, "WorkflowStatus")).toEqual(["DRAFT", "SUBMITTED", "UNDER_REVIEW", "APPROVED", "REJECTED", "CANCELLED"]);
    for (const model of ["ProductionEntry", "LossEntry", "DowntimeEntry"]) {
      const block = modelBlock(schema, model);
      expect(block).toMatch(/workflowStatus\s+WorkflowStatus\s+@default\(DRAFT\)\s+@map\("workflow_status"\)/);
      expect(block).toMatch(/version\s+Int\s+@default\(1\)/);
      for (const field of ["submittedBy", "approvedBy", "rejectedBy"]) {
        expect(block).toMatch(new RegExp(`${field}\\s+String\\?\\s+@map\\("[^"]+"\\)\\s+@db\\.Uuid`));
      }
      for (const field of ["submittedAt", "submissionReason", "approvedAt", "approvalReason", "rejectedAt", "rejectionReason"]) {
        expect(block).toContain(field);
      }
      expect(block).toContain("equipmentId");
      expect(block).toContain("shiftId");
      expect(block).toContain("importBatchId");
      expect(block).not.toMatch(/(?:submittedBy|approvedBy|rejectedBy)\s+[^\n]*@relation/);
    }
  });

  it("places existing rows under review instead of inventing a human approval", () => {
    const migration = readFileSync(join(repoRoot, "prisma/migrations/0007_workflow_versioning/migration.sql"), "utf8");
    expect(migration.match(/CREATE TYPE "WorkflowStatus" AS ENUM \(([\s\S]*?)\);/)?.[1].match(/'[A-Z_]+'/g)).toEqual([
      "'DRAFT'",
      "'SUBMITTED'",
      "'UNDER_REVIEW'",
      "'APPROVED'",
      "'REJECTED'",
      "'CANCELLED'"
    ]);
    expect(occurrences(migration, "DEFAULT 'DRAFT'")).toBe(3);
    expect(occurrences(migration, '"workflow_status" = \'UNDER_REVIEW\'')).toBe(3);
    expect(occurrences(migration, "Registro legado migrado; exige revisao humana.")).toBe(3);
    expect(occurrences(migration, 'CHECK ("version" > 0)')).toBe(3);
    expect(occurrences(migration, "rejection_reason_required")).toBe(3);
    for (const table of ["production_entries", "loss_entries", "downtime_entries"]) {
      expect(migration).toContain(`ALTER TABLE "${table}"`);
      expect(migration).toContain(`CREATE INDEX "${table}_week_id_workflow_status_idx" ON "${table}"("week_id", "workflow_status")`);
      expect(migration).toMatch(new RegExp(`UPDATE "${table}"[\\s\\S]*?"workflow_status" = 'UNDER_REVIEW'`));
    }
  });

  it("imports all three operational record types as DRAFT", () => {
    const importer = readFileSync(join(repoRoot, "apps/api/src/modules/import/import.service.ts"), "utf8");
    expect(occurrences(importer, 'workflowStatus: "DRAFT"')).toBeGreaterThanOrEqual(3);
  });

  it("filters every operational dashboard and report projection to APPROVED", () => {
    const expectations: Array<[string, number]> = [
      ["apps/api/src/modules/dashboard/dashboard.service.ts", 9],
      ["apps/api/src/modules/reports/reports.service.ts", 2],
      ["apps/api/src/modules/productivity/productivity.service.ts", 2],
      ["apps/api/src/modules/overweight/overweight.service.ts", 1],
      ["apps/api/src/modules/goals/goals.service.ts", 3],
      ["apps/api/src/modules/weeks/weeks.service.ts", 3]
    ];
    for (const [relativePath, exactCount] of expectations) {
      const source = readFileSync(join(repoRoot, relativePath), "utf8");
      expect(occurrences(source, 'workflowStatus: "APPROVED"'), relativePath).toBe(exactCount);
    }
  });
});
