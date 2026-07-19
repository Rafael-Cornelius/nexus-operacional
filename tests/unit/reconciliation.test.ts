import { describe, expect, it, vi } from "vitest";
import { ReconciliationService } from "../../apps/api/src/modules/reconciliation/reconciliation.service";

const batchId = "886e503e-9dc3-46c1-a851-e4c58fa68bcc";
const sourceTotals = {
  productionRows: 2,
  plannedBatches: 20,
  realizedBatches: 18,
  packedBoxes: 90,
  usedReworkKg: 4,
  generatedReworkKg: 3,
  productionKg: 1000,
  weighingLossKg: 12.5,
  overweightKg: 5,
  lossRows: 1,
  registeredLossKg: 8,
  downtimeRows: 1,
  downtimeMinutes: 30
};

function serviceFixture(overrides?: { productionKg?: number; pendingErrors?: number }) {
  const pendingErrors = Array.from({ length: overrides?.pendingErrors ?? 0 }, (_, index) => ({ id: `error-${index}` }));
  const prisma = {
    importBatch: {
      findUnique: vi.fn().mockResolvedValue({
        id: batchId,
        sourceFile: "relatorios.xlsx",
        originalFileName: "Relatórios.xlsx",
        fileHash: "hash",
        status: "IMPORTED",
        summary: { sourceTotals },
        errors: pendingErrors
      }),
      update: vi.fn().mockResolvedValue({ id: batchId, status: "CERTIFIED" })
    },
    productionEntry: {
      aggregate: vi.fn().mockResolvedValue({
        _count: 2,
        _sum: {
          plannedBatches: 20,
          realizedBatches: 18,
          packedBoxes: 90,
          usedReworkKg: 4,
          generatedReworkKg: 3,
          producedKg: overrides?.productionKg ?? 1000,
          weighingLossKg: 12.5,
          overweightTotalKg: 5
        }
      })
    },
    lossEntry: { aggregate: vi.fn().mockResolvedValue({ _count: 1, _sum: { quantityKg: 8 } }) },
    downtimeEntry: { aggregate: vi.fn().mockResolvedValue({ _count: 1, _sum: { stoppedMinutes: 30 } }) }
  };
  const audit = { record: vi.fn() };
  return { prisma, audit, service: new ReconciliationService(prisma as never, audit as never) };
}

describe("Excel to database reconciliation", () => {
  it("marks a matching batch as eligible but requires explicit certification", async () => {
    const { service, audit } = serviceFixture();

    await expect(service.report(batchId)).resolves.toMatchObject({
      status: "MATCH",
      certified: false,
      eligibleForCertification: true,
      pendingErrors: 0,
      metrics: expect.arrayContaining([
        expect.objectContaining({ key: "productionKg", excel: 1000, database: 1000, difference: 0, status: "MATCH" })
      ])
    });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: "reconcile", entityId: batchId }));
  });

  it("certifies a matching batch only through an audited admin action", async () => {
    const { service, prisma, audit } = serviceFixture();

    await expect(service.certify(batchId, "Conferencia concluida pelo responsavel", { id: "9bd519e4-f691-4a62-a656-cbb8382d678b", email: "admin@nexus.local", roles: ["ADMIN"] })).resolves.toMatchObject({
      batchStatus: "CERTIFIED",
      certified: true
    });
    expect(prisma.importBatch.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: batchId },
      data: expect.objectContaining({ status: "CERTIFIED" })
    }));
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: "certify_reconciliation" }));
  });

  it("reports the exact divergence and refuses certification", async () => {
    const { service } = serviceFixture({ productionKg: 980 });

    const result = await service.report(batchId);
    expect(result).toMatchObject({ status: "DIVERGENT", certified: false });
    expect(result.metrics.find((metric) => metric.key === "productionKg")).toMatchObject({
      excel: 1000,
      database: 980,
      difference: -20,
      status: "DIVERGENT"
    });
  });

  it("requires the batch to be reprocessed when legacy summaries have no source totals", async () => {
    const prisma = {
      importBatch: {
        findUnique: vi.fn().mockResolvedValue({
          id: batchId,
          sourceFile: "antigo.xlsx",
          originalFileName: null,
          fileHash: null,
          status: "CLEANED",
          summary: { productionEntryCount: 10 },
          errors: []
        })
      },
      productionEntry: { aggregate: vi.fn() }
    };
    const service = new ReconciliationService(prisma as never, { record: vi.fn() } as never);

    await expect(service.report(batchId)).resolves.toMatchObject({
      status: "SOURCE_TOTALS_UNAVAILABLE",
      certified: false
    });
    expect(prisma.productionEntry.aggregate).not.toHaveBeenCalled();
  });
});
