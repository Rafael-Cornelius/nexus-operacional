import { describe, expect, it, vi } from "vitest";
import { ImportService } from "../../apps/api/src/modules/import/import.service";

describe("operational import lineage and source totals", () => {
  it("links every created row to its batch and stores reconciliable source totals", async () => {
    const batchId = "11111111-1111-4111-8111-111111111111";
    const productionCreate = vi.fn().mockResolvedValue({ id: "production-entry" });
    const lossCreate = vi.fn().mockResolvedValue({ id: "loss-entry" });
    const downtimeCreate = vi.fn().mockResolvedValue({ id: "downtime-entry" });
    const batchUpdate = vi.fn().mockResolvedValue({ id: batchId, status: "IMPORTED" });
    const prisma = {
      importBatch: {
        findUnique: vi.fn().mockResolvedValue({ id: batchId, storedFilePath: "/stored/source.xlsx" }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        update: batchUpdate
      },
      sector: {
        findUniqueOrThrow: vi.fn().mockImplementation(({ where }: { where: { code: string } }) =>
          Promise.resolve({ id: where.code.toLowerCase(), code: where.code })
        )
      },
      product: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "product-1",
            code: "P-001",
            pricePerKg: 2,
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
      lossType: { upsert: vi.fn().mockResolvedValue({ id: "packaging" }) },
      productionEntry: { findFirst: vi.fn().mockResolvedValue(null), create: productionCreate },
      productionOrder: { upsert: vi.fn().mockResolvedValue({ id: "order-1" }) },
      lossEntry: { findFirst: vi.fn().mockResolvedValue(null), create: lossCreate },
      productionLine: { upsert: vi.fn().mockResolvedValue({ id: "line-1" }) },
      downtimeReason: { upsert: vi.fn().mockResolvedValue({ id: "reason-1" }) },
      downtimeEntry: { findFirst: vi.fn().mockResolvedValue(null), create: downtimeCreate },
      importError: { deleteMany: vi.fn(), createMany: vi.fn() }
    };
    const audit = { record: vi.fn() };
    const service = new ImportService(prisma as never, audit as never);
    vi.spyOn(service, "importProducts").mockResolvedValue({} as never);
    vi.spyOn(
      service as unknown as { runLegacyWorkbookImport(path: string): Promise<unknown> },
      "runLegacyWorkbookImport"
    ).mockResolvedValue({
      file: "/isolated/workbook.xlsx",
      sheetCount: 1,
      legacyData: {
        importErrors: [
          {
            sheetName: "Pacotes-caixas",
            rowNumber: 10,
            field: "boxWeightKg",
            message: "Produto sem peso de caixa."
          }
        ],
        productionEntries: [
          {
            sheetName: "Plan x Real (P1)",
            rowNumber: 2,
            sector: "P1",
            legacyWeekNumber: 1,
            date: "2026-05-04",
            productCode: "P-001",
            productionOrder: "OP-001",
            plannedBatches: 5,
            realizedBatches: 4,
            usedReworkKg: 1,
            packedBoxes: 2,
            weighingLossKg: 1.5,
            generatedReworkKg: 0.5,
            averagePackageWeightG: 600,
            pricePerKg: 2
          }
        ],
        lossEntries: [
          {
            sheetName: "CONTROLE DE PERDAS",
            rowNumber: 2,
            date: "2026-05-04",
            quantityKg: 3.25,
            legacyLine: "M1",
            lossType: "PACKAGING"
          }
        ],
        downtimeEntries: [
          {
            sheetName: "relatorios de paradas",
            rowNumber: 2,
            date: "2026-05-04",
            productionStart: "08:00:00",
            productionEnd: "12:00:00",
            downtimeStart: "09:00:00",
            downtimeEnd: "10:00:00",
            reason: "SETUP",
            legacyLine: "M1",
            legacyWeekNumber: 1
          }
        ],
        operationalImportErrors: []
      }
    });
    vi.spyOn(
      service as unknown as { ensureImportedWeek(date: string, week: number): Promise<unknown> },
      "ensureImportedWeek"
    ).mockResolvedValue({ id: "week-1" });

    await service.importOperationalData(batchId);

    expect(productionCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ importBatchId: batchId, workflowStatus: "DRAFT" })
    });
    expect(lossCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ importBatchId: batchId, workflowStatus: "DRAFT" })
    });
    expect(downtimeCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ importBatchId: batchId, workflowStatus: "DRAFT" })
    });
    expect(prisma.importError.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({ batchId, field: "boxWeightKg", message: "Produto sem peso de caixa." })
      ])
    });

    expect(batchUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: batchId },
        data: expect.objectContaining({
          summary: expect.objectContaining({
            sourceTotals: expect.objectContaining({
              productionRows: 1,
              plannedBatches: 5,
              realizedBatches: 4,
              packedBoxes: 2,
              usedReworkKg: 1,
              generatedReworkKg: 0.5,
              productionKg: 20,
              weighingLossKg: 1.5,
              overweightKg: 2,
              lossRows: 1,
              registeredLossKg: 3.25,
              downtimeRows: 1,
              downtimeMinutes: 60,
              bySector: expect.objectContaining({
                P1: expect.objectContaining({
                  productionRows: 1,
                  productionKg: 20,
                  weighingLossKg: 1.5,
                  overweightKg: 2,
                  lossRows: 1,
                  registeredLossKg: 3.25,
                  downtimeRows: 1,
                  downtimeMinutes: 60
                }),
                P2: expect.objectContaining({
                  productionRows: 0,
                  productionKg: 0,
                  weighingLossKg: 0,
                  overweightKg: 0,
                  lossRows: 0,
                  registeredLossKg: 0,
                  downtimeRows: 0,
                  downtimeMinutes: 0
                })
              })
            })
          })
        })
      })
    );
  });
});
