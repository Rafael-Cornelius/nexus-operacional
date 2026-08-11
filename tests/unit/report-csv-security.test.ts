import { describe, expect, it, vi } from "vitest";
import { csvCell, ReportsService } from "../../apps/api/src/modules/reports/reports.service";

describe("CSV report safety", () => {
  it("quotes delimiters and neutralizes spreadsheet formulas", () => {
    expect(csvCell('produto, "especial"')).toBe('"produto, ""especial"""');
    expect(csvCell("=HYPERLINK(\"https://invalid\")")).toBe('"\'=HYPERLINK(""https://invalid"")"');
    expect(csvCell("+1+1")).toBe('"\'+1+1"');
  });

  it("exports untrusted production orders as inert quoted cells", async () => {
    const prisma = {
      productionEntry: {
        findMany: vi.fn().mockResolvedValue([
          {
            date: new Date("2026-05-04T00:00:00.000Z"),
            sector: { code: "P1" },
            product: { code: "73734" },
            productionOrder: '=SUM(1,2)',
            producedKg: 100,
            weighingLossKg: 2,
            overweightTotalKg: 1,
            realYieldPercent: 0.95
          }
        ])
      },
      reportExport: {
        create: vi.fn().mockResolvedValue({ id: "export-1", type: "weekly-production-csv", filters: {}, status: "GENERATED" })
      }
    };
    const service = new ReportsService(prisma as never, { record: vi.fn() } as never, {} as never);

    const result = await service.weeklyProduction();
    expect(result.csv).toContain('"\'=SUM(1,2)"');
    expect(result.csv.startsWith("\uFEFF")).toBe(true);
  });
});
