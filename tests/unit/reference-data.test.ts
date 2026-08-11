import "reflect-metadata";
import { readFileSync } from "node:fs";
import { PATH_METADATA } from "@nestjs/common/constants";
import { describe, expect, it, vi } from "vitest";
import { MasterDataController } from "../../apps/api/src/modules/master-data/master-data.controller";
import { MasterDataService } from "../../apps/api/src/modules/master-data/master-data.service";
import { ROLES_KEY } from "../../apps/api/src/modules/auth/roles.decorator";

const ids = {
  sector: "11111111-1111-4111-8111-111111111111",
  line: "22222222-2222-4222-8222-222222222222",
  lossType: "33333333-3333-4333-8333-333333333333",
  reason: "44444444-4444-4444-8444-444444444444",
  user: "55555555-5555-4555-8555-555555555555"
};

const admin = { id: ids.user, email: "admin@nexus.local", roles: ["ADMIN"] };

function transactionalService(transaction: Record<string, unknown>, auditRecord = vi.fn().mockResolvedValue(undefined)) {
  const prisma = {
    $transaction: vi.fn((operation: (client: typeof transaction) => unknown) => operation(transaction))
  };
  return {
    service: new MasterDataService(prisma as never, { record: auditRecord } as never),
    prisma,
    auditRecord
  };
}

describe("reference-data API contract", () => {
  it("publishes the reference-data route with broad reads and ADMIN-only writes", () => {
    const controller = MasterDataController.prototype;
    const readRoles = ["ADMIN", "MANAGER", "SUPERVISOR", "OPERATOR", "VIEWER"];

    expect(Reflect.getMetadata(PATH_METADATA, MasterDataController)).toBe("reference-data");
    for (const method of [controller.overview, controller.sectors, controller.lines, controller.lossTypes, controller.downtimeReasons]) {
      expect(Reflect.getMetadata(ROLES_KEY, method)).toEqual(readRoles);
    }
    for (const method of [
      controller.createSector,
      controller.updateSector,
      controller.deleteSector,
      controller.createLine,
      controller.updateLine,
      controller.deactivateLine,
      controller.restoreLine,
      controller.createLossType,
      controller.updateLossType,
      controller.deactivateLossType,
      controller.restoreLossType,
      controller.createDowntimeReason,
      controller.updateDowntimeReason,
      controller.deactivateDowntimeReason,
      controller.restoreDowntimeReason
    ]) {
      expect(Reflect.getMetadata(ROLES_KEY, method)).toEqual(["ADMIN"]);
    }
  });

  it("keeps active line selectors free of removed lines, while overview can request all", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const service = new MasterDataService({ productionLine: { findMany } } as never, { record: vi.fn() } as never);

    await service.lines({ active: "true" });
    expect(findMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: expect.objectContaining({ active: true, deletedAt: null })
    }));

    await service.lines({ deleted: "all" });
    expect(findMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: expect.objectContaining({ deletedAt: undefined })
    }));
  });
});

