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
    const service = new ProductsService({ product } as never, audit as never);

    await expect(service.remove("product-1")).resolves.toEqual(deleted);
    await expect(service.restore("product-1")).resolves.toEqual(restored);
    expect(product.update).toHaveBeenNthCalledWith(2, expect.objectContaining({
      data: expect.objectContaining({ active: false, deletedAt: null })
    }));
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: "delete" }));
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: "restore" }));
  });

  it("refuses invented defaults when a missing weight configuration receives a partial patch", async () => {
    const product = {
      findUnique: vi.fn().mockResolvedValue({ id: "product-1", defaultSectorId: "sector-1", weightConfig: null }),
      update: vi.fn()
    };
    const service = new ProductsService({ product } as never, { record: vi.fn() } as never);

    await expect(service.update("product-1", { boxWeightKg: 10 })).rejects.toThrow("Informe todos os campos tecnicos");
    expect(product.update).not.toHaveBeenCalled();
  });
});
