import { describe, expect, it, vi } from "vitest";
import { ProductsService } from "../../apps/api/src/modules/products/products.service";

const productId = "2f08e255-87dc-40ca-83f6-5697fb660224";
const responsible = {
  id: "88a61adf-9717-45ea-88de-2ab1e3bc0cc0",
  email: "responsavel@nexus.local",
  roles: ["SUPERVISOR"]
};

describe("product price periods", () => {
  it("allows an overlapping draft so legacy history does not block a governed replacement", async () => {
    const period = { id: "draft-period", productId, status: "DRAFT", version: 4 };
    const transaction = {
      productPricePeriod: {
        findFirst: vi.fn().mockResolvedValue({ version: 3 }),
        create: vi.fn().mockResolvedValue(period)
      }
    };
    const prisma = {
      product: { findUnique: vi.fn().mockResolvedValue({ id: productId, deletedAt: null }) },
      $transaction: vi.fn((operation: (client: typeof transaction) => unknown) => operation(transaction))
    };
    const service = new ProductsService(prisma as never, { record: vi.fn() } as never);

    await expect(service.addPricePeriod(productId, {
      startsOn: "2026-07-01",
      endsOn: "2026-07-31",
      pricePerKg: 12.5,
      filmCostPerKg: 2,
      currency: "BRL",
      origin: "Contrato fornecedor"
    }, responsible)).resolves.toEqual(period);
    expect(transaction.productPricePeriod.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ version: 4, status: "DRAFT" })
    });
  });

  it("creates a future non-overlapping period without changing the current product price", async () => {
    const period = {
      id: "new-period",
      productId,
      startsOn: new Date("2030-01-01T00:00:00.000Z"),
      endsOn: null,
      pricePerKg: 15,
      filmCostPerKg: 3,
      currency: "BRL",
      origin: "Cotacao aprovada",
      status: "DRAFT",
      version: 3,
      responsibleBy: responsible.id
    };
    const findFirst = vi.fn().mockResolvedValue({ version: 2 });
    const transaction = {
      productPricePeriod: {
        findFirst,
        create: vi.fn().mockResolvedValue(period)
      }
    };
    const prisma = {
      product: {
        findUnique: vi.fn().mockResolvedValue({ id: productId, deletedAt: null })
      },
      $transaction: vi.fn((operation: (client: typeof transaction) => unknown) => operation(transaction))
    };
    const audit = { record: vi.fn() };
    const service = new ProductsService(prisma as never, audit as never);

    await expect(service.addPricePeriod(productId, {
      startsOn: "2030-01-01",
      pricePerKg: 15,
      filmCostPerKg: 3,
      currency: "BRL",
      origin: "Cotacao aprovada"
    }, responsible)).resolves.toEqual(period);
    expect(transaction.productPricePeriod.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        productId,
        version: 3,
        status: "DRAFT",
        responsibleBy: responsible.id,
        currency: "BRL",
        origin: "Cotacao aprovada"
      })
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "create_price_draft" }),
      transaction
    );
  });
});
