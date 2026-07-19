import { describe, expect, it, vi } from "vitest";
import { ProductsService } from "../../apps/api/src/modules/products/products.service";

const productId = "2f08e255-87dc-40ca-83f6-5697fb660224";

describe("product price periods", () => {
  it("blocks overlapping price validity ranges", async () => {
    const prisma = {
      product: { findUnique: vi.fn().mockResolvedValue({ id: productId, deletedAt: null }) },
      productPricePeriod: {
        findFirst: vi.fn().mockResolvedValue({ id: "existing-period" }),
        create: vi.fn()
      }
    };
    const service = new ProductsService(prisma as never, { record: vi.fn() } as never);

    await expect(service.addPricePeriod(productId, {
      startsOn: "2026-07-01",
      endsOn: "2026-07-31",
      pricePerKg: 12.5,
      filmCostPerKg: 2
    })).rejects.toThrow("sobrepoe");
    expect(prisma.productPricePeriod.create).not.toHaveBeenCalled();
  });

  it("creates a future non-overlapping period without changing the current product price", async () => {
    const period = {
      id: "new-period",
      productId,
      startsOn: new Date("2030-01-01T00:00:00.000Z"),
      endsOn: null,
      pricePerKg: 15,
      filmCostPerKg: 3
    };
    const prisma = {
      product: {
        findUnique: vi.fn().mockResolvedValue({ id: productId, deletedAt: null }),
        update: vi.fn()
      },
      productPricePeriod: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue(period)
      }
    };
    const audit = { record: vi.fn() };
    const service = new ProductsService(prisma as never, audit as never);

    await expect(service.addPricePeriod(productId, {
      startsOn: "2030-01-01",
      pricePerKg: 15,
      filmCostPerKg: 3
    })).resolves.toEqual(period);
    expect(prisma.product.update).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: "add_price_period" }));
  });
});
