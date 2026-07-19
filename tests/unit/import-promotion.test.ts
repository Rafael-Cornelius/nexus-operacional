import { ConflictException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { ImportPromotionService } from "../../apps/api/src/modules/import/import-promotion.service";

const batchId = "11111111-1111-4111-8111-111111111111";
const recordId = "22222222-2222-4222-8222-222222222222";
const user = {
  id: "33333333-3333-4333-8333-333333333333",
  email: "manager@nexus.local",
  roles: ["MANAGER"]
};

function productRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: recordId,
    batchId,
    domain: "PRODUCT",
    sourceKey: "source",
    sourceFingerprint: "fingerprint",
    sheetName: "Pacotes-caixas",
    cell: null,
    rowNumber: 2,
    rawOriginal: {},
    interpretedValue: {
      code: "P-001",
      name: "Produto real",
      defaultSector: "P1",
      packageWeightKg: 1,
      boxWeightKg: 10,
      packagesPerBox: 10,
      massWeightKg: 5,
      targetPackageWeightG: 500,
      unit: "kg",
      overweightTolerancePercent: 0.02,
      formula: "BOX_WEIGHT",
      active: true,
      pricePerKg: 2
    },
    correctedValue: null,
    validationIssues: null,
    classification: "VALID",
    decision: "PENDING",
    resolutionReason: null,
    resolvedBy: null,
    resolvedAt: null,
    version: 1,
    promotedEntityId: null,
    promotedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides
  };
}

function productionRecord(overrides: Record<string, unknown> = {}) {
  return productRecord({
    id: "44444444-4444-4444-8444-444444444444",
    domain: "PRODUCTION",
    sheetName: "Plan x Real (P2)",
    rowNumber: 8,
    sourceFingerprint: "production-fingerprint",
    interpretedValue: {
      sector: "P2",
      legacyWeekNumber: 1,
      date: "2026-05-04",
      productCode: "P-001",
      productionOrder: "OP-001",
      plannedBatches: 2,
      realizedBatches: 2,
      usedReworkKg: 0,
      packedBoxes: 1,
      weighingLossKg: 0,
      generatedReworkKg: 0,
      averagePackageWeightG: 500,
      pricePerKg: 999
    },
    ...overrides
  });
}

function lossRecord(id: string, fingerprint: string, quantityKg: number) {
  return productRecord({
    id,
    domain: "LOSS",
    sourceFingerprint: fingerprint,
    sheetName: "CONTROLE DE PERDAS",
    rowNumber: quantityKg === 2 ? 12 : 13,
    interpretedValue: {
      date: "2026-05-07",
      quantityKg,
      filmShift1Kg: quantityKg,
      filmShift2Kg: 0,
      boxLossUnits: 0,
      boxLossShift1Units: 0,
      boxLossShift2Units: 0,
      sector: "P1",
      productCode: "P-001",
      legacyLine: "M1",
      lossType: "PACKAGING"
    }
  });
}

function downtimeRecord(overrides: Record<string, unknown> = {}) {
  return productRecord({
    id: "88888888-8888-4888-8888-888888888888",
    domain: "DOWNTIME",
    sourceFingerprint: "downtime-fingerprint",
    sheetName: "relatorios de paradas",
    classification: "VALID",
    decision: "CORRECTED",
    correctedValue: {
      sector: "P1",
      lineId: "99999999-9999-4999-8999-999999999999",
      downtimeReasonId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      date: "2026-05-05",
      productionStart: "08:00:00",
      productionEnd: "16:00:00",
      downtimeStart: "10:00:00",
      downtimeEnd: "11:00:00",
      producedMassKg: 100,
      reason: "Ajuste",
      legacyLine: "M1",
      legacyWeekNumber: 1
    },
    ...overrides
  });
}

