import { ConflictException } from "@nestjs/common";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  DowntimeService,
  downtimeOverlapConstraint
} from "../../apps/api/src/modules/downtime/downtime.service";

const ids = {
  week: "00000000-0000-4000-8000-000000000001",
  sector: "00000000-0000-4000-8000-000000000002",
  line: "00000000-0000-4000-8000-000000000003",
  equipment: "00000000-0000-4000-8000-000000000004",
  reason: "00000000-0000-4000-8000-000000000005",
  entry: "00000000-0000-4000-8000-000000000006",
  actor: "00000000-0000-4000-8000-000000000007",
  submitter: "00000000-0000-4000-8000-000000000008"
};

const week = {
  id: ids.week,
  startsOn: new Date("2026-05-04T00:00:00.000Z"),
  endsOn: new Date("2026-05-10T00:00:00.000Z"),
  status: "OPEN",
  deletedAt: null
};

const line = {
  id: ids.line,
  sectorId: ids.sector,
  active: true,
  deletedAt: null
};

const basePayload = {
  weekId: ids.week,
  date: "2026-05-05",
  sector: "P1",
  lineId: ids.line,
  productionStart: "2026-05-05T08:00:00.000Z",
  productionEnd: "2026-05-05T16:00:00.000Z",
  downtimeStart: "2026-05-05T10:00:00.000Z",
  downtimeEnd: "2026-05-05T11:00:00.000Z",
  producedMassKg: 100,
  downtimeReasonId: ids.reason
};

function setup(options: {
  overlap?: { id: string } | null;
  createError?: unknown;
  auditError?: unknown;
} = {}) {
  const findFirst = vi.fn().mockResolvedValue(options.overlap ?? null);
  const create = options.createError
    ? vi.fn().mockRejectedValue(options.createError)
    : vi.fn().mockResolvedValue({ id: "00000000-0000-4000-8000-000000000099" });
  const transaction = {
    weeklyPeriod: { findUnique: vi.fn().mockResolvedValue(week) },
    sector: { findUnique: vi.fn().mockResolvedValue({ id: ids.sector, code: "P1" }) },
    productionLine: { findUnique: vi.fn().mockResolvedValue(line) },
    equipment: {
      findUnique: vi.fn().mockResolvedValue({
        id: ids.equipment,
        productionLineId: ids.line,
        productionLine: line,
        active: true,
        deletedAt: null
      })
    },
    downtimeReason: {
      findUnique: vi.fn().mockResolvedValue({ id: ids.reason, active: true })
    },
    downtimeEntry: { findFirst, create }
  };
  const $transaction = vi.fn((operation: (client: typeof transaction) => unknown) => operation(transaction));
  const audit = options.auditError
    ? vi.fn().mockRejectedValue(options.auditError)
    : vi.fn().mockResolvedValue(undefined);
  return {
    service: new DowntimeService({ $transaction } as never, { record: audit } as never),
    transaction,
    $transaction,
    audit,
    findFirst,
    create
  };
}

