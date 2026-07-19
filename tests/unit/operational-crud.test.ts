import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { DowntimeController } from "../../apps/api/src/modules/downtime/downtime.controller";
import { DowntimeService } from "../../apps/api/src/modules/downtime/downtime.service";
import { LossesController } from "../../apps/api/src/modules/losses/losses.controller";
import { LossesService } from "../../apps/api/src/modules/losses/losses.service";
import { ProductionController } from "../../apps/api/src/modules/production/production.controller";
import { ProductionService } from "../../apps/api/src/modules/production/production.service";
import { ROLES_KEY } from "../../apps/api/src/modules/auth/roles.decorator";

const ids = {
  week: "11111111-1111-4111-8111-111111111111",
  otherWeek: "22222222-2222-4222-8222-222222222222",
  entry: "33333333-3333-4333-8333-333333333333",
  product: "44444444-4444-4444-8444-444444444444",
  sector: "55555555-5555-4555-8555-555555555555",
  order: "66666666-6666-4666-8666-666666666666",
  otherOrder: "77777777-7777-4777-8777-777777777777",
  type: "88888888-8888-4888-8888-888888888888",
  reason: "99999999-9999-4999-8999-999999999999",
  line: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  equipment: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  user: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
};

const week = {
  id: ids.week,
  status: "OPEN",
  startsOn: new Date("2026-05-04T00:00:00.000Z"),
  endsOn: new Date("2026-05-10T00:00:00.000Z"),
  deletedAt: null
};

const user = {
  id: ids.user,
  email: "supervisor@nexus.local",
  roles: ["SUPERVISOR"]
};

describe("operational CRUD RBAC", () => {
  it.each([[ProductionController.prototype], [LossesController.prototype], [DowntimeController.prototype]])(
    "keeps reads broad, writes operational and destructive actions restricted",
    (controller) => {
      expect(Reflect.getMetadata(ROLES_KEY, controller.getById)).toEqual(["ADMIN", "MANAGER", "SUPERVISOR", "OPERATOR", "VIEWER"]);
    expect(Reflect.getMetadata(ROLES_KEY, controller.update)).toEqual(["ADMIN", "SUPERVISOR", "OPERATOR"]);
    expect(Reflect.getMetadata(ROLES_KEY, controller.softDelete)).toEqual(["ADMIN", "SUPERVISOR"]);
    expect(Reflect.getMetadata(ROLES_KEY, controller.restore)).toEqual(["ADMIN", "SUPERVISOR"]);
    expect(Reflect.getMetadata(ROLES_KEY, controller.submit)).toEqual(["ADMIN", "SUPERVISOR", "OPERATOR"]);
    expect(Reflect.getMetadata(ROLES_KEY, controller.approve)).toEqual(["ADMIN", "MANAGER", "SUPERVISOR"]);
    expect(Reflect.getMetadata(ROLES_KEY, controller.reject)).toEqual(["ADMIN", "MANAGER", "SUPERVISOR"]);
    }
  );
});