function fixture(record: ReturnType<typeof productRecord> | Array<ReturnType<typeof productRecord>> = productRecord(), status = "STAGED") {
  const records = Array.isArray(record) ? record : [record];
  let lossSequence = 0;
  const tx = {
    importBatch: {
      findUnique: vi.fn().mockResolvedValue({
        id: batchId,
        status,
        summary: { excelTotals: {} },
        promotedAt: null,
        stagingRecords: records
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      update: vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: batchId, status: data.status, summary: data.summary, promotedAt: data.promotedAt })
      )
    },
    sector: {
      upsert: vi.fn().mockImplementation(({ where }: { where: { code: string } }) =>
        Promise.resolve({ id: where.code.toLowerCase(), code: where.code })
      )
    },
    product: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({ id: "product-1", code: "P-001" }),
      findMany: vi.fn().mockResolvedValue([
        {
          id: "product-1",
          code: "P-001",
          active: true,
          deletedAt: null,
          pricePerKg: 0,
          weightConfig: {
            formula: "BOX_WEIGHT",
            packageWeightKg: 1,
            boxWeightKg: 10,
            packagesPerBox: 10,
            massWeightKg: 5,
            targetPackageWeightG: 500,
            overweightTolerancePercent: 0.02
          }
        }
      ])
    },
    productWeightConfig: { upsert: vi.fn().mockResolvedValue({ id: "weight-1", productId: "product-1" }) },
    importStagingRecord: { update: vi.fn(), findFirst: vi.fn().mockResolvedValue(null) },
    lossType: { upsert: vi.fn().mockResolvedValue({ id: "packaging" }) },
    productionLine: {
      findFirst: vi.fn().mockResolvedValue({ id: "99999999-9999-4999-8999-999999999999", active: true, deletedAt: null })
    },
    downtimeReason: {
      findFirst: vi.fn().mockResolvedValue({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", active: true })
    },
    weeklyPeriod: {
      findFirst: vi.fn().mockResolvedValue({
        id: "week-1",
        label: "Semana 1",
        status: "OPEN",
        deletedAt: null,
        startsOn: new Date("2026-05-04T00:00:00.000Z"),
        endsOn: new Date("2026-05-10T00:00:00.000Z")
      }),
      findUnique: vi.fn(),
      create: vi.fn()
    },
    productionEntry: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: "production-1" }) },
    productionOrder: { upsert: vi.fn().mockResolvedValue({ id: "order-1" }) },
    lossEntry: { create: vi.fn().mockImplementation(() => Promise.resolve({ id: `loss-${++lossSequence}` })) },
    downtimeEntry: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: "downtime-1" }) },
    productPricePeriod: { findFirst: vi.fn().mockResolvedValue(null) },
    $queryRaw: vi.fn(),
    importError: { count: vi.fn().mockResolvedValue(0) },
    auditLog: { create: vi.fn() }
  };
  const prisma = {
    $transaction: vi.fn().mockImplementation((callback: (client: typeof tx) => unknown) => callback(tx)),
    importBatch: { updateMany: vi.fn() }
  };
  const audit = { record: vi.fn() };
  const staging = { assertDomainValue: vi.fn().mockImplementation((_domain, value) => value) };
  return {
    tx,
    prisma,
    audit,
    staging,
    service: new ImportPromotionService(prisma as never, audit as never, staging as never)
  };
}

