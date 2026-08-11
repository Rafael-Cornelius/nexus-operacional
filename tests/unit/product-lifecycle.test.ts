import { describe, expect, it, vi } from "vitest";
import { ProductsService } from "../../apps/api/src/modules/products/products.service";

describe("product lifecycle", () => {
  it("soft deletes and restores a product as inactive with audit history", async () => {
    const active = { id: "product-1", active: true, deletedAt: null, weightConfig: {} };
    const deleted = { ...active, active: false, deletedAt: new Date("2026-07-19T12:00:00.000Z") };
    const restored = { ...deleted, deletedAt: null };
    const product = {
      findUnique: vi.fn().mockResolvedValueOnce(active).mockResolvedValueOnce(deleted),
      update: vi.fn().mockResolvedValueOnce(deleted).mockResolvedValueOnce(restored)
    };
    const audit = { record: vi.fn() };
    const transaction = { product };
    const service = new ProductsService({
      ...transaction,
      $transaction: vi.fn(async (operation: (client: typeof transaction) => Promise<unknown>) => operation(transaction))
    } as never, audit as never);

    await expect(service.remove("product-1")).resolves.toEqual(deleted);
    await expect(service.restore("product-1")).resolves.toEqual(restored);
    expect(product.update).toHaveBeenNthCalledWith(2, expect.objectContaining({
      data: expect.objectContaining({ active: false, deletedAt: null })
    }));
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: "delete" }), transaction);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: "restore" }), transaction);
  });

  it("refuses invented defaults when a missing weight configuration receives a partial patch", async () => {
    const product = {
      findUnique: vi.fn().mockResolvedValue({ id: "product-1", defaultSectorId: "sector-1", weightConfig: null }),
      update: vi.fn()
    };
    const transaction = { product };
    const service = new ProductsService({
      ...transaction,
      $transaction: vi.fn(async (operation: (client: typeof transaction) => Promise<unknown>) => operation(transaction))
    } as never, { record: vi.fn() } as never);

    await expect(service.update("product-1", { boxWeightKg: 10 })).rejects.toThrow("Informe todos os campos tecnicos");
    expect(product.update).not.toHaveBeenCalled();
  });

  it("rejects product creation when transactional audit fails", async () => {
    const created = { id: "product-1", code: "72169", name: "Produto", weightConfig: {} };
    const transaction = {
      sector: { findUniqueOrThrow: vi.fn().mockResolvedValue({ id: "sector-1", code: "P1" }) },
      product: { create: vi.fn().mockResolvedValue(created) }
    };
    const prisma = { $transaction: vi.fn(async (operation: (client: typeof transaction) => Promise<unknown>) => operation(transaction)) };
    const auditError = new Error("audit unavailable");
    const audit = { record: vi.fn().mockRejectedValue(auditError) };
    const service = new ProductsService(prisma as never, audit as never);

    await expect(service.create({
      code: "72169",
      name: "Produto",
      defaultSector: "P1",
      unit: "KG",
      packageWeightKg: 1,
      boxWeightKg: 10,
      packagesPerBox: 10,
      massWeightKg: 10,
      targetPackageWeightG: 1000,
      overweightTolerancePercent: 0.02,
      formula: "BOX_WEIGHT"
    })).rejects.toBe(auditError);
    expect(transaction.product.create).toHaveBeenCalledOnce();
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: "create", after: created }), transaction);
    expect(prisma.$transaction).toHaveBeenCalledOnce();
  });
});
