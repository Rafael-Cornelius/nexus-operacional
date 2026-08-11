import { describe, expect, it, vi } from "vitest";
import { ImportService } from "../../apps/api/src/modules/import/import.service";

function reportWithYield(overrides?: { packedBoxes?: number; errorCount?: number }) {
  return {
    file: "/isolated/workbook.xlsx",
    errors: overrides?.errorCount ? { "#REF!": overrides.errorCount } : {},
    legacyData: {
      products: [
        {
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
          source: { productRows: [{ sheet: "Pacotes-caixas", row: 2 }], weightRows: [] }
        }
      ],
      duplicateProductCodes: [],
      duplicateWeightCodes: [],
      importErrors: [],
      productionEntries: [
        {
          sheetName: "Plan x Real (P1)",
          rowNumber: 12,
          sector: "P1",
          legacyWeekNumber: 1,
          date: "2026-05-04",
          productCode: "P-001",
          productionOrder: "OP-001",
          plannedBatches: 5,
          realizedBatches: 1,
          usedReworkKg: 0,
          packedBoxes: overrides?.packedBoxes ?? 1,
          weighingLossKg: 0,
          generatedReworkKg: 0,
          averagePackageWeightG: 500,
          pricePerKg: 2
        }
      ],
      lossEntries: [],
      downtimeEntries: [],
      operationalImportErrors: []
    }
  };
}

describe("professional XLSX staging", () => {
  it("preserves original and interpreted values and blocks yield above 100% for review", () => {
    const service = new ImportService({} as never, { record: vi.fn() } as never);
    const records = (
      service as unknown as {
        buildStagingRecords(report: unknown): Array<Record<string, unknown>>;
      }
    ).buildStagingRecords(reportWithYield({ packedBoxes: 1 }));

    const production = records.find((record) => record.domain === "PRODUCTION");
    expect(production).toMatchObject({
      classification: "REQUIRES_REVIEW",
      decision: "PENDING",
      rawOriginal: expect.objectContaining({
        productionOrder: "OP-001",
        realizedBatches: 1,
        packedBoxes: 1
      }),
      interpretedValue: expect.objectContaining({
        calculationPreview: expect.objectContaining({
          producedKg: 10,
          expectedYieldKg: 5,
          rawRealYieldPercent: 2,
          storedRealYieldPercent: 2,
          inconsistencies: expect.arrayContaining([
            expect.stringContaining("Rendimento acima de 100%")
          ])
        })
      }),
      validationIssues: expect.arrayContaining([
        expect.objectContaining({
          source: "calculation",
          classification: "REQUIRES_REVIEW",
          message: expect.stringContaining("Rendimento acima de 100%")
        })
      ])
    });
  });

  it("creates an unresolved staging blocker for workbook formula errors instead of converting them to zero", () => {
    const service = new ImportService({} as never, { record: vi.fn() } as never);
    const records = (
      service as unknown as {
        buildStagingRecords(report: unknown): Array<Record<string, unknown>>;
      }
    ).buildStagingRecords(reportWithYield({ packedBoxes: 0, errorCount: 1454 }));

    expect(records).toContainEqual(expect.objectContaining({
      domain: "UNKNOWN",
      classification: "ERROR",
      decision: "PENDING",
      rawOriginal: expect.objectContaining({ errorType: "#REF!", count: 1454 }),
      validationIssues: expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining("nenhuma foi convertida para zero") })
      ])
    }));
  });

  it("requires approval for every P1 yield while formula remains unhomologated", () => {
    const service = new ImportService({} as never, { record: vi.fn() } as never);
    const records = (
      service as unknown as { buildStagingRecords(report: unknown): Array<Record<string, unknown>> }
    ).buildStagingRecords(reportWithYield({ packedBoxes: 0.4 }));

    expect(records.find((record) => record.domain === "PRODUCTION")).toMatchObject({
      classification: "REQUIRES_REVIEW",
      decision: "PENDING",
      validationIssues: expect.arrayContaining([
        expect.objectContaining({
          source: "rule-registry",
          message: expect.stringContaining("aguardam homologacao")
        })
      ])
    });
  });

  it("keeps compatibility product preparation read-only until atomic promotion", async () => {
    const audit = { record: vi.fn() };
    const prisma = {
      importBatch: {
        findUnique: vi.fn().mockResolvedValue({
          id: "11111111-1111-4111-8111-111111111111",
          status: "STAGED",
          summary: {},
          _count: { stagingRecords: 4 }
        })
      }
    };
    const service = new ImportService(prisma as never, audit as never);

    await expect(service.importProducts("11111111-1111-4111-8111-111111111111")).resolves.toMatchObject({
      status: "STAGED",
      stagedRecords: 4
    });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: "prepare_staging_products" }));
  });
});