describe("atomic staging promotion", () => {
  it("promotes selected rows, lineage and audit inside one serializable Prisma transaction", async () => {
    const { service, prisma, tx, staging, audit } = fixture();

    await expect(service.promote(batchId, user)).resolves.toMatchObject({
      id: batchId,
      status: "IMPORTED",
      idempotent: false
    });

    expect(prisma.$transaction).toHaveBeenCalledOnce();
    expect(staging.assertDomainValue).toHaveBeenCalledWith("PRODUCT", expect.objectContaining({ code: "P-001" }));
    expect(tx.product.upsert).toHaveBeenCalledOnce();
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: "create_imported_product",
      entity: "Product",
      before: undefined,
      after: expect.objectContaining({ stagingRecordId: recordId, sourceFingerprint: "fingerprint" })
    }), tx);
    expect(tx.importStagingRecord.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: recordId },
      data: expect.objectContaining({ promotedEntityId: "product-1", promotedAt: expect.any(Date) })
    }));
    expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: "promote_staging_batch", entityId: batchId })
    }));
  });

  it("blocks unresolved errors before any official write", async () => {
    const { service, tx } = fixture(productRecord({ classification: "ERROR" }));

    await expect(service.promote(batchId, user)).rejects.toBeInstanceOf(ConflictException);
    expect(tx.importBatch.updateMany).not.toHaveBeenCalled();
    expect(tx.product.upsert).not.toHaveBeenCalled();
  });

  it("does not copy a staged price into the deprecated product cache", async () => {
    const withoutPrice = productRecord();
    withoutPrice.interpretedValue = { ...withoutPrice.interpretedValue, pricePerKg: null };
    const { service, tx } = fixture(withoutPrice);
    tx.product.findUnique.mockResolvedValue({ id: "product-1" });

    await service.promote(batchId, user);

    const upsert = tx.product.upsert.mock.calls[0][0];
    expect(upsert.create).not.toHaveProperty("pricePerKg");
    expect(upsert.update).not.toHaveProperty("pricePerKg");
  });

  it("blocks production without an approved effective price even when XLSX carries a value", async () => {
    const { service, tx } = fixture([productRecord(), productionRecord()]);

    await expect(service.promote(batchId, user)).rejects.toBeInstanceOf(ConflictException);
    expect(tx.productPricePeriod.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: "APPROVED" })
    }));
    expect(tx.productionEntry.create).not.toHaveBeenCalled();
  });

  it("fails early when a new product needs an independently approved price before operational promotion", async () => {
    const { service, tx } = fixture([productRecord(), productionRecord()]);
    tx.product.findMany.mockResolvedValueOnce([]);

    await expect(service.promote(batchId, user)).rejects.toThrow("Cadastre e revise o produto");
    expect(tx.product.upsert).not.toHaveBeenCalled();
    expect(tx.productionEntry.create).not.toHaveBeenCalled();
  });

  it("rejects duplicate effective product codes before sequential upserts can overwrite data", async () => {
    const duplicate = productRecord({
      id: "77777777-7777-4777-8777-777777777777",
      correctedValue: { ...productRecord().interpretedValue, code: "p-001", name: "Segunda versao" },
      classification: "VALID",
      decision: "CORRECTED"
    });
    const { service, tx } = fixture([productRecord(), duplicate]);

    await expect(service.promote(batchId, user)).rejects.toThrow("mesmo codigo de produto");
    expect(tx.product.upsert).not.toHaveBeenCalled();
  });

  it("rejects operational facts for a product made inactive by the same staging batch", async () => {
    const inactive = productRecord({ interpretedValue: { ...productRecord().interpretedValue, active: false } });
    const { service, tx } = fixture([inactive, productionRecord()]);

    await expect(service.promote(batchId, user)).rejects.toThrow("desativados");
    expect(tx.productionEntry.create).not.toHaveBeenCalled();
  });

  it("uses only approved effective price and persists its lineage on imported production", async () => {
    const { service, tx } = fixture([productRecord(), productionRecord()]);
    tx.productPricePeriod.findFirst.mockResolvedValue({
      id: "price-1",
      status: "APPROVED",
      pricePerKg: 2.5,
      filmCostPerKg: 1.25,
      version: 3,
      origin: "Tabela homologada",
      currency: "BRL"
    });

    await expect(service.promote(batchId, user)).resolves.toMatchObject({ status: "IMPORTED" });
    expect(tx.productionEntry.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        pricePeriodId: "price-1",
        priceVersion: 3,
        priceOrigin: "Tabela homologada",
        priceCurrency: "BRL",
        unitPricePerKg: 2.5
      })
    }));
  });

  it("keeps distinct source rows for the same loss date and machine", async () => {
    const records = [
      lossRecord("55555555-5555-4555-8555-555555555555", "loss-row-12", 2),
      lossRecord("66666666-6666-4666-8666-666666666666", "loss-row-13", 3)
    ];
    const { service, tx } = fixture(records);
    tx.productPricePeriod.findFirst.mockResolvedValue({
      id: "price-film",
      status: "APPROVED",
      pricePerKg: 2.5,
      filmCostPerKg: 1.25,
      version: 2,
      origin: "Contrato de filme",
      currency: "BRL"
    });

    await expect(service.promote(batchId, user)).resolves.toMatchObject({ status: "IMPORTED" });
    expect(tx.lossEntry.create).toHaveBeenCalledTimes(2);
    expect(tx.importStagingRecord.findFirst).toHaveBeenCalledTimes(2);
  });

  it("blocks imported downtime timestamps outside the selected week", async () => {
    const invalid = downtimeRecord({
      correctedValue: {
        ...(downtimeRecord().correctedValue as Record<string, unknown>),
        productionStartDate: "2026-06-01",
        productionEndDate: "2026-06-01",
        downtimeStartDate: "2026-06-01",
        downtimeEndDate: "2026-06-01"
      }
    });
    const { service, tx } = fixture(invalid);

    await expect(service.promote(batchId, user)).rejects.toThrow("devem pertencer a semana");
    expect(tx.downtimeEntry.create).not.toHaveBeenCalled();
  });

  it("returns prior result idempotently after successful promotion", async () => {
    const { service, tx } = fixture(productRecord(), "IMPORTED");
    tx.importBatch.findUnique.mockResolvedValue({
      id: batchId,
      status: "IMPORTED",
      summary: { importedProducts: 1 },
      promotedAt: new Date("2026-07-19T00:00:00.000Z"),
      stagingRecords: [productRecord({ promotedAt: new Date() })]
    });

    await expect(service.promote(batchId, user)).resolves.toMatchObject({
      status: "IMPORTED",
      idempotent: true
    });
    expect(tx.importBatch.updateMany).not.toHaveBeenCalled();
    expect(tx.product.upsert).not.toHaveBeenCalled();
  });
});