describe("atomic and auditable reference-data writes", () => {
  it("creates a sector and its audit record inside one serializable transaction", async () => {
    const sector = { id: ids.sector, code: "P1", name: "Producao 1", description: null };
    const transaction = {
      sector: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue(sector)
      }
    };
    const { service, prisma, auditRecord } = transactionalService(transaction);

    await expect(service.createSector({ code: "P1", name: "Producao 1" }, admin)).resolves.toEqual(sector);
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "Serializable" });
    expect(auditRecord).toHaveBeenCalledWith(expect.objectContaining({
      userId: ids.user,
      module: "master-data",
      action: "create",
      entity: "Sector",
      entityId: ids.sector,
      after: sector
    }), transaction);
  });

  it("rejects the whole operation when the same-transaction audit write fails", async () => {
    const transaction = {
      sector: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: ids.sector, code: "P1", name: "Producao 1" })
      }
    };
    const auditError = new Error("audit unavailable");
    const { service } = transactionalService(transaction, vi.fn().mockRejectedValue(auditError));

    await expect(service.createSector({ code: "P1", name: "Producao 1" }, admin)).rejects.toBe(auditError);
  });

  it("does not remove a sector that has operational dependencies", async () => {
    const remove = vi.fn();
    const transaction = {
      sector: { findUnique: vi.fn().mockResolvedValue({ id: ids.sector, code: "P1" }), delete: remove },
      productionLine: { count: vi.fn().mockResolvedValue(1) },
      product: { count: vi.fn().mockResolvedValue(0) },
      productionEntry: { count: vi.fn().mockResolvedValue(0) },
      lossEntry: { count: vi.fn().mockResolvedValue(0) },
      downtimeEntry: { count: vi.fn().mockResolvedValue(0) },
      goal: { count: vi.fn().mockResolvedValue(0) }
    };
    const { service, auditRecord } = transactionalService(transaction);

    await expect(service.deleteSector(ids.sector, admin)).rejects.toThrow("possui 1 vinculo");
    expect(remove).not.toHaveBeenCalled();
    expect(auditRecord).not.toHaveBeenCalled();
  });

  it("round-trips a line through deactivate and restore with both states audited", async () => {
    const active = { id: ids.line, sectorId: ids.sector, code: "L1", name: "Linha 1", active: true, deletedAt: null };
    const removed = { ...active, active: false, deletedAt: new Date("2026-08-01T10:00:00.000Z") };
    const restored = { ...active };
    const update = vi.fn().mockResolvedValueOnce(removed).mockResolvedValueOnce(restored);
    const transaction = {
      productionLine: {
        findUnique: vi.fn().mockResolvedValueOnce(active).mockResolvedValueOnce(removed),
        update
      },
      equipment: { count: vi.fn().mockResolvedValue(0) },
      sector: { findUnique: vi.fn().mockResolvedValue({ id: ids.sector, code: "P1" }) }
    };
    const { service, auditRecord } = transactionalService(transaction);

    await expect(service.deactivateLine(ids.line, admin)).resolves.toEqual(removed);
    await expect(service.restoreLine(ids.line, admin)).resolves.toEqual(restored);

    expect(update).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: { id: ids.line },
      data: expect.objectContaining({ active: false, deletedAt: expect.any(Date) })
    }));
    expect(update).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: { id: ids.line },
      data: { active: true, deletedAt: null }
    }));
    expect(auditRecord.mock.calls.map(([entry]) => entry.action)).toEqual(["deactivate", "restore"]);
    expect(auditRecord.mock.calls.every(([, client]) => client === transaction)).toBe(true);
  });

  it("accepts the real OVERWEIGHT enum and rejects nonexistent loss codes before SQL", async () => {
    const lossType = { id: ids.lossType, code: "OVERWEIGHT", name: "Sobrepeso", active: true };
    const transaction = {
      lossType: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue(lossType)
      }
    };
    const { service, prisma, auditRecord } = transactionalService(transaction);

    await expect(service.createLossType({ code: "OVERWEIGHT", name: "Sobrepeso" }, admin)).resolves.toEqual(lossType);
    await expect(service.createLossType({ code: "PRODUCTION", name: "Invalido" }, admin)).rejects.toThrow();
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(auditRecord).toHaveBeenCalledWith(expect.objectContaining({ entity: "LossType", action: "create" }), transaction);
  });

  it("prevents a case-insensitive duplicate downtime reason", async () => {
    const transaction = {
      downtimeReason: {
        findFirst: vi.fn().mockResolvedValue({ id: ids.reason, name: "Manutencao", active: true }),
        create: vi.fn(),
        update: vi.fn()
      }
    };
    const { service, auditRecord } = transactionalService(transaction);

    await expect(service.createDowntimeReason({ name: "MANUTENCAO" }, admin)).rejects.toThrow("Ja existe motivo");
    expect(transaction.downtimeReason.create).not.toHaveBeenCalled();
    expect(transaction.downtimeReason.update).not.toHaveBeenCalled();
    expect(auditRecord).not.toHaveBeenCalled();
  });
});

describe("reference-data web integration", () => {
  it("offers only Prisma loss codes and wires catalog, navigation, and equipment selector", () => {
    const page = readFileSync("apps/web/app/cadastros-base/page.tsx", "utf8");
    const equipment = readFileSync("apps/web/app/equipamentos/page.tsx", "utf8");
    const navigation = readFileSync("apps/web/lib/navigation.ts", "utf8");
    const options = page.slice(page.indexOf("const lossTypeCodes"), page.indexOf("export default function"));

    for (const code of ["PACKAGING", "BOX", "ORGANIC", "MACHINE", "WEIGHING", "OVERWEIGHT", "OTHER"]) {
      expect(options).toContain(`value: "${code}"`);
    }
    expect(options).not.toContain('value: "PRODUCTION"');
    expect(options).not.toContain('value: "REWORK"');
    expect(page).toContain("/reference-data/lines/${row.id}/restore");
    expect(equipment).toContain('/reference-data/lines?active=true');
    expect(equipment).toContain("<LineSelect");
    expect(navigation).toContain('href: "/cadastros-base"');
  });
});
