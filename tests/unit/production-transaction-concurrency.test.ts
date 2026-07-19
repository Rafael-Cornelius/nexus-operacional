import { ConflictException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { ProductionService } from "../../apps/api/src/modules/production/production.service";

const ids = {
  week: "10000000-0000-4000-8000-000000000001",
  sector: "10000000-0000-4000-8000-000000000002",
  product: "10000000-0000-4000-8000-000000000003",
  entry: "10000000-0000-4000-8000-000000000004",
  order: "10000000-0000-4000-8000-000000000005",
  price: "10000000-0000-4000-8000-000000000006",
  user: "10000000-0000-4000-8000-000000000007"
};

const user = {
  id: ids.user,
  email: "operador@nexus.local",
  roles: ["OPERATOR"]
};

const week = {
  id: ids.week,
  status: "OPEN",
  startsOn: new Date("2026-05-04T00:00:00.000Z"),
  endsOn: new Date("2026-05-10T00:00:00.000Z"),
  deletedAt: null
};

const sector = { id: ids.sector, code: "P1" };

const product = {
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
};

const pricePeriod = {
  id: ids.price,
  productId: ids.product,
  startsOn: new Date("2026-05-01T00:00:00.000Z"),
  endsOn: null,
  pricePerKg: 10,
  filmCostPerKg: 0,
  version: 1,
  origin: "MANUAL",
  currency: "BRL",
  status: "APPROVED"
};

const payload = {
  weekId: ids.week,
  sector: "P1",
  date: "2026-05-05",
  productId: ids.product,
  productionOrder: "OP-100",
  plannedBatches: 10,
  realizedBatches: 8,
  usedReworkKg: 2,
  packedBoxes: 80,
  weighingLossKg: 1,
  generatedReworkKg: 3,
  averagePackageWeightG: 1000
};

const current = {
  id: ids.entry,
  version: 1,
  workflowStatus: "DRAFT",
  deletedAt: null,
  weekId: ids.week,
  week,
  sectorId: ids.sector,
  sector,
  lineId: null,
  equipmentId: null,
  shiftId: null,
  productId: ids.product,
  product,
  productionOrderId: ids.order,
  order: { id: ids.order },
  date: new Date("2026-05-05T00:00:00.000Z"),
  productionOrder: "OP-100",
  plannedBatches: 10,
  realizedBatches: 8,
  usedReworkKg: 2,
  packedBoxes: 80,
  producedKg: 800,
  weighingLossKg: 1,
  generatedReworkKg: 3,
  expectedYieldKg: 800,
  realYieldPercent: 1,
  massWeightKg: 10,
  boxWeightKg: 10,
  targetPackageWeightG: 1000,
  averagePackageWeightG: 1000,
  overweightGPerPackage: 0,
  overweightTotalKg: 0,
  overweightPercent: 0,
  unitPricePerKg: 10,
  productionCost: 8000,
  lossesCost: 10,
  overweightCost: 0,
  calculationRuleVersions: {},
  status: "OK",
  notes: null
};

function referenceData() {
  return {
    weeklyPeriod: { findUnique: vi.fn().mockResolvedValue(week) },
    product: { findUnique: vi.fn().mockResolvedValue(product) },
    sector: { findUnique: vi.fn().mockResolvedValue(sector) },
    productPricePeriod: { findFirst: vi.fn().mockResolvedValue(pricePeriod) }
  };
}

function orderKey(call: { where: { weekId_orderNumber_productId: { orderNumber: string } } }) {
  return call.where.weekId_orderNumber_productId.orderNumber;
}

describe("production write transactions and concurrency", () => {
  it("rolls back order and entry when the audit write fails", async () => {
    const state: { orders: Array<{ id: string; orderNumber: string; sectorCode: string }>; entries: unknown[] } = {
      orders: [],
      entries: []
    };
    const transaction = {
      ...referenceData(),
      $queryRaw: vi.fn().mockResolvedValue([]),
      productionOrder: {
        findUnique: vi.fn(({ where }) => Promise.resolve(
          state.orders.find((row) => row.orderNumber === orderKey({ where })) ?? null
        )),
        upsert: vi.fn(({ create }) => {
          const order = { id: ids.order, ...create };
          state.orders.push(order);
          return Promise.resolve(order);
        })
      },
      productionEntry: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn(({ data }) => {
          const entry = { id: ids.entry, ...data };
          state.entries.push(entry);
          return Promise.resolve(entry);
        })
      }
    };
    const prisma = {
      $transaction: vi.fn(async (operation) => {
        const orders = [...state.orders];
        const entries = [...state.entries];
        try {
          return await operation(transaction);
        } catch (error) {
          state.orders = orders;
          state.entries = entries;
          throw error;
        }
      })
    };
    const audit = vi.fn().mockRejectedValue(new Error("audit unavailable"));
    const service = new ProductionService(prisma as never, { record: audit } as never);

    await expect(service.create(payload, user)).rejects.toThrow("audit unavailable");
    expect(state.orders).toEqual([]);
    expect(state.entries).toEqual([]);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "create" }), transaction);
  });

  it("rolls back a newly-created ProductionOrder when optimistic update loses the race", async () => {
    const state = {
      orders: [{ id: ids.order, orderNumber: "OP-100", sectorCode: "P1", deletedAt: null }]
    };
    const transaction = {
      ...referenceData(),
      $queryRaw: vi.fn().mockResolvedValue([]),
      productionEntry: {
        findUnique: vi.fn().mockResolvedValue(current),
        findFirst: vi.fn().mockResolvedValue(null),
        update: vi.fn().mockRejectedValue({ code: "P2025" })
      },
      productionOrder: {
        findUnique: vi.fn(({ where }) => Promise.resolve(
          state.orders.find((row) => row.orderNumber === orderKey({ where })) ?? null
        )),
        upsert: vi.fn(({ create }) => {
          const order = { id: "new-order", ...create, deletedAt: null };
          state.orders.push(order);
          return Promise.resolve(order);
        })
      }
    };
    const prisma = {
      $transaction: vi.fn(async (operation) => {
        const orders = [...state.orders];
        try {
          return await operation(transaction);
        } catch (error) {
          state.orders = orders;
          throw error;
        }
      })
    };
    const audit = vi.fn();
    const service = new ProductionService(prisma as never, { record: audit } as never);

    const error = await service.update(ids.entry, {
      version: 1,
      productionOrder: "OP-NEW"
    }, user).catch((caught) => caught);

    expect(error).toBeInstanceOf(ConflictException);
    expect(error.getStatus()).toBe(409);
    expect(state.orders.map((row) => row.orderNumber)).toEqual(["OP-100"]);
    expect(audit).not.toHaveBeenCalled();
  });

  it("rejects only an active operationally-identical row and allows a distinct partial row for the same OP", async () => {
    const findFirst = vi.fn(({ where }) => Promise.resolve(
      where.packedBoxes === payload.packedBoxes ? { id: "existing-entry" } : null
    ));
    const create = vi.fn(({ data }) => Promise.resolve({ id: ids.entry, ...data }));
    const transaction = {
      ...referenceData(),
      $queryRaw: vi.fn().mockResolvedValue([]),
      productionEntry: { findFirst, create },
      productionOrder: {
        findUnique: vi.fn().mockResolvedValue({ id: ids.order, sectorCode: "P1", deletedAt: null }),
        upsert: vi.fn().mockResolvedValue({ id: ids.order, sectorCode: "P1" })
      }
    };
    const prisma = { $transaction: vi.fn((operation) => operation(transaction)) };
    const audit = vi.fn().mockResolvedValue(undefined);
    const service = new ProductionService(prisma as never, { record: audit } as never);

    const identical = await service.create(payload, user).catch((caught) => caught);
    expect(identical).toBeInstanceOf(ConflictException);
    expect(identical.getStatus()).toBe(409);
    expect(identical.message).toContain("ativo identico");

    await expect(service.create({ ...payload, packedBoxes: 81 }, user)).resolves.toMatchObject({
      productionOrder: "OP-100",
      packedBoxes: 81
    });
    expect(create).toHaveBeenCalledOnce();
    expect(findFirst).toHaveBeenLastCalledWith({
      where: expect.objectContaining({
        deletedAt: null,
        weekId: ids.week,
        productId: ids.product,
        productionOrder: "OP-100",
        packedBoxes: 81,
        plannedBatches: 10,
        realizedBatches: 8
      }),
      select: { id: true }
    });
  });

  it("serializes concurrent identical creates so one succeeds and the other receives HTTP 409", async () => {
    const orders: Array<{ id: string; orderNumber: string; sectorCode: string; deletedAt: null }> = [];
    const entries: Array<Record<string, unknown>> = [];
    const lockTails = new Map<string, Promise<void>>();
    let nextId = 1;
    const audit = vi.fn().mockResolvedValue(undefined);
    const prisma = {
      $transaction: vi.fn(async (operation) => {
        const releases: Array<() => void> = [];
        const transaction = {
          ...referenceData(),
          productionEntry: {
            findFirst: vi.fn(({ where }) => Promise.resolve(entries.find((row) =>
              row.deletedAt === null &&
              row.weekId === where.weekId &&
              row.productId === where.productId &&
              row.productionOrder === where.productionOrder &&
              row.packedBoxes === where.packedBoxes
            ) ?? null)),
            create: vi.fn(({ data }) => {
              const entry = { id: `entry-${nextId++}`, deletedAt: null, ...data };
              entries.push(entry);
              return Promise.resolve(entry);
            })
          },
          productionOrder: {
            findUnique: vi.fn(({ where }) => Promise.resolve(
              orders.find((row) => row.orderNumber === orderKey({ where })) ?? null
            )),
            upsert: vi.fn(({ create }) => {
              const existing = orders.find((row) => row.orderNumber === create.orderNumber);
              if (existing) return Promise.resolve(existing);
              const order = { id: `order-${orders.length + 1}`, ...create, deletedAt: null };
              orders.push(order);
              return Promise.resolve(order);
            })
          },
          $queryRaw: vi.fn(async (query) => {
            const key = String(query.values[0]);
            const previous = lockTails.get(key) ?? Promise.resolve();
            let release = () => undefined;
            const held = new Promise<void>((resolve) => {
              release = resolve;
            });
            lockTails.set(key, previous.then(() => held));
            await previous;
            releases.push(release);
            return [];
          })
        };
        try {
          return await operation(transaction);
        } finally {
          releases.reverse().forEach((release) => release());
        }
      })
    };
    const service = new ProductionService(prisma as never, { record: audit } as never);

    const results = await Promise.allSettled([
      service.create(payload, user),
      service.create(payload, user)
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejection = results.find((result) => result.status === "rejected");
    expect(rejection).toMatchObject({ reason: { status: 409 } });
    expect(entries).toHaveLength(1);
    expect(orders).toHaveLength(1);
    expect(audit).toHaveBeenCalledOnce();
  });

  it("serializes concurrent duplicate requests and reserves COPIA then COPIA-2", async () => {
    const orders = [{ id: ids.order, orderNumber: "OP-100", sectorCode: "P1", deletedAt: null }];
    const duplicated: Array<{ id: string; productionOrder: string }> = [];
    const lockTails = new Map<string, Promise<void>>();
    let nextId = 1;

    const prisma = {
      $transaction: vi.fn(async (operation) => {
        const releases: Array<() => void> = [];
        const transaction = {
          productPricePeriod: { findFirst: vi.fn().mockResolvedValue(pricePeriod) },
          productionEntry: {
            findUnique: vi.fn().mockResolvedValue(current),
            create: vi.fn(({ data }) => {
              const entry = { id: `copy-${nextId++}`, ...data };
              duplicated.push(entry);
              return Promise.resolve(entry);
            })
          },
          productionOrder: {
            findUnique: vi.fn(({ where }) => Promise.resolve(
              orders.find((row) => row.orderNumber === orderKey({ where })) ?? null
            )),
            upsert: vi.fn(({ create }) => {
              const existing = orders.find((row) => row.orderNumber === create.orderNumber);
              if (existing) return Promise.resolve(existing);
              const order = { id: `order-${orders.length + 1}`, ...create, deletedAt: null };
              orders.push(order);
              return Promise.resolve(order);
            })
          },
          $queryRaw: vi.fn(async (query) => {
            const key = String(query.values[0]);
            const previous = lockTails.get(key) ?? Promise.resolve();
            let release = () => undefined;
            const held = new Promise<void>((resolve) => {
              release = resolve;
            });
            lockTails.set(key, previous.then(() => held));
            await previous;
            releases.push(release);
            return [];
          })
        };
        try {
          return await operation(transaction);
        } finally {
          releases.reverse().forEach((release) => release());
        }
      })
    };
    const audit = vi.fn().mockResolvedValue(undefined);
    const service = new ProductionService(prisma as never, { record: audit } as never);

    const copies = await Promise.all([
      service.duplicate(ids.entry, user),
      service.duplicate(ids.entry, user)
    ]);

    expect(copies.map((row) => row.productionOrder).sort()).toEqual(["OP-100-COPIA", "OP-100-COPIA-2"]);
    expect(duplicated).toHaveLength(2);
    expect(new Set(duplicated.map((row) => row.productionOrder)).size).toBe(2);
    expect(audit).toHaveBeenCalledTimes(2);
  });
});