describe("production operational CRUD", () => {
  it("rejects empty or unknown PATCH payloads before accessing the database", async () => {
    const findUnique = vi.fn();
    const service = new ProductionService({ productionEntry: { findUnique } } as never, { record: vi.fn() } as never);

    await expect(service.update(ids.entry, { version: 1 }, user)).rejects.toThrow("Informe ao menos um campo");
    await expect(service.update(ids.entry, { version: 1, adminOverride: true }, user)).rejects.toThrow("Unrecognized key");
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("recalculates derived production and financial fields on PATCH and audits before/after", async () => {
    const current = {
      id: ids.entry,
      version: 1,
      workflowStatus: "APPROVED",
      deletedAt: null,
      weekId: ids.week,
      week,
      sectorId: ids.sector,
      sector: { id: ids.sector, code: "P1" },
      line: null,
      lineId: null,
      productId: ids.product,
      product: { id: ids.product },
      productionOrderId: ids.order,
      order: { id: ids.order },
      date: new Date("2026-05-05T00:00:00.000Z"),
      productionOrder: "OP-100",
      plannedBatches: 10,
      realizedBatches: 10,
      usedReworkKg: 0,
      packedBoxes: 10,
      producedKg: 100,
      weighingLossKg: 1,
      generatedReworkKg: 0,
      expectedYieldKg: 100,
      realYieldPercent: 1,
      massWeightKg: 10,
      boxWeightKg: 10,
      targetPackageWeightG: 1000,
      averagePackageWeightG: 1000,
      overweightGPerPackage: 0,
      overweightTotalKg: 0,
      overweightPercent: 0,
      unitPricePerKg: 10,
      productionCost: 1000,
      lossesCost: 10,
      overweightCost: 0,
      status: "OK",
      notes: "Conferencia do turno"
    };
    const updated = {
      ...current,
      packedBoxes: 20,
      producedKg: 200,
      productionCost: 2000
    };
    const productionUpdate = vi.fn().mockResolvedValue(updated);
    const auditRecord = vi.fn().mockResolvedValue(undefined);
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      productionEntry: {
        findUnique: vi.fn().mockResolvedValue(current),
        findFirst: vi.fn().mockResolvedValue(null),
        update: productionUpdate
      },
      weeklyPeriod: { findUnique: vi.fn().mockResolvedValue(week) },
      product: {
        findUnique: vi.fn().mockResolvedValue({
          id: ids.product,
          active: true,
          deletedAt: null,
          pricePerKg: 10,
          weightConfig: {
            formula: "BOX_WEIGHT",
            packageWeightKg: 1,
            boxWeightKg: 10,
            packagesPerBox: 10,
            massWeightKg: 10,
            targetPackageWeightG: 1000,
            overweightTolerancePercent: 0.02
          }
        })
      },
      sector: {
        findUnique: vi.fn().mockResolvedValue({ id: ids.sector, code: "P1" })
      },
      productPricePeriod: {
        findFirst: vi.fn().mockResolvedValue({
          id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          pricePerKg: 10,
          version: 1,
          origin: "MANUAL",
          currency: "BRL"
        })
      },
      productionOrder: {
        findUnique: vi.fn().mockResolvedValue(null),
        upsert: vi.fn().mockResolvedValue({ id: ids.order, sectorCode: "P1" })
      }
    };
    const prisma = {
      ...transaction,
      $transaction: vi.fn((operation: (client: typeof transaction) => unknown) => operation(transaction))
    };
    const service = new ProductionService(prisma as never, { record: auditRecord } as never);

    await expect(service.update(ids.entry, { version: 1, packedBoxes: 20, changeReason: "Correcao de apontamento aprovado" }, user)).resolves.toMatchObject({
      id: ids.entry,
      calculations: { producedKg: 200 }
    });
    expect(productionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          packedBoxes: 20,
          producedKg: 200,
          productionCost: 2000,
          workflowStatus: "DRAFT",
          version: { increment: 1 },
          updatedBy: ids.user
        })
      })
    );
    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "update",
        entityId: ids.entry,
        before: current,
        after: updated,
        reason: "Correcao de apontamento aprovado"
      }),
      transaction
    );
  });

  it("does not restore a production entry into a closed week", async () => {
    const productionUpdate = vi.fn();
    const auditRecord = vi.fn();
    const prisma = {
      productionEntry: {
        findUnique: vi.fn().mockResolvedValue({
          id: ids.entry,
          version: 1,
          workflowStatus: "CANCELLED",
          deletedAt: new Date("2026-05-06T10:00:00.000Z"),
          date: new Date("2026-05-05T00:00:00.000Z"),
          week: { ...week, status: "CLOSED" }
        }),
        update: productionUpdate
      }
    };
    const service = new ProductionService(prisma as never, { record: auditRecord } as never);

    await expect(service.restore(ids.entry, { version: 1, reason: "Correcao autorizada" }, user)).rejects.toThrow("Semana fechada");
    expect(productionUpdate).not.toHaveBeenCalled();
    expect(auditRecord).not.toHaveBeenCalled();
  });
});

