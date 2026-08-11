import { BadRequestException, ConflictException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { ImportStagingService } from "../../apps/api/src/modules/import/import-staging.service";
import { isPromotionBlocker } from "../../apps/api/src/modules/import/import-staging-policy";

const batchId = "11111111-1111-4111-8111-111111111111";
const recordId = "22222222-2222-4222-8222-222222222222";
const user = {
  id: "33333333-3333-4333-8333-333333333333",
  email: "supervisor@nexus.local",
  roles: ["SUPERVISOR"]
};
const lineId = "44444444-4444-4444-8444-444444444444";
const downtimeReasonId = "55555555-5555-4555-8555-555555555555";

function record(overrides: Record<string, unknown> = {}) {
  return {
    id: recordId,
    batchId,
    domain: "PRODUCT",
    classification: "ERROR",
    decision: "PENDING",
    version: 1,
    promotedAt: null,
    sourceFingerprint: "fingerprint",
    interpretedValue: { code: "P-001", name: "Fonte" },
    correctedValue: null,
    validationIssues: [{ field: "name", message: "Revisar" }],
    resolutionReason: null,
    resolvedBy: null,
    resolvedAt: null,
    sheetName: "Pacotes-caixas",
    rowNumber: 2,
    batch: { status: "STAGED" },
    ...overrides
  };
}

function fixture(overrides?: { changed?: number; current?: Record<string, unknown> }) {
  const current = record(overrides?.current);
  const updated = record({
    ...overrides?.current,
    classification: "VALID",
    decision: "CORRECTED",
    correctedValue: { code: "P-001", name: "Produto revisado" },
    resolutionReason: "Peso e cadastro conferidos na planilha fonte.",
    resolvedBy: user.id,
    resolvedAt: new Date("2026-07-19T12:00:00.000Z"),
    version: 2
  });
  const transaction = vi.fn();
  const prisma = {
    $transaction: transaction,
    importStagingRecord: {
      findFirst: vi.fn().mockResolvedValue(current),
      updateMany: vi.fn().mockResolvedValue({ count: overrides?.changed ?? 1 }),
      findUniqueOrThrow: vi.fn().mockResolvedValue(updated)
    },
    importError: { updateMany: vi.fn() }
  };
  transaction.mockImplementation((callback: (client: typeof prisma) => unknown) => callback(prisma));
  const audit = { record: vi.fn() };
  return { prisma, audit, service: new ImportStagingService(prisma as never, audit as never) };
}

const correctedProduct = {
  code: "P-001",
  name: "Produto revisado",
  defaultSector: "P1",
  packageWeightKg: 1,
  boxWeightKg: 10,
  packagesPerBox: 10,
  massWeightKg: 5,
  targetPackageWeightG: 500,
  overweightTolerancePercent: 0.02,
  pricePerKg: 2.5,
  formula: "BOX_WEIGHT",
  unit: "kg",
  active: true
};

describe("staging review workflow", () => {
  it("uses the same promotion policy for quarantined and unknown domains", () => {
    expect(isPromotionBlocker({ domain: "DOSAGE", classification: "VALID", decision: "PENDING" })).toBe(true);
    expect(isPromotionBlocker({ domain: "HISTORY", classification: "VALID", decision: "APPROVED" })).toBe(true);
    expect(isPromotionBlocker({ domain: "UNKNOWN", classification: "VALID", decision: "PENDING" })).toBe(true);
    expect(isPromotionBlocker({ domain: "DOSAGE", classification: "VALID", decision: "IGNORED" })).toBe(false);
    expect(isPromotionBlocker({ domain: "PRODUCT", classification: "VALID", decision: "PENDING" })).toBe(false);
  });

  it("stores correction separately from immutable original with optimistic version and audit", async () => {
    const { service, prisma, audit } = fixture();

    await expect(service.correct(batchId, recordId, {
      value: correctedProduct,
      reason: "Peso e cadastro conferidos na planilha fonte.",
      version: 1
    }, user)).resolves.toMatchObject({ decision: "CORRECTED", version: 2 });

    expect(prisma.importStagingRecord.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: recordId, batchId, version: 1, promotedAt: null }),
      data: expect.objectContaining({
        correctedValue: correctedProduct,
        classification: "VALID",
        decision: "CORRECTED",
        version: { increment: 1 }
      })
    }));
    expect(prisma.importError.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "CORRECTED", resolvedBy: user.id })
    }));
    expect(audit.record.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ action: "correct_staging_record" }));
    expect(audit.record.mock.calls[0]?.[1]).toBe(prisma);
    expect(audit.record.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      before: expect.objectContaining({ correctedValue: null, interpretedValue: expect.any(Object) }),
      after: expect.objectContaining({
        correctedValue: expect.objectContaining({ name: "Produto revisado" }),
        resolutionReason: expect.stringContaining("conferidos")
      })
    }));
  });

  it("rejects approval of ERROR until correction", async () => {
    const { service, prisma } = fixture();

    await expect(service.review(batchId, recordId, {
      action: "APPROVE",
      reason: "Tentativa de aprovar sem corrigir erro.",
      version: 1
    }, user)).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.importStagingRecord.updateMany).not.toHaveBeenCalled();
  });

  it("returns conflict when another reviewer already changed the row", async () => {
    const { service } = fixture({
      changed: 0,
      current: { classification: "REQUIRES_REVIEW", interpretedValue: correctedProduct }
    });

    await expect(service.review(batchId, recordId, {
      action: "APPROVE",
      reason: "Conferencia humana concluida com fonte original.",
      version: 1
    }, user)).rejects.toBeInstanceOf(ConflictException);
  });

  it("requires official downtime mappings before a review can be approved", async () => {
    const { service } = fixture({ current: {
      domain: "DOWNTIME",
      classification: "REQUIRES_REVIEW",
      interpretedValue: {
        sector: "P1",
        date: "2026-05-04",
        productionStart: "08:00:00",
        productionEnd: "16:00:00",
        downtimeStart: "10:00:00",
        downtimeEnd: "11:00:00",
        producedMassKg: 0,
        reason: "SETUP",
        legacyLine: "M1"
      }
    } });

    await expect(service.review(batchId, recordId, {
      action: "APPROVE",
      reason: "Mapeamento oficial ainda nao foi informado.",
      version: 1
    }, user)).rejects.toThrow("lineId");
  });

  it("does not presume midnight rollover when downtime end clock is earlier", async () => {
    const { service } = fixture({ current: { domain: "DOWNTIME" } });
    const value = {
      sector: "P1",
      lineId,
      downtimeReasonId,
      date: "2026-05-04",
      productionStart: "22:00:00",
      productionEnd: "06:00:00",
      downtimeStart: "23:00:00",
      downtimeEnd: "01:00:00",
      producedMassKg: 0,
      reason: "SETUP",
      legacyLine: "M1",
      legacyWeekNumber: 1
    };

    await expect(service.correct(batchId, recordId, {
      value,
      reason: "Virada de dia ainda nao possui datas confirmadas.",
      version: 1
    }, user)).rejects.toBeInstanceOf(BadRequestException);

    await expect(service.correct(batchId, recordId, {
      value: {
        ...value,
        productionEndDate: "2026-05-05",
        downtimeEndDate: "2026-05-05"
      },
      reason: "Datas de termino confirmadas na fonte operacional.",
      version: 1
    }, user)).resolves.toBeDefined();
  });

  it("rejects impossible calendar dates instead of accepting JavaScript rollover", async () => {
    const { service } = fixture({ current: { domain: "DOWNTIME" } });
    await expect(service.correct(batchId, recordId, {
      value: {
        sector: "P1",
        lineId,
        downtimeReasonId,
        date: "2026-02-30",
        productionStart: "08:00:00",
        productionEnd: "16:00:00",
        downtimeStart: "10:00:00",
        downtimeEnd: "11:00:00",
        producedMassKg: 0,
        reason: "SETUP",
        legacyLine: "M1",
        legacyWeekNumber: 1
      },
      reason: "Data impossivel deve ser rejeitada antes da promocao.",
      version: 1
    }, user)).rejects.toThrow("data invalida");
  });
});
