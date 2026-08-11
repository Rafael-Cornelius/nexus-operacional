import { ConflictException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { ImportService } from "../../apps/api/src/modules/import/import.service";
import { ImportStagingService } from "../../apps/api/src/modules/import/import-staging.service";

const batchId = "11111111-1111-4111-8111-111111111111";
const recordId = "22222222-2222-4222-8222-222222222222";
const user = {
  id: "33333333-3333-4333-8333-333333333333",
  email: "supervisor@nexus.local",
  roles: ["SUPERVISOR"]
};

describe("Excel source semantics and quarantine", () => {
  it("keeps unknown production values null and skips derived calculations", () => {
    const service = new ImportService({} as never, { record: vi.fn() } as never);
    const records = (
      service as unknown as { buildStagingRecords(report: unknown): Array<Record<string, unknown>> }
    ).buildStagingRecords({
      file: "/isolated/workbook.xlsx",
      legacyData: {
        products: [],
        importErrors: [],
        operationalImportErrors: [],
        lossEntries: [],
        downtimeEntries: [],
        productionEntries: [{
          sheetName: "Plan x Real (P2)",
          rowNumber: 12,
          sector: "P2",
          legacyWeekNumber: 1,
          date: "2026-05-04",
          productCode: "P-UNKNOWN",
          productionOrder: null,
          plannedBatches: 2,
          realizedBatches: 2,
          usedReworkKg: null,
          packedBoxes: 10,
          weighingLossKg: null,
          generatedReworkKg: null,
          pricePerKg: null,
          sourceCells: {
            H12: { cell: "H12", value: null, type: null, formula: null, formulaAttributes: null }
          }
        }]
      }
    });

    expect(records).toContainEqual(expect.objectContaining({
      domain: "PRODUCTION",
      classification: "ERROR",
      rawOriginal: expect.objectContaining({
        productionOrder: null,
        usedReworkKg: null,
        sourceCells: expect.objectContaining({ H12: expect.objectContaining({ value: null }) })
      }),
      interpretedValue: expect.not.objectContaining({ calculationPreview: expect.anything() }),
      validationIssues: expect.arrayContaining([
        expect.objectContaining({ field: "usedReworkKg", classification: "ERROR" }),
        expect.objectContaining({ field: "productionOrder", classification: "ERROR" })
      ])
    }));
  });

  it("creates one non-promotable staging record per broken formula cell", () => {
    const service = new ImportService({} as never, { record: vi.fn() } as never);
    const records = (
      service as unknown as { buildStagingRecords(report: unknown): Array<Record<string, unknown>> }
    ).buildStagingRecords({
      file: "/isolated/workbook.xlsx",
      formulaErrors: [{
        sheetName: "Dashboards",
        cell: "Q67",
        formula: "SUM('paradas m1'!#REF!)",
        formulaAttributes: {},
        calculatedValue: "0",
        cellType: null,
        errorType: "#REF!",
        context: "formula"
      }],
      errors: { "#REF!": 1 },
      legacyData: {
        products: [], productionEntries: [], lossEntries: [], downtimeEntries: [],
        importErrors: [], operationalImportErrors: []
      }
    });

    expect(records.filter((record) => record.domain === "UNKNOWN")).toHaveLength(1);
    expect(records).toContainEqual(expect.objectContaining({
      domain: "UNKNOWN",
      sheetName: "Dashboards",
      cell: "Q67",
      classification: "ERROR",
      rawOriginal: expect.objectContaining({
        formula: "SUM('paradas m1'!#REF!)",
        calculatedValue: "0"
      }),
      interpretedValue: expect.objectContaining({ promotable: false })
    }));
  });

  it("preserves film and box losses by shift without converting units", () => {
    const service = new ImportService({} as never, { record: vi.fn() } as never);
    const records = (
      service as unknown as { buildStagingRecords(report: unknown): Array<Record<string, unknown>> }
    ).buildStagingRecords({
      file: "/isolated/workbook.xlsx",
      legacyData: {
        products: [],
        productionEntries: [],
        downtimeEntries: [],
        importErrors: [],
        operationalImportErrors: [],
        lossEntries: [{
          sheetName: "CONTROLE DE PERDAS",
          rowNumber: 8,
          date: "2026-05-04",
          quantityKg: 6.22,
          filmShift1Kg: 4.12,
          filmShift2Kg: 2.1,
          boxLossUnits: 3,
          boxLossShift1Units: 2,
          boxLossShift2Units: 1,
          sector: null,
          productCode: null,
          legacyLine: "M1/MQ",
          lossType: "PACKAGING",
          sourceCells: {
            D8: { cell: "D8", value: "6.22", type: null, formula: "E8+F8", formulaAttributes: {} }
          }
        }]
      }
    });

    expect(records).toContainEqual(expect.objectContaining({
      domain: "LOSS",
      classification: "ERROR",
      interpretedValue: expect.objectContaining({
        quantityKg: 6.22,
        filmShift1Kg: 4.12,
        filmShift2Kg: 2.1,
        boxLossUnits: 3,
        boxLossShift1Units: 2,
        boxLossShift2Units: 1
      }),
      rawOriginal: expect.objectContaining({
        sourceCells: expect.objectContaining({
          D8: expect.objectContaining({ value: "6.22", formula: "E8+F8" })
        })
      }),
      validationIssues: expect.arrayContaining([
        expect.objectContaining({
          source: "unit-semantics",
          message: expect.stringContaining("nao foram somadas nem convertidas")
        }),
        expect.objectContaining({ field: "sector/productCode", classification: "ERROR" })
      ])
    }));
  });

  it("keeps orphan dosage cells and materialized history in non-promotable staging", () => {
    const service = new ImportService({} as never, { record: vi.fn() } as never);
    const records = (
      service as unknown as { buildStagingRecords(report: unknown): Array<Record<string, unknown>> }
    ).buildStagingRecords({
      file: "/isolated/workbook.xlsx",
      legacyData: {
        products: [],
        productionEntries: [],
        lossEntries: [],
        downtimeEntries: [],
        importErrors: [],
        operationalImportErrors: [],
        dosageSamples: [{
          sheetName: "Perdas - dosagem",
          cell: "B11",
          rowNumber: 11,
          columnNumber: 2,
          rawValue: "410",
          weightG: 410,
          missingContext: ["product", "date", "week"]
        }],
        historicalEntries: [{
          sheetName: "ARQUIVO MORTO",
          tableName: "tbl_Historico_P1",
          tableRange: "A230:AE297",
          rowNumber: 231,
          firstCell: "A231",
          recordId: "P1-2026-maio-S4-V001-L3",
          recordKey: "P1|2026|maio|S4|L3",
          version: 1,
          activeRaw: "SIM",
          sourceHash: "source-hash",
          rawValues: { "ID Registro": "P1-2026-maio-S4-V001-L3" },
          sourceCells: { A231: "P1-2026-maio-S4-V001-L3" }
        }]
      }
    });

    expect(records).toContainEqual(expect.objectContaining({
      domain: "DOSAGE",
      cell: "B11",
      classification: "REQUIRES_REVIEW",
      interpretedValue: expect.objectContaining({ promotable: false, weightG: 410 })
    }));
    expect(records).toContainEqual(expect.objectContaining({
      domain: "HISTORY",
      cell: "A231",
      classification: "REQUIRES_REVIEW",
      rawOriginal: expect.objectContaining({
        recordId: "P1-2026-maio-S4-V001-L3",
        sourceHash: "source-hash",
        sourceCells: { A231: "P1-2026-maio-S4-V001-L3" }
      })
    }));
  });

  it("forbids approval of quarantined sources even after human review", async () => {
    const transaction = vi.fn();
    const prisma = {
      $transaction: transaction,
      importStagingRecord: {
        findFirst: vi.fn().mockResolvedValue({
          id: recordId,
          batchId,
          domain: "DOSAGE",
          classification: "REQUIRES_REVIEW",
          decision: "PENDING",
          version: 1,
          promotedAt: null,
          sourceFingerprint: "fingerprint",
          sheetName: "Perdas - dosagem",
          rowNumber: 11,
          batch: { status: "STAGED" }
        }),
        updateMany: vi.fn()
      }
    };
    transaction.mockImplementation((callback: (client: typeof prisma) => unknown) => callback(prisma));
    const service = new ImportStagingService(prisma as never, { record: vi.fn() } as never);

    await expect(service.review(batchId, recordId, {
      action: "APPROVE",
      reason: "Amostra conferida, mas ainda sem contexto operacional.",
      version: 1
    }, user)).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.importStagingRecord.updateMany).not.toHaveBeenCalled();
  });
});
