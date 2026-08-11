import { readFileSync } from "node:fs";
import { join } from "node:path";
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
  filmShift1Kg: 5,
  filmShift2Kg: 3,
  boxLossUnits: 4,
  boxLossShift1Units: 1,
  boxLossShift2Units: 3,
  downtimeRows: 1,
  downtimeMinutes: 30
};

function serviceFixture(overrides?: {
  productionKg?: number;
  boxLossUnits?: number;
  pendingErrors?: number;
  independentDerivedMetrics?: boolean;
  stagingProductionKg?: number;
  workflowStatus?: "DRAFT" | "APPROVED";
  completeReconciliationScope?: boolean;
  sourceUnknownMetrics?: Record<string, number>;
}) {
  const pendingErrors = Array.from({ length: overrides?.pendingErrors ?? 0 }, (_, index) => ({ id: `error-${index}` }));
  const prisma = {
    importBatch: {
      findUnique: vi.fn().mockResolvedValue({
        id: batchId,
        sourceFile: "relatorios.xlsx",
        originalFileName: "Relatórios.xlsx",
        fileHash: "hash",
        status: "IMPORTED",
        importerVersion: "xlsx-normalizer-v3",
        summary: {
          excelTotals: { ...sourceTotals, unknownMetrics: overrides?.sourceUnknownMetrics },
          stagingTotals: {
            ...sourceTotals,
            productionKg: overrides?.stagingProductionKg ?? sourceTotals.productionKg
          },
          sourceIntegrity: {
            independentDerivedMetrics: overrides?.independentDerivedMetrics ?? true,
            completeReconciliationScope: overrides?.completeReconciliationScope ?? true
          }
        },
        errors: pendingErrors,
        stagingRecords: []
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
      }),
      findMany: vi.fn().mockResolvedValue([
        { id: "production-1", deletedAt: null, workflowStatus: overrides?.workflowStatus ?? "APPROVED" },
        { id: "production-2", deletedAt: null, workflowStatus: "APPROVED" }
      ])
    },
    lossEntry: {
      aggregate: vi.fn().mockResolvedValue({
        _count: 1,
        _sum: {
          quantityKg: 8,
          filmShift1Kg: 5,
          filmShift2Kg: 3,
          boxLossUnits: overrides?.boxLossUnits ?? 4,
          boxLossShift1Units: 1,
          boxLossShift2Units: 3
        }
      }),
      findMany: vi.fn().mockResolvedValue([
        { id: "loss-1", deletedAt: null, workflowStatus: "APPROVED" }
      ])
    },
    downtimeEntry: {
      aggregate: vi.fn().mockResolvedValue({ _count: 1, _sum: { stoppedMinutes: 30 } }),
      findMany: vi.fn().mockResolvedValue([
        { id: "downtime-1", deletedAt: null, workflowStatus: "APPROVED" }
      ])
    },
    $queryRaw: vi.fn().mockResolvedValue([{ id: batchId }])
  };
  Object.assign(prisma, {
    $transaction: vi.fn((operation: (transaction: typeof prisma) => unknown) => operation(prisma))
  });
  const audit = { record: vi.fn() };
  return { prisma, audit, service: new ReconciliationService(prisma as never, audit as never) };
}

