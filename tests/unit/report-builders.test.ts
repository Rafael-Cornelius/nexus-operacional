import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import {
  buildOperationalCsv,
  buildOperationalPdf,
  buildOperationalXlsx,
  type OperationalReportData
} from "../../apps/api/src/modules/reports/report-builders";

const report: OperationalReportData = {
  title: "Relatorio operacional",
  period: "Semana 1 (2026-05-04 a 2026-05-10)",
  generatedAt: "2026-07-19T12:00:00.000Z",
  source: "PostgreSQL",
  summary: {
    producedKg: 1000,
    plannedBatches: 10,
    realizedBatches: 9,
    planAchievement: 0.9,
    lossKg: 20,
    lossCost: 100,
    overweightKg: 5,
    overweightCost: 25,
    stoppedMinutes: 30,
    averageYield: 0.95,
    averageProductivity: 125,
    productionRecords: 1,
    lossRecords: 1,
    downtimeRecords: 1
  },
  production: [{
    date: "2026-05-04", sector: "P1", line: "Linha 1", equipment: "M1", shift: "T1",
    productCode: "073734", productName: "Produto teste", productionOrder: "=SUM(1,2)",
    plannedBatches: 10, realizedBatches: 9, producedKg: 1000, lossKg: 10, overweightKg: 5,
    yieldPercent: 0.95, productionCost: 5000, lossCost: 50, overweightCost: 25
  }],
  losses: [{
    date: "2026-05-04", sector: "P1", equipment: "M1", shift: "T1", productCode: "073734",
    productionOrder: "OP-1", type: "Pesagem", reason: "Ajuste", quantityKg: 10, cost: 50
  }],
  downtimes: [{
    date: "2026-05-04", sector: "P1", line: "Linha 1", equipment: "M1", shift: "T1",
    reason: "Limpeza", stoppedMinutes: 30, stoppedPercent: 0.1, realKgHour: 100, possibleKgHour: 120
  }],
  productivity: [{
    date: "2026-05-04", sector: "P1", equipment: "M1", shift: "T1", producedKg: 1000,
    productiveHours: 8, kgPerHour: 125
  }]
};

describe("operational report builders", () => {
  it("creates formula-safe CSV sections for every operational domain", () => {
    const csv = buildOperationalCsv(report);
    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(csv).toContain('"Producao"');
    expect(csv).toContain('"Perdas"');
    expect(csv).toContain('"Paradas"');
    expect(csv).toContain('"\'=SUM(1,2)"');
  });

  it("creates a valid XLSX with auditable summary and detail sheets", async () => {
    const buffer = await buildOperationalXlsx(report);
    expect(buffer.subarray(0, 2).toString()).toBe("PK");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(["Resumo", "Producao", "Perdas", "Paradas", "Produtividade"]);
    expect(workbook.getWorksheet("Resumo")?.getCell("B7").value).toBe(0.9);
    expect(workbook.getWorksheet("Producao")?.getCell("F2").value).toBe("073734");
    expect(workbook.getWorksheet("Producao")?.getCell("H2").value).toBe("=SUM(1,2)");
  });

  it("creates a multi-section PDF with valid signature", async () => {
    const buffer = await buildOperationalPdf(report);
    expect(buffer.subarray(0, 5).toString()).toBe("%PDF-");
    expect(buffer.length).toBeGreaterThan(1500);
  });
});