describe("downtime overlap concurrency", () => {
  it("uses equipment as the resource when equipment is present", async () => {
    const { service, findFirst } = setup({ overlap: { id: "existing" } });

    const promise = service.create({ ...basePayload, equipmentId: ids.equipment });
    await expect(promise).rejects.toBeInstanceOf(ConflictException);
    await expect(promise).rejects.toMatchObject({ status: 409 });
    expect(findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({
        deletedAt: null,
        equipmentId: ids.equipment,
        downtimeStart: { lt: new Date(basePayload.downtimeEnd) },
        downtimeEnd: { gt: new Date(basePayload.downtimeStart) }
      }),
      select: { id: true }
    });
    expect(findFirst.mock.calls[0][0].where).not.toHaveProperty("lineId");
  });

  it("falls back to line only for entries without equipment", async () => {
    const { service, findFirst } = setup({ overlap: { id: "existing" } });

    await expect(service.create(basePayload)).rejects.toMatchObject({ status: 409 });
    expect(findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({
        deletedAt: null,
        equipmentId: null,
        lineId: ids.line
      }),
      select: { id: true }
    });
  });

  it("rejects a downtime entry without line or equipment", async () => {
    const { service, create } = setup();
    const { lineId: _lineId, ...withoutResource } = basePayload;

    await expect(service.create(withoutResource)).rejects.toThrow("linha de producao ou o equipamento");
    expect(create).not.toHaveBeenCalled();
  });

  it("maps a concurrent database exclusion violation to a clear HTTP 409", async () => {
    const databaseError = {
      code: "P2004",
      meta: {
        database_error: `conflicting key violates exclusion constraint "downtime_entries_no_equipment_overlap"`,
        database_error_code: "23P01"
      }
    };
    const { service, create } = setup({ createError: databaseError });

    const promise = service.create({ ...basePayload, equipmentId: ids.equipment });
    await expect(promise).rejects.toMatchObject({ status: 409 });
    await expect(promise).rejects.toThrow("Conflito concorrente");
    expect(create).toHaveBeenCalledOnce();
    expect(downtimeOverlapConstraint(databaseError)).toBe("equipment");
  });

  it("creates and audits inside the same Serializable transaction", async () => {
    const { service, transaction, $transaction, audit } = setup();

    await expect(service.create(basePayload)).resolves.toMatchObject({
      id: "00000000-0000-4000-8000-000000000099"
    });
    expect($transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "Serializable" });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "create", entity: "DowntimeEntry" }),
      transaction
    );
  });

  it("fails the transaction when audit persistence fails", async () => {
    const auditError = new Error("audit unavailable");
    const { service, transaction, audit } = setup({ auditError });

    await expect(service.create(basePayload)).rejects.toThrow("audit unavailable");
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "create" }), transaction);
  });

  it("maps a Serializable write conflict to HTTP 409", async () => {
    const $transaction = vi.fn().mockRejectedValue({ code: "P2034" });
    const service = new DowntimeService({ $transaction } as never, { record: vi.fn() } as never);

    await expect(service.create(basePayload)).rejects.toMatchObject({ status: 409 });
    await expect(service.create(basePayload)).rejects.toThrow("Conflito concorrente");
  });

  it.each([
    { method: "softDelete", status: "DRAFT", deleted: false, auditAction: "delete", reasonRequired: true },
    { method: "restore", status: "CANCELLED", deleted: true, auditAction: "restore", reasonRequired: true },
    { method: "submit", status: "DRAFT", deleted: false, auditAction: "submit", reasonRequired: false },
    { method: "approve", status: "SUBMITTED", deleted: false, auditAction: "approve", reasonRequired: false },
    { method: "reject", status: "SUBMITTED", deleted: false, auditAction: "reject", reasonRequired: true }
  ] as const)("locks, mutates and audits $method in one Serializable transaction", async ({
    method,
    status,
    deleted,
    auditAction,
    reasonRequired
  }) => {
    const current = {
      id: ids.entry,
      version: 1,
      workflowStatus: status,
      deletedAt: deleted ? new Date("2026-05-06T00:00:00.000Z") : null,
      date: new Date(basePayload.date),
      productionStart: new Date(basePayload.productionStart),
      productionEnd: new Date(basePayload.productionEnd),
      downtimeStart: new Date(basePayload.downtimeStart),
      downtimeEnd: new Date(basePayload.downtimeEnd),
      lineId: ids.line,
      equipmentId: null,
      submittedBy: ids.submitter,
      week
    };
    const changed = { ...current, version: 2 };
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      downtimeEntry: {
        findUnique: vi.fn().mockResolvedValue(current),
        findFirst: vi.fn().mockResolvedValue(null),
        update: vi.fn().mockResolvedValue(changed)
      }
    };
    const $transaction = vi.fn((operation: (client: typeof transaction) => unknown) => operation(transaction));
    const audit = vi.fn().mockResolvedValue(undefined);
    const service = new DowntimeService({ $transaction } as never, { record: audit } as never);
    const command = reasonRequired
      ? { version: 1, reason: "Motivo operacional valido" }
      : { version: 1, reason: "Revisao concluida" };
    const actor = { id: ids.actor, email: "supervisor@nexus.local", roles: ["SUPERVISOR"] };

    await expect(service[method](ids.entry, command, actor)).resolves.toEqual(changed);
    expect(transaction.$queryRaw).toHaveBeenCalledOnce();
    expect(transaction.downtimeEntry.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: ids.entry, version: 1 } })
    );
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: auditAction, before: current, after: changed }),
      transaction
    );
    expect($transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "Serializable" });
  });

  it("does not misclassify unrelated Prisma conflicts", () => {
    expect(downtimeOverlapConstraint({ code: "P2025", message: "record missing" })).toBeNull();
  });

  it("defines half-open exclusion constraints and ignores, but preserves, soft-deleted rows", () => {
    const migration = readFileSync(
      join(__dirname, "../../prisma/migrations/0015_downtime_overlap_constraints/migration.sql"),
      "utf8"
    );

    expect(migration).toContain('CONSTRAINT "downtime_entries_no_equipment_overlap"');
    expect(migration).toContain('CONSTRAINT "downtime_entries_no_line_overlap_without_equipment"');
    expect(migration).toContain('CONSTRAINT "downtime_entries_resource_required"');
    expect(migration).toContain('CHECK ("deleted_at" IS NOT NULL OR "line_id" IS NOT NULL OR "equipment_id" IS NOT NULL) NOT VALID');
    expect(migration.match(/tsrange\("downtime_start", "downtime_end", '\[\)'\) WITH &&/g)).toHaveLength(2);
    expect(migration).toMatch(/"deleted_at" IS NULL\s+AND "equipment_id" IS NOT NULL/);
    expect(migration).toMatch(/"deleted_at" IS NULL\s+AND "equipment_id" IS NULL\s+AND "line_id" IS NOT NULL/);
    expect(migration).not.toMatch(/\bDELETE\s+FROM\s+"downtime_entries"/i);
  });
});