describe("Excel to database reconciliation", () => {
  it("reports matching implemented metrics but keeps full certification blocked while required domains are absent", async () => {
    const { service, audit } = serviceFixture();

    await expect(service.report(batchId)).resolves.toMatchObject({
      status: "MATCH",
      certified: false,
      eligibleForCertification: false,
      pendingErrors: 0,
      metrics: expect.arrayContaining([
        expect.objectContaining({ key: "productionKg", excel: 1000, database: 1000, difference: 0, status: "MATCH" })
      ])
    });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: "reconcile", entityId: batchId }));
  });

  it("certifies only after the independent full-scope gate is satisfied", async () => {
    const { service, prisma, audit } = serviceFixture();
    vi.spyOn(service as never, "sourceIntegrity" as never).mockReturnValue({
      independentDerivedMetrics: true,
      completeReconciliationScope: true
    } as never);

    await expect(service.certify(batchId, "Conferencia concluida pelo responsavel", { id: "9bd519e4-f691-4a62-a656-cbb8382d678b", email: "admin@nexus.local", roles: ["ADMIN"] })).resolves.toMatchObject({
      batchStatus: "CERTIFIED",
      certified: true
    });
    expect(prisma.importBatch.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: batchId },
      data: expect.objectContaining({ status: "CERTIFIED" })
    }));
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: "certify_reconciliation" }), prisma);
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

  it("refuses certification when reviewed staging still diverges from the independent Excel totals", async () => {
    const { service } = serviceFixture({ productionKg: 980, stagingProductionKg: 980 });

    await expect(service.report(batchId)).resolves.toMatchObject({
      status: "DIVERGENT",
      excelToStagingStatus: "DIVERGENT",
      stagingToDatabaseStatus: "MATCH",
      eligibleForCertification: false
    });
  });

  it("refuses certification until every promoted operational row is approved", async () => {
    const { service } = serviceFixture({ workflowStatus: "DRAFT" });

    await expect(service.report(batchId)).resolves.toMatchObject({
      status: "MATCH",
      pendingOperationalApprovals: 1,
      eligibleForCertification: false
    });
  });

  it("detects box-unit divergence independently from film kilograms", async () => {
    const { service } = serviceFixture({ boxLossUnits: 5 });

    const result = await service.report(batchId);
    expect(result.metrics.find((metric) => metric.key === "boxLossUnits")).toMatchObject({
      unit: "boxes",
      excel: 4,
      database: 5,
      difference: 1,
      tolerance: 0,
      status: "DIVERGENT"
    });
  });

  it("does not certify a circular staging calculation as independent Excel reconciliation", async () => {
    const { service } = serviceFixture({ independentDerivedMetrics: false });

    await expect(service.report(batchId)).resolves.toMatchObject({
      status: "MATCH",
      eligibleForCertification: false,
      sourceIntegrity: { independentDerivedMetrics: false }
    });
  });

  it("does not certify a source contract that omits required reconciliation domains", async () => {
    const { service } = serviceFixture({ completeReconciliationScope: false });

    await expect(service.report(batchId)).resolves.toMatchObject({
      eligibleForCertification: false,
      sourceIntegrity: { completeReconciliationScope: false }
    });
  });

  it("shows an unknown source metric as incomplete instead of silently converting it to zero", async () => {
    const { service } = serviceFixture({ sourceUnknownMetrics: { registeredLossKg: 1 } });

    const report = await service.report(batchId);
    expect(report).toMatchObject({ status: "INCOMPLETE", eligibleForCertification: false });
    expect(report.metrics.find((metric) => metric.key === "registeredLossKg")).toMatchObject({
      excel: null,
      excelKnownSubtotal: 8,
      excelUnknownValues: 1,
      stagingStatus: "INCOMPLETE"
    });
  });

  it("does not trust legacy totals without an explicit independent-source contract", async () => {
    const { service, prisma } = serviceFixture();
    prisma.importBatch.findUnique.mockResolvedValueOnce({
      id: batchId,
      sourceFile: "legacy.xlsx",
      originalFileName: null,
      fileHash: "hash",
      importerVersion: null,
      status: "IMPORTED",
      summary: { sourceTotals },
      errors: [],
      stagingRecords: []
    });

    await expect(service.report(batchId)).resolves.toMatchObject({
      eligibleForCertification: false,
      sourceIntegrity: { independentDerivedMetrics: false }
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

  it("freezes certified evidence and imported rows at the database boundary", () => {
    const migration = readFileSync(
      join(__dirname, "../../prisma/migrations/0016_certified_import_immutability/migration.sql"),
      "utf8"
    );
    expect(migration).toContain("FOR KEY SHARE");
    expect(migration).toContain("CERTIFIED");
    expect(migration).toContain("LEGACY_CERTIFIED");
    for (const table of [
      "production_entries",
      "loss_entries",
      "downtime_entries",
      "import_staging_records",
      "import_errors",
      "import_batches"
    ]) {
      expect(migration).toContain(`ON "${table}"`);
    }
  });
});