describe("losses operational CRUD", () => {
  it("recalculates loss cost on PATCH and records the audit trail", async () => {
    const current = {
      id: ids.entry,
      version: 1,
      workflowStatus: "DRAFT",
      deletedAt: null,
      weekId: ids.week,
      week,
      date: new Date("2026-05-05T00:00:00.000Z"),
      sector: { id: ids.sector, code: "P1" },
      productId: ids.product,
      product: { id: ids.product },
      productionOrderId: null,
      productionOrder: null,
      lossTypeId: ids.type,
      lossType: { id: ids.type },
      quantityKg: 5,
      packedBoxes: 10,
      reason: "Ajuste",
      notes: null
    };
    const updated = {
      ...current,
      quantityKg: 8,
      lossCost: 80,
      financialResult: -80
    };
    const lossUpdate = vi.fn().mockResolvedValue(updated);
    const auditRecord = vi.fn().mockResolvedValue(undefined);
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: ids.entry }]),
      lossEntry: {
        findUnique: vi.fn().mockResolvedValue(current),
        update: lossUpdate
      },
      weeklyPeriod: { findUnique: vi.fn().mockResolvedValue(week) },
      lossType: {
        findUnique: vi.fn().mockResolvedValue({ id: ids.type, code: "PRODUCT", active: true })
      },
      product: {
        findUnique: vi.fn().mockResolvedValue({
          id: ids.product,
          active: true,
          deletedAt: null,
          pricePerKg: 10,
          filmCostPerKg: 2,
          packageFilmWeightG: 3,
          weightConfig: { packagesPerBox: 10 }
        })
      },
      sector: {
        findUnique: vi.fn().mockResolvedValue({ id: ids.sector, code: "P1" })
      },
      productPricePeriod: {
        findFirst: vi.fn().mockResolvedValue({ pricePerKg: 10, filmCostPerKg: 2 })
      }
    };
    const prisma = {
      ...transaction,
      $transaction: vi.fn((operation: (client: typeof transaction) => unknown) => operation(transaction))
    };
    const service = new LossesService(prisma as never, { record: auditRecord } as never);

    await expect(service.update(ids.entry, { version: 1, quantityKg: 8 }, user)).resolves.toEqual(updated);
    expect(lossUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          quantityKg: 8,
          unitCost: 10,
          lossCost: 80,
          financialResult: -80,
          version: { increment: 1 }
        })
      })
    );
    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "update",
        before: current,
        after: updated
      }),
      transaction
    );
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "Serializable" });
  });

  it("rejects an order from another week before updating a loss", async () => {
    const current = {
      id: ids.entry,
      version: 1,
      workflowStatus: "DRAFT",
      deletedAt: null,
      weekId: ids.week,
      week,
      date: new Date("2026-05-05T00:00:00.000Z"),
      sector: { id: ids.sector, code: "P1" },
      productId: ids.product,
      product: { id: ids.product },
      productionOrderId: null,
      productionOrder: null,
      lossTypeId: ids.type,
      lossType: { id: ids.type },
      quantityKg: 5,
      packedBoxes: 10,
      reason: "Ajuste",
      notes: null
    };
    const lossUpdate = vi.fn();
    const auditRecord = vi.fn();
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: ids.entry }]),
      lossEntry: {
        findUnique: vi.fn().mockResolvedValue(current),
        update: lossUpdate
      },
      weeklyPeriod: { findUnique: vi.fn().mockResolvedValue(week) },
      lossType: {
        findUnique: vi.fn().mockResolvedValue({ id: ids.type, code: "PRODUCT", active: true })
      },
      product: {
        findUnique: vi.fn().mockResolvedValue({
          id: ids.product,
          active: true,
          deletedAt: null,
          pricePerKg: 10,
          filmCostPerKg: 2,
          packageFilmWeightG: 3,
          weightConfig: { packagesPerBox: 10 }
        })
      },
      sector: {
        findUnique: vi.fn().mockResolvedValue({ id: ids.sector, code: "P1" })
      },
      productionOrder: {
        findUnique: vi.fn().mockResolvedValue({
          id: ids.otherOrder,
          weekId: ids.otherWeek,
          productId: ids.product,
          sectorCode: "P1",
          deletedAt: null
        })
      }
    };
    const prisma = {
      ...transaction,
      $transaction: vi.fn((operation: (client: typeof transaction) => unknown) => operation(transaction))
    };
    const service = new LossesService(prisma as never, { record: auditRecord } as never);

    await expect(service.update(ids.entry, { version: 1, productionOrderId: ids.otherOrder }, user)).rejects.toThrow("pertencer a semana");
    expect(lossUpdate).not.toHaveBeenCalled();
    expect(auditRecord).not.toHaveBeenCalled();
  });

  it("restores a soft-deleted loss in an open week and audits it", async () => {
    const current = {
      id: ids.entry,
      version: 1,
      workflowStatus: "CANCELLED",
      deletedAt: new Date("2026-05-06T10:00:00.000Z"),
      date: new Date("2026-05-05T00:00:00.000Z"),
      week
    };
    const restored = { ...current, deletedAt: null };
    const lossUpdate = vi.fn().mockResolvedValue(restored);
    const auditRecord = vi.fn().mockResolvedValue(undefined);
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: ids.entry }]),
      lossEntry: {
        findUnique: vi.fn().mockResolvedValue(current),
        update: lossUpdate
      }
    };
    const prisma = {
      ...transaction,
      $transaction: vi.fn((operation: (client: typeof transaction) => unknown) => operation(transaction))
    };
    const service = new LossesService(prisma as never, { record: auditRecord } as never);

    await expect(service.restore(ids.entry, { version: 1, reason: "Restauracao autorizada" }, user)).resolves.toEqual(restored);
    expect(lossUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ deletedAt: null, workflowStatus: "DRAFT", version: { increment: 1 }, updatedBy: ids.user })
      })
    );
    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "restore",
        before: current,
        after: restored
      }),
      transaction
    );
  });
});

