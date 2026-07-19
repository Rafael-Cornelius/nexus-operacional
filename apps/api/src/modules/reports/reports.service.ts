import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { CurrentUser } from "../../infrastructure/security/current-user";
import { AuditService } from "../audit/audit.service";
import { DashboardService } from "../dashboard/dashboard.service";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function csvCell(value: unknown) {
  let text = value === null || value === undefined ? "" : String(value);
  // Planilhas executam celulas iniciadas por estes caracteres como formula.
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly dashboard: DashboardService
  ) {}

  async weeklyProduction(weekId?: string, user?: CurrentUser) {
    const entries = await this.prisma.productionEntry.findMany({
      where: { deletedAt: null, workflowStatus: "APPROVED", weekId },
      include: { product: true, sector: true, week: true },
      orderBy: [{ date: "asc" }, { sector: { code: "asc" } }]
    });
    const csv = `\uFEFF${[
      ["data", "setor", "produto", "op", "produzido_kg", "perdas_kg", "sobrepeso_kg", "rendimento"].map(csvCell).join(","),
      ...entries.map((entry) =>
        [
          entry.date.toISOString().slice(0, 10),
          entry.sector.code,
          entry.product.code,
          entry.productionOrder,
          entry.producedKg,
          entry.weighingLossKg,
          entry.overweightTotalKg,
          entry.realYieldPercent
        ].map(csvCell).join(",")
      )
    ].join("\r\n")}`;

    const exportRow = await this.prisma.reportExport.create({
      data: { type: "weekly-production-csv", filters: { weekId }, status: "GENERATED", createdBy: this.safeUserId(user) }
    });
    await this.audit.record({
      userId: this.safeUserId(user),
      module: "reports",
      action: "export",
      entity: "ReportExport",
      entityId: exportRow.id,
      after: { type: exportRow.type, filters: exportRow.filters, status: exportRow.status }
    });
    return { exportId: exportRow.id, format: "csv", csv };
  }

  async weeklySummary(weekId: string | undefined, user?: CurrentUser) {
    const week = weekId
      ? await this.prisma.weeklyPeriod.findUnique({ where: { id: weekId } })
      : await this.prisma.weeklyPeriod.findFirst({ where: { deletedAt: null }, orderBy: { endsOn: "desc" } });
    if (!week) return { week: null, summary: null, daily: [], sectors: [], alerts: [], comparison: null };

    const [kpis, comparison, alerts, dailyRows] = await Promise.all([
      this.dashboard.kpis(week.id),
      this.dashboard.comparison(week.id),
      this.dashboard.alerts(week.id),
      this.prisma.productionEntry.groupBy({
        by: ["date"],
        where: { deletedAt: null, workflowStatus: "APPROVED", weekId: week.id },
        _sum: { producedKg: true, weighingLossKg: true, overweightTotalKg: true },
        _avg: { realYieldPercent: true }
      })
    ]);
    const result = {
      week: { id: week.id, label: week.label, startsOn: week.startsOn, endsOn: week.endsOn, status: week.status },
      summary: kpis,
      sectors: kpis.financialBySector,
      daily: dailyRows.map((day) => ({
        date: day.date,
        producedKg: Number(day._sum.producedKg ?? 0),
        lossesKg: Number(day._sum.weighingLossKg ?? 0),
        overweightKg: Number(day._sum.overweightTotalKg ?? 0),
        averageYield: Number(day._avg.realYieldPercent ?? 0)
      })),
      alerts,
      comparison
    };
    const exportRow = await this.prisma.reportExport.create({
      data: { type: "weekly-operational-summary", filters: { weekId: week.id }, status: "GENERATED", createdBy: this.safeUserId(user) }
    });
    await this.audit.record({
      userId: this.safeUserId(user),
      module: "reports",
      action: "weekly_summary",
      entity: "ReportExport",
      entityId: exportRow.id,
      after: { type: exportRow.type, filters: exportRow.filters, status: exportRow.status }
    });
    return { exportId: exportRow.id, ...result };
  }

  private safeUserId(user?: CurrentUser) {
    return user?.id && uuidPattern.test(user.id) ? user.id : undefined;
  }
}
