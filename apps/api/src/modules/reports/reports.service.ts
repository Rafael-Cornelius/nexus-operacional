import { createHash } from "node:crypto";
import { BadRequestException, Injectable, InternalServerErrorException, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { CurrentUser } from "../../infrastructure/security/current-user";
import { AuditService } from "../audit/audit.service";
import { DashboardService } from "../dashboard/dashboard.service";
import {
  buildOperationalCsv,
  buildOperationalPdf,
  buildOperationalXlsx,
  type OperationalReportData
} from "./report-builders";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const operationalExportSchema = z
  .object({
    period: z.enum(["daily", "weekly", "monthly"]),
    format: z.enum(["csv", "xlsx", "pdf"]),
    date: z.string().date().optional(),
    weekId: z.string().uuid().optional(),
    year: z.coerce.number().int().min(2000).max(2200).optional(),
    month: z.coerce.number().int().min(1).max(12).optional()
  })
  .superRefine((value, context) => {
    if (value.period === "daily" && !value.date) context.addIssue({ code: "custom", path: ["date"], message: "Relatorio diario exige data." });
    if (value.period === "weekly" && !value.weekId) context.addIssue({ code: "custom", path: ["weekId"], message: "Relatorio semanal exige semana." });
    if (value.period === "monthly" && (!value.year || !value.month)) context.addIssue({ code: "custom", path: ["year"], message: "Relatorio mensal exige ano e mes." });
  });

type OperationalExportQuery = Record<string, string | undefined>;

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

  async operationalExport(query: OperationalExportQuery, user?: CurrentUser) {
    const parsed = operationalExportSchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((issue) => issue.message).join(" "));
    }
    const input = parsed.data;
    const range = await this.resolvePeriod(input);
    const filters = {
      period: input.period,
      format: input.format,
      date: input.date,
      weekId: input.weekId,
      year: input.year,
      month: input.month,
      startsOn: range.startsOn.toISOString().slice(0, 10),
      endsOn: range.endsOn.toISOString().slice(0, 10)
    };
    const exportRow = await this.prisma.reportExport.create({
      data: { type: `${input.period}-operational-${input.format}`, filters, status: "QUEUED", createdBy: this.safeUserId(user) }
    });

    try {
      const report = await this.loadOperationalData(range.startsOn, range.endsOn, range.label, input.weekId);
      const generated = await this.buildExport(input.format, report);
      const hash = createHash("sha256").update(generated.buffer).digest("hex");
      await this.prisma.reportExport.update({ where: { id: exportRow.id }, data: { status: "GENERATED" } });
      await this.audit.record({
        userId: this.safeUserId(user),
        module: "reports",
        action: "export",
        entity: "ReportExport",
        entityId: exportRow.id,
        after: { type: exportRow.type, filters, status: "GENERATED", sha256: hash, sizeBytes: generated.buffer.length }
      });
      return {
        exportId: exportRow.id,
        format: input.format,
        fileName: `nexus-${input.period}-${range.fileLabel}.${input.format}`,
        mimeType: generated.mimeType,
        sizeBytes: generated.buffer.length,
        sha256: hash,
        dataBase64: generated.buffer.toString("base64"),
        summary: report.summary
      };
    } catch (error) {
      await this.prisma.reportExport.update({ where: { id: exportRow.id }, data: { status: "FAILED" } }).catch(() => undefined);
      await this.audit.record({
        userId: this.safeUserId(user),
        module: "reports",
        action: "export_failed",
        entity: "ReportExport",
        entityId: exportRow.id,
        reason: error instanceof Error ? error.message : "Falha desconhecida"
      });
      if (error instanceof BadRequestException || error instanceof NotFoundException) throw error;
      throw new InternalServerErrorException("Nao foi possivel gerar o relatorio operacional.");
    }
  }

  private async resolvePeriod(input: z.infer<typeof operationalExportSchema>) {
    if (input.period === "daily") {
      const startsOn = new Date(`${input.date}T00:00:00.000Z`);
      return { startsOn, endsOn: startsOn, label: input.date!, fileLabel: input.date! };
    }
    if (input.period === "weekly") {
      const week = await this.prisma.weeklyPeriod.findFirst({ where: { id: input.weekId, deletedAt: null } });
      if (!week) throw new NotFoundException("Semana nao encontrada.");
      return {
        startsOn: week.startsOn,
        endsOn: week.endsOn,
        label: `${week.label} (${week.startsOn.toISOString().slice(0, 10)} a ${week.endsOn.toISOString().slice(0, 10)})`,
        fileLabel: `${week.year}-${String(week.month).padStart(2, "0")}-s${week.weekNumber}`
      };
    }
    const startsOn = new Date(Date.UTC(input.year!, input.month! - 1, 1));
    const endsOn = new Date(Date.UTC(input.year!, input.month!, 0));
    const label = `${input.year}-${String(input.month).padStart(2, "0")}`;
    return { startsOn, endsOn, label, fileLabel: label };
  }

  private async loadOperationalData(startsOn: Date, endsOn: Date, period: string, weekId?: string): Promise<OperationalReportData> {
    const dateFilter = { gte: startsOn, lte: endsOn };
    const [production, losses, downtimes, productivity] = await Promise.all([
      this.prisma.productionEntry.findMany({
        where: { deletedAt: null, workflowStatus: "APPROVED", date: dateFilter, weekId },
        include: { sector: true, line: true, equipment: true, shift: true, product: true },
        orderBy: [{ date: "asc" }, { createdAt: "asc" }]
      }),
      this.prisma.lossEntry.findMany({
        where: { deletedAt: null, workflowStatus: "APPROVED", date: dateFilter, weekId },
        include: { sector: true, equipment: true, shift: true, product: true, productionOrder: true, lossType: true },
        orderBy: [{ date: "asc" }, { createdAt: "asc" }]
      }),
      this.prisma.downtimeEntry.findMany({
        where: { deletedAt: null, workflowStatus: "APPROVED", date: dateFilter, weekId },
        include: { sector: true, line: true, equipment: true, shift: true, reason: true },
        orderBy: [{ date: "asc" }, { createdAt: "asc" }]
      }),
      this.prisma.productivityEntry.findMany({
        where: { deletedAt: null, workflowStatus: "APPROVED", date: dateFilter, weekId },
        include: { equipment: true, shift: true },
        orderBy: [{ date: "asc" }, { createdAt: "asc" }]
      })
    ]);

    const productionRows = production.map((row) => ({
      date: row.date.toISOString().slice(0, 10),
      sector: row.sector.code,
      line: row.line?.name ?? "",
      equipment: row.equipment?.name ?? "",
      shift: row.shift?.name ?? "",
      productCode: row.product.code,
      productName: row.product.name,
      productionOrder: row.productionOrder,
      plannedBatches: Number(row.plannedBatches),
      realizedBatches: Number(row.realizedBatches),
      producedKg: Number(row.producedKg),
      lossKg: Number(row.weighingLossKg),
      overweightKg: Number(row.overweightTotalKg),
      yieldPercent: Number(row.realYieldPercent),
      productionCost: Number(row.productionCost),
      lossCost: Number(row.lossesCost),
      overweightCost: Number(row.overweightCost)
    }));
    const lossRows = losses.map((row) => ({
      date: row.date.toISOString().slice(0, 10),
      sector: row.sector?.code ?? "",
      equipment: row.equipment?.name ?? "",
      shift: row.shift?.name ?? "",
      productCode: row.product?.code ?? "",
      productionOrder: row.productionOrder?.orderNumber ?? "",
      type: row.lossType.name,
      reason: row.reason ?? "",
      quantityKg: Number(row.quantityKg),
      filmShift1Kg: row.filmShift1Kg === null ? undefined : Number(row.filmShift1Kg),
      filmShift2Kg: row.filmShift2Kg === null ? undefined : Number(row.filmShift2Kg),
      boxLossUnits: row.boxLossUnits === null ? undefined : Number(row.boxLossUnits),
      boxLossShift1Units: row.boxLossShift1Units === null ? undefined : Number(row.boxLossShift1Units),
      boxLossShift2Units: row.boxLossShift2Units === null ? undefined : Number(row.boxLossShift2Units),
      cost: Number(row.lossCost)
    }));
    const downtimeRows = downtimes.map((row) => ({
      date: row.date.toISOString().slice(0, 10),
      sector: row.sector.code,
      line: row.line?.name ?? "",
      equipment: row.equipment?.name ?? "",
      shift: row.shift?.name ?? "",
      reason: row.reason.name,
      stoppedMinutes: Number(row.stoppedMinutes),
      stoppedPercent: Number(row.stoppedPercent),
      realKgHour: Number(row.realKgHour),
      possibleKgHour: Number(row.possibleKgHour)
    }));
    const productivityRows = productivity.map((row) => ({
      date: row.date.toISOString().slice(0, 10),
      sector: row.sectorCode,
      equipment: row.equipment?.name ?? "",
      shift: row.shift?.name ?? "",
      producedKg: Number(row.producedKg),
      productiveHours: Number(row.productiveHours),
      kgPerHour: Number(row.kgPerHour),
      source: row.dataSource
    }));

    const sum = (values: Array<Prisma.Decimal | number>) => values.reduce<Prisma.Decimal>((total, value) => total.plus(value), new Prisma.Decimal(0));
    const planned = sum(production.map((row) => row.plannedBatches));
    const realized = sum(production.map((row) => row.realizedBatches));
    const weighingLoss = sum(production.map((row) => row.weighingLossKg));
    const explicitLoss = sum(losses.map((row) => row.quantityKg));
    const averageYield = production.length ? sum(production.map((row) => row.realYieldPercent)).div(production.length) : new Prisma.Decimal(0);
    const averageProductivity = productivity.length ? sum(productivity.map((row) => row.kgPerHour)).div(productivity.length) : new Prisma.Decimal(0);
    return {
      title: "Relatorio operacional",
      period,
      generatedAt: new Date().toISOString(),
      source: "PostgreSQL",
      summary: {
        producedKg: Number(sum(production.map((row) => row.producedKg))),
        plannedBatches: Number(planned),
        realizedBatches: Number(realized),
        planAchievement: planned.isZero() ? 0 : Number(realized.div(planned)),
        lossKg: Number(weighingLoss.plus(explicitLoss)),
        lossCost: Number(sum(production.map((row) => row.lossesCost)).plus(sum(losses.map((row) => row.lossCost)))),
        overweightKg: Number(sum(production.map((row) => row.overweightTotalKg))),
        overweightCost: Number(sum(production.map((row) => row.overweightCost))),
        stoppedMinutes: Number(sum(downtimes.map((row) => row.stoppedMinutes))),
        averageYield: Number(averageYield),
        averageProductivity: Number(averageProductivity),
        productionRecords: production.length,
        lossRecords: losses.length,
        downtimeRecords: downtimes.length
      },
      production: productionRows,
      losses: lossRows,
      downtimes: downtimeRows,
      productivity: productivityRows
    };
  }

  private async buildExport(format: "csv" | "xlsx" | "pdf", report: OperationalReportData) {
    if (format === "xlsx") return { buffer: await buildOperationalXlsx(report), mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };
    if (format === "pdf") return { buffer: await buildOperationalPdf(report), mimeType: "application/pdf" };
    return { buffer: Buffer.from(buildOperationalCsv(report), "utf8"), mimeType: "text/csv;charset=utf-8" };
  }

  private safeUserId(user?: CurrentUser) {
    return user?.id && uuidPattern.test(user.id) ? user.id : undefined;
  }
}