describe("downtime operational CRUD", () => {
  it("recalculates downtime fields and can clear an optional production line", async () => {
    const current = {
      id: ids.entry,
      version: 1,
      workflowStatus: "DRAFT",
      deletedAt: null,
      weekId: ids.week,
      week,
      date: new Date("2026-05-05T00:00:00.000Z"),
      sectorId: ids.sector,
      sector: { id: ids.sector, code: "P1" },
      lineId: ids.line,
      line: { id: ids.line },
      equipmentId: ids.equipment,
      equipment: { id: ids.equipment },
      productionStart: new Date("2026-05-05T08:00:00.000Z"),
      productionEnd: new Date("2026-05-05T16:00:00.000Z"),
      downtimeStart: new Date("2026-05-05T10:00:00.000Z"),
      downtimeEnd: new Date("2026-05-05T11:00:00.000Z"),
      producedMassKg: 400,
      downtimeReasonId: ids.reason,
      reason: { id: ids.reason },
      notes: "Parada conferida"
    };
    const updated = {
      ...current,
      lineId: null,
      line: null,
      producedMassKg: 600
    };
    const downtimeUpdate = vi.fn().mockResolvedValue(updated);
    const auditRecord = vi.fn().mockResolvedValue(undefined);
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      downtimeEntry: {
        findUnique: vi.fn().mockResolvedValue(current),
        findFirst: vi.fn().mockResolvedValue(null),
        update: downtimeUpdate
      },
      weeklyPeriod: { findUnique: vi.fn().mockResolvedValue(week) },
      sector: {
        findUnique: vi.fn().mockResolvedValue({ id: ids.sector, code: "P1" })
      },
      productionLine: { findUnique: vi.fn() },
      equipment: {
        findUnique: vi.fn().mockResolvedValue({
          id: ids.equipment,
          productionLineId: null,
          productionLine: null,
          active: true,
          deletedAt: null
        })
      },
      downtimeReason: {
        findUnique: vi.fn().mockResolvedValue({ id: ids.reason, active: true })
      }
    };
    const prisma = {
      $transaction: vi.fn((operation: (client: typeof transaction) => unknown) => operation(transaction))
    };
    const service = new DowntimeService(prisma as never, { record: auditRecord } as never);

    await expect(service.update(ids.entry, { version: 1, lineId: null, producedMassKg: 600 }, user)).resolves.toMatchObject({
      id: ids.entry,
      calculations: {
        stoppedMinutes: 60,
        stoppedPercent: 0.125,
        realKgHour: 75
      }
    });
    expect(transaction.productionLine.findUnique).not.toHaveBeenCalled();
    expect(transaction.$queryRaw).toHaveBeenCalledOnce();
    expect(downtimeUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          lineId: null,
          stoppedMinutes: 60,
          stoppedPercent: 0.125,
          updatedBy: ids.user,
          version: { increment: 1 }
        })
      })
    );
    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "update",
        before: current,
        after: updated
      }),
      transaction
    );
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "Serializable" });
  });

  it("rejects a downtime interval outside the production window", async () => {
    const downtimeCreate = vi.fn();
    const transaction = {
      weeklyPeriod: { findUnique: vi.fn().mockResolvedValue(week) },
      downtimeEntry: { create: downtimeCreate },
      sector: { findUnique: vi.fn() },
      productionLine: { findUnique: vi.fn() },
      downtimeReason: { findUnique: vi.fn() }
    };
    const prisma = {
      $transaction: vi.fn((operation: (client: typeof transaction) => unknown) => operation(transaction))
    };
    const service = new DowntimeService(prisma as never, { record: vi.fn() } as never);

    await expect(
      service.create({
        weekId: ids.week,
        date: "2026-05-05",
        sector: "P1",
        lineId: ids.line,
        productionStart: "2026-05-05T08:00:00.000Z",
        productionEnd: "2026-05-05T16:00:00.000Z",
        downtimeStart: "2026-05-05T07:00:00.000Z",
        downtimeEnd: "2026-05-05T09:00:00.000Z",
        producedMassKg: 100,
        downtimeReasonId: ids.reason
      })
    ).rejects.toThrow("contido no periodo de producao");
    expect(downtimeCreate).not.toHaveBeenCalled();
  });

  it("rejects overlapping downtime entries for the same production line", async () => {
    const downtimeCreate = vi.fn();
    const transaction = {
      weeklyPeriod: { findUnique: vi.fn().mockResolvedValue(week) },
      downtimeEntry: {
        findFirst: vi.fn().mockResolvedValue({ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }),
        create: downtimeCreate
      },
      sector: {
        findUnique: vi.fn().mockResolvedValue({ id: ids.sector, code: "P1" })
      },
      productionLine: {
        findUnique: vi.fn().mockResolvedValue({
          id: ids.line,
          sectorId: ids.sector,
          active: true,
          deletedAt: null
        })
      },
      downtimeReason: {
        findUnique: vi.fn().mockResolvedValue({ id: ids.reason, active: true })
      }
    };
    const prisma = {
      $transaction: vi.fn((operation: (client: typeof transaction) => unknown) => operation(transaction))
    };
    const service = new DowntimeService(prisma as never, { record: vi.fn() } as never);

    await expect(
      service.create({
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
      })
    ).rejects.toThrow("parada sobreposta");
    expect(downtimeCreate).not.toHaveBeenCalled();
  });
});
