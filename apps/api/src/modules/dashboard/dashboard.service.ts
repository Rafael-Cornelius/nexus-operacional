import { Injectable, NotFoundException } from "@nestjs/common";
import { evaluateRule } from "../../domain/alerts/alert-engine";
import { PrismaService } from "../../infrastructure/database/prisma.service";

function n(value: unknown): number {
  return Number(value ?? 0);
}

type MetricKey = "productionTotalKg" | "lossesTotalKg" | "overweightTotalKg" | "averageYield" | "stoppedMinutes";

function comparisonMetric(label: string, key: MetricKey, improvesWhen: "up" | "down") {
  return { label, key, improvesWhen };
}

@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async kpis(weekId?: string) {
    const [production, registeredLosses, downtime, weeks, sectors, productionBySector, lossesBySector, packaging] = await Promise.all([
      this.prisma.productionEntry.aggregate({
        where: { deletedAt: null, weekId },
        _sum: {
          producedKg: true,
          weighingLossKg: true,
          overweightTotalKg: true,
          productionCost: true,
          lossesCost: true,
          overweightCost: true
        },
        _avg: { realYieldPercent: true, overweightPercent: true },
        _count: true
      }),
      this.prisma.lossEntry.aggregate({
        where: { deletedAt: null, weekId },
        _sum: { quantityKg: true, lossCost: true, filmUsedKg: true, filmUsedValue: true, financialResult: true }
      }),
      this.prisma.downtimeEntry.aggregate({
        where: { deletedAt: null, weekId },
        _sum: { stoppedMinutes: true },
        _avg: { stoppedPercent: true, realKgHour: true, possibleKgHour: true }
      }),
      this.prisma.weeklyPeriod.groupBy({ by: ["status"], _count: true }),
      this.prisma.sector.findMany(),
      this.prisma.productionEntry.groupBy({
        by: ["sectorId"],
        where: { deletedAt: null, weekId },
        _sum: { producedKg: true, weighingLossKg: true, overweightTotalKg: true, productionCost: true, lossesCost: true, overweightCost: true }
      }),
      this.prisma.lossEntry.groupBy({
        by: ["sectorId"],
        where: { deletedAt: null, weekId },
        _sum: { quantityKg: true, lossCost: true }
      }),
      this.prisma.lossEntry.aggregate({
        where: { deletedAt: null, weekId, lossType: { code: "PACKAGING" } },
        _sum: { quantityKg: true, lossCost: true, filmUsedKg: true, filmUsedValue: true, financialResult: true }
      })
    ]);

    const productionTotalKg = n(production._sum.producedKg);
    const weighingLossesKg = n(production._sum.weighingLossKg);
    const registeredLossesKg = n(registeredLosses._sum.quantityKg);
    const lossesTotalKg = weighingLossesKg + registeredLossesKg;
    const productionCost = n(production._sum.productionCost);
    const lossesCost = n(production._sum.lossesCost) + n(registeredLosses._sum.lossCost);
    const overweightCost = n(production._sum.overweightCost);
    const bySector = productionBySector.map((row) => {
      const directLoss = lossesBySector.find((loss) => loss.sectorId === row.sectorId);
      return {
        sector: sectors.find((sector) => sector.id === row.sectorId)?.code ?? row.sectorId,
        producedKg: n(row._sum.producedKg),
        lossesKg: n(row._sum.weighingLossKg) + n(directLoss?._sum.quantityKg),
        overweightKg: n(row._sum.overweightTotalKg),
        productionCost: n(row._sum.productionCost),
        lossesCost: n(row._sum.lossesCost) + n(directLoss?._sum.lossCost),
        overweightCost: n(row._sum.overweightCost)
      };
    });

    return {
      productionTotalKg,
      lossesTotalKg,
      weighingLossesKg,
      registeredLossesKg,
      overweightTotalKg: n(production._sum.overweightTotalKg),
      overweightPercent: n(production._avg.overweightPercent),
      averageYield: n(production._avg.realYieldPercent),
      stoppedMinutes: n(downtime._sum.stoppedMinutes),
      stoppedPercent: n(downtime._avg.stoppedPercent),
      averageRealKgHour: n(downtime._avg.realKgHour),
      averagePingandoKgHour: n(downtime._avg.possibleKgHour),
      records: production._count,
      financial: {
        productionCost,
        lossesCost,
        overweightCost,
        totalImpactCost: lossesCost + overweightCost,
        costPerKg: productionTotalKg ? productionCost / productionTotalKg : 0,
        lossPercent: productionTotalKg ? lossesTotalKg / productionTotalKg : 0,
        packaging: {
          lostKg: n(packaging._sum.quantityKg),
          lossCost: n(packaging._sum.lossCost),
          filmUsedKg: n(packaging._sum.filmUsedKg),
          filmUsedValue: n(packaging._sum.filmUsedValue),
          financialResult: n(packaging._sum.financialResult)
        }
      },
      financialBySector: bySector,
      weeksByStatus: weeks.map((item) => ({ status: item.status, count: item._count }))
    };
  }

  async charts(weekId?: string) {
    const [bySector, sectors, downtime, reasons, losses] = await Promise.all([
      this.prisma.productionEntry.groupBy({
        by: ["sectorId"],
        where: { deletedAt: null, weekId },
        _sum: { producedKg: true, weighingLossKg: true, overweightTotalKg: true }
      }),
      this.prisma.sector.findMany(),
      this.prisma.downtimeEntry.groupBy({
        by: ["downtimeReasonId"],
        where: { deletedAt: null, weekId },
        _sum: { stoppedMinutes: true }
      }),
      this.prisma.downtimeReason.findMany(),
      this.prisma.lossEntry.groupBy({
        by: ["lossTypeId"],
        where: { deletedAt: null, weekId },
        _sum: { quantityKg: true, lossCost: true }
      })
    ]);
    const lossTypes = await this.prisma.lossType.findMany();

    return {
      productionBySector: bySector.map((row) => ({
        sector: sectors.find((sector) => sector.id === row.sectorId)?.code ?? row.sectorId,
        producedKg: n(row._sum.producedKg),
        lossesKg: n(row._sum.weighingLossKg),
        overweightKg: n(row._sum.overweightTotalKg)
      })),
      downtimeByReason: downtime.map((row) => ({
        reason: reasons.find((reason) => reason.id === row.downtimeReasonId)?.name ?? row.downtimeReasonId,
        stoppedMinutes: n(row._sum.stoppedMinutes)
      })),
      lossesByType: losses.map((row) => ({
        type: lossTypes.find((type) => type.id === row.lossTypeId)?.name ?? row.lossTypeId,
        quantityKg: n(row._sum.quantityKg),
        lossCost: n(row._sum.lossCost)
      }))
    };
  }

  async comparison(weekId?: string) {
    const current = weekId
      ? await this.prisma.weeklyPeriod.findUnique({ where: { id: weekId } })
      : await this.prisma.weeklyPeriod.findFirst({ where: { deletedAt: null }, orderBy: { endsOn: "desc" } });
    if (!current) throw new NotFoundException("Nenhuma semana operacional encontrada.");
    const previous = await this.prisma.weeklyPeriod.findFirst({
      where: { deletedAt: null, endsOn: { lt: current.startsOn } },
      orderBy: { endsOn: "desc" }
    });
    const currentKpis = await this.kpis(current.id);
    const previousKpis = previous ? await this.kpis(previous.id) : null;
    const metrics = [
      comparisonMetric("Produção", "productionTotalKg", "up"),
      comparisonMetric("Perdas", "lossesTotalKg", "down"),
      comparisonMetric("Sobrepeso", "overweightTotalKg", "down"),
      comparisonMetric("Rendimento", "averageYield", "up"),
      comparisonMetric("Tempo parado", "stoppedMinutes", "down")
    ].map(({ label, key, improvesWhen }) => {
      const currentValue = currentKpis[key];
      const previousValue = previousKpis?.[key] ?? 0;
      const variationPercent = previousValue === 0 ? (currentValue === 0 ? 0 : null) : (currentValue - previousValue) / previousValue;
      const favorable = variationPercent === null || variationPercent === 0 ? "stable" : (improvesWhen === "up") === (variationPercent > 0) ? "up" : "down";
      return { label, key, currentValue, previousValue, variationPercent, trend: favorable, improvesWhen };
    });
    return {
      currentWeek: { id: current.id, label: current.label },
      previousWeek: previous ? { id: previous.id, label: previous.label } : null,
      metrics
    };
  }

  async alerts(weekId?: string) {
    const [goals, data] = await Promise.all([
      this.prisma.goal.findMany({ where: { deletedAt: null, active: true }, orderBy: { metric: "asc" } }),
      this.kpis(weekId)
    ]);
    const values: Record<string, number> = {
      yield: data.averageYield,
      overweight: data.overweightPercent,
      losses_kg: data.lossesTotalKg,
      loss: data.lossesTotalKg,
      downtime_minutes: data.stoppedMinutes,
      downtime: data.stoppedPercent,
      produced_kg: data.productionTotalKg
    };
    return goals.map((goal) => {
      const value = values[goal.metric] ?? 0;
      const metric = goal.metric === "yield" ? "yield" : goal.metric.startsWith("downtime") ? "downtime" : goal.metric.startsWith("overweight") ? "overweight" : "loss";
      const alert = evaluateRule({ metric, value, target: n(goal.targetValue) });
      return { goalId: goal.id, name: goal.name, metric: goal.metric, value, target: n(goal.targetValue), comparator: goal.comparator, status: alert.status, action: alert.action };
    });
  }

  health() {
    return {
      status: "ok",
      service: "nexus-operacional-api",
      databaseUrlConfigured: Boolean(process.env.DATABASE_URL),
      timestamp: new Date().toISOString()
    };
  }

  async dbHealth() {
    if (!process.env.DATABASE_URL) {
      return { status: "missing-database-url", database: "not_configured", timestamp: new Date().toISOString() };
    }
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: "ok", database: "reachable", timestamp: new Date().toISOString() };
    } catch {
      return { status: "database-unreachable", database: "error", timestamp: new Date().toISOString() };
    }
  }
}
